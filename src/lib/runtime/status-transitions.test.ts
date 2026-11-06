// Task status state machine: exhaustive 9×9 transition test
//
// Tests every (from, to) pair against the backend SDK (AgentRuntime).
// - Allowed transitions: verify success + default parameters
// - Disallowed transitions: verify explicit error (not silent no-op)
//
// No real LLM calls — the SDK runner is replaced with a hanging promise
// so tasks stay "running" until we resolve them.

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

// Mock webhook dispatcher — no outbound HTTP in tests
vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: vi.fn(),
}));

// Mock rule engine — no rule evaluation in tests
vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task, TaskStatus } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus, updateTask, queuePendingMessage, drainPendingMessages, peekPendingMessages } from "../db/tasks";
import { insertEvent, getEventsByTaskId } from "../db/events";

let tmpDir: string;
let projectId: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-status-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // run all migrations

  // Insert a user for owner_id
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "status-test@example.com", "x", "admin");

  projectId = createProject({ name: "status-test-project", ownerId: userId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Helpers ----

// All 11 statuses in canonical order (DAG P3 加 verifying, R131 加 await_user)
const ALL_STATUSES: TaskStatus[] = [
  "pending", "queued", "running", "paused",
  "reviewing", "verifying", "await_user", "completed", "failed", "rejected", "cancelled",
];

// Create a task and force it into the given status.
// For statuses that require a session_id (paused, reviewing, rejected, await_user),
// we set one so the runtime can work with them.
function makeTask(status: TaskStatus): Task {
  const task = createTask({
    title: `task-${status}`,
    prompt: "test prompt",
    project_id: projectId,
  });

  // Set session_id for statuses that need it
  // All statuses that have been executed (non-pending/queued) should have a session_id
  const needsSession: TaskStatus[] = ["paused", "reviewing", "rejected", "running", "completed", "failed", "cancelled", "verifying", "await_user"];
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
  if (status === "reviewing" || status === "verifying") {
    extras.completed_at = new Date().toISOString();
    extras.result = "done";
  }
  if (status === "rejected") {
    // Set metadata with reject info (历史兼容: 旧 rejected 状态有 reject_reason)
    updateTask(task.id, {
      metadata: JSON.stringify({
        reject_reason: "test reject",
        reject_count: 1,
        last_rejected_at: new Date().toISOString(),
      }),
    });
  }

  updateTaskStatus(task.id, status, extras);
  return getTaskById(task.id)!;
}

// Create a runtime with a fake runner that hangs (task stays "running").
// Returns the runtime + a resolve function to end the hanging task.
function makeRuntime(): {
  runtime: AgentRuntime;
  resolve: (taskId: string) => void;
} {
  const resolvers = new Map<string, () => void>();
  const runtime = new AgentRuntime();

  // Replace the scheduler's runner with a hanging promise
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
  scheduler.setRunner((task: Task, _mode: RunMode) =>
    new Promise<void>((resolve) => {
      resolvers.set(task.id, resolve);
    })
  );

  return {
    runtime,
    resolve: (taskId: string) => {
      const fn = resolvers.get(taskId);
      if (fn) fn();
    },
  };
}

// Tick: let microtasks drain (scheduler's async tail)
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- Allowed transitions (from constants.ts VALID_STATUS_TRANSITIONS) ----
// These are the transitions the kanban UI permits via drag-and-drop.
// The backend may also accept some transitions not in the UI map (e.g. cancel from any status).

const ALLOWED: Record<string, Set<string>> = {
  pending: new Set(["queued", "running", "cancelled"]),
  queued: new Set(["running", "cancelled", "pending"]),  // 🆕 R162: 看板拖回 pending
  running: new Set(["paused", "await_user", "cancelled"]),  // 🆕 R131: await_user
  paused: new Set(["running", "cancelled", "verifying", "completed"]),
  reviewing: new Set(["completed", "running", "verifying"]),  // R131: reject 移除
  verifying: new Set(["completed", "running", "failed", "cancelled"]),
  await_user: new Set(["running", "completed", "cancelled"]),  // 🆕 R131
  completed: new Set(["running"]),
  failed: new Set(["running"]),
  rejected: new Set(["running", "completed"]),
  cancelled: new Set(["running"]),
};

// ---- Test suites ----

describe("Task status state machine: allowed transitions", () => {
  // pending → queued/running (via start)
  it("pending → running (via startTask, when slot is free)", () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    expect(getTaskById(task.id)?.started_at).not.toBeNull();
    resolve(task.id);
  });

  it("pending → cancelled (via cancelTask)", async () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    await runtime.cancelTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  // queued → running (via startTask on a queued task — scheduler picks it up)
  it("queued → running (via startTask, scheduler picks up)", () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();
    // First start puts it in queued (if concurrency is full) or running.
    // With our fake runner and concurrency=2, it goes straight to running.
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  it("queued → cancelled (via cancelTask)", async () => {
    // Create a task, manually set to queued
    const task = makeTask("pending");
    updateTaskStatus(task.id, "queued");
    const { runtime } = makeRuntime();
    await runtime.cancelTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  // 🆕 R162 (damo 2026-09-22): 看板拖拽 queued → pending — 走 dequeueTask.
  //   与 cancel 的区别: 不删 session_id, 不算终止态, 不写 completed_at.
  //   任务留在 pending, 后续可直接 start (R155 同款 resumed 路径).
  it("queued → pending (via dequeueTask): 保留 session_id + 清 queued_order", () => {
    const task = makeTask("pending");
    // 模拟 scheduler enqueue 后的状态: queued + 有 queued_order + 有 session
    // (R155 路径: queued task 大多带 session_id, 否则不会入队)
    updateTask(task.id, {
      session_id: "mock-forked-session",
      queued_order: 42,
    });
    updateTaskStatus(task.id, "queued");
    const { runtime } = makeRuntime();
    expect(getTaskById(task.id)?.status).toBe("queued");

    runtime.dequeueTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("pending");
    // session_id 必须保留 — 用户拖出去后还能 start, 不能丢上下文
    expect(after?.session_id).toBe("mock-forked-session");
    // queued_order 必须清空 — re-queue 时按 MAX+1 排到队尾, 不按旧 order 插回去
    expect(after?.queued_order).toBeNull();
    // 不是终止态, 不写 completed_at
    expect(after?.completed_at).toBeNull();
    // status_change 事件: queued → pending, source=manual (UI 静默), reason=manual_dequeue
    const events = getEventsByTaskId(task.id).filter((e) => e.type === "status_change");
    const last = JSON.parse(events[events.length - 1].data);
    expect(last).toMatchObject({
      from: "queued",
      to: "pending",
      source: "manual",
      reason: "manual_dequeue",
    });
  });

  // 🆕 R162: dequeueTask 对非 queued 状态抛错, 防止与 cancel/approve 串改.
  it("dequeueTask on non-queued status throws (status 守门)", () => {
    for (const status of ["pending", "running", "paused", "completed", "cancelled"] as const) {
      const task = makeTask(status);
      const { runtime } = makeRuntime();
      expect(() => runtime.dequeueTask(task.id)).toThrow(
        /Cannot dequeue task in status/,
      );
    }
  });

  // running → paused (via pauseTask)
  it("running → paused (via pauseTask, with session_id)", async () => {
    const task = makeTask("running");
    // makeTask("running") already sets a session_id via needsSession. The
    // leak-fix path preserves it so the task lands in paused (resumable).
    const { runtime } = makeRuntime();
    expect(getTaskById(task.id)?.status).toBe("running");
    expect(getTaskById(task.id)?.session_id).not.toBeNull();

    await runtime.pauseTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("paused");
    expect(getTaskById(task.id)?.session_id).not.toBeNull();
  });

  // running → paused (via pauseTask, no session_id) → failed (leak-fix with no preserved transcript)
  it("running → paused via leak-fix without session_id becomes failed", async () => {
    const task = makeTask("running");
    // Force-clear session_id so the leak-fix branch hits the "no preserved
    // session_id" sub-branch (matches Paused-before-SDK-session_id case).
    updateTask(task.id, { session_id: null as any });
    const { runtime } = makeRuntime();
    await runtime.pauseTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("failed");
    expect(getTaskById(task.id)?.error).toMatch(/Paused before SDK session_id/);
  });

  // paused (already) → pauseTask is idempotent no-op
  it("pauseTask on already-paused task is idempotent no-op", async () => {
    const task = makeTask("paused");
    const before = getTaskById(task.id)!;
    const { runtime } = makeRuntime();
    await expect(runtime.pauseTask(task.id)).resolves.toBeUndefined();
    const after = getTaskById(task.id)!;
    expect(after.status).toBe("paused");
    // No spurious status_change event from the no-op.
    expect(after.completed_at).toBe(before.completed_at);
  });

  // terminal state + no session → pauseTask no-op (warns but doesn't throw)
  for (const terminal of ["reviewing", "completed", "failed", "cancelled", "rejected"] as const) {
    it(`pauseTask on ${terminal} task with no session is no-op`, async () => {
      const task = makeTask(terminal);
      const { runtime } = makeRuntime();
      await expect(runtime.pauseTask(task.id)).resolves.toBeUndefined();
      expect(getTaskById(task.id)?.status).toBe(terminal);
    });
  }

  // pauseTask on a non-existent task → throws
  it("pauseTask on unknown task throws", async () => {
    const { runtime } = makeRuntime();
    await expect(runtime.pauseTask("00000000-0000-0000-0000-000000000000"))
      .rejects.toThrow(/Task .* not found/);
  });

  // cancelTask on a cancelled task with no session is idempotent (no completed_at refresh)
  it("cancelTask on already-cancelled task is idempotent", async () => {
    const task = makeTask("cancelled");
    const before = getTaskById(task.id)!;
    const { runtime } = makeRuntime();
    await expect(runtime.cancelTask(task.id)).resolves.toBeUndefined();
    const after = getTaskById(task.id)!;
    expect(after.status).toBe("cancelled");
    // No spurious completed_at refresh (this was the regression: every
    // page-reload retry of cancel overwrote the timestamp).
    expect(after.completed_at).toBe(before.completed_at);
  });

  // running → cancelled (via cancelTask)
  it("running → cancelled (via cancelTask)", async () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");

    await runtime.cancelTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  // paused → running (via resumeTask)
  it("paused → running (via resumeTask)", () => {
    const task = makeTask("paused");
    const { runtime, resolve } = makeRuntime();
    runtime.resumeTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  // paused -> running via startTask MUST use "resume" mode, not "start".
  // The UI "恢复执行" button calls /start (startTask), so if startTask
  // picked "start" mode for a paused task the SDK would create a brand-new
  // session and the transcript history would be lost. Regression test.
  it("paused via startTask uses resume mode (preserves transcript)", () => {
    const task = makeTask("paused"); // has session_id
    const modes: RunMode[] = [];
    const runtime = new AgentRuntime();
    const scheduler = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
    scheduler.setRunner((_task: Task, mode: RunMode) => {
      modes.push(mode);
      return new Promise<void>(() => {}); // hang - keep task "running"
    });
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    expect(modes).toEqual(["resume"]);
  });

  // paused → cancelled (via cancelTask)
  it("paused → cancelled (via cancelTask)", async () => {
    const task = makeTask("paused");
    const { runtime } = makeRuntime();
    await runtime.cancelTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  // reviewing → completed (via approveTask)
  it("reviewing → completed (via approveTask)", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  // 🆕 R131 (damo 2026-09-15): reviewing → running (via refineTask, 取代旧 rejectTask)
  it("reviewing → running (via refineTask)", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();
    runtime.refineTask(task.id, "needs more work");
    expect(getTaskById(task.id)?.status).toBe("running");

    // Verify refine metadata
    const meta = JSON.parse(getTaskById(task.id)!.metadata!);
    expect(meta.refined_message).toBe("needs more work");
    expect(meta.refined_count).toBe(1);
    expect(meta.last_refined_at).not.toBeNull();
  });

  // 🆕 R131: running → await_user (via awaitTask)
  it("running → await_user (via awaitTask)", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    runtime.awaitTask(task.id, "decision_pending", "等 R88 拍板", "agent");
    expect(getTaskById(task.id)?.status).toBe("await_user");

    const meta = JSON.parse(getTaskById(task.id)!.metadata!);
    expect(meta.await_requested_by).toBe("agent");
    expect(meta.await_reason).toBe("decision_pending");
    expect(meta.await_note).toBe("等 R88 拍板");
    expect(meta.await_requested_at).not.toBeNull();
  });

  // 🆕 R131: await_user → running (via unawaitTask)
  it("await_user → running (via unawaitTask)", () => {
    const task = makeTask("await_user");
    const { runtime } = makeRuntime();
    runtime.unawaitTask(task.id, "agent_self_resolved", undefined, "agent");
    expect(getTaskById(task.id)?.status).toBe("running");

    const meta = JSON.parse(getTaskById(task.id)!.metadata!);
    expect(meta.unawait_requested_by).toBe("agent");
    expect(meta.unawait_reason).toBe("agent_self_resolved");
    expect(meta.await_resolved_by).toBe("unawait:agent_self_resolved");
  });

  // 🆕 R131: await_user → completed (via approveTask, 自动 unwait 透明)
  it("await_user → completed (via approveTask, auto-unwait)", () => {
    const task = makeTask("await_user");
    const { runtime } = makeRuntime();
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");

    // Verify await_user 元数据被清, 留 await_resolved_by 痕迹
    const meta = JSON.parse(getTaskById(task.id)!.metadata!);
    expect(meta.await_resolved_by).toBe("approve");
    expect(meta.await_resolved_at).not.toBeNull();
    expect(meta.await_requested_by).toBeUndefined();
    expect(meta.await_reason).toBeUndefined();
  });

  // failed → running (via startTask)
  it("failed → running (via startTask)", () => {
    const task = makeTask("failed");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  // rejected → running (via startTask, mode=resume) — 历史兼容
  it("rejected → running (via startTask, mode=resume)", () => {
    const task = makeTask("rejected");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  // rejected → completed (via approveTask) — 历史兼容
  it("rejected → completed (via approveTask)", () => {
    const task = makeTask("rejected");
    const { runtime } = makeRuntime();
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  // cancelled → running (via startTask) — now supported
  it("cancelled → running (via startTask)", () => {
    const task = makeTask("cancelled");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  // completed → running (via startTask) — now supported
  it("completed → running (via startTask)", () => {
    const task = makeTask("completed");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });
});

describe("Task status state machine: disallowed transitions (explicit errors)", () => {
  // startTask only allows pending/paused/failed/rejected
  it("startTask rejects from queued", () => {
    const task = makeTask("queued");
    const { runtime } = makeRuntime();
    expect(() => runtime.startTask(task.id)).toThrow(/Cannot start task in status: queued/);
  });

  it("startTask rejects from running", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    expect(() => runtime.startTask(task.id)).toThrow(/Cannot start task in status: running/);
  });

  it("startTask allows from reviewing (resume mode, preserves transcript)", () => {
    const task = makeTask("reviewing");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    resolve({}); // let scheduler run
    const updated = getTaskById(task.id);
    expect(updated?.status).toBe("running");
    // session_id preserved → resume mode
    expect(updated?.session_id).toBe(task.session_id);
  });

  it("restartTask clears session_id and starts fresh (清空重来)", () => {
    const task = makeTask("reviewing");
    const { runtime, resolve } = makeRuntime();
    expect(task.session_id).toBeTruthy();
    runtime.restartTask(task.id);
    resolve({}); // let scheduler run
    const updated = getTaskById(task.id);
    expect(updated?.status).toBe("running");
    // session_id cleared → fresh start
    expect(updated?.session_id).toBeNull();
  });

  it("restartTask rejects from pending", () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    expect(() => runtime.restartTask(task.id)).toThrow(/Cannot restart task in status: pending/);
  });

  it("restartTask rejects from running", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    expect(() => runtime.restartTask(task.id)).toThrow(/Cannot restart task in status: running/);
  });

  it("restartTask rejects from queued", () => {
    const task = makeTask("queued");
    const { runtime } = makeRuntime();
    expect(() => runtime.restartTask(task.id)).toThrow(/Cannot restart task in status: queued/);
  });

  // resumeTask only allows paused
  it("resumeTask rejects from pending", () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: pending/);
  });

  it("resumeTask rejects from running", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: running/);
  });

  it("resumeTask rejects from reviewing", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: reviewing/);
  });

  it("resumeTask rejects from completed", () => {
    const task = makeTask("completed");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: completed/);
  });

  it("resumeTask rejects from failed", () => {
    const task = makeTask("failed");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: failed/);
  });

  it("resumeTask rejects from rejected", () => {
    const task = makeTask("rejected");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: rejected/);
  });

  it("resumeTask rejects from cancelled", () => {
    const task = makeTask("cancelled");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: cancelled/);
  });

  it("resumeTask rejects from queued", () => {
    const task = makeTask("queued");
    const { runtime } = makeRuntime();
    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: queued/);
  });

  // approveTask allows reviewing/rejected/paused
  it("approveTask rejects from pending", () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    expect(() => runtime.approveTask(task.id)).toThrow(/not in reviewing, rejected, paused, or await_user state/);
  });

  it("approveTask rejects from running", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    expect(() => runtime.approveTask(task.id)).toThrow(/not in reviewing, rejected, paused, or await_user state/);
  });

  it("approveTask allows paused -> completed", () => {
    const task = makeTask("paused");
    const { runtime } = makeRuntime();
    expect(() => runtime.approveTask(task.id)).not.toThrow();
    expect(getTaskById(task.id)?.status).toBe("completed");
  });

  it("approveTask rejects from completed", () => {
    const task = makeTask("completed");
    const { runtime } = makeRuntime();
    expect(() => runtime.approveTask(task.id)).toThrow(/not in reviewing, rejected, paused, or await_user state/);
  });

  it("approveTask rejects from failed", () => {
    const task = makeTask("failed");
    const { runtime } = makeRuntime();
    expect(() => runtime.approveTask(task.id)).toThrow(/not in reviewing, rejected, paused, or await_user state/);
  });

  it("approveTask rejects from cancelled", () => {
    const task = makeTask("cancelled");
    const { runtime } = makeRuntime();
    expect(() => runtime.approveTask(task.id)).toThrow(/not in reviewing, rejected, paused, or await_user state/);
  });

  // 🆕 R131 (damo 2026-09-15): refineTask 取代旧 rejectTask. only allows reviewing
  it("refineTask rejects from pending", () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  it("refineTask rejects from running", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  it("refineTask rejects from paused", () => {
    const task = makeTask("paused");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  it("refineTask rejects from await_user", () => {
    const task = makeTask("await_user");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  it("refineTask rejects from completed", () => {
    const task = makeTask("completed");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  it("refineTask rejects from failed", () => {
    const task = makeTask("failed");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  // 🆕 R131: awaitTask only allows running
  it("awaitTask rejects from reviewing", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();
    expect(() => runtime.awaitTask(task.id, "decision_pending")).toThrow(/not in running state/);
  });

  it("awaitTask rejects from paused", () => {
    const task = makeTask("paused");
    const { runtime } = makeRuntime();
    expect(() => runtime.awaitTask(task.id, "decision_pending")).toThrow(/not in running state/);
  });

  // 🆕 R131: unawaitTask only allows await_user
  it("unawaitTask rejects from running", () => {
    const task = makeTask("running");
    const { runtime } = makeRuntime();
    expect(() => runtime.unawaitTask(task.id, "agent_self_resolved")).toThrow(/not in await_user state/);
  });

  it("unawaitTask rejects from reviewing", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();
    expect(() => runtime.unawaitTask(task.id, "agent_self_resolved")).toThrow(/not in await_user state/);
  });

  it("refineTask rejects from cancelled", () => {
    const task = makeTask("cancelled");
    const { runtime } = makeRuntime();
    expect(() => runtime.refineTask(task.id, "feedback")).toThrow(/not in reviewing state/);
  });

  // completed is an absolute terminal state — nothing can move it
  it("completed: resume/approve/refine fail, but start succeeds (reactivation)", () => {
    const task = makeTask("completed");
    const { runtime, resolve } = makeRuntime();

    // startTask now allows completed (reactivation)
    expect(() => runtime.startTask(task.id)).not.toThrow();
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  it("completed: other operations still fail", () => {
    const task = makeTask("completed");
    const { runtime } = makeRuntime();

    expect(() => runtime.resumeTask(task.id)).toThrow(/Cannot resume task in status: completed/);
    expect(() => runtime.approveTask(task.id)).toThrow(/not in reviewing, rejected, paused, or await_user state/);
    expect(() => runtime.refineTask(task.id, "f")).toThrow(/not in reviewing state/);
  });
});

describe("Task status state machine: cancelTask from any status", () => {
  // cancelTask has no source-status guard — it can cancel from ANY status.
  // This is a deliberate design choice (cancel is the universal "stop" button).
  const testableStatuses: TaskStatus[] = [
    "pending", "queued", "paused", "reviewing",
    "completed", "failed", "rejected",
  ];

  for (const status of testableStatuses) {
    it(`cancelTask succeeds from ${status}`, async () => {
      const task = makeTask(status);
      const { runtime } = makeRuntime();
      await runtime.cancelTask(task.id);
      expect(getTaskById(task.id)?.status).toBe("cancelled");
      expect(getTaskById(task.id)?.completed_at).not.toBeNull();
    });
  }

  it("cancelTask from running (with active session)", async () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    await runtime.cancelTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
  });
});

describe("Task status state machine: default parameters on transitions", () => {
  it("→ running sets started_at", () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();
    expect(getTaskById(task.id)?.started_at).toBeNull();

    runtime.startTask(task.id);
    const updated = getTaskById(task.id)!;
    expect(updated.status).toBe("running");
    expect(updated.started_at).not.toBeNull();
    resolve(task.id);
  });

  it("→ cancelled sets completed_at", async () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    expect(getTaskById(task.id)?.completed_at).toBeNull();

    await runtime.cancelTask(task.id);
    const updated = getTaskById(task.id)!;
    expect(updated.status).toBe("cancelled");
    expect(updated.completed_at).not.toBeNull();
  });

  it("→ completed (via approve) sets completed_at", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();

    runtime.approveTask(task.id);
    const updated = getTaskById(task.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).not.toBeNull();
  });

  it("🆕 R131: → running (via refine) sets metadata.refined_message/refined_count/last_refined_at", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();

    runtime.refineTask(task.id, "code quality issues");
    const updated = getTaskById(task.id)!;
    expect(updated.status).toBe("running");

    const meta = JSON.parse(updated.metadata!);
    expect(meta.refined_message).toBe("code quality issues");
    expect(meta.refined_count).toBe(1); // first refine
    expect(meta.last_refined_at).not.toBeNull();
  });

  it("🆕 R131: → running (via refine) increments refined_count on repeated refine cycles", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();

    // First refine
    runtime.refineTask(task.id, "first issue");
    expect(JSON.parse(getTaskById(task.id)!.metadata!).refined_count).toBe(1);

    // Manually move back to reviewing (simulating agent re-completing)
    updateTaskStatus(task.id, "reviewing");

    // Second refine
    runtime.refineTask(task.id, "second issue");
    expect(JSON.parse(getTaskById(task.id)!.metadata!).refined_count).toBe(2);
  });

  it("all transitions update updated_at", async () => {
    const task = makeTask("pending");
    const before = getTaskById(task.id)!.updated_at;

    // SQLite datetime('now') has second precision; wait long enough
    await new Promise((r) => setTimeout(r, 1100));

    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    const after = getTaskById(task.id)!.updated_at;
    expect(after).not.toBe(before);
    resolve(task.id);
  });
});

describe("Task status state machine: status_change events are recorded", () => {
  it("startTask records pending → queued → running events", () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);

    const events = getEventsByTaskId(task.id)
      .filter((e) => e.type === "status_change")
      .map((e) => JSON.parse(e.data) as { from: string; to: string });

    // With concurrency available, the scheduler runs synchronously:
    // pending → queued → running (both events recorded)
    const hasQueued = events.some((e) => e.to === "queued");
    const hasRunning = events.some((e) => e.to === "running");
    expect(hasQueued || hasRunning).toBe(true);
    expect(hasRunning).toBe(true);

    resolve(task.id);
  });

  it("cancelTask records * → cancelled event", async () => {
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    await runtime.cancelTask(task.id);

    const events = getEventsByTaskId(task.id)
      .filter((e) => e.type === "status_change")
      .map((e) => JSON.parse(e.data) as { from: string; to: string });

    expect(events.some((e) => e.to === "cancelled")).toBe(true);
  });

  it("approveTask records reviewing → completed event", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();
    runtime.approveTask(task.id);

    const events = getEventsByTaskId(task.id)
      .filter((e) => e.type === "status_change")
      .map((e) => JSON.parse(e.data) as { from: string; to: string });

    expect(events).toContainEqual({ from: "reviewing", to: "completed" });
  });

  it("🆕 R131: refineTask records reviewing → queued event when no active session (re-enqueues via scheduler)", () => {
    const task = makeTask("reviewing");
    const { runtime, resolve } = makeRuntime();
    runtime.refineTask(task.id, "bad");

    const events = getEventsByTaskId(task.id)
      .filter((e) => e.type === "status_change")
      .map((e) => JSON.parse(e.data) as { from: string; to: string; reason?: string });

    // Bugfix 2026-09-17 (task 5f5d90a5): refineTask used to flip status to
    // "running" without enqueuing — task stuck in "running" forever with
    // no agent to consume the pending message. Now it routes through
    // startTask() which has scheduler emit "reviewing → queued (refined)".
    expect(events).toContainEqual({ from: "reviewing", to: "queued", reason: "refined" });
    resolve(task.id);
  });

  it("🆕 R131 bugfix: refineTask queues the message so the resumed session drains it (no stranded 'running')", () => {
    const task = makeTask("reviewing");
    const { runtime, resolve } = makeRuntime();
    runtime.refineTask(task.id, "wrap-up please");

    // Message must be queued for the resumed session to drain.
    expect(peekPendingMessages(task.id)).toEqual(["wrap-up please"]);

    // Refined metadata recorded.
    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata || "{}");
    expect(meta.refined_by).toBe("damo");
    expect(meta.refined_count).toBe(1);
    expect(meta.refined_message).toBe("wrap-up please");

    // Status transitioned to queued by scheduler.enqueue (not "running").
    // If scheduler immediately picked it up it'd be "running" — accept both.
    expect(["queued", "running"]).toContain(after.status);
    resolve(task.id);
  });

  it("resumeTask records paused → queued → running events (R11: visible queue signal even when slot is busy)", () => {
    const task = makeTask("paused");
    const { runtime, resolve } = makeRuntime();
    runtime.resumeTask(task.id);

    const events = getEventsByTaskId(task.id)
      .filter((e) => e.type === "status_change")
      .map((e) => JSON.parse(e.data) as { from: string; to: string });

    // R11 fix: paused is now flipped to "queued" synchronously in enqueue(),
    // then "running" when the scheduler actually picks it up. This is what
    // makes the UI show a queue signal when the slot is busy; without it the
    // task stays "paused" in the UI and the user thinks resume did nothing.
    expect(events.some((e) => e.from === "paused" && e.to === "queued")).toBe(true);
    expect(events.some((e) => e.from === "queued" && e.to === "running")).toBe(true);
    resolve(task.id);
  });
});

describe("Task status state machine: full lifecycle paths", () => {
  it("happy path: pending → running → reviewing → completed", async () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();

    // Start
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
    await tick();

    // Simulate agent natural completion → reviewing
    updateTaskStatus(task.id, "reviewing", {
      result: "all done",
      completed_at: new Date().toISOString(),
    });

    // Approve
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");
    expect(getTaskById(task.id)?.completed_at).not.toBeNull();
  });

  it("reject-rework path: pending → running → reviewing → rejected → running → reviewing → completed", async () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();

    // Start
    runtime.startTask(task.id);
    resolve(task.id);
    await tick();

    // Agent completes → reviewing
    updateTaskStatus(task.id, "reviewing", {
      result: "first attempt",
      completed_at: new Date().toISOString(),
    });

    // Refine (reviewing → queued → running) 取代旧 reject
    runtime.refineTask(task.id, "needs fixes");
    // After bugfix: scheduler flipped to "queued" (or picked it up immediately
    // → "running"). Accept both. resolve() below drains the hanging runner.
    expect(["queued", "running"]).toContain(getTaskById(task.id)?.status);

    // Re-start (refined → queued → running) — scheduler 跑完一轮后 agent 接着改
    resolve(task.id);
    await tick();

    // Agent re-completes → reviewing
    updateTaskStatus(task.id, "reviewing", {
      result: "fixed version",
      completed_at: new Date().toISOString(),
    });

    // Approve
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");
  });

  it("fail-retry path: pending → running → failed → running", async () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();

    // Start
    runtime.startTask(task.id);
    resolve(task.id);
    await tick();

    // Simulate failure
    updateTaskStatus(task.id, "failed", {
      error: "something broke",
      completed_at: new Date().toISOString(),
    });
    expect(getTaskById(task.id)?.status).toBe("failed");

    // Retry
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  it("cancel-restart path: pending → cancelled → running", async () => {
    const task = makeTask("pending");
    const { runtime, resolve } = makeRuntime();

    // Cancel
    await runtime.cancelTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("cancelled");

    // Restart from cancelled — now supported
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });

  it("completed-reactivate path: completed → running → reviewing → completed", async () => {
    const task = makeTask("completed");
    const { runtime, resolve } = makeRuntime();

    // Reactivate from completed
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
    await tick();

    // Agent re-completes → reviewing
    updateTaskStatus(task.id, "reviewing", {
      result: "improved version",
      completed_at: new Date().toISOString(),
    });

    // Approve again
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");
  });

  it("skip approve path: rejected → completed (direct approve without re-running)", () => {
    const task = makeTask("rejected");
    const { runtime } = makeRuntime();

    // 历史 rejected task 可直接 approve (operator changes mind)
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");
  });
});

