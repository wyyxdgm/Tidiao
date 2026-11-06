import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemGate, getMemGuardThresholdMb } from "./mem-guard";

describe("MemGate", () => {
  it("内存够时放行, 且不触发预警沿", () => {
    const gate = new MemGate(2048);
    const r = gate.check(4600);
    expect(r.ok).toBe(true);
    expect(r.alertJustTriggered).toBe(false);
    expect(r.recovered).toBe(false);
  });

  it("首次跌破阈值 → 放行=false + alertJustTriggered=true (预警只报一次)", () => {
    const gate = new MemGate(2048);
    expect(gate.check(1100).alertJustTriggered).toBe(true);
    // 持续低内存: 不重复触发
    const again = gate.check(1000);
    expect(again.ok).toBe(false);
    expect(again.alertJustTriggered).toBe(false);
  });

  it("恢复 → ok=true + recovered=true (只报一次), 再检查不再报", () => {
    const gate = new MemGate(2048);
    gate.check(1100);
    const rec = gate.check(4600);
    expect(rec.ok).toBe(true);
    expect(rec.recovered).toBe(true);
    const after = gate.check(4600);
    expect(after.recovered).toBe(false);
  });

  it("边界值: 恰好等于阈值 = 放行 (>= 语义)", () => {
    const gate = new MemGate(2048);
    expect(gate.check(2048).ok).toBe(true);
    expect(gate.check(2047.9).ok).toBe(false);
  });

  it("阈值可注入, 构造时不读 env (便于测试)", () => {
    const gate = new MemGate(100);
    expect(gate.check(150).thresholdMb).toBe(100);
  });
});

describe("getMemGuardThresholdMb", () => {
  const original = process.env.AO_MEM_GUARD_MB;
  beforeEach(() => {
    delete process.env.AO_MEM_GUARD_MB;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AO_MEM_GUARD_MB;
    else process.env.AO_MEM_GUARD_MB = original;
  });

  // 功能: stub process.platform 后跑 fn, 完了还原 (测平台相关默认值用).
  function withPlatform(platform: string, fn: () => void): void {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  }

  it("未设置 + linux → 默认 2048 (WSL 闸门保护对象)", () => {
    withPlatform("linux", () => {
      expect(getMemGuardThresholdMb()).toBe(2048);
    });
  });

  it("未设置 + darwin → 0 (freemem 语义不成立, 默认关闸)", () => {
    withPlatform("darwin", () => {
      expect(getMemGuardThresholdMb()).toBe(0);
    });
  });

  it("合法值生效 (任意平台)", () => {
    process.env.AO_MEM_GUARD_MB = "1024";
    expect(getMemGuardThresholdMb()).toBe(1024);
    withPlatform("darwin", () => {
      expect(getMemGuardThresholdMb()).toBe(1024);
    });
  });

  it("非法值(非数字/负数)回退平台默认", () => {
    withPlatform("linux", () => {
      process.env.AO_MEM_GUARD_MB = "abc";
      expect(getMemGuardThresholdMb()).toBe(2048);
      process.env.AO_MEM_GUARD_MB = "-1";
      expect(getMemGuardThresholdMb()).toBe(2048);
    });
    withPlatform("darwin", () => {
      process.env.AO_MEM_GUARD_MB = "abc";
      expect(getMemGuardThresholdMb()).toBe(0);
    });
  });
});
