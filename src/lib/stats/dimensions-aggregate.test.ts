// R122 / T2.3.1: 维度聚合 helper 单测.
// 关注点:
//   - cost.by_tag + tasks.tags 同时聚合, 同一 dim 多 task 多 cost 累加正确.
//   - canonical 4 个 (backend/frontend/infra/沟通) 始终占位, 即使无数据 = UI 稳定.
//   - 非 canonical dim 仅在 cost 或 task 至少一项 > 0 时出现 (不污染空状态).
//   - 排序: canonical 置顶 → task 数降序 → name 字典序.
//   - 脏数据兜底: tags=null / 非 JSON / 非数组.

import { describe, it, expect } from "vitest";
import { aggregateDimensions, CANONICAL_DIMS } from "./dimensions-aggregate";

describe("aggregateDimensions", () => {
  it("空入参返回 4 个 canonical 占位 (零值, 全 canonical)", () => {
    const out = aggregateDimensions({}, []);
    expect(out).toHaveLength(CANONICAL_DIMS.length);
    expect(out.every((d) => d.isCanonical)).toBe(true);
    expect(out.every((d) => d.costUsd === 0 && d.taskCount === 0)).toBe(true);
    // 顺序固定 = canonical 数组顺序
    expect(out.map((d) => d.name)).toEqual([...CANONICAL_DIMS]);
  });

  it("从 cost.by_tag 聚合 dim:* 花费", () => {
    const out = aggregateDimensions(
      {
        "dim:backend": 5.5,
        "dim:frontend": 3.2,
        "mod:auth": 1.0, // 非 dim, 不计入
        "req:R122": 0.5, // 非 dim, 不计入
      },
      []
    );
    const backend = out.find((d) => d.name === "backend");
    const frontend = out.find((d) => d.name === "frontend");
    expect(backend?.costUsd).toBe(5.5);
    expect(frontend?.costUsd).toBe(3.2);
    expect(out.find((d) => d.name === "auth")).toBeUndefined();
  });

  it("从 task 列表聚合 task 数 (一个 task 多 dim 各计一次)", () => {
    const out = aggregateDimensions(
      {},
      [
        { tags: JSON.stringify(["dim:backend", "dim:frontend"]) },
        { tags: JSON.stringify(["dim:backend"]) },
        { tags: JSON.stringify(["mod:api"]) }, // 不计入
        { tags: null }, // 兜底
        { tags: "not json" }, // 兜底 = 不计入, 不抛
      ]
    );
    const backend = out.find((d) => d.name === "backend");
    const frontend = out.find((d) => d.name === "frontend");
    expect(backend?.taskCount).toBe(2);
    expect(frontend?.taskCount).toBe(1);
    expect(out.find((d) => d.name === "api")).toBeUndefined();
  });

  it("cost + task 双源合并: backend 既有花费又有 task", () => {
    const out = aggregateDimensions(
      { "dim:backend": 10 },
      [{ tags: JSON.stringify(["dim:backend"]) }]
    );
    const backend = out.find((d) => d.name === "backend");
    expect(backend?.costUsd).toBe(10);
    expect(backend?.taskCount).toBe(1);
  });

  it("非 canonical dim 出现在 task 数 > 0 时", () => {
    const out = aggregateDimensions({}, [{ tags: JSON.stringify(["dim:exotic"]) }]);
    const exotic = out.find((d) => d.name === "exotic");
    expect(exotic).toBeDefined();
    expect(exotic?.isCanonical).toBe(false);
    expect(exotic?.taskCount).toBe(1);
  });

  it("排序: canonical 置顶, 同 canonical 内 task 数降序, 同数字典序", () => {
    const out = aggregateDimensions(
      {},
      [
        { tags: JSON.stringify(["dim:exotic1"]) },
        { tags: JSON.stringify(["dim:backend"]) },
        { tags: JSON.stringify(["dim:backend"]) },
        { tags: JSON.stringify(["dim:frontend"]) },
      ]
    );
    // canonical: backend(2) → frontend(1) → infra(0) → 沟通(0)
    // 非 canonical: exotic1(1)
    expect(out.map((d) => d.name)).toEqual([
      "backend",
      "frontend",
      "infra",
      "沟通",
      "exotic1",
    ]);
  });

  it("同 canonical 同 task 数时按 name 字典序", () => {
    const out = aggregateDimensions(
      {},
      [
        { tags: JSON.stringify(["dim:frontend"]) },
        { tags: JSON.stringify(["dim:backend"]) },
      ]
    );
    // canonical 互比, task 都是 1, 按字典序 backend → frontend
    expect(out[0].name).toBe("backend");
    expect(out[1].name).toBe("frontend");
  });

  it("脏数据兜底: tags=null / 非 JSON / 非数组 都不抛", () => {
    const out = aggregateDimensions(
      {},
      [
        { tags: null },
        { tags: "" },
        { tags: "not json" },
        { tags: '{"not":"array"}' },
        { tags: "null" },
      ]
    );
    // 全部 0 个非 canonical, 只剩 canonical 占位
    expect(out.every((d) => d.isCanonical)).toBe(true);
  });

  it("cost.by_tag 脏数据兜底: 非 number / 非 string key 不抛", () => {
    const out = aggregateDimensions(
      {
        "dim:backend": 5,
        // @ts-expect-error 测试脏数据
        "dim:bogus": "not a number",
        // @ts-expect-error 测试脏数据
        123: "weird key",
      },
      []
    );
    const backend = out.find((d) => d.name === "backend");
    const bogus = out.find((d) => d.name === "bogus");
    expect(backend?.costUsd).toBe(5);
    expect(bogus).toBeUndefined(); // 非数字 cost 跳过
  });

  it("去重: 同一 task 多个相同 dim 只计一次", () => {
    const out = aggregateDimensions(
      {},
      [{ tags: JSON.stringify(["dim:backend", "dim:backend", "dim:backend"]) }]
    );
    const backend = out.find((d) => d.name === "backend");
    expect(backend?.taskCount).toBe(1);
  });
});
