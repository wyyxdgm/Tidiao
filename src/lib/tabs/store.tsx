// 功能: 飞书 AO-DEV R123 — 标签页状态 store (Context + useReducer).
//   tabs 存的是已访问 URL 的"书签"列表; 点击导航时新增 tab + 激活;
//   当前激活 tab = 当前 pathname. 渲染时只有 active tab 对应的页面被 Next.js
//   路由渲染 (其它 tab 暂存, 切换时再渲染) — 这是与 iframe 多 tab 的关键区别,
//   实现简单、不需要 portals/parallel routes, 浏览器前进后退正常工作.
// 关注点:
//   1. tab.id 用 path+search 哈希生成, 同 URL 不重复添加.
//   2. localStorage 持久化, 但只在 client mount 后 hydrate — SSR 渲染空态,
//      避免水合不一致 (tabs 是浏览器本地状态, 不影响服务端).
//   3. MAX_TABS 上限 20, 超出时关闭最早的 (LRU 风格). 避免无限制堆积.
//   4. closeTab 若关闭的是 active, 激活右侧邻居; 无右侧激活左侧; 列表空激活 null.

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";

export type Tab = {
  id: string;
  path: string;
  search: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
};

export type TabState = {
  tabs: Tab[];
  activeTabId: string | null;
};

export const MAX_TABS = 20;
const STORAGE_KEY = "nav-tabs-v1";

export function makeTabId(path: string, search: string): string {
  return `${path}?${search}`;
}

export function parseHref(href: string): { path: string; search: string } {
  // href 可能是 "/foo?bar=1" 或 "/foo" 或已是完整 URL (跨域) — 后者由 caller 拦截.
  const qIdx = href.indexOf("?");
  if (qIdx === -1) return { path: href, search: "" };
  return { path: href.slice(0, qIdx), search: href.slice(qIdx + 1) };
}

type Action =
  | { type: "open"; path: string; search: string; title: string }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "closeOthers"; id: string }
  | { type: "closeRight"; id: string }
  | { type: "closeLeft"; id: string }
  | { type: "duplicate"; id: string }
  | { type: "togglePin"; id: string }
  | { type: "closeAll" }
  | { type: "hydrate"; tabs: Tab[]; activeTabId: string | null };

function reducer(state: TabState, action: Action): TabState {
  switch (action.type) {
    case "open": {
      const id = makeTabId(action.path, action.search);
      const existing = state.tabs.find((t) => t.id === id);
      const tabs = existing
        ? state.tabs
        : (() => {
            const next = [
              ...state.tabs,
              {
                id,
                path: action.path,
                search: action.search,
                title: action.title,
                createdAt: Date.now(),
              },
            ];
            // LRU: 超上限关闭最老的非 pinned (active 钉住也保留).
            if (next.length > MAX_TABS) {
              const activeIdx = next.findIndex((t) => t.id === id);
              // 找最早的非 pinned 且非 active 的 tab
              let dropIdx = -1;
              for (let i = 0; i < next.length; i++) {
                if (i === activeIdx) continue;
                if (next[i].pinned) continue;
                dropIdx = i;
                break;
              }
              // 若全部 pinned, 退化到老规则: 踢最早的
              if (dropIdx === -1) {
                dropIdx = activeIdx === 0 && next.length > 1 ? 1 : 0;
              }
              next.splice(dropIdx, 1);
            }
            return next;
          })();
      return { tabs, activeTabId: id };
    }
    case "activate": {
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return { ...state, activeTabId: action.id };
    }
    case "close": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      let activeTabId = state.activeTabId;
      if (state.activeTabId === action.id) {
        if (tabs.length === 0) activeTabId = null;
        else if (idx < tabs.length) activeTabId = tabs[idx].id;
        else activeTabId = tabs[idx - 1].id;
      }
      return { tabs, activeTabId };
    }
    case "rename": {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, title: action.title } : t,
        ),
      };
    }
    case "closeOthers": {
      const keep = state.tabs.find((t) => t.id === action.id);
      if (!keep) return state;
      return { tabs: [keep], activeTabId: keep.id };
    }
    case "closeRight": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const tabs = state.tabs.slice(0, idx + 1);
      let activeTabId = state.activeTabId;
      if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
        activeTabId = tabs[tabs.length - 1].id;
      }
      return { tabs, activeTabId };
    }
    case "closeLeft": {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx === -1) return state;
      const tabs = state.tabs.slice(idx);
      let activeTabId = state.activeTabId;
      if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
        activeTabId = tabs[0].id;
      }
      return { tabs, activeTabId };
    }
    case "duplicate": {
      const src = state.tabs.find((t) => t.id === action.id);
      if (!src) return state;
      // duplicate 共享同一 URL — 不真复制, 在 tab 上加 "(副本)" 标题区分.
      // 同 URL 已存在时直接激活; 这里保留一份独立副本供对比.
      const dup: Tab = {
        ...src,
        id: `${src.id}#dup-${Date.now()}`,
        createdAt: Date.now(),
      };
      const tabs = [...state.tabs, dup];
      // LRU 上限
      if (tabs.length > MAX_TABS) tabs.shift();
      return { tabs, activeTabId: dup.id };
    }
    case "togglePin": {
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, pinned: !t.pinned } : t,
        ),
      };
    }
    case "closeAll":
      return { tabs: [], activeTabId: null };
    case "hydrate":
      return { tabs: action.tabs, activeTabId: action.activeTabId };
    default:
      return state;
  }
}

