// R3 client 端点解析 + 错误路径单测. 已知覆盖缺口补齐 (0828 run_id bug 当时
// 没被 exec.test.ts 测到: 因为 exec.test.ts mock startExecImpl 不经过真实 HTTP
// 解析). 这里直接 mock fetchImpl 让 client.ts 走完整解析路径.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import {
  startExec,
  streamEvents,
  cancel,
  RunnerHttpError,
} from "./client";
import type { RunnerConnection } from "./types";

// 一个标准 conn (host/port/authToken 来自 DB registry, 这里硬编码够用).
const conn: RunnerConnection = {
  runner: { id: "rid-1", host: "127.0.0.1", port: 18081, os_type: "macos" } as any,
  authToken: "token-abc",
  lastSeen: 0,
  status: "online",
};

// 把 mock Response 包成 client 期望的 shape.
function makeResponse(status: number, body: any, contentType = "application/json"): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("startExec", () => {
  it("🔴 happy path: 解析 daemon 返回的 run_id (snake_case, 跟 wire format 一致)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { run_id: "uuid-xyz" }));
    const r = await startExec(conn, { command: "echo hi", cwd: "/tmp", timeoutMs: 5000 }, {
      reqId: "req-1",
      fetchImpl,
    });
    expect(r.run_id).toBe("uuid-xyz");
  });

  it("🔴 缺 run_id → 抛 'malformed body: missing run_id' (防 run_id/runId 笔误复发)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { runId: "wrong-key" })); // 故意驼峰, daemon 用 snake
    await expect(
      startExec(conn, { command: "echo", cwd: "/tmp", timeoutMs: 5000 }, { reqId: "r", fetchImpl }),
    ).rejects.toThrow(/missing run_id/);
  });

  it("401 → 抛 RunnerHttpError(status=401) (heartbeat 401 错误类型不在这层, 这是 exec 401)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(401, "unauthorized"));
    await expect(
      startExec(conn, { command: "x", cwd: "/tmp", timeoutMs: 1000 }, { reqId: "r", fetchImpl }),
    ).rejects.toBeInstanceOf(RunnerHttpError);
  });

  it("500 → RunnerHttpError 包含 body (调工具能拿到 daemon 报错细节)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(500, "internal: cmd not found"));
    try {
      await startExec(conn, { command: "x", cwd: "/tmp", timeoutMs: 1000 }, { reqId: "r", fetchImpl });
    } catch (e) {
      expect((e as RunnerHttpError).status).toBe(500);
      expect((e as RunnerHttpError).body).toContain("cmd not found");
    }
  });

  it("请求头带 Authorization Bearer + X-Req-Id (调试三件套)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { run_id: "x" }));
    await startExec(conn, { command: "x", cwd: "/tmp", timeoutMs: 1000 }, {
      reqId: "req-trace-1",
      fetchImpl,
    });
    const headers = (fetchImpl as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer token-abc");
    expect(headers["X-Req-Id"]).toBe("req-trace-1");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("请求 body 含 command/cwd/timeout_ms/env (字段名 wire format, 跟 daemon server.go 对齐)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { run_id: "x" }));
    await startExec(
      conn,
      { command: "ls", cwd: "/tmp", timeoutMs: 3000, env: { PATH: "/usr/bin" } },
      { reqId: "r", fetchImpl },
    );
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(body).toEqual({ command: "ls", cwd: "/tmp", timeout_ms: 3000, env: { PATH: "/usr/bin" } });
  });

  it("URL 拼装: host:port + /v1/exec", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, { run_id: "x" }));
    await startExec(conn, { command: "x", cwd: "/tmp", timeoutMs: 1000 }, { reqId: "r", fetchImpl });
    expect((fetchImpl as any).mock.calls[0][0]).toBe("http://127.0.0.1:18081/v1/exec");
  });
});

