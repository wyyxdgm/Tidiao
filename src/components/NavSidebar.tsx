"use client";

// Navigation sidebar — collapsible on desktop, hamburger overlay on mobile.
// 展开态宽度可拖动,松手存 localStorage。

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import NavigationTree from "./NavigationTree";
import AccountSwitcher from "./AccountSwitcher";
import { useGlobalEventSource } from "@/lib/use-global-event-source";

type Project = {
  id: string;
  name: string;
  current_version_id: string | null;
  owner_id: string | null;
};

// 飞书 R29 R 列反馈: 全局看板链接右侧的运行中数量 badge 需要恢复.
// ab20b46 把 globalCounts 计算从 NavigationTree 里删了, 没在 NavSidebar 里
// 补回 — 导致 badge 消失. 这里用同一种 ScopeCounts 形状 + 自己 fetch /api/stats/counts
// 重新算. 和 NavigationTree 内部 fetch 的 scopeCounts 是两个独立请求, 但接口
// 是轻量级 KV 返回, 多一次代价可接受.
type ScopeCounts = { running: number; reviewing: number; paused: number; total: number };

type Me = { id?: string; email?: string; role?: string };
// /usage(用量统计) —— 普通用户也开放(双口径改造后, /api/stats/usage 对 self
// 永远返回本账号数据, 无权限门槛)。role 字段由 /api/user/me 顺手带出。
// 历史说明: 此前是 admin only, NavSidebar 入口 + API 端双层防线; 现已放开。

// 折叠状态沿用旧 key,避免已升级用户的偏好丢失
const COLLAPSED_KEY = "nav-sidebar-collapsed";
// 展开态宽度:像素值字符串
const WIDTH_KEY = "nav-sidebar-width";
// 飞书 R34: 顶部 3 项(快速入口)固定/活动开关. 默认固定 = 符合 R29 加这 3 项
// 时「快速入口」的意图;活动态走老行为(随项目列表滚动)。landscape 横屏若
// 上下都固定会让中间滚动区消失,所以保留开关给用户自己取舍。
const TOP_PINNED_KEY = "nav-top-pinned";
const DEFAULT_WIDTH = 256; // w-64
const MIN_WIDTH = 224;     // w-56,过窄树状菜单错位
const MAX_WIDTH = 448;     // 28rem,再宽就挤压主内容区

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 飞书 R36: 徽章改成纯数字, 三段斜杠分隔, 各自状态色.
// 格式: 运行中N / 审核M / 暂停P + 灰色「总数」; 任一彩色段为 0 则跳过, 保持侧栏干净.
// 全 0 (含 total) 时整条隐藏.
// 颜色复用 STATUS_DOT 口径(蓝=运行, 紫=审核, 黄=暂停), 视觉与看板状态点一致.
function renderGlobalCountsBadge(counts: ScopeCounts | undefined) {
  if (!counts) return null;
  const parts: Array<{ n: number; cls: string; title: string }> = [];
  if (counts.running > 0) parts.push({ n: counts.running, cls: "text-blue-500", title: "运行中" });
  if (counts.reviewing > 0) parts.push({ n: counts.reviewing, cls: "text-purple-600", title: "待审核" });
  if (counts.paused > 0) parts.push({ n: counts.paused, cls: "text-yellow-600", title: "已暂停" });
  if (parts.length === 0 && counts.total === 0) return null;
  return (
    <span className="ml-auto shrink-0 text-xs tabular-nums flex items-center gap-0.5" aria-label={`${parts.map(p => `${p.title}${p.n}`).join(" ")}${counts.total > 0 ? ` 总数${counts.total}` : ""}`}>
      {parts.map((p, i) => (
        <span key={p.title} className="flex items-center">
          {i > 0 && <span className="text-gray-300 mx-0.5">/</span>}
          <span className={p.cls} title={p.title}>{p.n}</span>
        </span>
      ))}
      {counts.total > 0 && (
        <span className={parts.length > 0 ? "ml-1 text-gray-400" : "text-gray-400"} title="总数">{counts.total}</span>
      )}
    </span>
  );
}

