// R122 / T2.3.2: 需求 tab 烟雾测试 —— 验证组件 + helper 链路.
// 关注点: 同 dimensions.test.tsx —— 不引入 testing-library, 验证模块导入 + helper 集成.

import { describe, it, expect } from "vitest";
import RequirementsTab from "./requirements";
import { aggregateRequirements } from "@/lib/stats/requirements-aggregate";

describe("RequirementsTab (smoke)", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof RequirementsTab).toBe("function");
  });

  it("走 helper 而非内置逻辑 (验证 import 解析正确)", () => {
    const tasks = [
      {
        tags: JSON.stringify(["req:R122", "req:用户登录"]),
        status: "completed",
        title: "test",
        cost_usd: 1,
        base_commit: null,
        head_commit: "c1",
      },
      {
        tags: JSON.stringify(["req:R122"]),
        status: "failed",
        title: "test2",
        cost_usd: 0.5,
        base_commit: null,
        head_commit: "c2",
      },
    ];
    const out = aggregateRequirements(tasks);
    expect(out).toHaveLength(2);
    const r122 = out.find((a) => a.name === "R122");
    expect(r122?.taskCount).toBe(2);
    expect(r122?.completed).toBe(1);
    expect(r122?.failed).toBe(1);
    expect(r122?.commitCount).toBe(2);
  });
});