const initialState: TabState = { tabs: [], activeTabId: null };

export type TabStore = TabState & {
  openTab: (href: string, title?: string) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  closeOthers: (id: string) => void;
  closeRight: (id: string) => void;
  closeLeft: (id: string) => void;
  duplicateTab: (id: string) => void;
  togglePin: (id: string) => void;
  closeAll: () => void;
};

const TabStoreContext = createContext<TabStore | null>(null);

function readPersisted(): TabState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TabState;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs: Tab[] = parsed.tabs
      .filter(
        (t): t is Tab =>
          t &&
          typeof t.id === "string" &&
          typeof t.path === "string" &&
          typeof t.title === "string",
      )
      // hydrate 清扫: 修复前 persist 过的 redirect-only 幽灵 tab (点击即跳走)
      // 一次性洗掉, 不让历史脏数据留在用户的 tab 条上.
      .filter((t) => !isRedirectOnlyPath(t.path))
      .slice(-MAX_TABS);
    return {
      tabs,
      activeTabId:
        typeof parsed.activeTabId === "string" &&
        tabs.some((t) => t.id === parsed.activeTabId)
          ? parsed.activeTabId
          : null,
    };
  } catch {
    return null;
  }
}

function persist(state: TabState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // QuotaExceeded / private mode — silent.
  }
}

// 这些路径不参与 tab 机制 (它们对应独立全屏页面, 没有共用左侧栏).
const FULLPAGE_PATHS = new Set(["/", "/login", "/register"]);

export function isFullPagePath(pathname: string): boolean {
  return FULLPAGE_PATHS.has(pathname);
}

// 项目内 UUID 形态段 (project_id / version_id 等都是 UUID).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 功能: 判定一个路径是否「redirect-only」— 服务端 page 组件无条件 redirect、
//   永远不渲染内容的路径. 这类路径不应开 tab: client-side 导航时 usePathname()
//   会先短暂显示中间值, 等 server RSC redirect 落地才切到目标路径, 中间值
//   一旦被 pathname effect open 成 tab, 就得到一个「点击立即跳到别的 tab」
//   的幽灵 tab (实测: 点面包屑「项目名」→ /{projectId} 中间帧开 tab → 307 到
//   /{projectId}/{versionId}).
// 关注点: 只覆盖无条件 redirect 的路由; 若新增 redirect-only page, 需同步
//   这里 (与该 page 的 redirect() 保持一致).
//   - /{projectId} (1 段 UUID) → redirect 到当前版本 ([projectId]/page.tsx)
//   - /{projectId}/{versionId}/requirements/{id} (4 段) → redirect 到
//     /requirements/{id} ([projectId]/[versionId]/requirements/[id]/page.tsx)
export function isRedirectOnlyPath(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 1) return UUID_RE.test(segs[0]);
  if (segs.length === 4 && segs[2] === "requirements") return true;
  return false;
}

