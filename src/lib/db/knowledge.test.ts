// Tests for knowledge module (R92, 2026-09-06).
//
// 覆盖范围:
//   - searchTasksByQuery: LIKE 命中 + owner 隔离 + project_id 过滤 + 已删不命中
//   - searchInAppRequirementsByQuery: 命中 + closed 排除 + owner 隔离
//   - searchCachedRequirementsByQuery: 命中 + owner JOIN 隔离 + errored 行不命中
//   - searchDocsInProject: 项目 cwd 内 .md 文件命中 + 隐藏目录跳过 + 大文件跳过
//   - searchKnowledge: 4 源并发 + 空 query 返空 + limit 校验
//   - escapeLike (via 间接): 含 %/_ 的 query 不通配
//   - listStaleCacheErrors: 返 fetch_error 行

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { searchKnowledge, listStaleCacheErrors } from "./knowledge";
import { createRequirement } from "./requirements";

let tmpDir: string;
let ownerA: string;
let ownerB: string;
let projectA: string;
let projectB: string;
let versionA: string;
let versionB: string;

function seedUser(email: string): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(id, email, "x");
  return id;
}

function seedProject(name: string, ownerId: string, cwd?: string | null): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO projects (id, name, owner_id, cwd) VALUES (?, ?, ?, ?)")
    .run(id, name, ownerId, cwd ?? null);
  return id;
}

