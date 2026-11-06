// 维护模式 (v34): 部署前有序关停 -> 部署 -> 恢复
//
// 关停的价值全在「上下文不丢」: pause 会 interrupt SDK 并保住 session_id,
// 恢复时 resume 能续上完整 transcript。所以这里的核心断言不是「状态对不对」,
// 而是「session_id 还在不在」+「重启后新进程知不知道自己该静默」。
//
// 真 SQLite + 真 TaskScheduler + 真事件持久化；只有 SDK 与 runner 是假的。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK 不参与: runner 被替换掉, query 永不被调用
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(async () => ({ sessionId: "mock-forked-session" })),
  getSessionMessages: vi.fn(async () => [{ uuid: "msg-1", role: "user" }]),
  query: vi.fn(),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

// ScheduleRunner 必须 mock: 真的 startScheduleRunner 会挂一个 60s interval +
// 5s setTimeout, 在测试进程里会对着已关闭的 DB 跑 tick, 还会拖住 vitest 退出.
// 同时正好让我们断言「关停停了轮询、恢复起了轮询」。
const stopScheduleRunner = vi.fn();
const startScheduleRunner = vi.fn();
vi.mock("./schedule-runner", () => ({
  stopScheduleRunner: () => stopScheduleRunner(),
  startScheduleRunner: () => startScheduleRunner(),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus, peekPendingMessages } from "../db/tasks";
import { getMaintenanceState, getRecentMaintenanceLog, getOpenMaintenanceLog, getLastCompletedMaintenanceLog } from "../db/maintenance";

let tmpDir: string;
let projectId: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-maint-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // 跑全部 migration（含 v34 建 maintenance_state）

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "maint-test@example.com", "x", "admin");
  projectId = createProject({ name: "maint-test-project", ownerId: userId }).id;

  stopScheduleRunner.mockClear();
  startScheduleRunner.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Helpers ----

function schedulerOf(runtime: AgentRuntime): TaskScheduler {
  return (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
}

function sessionsOf(runtime: AgentRuntime): Map<string, unknown> {
  return (runtime as unknown as { sessions: Map<string, unknown> }).sessions;
}

// runner 挂住不返回, 任务停在 running 直到 resolve —— 与 status-transitions.test 同法
function makeRuntime(): { runtime: AgentRuntime; resolve: (taskId: string) => void } {
  const resolvers = new Map<string, () => void>();
  const runtime = new AgentRuntime();
  schedulerOf(runtime).setRunner(
    (task: Task, _mode: RunMode) =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      })
  );
  return {
    runtime,
    resolve: (taskId: string) => resolvers.get(taskId)?.(),
  };
}

// 假 ActiveSession: pauseTask 只用到 interrupt / close / getSessionId /
// getCostUsd / takeUnansweredUserTurn。真 runner 被替换后 runtime.sessions
// 不会自动填充, 手动塞进去才能走 pause 路径。
function fakeSession(sessionId: string | null) {
  return {
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getSessionId: () => sessionId,
    // pause 时会读它把被打断的部分花费落库; 这里的关停用例不关心金额。
    // 给「零 token 的估算」形态: pauseTask 现在恒写 cost_usd(不再留 NULL),
    // 落的是最小估算值。成本落库本身由 cost-on-interrupt.test.ts 覆盖。
    getCostUsd: () => 0,
    getTokenUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    getCostSnapshot: () => ({ cost: 0.0001, source: "estimated" as const }),
    takeUnansweredUserTurn: () => null,
    markExternallyTerminated: () => {},
    get isClosed() {
      return false;
    },
  };
}

function newTask(title: string): Task {
  return createTask({ title, prompt: "test prompt", project_id: projectId });
}

// 让调度器的异步尾巴跑完
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- Tests ----

describe("维护模式: 关停闸门", () => {
  it("关停后 startTask 的任务停在 queued, 不进 running", async () => {
    const { runtime } = makeRuntime();
    await runtime.enterMaintenance({ by: userId, reason: "deploy" });

    const task = newTask("闸门测试");
    runtime.startTask(task.id);
    await tick();

    // enqueue 照常翻 queued（维护期间点启动不报错），但不出队
    expect(getTaskById(task.id)?.status).toBe("queued");
    expect(schedulerOf(runtime).getRunningCount()).toBe(0);
    expect(schedulerOf(runtime).isPaused()).toBe(true);
  });

  it("关停会停掉定时轮询, 恢复会重新启动", async () => {
    const { runtime } = makeRuntime();
    await runtime.enterMaintenance({ by: userId, reason: null });
    expect(stopScheduleRunner).toHaveBeenCalledTimes(1);
    expect(startScheduleRunner).not.toHaveBeenCalled();

    await runtime.exitMaintenance();
    expect(startScheduleRunner).toHaveBeenCalledTimes(1);
  });
});

