// wiki mermaid 检测纯函数单测 — 验证 react-markdown code 元素 props → {isMermaid, code}
// 的解构逻辑; 实际渲染由客户端 MermaidBlock 走 useEffect 测不了, 这里只保 props 解构
// 边界.

import { describe, it, expect } from "vitest";
import {
  classNameToArray,
  detectMermaid,
} from "./wiki-mermaid";

describe("classNameToArray", () => {
  it("字符串按空白拆分并去空", () => {
    expect(classNameToArray("language-mermaid foo bar")).toEqual([
      "language-mermaid",
      "foo",
      "bar",
    ]);
  });

  it("字符串数组原样过滤非字符串元素", () => {
    expect(
      classNameToArray(["language-mermaid", 42, null, "hl-1"] as unknown as string[])
    ).toEqual(["language-mermaid", "hl-1"]);
  });

  it("空 / null / undefined / 非字符串非数组 → 空数组", () => {
    expect(classNameToArray("")).toEqual([]);
    expect(classNameToArray(undefined)).toEqual([]);
    expect(classNameToArray(null)).toEqual([]);
    expect(classNameToArray(123 as unknown as string)).toEqual([]);
    expect(classNameToArray({} as unknown as string)).toEqual([]);
  });
});

describe("detectMermaid", () => {
  it("language-mermaid 字符串 → isMermaid=true, code=源码", () => {
    const child = {
      props: {
          className: "language-mermaid",
          children: "graph TD\nA-->B",
        },
    };
    const r = detectMermaid(child);
    expect(r.isMermaid).toBe(true);
    expect(r.code).toBe("graph TD\nA-->B");
  });

  it("language-mermaid 数组形式 → 命中", () => {
    const child = {
      props: {
        className: ["language-mermaid", "hl-1"],
        children: "erDiagram\nA ||--o{ B : link",
      },
    };
    const r = detectMermaid(child);
    expect(r.isMermaid).toBe(true);
    expect(r.code).toBe("erDiagram\nA ||--o{ B : link");
  });

  it("非 mermaid class (language-typescript 等) → 跳过", () => {
    const child = {
      props: {
        className: "language-typescript",
        children: "const x = 1;",
      },
    };
    expect(detectMermaid(child).isMermaid).toBe(false);
  });

  it("无 className → 跳过", () => {
    const child = { props: { children: "raw text" } };
    expect(detectMermaid(child).isMermaid).toBe(false);
  });

  it("null / undefined / 字符串 / 非对象 → 不崩, isMermaid=false", () => {
    expect(detectMermaid(null).isMermaid).toBe(false);
    expect(detectMermaid(undefined).isMermaid).toBe(false);
    expect(detectMermaid("raw").isMermaid).toBe(false);
    expect(detectMermaid(42).isMermaid).toBe(false);
  });

  it("空 children → isMermaid=true, code=空串 (上游会渲染空图, 不静默丢)", () => {
    const child = {
      props: {
        className: "language-mermaid",
        children: "",
      },
    };
    const r = detectMermaid(child);
    expect(r.isMermaid).toBe(true);
    expect(r.code).toBe("");
  });

  it("children 非字符串 (数字 / 数组) → String() 强转, 不崩", () => {
    const cases = [
      [123, "123"],
      [[1, 2], "1,2"],
    ] as const;
    for (const [raw, expected] of cases) {
      const r = detectMermaid({
        props: { className: "language-mermaid", children: raw },
      });
      expect(r.isMermaid).toBe(true);
      expect(r.code).toBe(expected);
    }
  });

  it("children 为 null / undefined → code 空串 (上游会渲染空图, 不静默丢)", () => {
    for (const raw of [null, undefined]) {
      const r = detectMermaid({
        props: { className: "language-mermaid", children: raw },
      });
      expect(r.isMermaid).toBe(true);
      expect(r.code).toBe("");
    }
  });

  it("无 props 字段的对象 → 不崩, isMermaid=false", () => {
    expect(detectMermaid({}).isMermaid).toBe(false);
    expect(detectMermaid({ foo: 1 }).isMermaid).toBe(false);
  });
});