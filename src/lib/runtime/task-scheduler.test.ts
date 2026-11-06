import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Mock the Claude Agent SDK so forkSession() can run end-to-end without a live
// session or API key. Only forkSession + getSessionMessages are actually
// called (the runner is replaced below, so query() is never invoked); query is
// stubbed purely to satisfy the module's runtime exports.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(async () => ({ sessionId: "forked-sess-id" })),
  getSessionMessages: vi.fn(async () => [{ uuid: "msg-1", role: "user" }]),
  query: vi.fn(),
}));

import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task, TaskStatus } from "./types";
import { AgentRuntime } from "./agent-runtime";
import { getDb, closeDb } from "../db";
import { createProject, updateProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus, deleteTask } from "../db/tasks";
import { insertEvent, getEventsByTaskId } from "../db/events";
import { createUser, setUserMaxConcurrency } from "../db/users";

// These tests cover the fork status-ordering regression: forkSession() must
// insert its "pending -> paused" status_change event BEFORE calling
// scheduler.enqueue(), because enqueue() runs the scheduler synchronously up
// to the status flip and emits "paused -> running" first. If the manual event
// is inserted after enqueue, it lands with a higher DB id, so SSE history
// replay (ORDER BY id ASC) ends on "paused" and the UI shows resume/restart
// buttons for a task that is actually running.
//
// We exercise the real TaskScheduler + real SQLite + real event persistence.
// Only the task runner is faked (we never call the Claude SDK here).

let tmpDir: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // run migrations against the fresh temp DB
  projectId = createProject({ name: "test-project" }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mimics AgentRuntime.emitEvent's persistence of status_change events.
function recordStatusChange(taskId: string, from: TaskStatus, to: TaskStatus): void {
  insertEvent({
    task_id: taskId,
    type: "status_change",
    data: JSON.stringify({ from, to }),
  });
}

// Mirrors the client-side SSE history replay (task-detail-client.tsx):
// iterate events in id ASC order, applying the last `to` as the status.
function replayFinalStatus(taskId: string): TaskStatus {
  const events = getEventsByTaskId(taskId); // ORDER BY id ASC
  let status: TaskStatus = "pending";
  for (const e of events) {
    if (e.type === "status_change") {
      const data = JSON.parse(e.data);
      if (data.to) status = data.to as TaskStatus;
    }
  }
  return status;
}

// A runner that never resolves on its own, so the task stays "running" for the
// duration of the test (the SDK path that would eventually complete it is
// absent). We don't care about completion here, only the synchronous enqueue.
function hangingRunner(): { run: (task: Task, mode: RunMode) => Promise<void>; resolve: () => void } {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    run: () => promise,
    resolve: resolveFn,
  };
}

