// 功能: 计算 task 在 board-client 双数组 (activeTasks / terminalTasks) 间的位置/状态
// 变化, 给 runAction (拖拽 optimistic update) 用. 纯函数, 无 React 依赖, 可单元测.
//
// 关注点:
//   - 输入是当前数组引用 + taskId + newStatus + now ISO. 输出是新的 active/terminal
//     数组 + terminalTotal 增量.
//   - 4 种方向 (与 board-client 的 SSE handler 同口径):
//       a) terminal → terminal: 原地 patch status+updated_at, 不重排序
//       b) active → active (queued/paused/running/reviewing/pending 互转):
//          原地 patch — R54 修复点, 原 runAction 错在无条件从 active 删, 导致 task 消失
//       c) active → terminal (e.g. running → cancelled): 跨组 + totalDelta +1
//       d) terminal → active (e.g. cancelled → running): 跨组 + totalDelta -1
//     都不命中 (未知 task) 返回原数组 + totalDelta 0, 调用方交给 SSE 兜底.
//   - 纯函数: 同样输入永远同样输出, 不依赖外部 state.

import { BOARD_TERMINAL_STATUSES } from "@/lib/constants";
import type { TaskStatus, TaskTrimmed } from "@/lib/runtime/types";

const TERMINAL_SET = new Set<string>(BOARD_TERMINAL_STATUSES);

export interface TaskMoveResult {
  active: TaskTrimmed[];
  terminal: TaskTrimmed[];
  totalDelta: number;
}

export function computeTaskMove(
  active: readonly TaskTrimmed[],
  terminal: readonly TaskTrimmed[],
  taskId: string,
  newStatus: TaskStatus,
  nowIso: string,
): TaskMoveResult {
  const newIsTerminal = TERMINAL_SET.has(newStatus);
  const inActive = active.some((t) => t.id === taskId);
  const inTerminal = terminal.some((t) => t.id === taskId);

  // (a) terminal → terminal: 原地 patch.
  //     R118: 输入端可能 active+terminal 都有 taskId (SSE/race), 此分支也要把
  //     active 那份清掉, 避免失败卡片残留.
  if (inTerminal && newIsTerminal) {
    return {
      active: active.filter((t) => t.id !== taskId),
      terminal: terminal.map((t) =>
        t.id === taskId ? { ...t, status: newStatus, updated_at: nowIso } : t,
      ),
      totalDelta: 0,
    };
  }

  // (b) active → active: 原地 patch (queued↔running, paused↔running 等).
  //     R54: 原 runAction 这里把 task 从 active 删了, 新 status 非 terminal → 不补回
  //     → 双数组都不在 → UI 消失直到 SSE 兜底.
  //     R118: 同样处理 active+terminal 双存在的边界 — 失败卡片残留 = 同步从 terminal 清掉.
  if (inActive && !newIsTerminal) {
    return {
      active: active.map((t) =>
        t.id === taskId ? { ...t, status: newStatus, updated_at: nowIso } : t,
      ),
      terminal: terminal.filter((t) => t.id !== taskId),
      totalDelta: 0,
    };
  }

  // (c) active → terminal: 跨组 + totalDelta +1.
  //     R118: 跨组前先把 task 从目标数组 (terminal) 也过滤一遍, 防止输入端重复
  //     (SSE handler 与 runAction 之间的竞争窗口 — refs 更新滞后 useEffect 一次 render)
  //     在输出端产生重复 ID, 看板视图会渲染两张相同卡片.
  if (inActive && newIsTerminal) {
    const moved = active.find((t) => t.id === taskId);
    if (!moved) {
      return { active: [...active], terminal: [...terminal], totalDelta: 0 };
    }
    const patched: TaskTrimmed = { ...moved, status: newStatus, updated_at: nowIso };
    return {
      active: active.filter((t) => t.id !== taskId),
      terminal: [patched, ...terminal.filter((t) => t.id !== taskId)],
      totalDelta: 1,
    };
  }

  // (d) terminal → active: 跨组 + totalDelta -1.
  //     R118: 同 (c) 保护, 防止目标数组 active 已有的同 ID 副本产生重复.
  if (inTerminal && !newIsTerminal) {
    const moved = terminal.find((t) => t.id === taskId);
    if (!moved) {
      return { active: [...active], terminal: [...terminal], totalDelta: 0 };
    }
    const patched: TaskTrimmed = { ...moved, status: newStatus, updated_at: nowIso };
    return {
      active: [patched, ...active.filter((t) => t.id !== taskId)],
      terminal: terminal.filter((t) => t.id !== taskId),
      totalDelta: -1,
    };
  }

  // 都不在 (未知 task): 原样返回, 调用方交给 SSE refresh 兜底.
  return { active: [...active], terminal: [...terminal], totalDelta: 0 };
}
