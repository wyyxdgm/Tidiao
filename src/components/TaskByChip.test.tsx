// TaskByChip 烟雾测试 — R108 T3 [by] chip 4 视图统一.
//
// 功能: 验证组件契约 (渲染短 id + 跳父 task + 阻止冒泡 + a11y 兜底).
//   因为组件是 "use client" + 调 useRouter().push(), 在裸 react-dom/server 的
//   renderToStaticMarkup 跑会抛 "expected app router to be mounted". 所以本测试
//   走 source-level 契约校验 (同仓 AwaitingReasonChip 的部分测试风格 —
//   不挂 href/onClick 这类).
//
// 关注点:
//   - stopPropagation 是关键契约 — 这是父级 Link 嵌套场景的核心需求,
//     漏写 = 点 chip 跳子 task 自身. 必须 source 校验, SSR 序列化掉 prop.
//   - 不用 <Link> 改用 <span>+useRouter().push() 是因为 board-client /
//     kanban-view 的 task card 外层已经是 <Link href=/tasks/{self.id}>,
//     套 <a> 会触发 hydration error "In HTML, <a> cannot be a descendant of <a>".
//   - 真要端到端验证 hydration 不再报错, 跑 next build + dev server, 看 console.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import TaskByChip from "./TaskByChip";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./TaskByChip.tsx"), "utf8");
}

describe("TaskByChip", () => {
  it("默认导出 = 函数组件", () => {
    expect(typeof TaskByChip).toBe("function");
  });

  it("不用 <Link>, 不引入 next/link (防 a 套 a hydration error)", () => {
    const src = readSrc();
    // 不允许再 import next/link — 加回会重新触发 hydration error. 这是硬约束:
    // 一旦 import Link 就一定渲染 <a>, 在外层 Link 里必然 hydration error.
    expect(src).not.toMatch(/from\s+["']next\/link["']/);
  });

  it("用 useRouter().push() 触发跳转, 目标 = /tasks/{dispatchedByTaskId}", () => {
    const src = readSrc();
    // 必须走 next/navigation 的 useRouter (App Router).
    expect(src).toMatch(/import\s*\{\s*useRouter\s*\}\s*from\s*["']next\/navigation["']/);
    // 跳转目标字符串必须是 /tasks/{dispatchedByTaskId} — 不允许写成别处
    // (例如 /[projectId]/tasks) 或硬编码 id.
    expect(src).toMatch(/target\s*=\s*`\/tasks\/\$\{dispatchedByTaskId\}`/);
    // 触发调用: router.push(target). 不允许 inline 字符串 (防止漂移).
    expect(src).toMatch(/router\.push\(target\)/);
  });

  it("onClick = stopPropagation + preventDefault (源文件契约)", () => {
    const src = readSrc();
    // 必须有 stopPropagation: 否则点 chip 冒泡到外层 Link → 跳子 task 自身.
    expect(src).toContain("e.stopPropagation()");
    // preventDefault 同步防御 (虽然外层是 <a> 我们阻止冒泡够, 但保险).
    expect(src).toContain("e.preventDefault()");
    // onClick 必须绑定到 chip 元素本身.
    expect(src).toMatch(/onClick\s*=/);
  });

  it("渲染元素 = <span> (避免 a 套 a) + data-href 携带跳转目标", () => {
    const src = readSrc();
    expect(src).toMatch(/<span/);
    expect(src).toMatch(/data-href=\{target\}/);
  });

  it("视觉样式与原 board-client.tsx 834 行内联 Link 一致", () => {
    const src = readSrc();
    // 原: bg-slate-100 text-slate-600 border border-slate-200 text-xs rounded-full
    expect(src).toContain("bg-slate-100");
    expect(src).toContain("text-slate-600");
    expect(src).toContain("border-slate-200");
    expect(src).toContain("text-xs");
    expect(src).toContain("rounded-full");
    // 悬停态保留原 hover 颜色
    expect(src).toContain("hover:bg-slate-200");
  });

  it("title 属性挂完整 dispatchedByTaskId (用户可复制搜)", () => {
    const src = readSrc();
    expect(src).toContain("title={`派发自 ${dispatchedByTaskId}");
    expect(src).toContain("短id 复制可搜");
  });

  it("a11y 兜底: role=link + tabIndex + Enter/Space keydown", () => {
    const src = readSrc();
    // span 不是原生 link, 屏幕阅读器靠 role=link, 键盘靠 tabIndex + keydown.
    expect(src).toMatch(/role=["']link["']/);
    expect(src).toMatch(/tabIndex=\{0\}/);
    // Enter / 空格 都触发跳父 task.
    expect(src).toMatch(/["']Enter["']/);
    expect(src).toMatch(/e\.key\s*===\s*["']\s*["']/);
  });
});