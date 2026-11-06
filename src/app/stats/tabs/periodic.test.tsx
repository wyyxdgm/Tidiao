// R122 / T2.4: 周期 tab 烟雾测试 —— 验证组件 + helper 链路.
// 关注点: 同 dimensions.test.tsx —— 不引入 testing-library; helper 全覆盖在 periodic-paths.test.ts.

import { describe, it, expect } from "vitest";
import PeriodicTab from "./periodic";
import { collectUnderPrefix, groupByBucket } from "@/lib/stats/periodic-paths";

describe("PeriodicTab (smoke)", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof PeriodicTab).toBe("function");
  });

  it("走 helper 而非内置逻辑 (验证 import 解析正确)", () => {
    // 模拟 periodic.tsx 的 useEffect 流程: fetch /api/projects + 每个项目的 /wiki/tree → collectUnderPrefix
    const tree = [
      {
        name: "docs",
        path: "",
        children: [
          {
            name: "stats",
            path: "",
            children: [
              {
                name: "aggregated",
                path: "",
                children: [
                  { name: "2026-08-28.md", path: "docs/stats/aggregated/2026-08-28.md" },
                  { name: "2026-W34.md", path: "docs/stats/aggregated/2026-W34.md" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const files = collectUnderPrefix(tree, "docs/stats/aggregated");
    expect(files).toHaveLength(2);
    const groups = groupByBucket(files);
    expect(groups.daily).toHaveLength(1);
    expect(groups.weekly).toHaveLength(1);
  });
});