describe("TaskScheduler.enqueue synchronous status flip", () => {
  it("flips a paused task through queued to running and emits both transitions before enqueue returns", () => {
    const task = createTask({ title: "t", prompt: "p", project_id: projectId });
    updateTaskStatus(task.id, "paused", { session_id: "sess-1" });

    const calls: Array<{ id: string; from: TaskStatus; to: TaskStatus }> = [];
    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((id, from, to) => {
      calls.push({ id, from, to });
      recordStatusChange(id, from, to);
    });
    const runner = hangingRunner();
    scheduler.setRunner(runner.run);

    // enqueue must complete the paused->queued->running transitions synchronously
    // (R11 fix: paused now flips to queued first so the UI shows a queue signal
    // even when the slot is busy — see "resume queued while same-cwd busy" below).
    scheduler.enqueue(task.id, "fork");
    runner.resolve();

    expect(getTaskById(task.id)?.status).toBe("running");
    expect(calls).toContainEqual({ id: task.id, from: "paused", to: "queued" });
    expect(calls).toContainEqual({ id: task.id, from: "queued", to: "running" });
  });

  // R11 regression: resuming a paused task whose cwd is held by another running
  // task used to leave the DB row at "paused" while the scheduler silently
  // held it in its in-memory queue. The UI kept showing "已暂停▶" with no
  // queued signal and the user read it as "resume did nothing". Now the paused
  // status flips to "queued" synchronously in enqueue(), so the UI reflects
  // "排队中" until the slot frees; the runner then picks it up and flips
  // queued -> running.
  it("resume queued while same-cwd busy: paused flips to queued, then runs when slot frees", async () => {
    const projectCwd = `/tmp/orch-r11-${Date.now()}`;
    const project = createProject({ name: "r11-same-cwd", cwd: projectCwd });
    const sibling = createTask({ title: "sibling-running", prompt: "p", project_id: project.id });
    const resumed = createTask({ title: "resumed", prompt: "p", project_id: project.id });
    updateTaskStatus(resumed.id, "paused", { session_id: "sess-resumed" });

    const calls: Array<{ id: string; from: TaskStatus; to: TaskStatus }> = [];
    const scheduler = new TaskScheduler(1); // global cap = 1, matches project's parallel_limit (default 1)
    scheduler.setStatusChangeHandler((id, from, to) => {
      calls.push({ id, from, to });
      recordStatusChange(id, from, to);
    });
    // Sibling occupies the slot (its runner hangs until we resolve it).
    // Resumed task should NOT be picked up while sibling is running.
    let resolveSibling!: () => void;
    const siblingPromise = new Promise<void>((r) => { resolveSibling = r; });
    const resumeStarted: Array<{ id: string; mode: RunMode }> = [];
    scheduler.setRunner((task, mode) => {
      if (task.id === sibling.id) return siblingPromise;
      resumeStarted.push({ id: task.id, mode });
      return new Promise<void>(() => {}); // hang on the resumed task
    });

    // Step 1: enqueue sibling normally so the scheduler actually claims the
    // slot (busyCwds + running set). Manually flipping the DB row to "running"
    // doesn't occupy the in-memory cwd lock — schedule() won't see it.
    scheduler.enqueue(sibling.id, "start");
    expect(getTaskById(sibling.id)?.status).toBe("running");

    // Step 2: resume the paused task. With R11's bug, the DB row stayed at
    // "paused" while the scheduler held it silently in queue[]. Now it flips
    // to "queued" so the UI shows the queue signal.
    scheduler.enqueue(resumed.id, "resume");

    expect(getTaskById(resumed.id)?.status).toBe("queued");
    expect(resumeStarted).toEqual([]);
    expect(scheduler.getQueue()).toContain(resumed.id);
    expect(calls).toContainEqual({ id: resumed.id, from: "paused", to: "queued" });

    // Step 3: free the sibling's slot. schedule() should pick up the resumed task.
    resolveSibling();
    await new Promise((r) => setImmediate(r)); // let onTaskDone -> schedule -> runTask settle

    expect(getTaskById(resumed.id)?.status).toBe("running");
    expect(resumeStarted).toEqual([{ id: resumed.id, mode: "resume" }]);
    expect(calls).toContainEqual({ id: resumed.id, from: "queued", to: "running" });
  });
});