describe("维护模式: running 任务", () => {
  it("被 pause 且 session_id 保住（上下文可恢复的前提）", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("running 任务");
    runtime.startTask(task.id);
    await tick();
    expect(getTaskById(task.id)?.status).toBe("running");

    // 塞进假 session, 模拟真实运行中的 SDK 会话
    sessionsOf(runtime).set(task.id, fakeSession("sess-abc-123"));

    const result = await runtime.enterMaintenance({ by: userId, reason: "deploy" });

    expect(result.paused).toContain(task.id);
    const after = getTaskById(task.id);
    expect(after?.status).toBe("paused");
    // 这一条是整个功能的意义所在: 没有 session_id 就没法续 transcript
    expect(after?.session_id).toBe("sess-abc-123");

    resolve(task.id);
  });

  it("session_id 尚未分配的任务归入 failed, 不进可恢复清单", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("无 session 任务");
    runtime.startTask(task.id);
    await tick();

    // getSessionId() 返回 null = agent 还没产出第一条 assistant 消息,
    // pauseTask 既有行为是标 failed（无从 resume）, 不该被当成挂起任务
    sessionsOf(runtime).set(task.id, fakeSession(null));

    const result = await runtime.enterMaintenance({ by: userId, reason: null });

    expect(result.paused).not.toContain(task.id);
    expect(result.failed.map((f) => f.task_id)).toContain(task.id);
    expect(getTaskById(task.id)?.status).toBe("failed");
    expect(getMaintenanceState().suspended.map((s) => s.task_id)).not.toContain(task.id);

    resolve(task.id);
  });
});

describe("维护模式: 排队任务（内存队列会随重启丢失）", () => {
  it("被摘下队列、状态回 pending、记进 suspended", async () => {
    const { runtime, resolve } = makeRuntime();
    schedulerOf(runtime).setConcurrency(1);

    const running = newTask("占住槽位");
    runtime.startTask(running.id);
    await tick();
    expect(getTaskById(running.id)?.status).toBe("running");

    const queued = newTask("排队中");
    runtime.startTask(queued.id);
    await tick();
    expect(getTaskById(queued.id)?.status).toBe("queued");

    sessionsOf(runtime).set(running.id, fakeSession("sess-running"));
    const result = await runtime.enterMaintenance({ by: userId, reason: null });

    expect(result.dequeued).toContain(queued.id);
    // 必须回 pending: 若留 queued 而内存队列已空, 重启后永远没人再调度它
    expect(getTaskById(queued.id)?.status).toBe("pending");
    expect(schedulerOf(runtime).getQueueSize()).toBe(0);

    const suspended = getMaintenanceState().suspended;
    expect(suspended.find((s) => s.task_id === queued.id)?.prev_status).toBe("queued");
    expect(suspended.find((s) => s.task_id === running.id)?.prev_status).toBe("running");

    resolve(running.id);
  });
});