describe("Task status state machine: dependency gates", () => {
  it("startTask blocks when dependencies are unmet", () => {
    const dep = makeTask("pending"); // dependency not completed
    const task = createTask({
      title: "blocked",
      prompt: "p",
      project_id: projectId,
      dependsOn: [dep.id],
    });

    const { runtime } = makeRuntime();
    expect(() => runtime.startTask(task.id)).toThrow(/Dependencies not met/);
  });

  it("startTask proceeds when dependencies are completed", () => {
    const dep = makeTask("completed");
    const task = createTask({
      title: "unblocked",
      prompt: "p",
      project_id: projectId,
      dependsOn: [dep.id],
    });

    const { runtime, resolve } = makeRuntime();
    runtime.startTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");
    resolve(task.id);
  });
});

describe("Task status state machine: server restart recovery", () => {
  it("running → paused on server restart (orphan recovery)", () => {
    const task = makeTask("running");
    // Simulate what recoverOrphanedTasks does
    updateTaskStatus(task.id, "paused", {
      session_id: task.session_id || undefined,
    });
    insertEvent({
      task_id: task.id,
      type: "status_change",
      data: JSON.stringify({ from: "running", to: "paused", reason: "server_restart" }),
    });
    expect(getTaskById(task.id)?.status).toBe("paused");
  });

  it("queued → pending on server restart (orphan recovery)", () => {
    const task = makeTask("queued");
    updateTaskStatus(task.id, "pending");
    insertEvent({
      task_id: task.id,
      type: "status_change",
      data: JSON.stringify({ from: "queued", to: "pending", reason: "server_restart" }),
    });
    expect(getTaskById(task.id)?.status).toBe("pending");
  });
});

