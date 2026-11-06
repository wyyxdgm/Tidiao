// TabStrip Cmd+W 拦截顺序 smoke 测 (飞书 AO-DEV R152 第二轮).
//
// 功能: 验证 Cmd+W 处理函数里 e.preventDefault() 的位置在 isEditableTarget
//   检查之前 — 这是 damo 第二轮要求的不变量: 即便用户在输入框, 或没有激活 tab,
//   浏览器原生 Cmd+W 关 window/tab 的默认行为也必须被拦截. 后人改回 "输入框里
//   提前 return, 不拦截" = 静默退化, 浏览器会关掉整个页面.
//
// 关注点:
//   - 沿用 R129 smoke 风格: 读源文件 + 正则, 不依赖 DOM 渲染 (仓内未装
//     @testing-library/react).
//   - 关键不变量: preventDefault 在 isEditableTarget 之前. 用正则的绝对位置
//     (str.indexOf) 比对, 任何位置错位即 fail.
//   - 也验证 stopPropagation 同样在 isEditableTarget 之前 (防分叉).
//   - 注释必须含 R152 字样 (防后人删关键决策来源).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = resolve(__dirname);
const src = readFileSync(resolve(here, "./TabStrip.tsx"), "utf8");

describe("TabStrip Cmd+W 拦截顺序 (R152 第二轮 smoke)", () => {
  it("preventDefault 在 isEditableTarget 检查之前调用", () => {
    // 抓 onKeyDown 函数体.
    const fnMatch = src.match(/function onKeyDown\(e: KeyboardEvent\)[\s\S]*?\n    \}/);
    expect(fnMatch, "找不到 onKeyDown 函数").toBeTruthy();
    const body = fnMatch![0];
    const preventDefaultIdx = body.indexOf("e.preventDefault()");
    const editableCheckIdx = body.indexOf("isEditableTarget(e.target)");
    expect(preventDefaultIdx, "onKeyDown 内找不到 preventDefault 调用").toBeGreaterThan(-1);
    expect(editableCheckIdx, "onKeyDown 内找不到 isEditableTarget 检查").toBeGreaterThan(-1);
    expect(
      preventDefaultIdx,
      `preventDefault (${preventDefaultIdx}) 必须在 isEditableTarget (${editableCheckIdx}) 之前 — 否则输入框/无 tab 时浏览器会关掉整个 window`,
    ).toBeLessThan(editableCheckIdx);
  });

  it("stopPropagation 同样在 isEditableTarget 检查之前", () => {
    const fnMatch = src.match(/function onKeyDown\(e: KeyboardEvent\)[\s\S]*?\n    \}/);
    expect(fnMatch).toBeTruthy();
    const body = fnMatch![0];
    const stopPropIdx = body.indexOf("e.stopPropagation()");
    const editableCheckIdx = body.indexOf("isEditableTarget(e.target)");
    expect(stopPropIdx).toBeGreaterThan(-1);
    expect(editableCheckIdx).toBeGreaterThan(-1);
    expect(stopPropIdx).toBeLessThan(editableCheckIdx);
  });

  it("关键决策来源注释含 R152 字样", () => {
    // 防后人删掉 R152 第二轮需求注释, 不知道为啥 preventDefault 要前置.
    expect(src).toMatch(/R152/);
  });
});
