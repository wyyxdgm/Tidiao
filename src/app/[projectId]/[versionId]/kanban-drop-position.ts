// 功能: 看板拖拽 drop 位置 + 跨列 status 切换的纯函数计算. 给 kanban-view.tsx 的
//   handleTaskItemDrop 用 (R154 修复点).
//
// 关注点:
//   - 跨列 drop (sourceColKey !== targetColKey):
//       a) 校验 VALID_STATUS_TRANSITIONS, 有 action → 返回 action + 新顺序
//       b) 新顺序: draggedId 插入 beforeTaskId 之前; beforeTaskId 不在 targetCol
//          或 null → 落到列尾. draggedId 不在 targetColIds 中 (跨列场景天然),
//          所以 withoutSelf 是干净的.
//   - 同列 drop (sourceColKey === targetColKey):
//       a) 不切 status (status 没变, 不发请求)
//       b) 新顺序: draggedId 从 withoutSelf 中拔掉, 插入 beforeTaskId 之前;
//          beforeTaskId null/不在 → 落到列尾. 与原 handleTaskItemDrop 行为一致.
//   - drop 落空 / 数据异常: crossColumn=false + action=null + newOrder=[],
//     调用方按"无操作"兜底.
//   - 与 board-client 的 runAction (POST /api/tasks/{id}/{action}) 和
//     handleKanbanReorder (POST /api/tasks/queue-order) 是上层调用方; 本文件
//     只算"该调什么 + 顺序是什么", 不直接发请求.

import { VALID_STATUS_TRANSITIONS, getStatusDragAction } from "@/lib/constants";

export interface CrossColumnDropInput {
  /** 拖出 task 的源列 key (即原 status) */
  sourceColKey: string | null | undefined;
  /** 拖入的目标列 key (drop 落到的列) */
  targetColKey: string;
  /** 被拖动的 task id */
  draggedId: string;
  /** drop 参考位置 — drop 到某张 card 上时 = 该 card id; 落空/列底空白 = null */
  beforeTaskId: string | null;
  /** 目标列当前可见 task id 顺序 (按 sortTasksForKanban 后) */
  targetColumnIds: string[];
}

export interface CrossColumnDropResult {
  /** 是否跨列 (sourceColKey !== targetColKey 且 sourceColKey 已知) */
  crossColumn: boolean;
  /** 跨列时该 POST 的 action (e.g. queued→running = "start"); 同列或非法 transition = null */
  action: string | null;
  /** 新的目标列顺序, 直接喂 handleKanbanReorder */
  newOrder: string[];
}

export function computeCrossColumnDrop(input: CrossColumnDropInput): CrossColumnDropResult {
  const { sourceColKey, targetColKey, draggedId, beforeTaskId, targetColumnIds } = input;

  if (!draggedId) {
    return { crossColumn: false, action: null, newOrder: [] };
  }

  const crossColumn = !!sourceColKey && sourceColKey !== targetColKey;

  // 跨列: 算 action (VALID transition + 有对应 API action 才返回, 否则 null)
  let action: string | null = null;
  if (crossColumn && sourceColKey) {
    if (VALID_STATUS_TRANSITIONS[sourceColKey]?.has(targetColKey)) {
      action = getStatusDragAction(sourceColKey, targetColKey);
    }
  }

  // 算新顺序 — 跨列时 draggedId 不在 targetColumnIds (status 还是 source),
  //   同列时 draggedId 必在 withoutSelf 之前会被过滤掉. 两种场景共用同一算法.
  const withoutSelf = targetColumnIds.filter((id) => id !== draggedId);
  let newOrder: string[];
  if (beforeTaskId && withoutSelf.includes(beforeTaskId)) {
    const idx = withoutSelf.indexOf(beforeTaskId);
    newOrder = [...withoutSelf.slice(0, idx), draggedId, ...withoutSelf.slice(idx)];
  } else {
    newOrder = [...withoutSelf, draggedId];
  }

  return { crossColumn, action, newOrder };
}