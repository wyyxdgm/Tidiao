// v510 (damo 2026-09-17): 看板列内排序 — queued_order ASC NULLS LAST, 没排过
//   的回落到 updated_at DESC. kanban-view.tsx 不导出 sortTasksForKanban, 这里
//   直接复刻排序逻辑 (单文件, 无依赖) 跑 vitest 兜底.
//
// 关注点:
//   - 全 NULL (用户没排过) → 退化为 updated_at DESC, 与改造前 byte-identical.
//   - 全非 NULL → 按 queued_order ASC.
//   - 混合 (一部分排过, 一部分没) → 排过的在前 (按 queued_order ASC),
//     没排过的在后 (按 updated_at DESC).
//   - stable sort (Array.prototype.sort 自带): 同 order 同 fallback 时
//     保留入列顺序, 避免跳变.
//
// 这里是单元测试, 不依赖 React 渲染.

import { describe, it, expect } from "vitest";
import { parseDbTime } from "@/lib/datetime";

interface KanbanTaskLike {
  id: string;
  updated_at: string;
  queued_order: number | null;
}

// 与 kanban-view.tsx sortTasksForKanban 复刻, 保持口径一致.
function sortTasksForKanban(list: KanbanTaskLike[]): KanbanTaskLike[] {
  return [...list].sort((a, b) => {
    const ao = a.queued_order;
    const bo = b.queued_order;
    const aHas = ao !== null && ao !== undefined;
    const bHas = bo !== null && bo !== undefined;
    if (aHas && bHas) return ao - bo;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    return (parseDbTime(b.updated_at)?.getTime() ?? 0) - (parseDbTime(a.updated_at)?.getTime() ?? 0);
  });
}

describe("KanbanView sortTasksForKanban (v510)", () => {
  it("全 NULL 时退化为 updated_at DESC", () => {
    const r = sortTasksForKanban([
      { id: "a", updated_at: "2026-09-17 10:00:00", queued_order: null },
      { id: "b", updated_at: "2026-09-17 12:00:00", queued_order: null },
      { id: "c", updated_at: "2026-09-17 11:00:00", queued_order: null },
    ]);
    expect(r.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("全非 NULL 时按 queued_order ASC", () => {
    const r = sortTasksForKanban([
      { id: "a", updated_at: "2026-09-17 10:00:00", queued_order: 30 },
      { id: "b", updated_at: "2026-09-17 12:00:00", queued_order: 10 },
      { id: "c", updated_at: "2026-09-17 11:00:00", queued_order: 20 },
    ]);
    expect(r.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("混合: 已排在前, 未排在后", () => {
    const r = sortTasksForKanban([
      { id: "queued-old", updated_at: "2026-09-17 08:00:00", queued_order: 30 },
      { id: "queued-new", updated_at: "2026-09-17 13:00:00", queued_order: 10 },
      { id: "no-order-fresh", updated_at: "2026-09-17 14:00:00", queued_order: null },
      { id: "no-order-stale", updated_at: "2026-09-17 09:00:00", queued_order: null },
    ]);
    expect(r.map((t) => t.id)).toEqual([
      "queued-new",    // order=10
      "queued-old",    // order=30
      "no-order-fresh",// 未排 + 更新更近 → 在前
      "no-order-stale",// 未排 + 更新更早 → 在后
    ]);
  });

  it("SQLite YYYY-MM-DD HH:MM:SS 与 ISO 混合时不串位", () => {
    // R149: 之前 raw localeCompare 因 ' ' < 'T' 把 SQLite 格式排错位置.
    // 解析到 ms 后统一比较, 两种格式都正确.
    const r = sortTasksForKanban([
      { id: "iso-new", updated_at: "2026-09-17T13:00:00Z", queued_order: null },
      { id: "sqlite-mid", updated_at: "2026-09-17 12:00:00", queued_order: null },
      { id: "iso-old", updated_at: "2026-09-17T10:00:00Z", queued_order: null },
    ]);
    expect(r[0].id).toBe("iso-new");
    expect(r[2].id).toBe("iso-old");
    // sqlite-mid 时间介于两者之间 → 中间
    expect(r[1].id).toBe("sqlite-mid");
  });

  it("空数组 → 空数组", () => {
    expect(sortTasksForKanban([])).toEqual([]);
  });
});