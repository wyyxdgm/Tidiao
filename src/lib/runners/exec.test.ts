// R3 executeOnRunner 测试. Mock ./client 替换 startExec/streamEvents/cancel,
//   用 fake ExecEvent 注入数据流.
//
// 关注点:
//   - 正常流: startExec 拿到 runId, streamEvents yield 若干 stdout + 1 exit,
//     返回结构化 ExecResult 含聚合 stdout + exitCode
//   - 超时: opts.timeoutMs 极短 → controller abort → 走 errorMessage 含 'timeout'
//   - 取消: opts.signal 提前 abort → 'caller aborted'
//   - startExec 阶段失败 (network) → errorMessage 'startExec failed: ...', runId=''
//   - 过滤器: env 只挑白名单, AO_TOKEN 等敏感 env 不外泄
//
// Mock 注意点:
//   - exec.ts 期望 streamEvents yield ExecEvent (已经 parseEventFrame 过的),
//     不是 ParsedSseFrame (那是 client 内部的中间形态). mock 直接 yield
//     ExecEvent 跳过 parseEventFrame 这一步 —— 该步由 client.test.ts 另测.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeOnRunner } from "./exec";
import type { ExecEvent, RunnerConnection } from "./types";

const mocks = vi.hoisted(() => ({
  startExecImpl: undefined as
    | ((...args: any[]) => Promise<{ runId: string }>)
    | undefined,
  streamEventsImpl: undefined as
    | ((...args: any[]) => AsyncIterable<any>)
    | undefined,
  cancelImpl: undefined as ((...args: any[]) => Promise<void>) | undefined,
}));

vi.mock("./client", () => ({
  startExec: (...args: any[]) => mocks.startExecImpl!(...args),
  streamEvents: (...args: any[]) => mocks.streamEventsImpl!(...args),
  cancel: (...args: any[]) => mocks.cancelImpl!(...args),
  RunnerHttpError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(`runner HTTP ${status}: ${body}`);
      this.name = "RunnerHttpError";
      this.status = status;
      this.body = body;
    }
  },
}));

function conn(): RunnerConnection {
  return {
    runner: {
      id: "r-1",
      name: "mac-build",
      host: "192.168.3.243",
      port: 8081,
      os_type: "macos",
      status: "online",
      last_heartbeat_at: null,
    },
    authToken: "test-token",
    lastSeenAtMs: Date.now(),
    status: "online",
  };
}

// 构造一个 async iterable 喂 ExecEvent 数组. exec.ts for-await 拿到的是
// ExecEvent (含 type 字段), 不是 ParsedSseFrame (kind/data).
function eventStream(events: ExecEvent[]): AsyncIterable<ExecEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

const HELLO_EVENTS: ExecEvent[] = [
  { type: "stdout", data: "hello\n", ts: 1, reqId: "r1" },
  { type: "stdout", data: "world\n", ts: 2, reqId: "r1" },
  { type: "exit", exitCode: 0, durationMs: 52300, ts: 3, reqId: "r1" },
];

beforeEach(() => {
  mocks.cancelImpl = vi.fn(async () => undefined);
});

describe("executeOnRunner: 正常流", () => {
  it("startExec + streamEvents + exit → 聚合 stdout / stderr / exitCode / duration", async () => {
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-1" }));
    mocks.streamEventsImpl = vi.fn(() => eventStream(HELLO_EVENTS));
    const r = await executeOnRunner(
      conn(),
      "echo hello",
      "/tmp",
      { PATH: "/usr/bin" },
      { reqId: "req-1", timeoutMs: 5000 },
    );
    expect(r.runId).toBe("rid-1");
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBe(52300);
    expect(r.stdout).toBe("hello\nworld\n");
    expect(r.stderr).toBe("");
    expect(r.errored).toBe(false);
  });

  it("stderr 帧聚合到 stderr 字段, 不混入 stdout", async () => {
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-2" }));
    mocks.streamEventsImpl = vi.fn(() =>
      eventStream([
        { type: "stdout", data: "OUT", ts: 1, reqId: "r1" },
        { type: "stderr", data: "ERR", ts: 2, reqId: "r1" },
        { type: "exit", exitCode: 1, durationMs: 100, ts: 3, reqId: "r1" },
      ]),
    );
    const r = await executeOnRunner(
      conn(),
      "fail",
      "/tmp",
      {},
      { reqId: "req-2", timeoutMs: 5000 },
    );
    expect(r.stdout).toBe("OUT");
    expect(r.stderr).toBe("ERR");
    expect(r.exitCode).toBe(1);
  });
});

describe("executeOnRunner: 失败模式", () => {
  it("startExec 抛错 → errorMessage 含 'startExec failed' + runId=''", async () => {
    mocks.startExecImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    mocks.streamEventsImpl = vi.fn(() => eventStream([]));
    const r = await executeOnRunner(
      conn(),
      "echo",
      "/tmp",
      {},
      { reqId: "r", timeoutMs: 5000 },
    );
    expect(r.errored).toBe(true);
    expect(r.runId).toBe("");
    expect(r.errorMessage).toMatch(/startExec failed/);
    expect(r.errorMessage).toMatch(/ECONNREFUSED/);
  });

  it("streamEvents 抛非 abort 错 → errored + 不 cancel", async () => {
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-3" }));
    mocks.streamEventsImpl = vi.fn(async function* () {
      throw new Error("network broken");
    });
    const r = await executeOnRunner(
      conn(),
      "echo",
      "/tmp",
      {},
      { reqId: "r", timeoutMs: 5000 },
    );
    expect(r.errored).toBe(true);
    expect(r.errorMessage).toMatch(/network broken/);
    // 不是 abort, 不调 cancel
    expect(mocks.cancelImpl).not.toHaveBeenCalled();
  });

  it("流中途收到 error 事件 → 记 errorMessage, 但不立即退出 (daemon 后续会 close)", async () => {
    // error 事件后没有 exit, for-await 自然 done (daemon close 连接), 仍
    // 返回 errored=true + exitCode=null (没拿到 exit).
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-4" }));
    mocks.streamEventsImpl = vi.fn(() =>
      eventStream([
        { type: "stdout", data: "partial", ts: 1, reqId: "r1" },
        { type: "error", message: "daemon oom", ts: 2, reqId: "r1" },
      ]),
    );
    const r = await executeOnRunner(
      conn(),
      "echo",
      "/tmp",
      {},
      { reqId: "r", timeoutMs: 5000 },
    );
    expect(r.errored).toBe(true);
    expect(r.errorMessage).toMatch(/daemon oom/);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toBe("partial"); // error 之前的 stdout 仍保留
  });
});

