// /api/tasks/[id]/stream 测试.
// 关注点:
//   - running 中刷新页面 / 断线重连 → 兜底补一条合成 status_change 事件, 带 started_at
//     和 timeout_ms. 这俩字段只活在 SSE 直播流 (emitEvent 在 transition 时塞), 不进
//     events 表. 历史回放只发 type==="history", 客户端不识别 → anchor 永远是 null →
//     meta-row 不渲染「剩余」. 真实 bug: 用户 running 中刷新看不到倒计时.
//   - 非 running (paused / completed / reviewing / failed / ...) → 不追加.
//   - running 但 started_at 为 NULL (理论上不会, 防御) → 不追加.
//   - 401 / 404 短路不进入 SSE 流.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

// vi.mock 工厂会被 hoist, top-level 的 vi.fn() 不可引用 —— 必须在工厂里现建.
// 但其它测试要重置 / 注入返回值, 用 module 缓存的引用. 解决办法: 用全局变量 +
// mockImplementation 在每个 case 里改 (vi.fn 返回 stable handle).
const mockState = {
  subscribe: () => () => {},
  getEvents: () => [] as any[],
  resolveTaskTimeoutMs: () => 1800_000 as number,
};

vi.mock("@/lib/runtime/agent-runtime", () => {
  return {
    getRuntime: () => ({
      subscribeToEvents: (..._args: any[]) => mockState.subscribe(),
      getEvents: (..._args: any[]) => mockState.getEvents(),
    }),
    resolveTaskTimeoutMs: (..._args: any[]) => mockState.resolveTaskTimeoutMs(),
  };
});

vi.mock("@/lib/db/tasks", () => {
  return {
    getTaskById: (..._args: any[]) => mockState.getTaskById(),
  };
});

import { GET } from "./route";

let tmpDir: string;
const taskId = "task-stream-test";
const userId = "u1";

function makeRequest(abortController = new AbortController()): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${taskId}/stream`, {
    headers: { "x-user-id": userId },
    signal: abortController.signal,
  });
}

async function readSseBody(res: Response): Promise<Array<Record<string, unknown>>> {
  // route 的 start() 同步 enqueue 了所有初始帧 (connected + history + 可能的 anchor),
  // 然后 setInterval(25s) 心跳, signal listener 等 abort. 测试只关心初始帧, 用 race
  // + sleep(150) 短路: 拿不到新帧就退出 + reader.cancel() 让 route 走 cleanup.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  let idleTicks = 0;
  while (idleTicks < 2) {
    const result = await Promise.race<{ value?: Uint8Array; done: boolean }>([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: false } as any), 150)),
    ]);
    if (!result || (result as any).done === undefined) {
      // sleep 分支赢
      idleTicks++;
      continue;
    }
    if (result.done) break;
    if (result.value) {
      buf += decoder.decode(result.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          events.push(JSON.parse(dataLine.slice("data: ".length)));
        } catch {
          // ping 行之类
        }
      }
      idleTicks = 0;
    } else {
      idleTicks++;
    }
  }
  try { reader.cancel(); } catch {}
  return events;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-stream-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  // 重置 mockState 默认值 (paused: 不发 anchor)
  mockState.subscribe = () => () => {};
  mockState.getEvents = () => [];
  mockState.resolveTaskTimeoutMs = () => 1800_000;
  // 默认 getTaskById 返 null (ownership gate 失败 → 404, 但 anchor 测试需要它返 task)
  mockState.getTaskById = () => null;
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /api/tasks/[id]/stream - running anchor 兜底", () => {
  it("running + 有 started_at → 追加合成 status_change 带 started_at + timeout_ms", async () => {
    const runningTask = {
      id: taskId,
      status: "running",
      started_at: "2026-08-22T10:00:00.000Z",
      project_id: null,
      metadata: null,
    };
    mockState.getTaskById = () => runningTask;

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await readSseBody(res);
    const anchor = events.find((e) => e.type === "status_change");
    expect(anchor).toBeTruthy();
    expect(anchor!.started_at).toBe("2026-08-22T10:00:00.000Z");
    expect(anchor!.timeout_ms).toBe(1800_000);
    expect(anchor!.from).toBe("running");
    expect(anchor!.to).toBe("running");
    expect(anchor!.source).toBe("auto");
  });

  it("paused → 不追加合成 status_change", async () => {
    mockState.getTaskById = () => ({
      id: taskId,
      status: "paused",
      started_at: "2026-08-22T10:00:00.000Z",
      project_id: null,
      metadata: null,
    });
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    const events = await readSseBody(res);
    expect(events.map((e) => e.type)).toEqual(["connected"]);
  });

  it("completed → 不追加合成 status_change", async () => {
    mockState.getTaskById = () => ({
      id: taskId,
      status: "completed",
      started_at: null,
      project_id: null,
      metadata: null,
    });
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    const events = await readSseBody(res);
    expect(events.map((e) => e.type)).toEqual(["connected"]);
  });

  it("running 但 started_at 为 NULL (防御性) → 不追加", async () => {
    mockState.getTaskById = () => ({
      id: taskId,
      status: "running",
      started_at: null,
      project_id: null,
      metadata: null,
    });
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    const events = await readSseBody(res);
    expect(events.map((e) => e.type)).toEqual(["connected"]);
  });

  it("没 x-user-id → 401, 不进 SSE 流", async () => {
    const req = new NextRequest(`http://localhost/api/tasks/${taskId}/stream`);
    const res = await GET(req, { params: Promise.resolve({ id: taskId }) });
    expect(res.status).toBe(401);
  });

  it("ownership gate: getTaskById 返 null → 404", async () => {
    mockState.getTaskById = () => null;
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    expect(res.status).toBe(404);
  });

  it("resolveTaskTimeoutMs 实际被调用, 返回值进 anchor.timeout_ms (per-task override)", async () => {
    const runningTask = {
      id: taskId,
      status: "running",
      started_at: "2026-08-22T10:00:00.000Z",
      project_id: "p1",
      metadata: JSON.stringify({ timeout_minutes: 60 }),
    };
    mockState.getTaskById = () => runningTask;
    mockState.resolveTaskTimeoutMs = () => 3600_000; // 60 min override 解析结果

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    const events = await readSseBody(res);
    const anchor = events.find((e) => e.type === "status_change");
    expect(anchor!.timeout_ms).toBe(3600_000);
  });

  it("events 表里有历史 status_change → 走 history 帧 + 仍追加 anchor", async () => {
    mockState.getTaskById = () => ({
      id: taskId,
      status: "running",
      started_at: "2026-08-22T10:00:00.000Z",
      project_id: null,
      metadata: null,
    });
    mockState.getEvents = () => [
      { id: 1, task_id: taskId, type: "status_change", data: '{"from":"pending","to":"running"}', session_id: null, created_at: "2026-08-22T10:00:00.000Z" },
      { id: 2, task_id: taskId, type: "message", data: '{"role":"user","text":"hi"}', session_id: "s1", created_at: "2026-08-22T10:00:01.000Z" },
    ];
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: taskId }) });
    const events = await readSseBody(res);
    expect(events.map((e) => e.type)).toEqual(["connected", "history", "history", "status_change"]);
    const anchor = events.find((e) => e.type === "status_change");
    expect(anchor!.started_at).toBe("2026-08-22T10:00:00.000Z");
  });
});
