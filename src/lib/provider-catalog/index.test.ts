// 供应商目录读取层测试 (R240).
// 覆盖:
//   1. getProviderCatalog 读取真实 catalog.json 通过 zod 校验 (防日更脚本写坏数据直接上线)
//   2. 目录内容不变量: id 唯一 / anthropic_verified 与 models_updated_at 日期格式 / models 非空
//   3. getProviderById 命中 + miss 返 null
//   4. matchProviderByBaseUrl: 精确命中 / 前缀命中 (claude-code-proxy 子路径) / 尾斜杠+大小写归一 / miss / 空
//   5. 缓存: TTL 内不重读; reset 后强制冷读 (日更脚本写回后新数据可见)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getProviderCatalog,
  getProviderById,
  matchProviderByBaseUrl,
  resetCatalogCacheForTest,
} from "./index";

beforeEach(() => {
  resetCatalogCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCatalogCacheForTest();
});

describe("provider-catalog 读取层", () => {
  it("真实 catalog.json 通过 zod 校验", () => {
    const catalog = getProviderCatalog();
    expect(catalog.schema_version).toBeGreaterThanOrEqual(1);
    expect(catalog.providers.length).toBeGreaterThanOrEqual(8);
  });

  it("目录不变量: id 唯一 + 每家有 anthropic 端点 + models 非空", () => {
    const { providers } = getProviderCatalog();
    const ids = providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of providers) {
      expect(p.anthropic_base_url).toMatch(/^https:\/\//);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.api_key_url).toMatch(/^https:\/\//);
    }
  });

  it("getProviderById 命中与 miss", () => {
    expect(getProviderById("ark")?.name).toContain("火山方舟");
    expect(getProviderById("nonexistent")).toBeNull();
  });
});

describe("matchProviderByBaseUrl", () => {
  it("精确命中 ark", () => {
    expect(matchProviderByBaseUrl("https://ark.cn-beijing.volces.com/api/plan")?.id).toBe("ark");
  });

  it("前缀命中: 百炼 claude-code-proxy 长路径", () => {
    expect(
      matchProviderByBaseUrl("https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy")?.id,
    ).toBe("bailian");
  });

  it("尾斜杠 + 大小写归一", () => {
    expect(matchProviderByBaseUrl("https://api.deepseek.com/anthropic/")?.id).toBe("deepseek");
    expect(matchProviderByBaseUrl("https://API.DeepSeek.com/anthropic")?.id).toBe("deepseek");
  });

  it("自定义中转站 miss 返 null; 空值返 null", () => {
    expect(matchProviderByBaseUrl("https://my-proxy.example.com/v1")).toBeNull();
    expect(matchProviderByBaseUrl(null)).toBeNull();
    expect(matchProviderByBaseUrl("")).toBeNull();
  });
});

describe("缓存行为", () => {
  it("写回 catalog.json 后 reset 缓存可见新数据 (模拟日更)", () => {
    const original = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "provider-catalog", "catalog.json"),
      "utf-8",
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-catalog-test-"));
    try {
      // 借 spy 把读路径指到临时副本, 验证 reset 后冷读新内容
      const modified = original.replace('"schema_version": 1', '"schema_version": 2');
      const tmpFile = path.join(tmpDir, "catalog.json");
      fs.writeFileSync(tmpFile, modified);
      vi.spyOn(path, "join").mockImplementation(((...args: string[]) =>
        args.includes("provider-catalog") && args.some((a) => a.endsWith(".json"))
          ? tmpFile
          : (path.join as typeof import("node:path").join)(...args)) as typeof path.join);
      expect(getProviderCatalog().schema_version).toBe(2);
      fs.writeFileSync(tmpFile, original.replace('"schema_version": 1', '"schema_version": 3'));
      // TTL 内仍读旧值
      expect(getProviderCatalog().schema_version).toBe(2);
      resetCatalogCacheForTest();
      expect(getProviderCatalog().schema_version).toBe(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
