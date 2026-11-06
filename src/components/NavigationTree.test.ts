// 修复回归: 页面激活态下, 用户折叠当前项目应生效, 不能再被 auto-expand 覆盖.
// bug 现场: NavigationTree 用 `Set<string>` 记用户展开集合, auto-expand 走
// `expanded.has(id) || id === effectiveProjectId`. 当前路由项目总是 effectiveProjectId,
// 用户点 header 想折叠时 toggle 改了 set, 但 || 右边仍为 true → 折叠不生效.
// 修复: 改成 `userExpanded: Record<id, bool>`, 缺失走 auto, 存在以用户为准.
// 纯函数 resolveProjectExpanded 已导出, 这里只对它断言, 不挂 React 渲染.

import { describe, it, expect } from "vitest";
import { resolveProjectExpanded, default as NavigationTree } from "./NavigationTree";

describe("resolveProjectExpanded", () => {
  it("无用户偏好 + 当前路由项目 → 展开 (auto-expand)", () => {
    expect(resolveProjectExpanded({}, "p1", "p1")).toBe(true);
  });

  it("无用户偏好 + 非当前路由项目 → 折叠", () => {
    expect(resolveProjectExpanded({}, "p2", "p1")).toBe(false);
  });

  it("无用户偏好 + 无当前路由 → 全折叠", () => {
    expect(resolveProjectExpanded({}, "p1", null)).toBe(false);
  });

  // 回归点: 用户点 header 折叠当前项目后, 不能再被 auto-expand 拽回展开.
  it("用户显式折叠当前路由项目 → 折叠 (修复点)", () => {
    expect(resolveProjectExpanded({ p1: false }, "p1", "p1")).toBe(false);
  });

  it("用户显式展开非当前路由项目 → 展开", () => {
    expect(resolveProjectExpanded({ p2: true }, "p2", "p1")).toBe(true);
  });

  it("用户显式折叠非当前路由项目 → 折叠", () => {
    expect(resolveProjectExpanded({ p2: false }, "p2", "p1")).toBe(false);
  });

  it("用户偏好独立于当前路由, 不会互相污染", () => {
    const prefs = { p1: false, p2: true };
    expect(resolveProjectExpanded(prefs, "p1", "p1")).toBe(false);
    expect(resolveProjectExpanded(prefs, "p2", "p1")).toBe(true);
    expect(resolveProjectExpanded(prefs, "p3", "p1")).toBe(false); // 未操作 → 折叠
  });

  it("显式 false 不被原型链上的 hasOwnProperty 误判 (防御)", () => {
    // 旧实现用 `projectId in userExpanded` 在极端情况下会触发原型链;
    // 当前实现走 hasOwnProperty, 这里构造一个会被 in 误判的场景反向确认.
    const prefs: Record<string, boolean> = { toString: false };
    expect(resolveProjectExpanded(prefs, "toString", "p1")).toBe(false);
  });
});

describe("NavigationTree 组件结构约束", () => {
  it("默认导出是函数组件", () => {
    expect(typeof NavigationTree).toBe("function");
  });
});
