// 0906 平台 P0 回归：fireShell 改用 spawn detached + 杀进程组 + timeout 冷却
//
// 事故: 原版 fireShell 用 child_process.exec(无 detached), Node 只持 wrapper pid;
//   timeout 发 SIGTERM 只杀 wrapper, wrapper fork 的 sheetwatch/python 变孤儿
//   继续跑 -> 下 tick skip_if_running 失效 -> 再 fire -> 多孤儿并发 26 分钟
//   误派 295 条 task。详见 docs/fixes/2026-09-06-sheetwatch-misdispatch-295.md
//
// 本测试三道防线:
//   ① spawn 调用形态正确: detached:true + shell:true + stdio 三管道
//   ② exit 信号语义: SIGTERM/SIGKILL 一律映射成 124(timeout), 正常 exit code 透传
//   ③ timeout 冷却: exit 走 124 路径时, schedule.next_run 被推到现在+2h,
//      正常 exit 不动 next_run(避免错过正常调度)
//   ④ spawn error(spawn 阶段失败): finalize(1) 且不动 next_run
//
// 真 SQLite + 真 schedules/tasks; child_process.spawn 用 fake child(可手动 emit exit/error)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// FakeChild 升级版: 记录所有 .on() 注册的 (event, cb), 测试可手动 emit。
// 原 schedule-reentry-guard 那版只 stub .on() 不记录, 只能验证 "调用 spawn 了"，
// 这里要验证 exit 事件路径必须捕获 cb。
type ChildEventCb = (...args: unknown[]) => void;
const spawnMock = vi.fn();
let lastChild: FakeChild | null = null;
class FakeStream {
  private dataCbs: ChildEventCb[] = [];
  on(event: string, cb: ChildEventCb): this {
    if (event === "data") this.dataCbs.push(cb);
    return this;
  }
  // 测 stdout/stderr 累加逻辑时用（这里 cooldown 测试不依赖 data 路径, 留着备用）
  emitData(chunk: Buffer): void {
    for (const cb of this.dataCbs) cb(chunk);
  }
}
class FakeChild {
  pid = 99999;
  stdout = new FakeStream();
  stderr = new FakeStream();
  private listeners: Record<string, ChildEventCb[]> = {};
  on(event: string, cb: ChildEventCb): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const cb of this.listeners["exit"] ?? []) cb(code, signal);
  }
  emitError(err: Error): void {
    for (const cb of this.listeners["error"] ?? []) cb(err);
  }
}
vi.mock("child_process", () => ({
  spawn: (_cmd: string, _opts: unknown) => {
    spawnMock(_cmd, _opts);
    lastChild = new FakeChild();
    return lastChild;
  },
}));

// 这里不跑 agent schedule, SDK mock 仅为满足模块导入
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { triggerSchedule } from "./schedule-runner";
import { getDb, closeDb } from "../db";
import { createSchedule, getScheduleById } from "../db/schedules";
import { ORCHESTRATOR_HOME } from "../constants";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cooldown-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();
  spawnMock.mockClear();
  lastChild = null;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeShellSchedule() {
  return createSchedule({
    name: "p0-cooldown",
    exec_type: "shell",
    command: "bash /tmp/whatever.sh",
    schedule_type: "cron",
    schedule_expr: "*/5 * * * *",
    // 推进 next_run 到下一槽位, 避免 runner tick 也来抢
    enabled: false,
  });
}

function getLastChild(): FakeChild {
  // schedule-runner triggerSchedule 同步调 fireShell, fireShell 同步 spawn,
  // 所以 triggerSchedule 返回时 spawnMock.calls.length == 1 + lastChild 已落
  expect(spawnMock).toHaveBeenCalledTimes(1);
  if (!lastChild) throw new Error("lastChild not captured — spawn mock factory didn't run");
  return lastChild;
}

describe("fireShell spawn detached: 调用形态", () => {
  it("spawn(cmd, { detached:true, shell:true, stdio 三管道, cwd })", () => {
    const s = makeShellSchedule();
    const r = triggerSchedule(getScheduleById(s.id)!);
    expect(r.fired).toBe(true);
    const [, opts] = spawnMock.mock.calls[0]! as [string, Record<string, unknown>];
    expect(opts.detached).toBe(true);
    expect(opts.shell).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(opts.cwd).toBe(s.cwd ?? ORCHESTRATOR_HOME);
    // 不消费, 收掉 silent fake child, 别让 Node 报 EventEmitter leak 警告
    getLastChild().emitExit(0, null);
  });
});

