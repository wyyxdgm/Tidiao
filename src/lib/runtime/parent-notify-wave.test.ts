// R78 W2 — M 模式波次控制独立验收测试.
//
// 验证 5 个断言 (W2 §4.3 + w2-audit.md §5):
//   A1: M 用 dispatched_by_task_id 派 5 个子 task → sender 被调 5 次, 5 个不同短 ID.
//   A2: 5 个子 task 的 depends_on JSON 列均为 null (M 没把 depends_on 当波次闸门).
//   A3: M 显式 setWaitingChild(child1) → child1 completed → waiting_child_id 清空 +
//       M 自动 approve (reviewing → completed, skipReviewGate=true 唯一入口).
//   A4: 混合态 (failed + cancelled + 3 个 reviewing) → 5 条都触发父通知; 子 task 各自独立,
//       互不干扰; partial 完成 = M 仍在等 waiting_child_id 命中.
//   A6: depends_on 路径不参与 M 波次: depends_on=X1 的 child_pending 在 X1 完成时
//       auto-start, 但 dispatched_by_task_id 链仍走 R107 通知链.
//
// 设计:
//   - 真 DB + 真 AgentRuntime + 真 notifyParentOfChildStatusChange.
//   - 不启动 SDK subprocess: scheduler.setRunner 返回挂起 promise.
//   - sender 用 vi.fn() mock (不 auto-start 父, 这样 M 能保持 reviewing 状态让 waiting_child_id
//     机制生效). 测试父收到的"通知" = sender 入参, 不是 pending_messages (因为 mock sender
//     不写 pending_messages; 那是真实 sendUserMessage 的副作用).
//   - A6 单独用真 sendUserMessage (因为要验证 autoStartDependents 真生效, 这与 R107 链正交).
//
// 关注点:
//   - autoResumeParentAfterChildComplete 仅在 parent.status === "reviewing" 触发 (R127 §3.4 洞3);
//     mock sender 不改 status, 所以 M 保持 reviewing, auto-resume 链路可观测.
//   - depends_on 路径走 updateTaskStatus → approveTask → autoStartDependents; 不调 emitEvent
//     → 不触发 parent-notify, 与 R107 链完全正交.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const dispatchWebhookMock = vi.fn();
vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: (...args: unknown[]) => dispatchWebhookMock(...args),
}));
vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import {
  PARENT_CHILD_NOTIFY_EVENT,
  setupParentNotify,
} from "./parent-notify";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import {
  createTask,
  getTaskById,
  peekPendingMessages,
  setWaitingChild,
  replaceTaskDependencies,
  updateTaskStatus,
} from "../db/tasks";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-parent-notify-wave-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user");

  projectId = createProject({
    name: "parent-notify-wave-test",
    cwd: tmpDir,
    ownerId,
  }).id;

  dispatchWebhookMock.mockReset();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 构造 AgentRuntime + scheduler runner 换成挂起 promise (不真启动 SDK).
// 用 vi.fn() sender (不动 M 的 status, 让 waiting_child_id 机制可观测).
function makeRuntimeWithMockSender(): {
  runtime: AgentRuntime;
  senderMock: ReturnType<typeof vi.fn>;
} {
  const runtime = new AgentRuntime();
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler })
    .scheduler;
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) =>
      new Promise<void>(() => {
        /* hang */
      }),
  );
  const senderMock = vi.fn();
  setupParentNotify(
    (taskId: string, message: string, _reason?: string) => {
      senderMock(taskId, message);
    },
    (childTaskId: string) =>
      runtime!.autoResumeParentAfterChildComplete(childTaskId),
  );
  return { runtime, senderMock };
}

// 构造 AgentRuntime + scheduler runner 换成挂起 promise (不真启动 SDK).
// 用真 sendUserMessage (走 auto-resume 路径, 用于 A6 验证 depends_on 链正交).
function makeRuntimeWithRealSender(): AgentRuntime {
  const runtime = new AgentRuntime();
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler })
    .scheduler;
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) =>
      new Promise<void>(() => {
        /* hang */
      }),
  );
  setupParentNotify((taskId: string, message: string, _reason?: string) => {
    runtime.sendUserMessage(taskId, message);
  });
  return runtime;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// 建 M 任务 (强设 status + session_id).
