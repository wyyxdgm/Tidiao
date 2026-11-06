// TabStrip sticky top-0 smoke 测 (飞书 AO-DEV R129).
//
// 功能: 验证 TabStrip 外层 wrapper class 含 `sticky top-0`, 内容滚动时 tab 条
//   保持固定在视口顶部不随页面滚动消失.
//
// 关注点:
//   - 本仓未装 @testing-library/react (见 src/app/stats/tabs/dimensions.test.tsx),
//     沿用「读源文件 + 正则」smoke 风格.
//   - class 含 sticky + top-0 即可, 不依赖 DOM 实际渲染; 真正的 sticky 行为在
//     浏览器里 CSS 引擎处理, 这条测只防 class 被改回 plain 状态时无声退场.
//   - shrink-0 顺带断言: 防 flex 容器把 tab 条压扁, 与 sticky 配合形成完整的
//     「固定顶部 tab」语义.
//   - bg-gray-50 顺带断言: 防被改成透明背景, 否则滚动时内容会从 tab 条后面
//     透出来, sticky 视觉效果打折.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = resolve(__dirname);
const src = readFileSync(resolve(here, "./TabStrip.tsx"), "utf8");

describe("TabStrip sticky top-0 (R129 smoke)", () => {
  it("外层 wrapper 含 sticky top-0", () => {
    // 抓「外层 wrapper <div ...>」的首个 className 块 (TabStrip 根 div).
    // 该 div 紧跟 `if (tabs.length === 0) return null;` 之后.
    const wrapperMatch = src.match(
      /return \(\s*<div\s+className="([^"]+)"/,
    );
    expect(wrapperMatch, "找不到 TabStrip 外层 wrapper").toBeTruthy();
    const classes = wrapperMatch![1];
    expect(classes).toMatch(/\bsticky\b/);
    expect(classes).toMatch(/\btop-0\b/);
    expect(classes).toMatch(/\bshrink-0\b/);
    // 背景色实色: 防被改成透明导致 sticky 视觉失效.
    expect(classes).toMatch(/\bbg-gray-50\b/);
    // z-index 高于页面内容, 保证滚动时盖在内容上.
    expect(classes).toMatch(/\bz-20\b/);
  });

  it("顶部注释标 R129 + sticky 语义, 防止后人改回 plain 时无声退场", () => {
    expect(src).toMatch(/R129/);
    expect(src).toMatch(/sticky/);
  });
});