describe("fork event ordering regression", () => {
  it("replays to 'running' when pending->paused is inserted before enqueue (post-fix)", () => {
    const task = createTask({ title: "fork", prompt: "p", project_id: projectId });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((id, from, to) => recordStatusChange(id, from, to));
    const runner = hangingRunner();
    scheduler.setRunner(runner.run);

    // Reproduce forkSession()'s post-fix ordering exactly.
    updateTaskStatus(task.id, "paused", {
      session_id: "sess-new",
      forked_from_session_id: "parent-sess",
    });
    insertEvent({
      task_id: task.id,
      session_id: "sess-new",
      type: "status_change",
      data: JSON.stringify({ from: "pending", to: "paused", reason: "fork_created" }),
    });
    scheduler.enqueue(task.id, "fork");
    runner.resolve();

    // The DB row is running...
    expect(getTaskById(task.id)?.status).toBe("running");
    // ...and so is the status derived from replaying events in id order.
    expect(replayFinalStatus(task.id)).toBe("running");

    // Explicitly: the pending->paused event must precede paused->running.
    const statusChanges = getEventsByTaskId(task.id)
      .filter((e) => e.type === "status_change")
      .map((e) => JSON.parse(e.data) as { from: string; to: string });
    const pausedIdx = statusChanges.findIndex((e) => e.to === "paused");
    const runningIdx = statusChanges.findIndex((e) => e.to === "running");
    expect(pausedIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(pausedIdx).toBeLessThan(runningIdx);
  });

  it("replays to 'paused' (the bug) when pending->paused is inserted after enqueue", () => {
    // This test documents the pre-fix behavior so the regression stays
    // understandable: reversing the order reproduces the bug the fix prevents.
    const task = createTask({ title: "fork-bad", prompt: "p", project_id: projectId });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((id, from, to) => recordStatusChange(id, from, to));
    const runner = hangingRunner();
    scheduler.setRunner(runner.run);

    updateTaskStatus(task.id, "paused", { session_id: "sess-new" });
    // BROKEN order: enqueue (emits paused->running) BEFORE the manual event.
    scheduler.enqueue(task.id, "fork");
    insertEvent({
      task_id: task.id,
      session_id: "sess-new",
      type: "status_change",
      data: JSON.stringify({ from: "pending", to: "paused", reason: "fork_created" }),
    });
    runner.resolve();

    // DB row is running, but replay ends on paused - exactly the bug.
    expect(getTaskById(task.id)?.status).toBe("running");
    expect(replayFinalStatus(task.id)).toBe("paused");
  });
});

describe("AgentRuntime.forkSession event ordering (end-to-end)", () => {
  it("replays to 'running' after a real forkSession() call", async () => {
    // Build a completed parent task with a session to fork from.
    const parent = createTask({ title: "parent", prompt: "do work", project_id: projectId });
    updateTaskStatus(parent.id, "completed", { session_id: "parent-sess-id" });

    // Use a fresh runtime (not the singleton) so scheduler state is isolated.
    const rt = new AgentRuntime();
    // Replace the runner so the real runTask()/ActiveSession (which would call
    // the SDK) never runs. The scheduler still does its real synchronous status
    // flip + emitEvent -> insertEvent, which is exactly what the fix depends on.
    const runner = hangingRunner();
    // Access the private scheduler to swap in a fake runner (the real runner
    // would spin up ActiveSession and call the SDK). Cast through unknown since
    // the field is private; this is a test-only escape hatch.
    (rt as unknown as { scheduler: TaskScheduler }).scheduler.setRunner(runner.run);

    const result = await rt.forkSession(parent.id, {});
    runner.resolve();

    // The forked task is actually running in the DB...
    expect(getTaskById(result.newTaskId)?.status).toBe("running");
    // ...and replaying its events in id order also lands on running, not paused.
    expect(replayFinalStatus(result.newTaskId)).toBe("running");
  });
});

// Cwd mutual exclusion: tasks sharing a working directory serialize, tasks on
// distinct cwd run in parallel. Guards against two agents editing/git-committing
// in the same tree at once (see task-scheduler.ts header comment).
describe("TaskScheduler cwd mutual exclusion", () => {
  // Build a controllable runner: each task gets its own hanging promise we can
  // resolve to mark that task "done". Returns the run fn plus a map of
  // taskId -> resolve, so a test can release specific tasks in order.
  function controllableRunner() {
    const resolvers = new Map<string, () => void>();
    const run = (task: Task, _mode: RunMode): Promise<void> =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      });
    return { run, resolvers };
  }

  // Let the scheduler's async tail (runTask finally -> onTaskDone -> schedule)
  // drain before asserting. Resolving a runner promise schedules onTaskDone as
  // a microtask; a setTimeout(0) gate ensures it has run before we read state.
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("serializes two tasks sharing the same cwd", async () => {
    const sharedCwd = path.join(tmpDir, "repo-a");
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId, cwd: sharedCwd });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId, cwd: sharedCwd });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((_id, _from, _to) => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");

    // t1 runs immediately; t2 must wait because the shared cwd is held.
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("queued");

    // Releasing t1 frees the cwd; schedule() picks up t2.
    runner.resolvers.get(t1.id)!();
    await tick();
    expect(getTaskById(t2.id)?.status).toBe("running");

    // Cleanup: let t2 finish so the scheduler drains.
    runner.resolvers.get(t2.id)!();
    await tick();
  });

  it("runs tasks on distinct cwd in parallel", async () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId, cwd: path.join(tmpDir, "repo-a") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId, cwd: path.join(tmpDir, "repo-b") });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((_id, _from, _to) => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");

    // Different cwd -> both run concurrently.
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("running");

    runner.resolvers.get(t1.id)!();
    runner.resolvers.get(t2.id)!();
    await tick();
  });

  it("releases the cwd lock when a running task is cancelled via close() path", async () => {
    // The cancel/pause path doesn't call onTaskDone directly - it relies on
    // session.close() making the runner promise settle, which hits runTask's
    // finally -> onTaskDone. We simulate that by settling the runner promise
    // (any settlement triggers finally). Verify the freed cwd lets the queued
    // task proceed.
    const sharedCwd = path.join(tmpDir, "repo-c");
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId, cwd: sharedCwd });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId, cwd: sharedCwd });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((_id, _from, _to) => {});
    // Runner that hangs until we manually settle - settling (resolve or reject)
    // mimics what session.close() does to the real runner.
    const resolvers = new Map<string, () => void>();
    scheduler.setRunner((task: Task, _mode: RunMode) =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      }),
    );

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    expect(getTaskById(t2.id)?.status).toBe("queued");

    // Settle t1 (as if close() ended the runner) -> onTaskDone fires -> cwd freed.
    resolvers.get(t1.id)!();
    await tick();
    expect(getTaskById(t2.id)?.status).toBe("running");

    resolvers.get(t2.id)!();
    await tick();
  });

  it("releases the cwd lock when a running task is soft-deleted mid-run (2026-08-25 regression)", async () => {
    // 事故回放: 861cf38a running 途中被软删(deleted_at 置位), runner 跑完后
    // onTaskDone -> doRelease 的 getTaskById 默认过滤软删行, 拿到 null ->
    // busyCwds 摘不掉 -> 同项目后续任务永远 queued 不出队. 修复后 doRelease
    // 用 includeDeleted 读行, cwd 锁照常释放.
    const sharedCwd = path.join(tmpDir, "repo-d");
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId, cwd: sharedCwd });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId, cwd: sharedCwd });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((_id, _from, _to) => {});
    const resolvers = new Map<string, () => void>();
    scheduler.setRunner((task: Task, _mode: RunMode) =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      }),
    );

    scheduler.enqueue(t1.id, "start");
    expect(getTaskById(t1.id)?.status).toBe("running");

    // t1 在 running 途中被软删.
    deleteTask(t1.id);

    // t2 入队, 此时 t1 还占着 cwd -> 排队.
    scheduler.enqueue(t2.id, "start");
    expect(getTaskById(t2.id)?.status).toBe("queued");

    // t1 的 runner 结束 -> onTaskDone -> doRelease 必须连软删行一起认,
    // 释放 cwd, t2 得以出队.
    resolvers.get(t1.id)!();
    await tick();
    expect(getTaskById(t2.id)?.status).toBe("running");

    resolvers.get(t2.id)!();
    await tick();
  });

  it("lets a task with a free cwd skip past a blocked higher-priority peer", async () => {
    // Queue: B (cwd=/shared, can't run while A holds /shared), C (cwd=/other,
    // free). C should run without waiting for B, since B can't run anyway.
    const sharedCwd = path.join(tmpDir, "repo-shared");
    const otherCwd = path.join(tmpDir, "repo-other");
    const a = createTask({ title: "a", prompt: "p", project_id: projectId, cwd: sharedCwd });
    const b = createTask({ title: "b", prompt: "p", project_id: projectId, cwd: sharedCwd });
    const c = createTask({ title: "c", prompt: "p", project_id: projectId, cwd: otherCwd });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler((_id, _from, _to) => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(a.id, "start");
    scheduler.enqueue(b.id, "start");
    scheduler.enqueue(c.id, "start");

    // a holds /shared; b is blocked on /shared; c's cwd is free -> c runs.
    expect(getTaskById(a.id)?.status).toBe("running");
    expect(getTaskById(b.id)?.status).toBe("queued");
    expect(getTaskById(c.id)?.status).toBe("running");

    runner.resolvers.get(a.id)!();
    runner.resolvers.get(c.id)!();
    await tick();
    // Now b can run (a released /shared).
    expect(getTaskById(b.id)?.status).toBe("running");
    runner.resolvers.get(b.id)!();
    await tick();
  });
});

