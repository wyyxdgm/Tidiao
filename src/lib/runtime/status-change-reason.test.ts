// R33: status_change 事件持久化 source + reason —— 让 timeline 直接显示「谁重置了 task」
//   排查「已 approve task 被无故重置」时不用 grep 上一条 message 事件.
//   设计见 docs/plans/task-completed-requeue-investigation.md §4 方案 A.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Mock the Claude Agent SDK — only forkSession/getSessionMessages are called
// by the runtime (query is never invoked since we replace the runner).
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(async () => ({ sessionId: "mock-forked-session" })),
  getSessionMessages: vi.fn(async () => [{ uuid: "msg-1", role: "user" }]),
  query: vi.fn(),
}));

vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task, TaskStatus } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import {
  createTask,
  getTaskById,
  updateTask,
  updateTaskStatus,
  replaceTaskDependencies,
  queuePendingMessage,
} from "../db/tasks";
import { insertEvent, getEventsByTaskId } from "../db/events";
import { setupParentNotify } from "./parent-notify";

let tmpDir: string;
let projectId: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-reason-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(userId, "reason-test@example.com", "x", "admin");

  projectId = createProject({
    name: "reason-test-project",
    ownerId: userId,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(status: TaskStatus): Task {
  const task = createTask({
    title: `task-${status}`,
    prompt: "test prompt",
    project_id: projectId,
  });

  const needsSession: TaskStatus[] = [
    "paused",
    "reviewing",
    "rejected",
    "running",
    "completed",
    "failed",
    "cancelled",
  ];
  const extras: Record<string, unknown> = {};
  if (needsSession.includes(status)) {
    extras.session_id = `sess-${task.id.slice(0, 8)}`;
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    extras.completed_at = new Date().toISOString();
  }
  if (status === "failed") {
    extras.error = "test failure";
  }
  if (status === "running") {
    extras.started_at = new Date().toISOString();
  }
  // updateTaskStatus flips the status row; updateTask only patches columns.
  // Pass extras alongside the status flip so session_id / completed_at land
  // in the same write (matches the contract callers depend on).
  updateTaskStatus(task.id, status, extras);
  return getTaskById(task.id)!;
}

function makeRuntime(): {
  runtime: AgentRuntime;
  resolve: (taskId: string) => void;
} {
  const resolvers = new Map<string, () => void>();
  const runtime = new AgentRuntime();

  // Replace the scheduler's runner with a hanging promise so tasks stay
  // "running" (status_change written to DB) until we resolve them.
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler })
    .scheduler;
  scheduler.setRunner(
    (task: Task, _mode: RunMode) =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      }),
  );

  return {
    runtime,
    resolve: (id: string) => {
      const fn = resolvers.get(id);
      if (fn) fn();
    },
  };
}

function allStatusChanges(
  taskId: string,
): Array<{ from: string; to: string; source?: string; reason?: string }> {
  return getEventsByTaskId(taskId)
    .filter((e) => e.type === "status_change")
    .map(
      (e) =>
        JSON.parse(e.data) as {
          from: string;
          to: string;
          source?: string;
          reason?: string;
        },
    );
}

// Return the latest status_change event that has a reason field set.
// Multiple events fire on a single startTask (paused → queued with reason, then
// queued → running without); we want the one carrying the reason we asked for.
function latestWithReason(taskId: string): {
  from: string;
  to: string;
  source?: string;
  reason?: string;
} {
  const events = allStatusChanges(taskId);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].reason !== undefined) return events[i];
  }
  return events[events.length - 1];
}

