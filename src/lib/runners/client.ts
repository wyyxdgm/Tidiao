// R3 HTTP client — 与 runner daemon 通信. 协议见 docs/plans/runners.md §Task R2.
//
// 端点:
//   POST /v1/exec                -> { run_id }  (daemon server.go:147)
//   GET  /v1/exec/:id/events     -> SSE 流: stdout/stderr/exit/error
//   POST /v1/exec/:id/cancel     -> 取消运行中子进程 (SIGTERM, 5s 后 SIGKILL)
//
// 关注点:
//   - 手解 SSE 帧, **不**引 EventSource polyfill (Edge runtime safe + 少一
//     个依赖). SSE 帧格式: `event: <kind>\ndata: <text>\n\n`, data 可多行
//     (我们 runner 端只发单行 JSON). 帧间靠空行分隔. partial 帧 (chunk 没
//     切在空行上) 要 buffer 起来等下一段.
//   - 所有请求走 Authorization: Bearer <token>. token 由 caller 从
//     connection.authToken 拿, 客户端不自己 look up (解耦).
//   - fetch 实现可注入 (测试 mock). 默认 globalThis.fetch.

import type {
  ExecEvent,
  ExecRequest,
  ExecStartResponse,
  ParsedSseFrame,
  RunnerConnection,
} from "./types";

/**
 * POST /v1/exec to start a command on the runner. Returns the run_id for
 * streaming events. Throws on transport error / non-2xx (network/auth).
 *
 * 关注点:
 *   - 头部 `X-Req-Id` 来自 caller (canUseTool 入口的 crypto.randomUUID()),
 *     与 SSE event 上的 req_id 字段同源, 调试性贯穿 (rollout §3 调试三件套).
 *   - 抛错让 caller (exec.ts) 决定怎么处理 → 失败走结构化 ExecResult 不抛.
 *   - 不传 timeout 给 fetch: 子进程可能跑很久, timeout 由 exec.ts 顶层
 *     AbortController 控制.
 */
export async function startExec(
  conn: RunnerConnection,
  req: ExecRequest,
  opts: { reqId: string; fetchImpl?: typeof fetch } = { reqId: "" },
): Promise<ExecStartResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `http://${conn.runner.host}:${conn.runner.port}/v1/exec`;
  const authToken = conn.authToken;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      "X-Req-Id": opts.reqId,
    },
    body: JSON.stringify({
      command: req.command,
      cwd: req.cwd,
      timeout_ms: req.timeoutMs,
      env: req.env ?? {},
    }),
  });
  if (!res.ok) {
    // 抛错带状态码, exec.ts 据此生成结构化错误 result.
    const body = await safeReadText(res);
    throw new RunnerHttpError(res.status, body);
  }
  const json = (await res.json()) as ExecStartResponse;
  if (!json || typeof json.run_id !== "string") {
    throw new Error(`runner /v1/exec returned malformed body: missing run_id`);
  }
  return json;
}

/**
 * Subscribe to SSE events for a running command. Returns an async iterable
 * that yields ExecEvent objects. The stream ends after the `exit` (or
 * `error`) frame; consumer is expected to break out and resolve.
 *
 * 关注点:
 *   - hand-parsed SSE: `event: <kind>\ndata: <text>\n\n`. partial 帧靠
 *     buffer 累积, 不做帧内拆分 (单事件 data 都是单行 JSON).
 *   - 不引入 EventSource polyfill (rollout §2 红线).
 *   - 401/403/500 等非 2xx 抛错 (走结构化 ExecResult.errorMessage). 200 但
 *     Content-Type 不是 text/event-stream → 同样抛 (罕见).
 */
