// R3 平台客户端 + canUseTool 拦截的类型 — 协议见 docs/plans/runners.md §Task R3.
//
// 关注点:
//   - RunnerConnection = 内存里的 Connection (decrypt 出来的 token + host/port 等),
//     由 registry.ts 启动时从 DB 加载 + heartbeat tick 标 offline/dead.
//   - ExecRequest / ExecEvent / ExecResult 是平台与 daemon 之间的 wire shape,
//     与 runner 端 HTTP+SSE body 一一对应. ExecResult 是平台内部的聚合结果
//     (streamEvents 把 stdout/stderr 拼好 + exit/duration).

/**
 * In-memory snapshot of a runner row + decrypted auth token. Built by
 * registry.ts on init from `runners` table. Never persisted — the token is
 * plaintext only in memory, sourced via decrypt() at startup.
 *
 * `lastSeenAtMs` is wall-clock-ms at the last observed heartbeat (via
 * registry's tick). Null = no heartbeat ever observed (e.g. fresh install).
 */
export interface RunnerConnection {
  runner: RunnerRow;
  /** Decrypted bearer token, used as Authorization: Bearer header on POST /v1/exec etc. */
  authToken: string;
  /** Wall-clock ms of the most recent heartbeat. null = never seen. */
  lastSeenAtMs: number | null;
  /** Status mirrored from DB; registry tick overrides it based on heartbeat freshness. */
  status: RunnerStatus;
}

/** Mirrors `runners` table SELECT shape (id/name/host/port/os_type/status/...). */
export interface RunnerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  os_type: "macos" | "windows" | "linux";
  status: RunnerStatus;
  last_heartbeat_at: string | null;
}

/** Runner status values — see src/lib/db/runners.ts RUNNER_STATUSES. */
export type RunnerStatus = "online" | "offline" | "dead";

/** Body sent to POST /v1/exec on the runner daemon. */
export interface ExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

/** Response from POST /v1/exec: a server-side run id, returned immediately while
 *  the daemon starts the subprocess. Events arrive via GET /v1/exec/:id/events.
 *  Wire field = run_id (snake_case, daemon server.go:147 + runners.md §协议 v1);
 *  other fields on this wire interface stay snake_case for consistency. */
export interface ExecStartResponse {
  run_id: string;
}

/** One SSE event frame from GET /v1/exec/:id/events. Matches runner wire shape
 *  in docs/plans/runners.md §Task R2. */
export type ExecEvent =
  | { type: "stdout"; data: string; ts: number; reqId: string }
  | { type: "stderr"; data: string; ts: number; reqId: string }
  | { type: "exit"; exitCode: number; durationMs: number; ts: number; reqId: string }
  | { type: "error"; message: string; ts: number; reqId: string };

/** Aggregated result from executing one command on a runner. Produced by exec.ts. */
export interface ExecResult {
  runId: string;
  stdout: string;
  stderr: string;
  /** Final exit code. 0 on graceful exit, non-zero on error. May be null when
   *  the daemon stream ended with `error` (network abort / daemon kill) before
   *  emitting an `exit` frame. */
  exitCode: number | null;
  /** Wall-clock duration reported by the daemon's `exit` frame, ms. Null when
   *  no exit frame arrived. */
  durationMs: number | null;
  /** Stable req_id used end-to-end (platform → daemon header → SSE req_id field
   *  → formatExecResult prefix). Useful for grep'ing logs across hops. */
  reqId: string;
  /** Error flag: true when stream ended with `error` event or aborted by
   *  timeout/cancel. Lets format.ts include a hint line. */
  errored: boolean;
  /** Free-form error message when errored=true (e.g. timeout/cancel/stream error). */
  errorMessage: string | null;
}

/**
 * Resolved routing decision for a Bash invocation. Returned by
 * resolveRunnerRoute().
 *
 * - `null` = no whitelist hit → caller falls through to local SDK Bash.
 * - `{ runner: null, reason }` = whitelist hit but runner offline/dead → caller
 *   denies with reason (no silent fallback to local exec — see risk #2 in
 *   docs/plans/runners.md).
 * - `{ runner, execOpts }` = whitelist hit + runner online → caller executes on
 *   the runner.
 *
 * `runId` is filled in by canUseTool AFTER startExec() returns; the abort
 * listener uses it to call client.cancel() if pause/cancel fires mid-exec.
 */
export type RouteResolution =
  | null
  | { runner: null; reason: string; cwdMapping?: undefined }
  | {
      runner: RunnerConnection;
      /** Runner-side cwd (project.runners[].cwd_mapping). */
      cwdMapping: string;
      /** Filled in after startExec() — used for abort-driven cancel. */
      runId?: string;
    };

/** Options for executeOnRunner(). */
export interface ExecOptions {
  reqId: string;
  /** Total timeout (ms) — covers both connect and full stream lifetime. */
  timeoutMs: number;
  /** Idle-data watchdog: ms without new event before declaring hung. */
  idleTimeoutMs?: number;
  /** Bearer token override (default = connection.authToken). Used by tests. */
  authToken?: string;
  /** Allow callers to inject a custom fetch (e.g. tests). */
  fetchImpl?: typeof fetch;
  /**
   * Custom SSE frame splitter. Defaults to defaultSplitSseStream (parses
   * ReadableStream into ParsedSseFrame). Tests inject one to feed fake frames.
   */
  splitStream?: (
    stream: ReadableStream<Uint8Array>,
  ) => AsyncIterable<ParsedSseFrame>;
  /**
   * Caller's abort signal — task pause/cancel propagates here so the runner
   * daemon can SIGTERM the in-flight subprocess. The executeOnRunner layer
   * folds it into a top-level AbortController alongside timeout + idle.
   */
  signal?: AbortSignal;
}

/** A single SSE frame parsed from a ReadableStream chunk. */
export interface ParsedSseFrame {
  /** Frame kind — `event: stdout` → "stdout", `event: exit` → "exit", etc. */
  kind: string;
  /** Frame data payload (one JSON object as text). */
  data: string;
}