// R3 输出格式化: 把 ExecResult 渲染成给人/模型读的多行字符串.
//
// 关注点:
//   - 截断: head 1KB + tail 64KB, 中间 "... [truncated N KB] ...".
//     Tauri build 动辄几百 KB 输出, 不截断会撑爆 model context.
//   - 前缀 "[runner:NAME (host:port) req=XXXXXXXX]" 让模型一眼看出"这是
//     平台伪造的远程结果, 非本地 SDK bash 输出". req_id 取前 8 位, 短到不
//     污染 token 又够追 e2e (rollout §3 调试三件套).
//   - 错误: stdout/stderr 即使为空, 也要把 errorMessage 落一行, 不让 agent
//     误以为是 "成功 + 空输出".
//   - 我们渲染给 agent 看的 tool_result, 不是给人看; 行宽 / ANSI 清理不是
//     这里的关注点 (cargo 的彩色 ANSI 通过 stderr 给模型, 模型自行解释).

import type { ExecResult, RunnerConnection } from "./types";

const HEAD_BYTES = 1024; // 1 KB
const TAIL_BYTES = 64 * 1024; // 64 KB

export interface FormatOptions {
  /** reqId 短哈希前 N 位. 默认 8. */
  reqIdPrefixLen?: number;
}

/**
 * Render an ExecResult into the string that becomes the agent's tool_result
 * (via canUseTool deny message). Truncates stdout/stderr to keep model
 * context manageable.
 *
 * 输出形如:
 * ```
 * [runner:mac-build (192.168.3.243:8081) req=a1b2c3d4] exit=0 duration=52.3s
 * --- stdout ---
 * ...
 * --- stderr ---
 * ...
 * --- error ---
 * ...
 * ```
 *
 * 关注点:
 *   - 任一段为空就省略 (不打 "--- stdout --- \n (空)" 让 agent 误以为有).
 *   - 截断只算字节, 不用字符 — SSE 给的是 utf-8, 我们按 .length 算 utf-16
 *     code units (JS string 长度). 近似足够 (因为我们只看"多少字节"做
 *     决策, 多/少几个 byte 在 64KB 尺度上无差).
 *   - durationMs 为 null 时写 "duration=N/A" (stream 提前断了).
 */
export function formatExecResult(
  conn: RunnerConnection,
  result: ExecResult,
  reqId: string,
  opts: FormatOptions = {},
): string {
  const prefixLen = opts.reqIdPrefixLen ?? 8;
  const reqShort = reqId.slice(0, prefixLen) || "?";

  const header = `[runner:${conn.runner.name} (${conn.runner.host}:${conn.runner.port}) req=${reqShort}]`;

  // exit + duration 行. 区分 errored=true 和 exit≠0.
  let statusLine: string;
  if (result.errored) {
    statusLine = `${header} errored duration=${formatDuration(result.durationMs)}`;
  } else if (result.exitCode === null) {
    statusLine = `${header} exit=N/A duration=${formatDuration(result.durationMs)}`;
  } else {
    statusLine = `${header} exit=${result.exitCode} duration=${formatDuration(result.durationMs)}`;
  }

  const parts: string[] = [statusLine];

  if (result.stdout) {
    parts.push("--- stdout ---");
    parts.push(truncate(result.stdout, HEAD_BYTES, TAIL_BYTES));
  }
  if (result.stderr) {
    parts.push("--- stderr ---");
    parts.push(truncate(result.stderr, HEAD_BYTES, TAIL_BYTES));
  }
  if (result.errorMessage) {
    parts.push("--- error ---");
    parts.push(result.errorMessage);
  }

  // stdout/stderr/error 全空 (罕见): 加一行 "(no output)" 提示, 防止 agent
  // 误以为是 tool 成功且无输出.
  if (parts.length === 1) {
    parts.push("(no output)");
  }

  return parts.join("\n");
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "N/A";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Truncate a string to head + tail with a marker in the middle. Counts
 * JavaScript string code units as a fast proxy for bytes (model-side
 * truncation is approximate anyway).
 *
 * 关注点:
 *   - 输入长度 <= head + tail 时原样返回, 不动.
 *   - 中间那段填 "... [truncated N KB] ..." — N 是被砍掉的字节数 (用
 *     `Math.max(0, ...)` 防止显示 -0).
 *   - marker 本身在 head/tail 中占一小段, 实际砍掉的字节 > N, 但显示用 N
 *     即可 (运维 / 排查关注的是数量级).
 */
export function truncate(
  s: string,
    headBytes: number = HEAD_BYTES,
    tailBytes: number = TAIL_BYTES,
): string {
  const total = s.length;
  if (total <= headBytes + tailBytes) return s;
  const head = s.slice(0, headBytes);
  const tail = s.slice(total - tailBytes);
  const truncatedBytes = Math.max(0, total - headBytes - tailBytes);
  return `${head}\n... [truncated ${formatBytes(truncatedBytes)}] ...\n${tail}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}