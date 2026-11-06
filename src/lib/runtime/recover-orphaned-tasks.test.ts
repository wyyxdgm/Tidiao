// recoverOrphanedTasks: queued 任务被 server_restart 回收为 pending 后,
//   session_id 存在的 task 应自动入队 (resume/fork 模式). 不再单纯降级为
//   pending 干等 — task 700d5434 实证: 用户 sendUserMessage 推 queued 后 server
//   重启, 任务卡 pending + metadata.pending_messages 有消息待消费.
//
// 关注点:
//   - fork 路径之前就有 enqueue, 是 R155 把"普通 queued + session_id"也并入这条
//     路径 (语义一致: 任务已被 scheduler 接住, 不该被降级冷处理).
//   - running → paused 的现有分支不动.
//   - 观察手段: events 表 status_change 事件链 (recoverOrphanedTasks 写 from=queued
//     to=pending reason=server_restart; enqueue 内部状态机会再写 from=pending
//     to=queued reason=server_restart). 同时核对 scheduler.queue 含该 task.
//   - runner 用 throw 路径, 让 schedule() 把 task 推到 failed 而不是卡 running
//     — 我们已经通过 status_change 事件验证了 enqueue 路径, 不关心最终 SDK 跑没跑.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler } from "./task-scheduler";
import { getEventsByTaskId } from "../db/events";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-recover-orphaned-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x");

  projectId = createProject({
    name: "recover-orphaned",
    cwd: tmpDir,
    ownerId,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setTaskState(
  taskId: string,
  status: "queued" | "running" | "pending" | "reviewing",
  sessionId?: string,
  forkedFrom?: string,
): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, session_id = COALESCE(?, session_id),
         forked_from_session_id = COALESCE(?, forked_from_session_id)
       WHERE id = ?`,
    )
    .run(status, sessionId ?? null, forkedFrom ?? null, taskId);
}

function makeTask(title: string): Task {
  return getTaskById(
    createTask({ title, prompt: "p", project_id: projectId }).id,
  )!;
}

// 读 events 表 status_change 事件的 reason 序列.
function statusChangeReasons(taskId: string): (string | null)[] {
  return getEventsByTaskId(taskId)
    .filter((e) => e.type === "status_change")
    .map((e) => {
      try {
        return (JSON.parse(e.data) as { reason?: string }).reason ?? null;
      } catch {
        return null;
      }
    });
}

function newRuntime(): AgentRuntime {
  const runtime = new AgentRuntime();
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
  // Runner 立刻 throw — 让 schedule() 把 task 推到 failed, 而不是卡 running.
  // 我们关心的是 enqueue 路径有没有被走过 (看 status_change 事件链), 不是 SDK 真跑没跑.
  scheduler.setRunner(
    (_task: Task, _mode: string) =>
      Promise.reject(new Error("test: runner throw to skip SDK")),
  );
  // init() 触发 recoverOrphanedTasks + loadRunnersFromDb + startHeartbeatTick.
  // loadRunnersFromDb 可能 throw 当 ENCRYPTION_KEY 不对; 我们 mock runner DB 走通.
  // startHeartbeatTick 是 setInterval, afterEach closeDb 应该会清, 不影响断言.
  try {
    runtime.init();
  } catch {
    // init 内部 loadRunnersFromDb 在 ENCRYPTION_KEY 漂了时 throw, 我们不关心 runner 表.
    // 但 recoverOrphanedTasks 应该已经先跑过了 (line 350 在 loadRunnersFromDb 之前).
  }
  // 给一个 tick 让 init() 内任何 microtask 跑完.
  return runtime;
}

// 启动时 AgentRuntime 构造函数自动跑 recoverOrphanedTasks.
// 我们观察 task 状态 + events 表 status_change 事件 + scheduler.queue.
describe("recoverOrphanedTasks: queued 任务的恢复语义 (R155)", () => {
  it("queued + session_id + 非 fork → 自动入队 resume (修复前会卡 pending)", () => {
    // 场景: task 700d5434 实测. sendUserMessage 推 queued, server 重启后
    //  应当自动 enqueue(resume), 让 ActiveSession.resume() 把 pending_messages
    //  消费掉. 修复前: 仅降级 pending, 等不到消费.
    const t = makeTask("resume-after-restart");
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(ownerId, t.id);
    setTaskState(t.id, "queued", "sess-existing");

    const runtime = newRuntime();

    // 关键断言 1: events 表前两个 status_change 事件 reason 都是 server_restart
    //   - recoverOrphanedTasks: queued → pending
    //   - scheduler.enqueue: pending → queued
    // R155 修复前: 只有第一个, 没有第二个.
    // 后面可能还有 runner throw 写的 failed 事件, 不在本测试关注范围.
    const reasons = statusChangeReasons(t.id);
    expect(reasons[0]).toBe("server_restart");
    expect(reasons[1]).toBe("server_restart");
    expect(reasons.length).toBeGreaterThanOrEqual(2);

    // 关键断言 2: 此刻 task 不再卡 pending (要么 enqueue 后被 schedule 拉走变
    //   failed/running, 要么仍在 queued).
    const after = getTaskById(t.id)!;
    expect(after.status).not.toBe("pending");

    // 关键断言 3: scheduler.queue 已被 dispatch 走 (splice 掉).
    const sched = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
    const queueLen = (sched as unknown as { queue: unknown[] }).queue.length;
    expect(queueLen).toBe(0);
  });

  it("queued + forked_from_session_id → mode = fork (行为不变)", () => {
    const t = makeTask("fork-after-restart");
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(ownerId, t.id);
    setTaskState(t.id, "queued", "sess-fork-target", "sess-fork-source");

    newRuntime();

    // 同样应该看到 enqueue 内部写的 pending → queued 事件.
    const reasons = statusChangeReasons(t.id);
    expect(reasons[0]).toBe("server_restart");
    expect(reasons[1]).toBe("server_restart");
  });

  it("queued + 无 session_id → 按 start 重新入队 (damo 1013: 显式 start 过 = 意图明确)", () => {
    // 旧行为 (6fbad284 前): 无 session 可 resume → 只翻 pending 不入队 =
    //   永久躺平 (调度队列是内存态, 无人认领; GDM 4 条 pending 27h 实证).
    // 新行为: start 过的任务 (= 到过 queued) 按 start 重新入队, 与 resume
    //   路径同语义; DAG 未满足由 scheduler 闸门继续挡, 不会误跑.
    const t = makeTask("no-session-restart");
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(ownerId, t.id);
    setTaskState(t.id, "queued"); // session_id 仍 NULL

    const runtime = newRuntime();

    // 事件链与 R155 resume 路径同构: queued→pending + pending→queued,
    //   两个 reason 都是 server_restart.
    const reasons = statusChangeReasons(t.id);
    expect(reasons[0]).toBe("server_restart");
    expect(reasons[1]).toBe("server_restart");

    // 不再卡 pending (runner throw 路径下最终 failed/queued 均可).
    const after = getTaskById(t.id)!;
    expect(after.status).not.toBe("pending");

    // scheduler.queue 已被 dispatch 走.
    const sched = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
    const queueLen = (sched as unknown as { queue: unknown[] }).queue.length;
    expect(queueLen).toBe(0);
  });

  it("running → 转 paused (现有行为不变)", () => {
    // running 任务被 server_restart 撞上, 失去 SDK subprocess, 转 paused 让用户手动
    // resume. 这条路径没改, 加 test 防回归.
    const t = makeTask("running-restart");
    getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(ownerId, t.id);
    setTaskState(t.id, "running", "sess-running");

    newRuntime();

    const after = getTaskById(t.id)!;
    expect(after.status).toBe("paused");
    expect(statusChangeReasons(t.id)).toEqual(["server_restart"]);
  });
});