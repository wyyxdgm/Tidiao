import { describe, it, expect } from "vitest";
import type { TaskTrimmed } from "@/lib/runtime/types";
import { matchesTaskSearch } from "@/lib/runtime/task-search";

function mkTask(overrides: Partial<TaskTrimmed> = {}): TaskTrimmed {
  return {
    id: "6a77fce7-1234-5678-9abc-def012345678",
    title: "默认标题",
    description: null,
    prompt_preview: "",
    result_preview: "",
    error_preview: "",
    status: "completed",
    priority: 0,
    type: null,
    model: null,
    resolved_model: null,
    tags: null,
    project_id: null,
    version_id: null,
    owner_id: null,
    deleted_at: null,
    cost_usd: null,
    updated_at: "2026-08-25T00:00:00Z",
    auto_approve: 0,
    auto_complete: 0,
    context_tokens: null,
    context_max: null,
    awaiting_owner_review: 0,
    awaiting_markers: null,
    dispatched_by_task_id: null,
    requirement_status: null,
    schedule_id: null,
    latest_checkpoint_status: null,
    awaiting_reason: null,
    queued_order: null,
    queued_reason: null,
    ...overrides,
  };
}

describe("matchesTaskSearch", () => {
  it("空 query 永远命中", () => {
    expect(matchesTaskSearch(mkTask(), "")).toBe(true);
    expect(matchesTaskSearch(mkTask(), "   ")).toBe(true);
  });

  it("按完整 UUID 命中 (R117 需求)", () => {
    const t = mkTask({ id: "6a77fce7-1234-5678-9abc-def012345678" });
    expect(matchesTaskSearch(t, "6a77fce7-1234-5678-9abc-def012345678")).toBe(true);
  });

  it("按 UUID 短前缀命中 — damo 例子 (R117 需求)", () => {
    const t = mkTask({ id: "6a77fce7-1234-5678-9abc-def012345678" });
    expect(matchesTaskSearch(t, "6a77fce7")).toBe(true);
  });

  it("大小写不敏感", () => {
    const t = mkTask({ id: "6A77FCE7-1234-5678-9abc-def012345678" });
    expect(matchesTaskSearch(t, "6a77fce7")).toBe(true);
  });

  it("不存在的短串返回 false", () => {
    const t = mkTask({ id: "6a77fce7-1234-5678-9abc-def012345678" });
    expect(matchesTaskSearch(t, "ffffffff")).toBe(false);
  });

  it("匹配 title / prompt_preview / description / result_preview / error_preview / tags 各字段", () => {
    const base = {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      title: "Alpha",
      description: "Bravo",
      prompt_preview: "Charlie",
      result_preview: "Delta",
      error_preview: "Echo",
      tags: '["Foxtrot","Golf"]',
    };
    expect(matchesTaskSearch(mkTask(base), "Alpha")).toBe(true);
    expect(matchesTaskSearch(mkTask(base), "Bravo")).toBe(true);
    expect(matchesTaskSearch(mkTask(base), "Charlie")).toBe(true);
    expect(matchesTaskSearch(mkTask(base), "Delta")).toBe(true);
    expect(matchesTaskSearch(mkTask(base), "Echo")).toBe(true);
    expect(matchesTaskSearch(mkTask(base), "Foxtrot")).toBe(true);
    expect(matchesTaskSearch(mkTask(base), "golf")).toBe(true); // tag 大小写
  });

  it("description / tags 为 null 时不抛", () => {
    const t = mkTask({ description: null, tags: null });
    expect(matchesTaskSearch(t, "anything")).toBe(false);
    expect(matchesTaskSearch(t, "默认标题")).toBe(true);
  });

  it("tags 是非法 JSON 时降级为空数组, 不抛", () => {
    const t = mkTask({ tags: "{not valid json" });
    expect(matchesTaskSearch(t, "anything")).toBe(false);
  });

  it("id 短串命中优先级高于其他字段空匹配 (回归 — 之前 id 不参与过滤)", () => {
    // 旧实现: id 不在 match 列表 → 输入纯 id 短串 → 0 命中 → 整列空白
    // 新实现: id 进 match 列表 → 命中
    const t = mkTask({
      id: "6a77fce7-1111-2222-3333-444444444444",
      title: "完全无关",
      prompt_preview: "也无关",
      result_preview: "",
    });
    expect(matchesTaskSearch(t, "6a77fce7")).toBe(true);
  });
});