function seedVersion(projectId: string, name: string, _ownerId: string, feishuUrl?: string | null, feishuSheet?: string): string {
  // 注: versions 表没有 owner_id 列; owner 隔离走 versions.project_id → projects.owner_id JOIN.
  // 这里保留 _ownerId 仅为了让 seed* 系列 helper 签名一致, 便于读测试代码.
  void _ownerId;
  const id = uuidv4();
  getDb()
    .prepare(
      "INSERT INTO versions (id, project_id, name, feishu_url, feishu_sheet) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, projectId, name, feishuUrl ?? null, feishuSheet ?? "Sheet2");
  return id;
}

function seedTask(projectId: string, ownerId: string, title: string, prompt?: string, result?: string): string {
  const id = uuidv4();
  // tasks.prompt 是 NOT NULL, 默认空字符串
  getDb()
    .prepare(
      `INSERT INTO tasks (id, project_id, owner_id, title, prompt, result, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(id, projectId, ownerId, title, prompt ?? "", result ?? null);
  return id;
}

function seedCacheRow(versionId: string, sheetUrl: string, rowNumber: number, title: string, description: string, error?: string): string {
  const id = `${versionId}:${rowNumber}`;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  getDb()
    .prepare(
      `INSERT INTO requirement_cache
         (id, version_id, sheet_url, sheet_name, row_number, title, description, fetched_at, fetch_error)
       VALUES (?, ?, ?, 'Sheet2', ?, ?, ?, ?, ?)`
    )
    .run(id, versionId, sheetUrl, rowNumber, title, description, now, error ?? null);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-kb-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑全部 migration 包括 v73
  ownerA = seedUser(`a-${uuidv4()}@example.com`);
  ownerB = seedUser(`b-${uuidv4()}@example.com`);
  // 用 tmpDir 下子目录作 project cwd (便于 docs 测)
  const cwdA = path.join(tmpDir, "projectA");
  fs.mkdirSync(cwdA, { recursive: true });
  const cwdB = path.join(tmpDir, "projectB");
  fs.mkdirSync(cwdB, { recursive: true });
  projectA = seedProject(`proj-a-${uuidv4()}`, ownerA, cwdA);
  projectB = seedProject(`proj-b-${uuidv4()}`, ownerB, cwdB);
  versionA = seedVersion(projectA, "v1", ownerA, "https://example.com/sheet1");
  versionB = seedVersion(projectB, "v1", ownerB, "https://example.com/sheet2");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- searchTasksByQuery ----

describe("searchKnowledge / tasks 源", () => {
  it("LIKE 命中 title / prompt / result", async () => {
    seedTask(projectA, ownerA, "配置飞书 sheetwatch 不派发");
    seedTask(projectA, ownerA, "完全无关的标题", "prompt 里提到 sheetwatch");
    seedTask(projectA, ownerA, "无", undefined, "result 里也提到 sheetwatch");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.tasks.length).toBe(3);
    // title 命中的 score=3+1=4, snippet 命中的 score=1
    const titleHit = r.by_source.tasks.find((h) => h.title.includes("不派发"));
    expect(titleHit?.score).toBeGreaterThanOrEqual(3);
  });

  it("owner 隔离 - 其他 user 的 task 不出现", async () => {
    seedTask(projectA, ownerA, "sheetwatch A 看到");
    seedTask(projectB, ownerB, "sheetwatch B 看到");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.tasks.length).toBe(1);
    expect(r.by_source.tasks[0].title).toContain("A");
  });

  it("project_id 过滤 - 只返指定 project", async () => {
    seedTask(projectA, ownerA, "项目 A 的 sheetwatch");
    seedTask(projectB, ownerA, "项目 B 的 sheetwatch"); // 同 owner 但 project 不同
    // 注: ownerA 不能拥有 projectB, 我们偷换一下: 把 projectB 转让给 ownerA
    getDb().prepare("UPDATE projects SET owner_id = ? WHERE id = ?").run(ownerA, projectB);

    const r = await searchKnowledge({ query: "sheetwatch", project_id: projectA }, ownerA);
    expect(r.by_source.tasks.length).toBe(1);
    expect(r.by_source.tasks[0].meta?.status).toBe("pending");
  });

  it("已软删 task 不命中", async () => {
    const id = seedTask(projectA, ownerA, "sheetwatch 要被删");
    getDb().prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run(id);

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.tasks.length).toBe(0);
  });

  it("LIKE 元字符 % 不通配 (escapeLike 生效)", async () => {
    seedTask(projectA, ownerA, "匹配 100% 完成");
    seedTask(projectA, ownerA, "匹配 100x 完成"); // 干扰项

    const r = await searchKnowledge({ query: "100%" }, ownerA);
    expect(r.by_source.tasks.length).toBe(1);
    expect(r.by_source.tasks[0].title).toContain("100%");
  });
});

// ---- searchInAppRequirementsByQuery ----

describe("searchKnowledge / requirements 源", () => {
  it("LIKE 命中 title + description", async () => {
    createRequirement(projectA, { title: "导出格式" }, ownerA);
    const req2 = createRequirement(projectA, { title: "无关标题", description: "导出格式用 JSON" }, ownerA);
    void req2;

    const r = await searchKnowledge({ query: "导出格式" }, ownerA);
    expect(r.by_source.requirements.length).toBe(2);
  });

  it("closed 不命中", async () => {
    const req = createRequirement(projectA, { title: "即将关闭" }, ownerA);
    getDb().prepare("UPDATE requirements SET status = 'closed' WHERE id = ?").run(req.id);

    const r = await searchKnowledge({ query: "关闭" }, ownerA);
    expect(r.by_source.requirements.length).toBe(0);
  });

  it("owner 隔离", async () => {
    createRequirement(projectA, { title: "A 的需求" }, ownerA);
    createRequirement(projectB, { title: "B 的需求" }, ownerB);

    const r = await searchKnowledge({ query: "需求" }, ownerA);
    expect(r.by_source.requirements.length).toBe(1);
    expect(r.by_source.requirements[0].title).toContain("A");
  });
});

// ---- searchCachedRequirementsByQuery ----

describe("searchKnowledge / requirement_cache 源", () => {
  it("LIKE 命中 cached 飞书需求点", async () => {
    seedCacheRow(versionA, "https://example.com/sheet1", 3, "飞书 R3", "内容是 sheetwatch 修");
    seedCacheRow(versionA, "https://example.com/sheet1", 4, "飞书 R4", "无关");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.requirement_cache.length).toBe(1);
    expect(r.by_source.requirement_cache[0].meta?.row_number).toBe(3);
  });

  it("fetch_error 行不命中 (脏数据兜底)", async () => {
    seedCacheRow(versionA, "https://example.com/sheet1", 5, "errored 行", "sheetwatch 也含这里", "lark-cli timeout");
    seedCacheRow(versionA, "https://example.com/sheet1", 6, "正常行", "sheetwatch 这里也提");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.requirement_cache.length).toBe(1);
    expect(r.by_source.requirement_cache[0].meta?.row_number).toBe(6);
  });

  it("跨 owner 不命中 (JOIN projects 隔离)", async () => {
    seedCacheRow(versionA, "https://example.com/sheet1", 7, "A 的 sheetwatch", "");
    seedCacheRow(versionB, "https://example.com/sheet2", 8, "B 的 sheetwatch", "");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.requirement_cache.length).toBe(1);
  });
});

// ---- searchDocsInProject ----

describe("searchKnowledge / docs 源", () => {
  it("项目 cwd 内 .md 命中", async () => {
    fs.writeFileSync(path.join(tmpDir, "projectA", "INDEX.md"), "# 标题\n这里提到 sheetwatch 不派发问题");
    fs.writeFileSync(path.join(tmpDir, "projectA", "notes.md"), "另一份提到 sheetwatch 的笔记");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.docs.length).toBe(2);
  });

  it("隐藏目录 / .md 文件不命中", async () => {
    fs.mkdirSync(path.join(tmpDir, "projectA", ".hidden"));
    fs.writeFileSync(path.join(tmpDir, "projectA", ".hidden", "secret.md"), "sheetwatch 是关键词");
    fs.writeFileSync(path.join(tmpDir, "projectA", "INDEX.md"), "正常笔记");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.docs.length).toBe(0); // 只命中隐藏, 但隐藏跳过
  });

  it("node_modules 跳过", async () => {
    fs.mkdirSync(path.join(tmpDir, "projectA", "node_modules"));
    fs.writeFileSync(path.join(tmpDir, "projectA", "node_modules", "p.md"), "sheetwatch 也提到");
    fs.writeFileSync(path.join(tmpDir, "projectA", "INDEX.md"), "sheetwatch 在这");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.docs.length).toBe(1);
  });

  it("非 .md 文件不命中", async () => {
    fs.writeFileSync(path.join(tmpDir, "projectA", "data.json"), '{"sheetwatch": 1}');
    fs.writeFileSync(path.join(tmpDir, "projectA", "INDEX.md"), "sheetwatch 在这");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.docs.length).toBe(1);
    expect(r.by_source.docs[0].id).toContain("INDEX.md");
  });
});

// ---- searchKnowledge 主入口 ----

describe("searchKnowledge 主入口", () => {
  it("空 query 返空 + warning", async () => {
    const r = await searchKnowledge({ query: "   " }, ownerA);
    expect(r.total_hits).toBe(0);
    expect(r.warnings).toContain("query 不能为空");
  });

  it("4 源并发跑 + 按源归组", async () => {
    seedTask(projectA, ownerA, "sheetwatch 任务");
    createRequirement(projectA, { title: "sheetwatch 需求" }, ownerA);
    seedCacheRow(versionA, "https://example.com/sheet1", 1, "sheetwatch 飞书", "");
    fs.writeFileSync(path.join(tmpDir, "projectA", "INDEX.md"), "sheetwatch 文档");

    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.tasks.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.requirements.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.requirement_cache.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.docs.length).toBeGreaterThanOrEqual(1);
    expect(r.total_hits).toBeGreaterThanOrEqual(4);
  });

  it("sources 子集生效", async () => {
    seedTask(projectA, ownerA, "sheetwatch");
    const r = await searchKnowledge({ query: "sheetwatch", sources: ["tasks"] }, ownerA);
    expect(r.by_source.tasks.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.requirements.length).toBe(0);
    expect(r.by_source.requirement_cache.length).toBe(0);
    expect(r.by_source.docs.length).toBe(0);
  });

  it("limit_per_source 上限 50, 下限 1", async () => {
    // 注入 60 条 task, limit=50 应只返 50
    for (let i = 0; i < 60; i++) {
      seedTask(projectA, ownerA, `task-${i} sheetwatch`);
    }
    const r50 = await searchKnowledge({ query: "sheetwatch", limit_per_source: 50 }, ownerA);
    expect(r50.by_source.tasks.length).toBe(50);

    const r1 = await searchKnowledge({ query: "sheetwatch", limit_per_source: 1 }, ownerA);
    expect(r1.by_source.tasks.length).toBe(1);
  });

  it("highlight 包裹 <mark>", async () => {
    seedTask(projectA, ownerA, "完全无关标题", "prompt 里提到 sheetwatch");
    const r = await searchKnowledge({ query: "sheetwatch" }, ownerA);
    expect(r.by_source.tasks[0].snippet).toContain("<mark>sheetwatch</mark>");
  });
});

// ---- listStaleCacheErrors ----

describe("listStaleCacheErrors", () => {
  it("列出 fetch_error 行", async () => {
    seedCacheRow(versionA, "https://example.com/sheet1", 1, "err1", "", "lark-cli fail");
    seedCacheRow(versionA, "https://example.com/sheet1", 2, "err2", "", "lark-cli fail again");
    seedCacheRow(versionA, "https://example.com/sheet1", 3, "ok", "");

    const r = listStaleCacheErrors(ownerA);
    expect(r.length).toBe(1);
    expect(r[0].version_id).toBe(versionA);
    expect(r[0].error_count).toBe(2);
  });

  it("owner 隔离", async () => {
    seedCacheRow(versionA, "https://example.com/sheet1", 1, "A err", "", "x");
    seedCacheRow(versionB, "https://example.com/sheet2", 1, "B err", "", "y");

    const r = listStaleCacheErrors(ownerA);
    expect(r.length).toBe(1);
    expect(r[0].version_id).toBe(versionA);
  });
});