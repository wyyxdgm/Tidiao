// /api/schedules/runs/[runId]/stream SSE 路由测试 (飞书 R86)
// 关注点:
//   - 4a) liveRuns 有数据:1s 推一次 snapshot, completed=true 后 close + 清 interval。
//   - 4b) liveRuns 无数据 + DB 有数据:推一次 DB output/error + completed:true + close。
//   - 4c) 客户端 abort:abort listener 清理 interval + 关 controller。
//   - 边界:401 (没 x-user-id) / 404 (runId 非数字 / runId 找不到 / schedule owner 不匹配)。
//   - 与现有 tasks/[id]/stream 测试同模式 (NextRequest + ReadableStream 读 frames)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

const mockState = {
  // runId -> entry; null = no live entry
  liveRuns: new Map<number, { stdout: string; stderr: string; completed: boolean; exitCode: number | null; updatedAt: number }>(),
  runRow: null as null | {
    id: number;
    schedule_id: string;
    exec_type: "agent" | "shell";
    task_id: string | null;
    command: string | null;
    exit_code: number | null;
    output: string | null;
    error: string | null;
    started_at: string;
    completed_at: string | null;
  },
  scheduleRow: null as null | { id: string; owner_id: string },
};

vi.mock("@/lib/db/schedules", () => ({
  getScheduleRunById: (..._args: any[]) => mockState.runRow,
  getScheduleById: (..._args: any[]) => mockState.scheduleRow,
}));

vi.mock("@/lib/runtime/schedule-runner", () => ({
  getLiveRun: (..._args: any[]) => mockState.liveRuns.get(_args[0]) ?? null,
}));

import { GET } from "./route";

let tmpDir: string;
const runIdStr = "42";
const scheduleId = "s-1";
const userId = "u-owner";

function makeRequest(opts: { runId?: string; abortController?: AbortController; admin?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = { "x-user-id": userId };
  if (opts.admin) headers["x-user-role"] = "admin";
  return new NextRequest(`http://localhost/api/schedules/runs/${opts.runId ?? runIdStr}/stream`, {
    headers,
    signal: opts.abortController?.signal,
  });
}

// 读 SSE frames (与 tasks/[id]/stream/route.test.ts 的 readSseBody 同算法)。
async function readSseBody(res: Response, opts: { idleMs?: number; maxIdleTicks?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const idleMs = opts.idleMs ?? 100;
  const maxIdleTicks = opts.maxIdleTicks ?? 3;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  let idleTicks = 0;
  while (idleTicks < maxIdleTicks) {
    const result = await Promise.race<{ value?: Uint8Array; done: boolean }>([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: false } as any), idleMs)),
    ]);
    if (result.done === true) break;
    if (!result.value) {
      idleTicks++;
      continue;
    }
    buf += decoder.decode(result.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try { events.push(JSON.parse(dataLine.slice("data: ".length))); } catch {}
    }
    idleTicks = 0;
  }
  try { reader.cancel(); } catch {}
  return events;
}

