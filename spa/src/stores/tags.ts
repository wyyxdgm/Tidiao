import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const CUSTOM_TITLES_KEY = 'tab-custom-titles-v1';
const PINNED_PATHS_KEY = 'tab-pinned-paths-v1';
const PERSIST_KEY = 'tab-list-persist-v1'; // key 存在 = 开关 ON
const LIST_KEY = 'tab-list-v1'; // 仅 PERSIST_KEY='1' 时写入

/** Read all persisted custom titles. Returns {} on parse error / disabled
 *  storage — never throws into the visit() hot path. */
function loadCustomTitles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CUSTOM_TITLES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCustomTitle(path: string, title: string): void {
  const all = loadCustomTitles();
  all[path] = title;
  try {
    localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(all));
  } catch {
    // storage full / disabled — silently degrade. Title still updates in-memory.
  }
}

/** Pinned paths = array, persisted as JSON. Set semantics on lookup. */
function loadPinnedPaths(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_PATHS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

function savePinnedPaths(paths: Set<string>): void {
  try {
    localStorage.setItem(PINNED_PATHS_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore
  }
}

/** 持久化开关 — 默认关, 刷新不保留 visited[]. ON 时每次 commit() 写
 *  tab-list-v1; store 初始化时若 ON 则 hydrate. 开关关闭时清空列表
 *  (避免「关了开关后刷新还是从老列表恢复」的歧义). */
function loadPersistEnabled(): boolean {
  try {
    return localStorage.getItem(PERSIST_KEY) === '1';
  } catch {
    return false;
  }
}

function saveList(visited: TagItem[]): void {
  if (!loadPersistEnabled()) return;
  try {
    // 存 title: 路由 afterEach 每次都会用 meta tagTitle 刷新 visited[].title
    // (customTitle 例外, 由 tab-custom-titles-v1 持久化覆盖). 因此 LIST_KEY
    // 里存的就是最近一次同步后的标题 — 哪怕 stale, 首次 render 后 afterEach
    // 会用最新 meta 覆盖回来. 列表短, 全量序列化便宜.
    const data = visited.map((t) => ({
      name: t.name,
      title: t.title,
      path: t.path,
      query: t.query,
    }));
    localStorage.setItem(LIST_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

function loadList(): TagItem[] {
  if (!loadPersistEnabled()) return [];
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const customTitles = loadCustomTitles();
    const pinned = loadPinnedPaths();
    return parsed
      .filter((e): e is { name: string; title: string; path: string; query?: Record<string, string> } => {
        return (
          typeof e === 'object' &&
          e !== null &&
          typeof (e as { name?: unknown }).name === 'string' &&
          typeof (e as { title?: unknown }).title === 'string' &&
          typeof (e as { path?: unknown }).path === 'string'
        );
      })
      .map((e) => {
        // customTitle 优先; 没自定义时用存时的 title 兜底 (旧版本 fallback
        // 到 path 让 tab 显示一长串 URL — 不直观).
        const custom = customTitles[e.path];
        return {
          name: e.name,
          title: custom || e.title,
          path: e.path,
          query: e.query,
          customTitle: !!custom,
          closable: pinned.has(e.path) ? false : true,
        } satisfies TagItem;
      });
  } catch {
    return [];
  }
}

export interface TagItem {
  // Cache key fed to <keep-alive include=...>. R165 起 = 路由组件名
  // (comp.name ?? comp.__name, router/index.ts afterEach 推导): keep-alive
  // 的 include 只按组件名匹配, 存 path/tagName 永不命中 = 缓存从未生效.
  // 多实例 (同组件不同 path) 由 MainLayout 的 :key="route.path" 分槽,
  // 不靠这里的 name 区分.
  name: string;
  // Human label shown in the tab.
  title: string;
  // URL path WITHOUT query (path is the tab identity for close/activate).
  path: string;
  // Last-seen query snapshot for this path. R57: 切回 tab 时还原, 否则 URL-driven
  // 输入 (e.g. BoardPage searchText 绑 route.query.q) 切走就丢. 每次 URL 变
  // (push/replace, 包括 updateQuery 改 query) afterEach 都会写新快照.
  query?: Record<string, string>;
  // Optional: true if tab can be closed.
  closable?: boolean;
  // User renamed this tab via the context menu — preserve across re-visits
  // (router.afterEach re-registers the original meta tagTitle every push).
  customTitle?: boolean;
}

// tags store: source of truth for open tabs + currently active tab.
// The <keep-alive> in App.vue binds :include to cachedNames, so closing a tag
// removes its name from include → instance unmounts → state gone.
// Switching active tag just updates current, the keep-alive cache holds
// all open components (no remount, no re-fetch).
export const useTagsStore = defineStore('tags', () => {
  const persistEnabled = ref<boolean>(loadPersistEnabled());
  const visited = ref<TagTag[]>(loadList());
  const currentPath = ref<string>('');

  // Helper local alias to keep typing tight.
  type TagTag = TagItem;

  const cachedNames = computed(() => visited.value.map((t) => t.name));

  /** R59: 持久化开关切换. ON → 立即 snapshot 当前 visited[], 后续每次
   *  commit() 写盘; OFF → 清掉 PERSIST_KEY 和 LIST_KEY (避免下次开启又
   *  把老列表复活). 暴露给 TagsView 用顶部 toggle 按钮. */
  function setPersist(on: boolean): void {
    persistEnabled.value = on;
    try {
      if (on) {
        localStorage.setItem(PERSIST_KEY, '1');
        commit();
      } else {
        localStorage.removeItem(PERSIST_KEY);
        localStorage.removeItem(LIST_KEY);
      }
    } catch {
      // ignore — toggle UI 状态已更新, 存储失败不抛
    }
  }

  /** R59: 写 visited[] 到 LIST_KEY. OFF 时 no-op (loadPersistEnabled 内
   *  早退, 避免每次 mutate 都查 localStorage 拖慢热路径). */
  function commit(): void {
    if (!persistEnabled.value) return;
    saveList(visited.value);
  }

  function visit(tag: TagItem): boolean {
    // Already open: just make it active. Don't reorder the list — preserve the
    // user's mental model of tab order.
    const existing = visited.value.find((t) => t.path === tag.path);
    if (existing) {
      // R57: 同步 query 快照 — 即使 path 没变, URL query 可能变了 (用户在搜索框
      // 打字触发 router.replace({query})). 切回这个 tab 时按最新快照还原.
      existing.query = tag.query;
      // Respect user rename: router.afterEach 每次推都带原始 meta tagTitle, 不
      // 覆盖用户自定义过的标题.
      if (!existing.customTitle) existing.title = tag.title;
      currentPath.value = tag.path;
      commit();
      return false;
    }
    // New tab: check localStorage for prior customTitle + pinned state.
    // Both path-keyed, survive refresh AND close+reopen of the same path.
    const customTitles = loadCustomTitles();
    const stored = customTitles[tag.path];
    const pinned = loadPinnedPaths().has(tag.path);
    visited.value.push({
      ...tag,
      title: stored || tag.title,
      customTitle: !!stored,
      closable: pinned ? false : tag.closable ?? true,
    });
    currentPath.value = tag.path;
    commit();
    return true;
  }

  function activate(path: string) {
    const existing = visited.value.find((t) => t.path === path);
    if (existing) currentPath.value = path;
    commit();
  }

  function close(path: string) {
    const idx = visited.value.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const tag = visited.value[idx];
    if (tag.closable === false) return; // pin
    visited.value.splice(idx, 1);

    // If closing current, activate the previous (or next) tab.
    if (currentPath.value === path) {
      const fallback =
        visited.value[idx - 1] || visited.value[idx] /* next, after splice */;
      currentPath.value = fallback?.path || '';
    }
    commit();
  }

  function closeOthers(path: string) {
    visited.value = visited.value.filter(
      (t) => t.path === path || t.closable === false,
    );
    currentPath.value = path;
    commit();
  }

  // 关掉 idx 之前的所有可关 tab (保留 path 自身 + 之前所有 pinned). 若当前
  // active 落在被关区间, fallback 到 path (切到的下一个 = path).
  function closeLeft(path: string) {
    const idx = visited.value.findIndex((t) => t.path === path);
    if (idx <= 0) return;
    const kept: TagItem[] = [];
    for (let i = 0; i < visited.value.length; i++) {
      const t = visited.value[i];
      if (i >= idx || t.closable === false) kept.push(t);
    }
    visited.value = kept;
    if (!kept.some((t) => t.path === currentPath.value)) {
      currentPath.value = path;
    }
    commit();
  }

  // 关掉 idx 之后的所有可关 tab (保留 path 自身 + 之后所有 pinned). active
  // 落在被关区间时 fallback 同 closeLeft.
  function closeRight(path: string) {
    const idx = visited.value.findIndex((t) => t.path === path);
    if (idx === -1) return;
    visited.value = visited.value.filter(
      (t, i) => i <= idx || t.closable === false,
    );
    if (!visited.value.some((t) => t.path === currentPath.value)) {
      currentPath.value = path;
    }
    commit();
  }

  // 重命名. 持久化到 localStorage (key=path) 以扛刷新; 同时标 customTitle
  // 防止 router.afterEach 的 meta tagTitle 后续覆盖.
  function rename(path: string, title: string) {
    const t = visited.value.find((x) => x.path === path);
    if (!t) return;
    const next = title.trim();
    if (!next) return;
    t.title = next;
    t.customTitle = true;
    saveCustomTitle(path, next);
    commit();
  }

  // 应用标题, 但不覆盖用户自定义过的标题 (customTitle=true). 自动标题场景
  // 用 (例如任务详情加载后算出「项目-任务」标题, 用户没手动重命名就接受
  // 这个值, 用户重命名过就保留).
  //
  // R74 fix: 写入时同时设 customTitle=true, 跟 rename 对齐. 否则切走再切
  // 回时 router.afterEach 会拿 meta.tagTitle (例如 "任务") 把已升级好的
  // 「项目-任务」覆盖掉. 升级后这段标题也是「用户视角的最终值」, 不该再
  // 被 meta placeholder 抢走.
  function applyTitle(path: string, title: string) {
    const t = visited.value.find((x) => x.path === path);
    if (!t) return;
    if (t.customTitle) return;
    const next = title.trim();
    if (!next) return;
    t.title = next;
    t.customTitle = true;
    commit();
  }

  // 固定 / 取消固定 = 切换 closable. pinned (closable=false) 时 × 隐藏, 不
  // 受 closeOthers/closeAll/closeLeft/closeRight 影响. 持久化到 localStorage
  // (path-keyed) 让刷新后仍保留固定状态.
  function togglePin(path: string) {
    const t = visited.value.find((x) => x.path === path);
    if (!t) return;
    t.closable = !(t.closable ?? true);
    const pinned = loadPinnedPaths();
    if (t.closable === false) pinned.add(path);
    else pinned.delete(path);
    savePinnedPaths(pinned);
    commit();
  }

  function closeAll() {
    visited.value = visited.value.filter((t) => t.closable === false);
    if (visited.value.length) currentPath.value = visited.value[0].path;
    else currentPath.value = '';
    commit();
  }

  return {
    visited,
    currentPath,
    cachedNames,
    persistEnabled,
    setPersist,
    visit,
    activate,
    close,
    closeOthers,
    closeLeft,
    closeRight,
    rename,
    applyTitle,
    togglePin,
    closeAll,
  };
});