describe("Task status state machine: sendUserMessage auto-activation from terminal states", () => {
  const terminalStatuses: TaskStatus[] = ["completed", "failed", "cancelled", "rejected"];

  for (const status of terminalStatuses) {
    it(`sendUserMessage from ${status} auto-starts task and queues message`, () => {
      const task = makeTask(status);
      const { runtime, resolve } = makeRuntime();

      // sendUserMessage should auto-activate the task
      runtime.sendUserMessage(task.id, `reactivate from ${status}`);

      // Task should now be running (or queued if concurrency is full)
      const updated = getTaskById(task.id)!;
      expect(["running", "queued"]).toContain(updated.status);

      // Verify a queued message event was recorded
      const events = getEventsByTaskId(task.id)
        .filter((e) => e.type === "message")
        .map((e) => JSON.parse(e.data) as { role: string; text: string; queued?: boolean });
      expect(events.some((e) => e.role === "user" && e.queued === true && e.text.includes(`reactivate from ${status}`))).toBe(true);

      resolve(task.id);
    });
  }

  it("sendUserMessage from pending (no session_id) 缓存不拉起 (damo 2026-10-31 改)", () => {
    // 旧行为 throw「请先启动」; 现改为缓存进 metadata.pending_messages,
    // 任务保持 pending (不自动拉起), 启动时由 start() drain 投递.
    const task = makeTask("pending");
    const { runtime } = makeRuntime();
    expect(() => runtime.sendUserMessage(task.id, "hello")).not.toThrow();
    const updated = getTaskById(task.id)!;
    expect(updated.status).toBe("pending");
    expect(peekPendingMessages(task.id)).toEqual(["hello"]);
    // transcript 有 queued 标记事件 (UI 显示已排队)
    const events = getEventsByTaskId(task.id)
      .filter((e) => e.type === "message")
      .map((e) => JSON.parse(e.data) as { role: string; text: string; queued?: boolean });
    expect(events.some((e) => e.role === "user" && e.queued === true && e.text === "hello")).toBe(true);
  });

  it("sendUserMessage from queued (no session_id) 缓存不拉起 (damo 2026-10-31 改)", () => {
    const task = makeTask("queued");
    const { runtime } = makeRuntime();
    expect(() => runtime.sendUserMessage(task.id, "hello")).not.toThrow();
    const updated = getTaskById(task.id)!;
    expect(updated.status).toBe("queued");
    expect(peekPendingMessages(task.id)).toEqual(["hello"]);
  });

  it("sendUserMessage from completed without session_id still throws", () => {
    // Edge case: completed task with no session_id (shouldn't happen normally)
    const task = makeTask("completed");
    updateTask(task.id, { session_id: null as any }); // clear session_id
    const { runtime } = makeRuntime();
    expect(() => runtime.sendUserMessage(task.id, "hello")).toThrow(/No active session/);
  });
});

