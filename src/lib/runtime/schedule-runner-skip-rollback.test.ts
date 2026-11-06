// 0830 hotfix 回归: skip_if_running 闸门永久死锁 → 回退 next_run
//
// 事故:schedule runner tick() 里 claimSchedule() 先推进 next_run 到下一周期,
// 然后 skip_if_running 检查发现上次 task 还卡 reviewing → continue。
// 但 next_run 已走,后续 60s tick 用 listDueSchedules(now) 永远不会再选中。
//
// hotfix:skip 时把 next_run 回退到原值,让下个 tick 重新尝试。
//
// 0901 演进 (damo 拍板 B+C):reviewing 不再算「在跑」——
//   ① reviewing task 不再触发 skip, runner 正常 fire 新 task, 上轮 result 拼进 prompt
//      (B 逻辑, 见 schedule-runner.ts 的 buildInheritedPrompt);
//   ② 只有 running/pending/queued 这类真正在执行的 task 才走原 skip + 回退逻辑;
//   ③ reviewing idle > 4h 由 C 逻辑转 damo 处理, 这里不覆盖。
//
// 本文件 4 个用例: 前 2 个覆盖「真在跑 → skip 回退」(running 不是 reviewing),
//   后 2 个覆盖「reviewing → fire」+「soft-delete 解锁」。
//
// 真 SQLite + 真 schedules/tasks 表;只 mock child_process.exec 和 SDK。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 🆕 damo 0906: fireShell 从 exec 改成 spawn detached; mock 跟着换。
const spawnMock = vi.fn();
class FakeStream {
  on() { return this; }
}
class FakeChild {
  pid = 99999;
  stdout = new FakeStream();
  stderr = new FakeStream();
  on() { return this; }
}
vi.mock("child_process", () => ({
  spawn: (_cmd: string, _opts: unknown) => {
    spawnMock(_cmd, _opts);
    return new FakeChild();
  },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { _tickForTest } from "./schedule-runner";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createSchedule, getScheduleById, updateSchedule } from "../db/schedules";
import { createTask, updateTaskStatus, deleteTask } from "../db/tasks";
import type { TaskStatus } from "./types";

let tmpDir: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-rollback-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  projectId = createProject({ name: "sched-rollback-project" }).id;
  spawnMock.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 建一条 agent 类定时(skip_if_running=true + cron 槽位已过期 → 立刻 due)
function makeAgentScheduleDueNow() {
  const s = createSchedule({
    name: "watchdog-test",
    exec_type: "agent",
    title: "test",
    prompt: "noop",
    project_id: projectId,
    schedule_type: "cron",
    schedule_expr: "* * * * *",
    skip_if_running: true,
  });
  // 强制 next_run 到 1 分钟前,确保 listDueSchedules(now) 选中
  updateSchedule(s.id, { enabled: true });
  const past = new Date(Date.now() - 60_000).toISOString();
  // 直接用 SQL 更新 next_run(createSchedule 不接受 next_run 字段)
  getDb()
    .prepare("UPDATE schedules SET next_run = ? WHERE id = ?")
    .run(past, s.id);
  return getScheduleById(s.id)!;
}

function makeReviewingTask(scheduleId: string): string {
  const t = createTask({
    title: "stuck watchdog task",
    prompt: "noop",
    project_id: projectId,
    schedule_id: scheduleId,
  });
  updateTaskStatus(t.id, "reviewing");
  return t.id;
}

// 0901: 「真在跑」 task(running,不是 reviewing) 仍走 skip + 回退 hotfix。
function makeRunningTask(scheduleId: string): string {
  const t = createTask({
    title: "still-running task",
    prompt: "noop",
    project_id: projectId,
    schedule_id: scheduleId,
  });
  updateTaskStatus(t.id, "running");
  return t.id;
}

describe("hotfix: skip_if_running 闸门不再永久死锁（running/pending/queued 路径）", () => {
  it("task 卡 running → tick() skip → schedule.next_run 回退到原值（不推进）", async () => {
    const schedule = makeAgentScheduleDueNow();
    const originalNextRun = schedule.next_run;
    makeRunningTask(schedule.id);

    await _tickForTest();

    const after = getScheduleById(schedule.id)!;
    expect(after.next_run).toBe(originalNextRun); // 回退 = hotfix 生效
    expect(spawnMock).not.toHaveBeenCalled(); // 没真 fire
  });

  it("连续两次 tick() 都 skip → next_run 每次都回退（循环但非永久）", async () => {
    const schedule = makeAgentScheduleDueNow();
    const originalNextRun = schedule.next_run;
    makeRunningTask(schedule.id);

    await _tickForTest();
    const after1 = getScheduleById(schedule.id)!;
    expect(after1.next_run).toBe(originalNextRun);

    // 第二次 tick — task 仍在 running,应再 skip + 再回退
    await _tickForTest();
    const after2 = getScheduleById(schedule.id)!;
    expect(after2.next_run).toBe(originalNextRun);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("0901 演进: reviewing 不再算在飞 → 正常 fire + inherited prompt", () => {
  it("task 卡 reviewing → tick() 不 skip 也不回退，正常推进 next_run fire 新 task", async () => {
    const schedule = makeAgentScheduleDueNow();
    const originalNextRun = schedule.next_run;
    makeReviewingTask(schedule.id);

    await _tickForTest();

    const after = getScheduleById(schedule.id)!;
    // reviewing 不再 skip → next_run 推进到下个 cron 槽位, 不再 = originalNextRun
    expect(new Date(after.next_run).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(after.next_run).not.toBe(originalNextRun);
    // agent schedule 走 fireAgent 路径, exec (shell) 没被调用
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("task 从 reviewing 变 completed → 下次 tick 正常 fire agent（闸门自动解锁）", async () => {
    const schedule = makeAgentScheduleDueNow();
    const taskId = makeReviewingTask(schedule.id);

    await _tickForTest();
    // 0901: 第一次 tick 看到 reviewing → 正常 fire（不再 skip）, next_run 已推进
    // 不再断言 spawnMock 没调用 —— agent schedule 走 fireAgent 不走 exec

    // 模拟 damo/auto_approve: task 转 completed
    updateTaskStatus(taskId, "completed");

    // 下次 tick 应正常 fire（SDK mock 了 query，不会真跑）
    await _tickForTest();
    const after = getScheduleById(schedule.id)!;
    expect(new Date(after.next_run).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("task 软删除 → 下次 tick 正常 fire（模拟「清理僵尸」手动止血）", async () => {
    const schedule = makeAgentScheduleDueNow();
    const taskId = makeReviewingTask(schedule.id);

    await _tickForTest();
    // 0901: 第一次 tick 看到 reviewing → 正常 fire

    // 模拟本地 cron 止血: DELETE 卡死 task
    deleteTask(taskId);

    await _tickForTest();
    const after = getScheduleById(schedule.id)!;
    expect(new Date(after.next_run).getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});