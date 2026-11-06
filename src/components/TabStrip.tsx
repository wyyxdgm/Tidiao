"use client";

// 功能: 飞书 AO-DEV R123 — 标签页 UI. 渲染在 <main> 顶部, 显示已打开的 tab,
//  当前激活高亮, 鼠标悬停显示完整 URL, 中键/× 关闭, 右键菜单 (关闭其它/全部/左侧/右侧/复制/钉住/刷新/重命名).
// 关注点:
//   1. horizontal scroll: tab 多于可视宽度时滚动, 不换行 (避免抢占页面内容).
//   2. tab 标题超长截断 (max-w), 完整 title 走 title= 属性 + 鼠标悬停.
//   3. 中键点击 = 关闭 (浏览器原生行为); 左键 = 激活; 右键 = 上下文菜单.
//   4. 钉住的 tab 显示 📌 图标, 不参与 LRU 淘汰 (隐式: store 的 LRU 跳过 pinned).
//   5. 标题显示走 useResolvedTitle — 任务/项目/版本显示真名, 不只是 ID.
//   6. 飞书 AO-DEV R129 — sticky top-0: tab 条在内容滚动时保持固定在视口顶部
//     不随页面滚动消失. sticky 在最近的滚动祖先内生效 (此处 = window/body),
//     因此 <main> 不需要 overflow-auto. 背景色 bg-gray-50 已实色, 内容滚动时
//     不会透到 tab 条后面. shrink-0 防止 flex 容器把 tab 条压扁.

import { useEffect, useRef, useState } from "react";
import { useTabStore, type Tab } from "@/lib/tabs/store";
import { useResolvedTitle } from "@/lib/tabs/title-resolver";