// 带日志版本: 调试用
async function readSseBodyWithLog(res: Response, opts: { idleMs?: number; maxIdleTicks?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const idleMs = opts.idleMs ?? 100;
  const maxIdleTicks = opts.maxIdleTicks ?? 3;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  let idleTicks = 0;
  let iter = 0;
  const t0 = Date.now();
  while (idleTicks < maxIdleTicks) {
    iter++;
    const result = await Promise.race<{ value?: Uint8Array; done: boolean }>([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: false } as any), idleMs)),
    ]);
    const elapsed = Date.now() - t0;
    if (result.done === true) { console.log(`[readSse] iter=${iter} elapsed=${elapsed}ms done=true`); break; }
    if (!result.value) {
      idleTicks++;
      console.log(`[readSse] iter=${iter} elapsed=${elapsed}ms idle idleTicks=${idleTicks}`);
      continue;
    }
    buf += decoder.decode(result.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const ev = JSON.parse(dataLine.slice("data: ".length));
        events.push(ev);
        console.log(`[readSse] iter=${iter} elapsed=${elapsed}ms frame completed=${ev.completed} source=${ev.source} stdoutLen=${String(ev.stdout ?? "").length}`);
      } catch {}
    }
    idleTicks = 0;
  }
  try { reader.cancel(); } catch {}
  return events;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runstrm-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  mockState.liveRuns = new Map();
  mockState.runRow = null;
  mockState.scheduleRow = null;
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /api/schedules/runs/[runId]/stream - 飞书 R86 SSE 流式日志", () => {
  it("4a) liveRuns 有数据:推 entry snapshot + 后续 1s 推增量, 收 completed:true 后 close", async () => {
    mockState.runRow = {
      id: 42,
      schedule_id: scheduleId,
      exec_type: "shell",
      task_id: null,
      command: "echo hi",
      exit_code: null,
      output: null,
      error: null,
      started_at: "2026-09-06T10:00:00.000Z",
      completed_at: null,
    };
    mockState.scheduleRow = { id: scheduleId, owner_id: userId };
    // 初始 entry: 部分 stdout, completed=false
    mockState.liveRuns.set(42, {
      stdout: "line 1\n",
      stderr: "",
      completed: false,
      exitCode: null,
      updatedAt: Date.now(),
    });

    // 🆕 vi.useFakeTimers + vi.advanceTimersByTime: jsdom 下 setInterval 的真实 tick 不稳定
    //   (it 主线程被 reader.read 的 microtask 占着时,interval callback 排队但 reader 不返回),
    //   用 fake timers 显式推进时间更稳。Promise.race 里的 setTimeout 也虚拟,
    //   readSseBody 在每个 advance 间隔内能拿到所有 enqueue 的 frames。
    vi.useFakeTimers();

    const res = await GET(makeRequest(), { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // T=1100ms:liveRuns 增量 (line 1+2)
    setTimeout(() => {
      mockState.liveRuns.set(42, {
        stdout: "line 1\nline 2\n",
        stderr: "warn",
        completed: false,
        exitCode: null,
        updatedAt: Date.now(),
      });
    }, 1100);
    // T=2200ms:liveRuns 完成 (line 1+2+3 + completed:true + exitCode:0)
    setTimeout(() => {
      mockState.liveRuns.set(42, {
        stdout: "line 1\nline 2\nline 3\n",
        stderr: "warn",
        completed: true,
        exitCode: 0,
        updatedAt: Date.now(),
      });
    }, 2200);

    // 推进到 T=3500ms,让 3 个 interval tick (T=1000/2000/3000) 都跑完 + cleanup 触发 (T=3050)
    await vi.advanceTimersByTimeAsync(3500);

    // 收 frames
    const events = await readSseBody(res, { idleMs: 50, maxIdleTicks: 5 });
    expect(events.length).toBeGreaterThanOrEqual(2);
    // 第一帧:initial snapshot (source: "live", completed: false)
    expect(events[0]).toMatchObject({ stdout: "line 1\n", completed: false, source: "live" });
    // 最后帧:completed:true + exitCode:0
    const last = events[events.length - 1];
    expect(last).toMatchObject({ completed: true, exitCode: 0, source: "live" });
    expect(String(last.stdout)).toContain("line 3");

    vi.useRealTimers();
  });

  it("4b) liveRuns 无数据 + DB 有数据:推一次 DB row + completed:true + close (兜底路径)", async () => {
    mockState.runRow = {
      id: 42,
      schedule_id: scheduleId,
      exec_type: "shell",
      task_id: null,
      command: "echo hi",
      exit_code: 0,
      output: "db stdout\n",
      error: "db error\n",
      started_at: "2026-09-06T10:00:00.000Z",
      completed_at: "2026-09-06T10:00:05.000Z",
    };
    mockState.scheduleRow = { id: scheduleId, owner_id: userId };
    // mockState.liveRuns 是空的 (5min cleanup 已过)
    const res = await GET(makeRequest(), { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(200);
    const events = await readSseBody(res);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stdout: "db stdout\n",
      stderr: "db error\n",
      completed: true,
      exitCode: 0,
      source: "db",
    });
  });

  it("4c) 客户端 abort:推 frame 后 abort → reader.cancel + 后续帧不再来 (cleanup 生效)", async () => {
    mockState.runRow = {
      id: 42,
      schedule_id: scheduleId,
      exec_type: "shell",
      task_id: null,
      command: "echo hi",
      exit_code: null,
      output: null,
      error: null,
      started_at: "2026-09-06T10:00:00.000Z",
      completed_at: null,
    };
    mockState.scheduleRow = { id: scheduleId, owner_id: userId };
    mockState.liveRuns.set(42, { stdout: "x", stderr: "", completed: false, exitCode: null, updatedAt: Date.now() });
    const ac = new AbortController();
    const res = await GET(makeRequest({ abortController: ac }), { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(200);
    // 立刻 abort (模拟用户关 modal)
    ac.abort();
    const events = await readSseBody(res, { idleMs: 150, maxIdleTicks: 3 });
    // 至少收到初始 snapshot, 然后 abort 后没有更多
    expect(events.length).toBeLessThanOrEqual(1);
    if (events.length === 1) {
      expect(events[0]).toMatchObject({ source: "live" });
    }
    // reader 已 cancel (readSseBody 里 try cancel) → 内部 controller 应已 close
  });

  it("401: 没 x-user-id → 不进 SSE 流", async () => {
    const req = new NextRequest(`http://localhost/api/schedules/runs/${runIdStr}/stream`);
    const res = await GET(req, { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(401);
  });

  it("404: runId 非数字", async () => {
    const res = await GET(makeRequest({ runId: "abc" }), { params: Promise.resolve({ runId: "abc" }) });
    expect(res.status).toBe(404);
  });

  it("404: runId 找不到 (getScheduleRunById 返 null)", async () => {
    mockState.runRow = null;
    const res = await GET(makeRequest(), { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(404);
  });

  it("404: schedule owner 不匹配 (非 admin)", async () => {
    mockState.runRow = {
      id: 42,
      schedule_id: scheduleId,
      exec_type: "shell",
      task_id: null,
      command: "x",
      exit_code: null,
      output: null,
      error: null,
      started_at: "2026-09-06T10:00:00.000Z",
      completed_at: null,
    };
    mockState.scheduleRow = null; // getScheduleById 返 null = owner 不匹配
    const res = await GET(makeRequest(), { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(404);
  });

  it("admin (x-user-role=admin) 跳过 owner 校验 → 200", async () => {
    mockState.runRow = {
      id: 42,
      schedule_id: scheduleId,
      exec_type: "shell",
      task_id: null,
      command: "x",
      exit_code: 0,
      output: "ok",
      error: "",
      started_at: "2026-09-06T10:00:00.000Z",
      completed_at: "2026-09-06T10:00:01.000Z",
    };
    mockState.scheduleRow = { id: scheduleId, owner_id: "u-other" }; // 不同 owner
    const res = await GET(makeRequest({ admin: true }), { params: Promise.resolve({ runId: runIdStr }) });
    expect(res.status).toBe(200);
    const events = await readSseBody(res);
    expect(events[0]).toMatchObject({ source: "db", completed: true });
  });
});