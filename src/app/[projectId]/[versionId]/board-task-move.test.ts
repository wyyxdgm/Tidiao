// 单元测: board-client 的 runAction 调 computeTaskMove 算 optimistic 更新.
// R54 bug 复现 + 修复点覆盖: queued→running / paused→running 不再消失, 同时保
// 持跨组 (active↔terminal) 与 terminal 内的正确分流.
//
// 关注点:
//   - 输入是 plain TaskTrimmed[], 没有 React 依赖, 可纯 vitest 跑.
//   - 5 条核心断言: active→active (R54 主场景) / terminal→active / 未知 task 原样
//     返回 (SSE 兜底) / totalDelta 正确累计 / 同 taskId 不出现在两边数组.

import { describe, expect, it } from "vitest";
import { computeTaskMove } from "./board-task-move";
import type { TaskTrimmed } from "@/lib/runtime/types";

const NOW = "2026-09-02T12:00:00.000Z";

function mk(id: string, status: TaskTrimmed["status"], rest: Partial<TaskTrimmed> = {}): TaskTrimmed {
  return {
    id,
    title: `task-${id}`,
    description: null,
    prompt_preview: "",
    result_preview: "",
    error_preview: "",
    status,
    priority: 0,
    type: "dev",
    model: null,
    resolved_model: null,
    tags: null,
    project_id: "p1",
    version_id: "v1",
    owner_id: "u1",
    deleted_at: null,
    cost_usd: 0,
    updated_at: "2026-09-02T10:00:00.000Z",
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
    ...rest,
  };
}

