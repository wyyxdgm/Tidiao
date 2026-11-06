// R107 R 列第三轮契约守卫 — 需求详情页 /requirements/[id] 的"← 需求点列表"回链.
//
// damo 反馈: 详情页返回按钮也要带 project_id + version_id, 否则丢上下文回全局.
// 当前实现: page.tsx 接受 ?project_id= + ?version_id= → 构造 backHref
//   有 context → /requirements?project_id=X&version_id=Y
//   无 → /requirements (全局兜底)
//
// 走 source file 读，不引 better-sqlite3.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./page.tsx"), "utf8");
}

describe("Requirement detail page (R107 R 列第三轮 契约)", () => {
  const src = readSrc();

  it("page.tsx 是 server component (默认导出 async function, 不带 use client)", () => {
    expect(src).not.toMatch(/^\s*"use client"/m);
    expect(src).toMatch(/export\s+default\s+async\s+function\s+RequirementDetailPage/);
  });

  it("接受 searchParams: { project_id?, version_id? } (R107 R 列第三轮)", () => {
    // 详情页要从 URL 读 project_id + version_id 构造回链.
    // PageProps interface 必须包含 searchParams + project_id + version_id 三个键.
    const propsBlock = src.match(/interface\s+PageProps\s*\{([\s\S]*?)\n\}/);
    expect(propsBlock, "PageProps interface 没找到").toBeTruthy();
    const block = propsBlock![1];
    expect(block).toMatch(/searchParams\?:\s*Promise<\{/);
    expect(block).toMatch(/project_id\?:\s*string/);
    expect(block).toMatch(/version_id\?:\s*string/);
  });

  it("buildBackToListHref 必须携带 project_id+version_id", () => {
    expect(src).toMatch(/function\s+buildBackToListHref/);
    const helperBlock = src.match(/function\s+buildBackToListHref[\s\S]*\n\s*\}/);
    expect(helperBlock, "buildBackToListHref 没找到").toBeTruthy();
    const block = helperBlock![0];
    expect(block).toMatch(/project_id/);
    expect(block).toMatch(/version_id/);
    // 无 project_id 兜底到 /requirements 全局.
    expect(block).toMatch(/return\s+["']\/requirements["']/);
  });

  it("'← 需求点列表' 必须走 backHref (而不是硬编码 /requirements)", () => {
    // 反测: 不应硬编码 /requirements (R107 R 列第三轮 = 丢 project 上下文).
    expect(src).toMatch(/href=\{backHref\}/);
    expect(src).toMatch(/← 需求点列表/);
    // 反测: 不应在 ← 需求点列表 这块用硬编码 /requirements.
    expect(src).not.toMatch(/← 需求点列表[\s\S]{0,200}href=["']\/requirements["']/);
  });

  it("回链参数优先用 searchParams, 兜底用 req 自带 (兼容老直链)", () => {
    // sp.project_id ?? req.project_id — 优先用 query 里的 (新流程).
    expect(src).toMatch(/sp\.project_id\s*\?\?\s*req\.project_id/);
    expect(src).toMatch(/sp\.version_id\s*\?\?\s*req\.version_id/);
  });
});

describe("New requirement page (R107 R 列第三轮 契约)", () => {
  function readNewSrc(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, "../new/page.tsx"), "utf8");
  }
  function readFormSrc(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, "../new/new-requirement-form.tsx"), "utf8");
  }
  const src = readNewSrc();
  const formSrc = readFormSrc();

  it("接受 searchParams: { project_id?, version_id? }", () => {
    expect(src).toMatch(/searchParams\?:\s*Promise<\{[^}]*project_id\?/);
    expect(src).toMatch(/version_id\?:\s*string/);
  });

  it("'← 需求点列表' 必须走 backHref (带 context)", () => {
    expect(src).toMatch(/buildBackToListHref/);
    expect(src).toMatch(/href=\{backHref\}/);
    expect(src).toMatch(/← 需求点列表/);
  });

  it("NewRequirementForm 必须接受 presetProjectId + presetVersionId + backHref", () => {
    expect(formSrc).toMatch(/presetVersionId\?:\s*string/);
    expect(formSrc).toMatch(/backHref\?:\s*string/);
  });

  it("提交后 router.push 必须带 project_id + version_id 给详情页", () => {
    expect(formSrc).toMatch(/router\.push\(`\/requirements\/\$\{data\.id\}\?/);
    // 必须包含 project_id 和 version_id 的 query 构造.
    expect(formSrc).toMatch(/detailQs\.set\(["']project_id["']/);
    expect(formSrc).toMatch(/detailQs\.set\(["']version_id["']/);
  });

  it("'取消' 按钮必须走 backHref (带回 project 上下文)", () => {
    expect(formSrc).toMatch(/href=\{backHref\s*\?\?\s*["']\/requirements["']\}/);
  });
});