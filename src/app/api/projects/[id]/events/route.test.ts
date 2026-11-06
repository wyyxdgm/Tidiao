// /api/projects/[id]/events 测试.
// 关注点:
//   - 心跳: 每 25s 发 SSE 注释行(": ping"). 该路由曾长期无心跳, pulu nginx
//     proxy_read_timeout 300s 会掐断静默 5 分钟的流, 浏览器报 ERR_HTTP2_PROTOCOL_ERROR.
//   - 事件转发: subscribeToProjectEvents 回调收到的事件原样转发成 data 帧.
//   - 写失败 / abort → 幂等 cleanup: unsubscribe + clearInterval 只走一次, 防订阅泄漏.
//   - 401 / 404 短路不进入 SSE 流.

import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// vi.mock 工厂会被 hoist, top-level 的 vi.fn() 不可引用 —— 用 module 缓存的
// mockState + mockImplementation 在每个 case 里注入 (同 tasks/[id]/stream 测试).
const mockState = {
  subscribe: () => () => {},
  getProjectById: () => ({ id: "p1" }) as any,
  onCleanup: () => {},
};

vi.mock("@/lib/runtime/agent-runtime", () => {
  return {
    getRuntime: () => ({
      subscribeToProjectEvents: (_projectId: string, cb: (e: unknown) => void) =>
        mockState.subscribe(cb),
    }),
  };
});

vi.mock("@/lib/db/projects", () => {
  return {
    getProjectById: (..._args: any[]) => mockState.getProjectById(),
  };
});

import { GET } from "./route";

const projectId = "proj-events-test";
const userId = "u1";

function makeRequest(abortController = new AbortController()): NextRequest {
  return new NextRequest(`http://localhost/api/projects/${projectId}/events`, {
    headers: { "x-user-id": userId },
    signal: abortController.signal,
  });
}

function callGet(req: NextRequest) {
  return GET(req, { params: Promise.resolve({ id: projectId }) });
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockState.subscribe = () => () => {};
  mockState.getProjectById = () => ({ id: "p1" }) as any;
  mockState.onCleanup = () => {};
});

describe("GET /api/projects/[id]/events", () => {
  it("401: 无 x-user-id 直接短路, 不开流", async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/projects/${projectId}/events`),
      { params: Promise.resolve({ id: projectId }) }
    );
    expect(res.status).toBe(401);
  });

  it("404: 非本人项目直接短路, 不开流", async () => {
    mockState.getProjectById = () => null as any;
    const res = await callGet(makeRequest());
    expect(res.status).toBe(404);
  });

  it("开流先发 connected 帧, 事件回调转发成 data 帧", async () => {
    let emit: (e: unknown) => void = () => {};
    mockState.subscribe = (cb: (e: unknown) => void) => {
      emit = cb;
      return () => {};
    };
    const res = await callGet(makeRequest());
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const connected = JSON.parse(
      (await readFrame(reader)).replace(/^data: /, "").trim()
    );
    expect(connected).toEqual({ type: "connected", project_id: projectId });

    emit({ type: "status_change", task_id: "t1" });
    const frame = await readFrame(reader);
    expect(JSON.parse(frame.replace(/^data: /, "").trim())).toEqual({
      type: "status_change",
      task_id: "t1",
    });
    await reader.cancel();
  });

  it("心跳: 每 25s 发一条 ': ping' 注释行保活", async () => {
    vi.useFakeTimers();
    const res = await callGet(makeRequest());
    const reader = res.body!.getReader();

    // 吃掉 connected 帧
    await readFrame(reader);

    const p1 = reader.read();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(new TextDecoder().decode((await p1).value)).toBe(": ping\n\n");

    const p2 = reader.read();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(new TextDecoder().decode((await p2).value)).toBe(": ping\n\n");

    await reader.cancel();
  });

  it("abort → 幂等 cleanup: unsubscribe 恰好调一次, 停心跳", async () => {
    vi.useFakeTimers();
    let unsubCalls = 0;
    mockState.subscribe = () => () => {
      unsubCalls++;
    };
    const abortController = new AbortController();
    const res = await callGet(makeRequest(abortController));
    const reader = res.body!.getReader();
    await readFrame(reader); // connected

    abortController.abort();
    abortController.abort(); // 二次触发也只走一次 cleanup
    expect(unsubCalls).toBe(1);

    // 心跳已停: 再推进 25s 不产生新帧 (读到的是 cancel/close 而非 ping)
    const p = Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await p).not.toBe(": ping\n\n");
    await reader.cancel().catch(() => {});
  });
});
