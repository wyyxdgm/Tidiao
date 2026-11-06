// R3 执行聚合: 调 client.startExec + streamEvents, 聚合 stdout/stderr, 遇
//   exit 结束. 返回结构化 ExecResult, 不抛 (runner 不可达 / auth 错 / 超时
//   全部结构化到 result).
//
// 关注点:
//   - idle-data watchdog: 收到 last event 后起 30s timer, 没新 event 就
//     cancel + 返回 timeout. 应对 cargo 解析阶段卡死那种场景; 总超时
//     `timeoutMs` 是兜底.
//   - total timeout: AbortController 在 timeoutMs 时触发 abort +
//     client.cancel(runId). 不等 daemon 自己超时 (它的 context.WithTimeout
//     兜底).
//   - signal 必传: canUseTool 把 options.signal 透进来, task 被 pause/cancel
//     时让 runner 也收 cancel. abort 一次性 listener (once: true), 避免
//     双触发 (signal 已经 abort, listener 不会重复触发, 但 once 是防御).
//   - 失败 -> 结构化 ExecResult (errored=true + errorMessage), 不抛.
//     canUseTool 拿到结构化结果后统一通过 formatExecResult 排版.

import { cancel as cancelExec, startExec, streamEvents } from "./client";
import type {
  ExecEvent,
  ExecOptions,
  ExecRequest,
  ExecResult,
  RunnerConnection,
} from "./types";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;

/**
 * Run a command on the runner, streaming events back. Never throws — all
 * failure modes are encoded in the returned ExecResult so canUseTool can
 * present them uniformly via format.ts.
 *
 * 关注点:
 *   - signal abort 一次性 listener, 内置 cleanup: 跑完 listener 自然
 *     移除, 不再存引用 (Options.signal 是 per-tool-call 的, 跑完会换).
 */
export async function executeOnRunner(
  conn: RunnerConnection,
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  opts: ExecOptions,
): Promise<ExecResult> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  // 顶层 AbortController, 用于整合 timeout + 调用方 signal + idle watchdog.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(new Error("timeout"));
  }, opts.timeoutMs);

  // 把 caller signal 串进来 (任务 pause/cancel 时也 abort 我们).
  const onCallerAbort = () => controller.abort(new Error("caller_aborted"));
  if (opts.signal?.aborted) {
    onCallerAbort();
  } else {
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    // 1. startExec — 拿到 run_id 才能开 SSE + 之后 cancel.
    let runId: string;
    try {
      const started = await startExec(
        conn,
        {
          command,
          cwd,
          timeoutMs: opts.timeoutMs,
          env: filterEnv(env),
        } satisfies ExecRequest,
        { reqId: opts.reqId, fetchImpl: opts.fetchImpl },
      );
      runId = started.run_id;
    } catch (err) {
      return errorResult(opts.reqId, `startExec failed: ${(err as Error).message}`);
    }

    // 2. 流式聚合. idle timer: 每次新 event 重置.
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let durationMs: number | null = null;
    let errored = false;
    let errorMessage: string | null = null;
    let idleHandle: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleHandle) clearTimeout(idleHandle);
      idleHandle = setTimeout(() => {
        controller.abort(new Error("idle_timeout"));
      }, idleMs);
    };

    try {
      resetIdle();
      const stream = streamEvents(conn, runId, {
        reqId: opts.reqId,
        signal: controller.signal,
        fetchImpl: opts.fetchImpl,
        ...(opts.splitStream ? { splitStream: opts.splitStream } : {}),
      });
      for await (const ev of stream) {
        resetIdle();
        if (ev.type === "stdout") {
          stdout += ev.data;
        } else if (ev.type === "stderr") {
          stderr += ev.data;
        } else if (ev.type === "exit") {
          exitCode = ev.exitCode;
          durationMs = ev.durationMs;
          break;
        } else if (ev.type === "error") {
          errored = true;
          errorMessage = ev.message;
          // error event 不一定意味着 stream 结束, 但一般 daemon 会 close.
          // 让 for-await 自然退出 (signal/reader 关闭) — 不 break, 避免漏
          // 掉紧跟的 exit. 实战中 daemon 写 error + 关闭连接; 自然 done.
        }
      }
    } catch (err) {
      // 任何流错误 (网络断 / abort) — 试 cancel 一次 (best-effort), 然后
      // 把错误带回 result.
      const abortReason = controller.signal.reason;
      if (abortReason instanceof Error) {
        // abort 触发: 超时 / idle / caller. cancel 让 daemon 收 SIGTERM.
        try {
          await cancelExec(conn, runId, {
            reqId: opts.reqId,
            fetchImpl: opts.fetchImpl,
          });
        } catch {}
        if (errorMessage == null) {
          errored = true;
          errorMessage =
            abortReason.message === "timeout"
              ? `timeout after ${opts.timeoutMs}ms`
              : abortReason.message === "idle_timeout"
                ? `idle for ${idleMs}ms (no new events)`
                : abortReason.message === "caller_aborted"
                  ? `caller aborted`
                  : abortReason.message;
        }
      } else {
        if (errorMessage == null) {
          errored = true;
          errorMessage = `stream failed: ${(err as Error).message}`;
        }
      }
      // exitCode / durationMs 保留 null (没拿到 exit 帧).
    } finally {
      if (idleHandle) clearTimeout(idleHandle);
    }

    return {
      runId,
      stdout,
      stderr,
      exitCode,
      durationMs,
      reqId: opts.reqId,
      errored,
      errorMessage,
    };
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

// 功能: 构造结构化错误 result. 在 startExec 阶段就失败时使用, runId 未知.
function errorResult(reqId: string, message: string): ExecResult {
  return {
    runId: "",
    stdout: "",
    stderr: "",
    exitCode: null,
    durationMs: null,
    reqId,
    errored: true,
    errorMessage: message,
  };
}

// 功能: runner 子进程通常需要干净 env. ActiveSession.buildEnv 注入了一堆
//   平台级 env (ORCHESTRATOR_* / ANTHROPIC_* / AO_TOKEN 等), 传给 runner
//   等于泄露 + 子进程可能误用. 这里只挑白名单的几个 (PATH / HOME / USER /
//   LANG / LC_ALL / SHELL), 其余一律丢弃. 后续 runner 真要拿更多上下文再
//   加白名单项.
//
// 关注点:
//   - 不能传 runner 不该看见的 secrets (AO_TOKEN / ANTHROPIC_API_KEY /
//     MINIMAX_API_KEY / MMX_CONFIG_DIR 等).
//   - PATH / HOME 是 bash 找命令和 ~ 展开必须, 没有它们 cargo / rustc
//     之类根本跑不起来.
//   - shell 环境变量 (LANG 等) runner 上 bash 自己有, 透传 WSL 的无害.
const RUNNER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TMPDIR",
  "EDITOR",
  "PAGER",
]);

function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!RUNNER_ENV_ALLOWLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}