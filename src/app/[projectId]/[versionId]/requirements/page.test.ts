// R107 契约守卫 — /[projectId]/[versionId]/requirements 页面 (默认带版本过滤 + 清空/重置).
//
// 守住三条契约:
//   1. 默认 = 把 path 里的 versionId 透传给 View 的 searchParams.version_id
//   2. ?clear=1 → 不传 version_id 给 View (清空过滤, 看 project 全量)
//   3. 顶部条 = 项目面包屑 + 清空/恢复版本 切换 + 重置 + 总入口
//
// 反测 (反 R107):
//   - 不应再 redirect 到 /requirements (那是旧行为, 现在是直渲染)
//   - 不应忽略 path 里的 versionId
//
// 走 source file 读取做契约校验, 不引 better-sqlite3 (与 page.test.ts 同款).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

function readSrc(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "./page.tsx"), "utf8");
}

describe("Version requirements page (R107 契约)", () => {
  const src = readSrc();

  it("是 server component (默认导出 async function, 不带 use client)", () => {
    expect(src).not.toMatch(/^\s*"use client"/m);
    expect(src).toMatch(/export\s+default\s+async\s+function\s+VersionRequirementsPage/);
  });

  it("委托给 RequirementsListView 渲染 (不再 redirect, R107 改直渲染)", () => {
    // 反测: 必须不再 redirect 到 /requirements (那是旧行为, 现在是直渲染).
    expect(src).not.toMatch(/redirect\([^)]*\/requirements/);
    // 必须委托给 View.
    expect(src).toMatch(/from\s+["']@\/components\/RequirementsListView["']/);
    // 必须传 searchParams + extraTopBar + projectContext (R107 R 列第三轮加).
    expect(src).toMatch(/<RequirementsListView/);
    expect(src).toMatch(/searchParams=\{viewParams\}/);
    expect(src).toMatch(/extraTopBar=\{topBar\}/);
    expect(src).toMatch(/projectContext=\{\{\s*projectId\s*,\s*versionId\s*\}\}/);
  });

  it("默认透传 versionId 给 View (R107 '默认都是这个版本的需求')", () => {
    // viewParams 必须把 versionId 写进去.
    expect(src).toMatch(/version_id:\s*versionId/);
  });

  it("?clear=1 → 不传 version_id 给 View (R107 '允许清空')", () => {
    // 必须有 sp.clear 判断 + 在 clear 时省掉 version_id 字段.
    expect(src).toMatch(/sp\.clear\s*!==\s*["']1["']/);
    // 必须有 ? : {} 三元分支, clear 时落到空对象 (即不传 version_id).
    expect(src).toMatch(/\?\s*\{\s*version_id:\s*versionId\s*\}\s*:\s*\{\s*\}\)/);
  });

  it("顶部条渲染'清空/恢复版本'切换按钮 (R107 '允许清空')", () => {
    expect(src).toMatch(/isCleared\s*=\s*sp\.clear\s*===\s*["']1["']/);
    expect(src).toMatch(/清空版本/);
    expect(src).toMatch(/恢复版本/);
  });

  it("重置按钮 = 直接跳到 pathBase 无 query (R107 '重制功能默认重置到带有当前版本的状态')", () => {
    // pathBase 必须含 projectId + versionId + /requirements.
    expect(src).toMatch(/pathBase\s*=\s*`\/\$\{projectId\}\/\$\{versionId\}\/requirements`/);
    // 重置按钮 href 必须是 pathBase (无 query).
    expect(src).toMatch(/href=\{pathBase\}/);
    expect(src).toMatch(/重置/);
  });

  it("总入口链接保留 (R107 第二段 '总入口, 需求点管理. 保留.')", () => {
    expect(src).toMatch(/href=["']\/requirements["']/);
    expect(src).toMatch(/总入口/);
  });

  it("本地 buildLocalHref 必须保留 pathBase (R87 跟进: 不能丢上下文)", () => {
    // View 内的 buildFilterHref 默认写到 /requirements, 这里必须自己写一个 local 版
    // 让 chip 链回 pathBase (不丢 projectId / versionId).
    expect(src).toMatch(/function\s+buildLocalHref/);
    // greedy match 直到函数末尾的 } (内层 if-block 的 } 用 non-greedy 会卡住).
    const helperBlock = src.match(/function\s+buildLocalHref[\s\S]*\n\s*\}/);
    expect(helperBlock, "buildLocalHref 没找到").toBeTruthy();
    const block = helperBlock![0];
    // 必须保留 pathBase + version_id.
    expect(block).toMatch(/pathBase/);
    expect(block).toMatch(/version_id/);
  });

  it("buildLocalHref 必须实际被顶部条按钮使用 (避免 dead code, R107 R 列反馈)", () => {
    // 顶部条的"清空版本"按钮用 buildLocalHref({ clear: true })
    expect(src).toMatch(/href=\{buildLocalHref\(\{\s*clear:\s*true\s*\}\)\}/);
    // 顶部条的"恢复版本"按钮用 buildLocalHref({ clear: false })
    expect(src).toMatch(/href=\{buildLocalHref\(\{\s*clear:\s*false\s*\}\)\}/);
    // 反测: 不应该出现 buildLocalHref 没被任何按钮使用的 dead code 痕迹
    // (e.g. 定义了但只用一次 = 几乎肯定是冗余; 我们要求至少 2 处使用 = 清空 + 恢复).
    const usages = src.match(/buildLocalHref\(/g);
    expect(usages, "buildLocalHref 应至少 2 处使用 (清空 + 恢复)").toBeTruthy();
    expect(usages!.length).toBeGreaterThanOrEqual(3); // 1 定义 + 2 调用
  });
});

describe("Unversioned requirements page (R107 契约)", () => {
  function readUnverSrc(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, "../../unversioned/requirements/page.tsx"), "utf8");
  }
  const src = readUnverSrc();

  it("是 server component", () => {
    expect(src).not.toMatch(/^\s*"use client"/m);
    expect(src).toMatch(/export\s+default\s+async\s+function\s+UnversionedRequirementsPage/);
  });

  it("version_id 强制 = 'null' (R107 抽出版本分支, unversioned 看未挂版本的需求)", () => {
    expect(src).toMatch(/version_id:\s*["']null["']/);
  });

  it("支持 ?clear (本页强制 null 过滤, 不支持 clear)", () => {
    // 反测: unversioned 不应该支持 clear (语义本身 = 强制 null).
    expect(src).not.toMatch(/sp\.clear/);
  });

  it("顶部条 = 重置 + 总入口 (R107 '总入口, 需求点管理. 保留.')", () => {
    expect(src).toMatch(/重置/);
    expect(src).toMatch(/总入口/);
    expect(src).toMatch(/href=["']\/requirements["']/);
  });

  it("本地 buildLocalHref 必须保留 pathBase", () => {
    expect(src).toMatch(/pathBase\s*=\s*`\/\$\{projectId\}\/unversioned\/requirements`/);
    expect(src).toMatch(/function\s+buildLocalHref/);
  });

  it("委托 RequirementsListView 时传 projectContext={projectId, versionId: null} (R107 R 列第三轮)", () => {
    expect(src).toMatch(/projectContext=\{\{\s*projectId\s*,\s*versionId:\s*null\s*\}\}/);
  });
});

describe("RequirementsListView 共用契约 (R107 抽出后被三页共用)", () => {
  function readViewSrc(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(
      resolve(here, "../../../../components/RequirementsListView.tsx"),
      "utf8",
    );
  }
  const viewSrc = readViewSrc();

  it("接受 extraTopBar slot (R107 顶部条)", () => {
    expect(viewSrc).toMatch(/extraTopBar\?:\s*ReactNode/);
    expect(viewSrc).toMatch(/\{extraTopBar\}/);
  });

  it("导出 RequirementsSearchParams 类型 (R107 三页复用同一类型)", () => {
    expect(viewSrc).toMatch(/export\s+interface\s+RequirementsSearchParams/);
  });

  it("version_id 解析三态: undefined=不过滤, 'null'=IS NULL, string=等于值", () => {
    // R64 原始契约, R107 抽出后 View 必须仍保留.
    expect(viewSrc).toMatch(/version_id\s*===\s*undefined\s*\?\s*undefined/);
    expect(viewSrc).toMatch(/version_id\s*===\s*["']null["']\s*\?\s*null/);
  });
});