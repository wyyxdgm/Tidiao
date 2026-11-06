/* 功能: sortTasksForKanban 单测 — v510 用例 + 2026-11-05 「默认时间倒序, 定制除外」口径. */
import { describe, it, expect } from 'vitest';
import { sortTasksForKanban } from './sort-tasks';

interface Row {
  id: string;
  updated_at: string;
  queued_order: number | null;
}

function sort(list: Row[], col: string): string[] {
  return sortTasksForKanban(list, col).map((t) => t.id);
}

describe('sortTasksForKanban (v510 看板列内排序)', () => {
  it('全 NULL 时按 updated_at DESC (SQLite 裸串)', () => {
    expect(
      sort([
        { id: 'a', updated_at: '2026-09-17 10:00:00', queued_order: null },
        { id: 'b', updated_at: '2026-09-17 12:00:00', queued_order: null },
        { id: 'c', updated_at: '2026-09-17 11:00:00', queued_order: null },
      ], 'queued'),
    ).toEqual(['b', 'c', 'a']);
  });

  it('全非 NULL 时按 queued_order ASC', () => {
    expect(
      sort([
        { id: 'a', updated_at: '2026-09-17 10:00:00', queued_order: 30 },
        { id: 'b', updated_at: '2026-09-17 12:00:00', queued_order: 10 },
        { id: 'c', updated_at: '2026-09-17 11:00:00', queued_order: 20 },
      ], 'queued'),
    ).toEqual(['b', 'c', 'a']);
  });

  it('混合: 排过的在前 (ASC), 没排过的在后按 updated_at DESC', () => {
    expect(
      sort([
        { id: 'queued-old', updated_at: '2026-09-17 08:00:00', queued_order: 30 },
        { id: 'queued-new', updated_at: '2026-09-17 13:00:00', queued_order: 10 },
        { id: 'no-order-fresh', updated_at: '2026-09-17 14:00:00', queued_order: null },
        { id: 'no-order-stale', updated_at: '2026-09-17 09:00:00', queued_order: null },
      ], 'queued'),
    ).toEqual(['queued-new', 'queued-old', 'no-order-fresh', 'no-order-stale']);
  });

  it('ISO 与 SQLite 裸串混排 (R149): 统一按 UTC 时刻比较', () => {
    expect(
      sort([
        { id: 'iso-new', updated_at: '2026-09-17T13:00:00Z', queued_order: null },
        { id: 'sqlite-mid', updated_at: '2026-09-17 12:00:00', queued_order: null },
        { id: 'iso-old', updated_at: '2026-09-17T10:00:00Z', queued_order: null },
      ], 'pending'),
    ).toEqual(['iso-new', 'sqlite-mid', 'iso-old']);
  });

  it('不修改入参数组 (纯函数)', () => {
    const list: Row[] = [
      { id: 'a', updated_at: '2026-09-17 10:00:00', queued_order: null },
      { id: 'b', updated_at: '2026-09-17 12:00:00', queued_order: null },
    ];
    sortTasksForKanban(list, 'queued');
    expect(list.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('回归 (2026-10-26 bug): 拖拽写库后 reload, running/queued 列序跟随 queued_order 而非 updated_at', () => {
    // 用户把 B (较新) 拖到 A (较旧) 上面 → 服务端写 A=10 B=20.
    // API 返回仍是 updated_at DESC (B 在前); 排序后必须 A 在前.
    expect(
      sort([
        { id: 'B', updated_at: '2026-10-26 12:00:00', queued_order: 20 },
        { id: 'A', updated_at: '2026-10-26 09:00:00', queued_order: 10 },
      ], 'running'),
    ).toEqual(['A', 'B']);
  });

  it('回归 (2026-11-05, damo): 非 running/queued 列忽略 queued_order 残留, 纯 updated_at DESC', () => {
    // 实证: completed 列被 10-31 拖拽残留 (ord 20/83) 劫持, 11-04 新任务沉底.
    // 定制只存在于 running/queued (REORDERABLE_STATUSES), 其他列恢复时间倒序.
    expect(
      sort([
        { id: 'stale-drag', updated_at: '2026-10-31 11:29:31', queued_order: 20 },
        { id: 'stale-drag-2', updated_at: '2026-10-31 04:12:59', queued_order: 83 },
        { id: 'fresh-1', updated_at: '2026-11-04 11:22:08', queued_order: 4650 },
        { id: 'fresh-2', updated_at: '2026-11-04 11:19:14', queued_order: 4652 },
        { id: 'fresh-null', updated_at: '2026-11-03 15:09:14', queued_order: null },
      ], 'completed'),
    ).toEqual(['fresh-1', 'fresh-2', 'fresh-null', 'stale-drag', 'stale-drag-2']);
  });

  it('running 列仍保留定制序 (拖拽手动干预语义不变)', () => {
    expect(
      sort([
        { id: 'older-updated', updated_at: '2026-11-01 08:00:00', queued_order: 10 },
        { id: 'newer-updated', updated_at: '2026-11-04 08:00:00', queued_order: 20 },
        { id: 'never-ordered', updated_at: '2026-11-05 08:00:00', queued_order: null },
      ], 'running'),
    ).toEqual(['older-updated', 'newer-updated', 'never-ordered']);
  });
});