export default function NavSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // 飞书 R34: 顶部 3 项固定/活动开关. 默认固定(贴合 R29「快速入口」意图);
  // 用户可在头部小按钮一键切回活动态。
  const [topPinned, setTopPinned] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [userEmail, setUserEmail] = useState("");
  const [userRole, setUserRole] = useState<string | undefined>(undefined);
  // 当前用户 id, 用于把 collapsed 头像圆也过滤到「自己的项目」. 与 NavigationTree
  // 同一规则: admin 视图下 /api/projects 拉所有用户, 这里显式过滤避免头像栏堆出
  // 别家项目. 未拿到时不兜底过滤, 保留旧行为.
  const [userId, setUserId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [maintenance, setMaintenance] = useState<{
    active: boolean; reason: string | null; entered_at: string | null;
  } | null>(null);
  // 飞书 R29 R 列反馈: 全局看板运行中数量 badge 数据源.
  const [scopeCounts, setScopeCounts] = useState<Record<string, ScopeCounts>>({});

  useEffect(() => {
    setMounted(true);
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
      const saved = localStorage.getItem(WIDTH_KEY);
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= MIN_WIDTH && n <= MAX_WIDTH) setWidth(n);
      }
      // 飞书 R34: 读取顶部 3 项的固定/活动偏好. null (新用户) 走默认 true,
      // 显式存了 "0" 的老用户保持活动态 — 不强推新行为。
      const pinnedSaved = localStorage.getItem(TOP_PINNED_KEY);
      if (pinnedSaved !== null) setTopPinned(pinnedSaved === "1");
    } catch {}
  }, []);

  // 拖动宽度:window 级监听保证鼠标移出侧栏也能继续;up 时取最终 clientX 写盘,
  // 不依赖 React state 的最新快照,避免一帧延迟。
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX));
      setWidth(next);
    }
    function onUp(e: MouseEvent) {
      const final = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX));
      try {
        localStorage.setItem(WIDTH_KEY, String(final));
      } catch {}
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects || []))
      .catch(() => {});
  }, [pathname]);

  useEffect(() => {
    fetch("/api/user/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        setUserEmail(d?.email ?? "");
        setUserRole(d?.role);
        if (d?.id) setUserId(d.id);
      })
      .catch(() => {});
  }, [pathname]);

  // 维护模式指示器:路由切换立即重拉 + 30s 轮询. 进入维护 → 用户侧栏立即看到横幅;
  // 退出维护 → 最迟 30s 内横幅消失. 失败/401 → 静默置 null, 不弹错。
  useEffect(() => {
    let cancelled = false;
    async function fetchMaint() {
      try {
        const r = await fetch("/api/maintenance/status");
        if (!r.ok) { if (!cancelled) setMaintenance(null); return; }
        const d = await r.json();
        if (!cancelled) setMaintenance(d);
      } catch { if (!cancelled) setMaintenance(null); }
    }
    fetchMaint();
    const id = setInterval(fetchMaint, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pathname]);

  // 飞书 R29 R 列反馈: 全局看板 badge 数据源. 路由切换立即拉 + SSE 实时刷.
  // 跟 NavigationTree 内部的 scopeCounts 是同一个接口两次拉取, 接受这点重复
  // (接口轻量), 避免引入 props/context 跨组件传递.
  // SSE 用全局单例 hook (与 NavigationTree / global-board / chat-view 共享), 不在此处再开长连接.
  useEffect(() => {
    let cancelled = false;
    async function fetchCounts() {
      try {
        const r = await fetch("/api/stats/counts");
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setScopeCounts(d || {});
      } catch {}
    }
    fetchCounts();
    return () => { cancelled = true; };
  }, [pathname]);
  useGlobalEventSource((ev) => {
    if (ev.type === "status_change") {
      // 路由依赖不在此 hook 闭包里, pathname 变时 fetchCounts 由上面 effect 触发;
      // 这里只关心事件触发的新一轮刷新, 复用同样的 fetch 逻辑.
      fetch("/api/stats/counts")
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d) setScopeCounts(d); })
        .catch(() => {});
    }
  });

  // Close mobile drawer on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // 全局快捷键: Cmd/Ctrl + 1..5 → 跳到「项目导航」里对应排位的项目默认版本.
  // 顺序与 NavigationTree 一致: 过滤掉别家项目后取前 N 个. 在 input/textarea/
  // contenteditable 中输入时不抢 (避免输入数字 1 时误跳转).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const num = parseInt(e.key, 10);
      if (!(num >= 1 && num <= 5)) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      ) {
        return;
      }
      const list = userId
        ? projects.filter((p) => p.owner_id === userId)
        : projects;
      const target = list[num - 1];
      if (!target) return;
      e.preventDefault();
      const href = target.current_version_id
        ? `/${target.id}/${target.current_version_id}`
        : `/${target.id}/unversioned`;
      router.push(href);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [projects, userId, router]);

  // 首页（全宽 dashboard）和未登录页（/login、/register）不显示侧栏
  // 注意:维护模式横幅挂在侧栏内部,侧栏在以上路径直接 return null,横幅自动隐藏。
  // 别再加全局 banner hook,会与侧栏在同页出现重复。
  if (pathname === "/" || pathname === "/login" || pathname === "/register") {
    // Still show mobile hamburger on non-home pages for back-navigation
    if (pathname !== "/" && pathname !== "/login" && pathname !== "/register") {
      // Won't reach here, but keeping logic clear
    }
    return null;
  }

  // 飞书 R29 R 列反馈: 全局看板 badge 数据. 只统计 currentUserId 名下的项目,
  // 与 NavigationTree 同一规则 (admin 视图下避免别家任务污染计数).
  const ownedProjects = userId
    ? projects.filter((p) => p.owner_id === userId)
    : projects;
  const ownedProjectIds = new Set(ownedProjects.map((p) => p.id));
  const globalCounts: ScopeCounts = Object.entries(scopeCounts)
    .filter(([key]) => ownedProjectIds.has(key.split(":")[0]))
    .reduce<ScopeCounts>(
      (acc, [, c]) => ({
        running: acc.running + c.running,
        reviewing: acc.reviewing + c.reviewing,
        paused: acc.paused + c.paused,
        total: acc.total + c.total,
      }),
      { running: 0, reviewing: 0, paused: 0, total: 0 },
    );

  function toggle() {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  // 飞书 R34: 顶部 3 项固定/活动切换. 固定态 = 项目滚动时 3 项留在 aside
  // 顶部(sticky);活动态 = 3 项随项目列表一起滚走(老行为)。
  function toggleTopPinned() {
    setTopPinned((v) => {
      const next = !v;
      try {
        localStorage.setItem(TOP_PINNED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  // 拖动时锁住 cursor 和文本选择,避免移出侧栏时 cursor 变箭头、文字被选中。
  // 用 style 标签避免污染全局 CSS 或与 SSR className 抖动。
  const dragStyle = dragging ? (
    <style>{`body { cursor: col-resize !important; user-select: none; }`}</style>
  ) : null;

  // Collapsed sidebar content (shared between desktop and mobile)
  const collapsedContent = (
    // sticky + h-screen: 项目多时图标列自己滚,不撑高 flex 行(否则右侧内容被 body 滚动顶走)
    <aside className="w-12 bg-gray-100 border-r border-gray-200 shrink-0 sticky top-0 h-screen overflow-y-auto flex flex-col items-center py-2 gap-1 relative">
      <button
        onClick={toggle}
        title="展开导航"
        className="p-2 rounded hover:bg-gray-200 text-gray-600"
      >
        <span className="text-base">▶</span>
      </button>
      <div className="w-8 border-t border-gray-300 my-1" />
      <a
        href="/"
        title="所有项目"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        🏠
      </a>
      <a
        href="/global"
        title="全局看板"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        🌐
      </a>
      <a
        href="/import"
        title="批量导入"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        📥
      </a>
      <a
        href="/requirements"
        title="需求点管理"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        📋
      </a>
      <a
        href="/assets"
        title="资源池"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        🖼️
      </a>
      <a
        href="/schedules"
        title="定时任务"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        ⏰
      </a>
      <a
        href="/usage"
        title="用量统计"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        📊
      </a>
      <a
        href="/settings"
        title="设置"
        className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
      >
        ⚙️
      </a>
      <div className="w-8 border-t border-gray-300 my-1" />
      {(userId ? projects.filter((p) => p.owner_id === userId) : projects).map((p) => (
        <a
          key={p.id}
          href={p.current_version_id ? `/${p.id}/${p.current_version_id}` : `/${p.id}/unversioned`}
          title={p.name}
          className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold flex items-center justify-center hover:bg-blue-200"
        >
          {p.name.slice(0, 2)}
        </a>
      ))}
      {userEmail && <AccountSwitcher userEmail={userEmail} variant="sidebar-collapsed" />}
      {maintenance?.active && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1 bg-amber-400 animate-pulse"
          title={maintenance.reason ?? "系统维护中"}
          aria-label="系统维护中"
        />
      )}
    </aside>
  );

  // Expanded sidebar content (shared between desktop and mobile)
  // 桌面态宽度由 inline style 控制(可拖动);移动端 drawer 仍用 w-64 固定。
  // mounted 守卫避免 hydration mismatch:服务端不带 style,客户端水合后才套上用户上次存的宽度。
  const dynamicWidth = mounted ? { width: `${width}px` } : undefined;
  // sticky + h-screen: 侧栏高度锁定视口,内部 flex-1 的 overflow-y-auto 才会真正滚动。
  // 否则项目多时 aside 撑高整个 flex 行,变成 body 滚动 = 右侧内容一起被顶上去。
  const expandedContent = (
    <aside
      className="w-64 bg-gray-100 border-r border-gray-200 shrink-0 sticky top-0 h-screen flex flex-col overflow-hidden relative"
      style={dynamicWidth}
    >
      <button
        onClick={toggle}
        title="收起导航"
        // 移动端抽屉自带 ✕ 关闭按钮，再显示一个 ◀ 会和它重叠。
        // 桌面侧栏常驻这个折叠按钮。
        className="absolute top-2 right-2 p-1 rounded hover:bg-gray-200 text-gray-500 text-xs z-10 hidden md:block"
      >
        ◀
      </button>
      <div className="flex-1 overflow-y-auto min-w-0">
        {maintenance?.active && (
          <div
            role="status"
            aria-live="polite"
            className="mx-2 mt-2 mb-1 rounded border border-amber-400 bg-amber-100 px-3 py-2 text-amber-900"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
              <span>🔧 系统维护中</span>
            </div>
            {maintenance.reason && (
              <div className="mt-1 text-xs text-amber-900 line-clamp-2">
                {maintenance.reason}
              </div>
            )}
            {maintenance.entered_at && (
              <div className="mt-0.5 text-[10px] text-amber-800">
                开始于 {formatTime(maintenance.entered_at)}
              </div>
            )}
          </div>
        )}
        {/* 飞书 R29: 顶部 3 条(定时任务/需求点管理/用量统计)保留作为快速入口;
            原 NavigationTree 底部那 4 条挪到下面固定栏. 项目列表现在独占中间滚动区.
            飞书 R34: 加一个固定/活动开关. 固定态 sticky 粘在 aside 顶部(bg 必须不透明,
            否则项目列表会从下面穿透显示). 活动态去掉 sticky,3 项随项目列表一起滚动,
            保留 R29 老行为;landscape 横屏 + 上下都固定会让中间滚动区消失,
            所以保留开关给用户自己取舍。 */}
        <div
          className={`pl-3 pr-8 py-2 border-b border-gray-200 ${
            topPinned ? "sticky top-0 z-10 bg-gray-100" : ""
          }`}
        >
          {/* 飞书 R145: 右侧 pr-8 给右上角 ◀ 收起按钮留位置,避免和
              「📌 已固定 / 📍 活动」切换按钮视觉挤在一起。 */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] uppercase tracking-wide text-gray-400">快速入口</span>
            <button
              onClick={toggleTopPinned}
              title={topPinned ? "切换为活动(随项目列表滚动)" : "切换为固定(始终留在顶部)"}
              aria-pressed={topPinned}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                topPinned
                  ? "text-blue-600 hover:bg-blue-50"
                  : "text-gray-500 hover:bg-gray-200"
              }`}
            >
              {topPinned ? "📌 已固定" : "📍 活动"}
            </button>
          </div>
          <a href="/schedules" className="flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600">
            <span>⏰</span> 定时任务
          </a>
          <a href="/requirements" className="flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 mt-1.5">
            <span>📋</span> 需求点管理
          </a>
          <a href="/assets" className="flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 mt-1.5">
            <span>🖼️</span> 资源池
          </a>
          <a href="/usage" className="flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 mt-1.5">
            <span>📊</span> 用量统计
          </a>
        </div>
        <NavigationTree />
      </div>
      {/* 飞书 R29: 底部常驻栏 = 4 条系统导航 + 折叠态账号切换器.
          这 4 条原先挂在 NavigationTree 尾部, 不属于项目列表, 视觉上容易
          让人误以为是项目. 挪出来固定到底部, 与上方项目区明显分层. */}
      <div className="border-t border-gray-200 px-3 py-2 space-y-1">
        <a
          href="/"
          className={`flex items-center gap-2 text-sm hover:text-blue-600 ${
            pathname === "/" ? "text-blue-600 font-semibold" : "text-gray-700"
          }`}
        >
          <span>🏠</span> 所有项目
        </a>
        <a
          href="/global"
          className={`flex items-center gap-2 text-sm hover:text-blue-600 ${
            pathname === "/global" ? "text-blue-600 font-semibold" : "text-gray-700"
          }`}
        >
          <span>🌐</span> <span>全局看板</span>
          {renderGlobalCountsBadge(globalCounts)}
        </a>
        <a
          href="/import"
          className={`flex items-center gap-2 text-sm hover:text-blue-600 ${
            pathname === "/import" ? "text-blue-600 font-semibold" : "text-gray-700"
          }`}
        >
          <span>📥</span> 批量导入
        </a>
        <a
          href="/settings"
          className={`flex items-center gap-2 text-sm hover:text-blue-600 ${
            pathname === "/settings" ? "text-blue-600 font-semibold" : "text-gray-700"
          }`}
        >
          <span>⚙️</span> 设置
        </a>
      </div>
      <div className="border-t border-gray-200 p-2 min-h-[56px]">
        {userEmail && <AccountSwitcher userEmail={userEmail} variant="sidebar" />}
      </div>
      {/* 拖动手柄:仅桌面态显示(展开态是这一支,不必再判 collapsed)*/}
      <div
        onMouseDown={(e) => {
          // preventDefault 防止拖动过程中选中文本
          e.preventDefault();
          setDragging(true);
        }}
        className="hidden md:block absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 active:bg-blue-500 z-20"
        title="拖动调整宽度"
      />
    </aside>
  );

  return (
    <>
      {dragStyle}
      {/* Mobile hamburger button — always visible on small screens */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] z-40 p-2 rounded-lg bg-white shadow-md border border-gray-200 text-gray-600 hover:bg-gray-50 btn-press md:hidden"
        title="打开导航"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
          <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
        </svg>
      </button>

      {/* Mobile overlay drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          {/* Drawer */}
          <div className="absolute left-0 top-0 bottom-0">
            {collapsed ? collapsedContent : expandedContent}
            {/* Close button */}
            <button
              onClick={() => setMobileOpen(false)}
              // safe-area 避开 iPhone notch / 灵动岛，否则关闭按钮被遮住。
              className="absolute top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] p-2 rounded-lg hover:bg-gray-200 text-gray-500 z-10"
              title="关闭导航"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Desktop sidebar — hidden on mobile, visible on md+ */}
      <div className="hidden md:block">
        {collapsed ? collapsedContent : expandedContent}
      </div>
    </>
  );
}