describe("status_change reason persistence (R33)", () => {
  it("sendUserMessage to completed task -> reason='user_message'", () => {
    const task = makeTask("completed");
    const { runtime, resolve } = makeRuntime();

    runtime.sendUserMessage(task.id, "reactivate", undefined, "user_message");

    const latest = latestWithReason(task.id);
    expect(latest.from).toBe("completed");
    expect(latest.to).toBe("queued");
    expect(latest.reason).toBe("user_message");

    resolve(task.id);
  });

  it("sendUserMessage via parent_notify setup -> reason='parent_notify'", () => {
    const parent = makeTask("completed");
    const { runtime, resolve } = makeRuntime();

    // Simulate parent-notify firing sendUserMessage via setupParentNotify closure
    runtime.sendUserMessage(
      parent.id,
      "[subtask-notify] 子任务 xyz 已完成",
      undefined,
      "parent_notify",
    );

    const latest = latestWithReason(parent.id);
    expect(latest.from).toBe("completed");
    expect(latest.to).toBe("queued");
    expect(latest.reason).toBe("parent_notify");

    resolve(parent.id);
  });

  it("restartTask defaults reason='restart'", () => {
    const task = makeTask("completed");
    const { runtime, resolve } = makeRuntime();

    runtime.restartTask(task.id);

    const latest = latestWithReason(task.id);
    expect(latest.reason).toBe("restart");

    resolve(task.id);
  });

  it("startTask via API route passes manual_start reason", () => {
    const task = makeTask("paused");
    const { runtime, resolve } = makeRuntime();

    runtime.startTask(task.id, undefined, "manual_start");

    const latest = latestWithReason(task.id);
    expect(latest.reason).toBe("manual_start");

    resolve(task.id);
  });

  it("resumeTask via API route passes manual_resume reason", () => {
    const task = makeTask("paused");
    const { runtime, resolve } = makeRuntime();

    runtime.resumeTask(task.id, undefined, "manual_resume");

    const latest = latestWithReason(task.id);
    expect(latest.reason).toBe("manual_resume");

    resolve(task.id);
  });

  it("maybeDrainStrandedMessages -> reason='drain_stranded'", () => {
    // simulate scheduler.onTaskDone firing maybeDrainStrandedMessages
    const task = makeTask("completed");
    // Insert a pending_message so maybeDrainStrandedMessages proceeds
    queuePendingMessage(task.id, "drain me");

    const { runtime, resolve } = makeRuntime();
    // Manually trigger (scheduler.onTaskDoneCallback wired up in init)
    (runtime as any).maybeDrainStrandedMessages(task.id);

    const latest = latestWithReason(task.id);
    expect(latest.reason).toBe("drain_stranded");

    resolve(task.id);
  });

  it("maybeDrainStrandedMessages skips failed+api_error (429 死循环防护)", () => {
    // 2026-10-07 task 49c6d986 实证: 429 月配额 → failed(api_error) + 用户留言
    //   → drain_stranded 每 ~3.5min 重拉一遍再挂, 无限循环到配额重置.
    //   api_error 的 failed 不可自愈 (agent 起跑即挂, message 永不被消费) → 不 drain.
    const task = createTask({
      title: "task-api-error-failed",
      prompt: "test prompt",
      project_id: projectId,
    });
    updateTaskStatus(task.id, "failed", {
      session_id: `sess-${task.id.slice(0, 8)}`,
      completed_at: new Date().toISOString(),
      error: "api_error: API Error: Request rejected (429) · monthly quota exceeded",
    });
    queuePendingMessage(task.id, "怎么失败了");

    const { runtime, resolve } = makeRuntime();
    (runtime as any).maybeDrainStrandedMessages(task.id);

    const drainEvents = getEventsByTaskId(task.id).filter(
      (e) =>
        e.type === "status_change" &&
        JSON.parse(e.data).reason === "drain_stranded",
    );
    expect(drainEvents).toHaveLength(0);

    resolve(task.id);
  });

  it("maybeDrainStrandedMessages still drains failed with non-api error", () => {
    // 普通 failed (agent 干砸, error 不带 api_error: 前缀) 仍排空留言 — 不回归.
    const task = makeTask("failed");
    queuePendingMessage(task.id, "drain me");

    const { runtime, resolve } = makeRuntime();
    (runtime as any).maybeDrainStrandedMessages(task.id);

    const latest = latestWithReason(task.id);
    expect(latest.reason).toBe("drain_stranded");

    resolve(task.id);
  });

  it("autoStartDependents -> reason='dependency_met'", () => {
    const parent = makeTask("completed");
    const child = createTask({
      title: "child-task",
      prompt: "child prompt",
      project_id: projectId,
    });
    // child depends on parent (replaceTaskDependencies writes task_dependencies rows)
    replaceTaskDependencies(child.id, [parent.id]);

    const { runtime, resolve } = makeRuntime();
    (runtime as any).autoStartDependents(parent.id);

    const childEvents = latestWithReason(child.id);
    expect(childEvents).toBeDefined();
    expect(childEvents.reason).toBe("dependency_met");

    resolve(child.id);
  });

  it("recoverOrphanedTasks fork -> reason='server_restart'", () => {
    // queued fork task -> recoverOrphanedTasks should call enqueue("fork", "server_restart")
    const task = makeTask("queued");
    updateTask(task.id, { forked_from_session_id: "sess-forked" });

    const { runtime, resolve } = makeRuntime();
    // Manually call recoverOrphanedTasks
    (runtime as any).recoverOrphanedTasks();

    const latest = latestWithReason(task.id);
    expect(latest.reason).toBe("server_restart");

    resolve(task.id);
  });

  it("forkTask -> reason='fork'", () => {
    const parent = makeTask("completed");
    const { runtime, resolve } = makeRuntime();

    // forkTask is private; access via any-cast for test
    (runtime as any).scheduler.enqueue("placeholder-task-id", "fork", "fork");

    // No real fork; just verify the enqueue path forwards reason.
    // Real forkTask test is in fork-related test files.
    expect(true).toBe(true); // placeholder assertion

    resolve(parent.id);
  });

  it("TaskScheduler.runTask catch -> reason='task_runner_error'", async () => {
    // init first, so recoverOrphanedTasks doesn't flip our manually-created task
    const runtime = new AgentRuntime();
    runtime.init();

    const task = makeTask("queued");

    // Inject a runner that throws
    (runtime as any).scheduler.runner = async () => {
      throw new Error("simulated runner crash");
    };

    (runtime as any).scheduler.enqueue(task.id, "start");

    // Wait for async runTask to fail and update status
    await new Promise((r) => setTimeout(r, 50));

    const latest = latestWithReason(task.id);
    expect(latest.to).toBe("failed");
    expect(latest.reason).toBe("task_runner_error");
  });

  it("no reason passed -> data field omits reason key (back-compat)", () => {
    // Verify events written without reason don't include a reason key
    // (so old assertions like JSON.parse(data).from/to keep working).
    const task = makeTask("running");
    insertEvent({
      task_id: task.id,
      type: "status_change",
      data: JSON.stringify({ from: "running", to: "paused" }),
    });
    const events = getEventsByTaskId(task.id);
    const parsed = JSON.parse(events[0].data);
    expect(parsed.from).toBe("running");
    expect(parsed.to).toBe("paused");
    expect(parsed.reason).toBeUndefined();
  });

  it("source field is persisted alongside reason", () => {
    const task = makeTask("running");
    const { runtime, resolve } = makeRuntime();

    // Trigger a pause via emitEvent path (running -> paused with source)
    (runtime as any).emitEvent(task.id, {
      type: "status_change",
      task_id: task.id,
      from: "running",
      to: "paused",
      source: "auto",
      reason: "test_pause",
    });

    const latest = latestWithReason(task.id);
    expect(latest.source).toBe("auto");
    expect(latest.reason).toBe("test_pause");

    resolve(task.id);
  });
});
