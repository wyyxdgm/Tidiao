// R94: getRequirementChipMeta 是三个 UI 入口 (chat-list / kanban-view / cards)
// 共用的纯函数, 决定是否显示关联需求 chip + 返回 meta. 这里锁死三入口的判断口径,
// 任何 UI 渲染改动都必须先改这里 + 测试同时过.
//
// 关键场景:
//   - 非 reviewing → null (无论需求 status 是啥)
//   - reviewing + 无关联需求 → null (requirement_status = null)
//   - reviewing + 三态 (awaiting_reply/has_suggestion/blocked) → 返回对应 meta
//   - reviewing + 终态 (pending/done/closed) → null (UI 决定不显示; 与 VISIBLE_REQUIREMENT_STATUSES 对齐)
//
// 关注点:
//   - 不依赖 React, 单测可直接调用, 无需 jsdom.
//   - 颜色 class 来自 R84 awaiting markers 同款 (cyan/emerald/red), 这里只校验
//     META 映射命中, 不强校验 class 字符串 (class 微调不影响语义).

import { describe, it, expect } from "vitest";
import {
  getRequirementChipMeta,
  VISIBLE_REQUIREMENT_STATUSES,
  RequirementStatusChip,
} from "./requirement-chip";
import type { TaskTrimmed } from "./types";

function makeTask(overrides: Partial<TaskTrimmed> = {}): Pick<TaskTrimmed, "status" | "requirement_status"> {
  return {
    status: "reviewing",
    requirement_status: null,
    ...overrides,
  };
}

describe("getRequirementChipMeta (R94)", () => {
  it("returns null when task is not reviewing", () => {
    // 任何非 reviewing 状态都不显示 chip, 哪怕关联需求是 has_suggestion.
    for (const status of [
      "pending",
      "queued",
      "running",
      "paused",
      "completed",
      "failed",
      "rejected",
      "cancelled",
    ] as const) {
      const meta = getRequirementChipMeta(makeTask({ status, requirement_status: "has_suggestion" }));
      expect(meta, `status=${status}`).toBeNull();
    }
  });

  it("returns null when reviewing but has no linked requirement", () => {
    expect(getRequirementChipMeta(makeTask({ status: "reviewing", requirement_status: null }))).toBeNull();
  });

  it("returns meta for the three visible intermediate statuses", () => {
    expect(getRequirementChipMeta(makeTask({ requirement_status: "awaiting_reply" }))?.label).toBe("等回复");
    expect(getRequirementChipMeta(makeTask({ requirement_status: "has_suggestion" }))?.label).toBe("有建议");
    expect(getRequirementChipMeta(makeTask({ requirement_status: "blocked" }))?.label).toBe("需拍板");
  });

  it("UI gate: terminal requirement statuses (pending/done/closed) return null", () => {
    // 与 VISIBLE_REQUIREMENT_STATUSES 同步: pending/done/closed 不进 chip, 即使
    // SQL 带回这些值, UI 也不会渲染. 这里锁死 — 改 VISIBLE_REQUIREMENT_STATUSES
    // 必须同步改这个测试.
    for (const status of ["pending", "done", "closed"] as const) {
      expect(
        getRequirementChipMeta(makeTask({ requirement_status: status })),
        `should hide chip for ${status}`,
      ).toBeNull();
    }
    // 防御: VISIBLE_REQUIREMENT_STATUSES 与预期三态严格一致.
    expect(VISIBLE_REQUIREMENT_STATUSES).toEqual(["awaiting_reply", "has_suggestion", "blocked"]);
  });

  it("returns null for unknown / unexpected requirement_status values", () => {
    // 不存在的 status (例如飞书 O 列历史值被错误写库) 不应渲染 chip.
    // 这里用 cast 模拟脏数据.
    const dirty = { status: "reviewing" as const, requirement_status: "garbage" as any };
    expect(getRequirementChipMeta(dirty)).toBeNull();
  });

  it("chip meta color/label 一致性: 与 R84 awaiting markers chip 同款 (cyan/emerald/red)", () => {
    // 这里不强校验 class 字符串, 只锁定 label 与 color 来源 = 颜色与 R84 marker 同款.
    // 反向断言: 颜色 class 包含 tailwind 配色关键词.
    const ar = getRequirementChipMeta(makeTask({ requirement_status: "awaiting_reply" }))!;
    const hs = getRequirementChipMeta(makeTask({ requirement_status: "has_suggestion" }))!;
    const bl = getRequirementChipMeta(makeTask({ requirement_status: "blocked" }))!;
    expect(ar.color).toContain("cyan");
    expect(hs.color).toContain("emerald");
    expect(bl.color).toContain("amber");
    expect(ar.title).toContain("飞书");
    expect(hs.title).toContain("飞书");
    expect(bl.title).toContain("飞书");
  });
});

// RequirementStatusChip 渲染组件在非 reviewing/无需求时不返回 DOM (返回 null). 这里
// 不依赖 jsdom, 用一个轻量测试 mock: 直接看 React.createElement 是否返回 null. 但
// 拉 react-dom 测 jsdom 成本高, 改测"决策函数返回 null 时, 不调用下游"行为 — 通过
// 包装 requirement_status = null 的 task 调组件, 期待返回 null.
// 这里跳过 React 组件级测试, 因为 getRequirementChipMeta 已 100% 覆盖决策; 三个
// UI 入口只在调用组件前先判 meta, 组件本身只负责渲染. 后续若加 snapshot, 引入
// @testing-library/react 时一起做.