// Per-owner concurrency cap (v30): a single account may run at most
// users.max_concurrency tasks at once, independent of the global cap. NULL
// owner (system/legacy tasks) and NULL cap (unlimited) are never gated.
describe("TaskScheduler per-owner concurrency cap (v30)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function controllableRunner() {
    const resolvers = new Map<string, () => void>();
    const run = (task: Task, _mode: RunMode): Promise<void> =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      });
    return { run, resolvers };
  }

  it("caps a single owner to max_concurrency with global slots free", async () => {
    const user = await createUser("cap-user@test", "pw", "user");
    setUserMaxConcurrency(user.id, 1);
    const proj = createProject({ name: "cap-proj", ownerId: user.id });
    // Distinct cwds so cwd mutual exclusion doesn't serialize them.
    const t1 = createTask({ title: "t1", prompt: "p", project_id: proj.id, cwd: path.join(tmpDir, "d1") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: proj.id, cwd: path.join(tmpDir, "d2") });

    const scheduler = new TaskScheduler(5); // global well above the per-owner cap
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");

    // t1 runs; t2 blocked by the owner cap (1), even with 4 global slots free.
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("queued");

    runner.resolvers.get(t1.id)!();
    await tick();
    expect(getTaskById(t2.id)?.status).toBe("running");
    runner.resolvers.get(t2.id)!();
    await tick();
  });

  it("does not gate null-owner or unlimited tasks", async () => {
    const userA = await createUser("a@test", "pw", "user");
    setUserMaxConcurrency(userA.id, 1);
    const projA = createProject({ name: "projA", ownerId: userA.id });
    const projB = createProject({ name: "projB" }); // owner_id = null

    const t1 = createTask({ title: "t1", prompt: "p", project_id: projA.id, cwd: path.join(tmpDir, "a1") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projA.id, cwd: path.join(tmpDir, "a2") });
    const t3 = createTask({ title: "t3", prompt: "p", project_id: projB.id, cwd: path.join(tmpDir, "b1") });

    const scheduler = new TaskScheduler(5);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    scheduler.enqueue(t3.id, "start");

    // t1 (owner A) runs; t2 (owner A) capped; t3 (null owner) not capped.
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("queued");
    expect(getTaskById(t3.id)?.status).toBe("running");

    runner.resolvers.get(t1.id)!();
    await tick();
    expect(getTaskById(t2.id)?.status).toBe("running");
    runner.resolvers.get(t2.id)!();
    runner.resolvers.get(t3.id)!();
    await tick();
  });

  it("lets a raised cap take effect after invalidateOwnerLimit", async () => {
    const user = await createUser("inc@test", "pw", "user");
    setUserMaxConcurrency(user.id, 1);
    const proj = createProject({ name: "inc-proj", ownerId: user.id });
    const t1 = createTask({ title: "t1", prompt: "p", project_id: proj.id, cwd: path.join(tmpDir, "i1") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: proj.id, cwd: path.join(tmpDir, "i2") });

    const scheduler = new TaskScheduler(5);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    expect(getTaskById(t2.id)?.status).toBe("queued"); // capped at 1

    // Raise the cap and invalidate the cache -> t2 should now run.
    setUserMaxConcurrency(user.id, 2);
    scheduler.invalidateOwnerLimit(user.id);
    expect(getTaskById(t2.id)?.status).toBe("running");

    runner.resolvers.get(t1.id)!();
    runner.resolvers.get(t2.id)!();
    await tick();
  });
});

