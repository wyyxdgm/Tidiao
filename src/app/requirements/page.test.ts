// R77 回归测试 — 需求点列表页契约 (R107 抽出 View 后, 契约守卫同时覆盖 page.tsx + RequirementsListView).
//
// 背景: damo R77 报"列表上 R74 只有待审核标签, 没有等回复". 排查后根因 = damo 看的是
//   task 列表 (task `e9799ec0-...` 状态 reviewing → 待审核), R74 没有 in_app
//   对应 (v63 砍了飞书 → in_app 同步链路), 但 in-app 列表页本身的状态徽章渲染
//   逻辑没毛病. 此测试守住契约: 后续若有人改 STATUS_LABEL/STATUS_COLOR/REQUIREMENT_STATUSES
//   把"等回复"等中间态漏掉, 单测挂, 防 UI 退化.
//
// R107 抽出后契约守卫同时校验 page.tsx (薄壳) + RequirementsListView (渲染体).
// 走 source file 读取做契约校验, 不引 better-sqlite3.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

function readSrc(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, rel), "utf8");
}

function readPageSrc(): string {
  return readSrc("./page.tsx");
}

function readViewSrc(): string {
  return readSrc("../../components/RequirementsListView.tsx");
}

function readDbSrc(): string {
  // 校验 page.tsx 与 db/requirements.ts REQUIREMENT_STATUSES 同源 (避免 client 复刻漂移)
  // 这是 R64 立规的硬约束 (status-flow.tsx 同款).
  return readSrc("../../lib/db/requirements.ts");
}

// R60 §4.1 + R64 6 态. 中间态 (awaiting_reply/has_suggestion/blocked) 对齐飞书 O 列.
const EXPECTED_STATUSES = [
  "pending",
  "done",
  "awaiting_reply",
  "has_suggestion",
  "blocked",
  "closed",
] as const;

const EXPECTED_LABEL_CN: Record<string, string> = {
  pending: "未开始",
  done: "已完成",
  awaiting_reply: "等回复",   // ← R77 damo 报缺失的标签
  has_suggestion: "有建议",
  blocked: "需拍板",
  closed: "已关闭",
};