describe("computeTaskMove (R54 board drag fix)", () => {
  it("R54: queued → running 原地 patch, 不从 active 数组消失", () => {
    const queued = mk("t1", "queued");
    const result = computeTaskMove([queued], [], "t1", "running", NOW);

    expect(result.totalDelta).toBe(0);
    expect(result.active).toHaveLength(1);
    expect(result.terminal).toHaveLength(0);
    expect(result.active[0].id).toBe("t1");
    expect(result.active[0].status).toBe("running");
    expect(result.active[0].updated_at).toBe(NOW);
  });

  it("R54: paused → running 原地 patch (用户在飞书 R54 报的另一个场景)", () => {
    const paused = mk("t2", "paused");
    const result = computeTaskMove([paused], [], "t2", "running", NOW);

    expect(result.totalDelta).toBe(0);
    expect(result.active).toHaveLength(1);
    expect(result.terminal).toHaveLength(0);
    expect(result.active[0].status).toBe("running");
  });

  it("active → terminal: 跨组 + totalDelta +1 (running → cancelled)", () => {
    const running = mk("t3", "running");
    const result = computeTaskMove([running], [], "t3", "cancelled", NOW);

    expect(result.totalDelta).toBe(1);
    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(1);
    expect(result.terminal[0].id).toBe("t3");
    expect(result.terminal[0].status).toBe("cancelled");
    // 跨组 = prepend 到 terminal 头部 (活窗口语义)
    expect(result.terminal[0]).toBe(result.terminal[0]);
  });

  it("terminal → active: 跨组 + totalDelta -1 (cancelled → running via start)", () => {
    const cancelled = mk("t4", "cancelled");
    const result = computeTaskMove([], [cancelled], "t4", "running", NOW);

    expect(result.totalDelta).toBe(-1);
    expect(result.active).toHaveLength(1);
    expect(result.terminal).toHaveLength(0);
    expect(result.active[0].id).toBe("t4");
    expect(result.active[0].status).toBe("running");
  });

  it("terminal → terminal: 原地 patch, 不重排序 (reviewing → completed)", () => {
    const reviewing = mk("t5", "reviewing");
    const otherCompleted = mk("t6", "completed");
    const result = computeTaskMove([], [reviewing, otherCompleted], "t5", "completed", NOW);

    expect(result.totalDelta).toBe(0);
    expect(result.terminal).toHaveLength(2);
    // 顺序保持 (不是 prepend) — SSE handler 的语义
    expect(result.terminal[0].id).toBe("t5");
    expect(result.terminal[1].id).toBe("t6");
    expect(result.terminal[0].status).toBe("completed");
    expect(result.terminal[0].updated_at).toBe(NOW);
  });

  it("未知 task: 原样返回 + totalDelta 0, 调用方交给 SSE 兜底", () => {
    const result = computeTaskMove(
      [mk("a", "queued")],
      [mk("b", "completed")],
      "ghost",
      "running",
      NOW,
    );
    expect(result.totalDelta).toBe(0);
    expect(result.active.map(t => t.id)).toEqual(["a"]);
    expect(result.terminal.map(t => t.id)).toEqual(["b"]);
  });

  it("不变量: 同一个 taskId 不可能同时出现在 active 和 terminal 输出里", () => {
    const t = mk("dup", "running");
    const out = computeTaskMove([t], [], "dup", "running", NOW);
    expect(out.active.find(x => x.id === "dup")).toBeDefined();
    expect(out.terminal.find(x => x.id === "dup")).toBeUndefined();

    const out2 = computeTaskMove([], [t], "dup", "running", NOW);
    expect(out2.active.find(x => x.id === "dup")).toBeDefined();
    expect(out2.terminal.find(x => x.id === "dup")).toBeUndefined();

    const out3 = computeTaskMove([t], [], "dup", "cancelled", NOW);
    expect(out3.active.find(x => x.id === "dup")).toBeUndefined();
    expect(out3.terminal.find(x => x.id === "dup")).toBeDefined();
  });

  it("不变量: 跨组移动时, 其它 task 顺序保留", () => {
    const a1 = mk("a1", "running");
    const a2 = mk("a2", "queued");
    const a3 = mk("a3", "paused");
    const t1 = mk("t1", "completed");
    const out = computeTaskMove([a1, a2, a3], [t1], "a2", "cancelled", NOW);

    expect(out.active.map(t => t.id)).toEqual(["a1", "a3"]);
    expect(out.terminal[0].id).toBe("a2");
    expect(out.terminal[1].id).toBe("t1");
  });

  // R118: 看板拖拽 task 从失败 (terminal) 到运行中 (active) 时, 同 taskId 同时出
  // 现在 active + terminal 双数组里 (SSE handler 和 runAction 之间存在竞争窗口,
  // refs 更新滞后 useEffect 一次 render). 这条覆盖"输入端就有重复"的不变量:
  // 输出永远不能有重复 ID. 端到端表现 = 失败卡片残留 + 运行中出现两张一样卡片.
  it("R118: 输入端 task 同时存在于 active + terminal, 输出仍然无重复", () => {
    const t = mk("dup", "failed", { updated_at: "2026-09-02T11:00:00.000Z" });
    // terminal → active 跨组, 即使输入端 active 已经有一份 dup (status='failed'),
    // 也不能在输出端变成两份.
    const out = computeTaskMove([t], [t], "dup", "running", NOW);
    const allIds = [...out.active.map(x => x.id), ...out.terminal.map(x => x.id)];
    const dupCount = allIds.filter(id => id === "dup").length;
    expect(dupCount).toBe(1);
    expect(out.active.find(x => x.id === "dup")?.status).toBe("running");
    expect(out.terminal.find(x => x.id === "dup")).toBeUndefined();

    // 反向: active → terminal 同款保护.
    const t2 = mk("dup2", "running");
    const out2 = computeTaskMove([t2], [t2], "dup2", "failed", NOW);
    const allIds2 = [...out2.active.map(x => x.id), ...out2.terminal.map(x => x.id)];
    const dupCount2 = allIds2.filter(id => id === "dup2").length;
    expect(dupCount2).toBe(1);
    expect(out2.terminal.find(x => x.id === "dup2")?.status).toBe("failed");
    expect(out2.active.find(x => x.id === "dup2")).toBeUndefined();
  });
});
