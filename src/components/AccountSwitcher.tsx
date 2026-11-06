"use client";

// Account switcher dropdown — replaces LogoutButton in the four spots that
// previously showed the current user (homepage header, sidebar collapsed /
// expanded). Long-lived API tokens in localStorage let the user hop between
// previously-logged-in accounts in one click; explicit logout removes the
// account from the list, while 401 kicks leave it intact.
//
// 飞书 R29 H 列硬约束: hover 出来的二级菜单必须浮在最顶层, 哪怕超出当前
// 容器范围也要可见. NavSidebar 的 aside 有 overflow-hidden, 任何 absolute
// 子元素超出 aside 都会被切. 这里用 createPortal 把 Dropdown 渲染到 body,
// z-index 9999, 配合 getBoundingClientRect + 视口边界检测, 不管 trigger
// 在哪个容器里都能浮在最上面且不溢出视口.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  getRecentAccounts,
  removeRecentAccount,
  type RecentAccount,
} from "@/lib/recent-accounts";

type Variant = "header" | "sidebar" | "sidebar-collapsed";

// 计算 dropdown 位置的纯函数 (从 trigger rect + 视口尺寸 + 估算菜单高).
// 飞书 R120: trigger 在侧栏底部时, 视口下沿放不下, dropdown 应该底对齐
// trigger.bottom 浮在右侧, 不再"top 对齐 + 4px gap"导致中间空一截.
// 关注点: top 翻转时 dropdown.bottom ≈ trigger.bottom (gap=0); menuHeight
//   比视口还高时 clamp 到 top=8 兜底; left 默认 rect.right, 视口右溢出
//   时左移留 8px 边距.
export function computeDropdownPosition(
  triggerRect: { top: number; right: number; bottom: number; left: number; width: number; height: number },
  viewport: { width: number; height: number },
  accountsLen: number,
): { top: number; left: number; width: number } {
  const vw = viewport.width;
  const vh = viewport.height;
  // 估算菜单高度: 当前账号 + 切换账号列表 + 登录其他账号 + 退出登录
  // 实测 N=0 ≈ 206px (header 68 + body 109 + footer 47 - border 重叠), N=1 加 38.
  // 旧公式 80 + N*48 + 80 在 N=0 估 160, 偏低 46px, trigger 贴视口底时翻转向上
  // 顶部 OK 但 dropdown.bottom 跌出视口 footer 被切. 上调到 230 + N*38 兜底.
  const menuHeight = Math.min(vh * 0.8, 230 + accountsLen * 38);
  const distToBottom = vh - triggerRect.bottom;
  const MENU_WIDTH = 256;
  // 视口下方放得下 → dropdown 在 trigger 下方, 顶部对齐 + 4px 间隙.
  // 放不下 → 翻转朝上, 但 **底部对齐 trigger.bottom**, 不留中间空隙.
  //   (历史 bug: 翻转时用 rect.top - menuHeight - 4 导致 dropdown.bottom
  //    与 trigger.bottom 之间空出 menuHeight+4-44 ≈ 200+ px 的大白条.)
  const canDown = distToBottom >= menuHeight + 16;
  let top = canDown
    ? triggerRect.bottom + 4
    : Math.max(8, triggerRect.bottom - menuHeight);
  // 兜底 clamp: estimate menuHeight 可能偏低 (实测 N=0 ≈ 206 vs estimate 160),
  // 翻转向上时 dropdown 实际高度 > 估计值, top + 实际 > vh-8 会让 footer 被视口
  // 底部切掉. 把 top 拉到 vh - menuHeight - 8 兜底. SPA AccountSwitcher.vue 同款
  // 修复 (commit d4130381 + 757f0a96).
  const maxTop = vh - menuHeight - 8;
  if (top > maxTop) top = Math.max(8, maxTop);
  // left: 默认相对 trigger 右边缘. 视口右侧溢出保护 (留 8px 边距, 左移).
  const desiredLeft = triggerRect.right;
  const overflow = desiredLeft + MENU_WIDTH + 8 - vw;
  const left = overflow > 0 ? desiredLeft - overflow : desiredLeft;
  return { top, left, width: MENU_WIDTH };
}

