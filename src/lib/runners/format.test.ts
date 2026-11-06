// R3 formatExecResult 纯字符串测试.
//
// 关注点:
//   - 头部格式: [runner:NAME (host:port) req=XXXXXXXX] exit=N duration=...
//   - 截断: head 1KB + tail 64KB, 中间 " ... [truncated N KB] ..."
//   - errored=true / exit=null / 全空输出 各自路径
//   - duration 格式: ms / 秒

import { describe, it, expect } from "vitest";
import { formatExecResult, truncate } from "./format";
import type { ExecResult, RunnerConnection } from "./types";

function conn(name = "mac-build"): RunnerConnection {
  return {
    runner: {
      id: "r-1",
      name,
      host: "192.168.3.243",
      port: 8081,
      os_type: "macos",
      status: "online",
      last_heartbeat_at: null,
    },
    authToken: "test",
    lastSeenAtMs: null,
    status: "online",
  };
}

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    runId: "rid-1",
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1000,
    reqId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    errored: false,
    errorMessage: null,
    ...overrides,
  };
}

describe("formatExecResult: header", () => {
  it("前缀含 runner name + host:port + req 短哈希", () => {
    const out = formatExecResult(conn("mac-build"), result(), "a1b2c3d4-xxx");
    expect(out).toMatch(/^\[runner:mac-build \(192\.168\.3\.243:8081\) req=a1b2c3d4\]/);
  });

  it("header 行带 exit + duration", () => {
    const out = formatExecResult(conn(), result({ exitCode: 0, durationMs: 52300 }), "x");
    expect(out).toContain("exit=0");
    expect(out).toContain("duration=52.3s");
  });

  it("durationMs < 1000 显示 ms 单位", () => {
    const out = formatExecResult(conn(), result({ durationMs: 250 }), "x");
    expect(out).toContain("duration=250ms");
  });

  it("durationMs null → N/A", () => {
    const out = formatExecResult(conn(), result({ durationCode: undefined, durationMs: null } as any), "x");
    expect(out).toContain("duration=N/A");
  });

  it("errored=true → header 带 errored 而非 exit=", () => {
    const out = formatExecResult(
      conn(),
      result({ errored: true, errorMessage: "boom", exitCode: null, durationMs: 300 }),
      "x",
    );
    expect(out).toContain("errored");
    expect(out).toContain("duration=300ms");
    expect(out).not.toContain("exit=");
  });

  it("exitCode 非 0 (子进程返回失败) — 正常显示 exit=1, 不算 errored", () => {
    const out = formatExecResult(
      conn(),
      result({ exitCode: 1, durationMs: 200 }),
      "x",
    );
    expect(out).toContain("exit=1");
    expect(out).not.toContain("errored");
  });
});

describe("formatExecResult: 段渲染", () => {
  it("stdout 段", () => {
    const out = formatExecResult(conn(), result({ stdout: "hello\nworld\n" }), "x");
    expect(out).toContain("--- stdout ---");
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  it("stderr 段", () => {
    const out = formatExecResult(conn(), result({ stderr: "warning: deprecated\n" }), "x");
    expect(out).toContain("--- stderr ---");
    expect(out).toContain("warning: deprecated");
  });

  it("stdout / stderr 都空且没 error → 显示 '(no output)' 提示", () => {
    const out = formatExecResult(conn(), result(), "x");
    expect(out).toContain("(no output)");
    expect(out).not.toContain("--- stdout ---");
    expect(out).not.toContain("--- stderr ---");
  });

  it("stdout / stderr 都空 + errorMessage 非空 → 显示 error 段, 无 '(no output)'", () => {
    const out = formatExecResult(
      conn(),
      result({ errored: true, errorMessage: "cancelled" }),
      "x",
    );
    expect(out).toContain("--- error ---");
    expect(out).toContain("cancelled");
    expect(out).not.toContain("(no output)");
  });
});

describe("formatExecResult: 截断", () => {
  it("小输出 (< head + tail) 原样, 不加 truncated 标记", () => {
    const small = "x".repeat(2000); // 2KB, 远小于 65KB
    const out = formatExecResult(conn(), result({ stdout: small }), "x");
    expect(out).toContain(small);
    expect(out).not.toContain("truncated");
  });

  it("大输出 (>= head + tail) → 截断, head + tail 都保留", () => {
    const big = "A".repeat(1024) + "B".repeat(200 * 1024) + "C".repeat(1024); // 202KB
    const out = formatExecResult(conn(), result({ stdout: big }), "x");
    expect(out).toContain("A".repeat(100)); // head 1KB 至少有 'A'
    expect(out).toContain("C".repeat(100)); // tail 64KB 至少有 'C'
    expect(out).toContain("[truncated");
  });

  it("200KB 输出 → truncated 标记显示 N KB (精确字节数)", () => {
    // 200_000 bytes input; head=1024, tail=65536; truncated = 200000 - 1024 - 65536 = 133440 bytes ≈ 130.3 KB
    const big = "x".repeat(200_000);
    const out = formatExecResult(conn(), result({ stdout: big }), "x");
    const m = out.match(/truncated ([\d.]+)KB/);
    expect(m).not.toBeNull();
    if (m) {
      const kb = Number(m[1]);
      expect(kb).toBeGreaterThan(100);
      expect(kb).toBeLessThan(200);
    }
  });

  it("stderr 独立截断", () => {
    const big = "x".repeat(200_000);
    const out = formatExecResult(conn(), result({ stderr: big }), "x");
    expect(out).toContain("--- stderr ---");
    expect(out).toContain("[truncated");
  });
});

describe("truncate helper", () => {
  it("边界: input = head + tail 时原样", () => {
    const s = "x".repeat(1024 + 64 * 1024);
    expect(truncate(s)).toBe(s);
  });

  it("边界: input = head + tail + 1 → 截断", () => {
    const s = "x".repeat(1024 + 64 * 1024 + 1);
    expect(truncate(s)).toContain("[truncated");
  });

  it("默认 head + tail 组合 (1KB + 64KB) 验证", () => {
    const s = "a".repeat(200_000);
    const out = truncate(s);
    expect(out.startsWith("a".repeat(1024))).toBe(true);
    expect(out.endsWith("a".repeat(64 * 1024))).toBe(true);
  });

  it("自定义 head/tail 边界生效", () => {
    const s = "x".repeat(200);
    const out = truncate(s, 50, 50);
    expect(out).toContain("[truncated");
    expect(out).toMatch(/^x{50}/);
    expect(out).toMatch(/x{50}$/);
  });
});