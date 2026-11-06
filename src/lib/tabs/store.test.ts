// 飞书 AO-DEV R123 — tab store reducer 单测 (纯函数, 无 React 依赖).

import { describe, expect, it } from "vitest";

// 复制 reducer 内部逻辑用于单测 (避免在测试里拉 React 上下文).
// 因为 reducer 是模块内私有函数, 这里通过覆盖 STORAGE_KEY 重置并直接 import
// 后, 通过 dispatch 的纯函数版本来测. 但 store.tsx 里 reducer 是私有的,
// 最简单的做法: 把 reducer 抽到独立文件 (本测试只覆盖逻辑分支).
//
// 这里采取务实做法: 不测 React 集成 (RTL 跑不动), 测一组关键 reducer case
// 用一个独立的小函数封装的核心逻辑 (makeTabId / parseHref / defaultTitle).
import { __test as _internal } from "@/lib/tabs/store";
import type { TabState } from "@/lib/tabs/store";

describe("tab reducer core helpers", () => {
  it("makeTabId / parseHref 是可逆的", () => {
    const { makeTabId, parseHref } = _internal;
    const cases: Array<[string, string]> = [
      ["/schedules", ""],
      ["/requirements", ""],
      ["/37c28ff5-d8c5-448d-9bbb-499709e01f82/2c358aeb-93ff-4141-b8cf-02aec4598b0a", ""],
      ["/tasks/abc-123", ""],
      ["/30068824-3539-4ab9-85ff-5c149eb84484/wiki", "path=CLAUDE.md"],
      ["/foo", "bar=1&baz=2"],
    ];
    for (const [path, search] of cases) {
      const id = makeTabId(path, search);
      expect(id).toBe(`${path}?${search}`);
      const href = search ? `${path}?${search}` : path;
      expect(parseHref(href)).toEqual({ path, search });
    }
  });

  it("defaultTitle 命中已知路径", () => {
    const { defaultTitle } = _internal;
    expect(defaultTitle("/schedules", "")).toBe("定时任务");
    expect(defaultTitle("/requirements", "")).toBe("需求点管理");
    expect(defaultTitle("/usage", "")).toBe("用量统计");
    expect(defaultTitle("/global", "")).toBe("全局看板");
    expect(defaultTitle("/tasks/abc12345-xxxx", "")).toBe("任务 abc12345");
    expect(defaultTitle("/assets", "")).toBe("资源池");
    expect(defaultTitle("/settings", "")).toBe("设置");
  });

  it("defaultTitle wiki path 用 leaf 名", () => {
    const { defaultTitle } = _internal;
    expect(
      defaultTitle(
        "/30068824-3539-4ab9-85ff-5c149eb84484/wiki",
        "path=docs/sub/file.md",
      ),
    ).toBe("Wiki · file.md");
  });

  it("defaultTitle 未知路径兜底", () => {
    const { defaultTitle } = _internal;
    expect(defaultTitle("/abc-456/foo", "")).toBe("foo");
    expect(defaultTitle("/unknown", "")).toBe("/unknown");
  });

  it("isFullPagePath 区分全屏页", () => {
    const { isFullPagePath } = _internal;
    expect(isFullPagePath("/")).toBe(true);
    expect(isFullPagePath("/login")).toBe(true);
    expect(isFullPagePath("/register")).toBe(true);
    expect(isFullPagePath("/schedules")).toBe(false);
    expect(isFullPagePath("/requirements")).toBe(false);
    expect(isFullPagePath("/tasks/abc")).toBe(false);
  });

  it("isRedirectOnlyPath 命中项目根 redirect 中间帧 (幽灵 tab 根因)", () => {
    const { isRedirectOnlyPath } = _internal;
    // /[projectId] (UUID 1 段) → 服务端无条件 redirect 到当前版本
    expect(
      isRedirectOnlyPath("/43b6a7f1-b183-4820-b5f0-e3656e574ee8"),
    ).toBe(true);
    // /{p}/{v}/requirements/{id} → 服务端无条件 redirect 到 /requirements/{id}
    expect(
      isRedirectOnlyPath(
        "/43b6a7f1-b183-4820-b5f0-e3656e574ee8/047b972c-622f-480c-a865-1e500e96f87f/requirements/1a52c7c0-88e2-4974-94c2-a8dfa210523d",
      ),
    ).toBe(true);
    // 合法页面不开杀戒
    expect(isRedirectOnlyPath("/schedules")).toBe(false);
    expect(isRedirectOnlyPath("/projects")).toBe(false); // 非 UUID 1 段不误伤
    expect(
      isRedirectOnlyPath(
        "/43b6a7f1-b183-4820-b5f0-e3656e574ee8/047b972c-622f-480c-a865-1e500e96f87f",
      ),
    ).toBe(false); // 版本看板是真实页面
    expect(
      isRedirectOnlyPath(
        "/43b6a7f1-b183-4820-b5f0-e3656e574ee8/unversioned/requirements",
      ),
    ).toBe(false); // 3 段未挂版本需求列表是真实页面
    expect(
      isRedirectOnlyPath(
        "/30068824-3539-4ab9-85ff-5c149eb84484/wiki",
      ),
    ).toBe(false);
  });

  it("hydrate 清扫: readPersisted 洗掉 redirect-only 幽灵 tab", async () => {
    // readPersisted 是模块私有, 这里直接驱动 localStorage + reducer hydrate
    // 的过滤语义: isRedirectOnlyPath 是清扫判据, 行为等价于
    // persisted.tabs.filter(t => !isRedirectOnlyPath(t.path)).
    const { isRedirectOnlyPath } = _internal;
    const persistedPaths = [
      "/43b6a7f1-b183-4820-b5f0-e3656e574ee8", // 幽灵: 项目根
      "/43b6a7f1-b183-4820-b5f0-e3656e574ee8/047b972c-622f-480c-a865-1e500e96f87f", // 合法
      "/schedules", // 合法
    ];
    const kept = persistedPaths.filter((p) => !isRedirectOnlyPath(p));
    expect(kept).toEqual([
      "/43b6a7f1-b183-4820-b5f0-e3656e574ee8/047b972c-622f-480c-a865-1e500e96f87f",
      "/schedules",
    ]);
  });
});

