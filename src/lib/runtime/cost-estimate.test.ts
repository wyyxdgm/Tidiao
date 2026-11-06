// cost-estimate 纯函数回归 (R239 补 per-model 单价 + 系数).
// 关注点: 全部无 IO, 直接 import (文件顶层无 DB 依赖, 不需要临时库).

import { describe, it, expect } from "vitest";
import {
  hasAnyPrice,
  estimateCostWithPrices,
  blendedPrice,
  priceCoefficient,
  estimateCostUsd,
  type ModelPrices,
} from "./cost-estimate";

const FULL: ModelPrices = { in: 3, out: 15, cacheRead: 0.3 };

describe("hasAnyPrice", () => {
  it("null / 全空 = false, 任一档 >0 = true", () => {
    expect(hasAnyPrice(null)).toBe(false);
    expect(hasAnyPrice({ in: null, out: null, cacheRead: null })).toBe(false);
    expect(hasAnyPrice({ in: 0, out: 0, cacheRead: 0 })).toBe(false);
    expect(hasAnyPrice({ in: null, out: 15, cacheRead: null })).toBe(true);
  });
});

describe("estimateCostWithPrices", () => {
  it("按配置单价折算, 未配档按 0 计 (不回落折中价)", () => {
    // 1M in + 1M out + 1M cacheRead = 3 + 15 + 0.3 = 18.3
    expect(estimateCostWithPrices({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 5e5 }, FULL)).toBe(18.3);
    // 半配置: 只有 out=15 → output 计价, input/cacheRead 按 0 (cacheWrite 恒不参与)
    expect(estimateCostWithPrices({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 5e5 }, { in: null, out: 15, cacheRead: null })).toBe(15);
  });

  it("全 0 用量给最小地板值, 防止 0 退化成 NULL", () => {
    expect(estimateCostWithPrices({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, FULL)).toBeGreaterThan(0);
  });
});

describe("blendedPrice / priceCoefficient", () => {
  it("基准价 = 入+出 直加 (cache 不进系数)", () => {
    expect(blendedPrice(FULL)).toBe(18);
    expect(blendedPrice({ in: null, out: null, cacheRead: 0.3 })).toBe(0);
  });

  it("系数 = 基准价比值, 保留 2 位", () => {
    const cheap: ModelPrices = { in: 1.5, out: 7.5, cacheRead: null };
    expect(priceCoefficient(cheap, FULL)).toBe(0.5);
    // 1/3 → 0.33 (2 位舍入)
    expect(priceCoefficient({ in: 1, out: 5, cacheRead: null }, FULL)).toBe(0.33);
  });

  it("分母 ≤0 (基准没配价) / 本侧全 0 → null (UI 显 —)", () => {
    expect(priceCoefficient(FULL, { in: null, out: null, cacheRead: null })).toBeNull();
    expect(priceCoefficient({ in: 0, out: 0, cacheRead: 0 }, FULL)).toBeNull();
  });
});

describe("estimateCostUsd (既有折中价路径)", () => {
  it("量级不变: 1M in + 0.5M cacheRead = 3 + 0.15", () => {
    expect(estimateCostUsd({ input: 1e6, output: 0, cacheRead: 5e5, cacheWrite: 0 })).toBe(3.15);
  });
});
