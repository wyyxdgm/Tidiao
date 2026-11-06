// R122 / T2.4: 周期总结 helper 单测 (从 wiki tree 抽 docs/stats/aggregated/).
// 关注点:
//   - bucketOf 边界: ISO 8601 命名 vs 自由命名 (其它归 other 兜底).
//   - collectUnderPrefix 递归正确性: 树里嵌套目录 / 不匹配的目录 / 多个同名目录.
//   - groupByBucket 顺序稳定: bucket 固定顺序 + 组内按 name 降序.

import { describe, it, expect } from "vitest";
import {
  bucketOf,
  collectUnderPrefix,
  groupByBucket,
  type WikiTreeNode,
} from "./periodic-paths";

describe("bucketOf", () => {
  it("识别 ISO 8601 日/周/月/年命名", () => {
    expect(bucketOf("2026-08-28.md")).toBe("daily");
    expect(bucketOf("2026-W34.md")).toBe("weekly");
    expect(bucketOf("2026-08.md")).toBe("monthly");
    expect(bucketOf("2026.md")).toBe("yearly");
  });

  it("daily 优先于 monthly (YYYY-MM-DD 也能粗略匹配 YYYY-MM, 短匹配兜底)", () => {
    // 实际顺序: daily → weekly → yearly → monthly. 2026-08-28 严格匹配 daily 而非 monthly.
    expect(bucketOf("2026-08-28.md")).toBe("daily");
  });

  it("yearly 优先于 monthly (2026.md 不被当 2026 月报)", () => {
    expect(bucketOf("2026.md")).toBe("yearly");
  });

  it("非 ISO 命名归 other 兜底", () => {
    expect(bucketOf("README.md")).toBe("other");
    expect(bucketOf("notes-2026-08-28.md")).toBe("other");
    expect(bucketOf("2026-08-28-snapshot.md")).toBe("other");
  });

  it("非 .md 后缀归 other (理论不会进来, 兜底)", () => {
    expect(bucketOf("2026-08-28.txt")).toBe("other");
  });
});

describe("collectUnderPrefix", () => {
  it("基础: 找到 docs/stats/aggregated/ 下所有 .md", () => {
    const tree: WikiTreeNode[] = [
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
                  { name: "2026-08-27.md", path: "docs/stats/aggregated/2026-08-27.md" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const out = collectUnderPrefix(tree, "docs/stats/aggregated");
    expect(out.map((f) => f.name).sort()).toEqual(["2026-08-27.md", "2026-08-28.md"]);
    expect(out.every((f) => f.bucket === "daily")).toBe(true);
  });

  it("目录名不匹配时跳过整棵子树 (不污染结果)", () => {
    const tree: WikiTreeNode[] = [
      { name: "docs", path: "", children: [
        { name: "stats", path: "", children: [
          { name: "OTHER", path: "", children: [
            { name: "fake-2026-08-28.md", path: "docs/stats/OTHER/fake-2026-08-28.md" },
          ] },
          { name: "aggregated", path: "", children: [
            { name: "2026-08-28.md", path: "docs/stats/aggregated/2026-08-28.md" },
          ] },
        ] },
      ] },
    ];
    const out = collectUnderPrefix(tree, "docs/stats/aggregated");
    expect(out.map((f) => f.name)).toEqual(["2026-08-28.md"]);
  });

  it("完全没找到 prefix → 返回空数组, 不报错", () => {
    const tree: WikiTreeNode[] = [
      { name: "src", path: "", children: [
        { name: "index.ts", path: "src/index.ts" },
      ] },
    ];
    const out = collectUnderPrefix(tree, "docs/stats/aggregated");
    expect(out).toEqual([]);
  });

  it("prefix 比树深时静默返回空 (depth 超过即停)", () => {
    const tree: WikiTreeNode[] = [
      { name: "docs", path: "", children: [
        { name: "stats", path: "", children: [
          { name: "2026-08-28.md", path: "docs/stats/2026-08-28.md" },
        ] },
      ] },
    ];
    const out = collectUnderPrefix(tree, "docs/stats/aggregated");
    expect(out).toEqual([]);
  });

  it("空树返回空数组", () => {
    expect(collectUnderPrefix([], "docs/stats/aggregated")).toEqual([]);
  });

  it("多个项目共用同 prefix, 递归正确 (各树独立)", () => {
    const t1: WikiTreeNode[] = [
      { name: "docs", path: "", children: [
        { name: "stats", path: "", children: [
          { name: "aggregated", path: "", children: [
            { name: "2026-08-28.md", path: "docs/stats/aggregated/2026-08-28.md" },
          ] },
        ] },
      ] },
    ];
    const t2: WikiTreeNode[] = [
      { name: "docs", path: "", children: [
        { name: "stats", path: "", children: [
          { name: "aggregated", path: "", children: [
            { name: "2026-W34.md", path: "docs/stats/aggregated/2026-W34.md" },
            { name: "2026.md", path: "docs/stats/aggregated/2026.md" },
          ] },
        ] },
      ] },
    ];
    const out1 = collectUnderPrefix(t1, "docs/stats/aggregated");
    const out2 = collectUnderPrefix(t2, "docs/stats/aggregated");
    expect(out1).toHaveLength(1);
    expect(out1[0].bucket).toBe("daily");
    expect(out2).toHaveLength(2);
    expect(out2.map((f) => f.bucket).sort()).toEqual(["weekly", "yearly"]);
  });
});

describe("groupByBucket", () => {
  it("按 bucket 分组, 组内按 name 降序 (新→旧)", () => {
    const files = [
      { path: "p/2026-08-27.md", name: "2026-08-27.md", bucket: "daily" as const },
      { path: "p/2026-08-28.md", name: "2026-08-28.md", bucket: "daily" as const },
      { path: "p/2026-W33.md", name: "2026-W33.md", bucket: "weekly" as const },
      { path: "p/2026-W34.md", name: "2026-W34.md", bucket: "weekly" as const },
      { path: "p/2026-07.md", name: "2026-07.md", bucket: "monthly" as const },
      { path: "p/2026-08.md", name: "2026-08.md", bucket: "monthly" as const },
      { path: "p/2025.md", name: "2025.md", bucket: "yearly" as const },
      { path: "p/2026.md", name: "2026.md", bucket: "yearly" as const },
    ];
    const groups = groupByBucket(files);
    expect(groups.daily.map((f) => f.name)).toEqual(["2026-08-28.md", "2026-08-27.md"]);
    expect(groups.weekly.map((f) => f.name)).toEqual(["2026-W34.md", "2026-W33.md"]);
    expect(groups.monthly.map((f) => f.name)).toEqual(["2026-08.md", "2026-07.md"]);
    expect(groups.yearly.map((f) => f.name)).toEqual(["2026.md", "2025.md"]);
    expect(groups.other).toEqual([]);
  });

  it("空入参返回全空组", () => {
    const groups = groupByBucket([]);
    expect(groups).toEqual({
      daily: [],
      weekly: [],
      monthly: [],
      yearly: [],
      other: [],
    });
  });

  it("other 桶兜底不丢", () => {
    const files = [
      { path: "p/README.md", name: "README.md", bucket: "other" as const },
      { path: "p/2026-08-28.md", name: "2026-08-28.md", bucket: "daily" as const },
    ];
    const groups = groupByBucket(files);
    expect(groups.other.map((f) => f.name)).toEqual(["README.md"]);
    expect(groups.daily.map((f) => f.name)).toEqual(["2026-08-28.md"]);
  });
});
