// R107 父子任务通知机制 — 集成测试 (e2e).
//
// 设计稿 docs/designs/2026-08-25-parent-notify.md §Q5:
//   "起一个临时 DB → 建 parent task + 派 child task → 子任务
//   updateTaskStatus("reviewing") → emitEvent → 断言 tasks.metadata.pending_messages
//   出现 [subtask-notify] 消息"
//
// 关注点:
//   - 真 DB + 真 AgentRuntime + 真 sendUserMessage (不走 vi.fn 替身, 因为设计稿要求
//     验证 auto-resume 路径上的真实副作用 — pending_messages 落库).
//   - 不启动 SDK subprocess: 用 status-transitions.test.ts 同款 "hanging runner" 模式.
//     scheduler.setRunner 返回一个挂起的 promise, 模拟 agent 还在跑.
//   - webhook 兜底 event (PARENT_CHILD_NOTIFY_EVENT) 默认无订阅方 — 我们只检查
//     dispatchWebhook 被调 + 入参正确, 不实际出网 (mock).

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

// 不启动 SDK subprocess — query/forkSession 不需要, 但防万一保险桩化.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import { PARENT_CHILD_NOTIFY_EVENT, setupParentNotify } from "./parent-notify";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, peekPendingMessages } from "../db/tasks";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-parent-notify-e2e-"));
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
    name: "parent-notify-e2e",
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

// 构造一个 AgentRuntime, 把 scheduler runner 换成挂起 promise (不真启动 SDK).
function makeRuntime(): {
  runtime: AgentRuntime;
  resolve: (taskId: string) => void;
} {
  const resolvers = new Map<string, () => void>();
  const runtime = new AgentRuntime();
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler })
    .scheduler;
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) =>
      new Promise<void>((resolve) => {
        resolvers.set(_task.id, resolve);
      }),
  );
  // 真注入 sender = 真 sendUserMessage (走 auto-resume 路径).
  // 我们绕过 getRuntime() 单例 (它会启动 init 等), 直接拿这个 runtime 的 sendUserMessage.
  // 但 parent-notify 用的是 setupParentNotify 全局注入, 所以 sender 闭包要捕获这个 runtime.
  // 第 3 参 reason: 测试不关心 (生产路径会传 "parent_notify"，让 status_change 事件带 reason).
  setupParentNotify((taskId: string, message: string, _reason?: string) => {
    runtime.sendUserMessage(taskId, message);
  });
  return {
    runtime,
    resolve: (taskId: string) => {
      const fn = resolvers.get(taskId);
      if (fn) fn();
    },
  };
}

// 建 parent task (强设 status + session_id).
function makeParent(
  status: "running" | "completed" | "paused" | "reviewing",
  sessionId: string | null,
): Task {
  const t = createTask({
    title: "parent-task",
    prompt: "parent prompt",
    project_id: projectId,
  });
  const completedAt =
    status === "completed" || status === "failed" || status === "cancelled"
      ? new Date().toISOString()
      : null;
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, status = ?, session_id = ?, completed_at = ? WHERE id = ?`,
    )
    .run(ownerId, status, sessionId, completedAt, t.id);
  return getTaskById(t.id)!;
}

// 建 child task 并挂上 dispatched_by_task_id + 设 session_id (让 status 转换符合预期).
function makeChild(parentId: string): Task {
  const t = createTask({
    title: "child-task",
    prompt: "child prompt",
    project_id: projectId,
  });
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, dispatched_by_task_id = ?, status = ?, session_id = ? WHERE id = ?`,
    )
    .run(ownerId, parentId, "running", "sess-child", t.id);
  return getTaskById(t.id)!;
}

// 让 microtask drain (emitEvent 是同步, 但 sendUserMessage → startTask 是异步链路).
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- Tests ----

describe("parent-notify e2e: emitEvent → 真 sendUserMessage → pending_messages", () => {
  it("父 completed + session_id + 子 reviewing → 父 metadata.pending_messages 含 [subtask-notify] reviewing", async () => {
    const { runtime } = makeRuntime();
    // 关键: 父 status=completed + session_id 有, 触发 sendUserMessage 的 canAutoStart
    //   分支 (auto-resume) — 这是 R107 设计的核心场景.
    const parent = makeParent("completed", "sess-completed-parent");
    const child = makeChild(parent.id);

    // 调试: 确认父 task 真的有 session_id + status=completed
    const parentDb = getTaskById(parent.id)!;
    expect(parentDb.session_id).toBe("sess-completed-parent");
    expect(parentDb.status).toBe("completed");

    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "running",
      to: "reviewing",
    });
    // 让 sendUserMessage → queuePendingMessage + startTask 链路 drain.
    await tick();
    await tick();

    const pending = peekPendingMessages(parent.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]).toContain("[subtask-notify]");
    expect(pending[0]).toContain("已进入 reviewing");
    expect(pending[0]).toContain(child.id);
  });

  it("父 failed + session_id + 子 failed → 父 pending_messages 含 [subtask-notify] failed", async () => {
    const { runtime } = makeRuntime();
    const parent = makeParent("failed", "sess-failed-parent");
    const child = makeChild(parent.id);

    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "running",
      to: "failed",
    });
    await tick();
    await tick();

    const pending = peekPendingMessages(parent.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]).toContain("已进入 failed");
  });

  it("父 paused + session_id + 子 cancelled → 父 pending_messages 含 [subtask-notify] cancelled", async () => {
    const { runtime } = makeRuntime();
    const parent = makeParent("paused", "sess-paused-parent");
    const child = makeChild(parent.id);

    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "running",
      to: "cancelled",
    });
    await tick();
    await tick();

    const pending = peekPendingMessages(parent.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]).toContain("已进入 cancelled");
  });
});