// Per-cwd 并发上限 (v38, projects.parallel_limit): 同一个 cwd 默认只能跑一个任务
// (严格互斥), 项目把 parallel_limit 调到 N 后可以并发 N 个. 用于「基本不写工作树」
// 的项目(如搭档巡检)提高并行度, 同时不动全局并发和 per-owner 上限。
describe("TaskScheduler per-cwd parallel limit (v38)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function controllableRunner() {
    const resolvers = new Map<string, () => void>();
    const run = (task: Task, _mode: RunMode): Promise<void> =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      });
    return { run, resolvers };
  }

  it("runs parallel_limit tasks on the same cwd and queues the rest", async () => {
    const proj = createProject({ name: "par-proj" });
    updateProject(proj.id, { parallel_limit: 2 });
    const sharedCwd = path.join(tmpDir, "shared-repo");
    const ts = [1, 2, 3].map((i) =>
      createTask({ title: `t${i}`, prompt: "p", project_id: proj.id, cwd: sharedCwd }),
    );

    const scheduler = new TaskScheduler(5); // 全局远高于 per-cwd 上限
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    ts.forEach((t) => scheduler.enqueue(t.id, "start"));

    // 前两个进得去, 第三个被 per-cwd 上限挡住(全局还有 3 个空位).
    expect(getTaskById(ts[0].id)?.status).toBe("running");
    expect(getTaskById(ts[1].id)?.status).toBe("running");
    expect(getTaskById(ts[2].id)?.status).toBe("queued");

    // 放掉一个 -> 腾出一个 cwd 槽位, 第三个补上.
    runner.resolvers.get(ts[0].id)!();
    await tick();
    expect(getTaskById(ts[2].id)?.status).toBe("running");

    runner.resolvers.get(ts[1].id)!();
    runner.resolvers.get(ts[2].id)!();
    await tick();
  });

  it("defaults to strict mutual exclusion when parallel_limit is untouched", async () => {
    // 存量项目(从未设置过 parallel_limit)必须和上线前完全一致.
    const proj = createProject({ name: "default-proj" });
    expect(proj.parallel_limit ?? 1).toBe(1);
    const sharedCwd = path.join(tmpDir, "default-repo");
    const t1 = createTask({ title: "t1", prompt: "p", project_id: proj.id, cwd: sharedCwd });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: proj.id, cwd: sharedCwd });

    const scheduler = new TaskScheduler(5);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("queued");

    runner.resolvers.get(t1.id)!();
    await tick();
    runner.resolvers.get(t2.id)!();
    await tick();
  });

  it("still honours the global cap when parallel_limit is higher", async () => {
    // 三层闸门取小: parallel_limit=5 但全局只有 2 个槽位 -> 只跑 2 个.
    const proj = createProject({ name: "global-cap-proj" });
    updateProject(proj.id, { parallel_limit: 5 });
    const sharedCwd = path.join(tmpDir, "cap-repo");
    const ts = [1, 2, 3].map((i) =>
      createTask({ title: `t${i}`, prompt: "p", project_id: proj.id, cwd: sharedCwd }),
    );

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    ts.forEach((t) => scheduler.enqueue(t.id, "start"));
    expect(scheduler.getRunningCount()).toBe(2);
    expect(getTaskById(ts[2].id)?.status).toBe("queued");

    runner.resolvers.get(ts[0].id)!();
    runner.resolvers.get(ts[1].id)!();
    await tick();
    runner.resolvers.get(ts[2].id)!();
    await tick();
  });

  it("frees only its own cwd slot when a task is cancelled early", async () => {
    // releaseSlot(取消/暂停) 后 runner 迟到的 onTaskDone 不能把别的任务占着的
    // cwd 槽位一起抹掉 —— holder set 只删自己那一条.
    const proj = createProject({ name: "release-proj" });
    updateProject(proj.id, { parallel_limit: 2 });
    const sharedCwd = path.join(tmpDir, "release-repo");
    const ts = [1, 2, 3].map((i) =>
      createTask({ title: `t${i}`, prompt: "p", project_id: proj.id, cwd: sharedCwd }),
    );

    const scheduler = new TaskScheduler(5);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    ts.forEach((t) => scheduler.enqueue(t.id, "start"));
    expect(getTaskById(ts[2].id)?.status).toBe("queued");

    // t1 提前释放槽位 -> t3 顶上, cwd 上现在是 t2 + t3.
    scheduler.releaseSlot(ts[0].id);
    expect(getTaskById(ts[2].id)?.status).toBe("running");

    // t1 的 runner 现在才结束(迟到的 onTaskDone), 不应影响 t2/t3 的占位.
    runner.resolvers.get(ts[0].id)!();
    await tick();
    expect(scheduler.getRunning().sort()).toEqual([ts[1].id, ts[2].id].sort());

    runner.resolvers.get(ts[1].id)!();
    runner.resolvers.get(ts[2].id)!();
    await tick();
  });

  it("rejects an out-of-range parallel_limit instead of silently storing it", () => {
    const proj = createProject({ name: "validate-proj" });
    expect(() => updateProject(proj.id, { parallel_limit: 0 })).toThrow(/1-10/);
    expect(() => updateProject(proj.id, { parallel_limit: 11 })).toThrow(/1-10/);
    expect(() => updateProject(proj.id, { parallel_limit: 1.5 })).toThrow(/1-10/);
    // null = 恢复默认(1)
    updateProject(proj.id, { parallel_limit: 3 });
    expect(updateProject(proj.id, { parallel_limit: null })?.parallel_limit).toBe(1);
  });
});

