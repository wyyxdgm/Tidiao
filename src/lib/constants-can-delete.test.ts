// R105: 删除按钮可见性收敛到 canDeleteTask, 三处 UI (task-detail /
//   board-client / kanban-view) 共用同一份判断. 此测覆盖边界:
//     - queued / pending / paused / reviewing / verifying / 终态 → 可删 (R105 主诉求)
//     - running → 不可删 (避免中断 agent session, 跟其他状态动作按钮护栏一致)
//     - 已软删 (deleted_at 非空) → 不可删 (走恢复流程)
//     - 兜底: status null/undefined 视为非 running, 可删 (新创建/边界态安全)
//     - 兜底: deletedAt 真值字符串即软删, 不可删
//
// 关注点:
//   - 纯函数, 无 React 依赖.
//   - 5 条核心断言覆盖主要 status + 两个兜底, 共 7-8 条.

import { describe, expect, it } from "vitest";
import { canDeleteTask } from "./constants";

describe("canDeleteTask (R105)", () => {
  it("R105 主诉求: queued / pending / paused 都能删", () => {
    for (const status of ["queued", "pending", "paused"]) {
      expect(canDeleteTask(status, null), `status=${status}`).toBe(true);
    }
  });

  it("R105: reviewing / verifying (R61 / DAG P3) 也允许删", () => {
    expect(canDeleteTask("reviewing", null)).toBe(true);
    expect(canDeleteTask("verifying", null)).toBe(true);
  });

  it("终态 (completed / failed / rejected / cancelled) 全部允许", () => {
    for (const status of ["completed", "failed", "rejected", "cancelled"]) {
      expect(canDeleteTask(status, null), `status=${status}`).toBe(true);
    }
  });

  it("护栏: running 中的 task 不能删 (避免中断 agent session)", () => {
    expect(canDeleteTask("running", null)).toBe(false);
  });

  it("已软删 (deleted_at 非空) → 不可删 (走恢复流程)", () => {
    expect(canDeleteTask("queued", "2026-09-06T10:00:00.000Z")).toBe(false);
    expect(canDeleteTask("completed", "2026-09-06T10:00:00.000Z")).toBe(false);
    // 即使是 running 也不双扣 (前面 running 已拒)
    expect(canDeleteTask("running", "2026-09-06T10:00:00.000Z")).toBe(false);
  });

  it("兜底: status null/undefined 视为非 running, 可删", () => {
    expect(canDeleteTask(null, null)).toBe(true);
    expect(canDeleteTask(undefined, null)).toBe(true);
  });

  it("兜底: deletedAt 真值字符串即软删, status 是 queued 也拒", () => {
    expect(canDeleteTask("queued", "anything-non-empty")).toBe(false);
  });

  it("未知 status (非 running) 一律允许, 后续如果引入新 status 不会误锁", () => {
    // 防止未来加新 status 时被默认拒掉. 这是 canDeleteTask 设计上故意宽松的点:
    //   真正约束在 UI/DB 层 (无法中断的会话), 不在常量层.
    expect(canDeleteTask("some_future_status", null)).toBe(true);
  });
});