describe("parent-notify e2e: webhook 兜底 (父 session_id=null)", () => {
  it("父 completed 但 session_id=null (从未启动) → 走 webhook 兜底, 不入 pending_messages", async () => {
    const { runtime } = makeRuntime();
    const parent = makeParent("completed", null); // 父无 session
    const child = makeChild(parent.id);

    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "running",
      to: "reviewing",
    });
    await tick();

    // 父的 pending_messages 应为空 (sendUserMessage 不会入 — 父从未启动).
    expect(peekPendingMessages(parent.id)).toEqual([]);

    // webhook 兜底被调 (task.reviewing 是既有契约; task.parent_child_notify 是 R107 新增).
    //   两者都会被调: 父软删/session 缺失 → emitEvent 仍按 status_change → task.reviewing 发;
    //   parent-notify 走 webhook 兜底 → task.parent_child_notify 发. 互不干扰.
    const parentChildNotifyCalls = dispatchWebhookMock.mock.calls.filter(
      (c) => c[0] === PARENT_CHILD_NOTIFY_EVENT,
    );
    expect(parentChildNotifyCalls.length).toBe(1);
    const [event, parentTask, , note] = parentChildNotifyCalls[0];
    expect(event).toBe(PARENT_CHILD_NOTIFY_EVENT);
    expect(parentTask.id).toBe(parent.id);
    const parsed = JSON.parse(note as string);
    expect(parsed.child_to).toBe("reviewing");
    expect(parsed.child_id).toBe(child.id);
  });
});

describe("parent-notify e2e: 与既有 webhook 契约兼容 (枚举扩大不破坏)", () => {
  it("父 alive (completed + session_id) → 父通知走 sendUserMessage, 既有 task.reviewing webhook 仍正常发", async () => {
    const { runtime } = makeRuntime();
    const parent = makeParent("completed", "sess-x");
    const child = makeChild(parent.id);

    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "running",
      to: "reviewing",
    });
    await tick();
    await tick();

    // 父通知走真 sendUserMessage → 入 pending_messages.
    const pending = peekPendingMessages(parent.id);
    expect(pending.length).toBeGreaterThan(0);

    // task.reviewing webhook 仍被调 (既有契约, 不被新增事件类型影响).
    const reviewingCalls = dispatchWebhookMock.mock.calls.filter(
      (c) => c[0] === "task.reviewing",
    );
    expect(reviewingCalls.length).toBeGreaterThanOrEqual(1);

    // 父 alive 路径不走 task.parent_child_notify 兜底.
    const parentChildNotifyCalls = dispatchWebhookMock.mock.calls.filter(
      (c) => c[0] === PARENT_CHILD_NOTIFY_EVENT,
    );
    expect(parentChildNotifyCalls.length).toBe(0);
  });
});

describe("parent-notify e2e: NOTIFY_STATUSES 多次触发", () => {
  it("子 task 跨多次终态进入 (reviewing + cancelled) → 第一次入 pending_messages, 第二次走 webhook 兜底 (父 status 已变 running)", async () => {
    // 物理现实: 第一次 emit 后, sendUserMessage → startTask 把父 status 同步改为 running.
    //   第二次 emit 时 sendUserMessage 看到 status=running, 三个分支 (paused/terminal/queued)
    //   都不匹配, 走到最末 throw "No active session" → parent-notify catch → webhook 兜底.
    //   这是真实系统行为, 测试如实反映:
    //     - pending_messages 1 条 (reviewing)
    //     - task.parent_child_notify webhook 1 条 (cancelled)
    const { runtime } = makeRuntime();
    const parent = makeParent("completed", "sess-multi");
    const child = makeChild(parent.id);

    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "running",
      to: "reviewing",
    });
    runtime.emitEvent(child.id, {
      type: "status_change",
      task_id: child.id,
      from: "reviewing",
      to: "cancelled",
    });
    await tick();
    await tick();
    await tick();

    // 第一次 emit → 入 pending_messages
    const pending = peekPendingMessages(parent.id);
    expect(pending.length).toBe(1);
    expect(pending[0]).toContain("已进入 reviewing");

    // 第二次 emit → 走 webhook 兜底 (父 status 已 running, sendUserMessage 抛 No active session)
    const parentChildNotifyCalls = dispatchWebhookMock.mock.calls.filter(
      (c) => c[0] === PARENT_CHILD_NOTIFY_EVENT,
    );
    expect(parentChildNotifyCalls.length).toBe(1);
    const noteParsed = JSON.parse(parentChildNotifyCalls[0][3] as string);
    expect(noteParsed.child_to).toBe("cancelled");
  });
});