function makeM(
  status: "running" | "reviewing" | "completed" | "paused",
  sessionId: string | null,
): Task {
  const t = createTask({
    title: "M-parent-task",
    prompt: "M prompt",
    project_id: projectId,
  });
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, status = ?, session_id = ? WHERE id = ?`,
    )
    .run(ownerId, status, sessionId, t.id);
  return getTaskById(t.id)!;
}

// 建 child task (挂 dispatched_by_task_id + running + session). 可选 dependsOn.
function makeChild(parentId: string, dependsOn: string[] = []): Task {
  const t = createTask({
    title: `child-task-${uuidv4().slice(0, 4)}`,
    prompt: "child prompt",
    project_id: projectId,
  });
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, dispatched_by_task_id = ?, status = ?, session_id = ? WHERE id = ?`,
    )
    .run(ownerId, parentId, "running", "sess-child", t.id);
  if (dependsOn.length > 0) {
    replaceTaskDependencies(t.id, dependsOn);
  }
  return getTaskById(t.id)!;
}

// ---- Tests ----

describe("parent-notify-wave: A1+A2 — M 用 dispatched_by_task_id 派 N 个子, 不靠 depends_on", () => {
  it("5 子 task (depends_on=[]) 全部进 reviewing → sender 被调 5 次 + 5 个不同短 ID + depends_on JSON 列均为 null", async () => {
    const { runtime, senderMock } = makeRuntimeWithMockSender();
    const m = makeM("reviewing", "sess-M");
    const children: Task[] = [];
    for (let i = 0; i < 5; i++) {
      children.push(makeChild(m.id, []));
    }

    // 5 个子 task 各自进 reviewing — 模拟 agent 各自完成一轮.
    for (const c of children) {
      runtime.emitEvent(c.id, {
        type: "status_change",
        task_id: c.id,
        from: "running",
        to: "reviewing",
      });
    }
    // 让链路 drain.
    for (let i = 0; i < 10; i++) await tick();

    // A1: sender 被调 5 次 (mock sender 不写库, 所以这里断言入参而非 pending_messages).
    expect(senderMock).toHaveBeenCalledTimes(5);
    const calledMessages = senderMock.mock.calls.map((c) => c[1] as string);
    for (const msg of calledMessages) {
      expect(msg).toContain("[subtask-notify]");
      expect(msg).toContain("已进入 reviewing");
    }
    // 5 条消息各自带不同的 child 短 ID.
    const shortIds = new Set(
      calledMessages.map((msg) => {
        const m = msg.match(/子任务 ([a-f0-9]{8})/);
        return m ? m[1] : null;
      }),
    );
    expect(shortIds.size).toBe(5);

    // A2: depends_on 列均为 null (M 没把 depends_on 当波次闸门).
    const db = getDb();
    for (const c of children) {
      const row = db
        .prepare("SELECT depends_on FROM tasks WHERE id = ?")
        .get(c.id) as { depends_on: string | null };
      expect(row.depends_on).toBeNull();
    }

    // mock sender 不写库, 所以 pending_messages 是空。
    expect(peekPendingMessages(m.id).length).toBe(0);
  });
});

