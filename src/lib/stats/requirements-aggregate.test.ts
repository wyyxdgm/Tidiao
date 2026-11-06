// R122 / T2.3.2: 需求聚合 helper 单测.
// 关注点:
//   - 双轨: task 数 + commit 数 (base/head 去重).
//   - 重名合并: req:R122 + req:R122 算 1 个 req.
//   - 排序: task 数降序 → name 字典序.
//   - 脏数据兜底: tags=null / 非 JSON / 非数组.
//   - 一 task 多 req:* → 该 task 在每个 req 桶里都 +1 (跨桶共享).
//   - status 过滤: completed/failed 计数.

import { describe, it, expect } from "vitest";
import { aggregateRequirements } from "./requirements-aggregate";

describe("aggregateRequirements", () => {
  it("空入参返回空数组", () => {
    expect(aggregateRequirements([])).toEqual([]);
  });

  it("基本: 单 task 单 req, completed=1, commit=1", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: 1.5,
        base_commit: "abc",
        head_commit: "def",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: "R122",
      taskCount: 1,
      completed: 1,
      failed: 0,
      commitCount: 1,
      costUsd: 1.5,
    });
  });

  it("双轨: task 数 + commit 数 (去重)", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: 1,
        base_commit: null,
        head_commit: "commit-A",
      },
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: 1,
        base_commit: null,
        head_commit: "commit-B",
      },
      {
        tags: JSON.stringify(["req:R122"]),
        status: "failed",
        cost_usd: 0.5,
        base_commit: null,
        head_commit: "commit-A", // 重复
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].taskCount).toBe(3);
    expect(out[0].completed).toBe(2);
    expect(out[0].failed).toBe(1);
    expect(out[0].commitCount).toBe(2); // A + B 去重
    expect(out[0].costUsd).toBe(2.5);
  });

  it("commit 锚点: head 优先, 没 head 才退 base", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: 0,
        base_commit: "base-1",
        head_commit: "head-1",
      },
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: 0,
        base_commit: "base-2",
        head_commit: null,
      },
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: 0,
        base_commit: null,
        head_commit: null, // 无 commit = 不计入 commit 数
      },
    ]);
    expect(out[0].taskCount).toBe(3);
    expect(out[0].commitCount).toBe(2); // head-1 + base-2
  });

  it("重名合并: 同一 req 名共享桶", () => {
    const out = aggregateRequirements([
      { tags: JSON.stringify(["req:R122"]), status: "completed", cost_usd: 1, base_commit: null, head_commit: "a" },
      { tags: JSON.stringify(["req:R122"]), status: "completed", cost_usd: 1, base_commit: null, head_commit: "b" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].taskCount).toBe(2);
    expect(out[0].commitCount).toBe(2);
  });

  it("一 task 多 req:* → 在每个 req 桶里都 +1 (跨桶共享)", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:R122", "req:用户登录"]),
        status: "completed",
        cost_usd: 2,
        base_commit: null,
        head_commit: "c1",
      },
    ]);
    expect(out).toHaveLength(2);
    const r122 = out.find((a) => a.name === "R122");
    const login = out.find((a) => a.name === "用户登录");
    expect(r122?.taskCount).toBe(1);
    expect(login?.taskCount).toBe(1);
    expect(r122?.commitCount).toBe(1);
    expect(login?.commitCount).toBe(1);
  });

  it("排序: task 数降序, 同数字典序", () => {
    const out = aggregateRequirements([
      { tags: JSON.stringify(["req:A"]), status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: JSON.stringify(["req:B"]), status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: JSON.stringify(["req:B"]), status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: JSON.stringify(["req:C"]), status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: JSON.stringify(["req:C"]), status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: JSON.stringify(["req:C"]), status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
    ]);
    expect(out.map((a) => a.name)).toEqual(["C", "B", "A"]);
  });

  it("脏数据兜底: tags=null/undefined/非 JSON/非数组 都不抛, 不计入", () => {
    const out = aggregateRequirements([
      { tags: null, status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: "", status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: "", status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: "not json", status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
      { tags: '{"not":"array"}', status: "completed", cost_usd: 0, base_commit: null, head_commit: null },
    ]);
    expect(out).toEqual([]);
  });

  it("非 req:* 标签被忽略 (dim/mod 标签不计入 req 聚合)", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["dim:backend", "mod:auth", "req:R122"]),
        status: "completed",
        cost_usd: 0,
        base_commit: null,
        head_commit: null,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("R122");
  });

  it("cost_usd=null / 非 number 不报错, 视为 0", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:R122"]),
        status: "completed",
        cost_usd: null,
        base_commit: null,
        head_commit: null,
      },
    ]);
    expect(out[0].costUsd).toBe(0);
  });

  it("空 req 名被跳过 (req: 这种裸前缀不计入)", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:", "req:R122"]),
        status: "completed",
        cost_usd: 0,
        base_commit: null,
        head_commit: null,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("R122");
  });

  it("中文需求名正常处理", () => {
    const out = aggregateRequirements([
      {
        tags: JSON.stringify(["req:用户登录", "req:微信支付接入"]),
        status: "completed",
        cost_usd: 0,
        base_commit: null,
        head_commit: "c1",
      },
    ]);
    expect(out.map((a) => a.name).sort()).toEqual(["微信支付接入", "用户登录"]);
  });
});