export default function AccountSwitcher({
  userEmail,
  variant,
}: {
  userEmail: string;
  variant: Variant;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<RecentAccount[]>([]);
  const [busy, setBusy] = useState(false);
  // 飞书 R29 H 列: Dropdown 用 portal 渲染到 body, 这里存 fixed 定位的 inline
  // style. null = 关闭. 打开时根据 trigger.getBoundingClientRect + 视口边界
  // 决定 top/left/方向 (上/下) + 防止溢出左右.
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);
  // Refs let mouseEnter/Leave distinguish "leaving trigger" from "entering
  // dropdown" so the menu doesn't snap closed mid-hover.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // SSR 守卫: portal 只在客户端 document.body 可用时挂载, 否则 hydration
  // mismatch. 先 false, mount 后 set true.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Open = 刷新账号列表 + 计算 Dropdown 位置. 顺手监听 resize 让 trigger
  // 位置变化 (改侧栏宽度 / 浏览器窗口大小) 时 Dropdown 跟着重定位.
  useEffect(() => {
    if (!open) {
      setDropdownStyle(null);
      return;
    }
    setAccounts(getRecentAccounts());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function compute() {
      if (!wrapperRef.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      const { top, left, width } = computeDropdownPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        accounts.length,
      );
      setDropdownStyle({
        position: "fixed",
        top,
        left,
        width,
        zIndex: 9999,
      });
    }
    // First: estimate-based 位置让 dropdown 能渲染 (dropdownStyle 为 null 时不渲染)
    compute();
    // Post-mount: 等 dropdown 渲染完用真实高度重定位. estimate menuHeight 偏差
    // (230+N*38 vs 实测 206+N*38 for N=0 差 24) 让 top 算高, dropdown.bottom 离
    // trigger.bottom 留 24px 空隙. flush:
    //   - canDown: top = rect.bottom (无 gap)
    //   - 翻转:   top = rect.bottom - actual (bottom-aligned, 无 gap)
    // 兜底 clamp 防极小视口 footer 被切.
    const raf = requestAnimationFrame(() => {
      const dd = document.querySelector("[data-account-dropdown] > div") as HTMLElement | null;
      if (!dd || !wrapperRef.current) return;
      const actual = dd.getBoundingClientRect().height;
      const rect = wrapperRef.current.getBoundingClientRect();
      const distToBottom = window.innerHeight - rect.bottom;
      let top = distToBottom >= actual + 16
        ? rect.bottom                     // flush below trigger
        : Math.max(8, rect.bottom - actual); // bottom-aligned above
      const maxTop = window.innerHeight - actual - 8;
      if (top > maxTop) top = Math.max(8, maxTop);
      setDropdownStyle((prev) => prev ? { ...prev, top } : prev);
    });
    window.addEventListener("resize", compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", compute);
    };
  }, [open, accounts.length]);

  // Click-outside closes (all variants — also needed on touch for header /
  // sidebar-collapsed where there's no mouseLeave to trigger the scheduleClose).
  // 注意 dropdown 在 portal 里, 不在 wrapperRef 内, 所以 dropdown 内部的点击
  // 不会误触发关闭 (mousedown target 不在 wrapperRef.contains 内).
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      // dropdown 自己不在 wrapperRef 里, 但 mousedown 命中 dropdown 不算 outside;
      // 显式检查 dropdown 容器 (data attr) 避免点 dropdown 触发关闭.
      const t = e.target as HTMLElement | null;
      const inWrapper = wrapperRef.current?.contains(t as Node) ?? false;
      const inDropdown = t?.closest?.("[data-account-dropdown]") != null;
      if (!inWrapper && !inDropdown) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function scheduleClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }
  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  async function switchTo(target: RecentAccount) {
    if (target.email === userEmail.toLowerCase() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: target.email, token: target.token }),
      });
      if (!res.ok) {
        // Token might be revoked server-side; drop the stale entry and
        // bounce to login so the user can re-authenticate.
        removeRecentAccount(target.email);
        window.location.href = "/login";
        return;
      }
      // After switching, the previous page may belong to a different user's
      // project scope. Land on /settings — a per-user page that always
      // makes sense for the new identity.
      window.location.href = "/settings";
    } catch {
      setBusy(false);
    }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Explicit logout: only remove *this* account, keep the rest so the
      // user can still see and switch to their other identities.
      removeRecentAccount(userEmail);
      window.location.href = "/login";
    } catch {
      setBusy(false);
    }
  }

  // Portal dropdown — 三个 variant 共用. data attr 让 click-outside 检测
  // 知道「这是 dropdown 内部的点击, 不要关」.
  const dropdown =
    open && mounted && dropdownStyle
      ? createPortal(
          <div data-account-dropdown>
            <DropdownBody
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
              userEmail={userEmail}
              accounts={accounts.filter((a) => a.email !== userEmail.toLowerCase())}
              busy={busy}
              onPick={switchTo}
              onLogout={logout}
              showLogout
              style={dropdownStyle}
            />
          </div>,
          document.body,
        )
      : null;

  // --- Variant: header (homepage top-right avatar) -----------------------
  if (variant === "header") {
    const initial = (userEmail[0] || "?").toUpperCase();
    return (
      <>
        <div
          ref={wrapperRef}
          className="relative"
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          <button
            type="button"
            title={userEmail}
            // onClick 让 iPhone 触屏可以点开（hover 在移动端不触发）。
            // 不做 toggle：桌面 hover 已是开启态，toggle 会立刻关闭。统一用
            // setOpen(true)；关闭走 mouseLeave scheduleClose + 外部点击。
            onClick={() => {
              cancelClose();
              setOpen(true);
            }}
            className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-sm font-semibold text-gray-600 hover:bg-gray-300"
          >
            {initial}
          </button>
        </div>
        {dropdown}
      </>
    );
  }

  // --- Variant: sidebar-collapsed (icon-only, hover dropdown) ------------
  if (variant === "sidebar-collapsed") {
    return (
      <>
        <div
          ref={wrapperRef}
          className="relative mt-auto"
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          <button
            type="button"
            title={userEmail}
            // onClick 让 iPhone 触屏可以点开（hover 在移动端不触发）。
            onClick={() => {
              cancelClose();
              setOpen(true);
            }}
            className="p-2 rounded hover:bg-gray-200 text-gray-600 text-base"
          >
            ⏻
          </button>
        </div>
        {dropdown}
      </>
    );
  }

  // --- Variant: sidebar (expanded, 默认折叠, hover/点开二级菜单) -----------
  // 飞书 R29: 账号区域不常用, 收到二级菜单. trigger 行只占 1 行(头像 + email
  // + ▾), hover/点开 → portal 浮层 Dropdown(浮在 body 顶层, 不被侧栏 overflow-hidden 切).
  if (variant === "sidebar") {
    const initial = (userEmail[0] || "?").toUpperCase();
    return (
      <>
        <div
          ref={wrapperRef}
          className="relative"
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          <button
            type="button"
            title={userEmail}
            onClick={() => {
              cancelClose();
              setOpen(true);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-gray-200 text-gray-600 text-sm"
          >
            <span className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center text-xs font-semibold text-gray-600 shrink-0">
              {initial}
            </span>
            <span className="flex-1 text-left truncate" title={userEmail}>
              {userEmail}
            </span>
            <span className="text-gray-400 text-xs">{open ? "▴" : "▾"}</span>
          </button>
        </div>
        {dropdown}
      </>
    );
  }
  return null;
}

// --- Dropdown body ---------------------------------------------------------

function DropdownBody({
  onMouseEnter,
  onMouseLeave,
  userEmail,
  accounts,
  busy,
  onPick,
  onLogout,
  showLogout,
  style,
}: {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  userEmail: string;
  accounts: RecentAccount[];
  busy: boolean;
  onPick: (a: RecentAccount) => void;
  onLogout: () => void;
  showLogout: boolean;
  style: CSSProperties;
}) {
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={style}
      // 飞书 R29 H 列: 浮在最顶层 (z-index 9999 在 inline style), 哪怕超出
      // 当前容器范围也可见 (portal + fixed). max-h-[80vh] 兜底防极端视口.
      className="bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-gray-100">
        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
          当前账号
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-semibold shrink-0">
            {(userEmail[0] || "?").toUpperCase()}
          </span>
          <span className="text-sm text-gray-800 truncate" title={userEmail}>
            {userEmail}
          </span>
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
          切换账号
        </div>
        {accounts.length === 0 ? (
          <div className="px-3 py-2 text-xs text-gray-400">
            暂无其他已登录账号
          </div>
        ) : (
          accounts.map((a) => (
            <button
              key={a.email}
              type="button"
              onClick={() => onPick(a)}
              disabled={busy}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 disabled:opacity-50"
            >
              <span className="w-7 h-7 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center text-xs font-semibold shrink-0">
                {(a.email[0] || "?").toUpperCase()}
              </span>
              <span className="text-sm text-gray-700 truncate flex-1" title={a.email}>
                {a.email}
              </span>
            </button>
          ))
        )}
        {/* "登录其他账号" - 即使没有历史账号也能从这里跳到 /login 添加新账号。
            登录成功后 addRecentAccount 写入 localStorage，当前账号的 switchToken
            仍在，之后两个账号就能互相切换。 */}
        <button
          type="button"
          onClick={() => {
            window.location.href = "/login";
          }}
          disabled={busy}
          className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm text-blue-600 disabled:opacity-50"
        >
          ＋ 登录其他账号
        </button>
      </div>

      {showLogout && (
        <div className="border-t border-gray-100 p-1">
          <button
            type="button"
            onClick={onLogout}
            disabled={busy}
            className="w-full text-left px-3 py-2 rounded hover:bg-gray-50 text-sm text-gray-700 disabled:opacity-50"
          >
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}