export function TabStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pathname = usePathname();
  const router = useRouter();
  const hydratedRef = useRef(false);

  // Hydrate from localStorage on mount.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const persisted = readPersisted();
    if (persisted) dispatch({ type: "hydrate", ...persisted });
  }, []);

  // Persist on change (after hydration).
  useEffect(() => {
    if (!hydratedRef.current) return;
    persist(state);
  }, [state]);

  // 自动添加/激活 tab: pathname 变化时, 若对应 tab 已存在则激活, 否则新增.
  // 仅对 tabbable 路径生效; 全屏页 (/, /login, /register) 跳过.
  // 关注点: effect 依赖 [pathname, activeTabId] — 关闭激活 tab 时 activeTabId
  // 先变而 pathname 还是旧值 (router.push 异步未完成), 此刻若不拦住会把刚关的
  // tab 重新 open 回来 (表现为"关不掉当前 tab"). 用 ref 记上次已处理的 pathname,
  // 仅 pathname 真变 (真实导航) 时才 open.
  const lastSeenPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hydratedRef.current) return;
    if (isFullPagePath(pathname)) return;
    if (lastSeenPathRef.current === pathname) return;
    lastSeenPathRef.current = pathname;
    // redirect-only 中间帧不开 tab: client-side 导航时 usePathname() 先显示
    // /{projectId} 这类无条件 redirect 路径, server redirect 落地后 pathname
    // 才切到目标路径. 中间帧开 tab = 幽灵 tab (点击立即跳走), 直接跳过.
    if (isRedirectOnlyPath(pathname)) return;
    const search = window.location.search.replace(/^\?/, "");
    const id = makeTabId(pathname, search);
    if (state.activeTabId === id) return;
    dispatch({
      type: "open",
      path: pathname,
      search,
      title: defaultTitle(pathname, search),
    });
  }, [pathname, state.activeTabId]);

  // 用全局 document.title 回写激活 tab 的 title (在 navigation 完成后
  // Next.js 会更新 document.title, 此时拿到的就是页面真实标题).
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!state.activeTabId) return;
    const activeId = state.activeTabId;
    const t = setTimeout(() => {
      const title = document.title;
      if (!title) return;
      dispatch({ type: "rename", id: activeId, title });
    }, 200);
    return () => clearTimeout(t);
  }, [state.activeTabId]);

  const openTab = useCallback(
    (href: string, title?: string) => {
      const { path, search } = parseHref(href);
      if (isFullPagePath(path)) {
        router.push(href);
        return;
      }
      // redirect-only 路径只导航不开 tab (同 pathname effect 的中间帧防护).
      if (isRedirectOnlyPath(path)) {
        router.push(href);
        return;
      }
      const id = makeTabId(path, search);
      if (state.tabs.some((t) => t.id === id) && state.activeTabId !== id) {
        router.push(href);
        return;
      }
      dispatch({
        type: "open",
        path,
        search,
        title: title ?? defaultTitle(path, search),
      });
      router.push(href);
    },
    [router, state.tabs, state.activeTabId],
  );

  const activateTab = useCallback(
    (id: string) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return;
      dispatch({ type: "activate", id });
      router.push(`${tab.path}${tab.search ? `?${tab.search}` : ""}`);
    },
    [router, state.tabs],
  );

  const closeTab = useCallback(
    (id: string) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return;
      const wasActive = state.activeTabId === id;
      const idx = state.tabs.findIndex((t) => t.id === id);
      const remaining = state.tabs.filter((t) => t.id !== id);
      dispatch({ type: "close", id });
      if (wasActive) {
        // 切到下一个 tab: 先找右侧, 再找左侧.
        const next =
          remaining[idx] ?? remaining[idx - 1] ?? remaining[0] ?? null;
        if (next) {
          router.push(
            `${next.path}${next.search ? `?${next.search}` : ""}`,
          );
        } else {
          router.push("/global");
        }
      }
    },
    [router, state.tabs, state.activeTabId],
  );

  const closeOthers = useCallback(
    (id: string) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      dispatch({ type: "closeOthers", id });
      // 激活右键的 tab; 若右键的不是 active, 同步切路由
      if (state.activeTabId !== id) {
        const tab = state.tabs[idx];
        router.push(`${tab.path}${tab.search ? `?${tab.search}` : ""}`);
      }
    },
    [router, state.tabs, state.activeTabId],
  );

  const closeRight = useCallback(
    (id: string) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      dispatch({ type: "closeRight", id });
      // 激活右键的 tab (若还不是 active)
      if (state.activeTabId !== id) {
        const tab = state.tabs[idx];
        router.push(`${tab.path}${tab.search ? `?${tab.search}` : ""}`);
      }
    },
    [router, state.tabs, state.activeTabId],
  );

  const closeLeft = useCallback(
    (id: string) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      dispatch({ type: "closeLeft", id });
      // 激活右键的 tab (若还不是 active)
      if (state.activeTabId !== id) {
        const tab = state.tabs[idx];
        router.push(`${tab.path}${tab.search ? `?${tab.search}` : ""}`);
      }
    },
    [router, state.tabs, state.activeTabId],
  );

  const duplicateTab = useCallback((id: string) => {
    dispatch({ type: "duplicate", id });
  }, []);

  const togglePin = useCallback((id: string) => {
    dispatch({ type: "togglePin", id });
  }, []);

  const closeAll = useCallback(() => {
    dispatch({ type: "closeAll" });
    router.push("/global");
  }, [router]);

  const renameTab = useCallback((id: string, title: string) => {
    dispatch({ type: "rename", id, title });
  }, []);

  const store = useMemo<TabStore>(
    () => ({
      ...state,
      openTab,
      activateTab,
      closeTab,
      renameTab,
      closeOthers,
      closeRight,
      closeLeft,
      duplicateTab,
      togglePin,
      closeAll,
    }),
    [
      state,
      openTab,
      activateTab,
      closeTab,
      renameTab,
      closeOthers,
      closeRight,
      closeLeft,
      duplicateTab,
      togglePin,
      closeAll,
    ],
  );

  return (
    <TabStoreContext.Provider value={store}>
      {children}
    </TabStoreContext.Provider>
  );
}

