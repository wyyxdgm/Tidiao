// useAvailableModels 单元测试.
// 覆盖 (聚合纯函数 aggregateModelOptions):
//   1. 空 inputs → options = default + builtin (MODEL_OPTIONS 兜底)
//   2. 并集去重 (configured 优先于 builtin/used)
//   3. configured 带 name → label 含 (name)
//   4. used 但已存在于 builtin/used → 不重复
//   5. label 标记: [已配置] / [内置] / [历史] / default
//   6. 空字符串 / 全空 model 不入选项
//   7. used 顺序: configured → builtin → used (严格按序, source 标记正确)
//
// 关注点:
//   - 测试纯函数, 不依赖 React DOM (项目 vitest 未配 jsdom/happy-dom).
//   - hook 自身的 fetch + cleanup 逻辑由人工冒烟 (验证 UI 时一并验).

import { describe, it, expect } from "vitest";
import {
  aggregateModelOptions,
  DEFAULT_MODEL_OPTION,
  type AvailableLlmConfigSummary,
} from "./use-available-models";
import { MODEL_OPTIONS } from "@/lib/constants";

const baseConfig: AvailableLlmConfigSummary = {
  id: "cfg-1",
  source: "self",
  name: "my-config",
  type: "anthropic",
  has_api_key: true,
  base_url: null,
  model: null,
  is_default: true,
};

describe("aggregateModelOptions", () => {
  it("空 inputs → options = default + builtin 兜底", () => {
    const options = aggregateModelOptions([], []);
    expect(options[0]).toEqual(DEFAULT_MODEL_OPTION);

    const values = options.map((o) => o.value);
    expect(values[0]).toBe("");

    // builtin 中所有非空 model 都应出现
    const builtinValues = MODEL_OPTIONS.filter((o) => o.value).map((o) => o.value);
    for (const v of builtinValues) expect(values).toContain(v);

    // 所有 source 应是 default 或 builtin
    const sources = new Set(options.map((o) => o.source));
    expect(sources.has("used")).toBe(false);
    expect(sources.has("configured")).toBe(false);
  });

  it("configured 优先于 builtin (去重 + source 标记)", () => {
    const dupModel = "glm-latest"; // 同时在 builtin 里
    const options = aggregateModelOptions(
      [{ ...baseConfig, model: dupModel, name: "my-glm" }],
      []
    );
    const opt = options.find((o) => o.value === dupModel);
    expect(opt?.source).toBe("configured");
    expect(opt?.label).toContain("[已配置]");
    expect(opt?.label).toContain("my-glm");
  });

  it("used 不与 configured/builtin 重复时 → source=used + [历史]", () => {
    const options = aggregateModelOptions(
      [{ ...baseConfig, model: "only-configured" }],
      ["only-used"]
    );
    const used = options.find((o) => o.value === "only-used");
    expect(used?.source).toBe("used");
    expect(used?.label).toContain("[历史]");
  });

  it("used 与 builtin 重复 → 不进 used (builtin 先到先得)", () => {
    const builtinValue = MODEL_OPTIONS.find((o) => o.value)?.value;
    if (!builtinValue) throw new Error("no builtin value in MODEL_OPTIONS");
    const options = aggregateModelOptions([], [builtinValue]);
    const occ = options.filter((o) => o.value === builtinValue);
    expect(occ).toHaveLength(1);
    expect(occ[0].source).toBe("builtin");
  });

  it("used 与 configured 重复 → configured 保留, used 不入", () => {
    const dup = "my-model";
    const options = aggregateModelOptions(
      [{ ...baseConfig, model: dup, name: "n" }],
      [dup]
    );
    const occ = options.filter((o) => o.value === dup);
    expect(occ).toHaveLength(1);
    expect(occ[0].source).toBe("configured");
  });

  it("configured 无 model 字段 → 不入选项 (跳过)", () => {
    const options = aggregateModelOptions(
      [{ ...baseConfig, model: null }],
      []
    );
    // default + builtin 仍在; configured 为空的 config 不产生条目
    const configured = options.filter((o) => o.source === "configured");
    expect(configured).toHaveLength(0);
  });

  it("trim 空白: '  m1  ' 与 'm1' 视为同一条", () => {
    const options = aggregateModelOptions([], ["  m1  "]);
    expect(options.find((o) => o.value === "m1")).toBeDefined();
    expect(options.find((o) => o.value === "  m1  ")).toBeUndefined();
  });

  it("空字符串 / 全空白 model 不入选项", () => {
    const options = aggregateModelOptions([], ["", "   "]);
    const values = options.map((o) => o.value);
    // 只有 default (空字符串) + builtin
    const empty = values.filter((v) => v === "");
    expect(empty).toHaveLength(1);
    expect(values.includes("   ")).toBe(false);
  });

  it("顺序严格: default → configured → builtin → used", () => {
    const options = aggregateModelOptions(
      [{ ...baseConfig, model: "alpha", name: "a" }],
      ["zulu"]
    );
    const sources = options.map((o) => o.source);
    // 找每个 source 的首次出现 index
    const firstIdx = (s: string) => sources.findIndex((x) => x === s);
    expect(firstIdx("default")).toBe(0);
    expect(firstIdx("configured")).toBeGreaterThan(firstIdx("default"));
    expect(firstIdx("builtin")).toBeGreaterThan(firstIdx("configured"));
    expect(firstIdx("used")).toBeGreaterThan(firstIdx("builtin"));
  });
});