export async function* streamEvents(
  conn: RunnerConnection,
  runId: string,
  opts: {
    reqId: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    /**
     * Inject a custom SSE-frame splitter. Used by tests to feed deterministic
     * frames from a string instead of a real ReadableStream. Defaults to
     * the internal splitSseStream helper.
     */
    splitStream?: (
      stream: ReadableStream<Uint8Array>,
    ) => AsyncIterable<ParsedSseFrame>;
  },
): AsyncIterable<ExecEvent> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const split = opts.splitStream ?? defaultSplitSseStream;
  const url = `http://${conn.runner.host}:${conn.runner.port}/v1/exec/${encodeURIComponent(runId)}/events`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${conn.authToken}`,
      "X-Req-Id": opts.reqId,
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await safeReadText(res);
    throw new RunnerHttpError(res.status, body);
  }
  if (!res.body) {
    throw new Error(`runner /v1/exec/${runId}/events returned no body`);
  }
  for await (const frame of split(res.body)) {
    yield parseEventFrame(frame, opts.reqId);
  }
}

/**
 * Cancel a running exec on the daemon. POST /v1/exec/:id/cancel → daemon
 * side SIGTERM (then SIGKILL after 5s). Best-effort: errors are swallowed
 * by canUseTool abort listener (.catch(()=>{})), but we still surface them
 * to caller via throw for tests.
 */
export async function cancel(
  conn: RunnerConnection,
  runId: string,
  opts: { reqId: string; fetchImpl?: typeof fetch } = { reqId: "" },
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `http://${conn.runner.host}:${conn.runner.port}/v1/exec/${encodeURIComponent(runId)}/cancel`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${conn.authToken}`,
      "X-Req-Id": opts.reqId,
    },
  });
  if (!res.ok) {
    const body = await safeReadText(res);
    throw new RunnerHttpError(res.status, body);
  }
}

// ---------- 内部 helper ----------

export class RunnerHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`runner HTTP ${status}: ${body || "(no body)"}`);
    this.name = "RunnerHttpError";
    this.status = status;
    this.body = body;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Parse one SSE frame into an ExecEvent. Tolerates malformed JSON by
 * returning an error event (matches runner wire shape) instead of throwing.
 *
 * 关注点: data 字段是 JSON, 解不出来 → error event 携带 message (给
 * format.ts 一行提示), 不破坏迭代.
 */
function parseEventFrame(frame: ParsedSseFrame, fallbackReqId: string): ExecEvent {
  let parsed: any;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return {
      type: "error",
      message: `malformed SSE frame: ${frame.data.slice(0, 200)}`,
      ts: Date.now(),
      reqId: fallbackReqId,
    };
  }
  const kind = frame.kind || parsed.type;
  const reqId = (parsed.req_id ?? parsed.reqId ?? fallbackReqId) as string;
  const ts = typeof parsed.ts === "number" ? parsed.ts : Date.now();
  if (kind === "stdout" || parsed.type === "stdout") {
    return { type: "stdout", data: String(parsed.data ?? ""), ts, reqId };
  }
  if (kind === "stderr" || parsed.type === "stderr") {
    return { type: "stderr", data: String(parsed.data ?? ""), ts, reqId };
  }
  if (kind === "exit" || parsed.type === "exit") {
    return {
      type: "exit",
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
      durationMs:
        typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      ts,
      reqId,
    };
  }
  if (kind === "error" || parsed.type === "error") {
    return {
      type: "error",
      message: String(parsed.message ?? "runner reported error"),
      ts,
      reqId,
    };
  }
  return {
    type: "error",
    message: `unknown SSE frame kind: ${String(kind)}`,
    ts,
    reqId,
  };
}

/**
 * Default SSE frame splitter. Reads the response body as utf-8 text and
 * splits on `\n\n` (SSE record separator), then parses each record into
 * `event:` and `data:` lines. Tracks a buffer for partial records that
 * straddle chunk boundaries.
 *
 * 关注点:
 *   - SSE spec: a "record" = lines of `event:` / `data:` / `id:` /
 *     `retry:`, terminated by a blank line. We only consume `event:` and
 *     `data:` (others ignored). Comments (lines starting with `:`) ignored.
 *   - One record may have multiple `data:` lines — spec says they get
 *     joined with `\n`. Our runner writes single-line JSON, so this is a
 *     forward-compatible nicety (preserves order if multi-line ever
 *     happens).
 *   - Yields frames in arrival order; no prefetch.
 */
export async function* defaultSplitSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ParsedSseFrame> {
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const record = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const frame = parseSseRecord(record);
        if (frame) yield frame;
      }
    }
    // 末尾 flush: 还有残余 buffer 当作最后一帧处理 (一些 server 实现
    // 不补 trailing blank line).
    if (buffer.trim().length > 0) {
      const frame = parseSseRecord(buffer);
      if (frame) yield frame;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function parseSseRecord(record: string): ParsedSseFrame | null {
  let eventKind: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of record.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue; // 注释/空行跳过
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // SSE spec: leading single space stripped
    if (field === "event") eventKind = value;
    else if (field === "data") dataLines.push(value);
    // 其他 field (id/retry) 忽略
  }
  if (eventKind === null && dataLines.length === 0) return null;
  return {
    kind: eventKind ?? "message",
    data: dataLines.join("\n"),
  };
}