describe("Requirements list page (R77 契约)", () => {
  const pageSrc = readPageSrc();
  const viewSrc = readViewSrc();

  it("/requirements page.tsx 是 server component 薄壳 (R107 抽出后)", () => {
    // 防止有人改成 "use client" 或往薄壳里塞大段渲染逻辑.
    expect(pageSrc).not.toMatch(/^\s*"use client"/m);
    expect(pageSrc).toMatch(/export\s+default\s+async\s+function\s+RequirementsListPage/);
    // 薄壳应该委托给 RequirementsListView, 而不是直接写 listRequirements.
    expect(pageSrc).toMatch(/from\s+["']@\/components\/RequirementsListView["']/);
    expect(pageSrc).toMatch(/<RequirementsListView\s+searchParams=\{params\}\s*\/>/);
    // 薄壳不应再 import listRequirements (那是 View 的事).
    expect(pageSrc).not.toMatch(/from\s+["']@\/lib\/db\/requirements["']/);
  });

  it("RequirementsListView 是 server component, 包含 6 态渲染 + buildFilterHref", () => {
    expect(viewSrc).not.toMatch(/^\s*"use client"/m);
    expect(viewSrc).toMatch(/export\s+default\s+async\s+function\s+RequirementsListView/);
    expect(viewSrc).toMatch(/import\s*\{[^}]*REQUIREMENT_STATUSES[^}]*\}\s*from\s*["']@\/lib\/db\/requirements["']/);
  });

  it("STATUS_LABEL 含 6 个中文标签 (含 R77 关键'等回复')", () => {
    // R107 抽出: STATUS_LABEL 在 View 里, 不在 page.tsx 里. 校验源改为 view.
    for (const [key, cn] of Object.entries(EXPECTED_LABEL_CN)) {
      const re = new RegExp(`${key}\\s*:\\s*["']${cn}["']`);
      expect(viewSrc, `STATUS_LABEL 缺 ${key} → ${cn}`).toMatch(re);
    }
  });

  it("STATUS_LABEL 6 个状态全覆盖, 漏一个挂掉", () => {
    const labels = viewSrc.match(/STATUS_LABEL\s*:\s*Record<[^>]*>\s*=\s*\{([\s\S]*?)\}/);
    expect(labels).toBeTruthy();
    const block = labels![1];
    for (const key of EXPECTED_STATUSES) {
      expect(block, `STATUS_LABEL 缺 ${key}`).toMatch(new RegExp(`\\b${key}\\s*:`));
    }
  });

  it("STATUS_COLOR 与 STATUS_LABEL 同步 (6 色 6 标签, 防某个状态漏色导致徽章空白)", () => {
    const colorBlock = viewSrc.match(/STATUS_COLOR\s*:\s*Record<[^>]*>\s*=\s*\{([\s\S]*?)\}/);
    expect(colorBlock).toBeTruthy();
    for (const key of EXPECTED_STATUSES) {
      expect(colorBlock![1], `STATUS_COLOR 缺 ${key}`).toMatch(new RegExp(`\\b${key}\\s*:`));
    }
  });

  it("徽章渲染走 STATUS_LABEL[r.status] (不是写死字符串或 task.status)", () => {
    // 防有人误把徽章渲染接到 task.status 上 (那就是 R77 报的'待审核' bug 模式).
    expect(viewSrc).toMatch(/STATUS_LABEL\[r\.status\]/);
    // 反向断言: 不应直接渲染 task.status (那是 task 列表页的事).
    expect(viewSrc).not.toMatch(/task\.status/);
  });

  it("filter 按钮遍历 REQUIREMENT_STATUSES 渲 6 个状态 (含等回复)", () => {
    expect(viewSrc).toMatch(/REQUIREMENT_STATUSES\.map\(\(s\)\s*=>\s*\(/);
    expect(viewSrc).toMatch(/\{STATUS_LABEL\[s\]\}/);
  });

  it("db/requirements.ts REQUIREMENT_STATUSES 顺序/键 与列表页 6 态一致", () => {
    const dbSrc = readDbSrc();
    const exportBlock = dbSrc.match(/export\s+const\s+REQUIREMENT_STATUSES[^=]*=\s*\[([\s\S]*?)\]/);
    expect(exportBlock).toBeTruthy();
    for (const key of EXPECTED_STATUSES) {
      expect(exportBlock![1], `db REQUIREMENT_STATUSES 缺 ${key}`).toContain(`"${key}"`);
    }
  });

  // R87 跟进: status 过滤 chip 必须保留 project_id / version_id.
  it("buildFilterHref 保留 project_id / version_id, 清 status 单独可控 (R87 跟进)", () => {
    const helperBlock = viewSrc.match(/function\s+buildFilterHref[\s\S]*?\n\s*\}/);
    expect(helperBlock, "buildFilterHref 没找到").toBeTruthy();
    const block = helperBlock![0];
    expect(block).toMatch(/project_id/);
    expect(block).toMatch(/version_id/);
    expect(block).toMatch(/status/);
    // page 参数不应被 preserve.
    expect(block).not.toMatch(/searchParams\.page/);
  });

  // R107 R 列 (damo 反馈): 项目里的需求页点 chip 会跳全局入口 (/requirements),
  // 期望 URL = /requirements?project_id=X&version_id=Y&status=Z (保留完整过滤).
  // View 内部 buildFilterHref 默认写到 /requirements, chip 走它 → 行为匹配。
  it("chip 跳全局入口 /requirements + 保留 project_id / version_id / status (R107 R 列反馈)", () => {
    // buildFilterHref 必须写到 /requirements (全局入口 path).
    expect(viewSrc).toMatch(/return\s+qs\s*\?\s*`\/requirements\?\$\{qs\}`\s*:\s*["']\/requirements["']/);
    // 7 个 chip (1 全部 + 6 状态) 都走 buildFilterHref.
    expect(viewSrc).toMatch(/href=\{buildFilterHref\(\{\s*\}\)\}/);  // 全部 chip
    expect(viewSrc).toMatch(/href=\{buildFilterHref\(\{\s*status:\s*s\s*\}\)\}/);  // 状态 chip
    // 必须保留 project_id + version_id (没这俩 = 反 R107 R 列期望).
    const helperBlock = viewSrc.match(/function\s+buildFilterHref[\s\S]*\n\s*\}/);
    expect(helperBlock).toBeTruthy();
    const block = helperBlock![0];
    expect(block).toMatch(/searchParams\.project_id/);
    expect(block).toMatch(/searchParams\.version_id/);
  });

  // R107 R 列第三轮 (damo 追加): 项目里点 chip/新建/空态/详情返回 都要带 project 上下文,
  // 否则回到无项目状态. View 内 buildNewRequirementHref 必须:
  //   - 有 context → /requirements/new?project_id=X&version_id=Y (携带)
  //   - 无 context → /requirements/new (全局兜底)
  // "+ 新建需求" 顶部按钮必须走它 (顶部按钮是空态以外的唯一入口, R107 R 列第五轮跟进).
  it("View 接受 projectContext prop, buildNewRequirementHref 携带 project_id+version_id (R107 R 列第三轮)", () => {
    // prop 必须存在.
    expect(viewSrc).toMatch(/projectContext\?:\s*\{[\s\S]*projectId:\s*string/);
    expect(viewSrc).toMatch(/versionId:\s*string\s*\|\s*null/);
    // buildNewRequirementHref 函数存在.
    expect(viewSrc).toMatch(/function\s+buildNewRequirementHref/);
    const helperBlock = viewSrc.match(/function\s+buildNewRequirementHref[\s\S]*\n\s*\}/);
    expect(helperBlock, "buildNewRequirementHref 没找到").toBeTruthy();
    const block = helperBlock![0];
    // 必须用 ctx.projectId + ctx.versionId 构造 URL.
    expect(block).toMatch(/ctx\.projectId/);
    expect(block).toMatch(/ctx\.versionId/);
    // 无 ctx 兜底到 /requirements/new (全局).
    expect(block).toMatch(/return\s+["']\/requirements\/new["']/);
    // "+ 新建需求" 顶部按钮必须走 buildNewRequirementHref.
    expect(viewSrc).toMatch(/href=\{buildNewRequirementHref\(projectContext\)\}/);
  });

  // R107 R 列第五轮: damo 反馈"暂无需求点. 新建一个 这个入口还不对" — 空态的 inline
  // "新建一个" 链接冗余 (顶部"+ 新建需求"按钮已覆盖). 改为纯文本 + 提示用户用顶部按钮.
  it("空态不再有 inline'新建一个'链接 (R107 R 列第五轮, 顶部按钮是唯一入口)", () => {
    // 反测: 空态块不应再出现 hard-coded "新建一个" inline link.
    // 旧的写法是: <Link href={buildNewRequirementHref(...)}>新建一个</Link>
    // 新写法是: 纯文本 + 提示.
    expect(viewSrc).not.toMatch(/>\s*新建一个\s*<\/Link>/);
    // 必须保留"暂无需求点" 文案 (空态状态描述).
    expect(viewSrc).toMatch(/暂无需求点/);
    // 必须有"点击右上角"+ 新建需求"添加"提示文字, 指引用户用顶部按钮.
    expect(viewSrc).toMatch(/点击右上角.*新建需求.*添加/);
  });
});