export function useTabStore(): TabStore {
  const ctx = useContext(TabStoreContext);
  if (!ctx) {
    throw new Error("useTabStore must be used within <TabStoreProvider>");
  }
  return ctx;
}

// 从 path/search 推断默认标题 (页面 document.title 尚未更新时的兜底).
// 模式: /schedules → "定时任务", /requirements → "需求点管理", /tasks/{id} → "任务 ...",
// /{projectId}/{versionId} → 用 version id 短截 (项目名需要 fetch, 暂用 id).
export function defaultTitle(path: string, search: string): string {
  if (path === "/schedules") return "定时任务";
  if (path === "/requirements") return "需求点管理";
  if (path === "/assets") return "资源池";
  if (path === "/usage") return "用量统计";
  if (path === "/global") return "全局看板";
  if (path === "/import") return "批量导入";
  if (path === "/settings") return "设置";
  if (path === "/stats") return "统计";
  if (path === "/runners") return "Runner";
  if (path === "/templates") return "模板";
  if (path === "/webhooks") return "Webhook";
  if (path === "/progress") return "进度";
  if (path === "/transcript") return "Transcript";
  if (path === "/uncategorized") return "未分类";
  if (path.startsWith("/tasks/")) {
    const id = path.slice("/tasks/".length).slice(0, 8);
    return `任务 ${id}`;
  }
  if (path === "/login") return "登录";
  if (path === "/register") return "注册";
  // /{projectId}/... — 用第一段 id 兜底, 真实项目名由 document.title 回写.
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    if (parts[1] === "wiki") {
      const wikiPath = new URLSearchParams(search).get("path");
      return wikiPath ? `Wiki · ${wikiPath.split("/").pop()}` : "Wiki";
    }
    if (parts[1] === "board") return "Board";
    if (parts[1] === "requirements") return "需求";
    return parts[1].slice(0, 8);
  }
  return path || "/";
}

// 仅测试用 — 把模块私有函数集中暴露给单测, 生产代码不应 import.
export const __test = {
  makeTabId,
  parseHref,
  defaultTitle,
  isFullPagePath,
  isRedirectOnlyPath,
  reducer,
  MAX_TABS,
} satisfies Record<string, unknown>;