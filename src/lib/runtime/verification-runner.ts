// DAG P3 (B2/B3/B4/B5 拍板): 项目级 verification_command 执行器.
//   设计稿 docs/plans/dag-verification.md §4.3 + §6.
//
//   行为:
//     - agent SDK 报完成 → approveTask 拦截 → 翻 verifying → 调本函数跑命令
//     - exit 0 = 成功 → 翻 completed
//     - exit 非 0 = 失败 → 回退 running + 注入反馈 (N 次重试)
//     - 超时 = exit 非 0 + timed_out=true
//
//   关键不变量:
//     - **同步阻塞**: execSync, 不引入 async — 因为 approveTask 本身同步, 在
//       「agent 完成 → 平台同步跑验收 → 翻 completed」的串行路径里足够. 如未来
//       验收慢, 再换 execa async 包装. 不要现在做 (YAGNI).
//     - **env 透传**: process.env 原样透传, 不注入 session vars (避免 R128 教训:
//       pm2 restart 继承 env 会让平台子进程误把 task 归到上一个 task 名下). 也不
//       清 env — 项目命令可能依赖 ORCHESTRATOR_* 系列环境变量.
//     - **截断 8KB**: stdout/stderr 单独截断前 8KB, 防爆库. exit code / 耗时 /
//       超时标志 = 完整保留.
//     - **cwd**: 用 task.cwd (与该 task 工作目录一致). null 时用 process.cwd()
//       (项目未配置 cwd 的兜底, 不应发生但兜一下).

import { execSync } from "node:child_process";

// 输出截断阈值 (字节). 防极端输出 (yes 命令 / 大 build log) 撑爆 DB.
// 设计稿 §4.3 失败模式 4: 命令副作用污染 — 这里只关心日志体积, 副作用由命令自己清理.
export const VERIFICATION_OUTPUT_TRUNCATE_BYTES = 8 * 1024;

export interface VerificationResult {
  exit_code: number;
  stdout: string; // 截断 8KB
  stderr: string; // 截断 8KB
  duration_ms: number;
  timed_out: boolean;
}

// 功能: 截断字符串到指定字节上限, 加「...(truncated, total N bytes)」后缀.
// 关注点: 按字节截断 (Buffer.byteLength), 防止多字节字符 (UTF-8) 切断半个码点.
// 中文/emoji 等每个字符 3-4 字节, 按 char 截断会算错字符数.
function truncateOutput(raw: string, maxBytes: number): string {
  const buf = Buffer.from(raw, "utf8");
  if (buf.length <= maxBytes) return raw;
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n\n... (truncated, total ${buf.length} bytes)`;
}

// 功能: 跑项目级 verification_command, 返回 4 字段结构化结果.
//   超时由 timeoutSeconds 控制 (默认 600s).
//   关注点:
//     - execSync 同步阻塞, 适用于「agent 完成 → 平台同步跑验收 → 翻 completed」的
//       串行流程. 命令挂住由 execSync 的 timeout 选项兜底, 主动 kill.
//     - cwd = task.cwd (从 task 拿), env 透传当前 process.env (包括平台 secret).
//     - 命令 stdout/stderr 截断前 8KB (防爆库).
//     - 返回 exit_code 0 = 成功, 非 0 = 失败 (含超时).
//   抛错: 不抛. 超时/命令不存在/非零退出都捕获成结构化结果 (timed_out / exit_code),
//     让 caller (agent-runtime.ts 的 _approveTaskWithVerification) 自己判断.
export function runVerificationCommand(
  command: string,
  cwd: string | null,
  timeoutSeconds: number,
): VerificationResult {
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: cwd ?? process.cwd(),
      timeout: timeoutSeconds * 1000,
      // 收 stdout/stderr 到 buffer, 不直接打印 (避免平台日志被命令污染)
      stdio: ["ignore", "pipe", "pipe"],
      // 透传环境变量, 不注入 session vars (避免 R128 教训)
      env: process.env,
      // 命令不存在时 kill 信号 ≠ 0 退出. execSync 抛错, catch 后填 exit_code
      killSignal: "SIGTERM",
      maxBuffer: 16 * 1024 * 1024, // 16MB 内部缓冲, 我们自己再截断到 8KB
      encoding: "utf8",
    });
    return {
      exit_code: 0,
      stdout: truncateOutput(stdout ?? "", VERIFICATION_OUTPUT_TRUNCATE_BYTES),
      stderr: "",
      duration_ms: Date.now() - start,
      timed_out: false,
    };
  } catch (err) {
    const e = err as {
      status?: number | null;
      stdout?: string | Buffer | null;
      stderr?: string | Buffer | null;
      signal?: string | null;
      killed?: boolean;
      message?: string;
    };
    // execSync 超时: signal = 'SIGTERM' (我们传的 killSignal), killed = true.
    // 也兜底识别 OS 自带 kill 信号 (SIGKILL 在 Linux 罕见, 主要靠 timeout 选项).
    const timedOut = e.killed === true || e.signal === "SIGTERM";
    const exitCode = typeof e.status === "number" ? e.status : timedOut ? 124 : 1;
    const stdoutStr =
      typeof e.stdout === "string"
        ? e.stdout
        : e.stdout
          ? Buffer.from(e.stdout).toString("utf8")
          : "";
    const stderrStr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr
          ? Buffer.from(e.stderr).toString("utf8")
          : e.message ?? "";
    return {
      exit_code: exitCode,
      stdout: truncateOutput(stdoutStr, VERIFICATION_OUTPUT_TRUNCATE_BYTES),
      stderr: truncateOutput(stderrStr, VERIFICATION_OUTPUT_TRUNCATE_BYTES),
      duration_ms: Date.now() - start,
      timed_out: timedOut,
    };
  }
}
