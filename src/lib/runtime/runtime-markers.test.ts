import { describe, it, expect } from "vitest";
import { stripRuntimeMarkers } from "./runtime-markers";

describe("stripRuntimeMarkers", () => {
  it("剥掉 checkpoint / awaiting / git 三类运行时标签", () => {
    const raw = [
      '<checkpoint step=1 summary="收到派发通知：先读原表"/>',
      "",
      "需求明确，开始改代码。",
      '<awaiting type="choice" question="选哪个"/>',
      '<git commit-id="abc1234"/>',
      "改完了。",
    ].join("\n");
    expect(stripRuntimeMarkers(raw)).toBe("需求明确，开始改代码。\n\n改完了。");
  });

  it("容忍带属性的完整形态 + 自闭合混排", () => {
    const raw =
      '<checkpoint step=2 summary="定位限制点" by="runtime" status="done"/>\n正文一行';
    expect(stripRuntimeMarkers(raw)).toBe("正文一行");
  });

  it("不误伤正文里的泛指尖括号文本", () => {
    const raw = "用 <div> 渲染，泛型写法 Array<string>。";
    expect(stripRuntimeMarkers(raw)).toBe("用 <div> 渲染，泛型写法 Array<string>。");
  });

  it("剥完只剩标签 → 空串; null/undefined → 空串", () => {
    expect(stripRuntimeMarkers('<checkpoint step=1 summary="x"/>')).toBe("");
    expect(stripRuntimeMarkers(null)).toBe("");
    expect(stripRuntimeMarkers(undefined)).toBe("");
  });

  it("剥完的连续空行压成单个空行", () => {
    const raw = '第一段。\n\n<checkpoint step=1 summary="a"/>\n\n\n\n第二段。';
    expect(stripRuntimeMarkers(raw)).toBe("第一段。\n\n第二段。");
  });
});
