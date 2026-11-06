// 定时任务防重派闸门（v2-p0-loop 事故回归）
//
// 事故: 一个 shell 类定时任务每 10 分钟派同一件事, 5 天造了 604 个 task、烧 $206。
// 两个原因叠在一起 ——
//   ① 闸门只看 schedule.last_task_id, 而 shell 类的 task 是脚本自己走 POST /api/tasks
//      建的, runner 从不写 last_task_id -> 对 shell 等于没有闸门;
//   ② 判据只认 running/queued, 而任务干完落在 reviewing（等人验收）-> 就算认了
//      last_task_id 也照样判成「没派过」。
// 所以下面每条断言都盯着这两点: 判据走 tasks.schedule_id 反查 + reviewing 算「在飞」。
//
// 真 SQLite + 真 schedules/tasks 表；只有 child_process.exec 和 SDK 是假的。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// spawn 必须假掉: 否则 shell 类触发会真去跑命令, 且 child.on("exit") 在测试结束后写已关闭的 DB。
// 只记录被调用, 永不 emit exit/error(stub 返回的 fake child 不挂任何 listener 时就沉默)。
// 🆕 damo 0906: fireShell 从 exec 改成 spawn detached;mock 也跟着换。
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

// schedule-runner -> agent-runtime -> SDK: 这里不跑 agent 类触发, 只为满足模块导入。
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { triggerSchedule } from "./schedule-runner";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createSchedule, getScheduleById } from "../db/schedules";
import {
  createTask,
  updateTaskStatus,
  deleteTask,
  getUnfinishedTaskBySchedule,
} from "../db/tasks";
import type { TaskStatus } from "./types";

let tmpDir: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sched-guard-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // 跑全部 migration（含 v37 建 idx_tasks_schedule）
  projectId = createProject({ name: "sched-guard-project" }).id;
  spawnMock.mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 建一条 shell 定时任务（事故的形态: cron */10 + skip_if_running）
function makeShellSchedule(opts?: { skip_if_running?: boolean }) {
  return createSchedule({
    name: "p0-loop",
    exec_type: "shell",
    command: "bash /tmp/p0-loop.sh",
    schedule_type: "cron",
    schedule_expr: "*/10 * * * *",
    skip_if_running: opts?.skip_if_running,
  });
}

// 模拟「shell 脚本走 POST /api/tasks 自建 task」并把它推到某个状态
function makeTask(status: TaskStatus, scheduleId?: string): string {
  const task = createTask({
    title: "P0-2 顶导改蓝色实色通栏",
    prompt: "改顶导",
    project_id: projectId,
    schedule_id: scheduleId,
  });
  if (status !== "pending") updateTaskStatus(task.id, status);
  return task.id;
}

describe("防重派闸门: shell 类定时任务", () => {
  it("上一次派出的任务在 reviewing -> 不再触发（事故本体）", () => {
    const schedule = makeShellSchedule();
    const taskId = makeTask("reviewing", schedule.id);

    const result = triggerSchedule(getScheduleById(schedule.id)!);

    expect(result.fired).toBe(false);
    expect(result.reason).toContain(taskId);
    expect(result.reason).toContain("reviewing");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("paused / rejected 同样算「在飞」", () => {
    for (const status of ["paused", "rejected"] as TaskStatus[]) {
      const schedule = makeShellSchedule();
      makeTask(status, schedule.id);
      expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(false);
    }
  });

  it("上一次的任务 completed -> 正常触发下一次", () => {
    const schedule = makeShellSchedule();
    makeTask("completed", schedule.id);

    expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("failed 也算了结（允许重试）", () => {
    const schedule = makeShellSchedule();
    makeTask("failed", schedule.id);
    expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(true);
  });

  it("skip_if_running=0 是逃生口: 有在飞任务也照样触发", () => {
    const schedule = makeShellSchedule({ skip_if_running: false });
    makeTask("reviewing", schedule.id);
    expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(true);
  });

  it("僵尸任务被软删除后, 卡住的 schedule 自动解开", () => {
    const schedule = makeShellSchedule();
    const taskId = makeTask("reviewing", schedule.id);
    expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(false);

    deleteTask(taskId);

    expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(true);
  });

  it("脚本没传 schedule_id -> 平台依旧看不见（闸门的前提, 写死以防误以为已覆盖）", () => {
    const schedule = makeShellSchedule();
    makeTask("reviewing"); // 无 schedule_id: 事故当时 p0.log 里就是 "schedule_id":null

    expect(getUnfinishedTaskBySchedule(schedule.id)).toBeNull();
    expect(triggerSchedule(getScheduleById(schedule.id)!).fired).toBe(true);
  });
});

describe("防重派闸门: agent 类定时任务", () => {
  it("queued/running 仍然挡住（原有行为不回退）", () => {
    const schedule = createSchedule({
      name: "每日巡检",
      exec_type: "agent",
      title: "巡检",
      prompt: "检查状态",
      project_id: projectId,
      schedule_type: "cron",
      schedule_expr: "0 9 * * *",
    });
    makeTask("queued", schedule.id);

    const result = triggerSchedule(getScheduleById(schedule.id)!);
    expect(result.fired).toBe(false);
    expect(result.reason).toContain("queued");
  });
});