describe("streamEvents", () => {
  function sseBody(records: string): Response {
    // 把 records (含 \n\n 分隔) 包成 SSE 流
    const encoder = new TextEncoder();
    return new Response(encoder.encode(records), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }) as any;
  }

  // 给一个完整的 exec 序列 (3 帧: stdout, exit) 当 happy path
  const happyFrames = [
    'event: stdout\ndata: {"type":"stdout","data":"hello\\n","ts":1,"req_id":"r"}\n\n',
    'event: exit\ndata: {"type":"exit","exitCode":0,"durationMs":42,"ts":2,"req_id":"r"}\n\n',
  ].join("");

  it("happy path: 手解 SSE → 收 stdout + exit", async () => {
    const fetchImpl = vi.fn(async () => sseBody(happyFrames));
    const events: any[] = [];
    for await (const e of streamEvents(conn, "run-1", { reqId: "r", fetchImpl })) {
      events.push(e);
    }
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: "stdout", data: "hello\n" });
    expect(events[1]).toMatchObject({ type: "exit", exitCode: 0, durationMs: 42 });
  });

  it("跨 chunk 边界: partial 帧 buffer 累积到下一段才 yield (核心关注点)", async () => {
    // 第一帧末尾故意切在中间 (没 \n\n), 模拟 partial chunk
    const partial1 = 'event: stdout\ndata: {"type":"stdout","data":"par';
    const partial2 = 'tial\\n","ts":3,"req_id":"r"}\n\nevent: exit\ndata: {"type":"exit","exitCode":0,"durationMs":1,"ts":4,"req_id":"r"}\n\n';
    // 用 ReadableStream 模拟分两次 push
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partial1));
        controller.enqueue(new TextEncoder().encode(partial2));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const events: any[] = [];
    for await (const e of streamEvents(conn, "run-1", { reqId: "r", fetchImpl })) {
      events.push(e);
    }
    expect(events.length).toBe(2);
    expect(events[0].data).toBe("partial\n");
  });

  it("401 → RunnerHttpError", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(401, "unauthorized"));
    await expect(async () => {
      for await (const _ of streamEvents(conn, "run-1", { reqId: "r", fetchImpl })) {
        // 不会到这
      }
    }).rejects.toBeInstanceOf(RunnerHttpError);
  });

  it("malformed JSON 帧 → error event (不破坏迭代)", async () => {
    const badFrames = 'event: stdout\ndata: {not-json\n\nevent: exit\ndata: {"type":"exit","exitCode":0,"durationMs":1,"ts":5,"req_id":"r"}\n\n';
    const fetchImpl = vi.fn(async () => sseBody(badFrames));
    const events: any[] = [];
    for await (const e of streamEvents(conn, "run-1", { reqId: "r", fetchImpl })) {
      events.push(e);
    }
    expect(events[0].type).toBe("error");
    expect(events[0].message).toMatch(/malformed SSE frame/);
    expect(events[1].type).toBe("exit");
  });

  it("abort signal: 已 abort 的 signal → fetch 阶段直接抛 (abort 入口)", async () => {
    const controller = new AbortController();
    controller.abort(); // 提前 abort
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      // 真实 fetch 行为: signal aborted → 抛 AbortError
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return makeResponse(200, "");
    });
    await expect(async () => {
      for await (const _ of streamEvents(conn, "run-1", { reqId: "r", fetchImpl, signal: controller.signal })) {
        // 不会到这
      }
    }).rejects.toThrow();
    // signal 必须被透传给 fetch
    expect((fetchImpl as any).mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe("cancel", () => {
  it("happy path: 200 → 静默 ok", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, ""));
    await expect(cancel(conn, "run-1", { reqId: "r", fetchImpl })).resolves.toBeUndefined();
  });

  it("404 (run 已结束) → RunnerHttpError (caller 可选择 swallow)", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(404, "run not found"));
    await expect(cancel(conn, "run-1", { reqId: "r", fetchImpl })).rejects.toBeInstanceOf(RunnerHttpError);
  });

  it("URL 拼装 + Authorization", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, ""));
    await cancel(conn, "run-xyz", { reqId: "r", fetchImpl });
    expect((fetchImpl as any).mock.calls[0][0]).toBe("http://127.0.0.1:18081/v1/exec/run-xyz/cancel");
    expect((fetchImpl as any).mock.calls[0][1].headers.Authorization).toBe("Bearer token-abc");
  });
});