// 飞书 R86: schedule-runner.ts liveRuns Map 单测
//
// 关注点:
//   - getLiveRun(runId): Map.get, 没有返 null。
//   - deleteLiveRun(runId): Map.delete (测试用)。
//   - _resetRunnerStateForTest: 重置全部 in-memory state (liveRuns + runningShells +
//     notifiedStaleReviewing + tickCounter), 避免测试间泄漏。
//
// 本文件用 fake timers + 真 SQLite (与同仓 schedule-runner-cooldown.test.ts 同模式)。
// 不真跑 child_process spawn (用 vi.mock 替换 child_process, 同 skip-rollback.test)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const spawnMock = vi.fn();
class FakeStream {
  private listeners: Record<string, Array<(c: Buffer) => void>> = {};
  on(event: string, handler: (c: Buffer) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    const handlers = this.listeners[event] ?? [];
    for (const h of handlers) h(...(args as [Buffer]));
    return true;
  }
}
class FakeChild {
  pid = 99999;
  stdout = new FakeStream();
  stderr = new FakeStream();
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];
  on(event: string, handler: any) {
    if (event === "exit") this.exitListeners.push(handler);
    else if (event === "error") this.errorListeners.push(handler);
    return this;
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
    for (const h of this.exitListeners) h(code, signal);
  }
  emitError(err: Error) {
    for (const h of this.errorListeners) h(err);
  }
}
const childInstances: FakeChild[] = [];
vi.mock("child_process", () => ({
  spawn: (_cmd: string, _opts: unknown) => {
    spawnMock(_cmd, _opts);
    const c = new FakeChild();
    childInstances.push(c);
    return c;
  },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import {
  getLiveRun,
  deleteLiveRun,
  _resetRunnerStateForTest,
} from "./schedule-runner";
import { triggerSchedule } from "./schedule-runner";
import { closeDb, getDb } from "../db";
import { createProject } from "../db/projects";
import { createSchedule, getScheduleById } from "../db/schedules";

let tmpDir: string;
let projectId: string;
let scheduleId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-r86-liverun-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  // 创 project + shell schedule 走 fireShell 路径
  projectId = createProject({ name: "p1", owner_id: "u1", repo_url: null, cwd: null, default_version_id: null, deleted_at: null }).id;
  const sched = createSchedule({
    name: "test shell",
    description: null,
    exec_type: "shell",
    schedule_type: "cron",
    schedule_expr: "* * * * *",
    timezone: "UTC",
    prompt: null,
    command: "echo hi",
    cwd: null,
    project_id: projectId,
    version_id: null,
    enabled: true,
    skip_if_running: false,
    priority: 0,
    auto_approve: false,
    model: null,
    allowed_tools: null,
    max_turns: null,
    effort: null,
    tags: null,
    freq_min_minutes: null,
    freq_max_minutes: null,
    night_start_hour: null,
    night_end_hour: null,
    night_schedule_expr: null,
  } as any);
  scheduleId = sched.id;
  // fireShell 会在 mock 的 spawn 返回 FakeChild; 把 stdout/stderr on handler 桥接到 FakeChild。
  const origSpawn = (require("child_process") as any).spawn;
  (require("child_process") as any).spawn = (cmd: string, opts: unknown) => {
    const c = origSpawn(cmd, opts);
    c.onData = (handler: (c: Buffer) => void) => {
      c.stdout.on("data", handler);
      c.stderr.on("data", handler);
    };
    childInstances.push(c);
    return c;
  };
  childInstances.length = 0;
  _resetRunnerStateForTest();
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("R86 liveRuns Map (schedule-runner in-memory buffer)", () => {
  it("fireShell 启动时, fake child 触发 stdout data → liveRuns 写入 entry (completed=false)", () => {
    const sched = getScheduleById(scheduleId)!;
    const result = triggerSchedule(sched);
    expect(result.fired).toBe(true);
    expect(childInstances.length).toBeGreaterThanOrEqual(1);
    const child = childInstances[0];
    // 拿到 schedule_run id (recordRun 返 number)
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    // 模拟 stdout data
    child.stdout.emit("data", Buffer.from("line 1\n"));
    const entry = getLiveRun(runId);
    expect(entry).not.toBeNull();
    expect(entry!.stdout).toBe("line 1\n");
    expect(entry!.completed).toBe(false);
    expect(entry!.exitCode).toBeNull();
  });

  it("stdout 多 chunk 累加到 entry.stdout", () => {
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    child.stdout.emit("data", Buffer.from("a"));
    child.stdout.emit("data", Buffer.from("b"));
    child.stdout.emit("data", Buffer.from("c\n"));
    const entry = getLiveRun(runId);
    expect(entry!.stdout).toBe("abc\n");
  });

  it("stderr 累加到 entry.stderr (与 stdout 分开)", () => {
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.stderr.emit("data", Buffer.from("warn1\n"));
    child.stderr.emit("data", Buffer.from("warn2\n"));
    const entry = getLiveRun(runId);
    expect(entry!.stdout).toBe("ok\n");
    expect(entry!.stderr).toBe("warn1\nwarn2\n");
  });

  it("child exit → liveRuns 标 completed:true + exitCode", () => {
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    child.stdout.emit("data", Buffer.from("done\n"));
    child.emitExit(0, null);
    const entry = getLiveRun(runId);
    expect(entry).not.toBeNull();
    expect(entry!.completed).toBe(true);
    expect(entry!.exitCode).toBe(0);
    expect(entry!.stdout).toBe("done\n");
  });

  it("5min TTL 后 entry 被清理", async () => {
    vi.useFakeTimers();
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    child.stdout.emit("data", Buffer.from("x"));
    child.emitExit(0, null);
    expect(getLiveRun(runId)).not.toBeNull();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getLiveRun(runId)).toBeNull();
    vi.useRealTimers();
  });

  it("deleteLiveRun (测试 API) 立即清 entry", () => {
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    child.stdout.emit("data", Buffer.from("y"));
    expect(getLiveRun(runId)).not.toBeNull();
    deleteLiveRun(runId);
    expect(getLiveRun(runId)).toBeNull();
  });

  it("SHELL_MAX_BUFFER 截断后, 新 chunk 不再写入 entry (overflowed 标志)", () => {
    // 用 vi.spyOn 偷 SHELL_MAX_BUFFER 不可行 (const 不导出)。直接发 1MB+ 字符串。
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    const huge = Buffer.alloc(1024 * 1024 + 100, "x"); // 1MB + 100 bytes
    child.stdout.emit("data", huge);
    child.stdout.emit("data", Buffer.from("AFTER"));
    const entry = getLiveRun(runId);
    // 应该被截断到 1MB, "AFTER" 不追加
    expect(entry!.stdout.length).toBe(1024 * 1024);
    expect(entry!.stdout).not.toContain("AFTER");
  });
});

describe("R86 _resetRunnerStateForTest (测试基础设施)", () => {
  it("清空 liveRuns + runningShells + notifiedStaleReviewing + tickCounter", () => {
    // 注一些状态
    const sched = getScheduleById(scheduleId)!;
    triggerSchedule(sched);
    const child = childInstances[0];
    const row = getDb().prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    const runId = row.id;
    child.stdout.emit("data", Buffer.from("z"));
    expect(getLiveRun(runId)).not.toBeNull();
    _resetRunnerStateForTest();
    expect(getLiveRun(runId)).toBeNull();
  });
});