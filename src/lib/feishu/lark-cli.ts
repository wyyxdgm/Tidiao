// 单一的 lark-cli 子进程入口. sheets.ts / images.ts 都从这里调.
//
// 关注点:
//   - `-o <path>` **必须是相对当前工作目录的路径** —— 传绝对路径会被
//     lark-cli 拒绝 (`must be a relative path within the current directory`).
//     所以要下载到某个目录, 用 opts.cwd 指到那个目录 + 传裸文件名, 不要拼绝对路径.
//   - 飞书 API 偶发 2200 Internal Error, 加 3 次重试 (50ms/150ms 指数退避).
//     实测: 单行读 row 6 偶发挂掉, 但整段 range 不挂; 重试 1-2 次就好.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const LARK_RETRY_COUNT = 3;
const LARK_RETRY_DELAYS_MS = [50, 150];

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // 飞书 2200 Internal Error, 或 timeout 类错误, 都重试.
  return /2200|Internal Error|ETIMEDOUT|ECONNRESET|ENOTFOUND|timeout/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLarkCli(
  args: string[],
  opts?: { cwd?: string },
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= LARK_RETRY_COUNT; attempt++) {
    try {
      const { stdout } = await execFileAsync("lark-cli", args, {
        maxBuffer: 10 * 1024 * 1024,
        cwd: opts?.cwd,
      });
      return stdout;
    } catch (err) {
      lastError = err;
      if (attempt < LARK_RETRY_COUNT && isTransientError(err)) {
        await sleep(LARK_RETRY_DELAYS_MS[attempt] ?? 50);
        continue;
      }
      throw err;
    }
  }
  // 不可达, 但 TS 要 return 兜底.
  throw lastError;
}