describe("parent-notify-wave: A3 — M 显式等待特定子, 子完成触发父 auto-approve", () => {
  it("setWaitingChild(child1) → child1 completed → waiting_child_id 清空 + M auto-approved", async () => {
    const { runtime } = makeRuntimeWithMockSender();
    const m = makeM("reviewing", "sess-M");
    const child1 = makeChild(m.id);
    const child2 = makeChild(m.id);
    const child3 = makeChild(m.id);

    // M 显式标 waiting_child_id = child1.id (走 setWaitingChild → mutateTaskMetadata).
    const setOk = setWaitingChild(m.id, child1.id);
    expect(setOk).toBe(true);

    // child1 进 reviewing → completed. mock sender 不动 M.status, M 保持 reviewing.
    runtime.emitEvent(child1.id, {
      type: "status_change",
      task_id: child1.id,
      from: "running",
      to: "reviewing",
    });
    runtime.emitEvent(child1.id, {
      type: "status_change",
      task_id: child1.id,
      from: "reviewing",
      to: "completed",
    });
    for (let i = 0; i < 10; i++) await tick();

    // waiting_child_id 应已被清 (mutateTaskMetadata 路径走通).
    const mAfter = getTaskById(m.id)!;
    const meta = mAfter.metadata ? JSON.parse(mAfter.metadata) : {};
    expect(meta.waiting_child_id).toBeUndefined();

    // M 应被 auto-approved (reviewing → completed, skipReviewGate=true 唯一入口).
    expect(mAfter.status).toBe("completed");

    // child2 / child3 还在 running, 互不干扰.
    expect(getTaskById(child2.id)!.status).toBe("running");
    expect(getTaskById(child3.id)!.status).toBe("running");
  });

  it("子 completed 但 waiting_child_id 不匹配 → 不触发 auto-approve (血缘白名单生效)", async () => {
    const { runtime } = makeRuntimeWithMockSender();
    const m = makeM("reviewing", "sess-M");
    const waiting = makeChild(m.id);
    const unrelated = makeChild(m.id);

    // M 只标 waiting_child_id = waiting.id.
    setWaitingChild(m.id, waiting.id);

    // unrelated 进 completed, 但 M 没在等它 → 应不触发 auto-approve.
    runtime.emitEvent(unrelated.id, {
      type: "status_change",
      task_id: unrelated.id,
      from: "running",
      to: "reviewing",
    });
    runtime.emitEvent(unrelated.id, {
      type: "status_change",
      task_id: unrelated.id,
      from: "reviewing",
      to: "completed",
    });
    for (let i = 0; i < 10; i++) await tick();

    // M 仍在 reviewing (auto-approve 没触发).
    const mAfter = getTaskById(m.id)!;
    expect(mAfter.status).toBe("reviewing");
    // waiting_child_id 仍未清 (无关子 completed 不动它).
    const meta = mAfter.metadata ? JSON.parse(mAfter.metadata) : {};
    expect(meta.waiting_child_id).toBe(waiting.id);
  });
});

describe("parent-notify-wave: A4 — 混合态 (failed + cancelled + reviewing) 触发父通知但不全完成", () => {
  it("5 子混合态 → sender 被调 5 次; waiting 命中前 M 不动; 命中后 M auto-approved", async () => {
    const { runtime, senderMock } = makeRuntimeWithMockSender();
    const m = makeM("reviewing", "sess-M");
    const children: Task[] = [];
    for (let i = 0; i < 5; i++) children.push(makeChild(m.id));

    // M 只等 child0; 其他 4 个各自走不同结局, 都到 NOTIFY_STATUSES 之一.
    setWaitingChild(m.id, children[0].id);

    // 用 emitEvent 触发 parent-notify 通知流 (DB 状态保持 running — 这是 parent-notify
    // 设计: 通知链路只信任 event 的 from/to 字段, 不耦合 task 表 status. 同步更新 DB
    // 是上层 caller 的责任).
    // child0 → reviewing
    runtime.emitEvent(children[0].id, {
      type: "status_change", task_id: children[0].id, from: "running", to: "reviewing",
    });
    // child1 → failed
    runtime.emitEvent(children[1].id, {
      type: "status_change", task_id: children[1].id, from: "running", to: "failed",
    });
    // child2 → cancelled
    runtime.emitEvent(children[2].id, {
      type: "status_change", task_id: children[2].id, from: "running", to: "cancelled",
    });
    // child3 → reviewing
    runtime.emitEvent(children[3].id, {
      type: "status_change", task_id: children[3].id, from: "running", to: "reviewing",
    });
    // child4 → reviewing
    runtime.emitEvent(children[4].id, {
      type: "status_change", task_id: children[4].id, from: "running", to: "reviewing",
    });
    for (let i = 0; i < 20; i++) await tick();

    // sender 被调 5 次 (reviewing + failed + cancelled + reviewing + reviewing).
    expect(senderMock).toHaveBeenCalledTimes(5);

    // M 仍在 reviewing — child0 还没 completed, auto-approve 不触发.
    const mAfter = getTaskById(m.id)!;
    expect(mAfter.status).toBe("reviewing");

    // 子 task DB 状态保持原值 running — emitEvent 不动 DB; 父 task 不被误标完成, 子 task 互不干扰.
    for (const c of children) {
      expect(getTaskById(c.id)!.status).toBe("running");
    }

    // waiting_child_id 仍未清 (child0 未 completed).
    const meta = mAfter.metadata ? JSON.parse(mAfter.metadata) : {};
    expect(meta.waiting_child_id).toBe(children[0].id);

    // 现在让 child0 completed — emitEvent 触发 parent-notify 血缘白名单命中 →
    //   autoResumeParentAfterChildComplete → 清 waiting_child_id + approve M.
    runtime.emitEvent(children[0].id, {
      type: "status_change", task_id: children[0].id, from: "reviewing", to: "completed",
    });
    for (let i = 0; i < 20; i++) await tick();

    const mFinal = getTaskById(m.id)!;
    expect(mFinal.status).toBe("completed");
    const metaFinal = mFinal.metadata ? JSON.parse(mFinal.metadata) : {};
    expect(metaFinal.waiting_child_id).toBeUndefined();
  });
});