// Hang helper: 永远 wait 直到 signal abort → reject, 模拟 runner daemon 流挂住.
function waitForAbort(opts: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    }
  });
}

describe("executeOnRunner: 超时 / 取消 / idle", () => {
  it("caller signal 中途 abort → errorMessage 'caller aborted' + cancel 被调", async () => {
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-5" }));
    mocks.streamEventsImpl = vi.fn(async function* (
      _c: RunnerConnection,
      _id: string,
      opts: { signal?: AbortSignal },
    ) {
      // 收到 controller.signal (含 caller 串入) 后立即 throw.
      await waitForAbort(opts);
      yield { type: "stdout", data: "x", ts: 1, reqId: "r1" }; // 永远不到
    });

    const callerSignal = new AbortController();
    const promise = executeOnRunner(
      conn(),
      "long",
      "/tmp",
      {},
      { reqId: "r", timeoutMs: 30000, signal: callerSignal.signal },
    );
    // 给 startExec 一点时间先跑完 (setTimeout 0)
    await new Promise((r) => setTimeout(r, 10));
    callerSignal.abort();
    const r = await promise;
    expect(r.errored).toBe(true);
    expect(r.errorMessage).toMatch(/aborted/);
    expect(mocks.cancelImpl).toHaveBeenCalled();
  });

  it("idle-data watchdog: stream 暂停不发新事件 → 触发 idle abort + cancel", async () => {
    // 极短 idle, 默认 30s 不可测. opts.idleTimeoutMs=30.
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-6" }));
    mocks.streamEventsImpl = vi.fn(async function* (
      _c: RunnerConnection,
      _id: string,
      opts: { signal?: AbortSignal },
    ) {
      yield {
        type: "stdout",
        data: "first",
        ts: 1,
        reqId: "r1",
      };
      // 然后 hang — 等 controller.signal (idle/timeout 触发时) 中断.
      await waitForAbort(opts);
      yield { type: "stdout", data: "x", ts: 2, reqId: "r1" };
    });
    const r = await executeOnRunner(
      conn(),
      "hung",
      "/tmp",
      {},
      { reqId: "r", timeoutMs: 30000, idleTimeoutMs: 30 },
    );
    expect(r.errored).toBe(true);
    expect(r.errorMessage).toMatch(/idle/);
    expect(r.stdout).toBe("first");
    expect(mocks.cancelImpl).toHaveBeenCalled();
  });

  it("总 timeout: timeoutMs=30 + stream hang → errorMessage 'timeout'", async () => {
    mocks.startExecImpl = vi.fn(async () => ({ run_id: "rid-7" }));
    mocks.streamEventsImpl = vi.fn(async function* (
      _c: RunnerConnection,
      _id: string,
      opts: { signal?: AbortSignal },
    ) {
      await waitForAbort(opts);
      yield { type: "stdout", data: "x", ts: 1, reqId: "r1" };
    });
    const r = await executeOnRunner(
      conn(),
      "x",
      "/tmp",
      {},
      { reqId: "r", timeoutMs: 30 },
    );
    expect(r.errored).toBe(true);
    expect(r.errorMessage).toMatch(/timeout/);
    expect(mocks.cancelImpl).toHaveBeenCalled();
  });
});

describe("executeOnRunner: env 过滤", () => {
  it("白名单外的 env 不传给 runner (AO_TOKEN / ANTHROPIC_API_KEY 等不外泄)", async () => {
    const startSpy = vi.fn(async () => ({ run_id: "rid-env" }));
    mocks.startExecImpl = startSpy as any;
    mocks.streamEventsImpl = vi.fn(() =>
      eventStream([{ type: "exit", exitCode: 0, durationMs: 1, ts: 1, reqId: "r1" }]),
    );
    await executeOnRunner(
      conn(),
      "echo",
      "/tmp",
      {
        PATH: "/usr/bin",
        HOME: "/home/user",
        USER: "damo",
        AO_TOKEN: "ao_secret_xxx", // 不应出现
        ANTHROPIC_API_KEY: "sk-xxx", // 不应出现
        ANTHROPIC_BASE_URL: "https://example.com", // 不应出现
        MINIMAX_API_KEY: "minimax-xxx", // 不应出现
      },
      { reqId: "r", timeoutMs: 5000 },
    );
    // startExec signature: startExec(conn, req, opts) — req is second arg.
    const callArgs = startSpy.mock.calls[0] as any[];
    const reqArg = callArgs[1] as any;
    const env = reqArg.env as Record<string, string>;
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.USER).toBe("damo");
    expect(env.AO_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.MINIMAX_API_KEY).toBeUndefined();
  });
});