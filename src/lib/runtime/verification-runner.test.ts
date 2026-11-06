// DAG P3 verification-runner 单元测试.
//   4 条核心:
//     1) 成功命令 (exit 0) → result.exit_code=0, stdout 有内容
//     2) 失败命令 (exit 1) → result.exit_code=1, stderr 有内容
//     3) 超时命令 (sleep 999 + timeout=2s) → result.timed_out=true
//     4) stdout/stderr 截断 8KB (跑 yes | head -c 100000)

import { describe, it, expect } from "vitest";
import { runVerificationCommand, VERIFICATION_OUTPUT_TRUNCATE_BYTES } from "./verification-runner";

describe("DAG P3 verification-runner", () => {
  it("成功命令 (exit 0) → exit_code=0 + stdout 有内容 + 不超时", () => {
    const r = runVerificationCommand('echo "hello world"', null, 5);
    expect(r.exit_code).toBe(0);
    expect(r.timed_out).toBe(false);
    expect(r.stdout).toContain("hello world");
    expect(r.stderr).toBe("");
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("失败命令 (exit 1) → exit_code=1 + stderr 有内容", () => {
    // bash -c 'echo oops 1>&2; exit 1'
    const r = runVerificationCommand(
      "node -e \"process.stderr.write('oops'); process.exit(1)\"",
      null,
      5,
    );
    expect(r.exit_code).toBe(1);
    expect(r.timed_out).toBe(false);
    expect(r.stderr).toContain("oops");
  });

  it("超时命令 (sleep 999 + timeout=2s) → timed_out=true + exit_code 非 0", () => {
    const r = runVerificationCommand(
      "node -e \"setTimeout(() => {}, 60000)\"",
      null,
      2,
    );
    expect(r.timed_out).toBe(true);
    expect(r.exit_code).not.toBe(0);
    // exit_code 应为 124 (timeout 标准返回码) 或被 kill 信号填的非零值
    expect(typeof r.exit_code).toBe("number");
  });

  it("stdout/stderr 截断 8KB (大输出场景) — 截断标记存在 + 截断阈值正确", () => {
    // node 写 100KB stdout
    const big = "A".repeat(100 * 1024);
    const r = runVerificationCommand(
      `node -e "process.stdout.write('${big}')"`,
      null,
      10,
    );
    expect(r.exit_code).toBe(0);
    // 输出包含截断标记
    expect(r.stdout).toContain("truncated");
    // stdout 字节数不超过 VERIFICATION_OUTPUT_TRUNCATE_BYTES + 截断后缀 (~80B)
    const outBytes = Buffer.byteLength(r.stdout, "utf8");
    expect(outBytes).toBeLessThanOrEqual(VERIFICATION_OUTPUT_TRUNCATE_BYTES + 200);
    expect(outBytes).toBeGreaterThan(VERIFICATION_OUTPUT_TRUNCATE_BYTES); // 真的截了
  });
});