describe("维护模式: 恢复", () => {
  it("两类挂起任务都重新跑起来", async () => {
    const { runtime, resolve } = makeRuntime();
    schedulerOf(runtime).setConcurrency(1);

    const running = newTask("running 类");
    runtime.startTask(running.id);
    await tick();
    const queued = newTask("queued 类");
    runtime.startTask(queued.id);
    await tick();

    sessionsOf(runtime).set(running.id, fakeSession("sess-r"));
    await runtime.enterMaintenance({ by: userId, reason: null });
    expect(getTaskById(running.id)?.status).toBe("paused");
    expect(getTaskById(queued.id)?.status).toBe("pending");

    // 并发放开到 2, 两个都能立刻拿到槽位
    schedulerOf(runtime).setConcurrency(2);
    const result = await runtime.exitMaintenance();
    await tick();

    expect(result.resumed).toContain(running.id);
    expect(result.requeued).toContain(queued.id);
    expect(getTaskById(running.id)?.status).toBe("running");
    expect(getTaskById(queued.id)?.status).toBe("running");
    expect(getMaintenanceState().active).toBe(false);
    expect(getMaintenanceState().suspended).toEqual([]);

    resolve(running.id);
    resolve(queued.id);
  });

  // 光「状态回 running」是不够的: 实测过一次 —— session_id 保住了、SDK 也带
  // --resume 起来了, 但 agent 6 分钟零动作, 因为 resume() 拿到的
  // initialPrompt 和 preMessages 都是空的 -> 没有 turn 可做, 空转到 30min 超时。
  // 所以这里断言的是「队列里真有一条续跑消息」, 而不是状态。
  it("resume 前注入「继续」, 否则 agent 连上也没 turn 可做", async () => {
    const { runtime, resolve } = makeRuntime();
    const running = newTask("需要被推一把");
    runtime.startTask(running.id);
    await tick();
    sessionsOf(runtime).set(running.id, fakeSession("sess-nudge"));
    await runtime.enterMaintenance({ by: userId, reason: null });
    expect(getTaskById(running.id)?.status).toBe("paused");

    await runtime.exitMaintenance();
    await tick();

    // resume() 会在真实路径里 drain 掉它; 这里 runner 是假的, 所以队列还在
    expect(peekPendingMessages(running.id)).toEqual(["继续"]);

    resolve(running.id);
  });

  it("requeue 的 pending 任务不注入（它本来就从头跑, prompt 自带）", async () => {
    const { runtime, resolve } = makeRuntime();
    schedulerOf(runtime).setConcurrency(1);

    const blocker = newTask("占住槽位");
    runtime.startTask(blocker.id);
    await tick();
    const queued = newTask("排队的");
    runtime.startTask(queued.id);
    await tick();

    sessionsOf(runtime).set(blocker.id, fakeSession("sess-b"));
    await runtime.enterMaintenance({ by: userId, reason: null });
    expect(getTaskById(queued.id)?.status).toBe("pending");

    await runtime.exitMaintenance();
    await tick();

    expect(peekPendingMessages(queued.id)).toEqual([]);

    resolve(blocker.id);
    resolve(queued.id);
  });

  it("不碰用户自己手动 pause 的任务", async () => {
    const { runtime } = makeRuntime();

    // 关停「之前」就已是 paused 的任务 —— 不该被 exitMaintenance 唤醒
    const manual = newTask("手动挂起");
    updateTaskStatus(manual.id, "paused", { session_id: "sess-manual" });

    await runtime.enterMaintenance({ by: userId, reason: null });
    expect(getMaintenanceState().suspended.map((s) => s.task_id)).not.toContain(manual.id);

    const result = await runtime.exitMaintenance();
    await tick();

    expect(result.resumed).not.toContain(manual.id);
    expect(getTaskById(manual.id)?.status).toBe("paused");
  });

  it("维护期间被手动处理过的任务只跳过, 不报错", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("中途被处理");
    runtime.startTask(task.id);
    await tick();
    sessionsOf(runtime).set(task.id, fakeSession("sess-x"));
    await runtime.enterMaintenance({ by: userId, reason: null });
    expect(getTaskById(task.id)?.status).toBe("paused");

    // 人在维护期间点了「通过」
    runtime.approveTask(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");

    const result = await runtime.exitMaintenance();
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.task_id)).toContain(task.id);
    expect(getTaskById(task.id)?.status).toBe("completed");

    resolve(task.id);
  });
});

describe("维护模式: 跨进程重启", () => {
  it("active=1 时新进程启动即关闸（内存标记会丢, 库里的不会）", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("跨重启");
    runtime.startTask(task.id);
    await tick();
    sessionsOf(runtime).set(task.id, fakeSession("sess-persist"));
    await runtime.enterMaintenance({ by: userId, reason: "deploy" });
    resolve(task.id);

    // 模拟 pm2 restart: 全新 AgentRuntime + init()（同一个 DB 文件）
    const fresh = new AgentRuntime();
    schedulerOf(fresh).setRunner(() => new Promise<void>(() => {}));
    fresh.init();

    expect(fresh.isMaintenanceActive()).toBe(true);
    expect(schedulerOf(fresh).isPaused()).toBe(true);

    // 新进程里点启动也不该真跑起来
    const another = newTask("重启后新任务");
    fresh.startTask(another.id);
    await tick();
    expect(getTaskById(another.id)?.status).toBe("queued");
    expect(schedulerOf(fresh).getRunningCount()).toBe(0);
  });

  it("重启把 queued 扫成 pending 后, 恢复仍能认出并重新入队", async () => {
    const { runtime, resolve } = makeRuntime();
    schedulerOf(runtime).setConcurrency(1);
    const running = newTask("占槽");
    runtime.startTask(running.id);
    await tick();
    const queued = newTask("排队");
    runtime.startTask(queued.id);
    await tick();

    sessionsOf(runtime).set(running.id, fakeSession("sess-a"));
    await runtime.enterMaintenance({ by: userId, reason: null });
    resolve(running.id);

    // 新进程: recoverOrphanedTasks 会动残留状态, 恢复必须按「当前状态」分派
    const fresh = new AgentRuntime();
    schedulerOf(fresh).setRunner(() => new Promise<void>(() => {}));
    fresh.init();
    schedulerOf(fresh).setConcurrency(2);

    const result = await fresh.exitMaintenance();
    await tick();

    const touched = [...result.resumed, ...result.requeued];
    expect(touched).toContain(running.id);
    expect(touched).toContain(queued.id);
    expect(result.failed).toEqual([]);
  });
});