describe("parent-notify-wave: A6 — depends_on 路径不参与 M 波次", () => {
  it("child_x 依赖 X1, X1 completed → child_x auto-start (pending → queued/running); child_x 进 reviewing → M 收 R107 通知", async () => {
    const runtime = makeRuntimeWithRealSender();
    const m = makeM("running", "sess-M");
    // X1: 一个独立 task, 不挂在 M 下 (模拟「先要做的前置调研」).
    const x1 = createTask({
      title: "X1-predecessor",
      prompt: "X1 prompt",
      project_id: projectId,
    });
    getDb()
      .prepare(
        `UPDATE tasks SET owner_id = ?, status = ?, session_id = ? WHERE id = ?`,
      )
      .run(ownerId, "running", "sess-X1", x1.id);

    // child_x: 同时 (a) dispatched_by_task_id=M (R107 通知链) + (b) depends_on_ids=[X1] (依赖闸门).
    const childX = createTask({
      title: "child-with-deps",
      prompt: "child prompt",
      project_id: projectId,
      dependsOn: [x1.id],
    });
    getDb()
      .prepare(
        `UPDATE tasks SET owner_id = ?, dispatched_by_task_id = ?, status = ?, session_id = ? WHERE id = ?`,
      )
      .run(ownerId, m.id, "pending", null, childX.id);

    // X1 → completed: 走 approveTask → updateTaskStatus("completed") + emitEvent + autoStartDependents
    //   → childX auto-start. X1.dispatched_by_task_id = null, 所以 emitEvent 后 parent-notify 早返
    //   (子无 parent), 与 M 派发链完全正交.
    // 先把 X1 推到 reviewing (approveTask 仅允许 reviewing/rejected/paused/await_user).
    updateTaskStatus(x1.id, "reviewing");
    runtime.approveTask(x1.id);
    for (let i = 0; i < 20; i++) await tick();

    // childX 应已被 auto-started (status 不再是 pending).
    expect(getTaskById(childX.id)!.status).not.toBe("pending");

    // X1 没有 dispatched_by_task_id, 所以 M.pending_messages 在 X1 完成时**没有**收到 R107 通知.
    expect(peekPendingMessages(m.id).length).toBe(0);

    // 现在让 childX 进 reviewing → M 应收到 R107 通知 (因为 childX.dispatched_by_task_id = M).
    // 走真 sendUserMessage + canAutoStart (M 是 running 状态, sendUserMessage 早返 "No active
    // session" 走 webhook 兜底) — 也说明 depends_on 路径与 R107 链互不影响.
    updateTaskStatus(childX.id, "reviewing");
    runtime.emitEvent(childX.id, {
      type: "status_change", task_id: childX.id, from: "running", to: "reviewing",
    });
    for (let i = 0; i < 20; i++) await tick();

    // X1 完成没污染 M (depends_on 不刷 R107); childX reviewing 触发了 R107 链路.
    // (M 处于 running 状态, sendUserMessage 走 webhook 兜底, 不入 pending_messages)
    const webhookCalls = dispatchWebhookMock.mock.calls.filter(
      (c) => c[0] === PARENT_CHILD_NOTIFY_EVENT,
    );
    expect(webhookCalls.length).toBeGreaterThanOrEqual(1);
    const lastNote = JSON.parse(webhookCalls[webhookCalls.length - 1][3] as string);
    expect(lastNote.child_id).toBe(childX.id);
    expect(lastNote.child_to).toBe("reviewing");
  });
});