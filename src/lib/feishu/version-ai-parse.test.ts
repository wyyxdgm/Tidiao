// v513 (飞书 R172) — version-ai-parse 纯函数单测.
// LLM / lark-cli 路径不做网络测试 (fetchSheetMetas / parseVersionInput 端到端
// 依赖外部进程), 只测确定性解析层.

import { describe, it, expect } from "vitest";
import {
  extractFeishuUrls,
  matchSheetToName,
  buildParseSystemPrompt,
  buildParseUserPrompt,
  extractJson,
} from "./version-ai-parse";

const SHEETS = [
  { sheet_id: "885c32", title: "看板", index: 0 },
  { sheet_id: "J7heSX", title: "AO-DEV", index: 3 },
  { sheet_id: "50IZV1", title: "yidao", index: 4 },
];

describe("extractFeishuUrls", () => {
  it("extracts wiki URL with sheet id from free text", () => {
    const urls = extractFeishuUrls(
      "新建版本，表在 https://my.feishu.cn/wiki/ABC123?sheet=885c32 用于追踪需求",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0].wikiUrl).toBe("https://my.feishu.cn/wiki/ABC123");
    expect(urls[0].sheetIdFromQuery).toBe("885c32");
  });

  it("returns empty for text without feishu urls", () => {
    expect(extractFeishuUrls("就是一个 v1.7 的需求追踪版本")).toHaveLength(0);
  });

  it("ignores non-feishu urls", () => {
    expect(extractFeishuUrls("参考 https://example.com/foo?sheet=abc")).toHaveLength(0);
  });

  it("strips trailing chinese punctuation from urls", () => {
    const urls = extractFeishuUrls(
      "表：https://my.feishu.cn/wiki/ABC123?sheet=885c32，麻烦建一下",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0].wikiUrl).toContain("ABC123");
  });

  it("keeps urls without sheet query (sheetIdFromQuery null)", () => {
    const urls = extractFeishuUrls("https://my.feishu.cn/wiki/XYZ789");
    expect(urls).toHaveLength(1);
    expect(urls[0].sheetIdFromQuery).toBeNull();
  });
});

describe("matchSheetToName", () => {
  it("maps sheet id to title", () => {
    expect(matchSheetToName("J7heSX", SHEETS)).toBe("AO-DEV");
  });

  it("passes through exact title", () => {
    expect(matchSheetToName("AO-DEV", SHEETS)).toBe("AO-DEV");
  });

  it("fuzzy-matches title prefix", () => {
    expect(matchSheetToName("AO", SHEETS)).toBe("AO-DEV");
  });

  it("returns null when no match", () => {
    expect(matchSheetToName("nope", SHEETS)).toBeNull();
    expect(matchSheetToName("", SHEETS)).toBeNull();
  });
});

describe("buildParseSystemPrompt", () => {
  it("mentions conservative null rule and json-only output", () => {
    const p = buildParseSystemPrompt();
    expect(p).toContain("null");
    expect(p).toContain("JSON");
  });
});

describe("buildParseUserPrompt", () => {
  it("includes project context, versions, sheets and user text", () => {
    const p = buildParseUserPrompt({
      projectName: "partner",
      projectCwd: "/home/user/workspace/partner",
      existingVersions: [{ name: "v1.0", description: "初始" }],
      userText: "建 v1.1 追踪 GDM 需求",
      url: {
        raw: "https://my.feishu.cn/wiki/ABC?sheet=885c32",
        wikiUrl: "https://my.feishu.cn/wiki/ABC",
        sheetIdFromQuery: "885c32",
      },
      sheets: SHEETS,
      idMappedSheetName: "看板",
    });
    expect(p).toContain("partner");
    expect(p).toContain("v1.0");
    expect(p).toContain("看板");
    expect(p).toContain("建 v1.1 追踪 GDM 需求");
    expect(p).toContain("885c32");
  });
});

describe("extractJson", () => {
  it("parses plain json object", () => {
    expect(extractJson('{"name":"v1.1"}')).toEqual({ name: "v1.1" });
  });

  it("parses json inside code fence / surrounding text", () => {
    expect(extractJson('好的：```json\n{"name":"v2"}\n```')).toEqual({ name: "v2" });
  });

  it("returns null for non-json", () => {
    expect(extractJson("没有对象")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
});
