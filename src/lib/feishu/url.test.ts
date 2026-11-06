import { describe, it, expect } from "vitest";
import { normalizeSheetUrl } from "./url";

describe("normalizeSheetUrl", () => {
  // 基础形态
  it("strips ?sheet= from clean wiki URL", () => {
    const r = normalizeSheetUrl(
      "https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?sheet=1XzOKi",
    );
    expect(r.wikiUrl).toBe("https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d");
    expect(r.sheetIdFromQuery).toBe("1XzOKi");
  });

  it("returns clean wiki URL untouched when no query", () => {
    const r = normalizeSheetUrl(
      "https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d",
    );
    expect(r.wikiUrl).toBe("https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d");
    expect(r.sheetIdFromQuery).toBeNull();
  });

  // 多个 query 参数
  it("only strips ?sheet=, keeps other query params", () => {
    const r = normalizeSheetUrl(
      "https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?sheet=1XzOKi&view=grid",
    );
    // Node URL.searchParams 会对非保留字符重新编码(: 等),实测会被 encode 成 %3A;
    // lark-cli 接 URL-encoded 与未编码行为一致,这里只断言 path + sheet 抽取.
    expect(r.wikiUrl).toBe("https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?view=grid");
    expect(r.sheetIdFromQuery).toBe("1XzOKi");
  });

  it("preserves query order when ?sheet= is not the first param", () => {
    const r = normalizeSheetUrl(
      "https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?view=grid&sheet=abc",
    );
    expect(r.wikiUrl).toBe("https://my.feishu.cn/wiki/PGBDwgCWWiW3wukVqrCcjcPjn5d?view=grid");
    expect(r.sheetIdFromQuery).toBe("abc");
  });

  // 直接 sheet URL 形态（不转 wiki,不强猜）
  it("returns direct /sheets/xxx URL untouched with sheet_id from path", () => {
    const r = normalizeSheetUrl("https://my.feishu.cn/sheets/1XzOKi");
    expect(r.wikiUrl).toBe("https://my.feishu.cn/sheets/1XzOKi");
    expect(r.sheetIdFromQuery).toBe("1XzOKi");
  });

  // 非飞书域名
  it("returns non-feishu domain URL untouched", () => {
    const r = normalizeSheetUrl("https://internal.example.com/wiki/abc?sheet=xyz");
    expect(r.wikiUrl).toBe("https://internal.example.com/wiki/abc?sheet=xyz");
    expect(r.sheetIdFromQuery).toBeNull();
  });

  it("recognizes larksuite.com domain", () => {
    const r = normalizeSheetUrl(
      "https://acme.larksuite.com/wiki/WikiToken?sheet=SheetId123",
    );
    expect(r.wikiUrl).toBe("https://acme.larksuite.com/wiki/WikiToken");
    expect(r.sheetIdFromQuery).toBe("SheetId123");
  });

  // 边界
  it("returns empty for empty input", () => {
    expect(normalizeSheetUrl("")).toEqual({ wikiUrl: "", sheetIdFromQuery: null });
    expect(normalizeSheetUrl("   ")).toEqual({ wikiUrl: "", sheetIdFromQuery: null });
  });

  it("trims surrounding whitespace before parsing", () => {
    const r = normalizeSheetUrl(
      "  https://my.feishu.cn/wiki/Tok?sheet=Sheet1  ",
    );
    expect(r.wikiUrl).toBe("https://my.feishu.cn/wiki/Tok");
    expect(r.sheetIdFromQuery).toBe("Sheet1");
  });

  it("throws on malformed URL", () => {
    expect(() => normalizeSheetUrl("not a url at all")).toThrow(/Invalid sheet URL/);
  });

  // 协议兜底
  it("keeps http:// if explicitly provided (don't force https)", () => {
    const r = normalizeSheetUrl("http://my.feishu.cn/wiki/Tok?sheet=abc");
    expect(r.wikiUrl).toBe("http://my.feishu.cn/wiki/Tok");
    expect(r.sheetIdFromQuery).toBe("abc");
  });

  // ?sheet= 在 path 后无值
  it("handles empty ?sheet= value", () => {
    const r = normalizeSheetUrl("https://my.feishu.cn/wiki/Tok?sheet=");
    expect(r.wikiUrl).toBe("https://my.feishu.cn/wiki/Tok");
    expect(r.sheetIdFromQuery).toBe("");
  });
});