// v510 (damo 2026-09-17): 看板拖拽手动排序 — scheduler 按 queued_order 派发.
//
// 关注点:
//   - 三个 task 全部 enqueue 后, 默认按 priority desc + 入队顺序排.
//   - reorderQueue 重排后, schedule() 出队顺序按新 order; 高 order = 后跑.
//   - 入队时分配 queued_order = MAX + 1, 不会破坏已有手动顺序.
//   - 已 running 的 task 被 reorderQueue 跳过 (cache 不更新), 不污染.
//   - NULL order = "未排序", 排到所有已设值之后 (NULLS LAST 语义).
describe("TaskScheduler v510 manual queue order", () => {
  it("enqueue assigns queued_order = MAX+1 in arrival order", () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId });
    const t3 = createTask({ title: "t3", prompt: "p", project_id: projectId });

    // 不真正起 runner — 用 cap=0 scheduler 阻止派发, 只看 enqueue 顺序.
    const scheduler = new TaskScheduler(0);
    scheduler.setRunner(async () => {});
    scheduler.setStatusChangeHandler(() => {});

    scheduler.enqueue(t1.id);
    scheduler.enqueue(t2.id);
    scheduler.enqueue(t3.id);

    const o1 = getTaskById(t1.id)!.queued_order!;
    const o2 = getTaskById(t2.id)!.queued_order!;
    const o3 = getTaskById(t3.id)!.queued_order!;

    expect(o1).toBeLessThan(o2);
    expect(o2).toBeLessThan(o3);
    expect(o3 - o1).toBe(2); // 连续整数 (capped at MAX+1 + N)
  });

  it("reorderQueue 重排后 schedule() 按新 order 出队", async () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId });
    const t3 = createTask({ title: "t3", prompt: "p", project_id: projectId });

    // parallel_limit 提到 3, 让同 cwd 的 3 个 task 不互斥.
    updateProject(projectId, { parallel_limit: 3 });

    const startedOrder: string[] = [];
    // 用 hanging runner, enqueue 时只入队不出队; reorderQueue 后手动
    //   resolve 让 runner 依次完成, 验证出队顺序.
    const pending: Array<() => void> = [];
    const scheduler = new TaskScheduler(3);
    scheduler.setRunner((task) =>
      new Promise<void>((resolve) => {
        startedOrder.push(task.id);
        pending.push(resolve);
      }),
    );
    scheduler.setStatusChangeHandler(() => {});

    // 维护模式 = paused, schedule 立即返回; enqueue 只入队不出队.
    scheduler.setPaused(true);
    scheduler.enqueue(t1.id);
    scheduler.enqueue(t2.id);
    scheduler.enqueue(t3.id);

    // 用户把 t3 拽到最前 (order: t3=10, t1=20, t2=30).
    scheduler.reorderQueue([
      { id: t3.id, order: 10 },
      { id: t1.id, order: 20 },
      { id: t2.id, order: 30 },
    ]);

    // 恢复派发 — schedule() 按 reorderQueue 后的顺序逐个出队.
    scheduler.setPaused(false);

    // 等 microtask flush, 让 scheduler 派发 3 个任务.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(startedOrder).toContain(t1.id);
    expect(startedOrder).toContain(t2.id);
    expect(startedOrder).toContain(t3.id);
    // t3 必须是第一个跑 (order=10 最小)
    expect(startedOrder.indexOf(t3.id)).toBeLessThan(startedOrder.indexOf(t1.id));
    expect(startedOrder.indexOf(t1.id)).toBeLessThan(startedOrder.indexOf(t2.id));

    // 让 pending promise resolve, 避免测试结束后留下 dangling promise.
    while (pending.length > 0) pending.shift()!();
  });

  it("reorderQueue 跳过已不在队列的 task (cache 不留死键)", () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId });

    const scheduler = new TaskScheduler(0);
    scheduler.setRunner(async () => {});
    scheduler.setStatusChangeHandler(() => {});

    scheduler.enqueue(t1.id);
    scheduler.enqueue(t2.id);
    // t1 出了队 (模拟 dequeue / 被抢占).
    scheduler.dequeue(t1.id);

    // reorderQueue 包含 t1 — 应该被忽略, 不影响 t2.
    expect(() =>
      scheduler.reorderQueue([
        { id: t1.id, order: 100 },
        { id: t2.id, order: 200 },
      ]),
    ).not.toThrow();
  });

  it("doRelease 清掉 cache — 重入队后按新 MAX+1 排", () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId });

    const scheduler = new TaskScheduler(1);
    scheduler.setRunner(async () => {});
    scheduler.setStatusChangeHandler(() => {});

    scheduler.enqueue(t1.id);
    const firstOrder = getTaskById(t1.id)!.queued_order!;

    // 强制 release + 重新入队 — 第二次 enqueue 应该拿到 MAX+1 (next, 不复用旧的).
    scheduler.releaseSlot(t1.id);
    updateTaskStatus(t1.id, "completed"); // 模拟「跑完了」
    scheduler.enqueue(t1.id, "start", "test_rerun");
    const secondOrder = getTaskById(t1.id)!.queued_order!;

    expect(secondOrder).toBeGreaterThan(firstOrder);
  });

  it("NULL order 排到所有已设值之后 (NULLS LAST)", () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId });

    const scheduler = new TaskScheduler(0);
    scheduler.setRunner(async () => {});
    scheduler.setStatusChangeHandler(() => {});

    scheduler.enqueue(t1.id);
    scheduler.enqueue(t2.id);

    // 把 t2 显式清空 (order=null = "未排序"), t1 留 1.
    scheduler.reorderQueue([
      { id: t1.id, order: 1 },
      { id: t2.id, order: null },
    ]);

    // queue 内部顺序: t1 (order=1) 在前, t2 (order=null) 在后.
    const queueIds = scheduler.getQueue();
    expect(queueIds.indexOf(t1.id)).toBeLessThan(queueIds.indexOf(t2.id));
  });
});