describe("fireShell exit 路径: 正常 exit code 不动 next_run", () => {
  it("exit(0, null) → 不推 next_run, schedule_runs.exit_code = 0", () => {
    const s = makeShellSchedule();
    const before = getScheduleById(s.id)!.next_run;
    const r = triggerSchedule(getScheduleById(s.id)!);
    expect(r.fired).toBe(true);
    const child = getLastChild();
    child.emitExit(0, null);
    // next_run 没动
    expect(getScheduleById(s.id)!.next_run).toBe(before);
    // schedule_runs 落了 exit_code=0
    const run = getDb()
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1")
      .get(s.id) as { exit_code: number | null } | undefined;
    expect(run?.exit_code).toBe(0);
  });

  it("exit(1, null) → exit_code=1 透传, 仍不动 next_run(非 124 不冷却)", () => {
    const s = makeShellSchedule();
    const before = getScheduleById(s.id)!.next_run;
    triggerSchedule(getScheduleById(s.id)!);
    getLastChild().emitExit(1, null);
    expect(getScheduleById(s.id)!.next_run).toBe(before);
    const run = getDb()
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1")
      .get(s.id) as { exit_code: number | null } | undefined;
    expect(run?.exit_code).toBe(1);
  });
});

describe("fireShell 冷却: 被信号杀的 exit 一律映射 124 + 推 next_run 2h", () => {
  it("exit(null, SIGTERM) → exit_code=124 + next_run 推到 ~2h 后", async () => {
    const s = makeShellSchedule();
    const before = getScheduleById(s.id)!.next_run;
    triggerSchedule(getScheduleById(s.id)!);
    const child = getLastChild();
    const t0 = Date.now();
    child.emitExit(null, "SIGTERM");
    // 让 finalize 里的 finishRun / pushScheduleNextRun 落库完成
    await new Promise((r) => setTimeout(r, 10));

    const after = getScheduleById(s.id)!.next_run;
    expect(after).not.toBe(before);
    // 推后 ~2h, 允许 ±5s 抖动
    const pushedMs = new Date(after).getTime() - t0;
    expect(pushedMs).toBeGreaterThanOrEqual(2 * 3600 * 1000 - 5_000);
    expect(pushedMs).toBeLessThanOrEqual(2 * 3600 * 1000 + 5_000);

    const run = getDb()
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1")
      .get(s.id) as { exit_code: number | null; completed_at: string | null } | undefined;
    expect(run?.exit_code).toBe(124);
    expect(run?.completed_at).not.toBeNull();
  });

  it("exit(null, SIGKILL) → 同样映射 124 + 冷却(grace 2s 后兜底也算 timeout)", async () => {
    const s = makeShellSchedule();
    const before = getScheduleById(s.id)!.next_run;
    triggerSchedule(getScheduleById(s.id)!);
    getLastChild().emitExit(null, "SIGKILL");
    await new Promise((r) => setTimeout(r, 10));
    expect(getScheduleById(s.id)!.next_run).not.toBe(before);
    const run = getDb()
      .prepare("SELECT exit_code FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1")
      .get(s.id) as { exit_code: number | null } | undefined;
    expect(run?.exit_code).toBe(124);
  });
});

describe("fireShell spawn error 路径: 命令不存在/cwd 错 → finalize(1) 不冷却", () => {
  it("error 事件 → exit_code=1 + 不推 next_run(spawn 阶段失败不算 timeout)", async () => {
    const s = makeShellSchedule();
    const before = getScheduleById(s.id)!.next_run;
    triggerSchedule(getScheduleById(s.id)!);
    getLastChild().emitError(new Error("spawn ENOENT"));
    await new Promise((r) => setTimeout(r, 10));
    expect(getScheduleById(s.id)!.next_run).toBe(before);
    const run = getDb()
      .prepare("SELECT exit_code FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1")
      .get(s.id) as { exit_code: number | null } | undefined;
    expect(run?.exit_code).toBe(1);
  });
});

describe("fireShell runningShells 闸门: fireShell 返回后 schedule.id 立刻从 runningShells 移除", () => {
  it("exit(0) 后 triggerSchedule 立即能再 fire(skip_if_running 不应误判在跑)", () => {
    // triggerSchedule 走的是 _tickForTest 同一条路径, 这里手动 triggerSchedule
    // 模拟「上一轮刚退出, 下一轮 60s 后 tick 来了」—— runningShells 已清理
    const s = makeShellSchedule();
    s.skip_if_running = true; // 强制开闸门
    getDb()
      .prepare("UPDATE schedules SET skip_if_running = 1 WHERE id = ?")
      .run(s.id);
    triggerSchedule(getScheduleById(s.id)!);
    getLastChild().emitExit(0, null);
    // 第二次 trigger: 上次已退出, 不该被 runningShells 挡
    spawnMock.mockClear();
    const r2 = triggerSchedule(getScheduleById(s.id)!);
    expect(r2.fired).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    getLastChild().emitExit(0, null);
  });
});
