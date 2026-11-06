// TaskStatusChip 烟雾测试 — R109 sub-status chip 4 视图统一.
//
// 功能: 验证组件契约 (4 色映射 + null 短路 + 视觉 class + 不做 link).
//   走 react-dom/server renderToStaticMarkup 渲染纯组件. status-display 映射
//   已在 status-display.test.ts 单测覆盖, 本文件只测组件层包装.
//
// 关注点:
//   - vitest 不引 @testing-library, 用 SSR 拿 HTML 最稳 (与 TaskByChip.test.tsx 同款).
//   - null/空/未知 三种 fallback 都得验证: 不渲染 / 不渲染 / 灰色 chip + "unknown".
//   - 父组件传 status 时不挂 onClick (chip 不是 link) — 防回归写成 link.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import TaskStatusChip from "./TaskStatusChip";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./TaskStatusChip.tsx"), "utf8");
}

describe("TaskStatusChip", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof TaskStatusChip).toBe("function");
  });

  it("status=null → 返回 null, 渲染出空字符串", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: null }));
    expect(html).toBe("");
  });

  it("status=undefined → 返回 null, 渲染出空字符串", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: undefined }));
    expect(html).toBe("");
  });

  it("status=空字符串 → 返回 null, 渲染出空字符串", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: "" }));
    expect(html).toBe("");
  });

  it("中文 alias 映射正确 (4 中文 状态)", () => {
    const cases: Array<[string, string, string]> = [
      ["等回复", "等回复", "bg-blue-100"],
      ["有建议", "有建议", "bg-purple-100"],
      ["需拍板", "需拍板", "bg-orange-100"],
      ["卡住", "卡住", "bg-red-100"],
    ];
    for (const [status, label, bg] of cases) {
      const html = renderToStaticMarkup(createElement(TaskStatusChip, { status }));
      expect(html).toContain(label);
      expect(html).toContain(bg);
    }
  });

  it("英文 alias 也展示中文 label (共享 tone 常量, 跨语言同色)", () => {
    // R108 T2 设计: 英文 alias 走相同 tone, label 固定中文 ("等回复"/"有建议"/...). 这样
    // 中文用户看英文 status 也认得, 不混.
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: "waiting" }));
    expect(html).toContain("等回复");
    expect(html).toContain("bg-blue-100");
  });

  it("未知 status → 渲染灰色 chip + label='unknown'", () => {
    const html = renderToStaticMarkup(
      createElement(TaskStatusChip, { status: "waiting_reply" }),
    );
    // waiting_reply 不在 8 个 alias 内 (设计取舍 — 见 status-display.ts:10-13 注释)
    expect(html).toContain("unknown");
    expect(html).toContain("bg-gray-100");
    expect(html).toContain("text-gray-600");
  });

  it("大小写不敏感 (trim+lowercase)", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: "  WAITING  " }));
    expect(html).toContain("等回复");
    expect(html).toContain("bg-blue-100");
  });

  it("视觉与 right-dock CheckpointNode 一致 (text-xs + rounded-full)", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: "等回复" }));
    expect(html).toContain("text-xs");
    expect(html).toContain("rounded-full");
  });

  it("data-status-tone 属性挂 tone 值 (便于测试 / e2e 选择器)", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: "卡住" }));
    expect(html).toContain('data-status-tone="blocked"');
  });

  it("title 属性挂原始 status 字符串 (便于悬停查看)", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusChip, { status: "需拍板" }));
    expect(html).toContain('title="sub-status: 需拍板"');
  });

  it("组件源码不挂 href / onClick (chip 不是 link, 防回归)", () => {
    // 读源文件确认 — SSR 不挂 link prop, 但写错时 src 会有 <a 或 <Link, 这里用 src 校验
    const src = readSrc();
    expect(src).not.toMatch(/<a\s|<Link\s|import\s+Link/);
    expect(src).not.toMatch(/onClick\s*=/);
  });
});