// Regression: messages that arrive during a session's teardown window
// (closed=true but not yet removed from runtime.sessions) must be routed to the
// durable pending_messages queue and auto-drained when the task finishes,
// not lost in a dead in-memory queue.
describe("Stranded message drain on session teardown", () => {
  it("peekPendingMessages reads without clearing", () => {
    const task = makeTask("reviewing");
    queuePendingMessage(task.id, "msg-a");
    queuePendingMessage(task.id, "msg-b");

    expect(peekPendingMessages(task.id)).toEqual(["msg-a", "msg-b"]);
    // Peek again - still there (not cleared)
    expect(peekPendingMessages(task.id)).toEqual(["msg-a", "msg-b"]);

    // Drain clears
    expect(drainPendingMessages(task.id)).toEqual(["msg-a", "msg-b"]);
    expect(peekPendingMessages(task.id)).toEqual([]);
  });

  it("maybeDrainStrandedMessages re-enqueues a terminal task with pending messages", async () => {
    const task = makeTask("reviewing");
    queuePendingMessage(task.id, "stranded-1");
    const { runtime, resolve } = makeRuntime();

    // Simulate the onTaskDone hook firing after the task finished to reviewing.
    (runtime as unknown as { maybeDrainStrandedMessages: (id: string) => void })
      .maybeDrainStrandedMessages(task.id);

    // Auto-resume was triggered -> task left the terminal state.
    const updated = getTaskById(task.id)!;
    expect(["queued", "running"]).toContain(updated.status);

    resolve(task.id);
    await tick();
  });

  it("maybeDrainStrandedMessages is a no-op when there are no pending messages", () => {
    const task = makeTask("reviewing");
    const { runtime } = makeRuntime();

    (runtime as unknown as { maybeDrainStrandedMessages: (id: string) => void })
      .maybeDrainStrandedMessages(task.id);

    // No pending messages -> no re-enqueue -> stays reviewing.
    expect(getTaskById(task.id)?.status).toBe("reviewing");
  });

  it("maybeDrainStrandedMessages is a no-op for non-terminal (running) status", () => {
    const task = makeTask("running");
    queuePendingMessage(task.id, "should-not-drain-yet");
    const { runtime } = makeRuntime();

    (runtime as unknown as { maybeDrainStrandedMessages: (id: string) => void })
      .maybeDrainStrandedMessages(task.id);

    // running tasks are drained by the normal in-flight flow, not by this hook.
    expect(getTaskById(task.id)?.status).toBe("running");
  });
});