export default function TabStrip() {
  const {
    tabs,
    activeTabId,
    activateTab,
    closeTab,
    closeOthers,
    closeRight,
    closeLeft,
    duplicateTab,
    togglePin,
    closeAll,
    renameTab,
  } = useTabStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<{ tabId: string; value: string } | null>(
    null,
  );

  // 激活 tab 改变时, 自动滚动到可视区.
  useEffect(() => {
    if (!activeTabId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLDivElement>(
      `[data-tab-id="${CSS.escape(activeTabId)}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [activeTabId]);

  // damo R123 D1 + R152 第二轮: Cmd+W (macOS) / Ctrl+W (其他) 关当前激活的 tab,
  //   且始终拦截浏览器原生 Cmd+W 关 window/tab 的默认行为 (damo 反馈: 即便没
  //   打开 tab, 浏览器关整个 window 也是反直觉).
  //   用 capture phase + document 级监听 (TabStrip 只占顶部一行, 全局快捷键体验更好).
  //   关注点:
  //     1. preventDefault + stopPropagation 始终在 isEditableTarget 检查之前 —
  //        浏览器默认关 window/tab 行为必须无条件拦截; preventDefault 不影响 'w'
  //        字符输入 (keypress 是另一事件), 所以在输入框里输入 Cmd+W 仍能写字.
  //     2. 输入框/重命名对话框 不触发 closeTab 副作用 (避免用户正在编辑的 tab 被关).
  //     3. activeTabId 为空时不 closeTab (但浏览器默认已被拦截).
  useEffect(() => {
    function isEditableTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      // Cmd+W (mac) / Ctrl+W (其他) — 标准 "关当前" 快捷键
      const isCloseCombo =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w";
      if (!isCloseCombo) return;
      // 始终拦截浏览器默认 (关整个 window / 关最近 tabbed window).
      // damo R152 第二轮: 即便用户没打开 tab 容器 tab, 也不该让浏览器关掉整个页面.
      e.preventDefault();
      e.stopPropagation();
      // 输入框里不触发 closeTab (rename dialog / 页面内搜索框 等).
      // — 浏览器默认已被上面 preventDefault 拦掉, 这里只挡 closeTab 副作用.
      if (isEditableTarget(e.target)) return;
      // rename dialog 开着时不触发 closeTab (用户可能正在输入 'w' 作为标题字符).
      if (renaming) return;
      // 没激活 tab 不 closeTab (但浏览器默认已被拦截).
      if (!activeTabId) return;
      closeTab(activeTabId);
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeTabId, renaming, closeTab]);

  // 右键菜单关闭 (点其它地方).
  useEffect(() => {
    if (!menu) return;
    function onDocClick() {
      setMenu(null);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menu]);

  if (tabs.length === 0) return null;

  const menuTab = menu ? tabs.findIndex((t) => t.id === menu.tabId) : -1;
  const hasLeft = menuTab > 0;
  const hasRight = menuTab >= 0 && menuTab < tabs.length - 1;
  const otherCount = tabs.length - 1;
  const rightCount = menuTab >= 0 ? tabs.length - 1 - menuTab : 0;
  const leftCount = menuTab > 0 ? menuTab : 0;

  return (
    <div className="sticky top-0 z-20 shrink-0 relative border-b border-gray-200 bg-gray-50">
      <div
        ref={scrollRef}
        className="flex overflow-x-auto overflow-y-hidden h-9 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:bg-gray-300"
        role="tablist"
        aria-label="已打开的标签页"
      >
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onActivate={() => activateTab(tab.id)}
            onClose={(e) => {
              // preventDefault + stopPropagation 双保险:
              //   - preventDefault 阻止原生 click 默认行为 (mousedown/mouseup 选中)
              //   - stopPropagation 阻止事件冒泡到外层 div 的 onActivate,
              //     否则会触发「关闭后立即激活」(React 19 + 同步 dispatch 下能看到中间态)
              //   - nativeEvent.stopImmediatePropagation 防 capture-phase 监听器误触发
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              closeTab(tab.id);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
            }}
            onDoubleClick={() => {
              const current = tabs.find((t) => t.id === tab.id);
              setRenaming({ tabId: tab.id, value: current?.title ?? "" });
            }}
          />
        ))}
      </div>
      {menu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[160px] bg-white border border-gray-200 rounded shadow-lg py-1 text-sm"
          style={{ left: menu.x, top: menu.y }}
        >
          <MenuItem
            label="重新载入"
            onClick={() => {
              const tab = tabs.find((t) => t.id === menu.tabId);
              if (tab) {
                activateTab(tab.id);
                // router.push 同 URL 会触发 next.js 重新 fetch, 用 query 加 _ts 强制刷新
                const sep = tab.search ? "&" : "?";
                const url = `${tab.path}${tab.search}${sep}_ts=${Date.now()}`;
                window.location.assign(url);
              }
              setMenu(null);
            }}
          />
          <MenuItem
            label="复制 URL"
            onClick={() => {
              const tab = tabs.find((t) => t.id === menu.tabId);
              if (tab) {
                // 🔴 hash 路由: tasks 页复制出去的 URL 落 SPA (/#/tasks/...); 其余旧壳路由保持原样
                const hashPath = /^\/tasks\/[0-9a-f-]+$/.test(tab.path)
                  ? `/#${tab.path}`
                  : tab.path;
                const url = `${window.location.origin}${hashPath}${tab.search ? `?${tab.search}` : ""}`;
                void navigator.clipboard?.writeText(url).catch(() => {});
              }
              setMenu(null);
            }}
          />
          <MenuItem
            label={tabs.find((t) => t.id === menu.tabId)?.pinned ? "取消钉住" : "钉住"}
            onClick={() => {
              togglePin(menu.tabId);
              setMenu(null);
            }}
          />
          <div className="border-t border-gray-200 my-1" />
          <MenuItem
            label="重命名…"
            onClick={() => {
              const tab = tabs.find((t) => t.id === menu.tabId);
              if (tab) setRenaming({ tabId: tab.id, value: tab.title });
              setMenu(null);
            }}
          />
          <MenuItem
            label="复制 (新标签页)"
            onClick={() => {
              duplicateTab(menu.tabId);
              setMenu(null);
            }}
          />
          <div className="border-t border-gray-200 my-1" />
          <MenuItem
            label="关闭"
            onClick={() => {
              closeTab(menu.tabId);
              setMenu(null);
            }}
          />
          <MenuItem
            label={`关闭左侧 (${leftCount})`}
            disabled={!hasLeft}
            onClick={() => {
              closeLeft(menu.tabId);
              setMenu(null);
            }}
          />
          <MenuItem
            label={`关闭右侧 (${rightCount})`}
            disabled={!hasRight}
            onClick={() => {
              closeRight(menu.tabId);
              setMenu(null);
            }}
          />
          <MenuItem
            label={`关闭其它 (${otherCount})`}
            disabled={otherCount === 0}
            onClick={() => {
              closeOthers(menu.tabId);
              setMenu(null);
            }}
          />
          <MenuItem
            label="关闭全部"
            disabled={tabs.length === 0}
            onClick={() => {
              closeAll();
              setMenu(null);
            }}
          />
        </div>
      )}
      {renaming && (
        <RenameDialog
          initial={renaming.value}
          onConfirm={(value) => {
            renameTab(renaming.tabId, value);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      className="block w-full text-left px-3 py-1.5 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function RenameDialog({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/30" onClick={onCancel}>
      <div
        className="bg-white rounded shadow-lg p-4 w-[400px] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium mb-2">重命名标签页</div>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(value.trim() || initial);
            if (e.key === "Escape") onCancel();
          }}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
          maxLength={80}
        />
        <div className="flex justify-end gap-2 mt-3 text-sm">
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded text-gray-600 hover:bg-gray-100"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(value.trim() || initial)}
            className="px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

function TabItem({
  tab,
  active,
  onActivate,
  onClose,
  onAuxClick,
  onContextMenu,
  onDoubleClick,
}: {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: (e: React.MouseEvent) => void;
  onAuxClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const resolved = useResolvedTitle(tab.path, tab.search);
  const fullTitle = tab.search
    ? `${tab.path}?${tab.search}`
    : tab.path;
  return (
    <div
      data-tab-id={tab.id}
      role="tab"
      aria-selected={active}
      title={fullTitle}
      onClick={onActivate}
      onAuxClick={onAuxClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      className={`group shrink-0 flex items-center gap-1 pl-3 pr-2 border-r border-gray-200 cursor-pointer select-none max-w-[240px] ${
        active
          ? "bg-white text-gray-900 border-b-2 border-b-blue-500 -mb-px"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
      }`}
    >
      {tab.pinned && <span className="shrink-0 text-[10px]" title="已钉住">📌</span>}
      <span className="truncate text-xs flex-1 min-w-0">{resolved || tab.title || fullTitle}</span>
      <button
        type="button"
        onClick={onClose}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label={`关闭 ${tab.title}`}
        title="关闭"
        // 永远可见; 不参与 tab 激活 (z-index 高 + onClick 防冒泡).
        className="shrink-0 w-5 h-5 rounded text-base leading-none flex items-center justify-center text-gray-500 hover:bg-gray-300 hover:text-gray-900 relative z-10"
      >
        ×
      </button>
    </div>
  );
}