describe("TaskScheduler queued_reason (v531)", () => {
  function controllableRunner() {
    const resolvers = new Map<string, () => void>();
    const run = (task: Task, _mode: RunMode): Promise<void> =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      });
    return { run, resolvers };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("cwd 互斥挡住时写原因, 出队后清空", async () => {
    const sharedCwd = path.join(tmpDir, "repo-v531");
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId, cwd: sharedCwd });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId, cwd: sharedCwd });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");

    // t1 立即跑 (原因已清/为空); t2 被 cwd 互斥挡住, 原因写上 (含挡路者短 id).
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t1.id)?.queued_reason ?? null).toBeNull();
    expect(getTaskById(t2.id)?.status).toBe("queued");
    expect(getTaskById(t2.id)?.queued_reason).toMatch(
      new RegExp(`同项目任务 ${t1.id.slice(0, 8)} 正在运行`),
    );

    // t1 完成 → t2 出队, 原因清空.
    runner.resolvers.get(t1.id)!();
    await tick();
    expect(getTaskById(t2.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.queued_reason ?? null).toBeNull();

    runner.resolvers.get(t2.id)!();
    await tick();
  });

  it("全局并发满时队列任务写原因", async () => {
    const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId, cwd: path.join(tmpDir, "repo-g1") });
    const t2 = createTask({ title: "t2", prompt: "p", project_id: projectId, cwd: path.join(tmpDir, "repo-g2") });
    const t3 = createTask({ title: "t3", prompt: "p", project_id: projectId, cwd: path.join(tmpDir, "repo-g3") });

    const scheduler = new TaskScheduler(2);
    scheduler.setStatusChangeHandler(() => {});
    const runner = controllableRunner();
    scheduler.setRunner(runner.run);

    scheduler.enqueue(t1.id, "start");
    scheduler.enqueue(t2.id, "start");
    scheduler.enqueue(t3.id, "start");

    // 并发 2 满, t3 排队且原因 = 全局并发满.
    expect(getTaskById(t1.id)?.status).toBe("running");
    expect(getTaskById(t2.id)?.status).toBe("running");
    expect(getTaskById(t3.id)?.status).toBe("queued");
    expect(getTaskById(t3.id)?.queued_reason).toContain("全局并发已满");

    runner.resolvers.get(t1.id)!();
    await tick();
    // 槽位释放, t3 出队 + 原因清空.
    expect(getTaskById(t3.id)?.status).toBe("running");
    expect(getTaskById(t3.id)?.queued_reason ?? null).toBeNull();

    runner.resolvers.get(t2.id)!();
    runner.resolvers.get(t3.id)!();
    await tick();
  });

  it("内存闸门挡出队时队列任务写原因", () => {
    // 阈值在 MemGate 构造时固化 (scheduler 构造时读 env), 设一个必挡值.
    process.env.AO_MEM_GUARD_MB = "9999999";
    try {
      const t1 = createTask({ title: "t1", prompt: "p", project_id: projectId });
      const scheduler = new TaskScheduler(2);
      scheduler.setStatusChangeHandler(() => {});
      scheduler.setRunner(() => new Promise<void>(() => {}));
      scheduler.enqueue(t1.id, "start");

      expect(getTaskById(t1.id)?.status).toBe("queued");
      expect(getTaskById(t1.id)?.queued_reason).toContain("可用内存");
    } finally {
      delete process.env.AO_MEM_GUARD_MB;
    }
  });
});