describe("维护模式: 幂等", () => {
  it("连调两次 enter 不重复 pause、不覆盖 suspended", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("幂等测试");
    runtime.startTask(task.id);
    await tick();
    const session = fakeSession("sess-idem");
    sessionsOf(runtime).set(task.id, session);

    const first = await runtime.enterMaintenance({ by: userId, reason: "第一次" });
    expect(first.already).toBe(false);
    expect(first.paused).toEqual([task.id]);
    const enteredAt = getMaintenanceState().entered_at;

    const second = await runtime.enterMaintenance({ by: userId, reason: "第二次" });
    expect(second.already).toBe(true);
    // 不重复 interrupt, 也不把 reason/entered_at 改掉
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    expect(getMaintenanceState().entered_at).toBe(enteredAt);
    expect(getMaintenanceState().reason).toBe("第一次");
    // 已挂起的清单如实回报, 供部署脚本核对
    expect(second.paused).toEqual([task.id]);

    resolve(task.id);
  });

  it("未处于维护中调 exit 也安全（等于确认开闸 + 起轮询）", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.exitMaintenance();
    expect(result.active_before).toBe(false);
    expect(result.resumed).toEqual([]);
    expect(result.requeued).toEqual([]);
    expect(schedulerOf(runtime).isPaused()).toBe(false);
    expect(startScheduleRunner).toHaveBeenCalledTimes(1);
  });

  // ---- v53 maintenance_log ----

  it("enter 写一条 maintenance_log, exit 收尾 result='completed'", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("v53-1");
    runtime.startTask(task.id);
    await tick();
    expect(getTaskById(task.id)?.status).toBe("running");
    sessionsOf(runtime).set(task.id, fakeSession("sess-v53-1"));

    await runtime.enterMaintenance({ by: userId, reason: "v53 测试" });

    // enter 后应有一条 open log
    const open = getOpenMaintenanceLog();
    expect(open).not.toBeNull();
    expect(open!.reason).toBe("v53 测试");
    expect(open!.started_by).toBe(userId);
    expect(open!.paused_count).toBe(1);
    expect(open!.dequeued_count).toBe(0);
    expect(open!.ended_at).toBeNull();
    expect(open!.result).toBeNull();

    await runtime.exitMaintenance();

    // exit 后 open log 收尾
    const after = getRecentMaintenanceLog(1)[0];
    expect(after.id).toBe(open!.id);
    expect(after.ended_at).not.toBeNull();
    expect(after.duration_seconds).not.toBeNull();
    expect(after.duration_seconds!).toBeGreaterThanOrEqual(0);
    expect(after.result).toBe("completed");
    expect(getOpenMaintenanceLog()).toBeNull();

    resolve(task.id);
  });

  it("finishMaintenanceLog 直接写 result='failed', 字段映射正确", async () => {
    // 不依赖 runtime 路径, 直接验证 db 层 result 写入语义 (3 态 CHECK 兜底手工脏值).
    const { startMaintenanceLog, finishMaintenanceLog } = await import("../db/maintenance");
    const id = startMaintenanceLog({
      started_by: userId,
      reason: "手工 failed 路径",
      paused_count: 0,
      dequeued_count: 0,
      failed_count: 3,
    });
    finishMaintenanceLog({ id, ended_by: userId, result: "failed" });
    const row = getRecentMaintenanceLog(1)[0];
    expect(row.id).toBe(id);
    expect(row.result).toBe("failed");
    expect(row.ended_by).toBe(userId);
    expect(row.failed_count).toBe(3);
    expect(row.duration_seconds).not.toBeNull();
  });

  it("getLastCompletedMaintenanceLog 排除 open log, 只返 ended_at 非空的", async () => {
    const { startMaintenanceLog, finishMaintenanceLog } = await import("../db/maintenance");
    // 第一条: completed
    const id1 = startMaintenanceLog({
      started_by: userId, reason: "completed 路径",
      paused_count: 0, dequeued_count: 0, failed_count: 0,
    });
    finishMaintenanceLog({ id: id1, ended_by: userId, result: "completed" });
    // 第二条: open (不 finish)
    startMaintenanceLog({
      started_by: userId, reason: "open 路径",
      paused_count: 1, dequeued_count: 0, failed_count: 0,
    });

    const last = getLastCompletedMaintenanceLog();
    expect(last).not.toBeNull();
    expect(last!.id).toBe(id1);
    expect(last!.result).toBe("completed");
    expect(last!.reason).toBe("completed 路径");

    // 兜底: open log 仍能查到
    const open = getOpenMaintenanceLog();
    expect(open!.reason).toBe("open 路径");
    expect(open!.ended_at).toBeNull();

    // 兜底收尾: 收掉 open log 防污染下个 case
    finishMaintenanceLog({ id: open!.id, ended_by: userId, result: "aborted" });
  });
});
