// AwaitingReasonChip 烟雾测试 — R112 续 (v129) reviewing 子终态 chip.
//
// 关注点:
//   - 2 个常用 alias (design_pending / deploy_pending) 各自色 + label 验证.
//   - 自由字符串走兜底「待<原值>」+ 灰 — damo 第 3 tag 允许 AI 自主定义的核心契约.
//   - null/undefined/空串 → 组件自身不渲染 (双保险: 父组件不挂 + 组件内兜底).
//   - 组件源码不挂 <a>/<Link>/onClick (chip 不是 link, 与 TaskStatusChip 同款).
//   - vitest 不引 @testing-library, 用 SSR 拿 HTML 最稳 (与 TaskByChip/TaskStatusChip 同款).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import AwaitingReasonChip from "./AwaitingReasonChip";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./AwaitingReasonChip.tsx"), "utf8");
}

describe("AwaitingReasonChip", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof AwaitingReasonChip).toBe("function");
  });

  it("reason=null → 渲染出空字符串", () => {
    const html = renderToStaticMarkup(createElement(AwaitingReasonChip, { reason: null }));
    expect(html).toBe("");
  });

  it("reason=undefined → 渲染出空字符串", () => {
    const html = renderToStaticMarkup(createElement(AwaitingReasonChip, { reason: undefined }));
    expect(html).toBe("");
  });

  it("reason=空字符串 → 渲染出空字符串", () => {
    const html = renderToStaticMarkup(createElement(AwaitingReasonChip, { reason: "" }));
    expect(html).toBe("");
  });

  it("reason=全空白字符串 → 渲染出空字符串 (trim 后空)", () => {
    const html = renderToStaticMarkup(createElement(AwaitingReasonChip, { reason: "   " }));
    expect(html).toBe("");
  });

  it("design_pending → 「待实施」+ 蓝", () => {
    const html = renderToStaticMarkup(
      createElement(AwaitingReasonChip, { reason: "design_pending" }),
    );
    expect(html).toContain("待实施");
    expect(html).toContain("bg-blue-100");
    expect(html).toContain("text-blue-700");
  });

  it("deploy_pending → 「待部署」+ 紫", () => {
    const html = renderToStaticMarkup(
      createElement(AwaitingReasonChip, { reason: "deploy_pending" }),
    );
    expect(html).toContain("待部署");
    expect(html).toContain("bg-purple-100");
    expect(html).toContain("text-purple-700");
  });

  it("自由字符串 (damo 第 3 tag) → 兜底「待<原值>」+ 灰", () => {
    // damo R112 E/R: 第 3 个 tag 允许 AI 自主定义. 这里测一个常见 case (待测试) +
    // 一个无意义字符串 (自定义 hash), 都该走兜底而非崩溃.
    const cases = ["待测试", "test_docs_pending", "review_123", "user_abc_def"];
    for (const r of cases) {
      const html = renderToStaticMarkup(createElement(AwaitingReasonChip, { reason: r }));
      expect(html).toContain(`待${r}`);
      expect(html).toContain("bg-gray-100");
      expect(html).toContain("text-gray-600");
    }
  });

  it("trim 边界 (前后空格)", () => {
    const html = renderToStaticMarkup(
      createElement(AwaitingReasonChip, { reason: "  design_pending  " }),
    );
    expect(html).toContain("待实施");
    expect(html).toContain("bg-blue-100");
  });

  it("视觉与 right-dock / TaskStatusChip 一致 (text-xs + rounded-full)", () => {
    const html = renderToStaticMarkup(
      createElement(AwaitingReasonChip, { reason: "design_pending" }),
    );
    expect(html).toContain("text-xs");
    expect(html).toContain("rounded-full");
  });

  it("data-awaiting-reason 属性挂 reason 原值 (便于 e2e 选择器)", () => {
    const html = renderToStaticMarkup(
      createElement(AwaitingReasonChip, { reason: "deploy_pending" }),
    );
    expect(html).toContain('data-awaiting-reason="deploy_pending"');
  });

  it("title 属性挂 reason 原值 (悬停查看)", () => {
    const html = renderToStaticMarkup(
      createElement(AwaitingReasonChip, { reason: "design_pending" }),
    );
    expect(html).toContain('title="awaiting_reason: design_pending"');
  });

  it("组件源码不挂 href / onClick (chip 不是 link, 防回归)", () => {
    const src = readSrc();
    expect(src).not.toMatch(/<a\s|<Link\s|import\s+Link/);
    expect(src).not.toMatch(/onClick\s*=/);
  });
});