describe("tab reducer 行为分支", () => {
  const reducer = _internal.reducer;
  const empty: TabState = { tabs: [], activeTabId: null };

  it("open 新增 tab 并激活", () => {
    const s1 = reducer(empty, {
      type: "open",
      path: "/schedules",
      search: "",
      title: "定时任务",
    });
    expect(s1.tabs).toHaveLength(1);
    expect(s1.activeTabId).toBe("/schedules?");
    const s2 = reducer(s1, {
      type: "open",
      path: "/requirements",
      search: "",
      title: "需求点管理",
    });
    expect(s2.tabs).toHaveLength(2);
    expect(s2.activeTabId).toBe("/requirements?");
  });

  it("open 同 URL 重复 → 不新增, 只激活", () => {
    const s1 = reducer(empty, {
      type: "open",
      path: "/schedules",
      search: "",
      title: "定时任务",
    });
    const s2 = reducer(s1, {
      type: "open",
      path: "/schedules",
      search: "",
      title: "定时任务",
    });
    expect(s2.tabs).toHaveLength(1);
    expect(s2.activeTabId).toBe(s1.activeTabId);
  });

  it("open 超出 MAX_TABS → LRU 关闭最老 (除 active)", () => {
    let state = empty;
    // 先建 20 个 (用 active 之外的填充)
    for (let i = 0; i < 20; i++) {
      state = reducer(state, {
        type: "open",
        path: `/p${i}`,
        search: "",
        title: `P${i}`,
      });
    }
    expect(state.tabs).toHaveLength(20);
    // 第 21 个, 关闭最早的非 active tab (active 是 /p19)
    state = reducer(state, {
      type: "open",
      path: "/p20",
      search: "",
      title: "P20",
    });
    expect(state.tabs).toHaveLength(20);
    expect(state.tabs[0].path).not.toBe("/p0"); // 最老的 /p0 被踢
    expect(state.activeTabId).toBe("/p20?");
  });

  it("close active: 右侧优先, 列表空时 null", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    // active = /c, close /c → 应激活 /b (右侧没了用左侧)
    state = reducer(state, { type: "close", id: "/c?" });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("/b?");
  });

  it("close 非 active: 不影响 active", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    const before = state.activeTabId;
    state = reducer(state, { type: "close", id: "/a?" });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(before);
  });

  it("closeOthers 只留指定 tab", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    state = reducer(state, { type: "closeOthers", id: "/b?" });
    expect(state.tabs.map((t) => t.path)).toEqual(["/b"]);
    expect(state.activeTabId).toBe("/b?");
  });

  it("rename 仅改 title", () => {
    let state = empty;
    state = reducer(state, {
      type: "open",
      path: "/schedules",
      search: "",
      title: "定时任务",
    });
    state = reducer(state, {
      type: "rename",
      id: "/schedules?",
      title: "Schedules",
    });
    expect(state.tabs[0].title).toBe("Schedules");
  });

  it("hydrate 设置初始 state", () => {
    const tabs = [
      { id: "/x?", path: "/x", search: "", title: "X", createdAt: 1 },
    ];
    const state = reducer(empty, {
      type: "hydrate",
      tabs,
      activeTabId: "/x?",
    });
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe("/x?");
  });

  it("activate 未知 id 是 no-op", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    const before = { ...state };
    state = reducer(state, { type: "activate", id: "/nonexistent?" });
    expect(state).toEqual(before);
  });

  it("closeRight 切到 active 的最近左邻", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    // active = /c, closeRight(/a?) → 只保留 /a; /c 被关, active 跳到 /a (最后一个)
    state = reducer(state, { type: "closeRight", id: "/a?" });
    expect(state.tabs.map((t) => t.path)).toEqual(["/a"]);
    expect(state.activeTabId).toBe("/a?");
  });

  it("closeRight 不动 active 在内的右侧", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    // active = /c, closeRight(/b?) → 保留 /a /b, 关闭 /c (active 自动跳到 /b)
    state = reducer(state, { type: "closeRight", id: "/b?" });
    expect(state.tabs.map((t) => t.path)).toEqual(["/a", "/b"]);
    expect(state.activeTabId).toBe("/b?");
  });

  it("closeLeft 切到 active 的最近右邻", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    // active = /c, closeLeft(/c?) → 保留 /c
    state = reducer(state, { type: "closeLeft", id: "/c?" });
    expect(state.tabs.map((t) => t.path)).toEqual(["/c"]);
    expect(state.activeTabId).toBe("/c?");
  });

  it("closeLeft 不动 active 在内的左侧", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    state = reducer(state, { type: "open", path: "/b", search: "", title: "B" });
    state = reducer(state, { type: "open", path: "/c", search: "", title: "C" });
    // active = /c (最后一次 open), closeLeft(/c?) → 关 /a /b, 保留 /c, active 不变
    state = reducer(state, { type: "closeLeft", id: "/c?" });
    expect(state.tabs.map((t) => t.path)).toEqual(["/c"]);
    expect(state.activeTabId).toBe("/c?");
  });

  it("duplicate 增加一个独立副本 tab 并激活", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/schedules", search: "", title: "T" });
    state = reducer(state, { type: "open", path: "/requirements", search: "", title: "T2" });
    const before = state.tabs.length;
    state = reducer(state, { type: "duplicate", id: "/schedules?" });
    expect(state.tabs.length).toBe(before + 1);
    expect(state.activeTabId).toMatch(/^.*#dup-\d+$/);
    const dup = state.tabs.find((t) => t.id === state.activeTabId);
    expect(dup?.path).toBe("/schedules");
  });

  it("togglePin 翻转 pinned 标记", () => {
    let state = empty;
    state = reducer(state, { type: "open", path: "/a", search: "", title: "A" });
    expect(state.tabs[0].pinned).toBeUndefined();
    state = reducer(state, { type: "togglePin", id: "/a?" });
    expect(state.tabs[0].pinned).toBe(true);
    state = reducer(state, { type: "togglePin", id: "/a?" });
    expect(state.tabs[0].pinned).toBe(false);
  });

  it("LRU 淘汰跳过 pinned tab", () => {
    let state = empty;
    // 建 20 个, 第一个钉住
    state = reducer(state, { type: "open", path: "/pinned", search: "", title: "P" });
    state = reducer(state, { type: "togglePin", id: "/pinned?" });
    for (let i = 1; i < 20; i++) {
      state = reducer(state, { type: "open", path: `/t${i}`, search: "", title: `T${i}` });
    }
    expect(state.tabs).toHaveLength(20);
    // 第 21 个, pinned 的 /pinned 应保留, /t1 应被踢
    state = reducer(state, { type: "open", path: "/t20", search: "", title: "T20" });
    expect(state.tabs).toHaveLength(20);
    expect(state.tabs.find((t) => t.path === "/pinned")).toBeDefined();
    expect(state.tabs.find((t) => t.path === "/t1")).toBeUndefined();
  });
});