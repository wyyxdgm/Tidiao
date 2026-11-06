// R122 / T1.1 标签 helper 单测.
// 关注点: parseTags/formatTags/addTag 是无副作用纯函数, 不需要 DB fixture.

import { describe, it, expect } from "vitest";
import { TAG_PREFIX, parseTags, formatTags, addTag } from "./tags";

describe("TAG_PREFIX", () => {
  it("三个命名空间前缀固定, 改值要全局同步", () => {
    expect(TAG_PREFIX.dimension).toBe("dim:");
    expect(TAG_PREFIX.module).toBe("mod:");
    expect(TAG_PREFIX.requirement).toBe("req:");
  });
});

describe("parseTags", () => {
  it("按命名空间拆分, 去前缀, 去重", () => {
    const raw = JSON.stringify(["dim:auth", "mod:api", "req:R12", "dim:auth"]);
    expect(parseTags(raw)).toEqual({
      dimensions: ["auth"],
      modules: ["api"],
      requirements: ["R12"],
    });
  });

  it("空 / null 降级为空桶, 不抛 (脏数据 = 非 JSON 数组时归入 dimensions 兜底)", () => {
    expect(parseTags(null)).toEqual({ dimensions: [], modules: [], requirements: [] });
    expect(parseTags(undefined)).toEqual({ dimensions: [], modules: [], requirements: [] });
    expect(parseTags("")).toEqual({ dimensions: [], modules: [], requirements: [] });
    expect(parseTags("not json")).toEqual({ dimensions: ["not json"], modules: [], requirements: [] });
    expect(parseTags('{"not":"array"}')).toEqual({ dimensions: [], modules: [], requirements: [] });
  });

  it("无前缀标签归入 dimensions 兜底 (上游应自觉加前缀, 不该有)", () => {
    const raw = JSON.stringify(["legacy-tag", "mod:db"]);
    expect(parseTags(raw)).toEqual({
      dimensions: ["legacy-tag"],
      modules: ["db"],
      requirements: [],
    });
  });

  it("顺序稳定: dim → mod → req (跨类互不交叉)", () => {
    const raw = JSON.stringify(["req:R1", "dim:d1", "mod:m1", "req:R2", "dim:d2"]);
    const out = parseTags(raw);
    expect(out.dimensions).toEqual(["d1", "d2"]);
    expect(out.modules).toEqual(["m1"]);
    expect(out.requirements).toEqual(["R1", "R2"]);
  });
});

describe("formatTags", () => {
  it("三类各自拼前缀, 空数组不输出", () => {
    expect(formatTags(["a", "b"], ["x"], ["R1"])).toEqual([
      "dim:a",
      "dim:b",
      "mod:x",
      "req:R1",
    ]);
  });

  it("formatTags ∘ parseTags round-trip 一致 (除顺序)", () => {
    const raw = JSON.stringify(["dim:a", "mod:b", "req:R1"]);
    const parsed = parseTags(raw);
    const back = formatTags(parsed.dimensions, parsed.modules, parsed.requirements);
    expect(back.sort()).toEqual(["dim:a", "mod:b", "req:R1"]);
  });

  it("三类全空返回 []", () => {
    expect(formatTags([], [], [])).toEqual([]);
  });

  it("空串元素跳过, 不输出 dim: 这种裸前缀", () => {
    expect(formatTags(["", "a"], ["  "], ["R1"])).toEqual(["dim:a", "req:R1"]);
  });
});

describe("addTag", () => {
  it("null 入参 = 新建数组", () => {
    expect(addTag(null, "dim", "foo")).toEqual(["dim:foo"]);
  });

  it("追加并自带前缀, 已存在则幂等不重复", () => {
    expect(addTag(["dim:foo"], "mod", "bar")).toEqual(["dim:foo", "mod:bar"]);
    expect(addTag(["dim:foo", "mod:bar"], "dim", "foo")).toEqual(["dim:foo", "mod:bar"]);
  });

  it("value 已带前缀 = 去重再拼 (避免 dim:dim:foo)", () => {
    expect(addTag(null, "dim", "dim:foo")).toEqual(["dim:foo"]);
    expect(addTag(["dim:foo"], "dim", "dim:foo")).toEqual(["dim:foo"]);
  });

  it("空 value 不变 (返回新数组, 不改原数组)", () => {
    const orig = ["dim:foo"];
    const out = addTag(orig, "dim", "");
    expect(out).toEqual(["dim:foo"]);
    expect(out).not.toBe(orig); // immutable
    expect(orig).toEqual(["dim:foo"]); // 原数组未改
  });

  it("三种 kind 都能用 (不限定顺序)", () => {
    const t0: string[] = [];
    const t1 = addTag(t0, "req", "R12");
    const t2 = addTag(t1, "dim", "auth");
    const t3 = addTag(t2, "mod", "api");
    expect(t3).toEqual(["req:R12", "dim:auth", "mod:api"]);
  });
});