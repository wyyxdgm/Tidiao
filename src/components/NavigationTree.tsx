"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useGlobalEventSource } from "@/lib/use-global-event-source";

type Project = {
  id: string;
  name: string;
  current_version_id: string | null;
  current_version_name: string | null;
  owner_id: string | null;
  sort_order: number | null;
};

type Version = {
  id: string;
  project_id: string;
  name: string;
  is_released: number;
};

type ScopeCounts = {
  running: number;
  reviewing: number;
  paused: number;
  total: number;
};

// 纯函数: 给定用户偏好 + 当前路由项目, 决定项目是否展开.
// 用户没动过的项目 → 当前路由项目自动展开, 其余折叠.
// 用户动过的项目 → 以 userExpanded 为准 (保留折叠/展开选择, 不被
// auto-expand 覆盖 — 否则「页面激活态下菜单收不起来」).
// 导出供单元测试 (NavigationTree.test.tsx) 验证 toggle 行为.
export function resolveProjectExpanded(
  userExpanded: Record<string, boolean>,
  projectId: string,
  effectiveProjectId: string | null,
): boolean {
  if (Object.prototype.hasOwnProperty.call(userExpanded, projectId)) {
    return userExpanded[projectId];
  }
  return projectId === effectiveProjectId;
}

export default function NavigationTree() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  // 用户显式设置的展开/折叠偏好. 缺失 = 没动过, 走 auto-expand (匹配当前路由
  // 时自动展开). 一旦用户 toggle 过, 就以用户选择为准 — 否则当前路由项目
  // 的 auto-expand 会盖掉用户的折叠操作, 出现"页面激活态下菜单收不起来"
  // 的问题. Session 内保留, 不写 localStorage (跟旧 expanded 行为一致).
  const [userExpanded, setUserExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [scopeCounts, setScopeCounts] = useState<Record<string, ScopeCounts>>({});
  // 当前登录用户 id, 用于把左侧导航过滤到「自己的项目」. 跨用户数据走
  // /global 或账号切换器 — admin 视图下 /api/projects 会拉所有用户的项目, 这里
  // 显式过滤避免在导航栏堆出别家「未分类」/历史测试项目. 未拿到 userId 时不过滤,
  // 保留旧的「全量」行为作为兜底, 避免接口挂掉时整栏空白.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // 飞书 R28: 项目导航拖动排序.
  // draggingId: 正在被拖的项目 id; overId: 当前 hover 在其上方/下方的目标 id;
  // overPos: 'before' | 'after' 决定 drop 后新位置在目标的前后.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overPos, setOverPos] = useState<"before" | "after">("before");
  // 拖拽期间 clientX 实时计算 top/bottom 半区, 避免 React state 一帧延迟. ref
  // 不触发重渲, 但 setOverPos 是 state, 会触发受影响的行重渲(只需 1 行, 便宜).
  const dragClientYRef = useRef<number | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Extract current project/version from pathname: /[projectId]/[versionId].
  // /tasks/[id] 走 taskRouteProjectId 兜底 (URL 第一段是 "tasks" 不是真实 project,
  // 这里拉一次 task 拿 project_id 传下去做高亮 + 自动展开).
  const pathParts = pathname.split("/").filter(Boolean);
  const isTaskRoute = pathname.startsWith("/tasks/");
  // taskRouteProjectId: /tasks/[id] 路由下 task 所属 project. 消费方按
  // isTaskRoute 拿, 离开 /tasks/[id] 不主动清 (下次进 /tasks/[id2] 前都
  // 不参与高亮 / 展开), 避免在 effect 主体里同步 setState (React 19 lint).
  const [taskRouteProjectId, setTaskRouteProjectId] = useState<string | null>(null);

  // 路由切换 → 拉一次 task 详情, 把 task.project_id 写进 taskRouteProjectId.
  // 短 ID (server 会 redirect 到完整 UUID) 跳过: 等 redirect 完 pathname 变
  // 成完整 ID 时这个 effect 再跑一次, 不必现在多发一次可能 409 的请求.
  // setState 只在 async 回调里, 满足 react-hooks/set-state-in-effect 红线。
  useEffect(() => {
    if (!isTaskRoute) return;
    const m = pathname.match(/^\/tasks\/([^/]+)/);
    const taskId = m?.[1];
    if (!taskId || taskId.length < 36) return;
    let cancelled = false;
    fetch(`/api/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setTaskRouteProjectId(data?.project_id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, isTaskRoute]);

  // effective*: 路由 → 当前 project/version 的统一来源.
  //  - /[projectId]/...   → pathParts[0..1]
  //  - /tasks/[id]        → effectiveProjectId = taskRouteProjectId (fetch 回来才有);
  //                          effectiveVersionId = null (task 页没 version 上下文,
  //                          不强行高亮某个版本, 避免误判)
  const effectiveProjectId = isTaskRoute
    ? taskRouteProjectId
    : pathParts[0] || null;
  const effectiveVersionId = isTaskRoute ? null : pathParts[1] || null;

  useEffect(() => {
    Promise.all([
      fetch("/api/projects?sort=manual").then((r) => r.json()),
      fetch("/api/versions").then((r) => r.json()),
      fetch("/api/stats/counts").then((r) => r.json()),
      fetch("/api/user/me")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([pData, vData, cData, meData]) => {
      setProjects(pData.projects || []);
      setVersions(vData.versions || []);
      setScopeCounts(cData || {});
      if (meData?.id) setCurrentUserId(meData.id);
    });
  }, [pathname]);

  // 自动展开: 派生计算 (derived), 不写进 state. effectiveProjectId 变化
  // → 组件重渲 → isProjectExpanded 跟着新值走. 简单且符合 React 19 不在
  // effect 里同步 setState 的约束.
  // 用户偏好优先: 一旦 toggle 过该 project, 以 userExpanded[projectId] 为准;
  // 未 toggle 过的才走 auto-expand (当前路由项目 → 展开). 这样避免当前
  // 路由项目被 auto-expand 覆盖掉用户的折叠操作.
  const isProjectExpanded = (projectId: string) =>
    resolveProjectExpanded(userExpanded, projectId, effectiveProjectId);

  // 全局 SSE: 收到任意任务 status_change 时刷新 scopeCounts, 让待审核计数近实时更新.
  // 共享全局单例 EventSource (NavSidebar / global-board / chat-view 也在订阅), 避免重复长连接.
  useGlobalEventSource((event) => {
    if (event.type === "status_change") {
      fetch("/api/stats/counts")
        .then((r) => r.json())
        .then((c) => setScopeCounts(c || {}))
        .catch(() => {});
    }
  });

  function toggleProject(projectId: string) {
    const current = isProjectExpanded(projectId);
    setUserExpanded((prev) => ({ ...prev, [projectId]: !current }));
  }

  async function setCurrentVersion(projectId: string, versionId: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_version_id: versionId }),
      });
      const data = await res.json();
      if (data.project) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === projectId
              ? { ...p, current_version_id: versionId, current_version_name: data.project.current_version_name }
              : p
          )
        );
      }
    } finally {
      setLoading(false);
    }
  }

  // 飞书 R28: 拖动排序核心.
  // 落点策略: drop 时算出新数组, 给每行赋 step*1000 (步长 1000 留插入空间),
  // 并行 PATCH 所有受影响的行. 失败的项目保持本地 UI 顺序, 下次拉取会被服务端
  // 覆盖; 不弹 toast —— sidebar 拖拽是轻量交互, 阻塞反馈反而别扭.
  async function reorderProjects(dragId: string, targetId: string, pos: "before" | "after") {
    if (dragId === targetId) return;
    const current = projects;
    const fromIdx = current.findIndex((p) => p.id === dragId);
    const toIdxRaw = current.findIndex((p) => p.id === targetId);
    if (fromIdx < 0 || toIdxRaw < 0) return;
    const without = current.filter((p) => p.id !== dragId);
    const insertAt = pos === "before" ? toIdxRaw : toIdxRaw + 1;
    const reordered = [
      ...without.slice(0, insertAt),
      current[fromIdx],
      ...without.slice(insertAt),
    ];
    const patched = reordered.map((p, i) => ({ ...p, sort_order: i * 1000 }));
    setProjects(patched); // 本地立即反映新顺序, 失败由下次拉取纠偏
    // 仅 PATCH 受影响的行: sort_order 变化的那几条. 未变化的行跳过避免空写.
    const prevById = new Map(current.map((p) => [p.id, p.sort_order ?? null]));
    await Promise.all(
      patched
        .filter((p) => (prevById.get(p.id) ?? null) !== p.sort_order)
        .map((p) =>
          fetch(`/api/projects/${p.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sort_order: p.sort_order }),
          }).catch(() => null)
        )
    );
  }

  function onDragStart(e: React.DragEvent, id: string) {
    setDraggingId(id);
    // dataTransfer 必须 setData 才能让 drop 触发 —— 任意字符串都行, 用 id 方便
    // 跨子组件传. effectAllowed=move 让 cursor 显示移动箭头 (而非禁止).
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: React.DragEvent, id: string) {
    if (!draggingId || draggingId === id) return;
    e.preventDefault(); // 必须 preventDefault 才能在目标上触发 drop
    e.dataTransfer.dropEffect = "move";
    dragClientYRef.current = e.clientY;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 上半区 = before, 下半区 = after; 中点 ±4px 抖动容差.
    const mid = rect.top + rect.height / 2;
    const pos: "before" | "after" = e.clientY < mid ? "before" : "after";
    if (overId !== id || overPos !== pos) {
      setOverId(id);
      setOverPos(pos);
    }
  }

  function onDragLeave(e: React.DragEvent, id: string) {
    // 离开时不要立刻清 overId, 否则经过子节点会闪烁; 用 relatedTarget 判一下:
    // 真的离开整个组件才清. 但 React 的 dragleave 在子元素切换时也会冒泡, 所以
    // 兜底: 进入 dragend 时统一清.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      if (overId === id) {
        setOverId(null);
      }
    }
  }

  function onDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    const dragId = e.dataTransfer.getData("text/plain") || draggingId;
    if (!dragId || dragId === targetId) {
      setDraggingId(null);
      setOverId(null);
      return;
    }
    void reorderProjects(dragId, targetId, overPos);
    setDraggingId(null);
    setOverId(null);
  }

  function onDragEnd() {
    setDraggingId(null);
    setOverId(null);
    dragClientYRef.current = null;
  }

  const projectVersions = (projectId: string) =>
    versions.filter((v) => v.project_id === projectId);

  // 飞书 R29: 项目列表只渲染 currentUserId 名下的项目, 避免 admin 视图被
  // 别家项目塞爆侧栏. 全局看板的计数 badge 已上移到 NavSidebar 底部.
  const ownedProjects = currentUserId
    ? projects.filter((p) => p.owner_id === currentUserId)
    : projects;

  // 飞书 R36: 徽章改成纯数字, 三段斜杠分隔, 各自状态色. 全 0 返回 null, 由
  // 调用方决定是否回退显示版本数(项目头)或直接隐藏(版本/其他任务链接).
  // R36 微调: 右侧加灰色「总数」区分活跃任务 vs 全部任务.
  // 颜色复用 STATUS_DOT(蓝=运行, 紫=审核, 黄=暂停), 与看板状态点视觉一致.
  function renderCountBadge(counts: ScopeCounts | undefined) {
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
        {/* R36 微调: 灰色总数加在彩色段右侧, 加 ml-1 间距. 仅当 total > 0 才显示. */}
        {counts.total > 0 && (
          <span className={parts.length > 0 ? "ml-1 text-gray-400" : "text-gray-400"} title="总数">{counts.total}</span>
        )}
      </span>
    );
  }

  return (
    <nav className="p-3 space-y-1">
      {/* 飞书 R36 微调: 标题右侧加项目数量. 折叠 + ownedProjects 过滤都已是
          最终态, 直接展示. admin 视图下只显示当前用户可见的项目数. */}
      <div className="px-2 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center">
        <span>项目导航</span>
        <span className="ml-auto font-normal tabular-nums" title="项目数量">
          {ownedProjects.length}
        </span>
      </div>

      {ownedProjects.length === 0 && (
        <div className="px-2 py-4 text-xs text-gray-400 text-center">
          暂无项目
        </div>
      )}

      {ownedProjects.map((project) => {
        const pvs = projectVersions(project.id);
        const isExpanded = isProjectExpanded(project.id);
        const hasCurrent = !!project.current_version_id;
        // 飞书 R29 (damo 反馈): 项目级 badge = 累加所有版本 + unversioned 的
        // counts, 跟版本级 renderCountBadge 形状一致. 没任务时 badge 不渲染
        // (total=0 → renderCountBadge 返回 null), 回退显示原版本数.
        const projectCounts: ScopeCounts = [
          ...pvs.map((v) => scopeCounts[`${project.id}:${v.id}`] ?? { running: 0, reviewing: 0, paused: 0, total: 0 }),
          scopeCounts[`${project.id}:`] ?? { running: 0, reviewing: 0, paused: 0, total: 0 },
        ].reduce<ScopeCounts>(
          (acc, c) => ({
            running: acc.running + c.running,
            reviewing: acc.reviewing + c.reviewing,
            paused: acc.paused + c.paused,
            total: acc.total + c.total,
          }),
          { running: 0, reviewing: 0, paused: 0, total: 0 },
        );
        // 飞书 R28: 拖拽视觉状态.
        // isDragging: 被拖的行半透明 + 弱化背景; 落点指示器 (前后两条蓝线) 由
        // isOverBefore/isOverAfter 决定; 拖拽中其它行 cursor: grabbing 体感.
        const isDragging = draggingId === project.id;
        const isOverBefore = overId === project.id && overPos === "before" && draggingId && draggingId !== project.id;
        const isOverAfter = overId === project.id && overPos === "after" && draggingId && draggingId !== project.id;

        return (
          <div
            key={project.id}
            draggable
            onDragStart={(e) => onDragStart(e, project.id)}
            onDragOver={(e) => onDragOver(e, project.id)}
            onDragLeave={(e) => onDragLeave(e, project.id)}
            onDrop={(e) => onDrop(e, project.id)}
            onDragEnd={onDragEnd}
            className={isDragging ? "opacity-40" : ""}
          >
            {/* drop indicator: 上下两条 2px 蓝线, 在项目 header 外侧 (相对定位). */}
            {isOverBefore && (
              <div className="h-0.5 bg-blue-500 mx-1 rounded" aria-hidden="true" />
            )}
            {/* Project header */}
            <button
              onClick={() => toggleProject(project.id)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-gray-200 text-left group"
            >
              <span className="text-gray-400 text-xs shrink-0">
                {isExpanded ? "▼" : "▶"}
              </span>
              {/* 飞书 R28: 拖拽手柄 — 鼠标 hover 时由灰变深, 提示可拖.
                  cursor-grab/grabbing 体感来自内联 style 避免污染全局 CSS.
                  仅在 hover 整行时显现手柄, 默认不抢视觉。 */}
              <span
                className="text-gray-300 group-hover:text-gray-500 text-xs shrink-0 select-none"
                style={{ cursor: isDragging ? "grabbing" : "grab" }}
                title="拖动以重新排序"
                aria-hidden="true"
              >
                ⋮⋮
              </span>
              <span className="flex items-center min-w-0" title={project.name}>
                <span className="text-sm font-medium text-gray-800 truncate">{project.name}</span>
                {/* R36 微调 2: 版本数放项目名旁边括号里, 视觉靠近「项目名」而非徽章.
                    shrink-0 让长名 truncate 时 (3) 不被吃掉. */}
                <span className="ml-1 shrink-0 text-xs text-gray-400 font-normal" title="版本数量">({pvs.length})</span>
              </span>
              {/* 项目级 badge (飞书 R29 + R36 微调): 仅徽章. 版本数已挪到项目名旁. */}
              <span className="ml-auto flex items-center gap-2">
                {renderCountBadge(projectCounts)}
              </span>
            </button>
            {isOverAfter && (
              <div className="h-0.5 bg-blue-500 mx-1 rounded" aria-hidden="true" />
            )}

            {/* Versions list */}
            {isExpanded && (
              <div className="ml-4 space-y-0.5">
                {pvs.map((v) => {
                  const isCurrent = v.id === project.current_version_id;
                  const isActive =
                    v.id === effectiveVersionId && project.id === effectiveProjectId;

                  return (
                    <div key={v.id} className="flex items-center gap-1">
                      <Link
                        href={`/${project.id}/${v.id}`}
                        title={v.name}
                        className={`flex-1 flex items-center gap-1 px-2 py-1 rounded text-sm truncate ${
                          isActive
                            ? "bg-blue-100 text-blue-700 font-semibold"
                            : "text-gray-600 hover:bg-gray-100"
                        }`}
                      >
                        <span className="shrink-0">{isCurrent ? "⭐" : ""}</span>
                        <span className="truncate">{v.name}</span>
                        {v.is_released === 1 && (
                          <span className="shrink-0 text-xs bg-green-100 text-green-700 px-1 rounded">stable</span>
                        )}
                        {renderCountBadge(scopeCounts[`${project.id}:${v.id}`])}
                      </Link>
                      {!isCurrent && (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            setCurrentVersion(project.id, v.id);
                          }}
                          disabled={loading}
                          title="设为当前版本"
                          className="shrink-0 p-1 text-gray-300 hover:text-blue-500 disabled:opacity-50"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}

                {pvs.length === 0 && (
                  <div className="px-2 py-1 text-xs text-gray-400 italic">
                    暂无版本
                  </div>
                )}

                <Link
                  href={`/${project.id}/unversioned`}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${
                    effectiveProjectId === project.id && effectiveVersionId === "unversioned"
                      ? "bg-blue-100 text-blue-700 font-semibold"
                      : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  <span>📁</span>
                  <span>其他任务</span>
                  {renderCountBadge(scopeCounts[`${project.id}:`])}
                </Link>

                {/* 飞书 R87: 需求列表 / Board 入口放在 Wiki 上方, 让用户从导航
                    一眼看到「这个项目有哪几个常用视图」. board 用 project cwd
                    兜底 (不受 version 切换影响, R66 引擎设计), 需求走 current
                    version, 无 version 时回退 unversioned. */}
                <Link
                  href={`/${project.id}/board?path=boards/project-progress.md`}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${
                    effectiveProjectId === project.id && pathname?.includes(`/${project.id}/board`)
                      ? "bg-blue-100 text-blue-700 font-semibold"
                      : "text-gray-500 hover:bg-gray-100"
                  }`}
                  title="项目进度看板"
                >
                  <span>📊</span>
                  <span>Board</span>
                </Link>
                <Link
                  href={
                    project.current_version_id
                      ? `/${project.id}/${project.current_version_id}/requirements`
                      : `/${project.id}/unversioned/requirements`
                  }
                  className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${
                    effectiveProjectId === project.id && pathname?.includes(`/requirements`)
                      ? "bg-blue-100 text-blue-700 font-semibold"
                      : "text-gray-500 hover:bg-gray-100"
                  }`}
                  title="需求点列表"
                >
                  <span>📋</span>
                  <span>需求</span>
                </Link>

                <Link
                  href={`/${project.id}/wiki`}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${
                    effectiveProjectId === project.id && pathname?.includes(`/${project.id}/wiki`)
                      ? "bg-blue-100 text-blue-700 font-semibold"
                      : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  <span>📖</span>
                  <span>Wiki</span>
                </Link>
              </div>
            )}
          </div>
        );
      })}

      {/* 飞书 R29: 原 NavigationTree 底部那 4 条(所有项目/全局看板/批量导入/设置)
          已挪到 NavSidebar 底部常驻栏. 这里只渲染项目列表, 不再带这 4 条,
          避免重复 + 让项目区视觉更干净. 全局看板的计数 badge 同理上移. */}
    </nav>
  );
}
