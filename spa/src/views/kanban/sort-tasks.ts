/* 功能: 看板列内排序 — 「默认时间倒序, 定制的除外」(damo 2026-11-05).
   定制排序 (queued_order ASC) 只在 running / queued 两列生效 — 这两列是
   REORDERABLE_STATUSES (拖拽手动调序的唯一合法列, KanbanBoard handleSameColReorder
   同口径). 其余列一律纯 updated_at DESC, 忽略 queued_order.
   单测 sort-tasks.test.ts.

   关注点 (bug 修复 2026-11-05): 之前所有列都 queued_order ASC 优先 — 但
   queued_order 是终身残留值 (scheduler enqueue 时给每个过队任务写 MAX+1,
   手动拖拽整列重写, 只有 dequeue 清空; 任务 queued → running → completed
   转状态一路带着). 实证: completed 列顶部是 10-31 的老任务 (ord 20/83 =
   上周拖拽残留), 11-04 的任务沉底 = 列序被几周前的定制残留劫持, 违反
   「默认时间倒序」. 修法 = 定制语义只回到它存在的列 (running/queued),
   其他列恢复时间倒序.

   历史语义 (v510, 2026-10-26): 全列 queued_order ASC 优先, NULL 回落
   updated_at DESC — 镜像 master kanban-view.tsx sortTasksForKanban. 修复
   只改 SPA (对外 UI 唯一), master (src/app 历史壳) 不动. */
import { parseDbTime } from '@/lib/datetime';

export interface KanbanSortTask {
  updated_at: string;
  queued_order: number | null | undefined;
}

/** 定制排序 (拖拽 queued_order) 只在这两列生效 — 与 KanbanBoard
    REORDERABLE_STATUSES 保持同源口径. */
const CUSTOM_ORDER_STATUSES: ReadonlySet<string> = new Set(['running', 'queued']);

export function sortTasksForKanban<T extends KanbanSortTask>(list: T[], col: string): T[] {
  const customOrder = CUSTOM_ORDER_STATUSES.has(col);
  return [...list].sort((a, b) => {
    if (customOrder) {
      const ao = a.queued_order;
      const bo = b.queued_order;
      const aHas = ao !== null && ao !== undefined;
      const bHas = bo !== null && bo !== undefined;
      if (aHas && bHas) return (ao as number) - (bo as number);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
    }
    // 默认: updated_at DESC; parseDbTime 避免 SQLite 裸 UTC 串与 ISO 混排
    // (R149 口径, 与 lib/datetime 同源).
    return (parseDbTime(b.updated_at)?.getTime() ?? 0) - (parseDbTime(a.updated_at)?.getTime() ?? 0);
  });
}
