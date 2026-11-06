// R122 / T2.3.1: 维度 tab 烟雾测试 —— 验证组件 + helper 链路.
// 关注点:
//   - 不引入 @testing-library (本仓未装), 改为验证模块导入 + 类型契约 + helper 调用.
//   - 渲染层面 (useEffect + fetch) 留给手测 / E2E; 数据正确性已由 dimensions-aggregate.test.ts 守.
//   - 这是 smoke, 不是真正的 React 渲染测试; 真实 UI 验证见 docs/runbook.md.

import { describe, it, expect } from "vitest";
import DimensionsTab from "./dimensions";
import { aggregateDimensions } from "@/lib/stats/dimensions-aggregate";

describe("DimensionsTab (smoke)", () => {
  it("默认导出 = 函数组件 (type guard 形式)", () => {
    expect(typeof DimensionsTab).toBe("function");
  });

  it("走 helper 而非内置逻辑 (验证 import 解析正确, 不是空占位)", () => {
    // 模拟 dimensions.tsx 的 useEffect 流程: fetch /api/stats + /api/tasks → aggregateDimensions
    const stats = {
      tasks: {},
      scheduler: { queue_size: 0, running_count: 0, max_concurrency: 0 },
      cost: { total: 0, by_tag: { "dim:backend": 5 }, by_model: {}, by_day: [] },
    };
    const tasks = [{ tags: JSON.stringify(["dim:backend"]), status: "completed", cost_usd: null }];
    const out = aggregateDimensions(stats.cost.by_tag, tasks);
    expect(out.find((d) => d.name === "backend")?.costUsd).toBe(5);
    expect(out.find((d) => d.name === "backend")?.taskCount).toBe(1);
  });
});
