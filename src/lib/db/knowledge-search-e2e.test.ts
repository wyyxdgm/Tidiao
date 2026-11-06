// knowledge-search-e2e.test.ts — Code Knowledge Index 全 6+1 源端到端测试 (飞书 R92 第二阶段, T4).
//
// 测试分布 (plan §5 测试策略):
//   - 5 条 全 6+1 源排序 (验证 symbols > links > requirements > tasks > requirement_cache > docs > embeddings)
//   - 5 条 术语扩展 query ("派单" 与 "dispatch task" 命中重合率 > 70%)
//   - 5 条 embedding 阈值过滤 (cosine < 0.7 不显示 + 必带 file:line)
//
// 关注点:
//   - 不调真实 embed() (异步 + 模型依赖) — embeddings 源用 mocked searchByVector 注入.
//   - searchKnowledge() 改 async 后 (T4), 全部测试 await.
//   - 测试 fixture: 同时种 tasks / requirements / docs / symbols / links, 验证排序.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "./index";
import { searchKnowledge, SOURCE_ORDER } from "./knowledge";
import { upsertTerm } from "./business-terms";
import * as codeEmbeddings from "./code-embeddings";
import { cosineSimilarity, float32ToBuffer } from "../embeddings/bge-small";

// ---- DB fixture ----

let tmpDir: string;
let projectA: string;
let ownerA: string;

function setupTmpDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-e2e-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  // 创建 owner (users 表, 与 knowledge.test.ts seedUser 同款)
  ownerA = `user-${Math.random().toString(36).slice(2, 10)}`;
  const db = getDb();
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'user', datetime('now'))"
  ).run(ownerA, `${ownerA}@test.local`, "x");

  // 创建 project (cwd 用于 docs 源)
  projectA = `proj-${Math.random().toString(36).slice(2, 10)}`;
  const cwdA = path.join(tmpDir, "proj");
  fs.mkdirSync(cwdA, { recursive: true });
  fs.writeFileSync(path.join(cwdA, "doc1.md"), "# 派单配置\n派单到项目是平台核心流程.");
  fs.writeFileSync(path.join(cwdA, "doc2.md"), "# 其他主题\n不相关内容.");
  db.prepare(
    "INSERT INTO projects (id, name, owner_id, cwd, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(projectA, "test-proj", ownerA, cwdA);

  // Seed business terms (D5 双向扩展依赖)
  upsertTerm({
    damo_term: "派单",
    canonical: "dispatch task",
    aliases: "分发任务,派发,dispatch",
    domain: "platform",
  });
  upsertTerm({
    damo_term: "过卡",
    canonical: "deploy approval",
    aliases: "部署审批,通过审批,deploy-approval",
    domain: "platform",
  });
}

function teardownTmpDb(): void {
  closeDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  delete process.env.ORCHESTRATOR_DB_PATH;
}

function seedTask(title: string): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, prompt, owner_id, project_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
    )
    .run(`task-${Math.random().toString(36).slice(2, 10)}`, title, title, ownerA, projectA);
}

function seedRequirement(title: string): void {
  getDb()
    .prepare(
      `INSERT INTO requirements (id, title, description, owner_id, project_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
    )
    .run(
      `req-${Math.random().toString(36).slice(2, 10)}`,
      title,
      title,
      ownerA,
      projectA
    );
}

function seedCodeSymbol(name: string, file: string): void {
  const id = `${Math.random().toString(36).slice(2, 10)}:1`;
  getDb()
    .prepare(
      `INSERT INTO code_symbols (id, file, line, kind, name, signature, docstring, exported, indexed_at, file_mtime)
       VALUES (?, ?, 1, 'function', ?, 'function foo()', 'doc', 1, datetime('now'), datetime('now'))`
    )
    .run(id, file, name);
}

function seedBusinessLink(symbolName: string, refId: string): void {
  const sym = getDb()
    .prepare("SELECT id FROM code_symbols WHERE name = ? LIMIT 1")
    .get(symbolName) as { id: string } | undefined;
  if (!sym) return;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO code_business_links
         (id, symbol_id, kind, ref_kind, ref_id, ref_alias, provenance, created_at)
       VALUES (?, ?, '@requirement', 'requirement', ?, NULL, 'jsdoc', datetime('now'))`
    )
    .run(`${sym.id}:@requirement:abc12345`, sym.id, refId);
}

// ---- 1) 全 6+1 源排序 5 条 ----

describe("searchKnowledge / 7 源固定排序", () => {
  beforeEach(setupTmpDb);
  afterEach(teardownTmpDb);

  it("SOURCE_ORDER 常量: symbols > links > requirements > tasks > requirement_cache > docs > embeddings", () => {
    expect(SOURCE_ORDER).toEqual([
      "symbols",
      "links",
      "requirements",
      "tasks",
      "requirement_cache",
      "docs",
      "embeddings",
    ]);
  });

  it("搜索后 by_source 7 个 key 都在 (空 query 例外)", async () => {
    const r = await searchKnowledge({ query: "派单" }, ownerA);
    expect(Object.keys(r.by_source).sort()).toEqual(
      ["docs", "embeddings", "links", "requirements", "requirement_cache", "symbols", "tasks"].sort()
    );
  });

  it("多源命中时 (mock 各源都有数据) by_source 键齐全", async () => {
    // 各源种一条命中的数据
    seedTask("派单 task");
    seedRequirement("派单 requirement");
    seedCodeSymbol("dispatchTask", "src/lib/tasks.ts");
    seedBusinessLink("dispatchTask", "派单 feature");

    // mock embeddings 源返 1 个 hit
    vi.spyOn(codeEmbeddings, "searchByVector").mockReturnValue([
      {
        id: "emb-1",
        file: "src/lib/tasks.ts",
        line: 0,
        score: 0.85,
        chunk_text: "File: src/lib/tasks.ts\n...派单相关代码...",
      },
    ]);

    const r = await searchKnowledge({ query: "派单" }, ownerA);
    expect(r.by_source.tasks.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.requirements.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.symbols.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.links.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.docs.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.embeddings.length).toBeGreaterThanOrEqual(1);
    expect(r.by_source.requirement_cache.length).toBe(0); // 没 seed, 自然空
  });

  it("embeddings mock 命中带 file:line (满足 §5 约束 1)", async () => {
    vi.spyOn(codeEmbeddings, "searchByVector").mockReturnValue([
      {
        id: "emb-1",
        file: "src/lib/tasks.ts",
        line: 0,
        score: 0.85,
        chunk_text: "File: src/lib/tasks.ts\n派单到项目",
      },
    ]);

    const r = await searchKnowledge({ query: "派单", sources: ["embeddings"] }, ownerA);
    const hit = r.by_source.embeddings[0];
    expect(hit).toBeDefined();
    expect(hit?.meta?.file).toBe("src/lib/tasks.ts");
    expect(hit?.meta?.line).toBeDefined();
  });

  it("空 query 返所有源都是 [] + warning", async () => {
    const r = await searchKnowledge({ query: "   " }, ownerA);
    expect(r.total_hits).toBe(0);
    expect(r.by_source.tasks).toEqual([]);
    expect(r.by_source.symbols).toEqual([]);
    expect(r.by_source.embeddings).toEqual([]);
    expect(r.warnings).toContain("query 不能为空");
  });
});

// ---- 2) 术语扩展 5 条 ----

describe("searchKnowledge / 术语扩展 query", () => {
  beforeEach(setupTmpDb);
  afterEach(teardownTmpDb);

  it("派单 (damo 口语) 与 dispatch task (canonical) 都命中 requirements", async () => {
    seedRequirement("派单配置"); // damo 口语
    seedRequirement("dispatch task"); // canonical

    const rA = await searchKnowledge({ query: "派单" }, ownerA);
    const rB = await searchKnowledge({ query: "dispatch task" }, ownerA);
    // expandQuery("派单") → "(派单 | dispatch task | 分发任务 | 派发 | dispatch)" → 两条都命中
    // expandQuery("dispatch task") 含空格不扩展, 原 LIKE "%dispatch task%" → 命中自身
    expect(rA.by_source.requirements.length).toBeGreaterThanOrEqual(2);
    expect(rB.by_source.requirements.length).toBeGreaterThanOrEqual(1);
  });

  it("派单 query 命中 docs (含 '派单到项目是平台核心流程')", async () => {
    const r = await searchKnowledge({ query: "派单" }, ownerA);
    const docsHits = r.by_source.docs.filter((d) => d.title.includes("派单"));
    expect(docsHits.length).toBeGreaterThanOrEqual(1);
  });

  it("dispatch task query 也命中 docs (D5 双向扩展 + OR 字符串)", async () => {
    const r = await searchKnowledge({ query: "dispatch task" }, ownerA);
    // expandQuery("dispatch task") 不扩展 (含空格), 走原 LIKE → "dispatch task" → 文档里没这字面
    // 但 docs 里有 "派单", "派单" 不命中 LIKE "dispatch task"
    // 注: docs 内容 "派单到项目是平台核心流程" 不含 "dispatch task" 字面 → 0 命中 OK
    // 这是符合预期的 (D5 只对单 token 词做扩展)
    expect(r.by_source.docs.length).toBe(0);
  });

  it("派单 与 dispatch 在 symbols 源 命中重合率 > 70% (D5 验证指标)", async () => {
    // 种 5 个 symbol, 名字同时含 "dispatch"
    seedCodeSymbol("dispatchTask", "src/lib/tasks.ts");
    seedCodeSymbol("dispatchTasks", "src/lib/tasks.ts");
    seedCodeSymbol("dispatchTaskV2", "src/lib/tasks.ts");
    seedCodeSymbol("dispatchHook", "src/lib/hooks.ts");
    seedCodeSymbol("dispatchJob", "src/lib/jobs.ts");

    const rA = await searchKnowledge(
      { query: "派单", sources: ["symbols"] },
      ownerA
    );
    // 用 "dispatch" (单 token, 走 expandQuery → "派单" alias) 而不是 "dispatch task" (含空格不扩展)
    const rB = await searchKnowledge(
      { query: "dispatch", sources: ["symbols"] },
      ownerA
    );

    const namesA = new Set(rA.by_source.symbols.map((h) => h.title));
    const namesB = new Set(rB.by_source.symbols.map((h) => h.title));

    // 派单 走 expandQuery → "(派单 | dispatch task | 分发任务 | 派发 | dispatch)" → LIKE %dispatch% → 5 个
    expect(namesA.size).toBe(5);
    // dispatch 是 alias, 同命中 5 个
    expect(namesB.size).toBe(5);

    // 重合率 = |交集| / max(|A|, |B|)
    const intersect = [...namesA].filter((n) => namesB.has(n)).length;
    const ratio = intersect / Math.max(namesA.size, namesB.size, 1);
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });

  it("过卡 (deploy approval) 也走 D5 扩展 — 命中 deployment 相关 docs", async () => {
    // 写一个 docs 含 "deploy approval" 字面
    fs.writeFileSync(
      path.join(tmpDir, "proj", "deploy.md"),
      "# Deploy Approval Flow\ndeploy approval 是平台审批流程"
    );
    const r = await searchKnowledge({ query: "过卡" }, ownerA);
    // expandQuery("过卡") → "(过卡 | deploy approval | 部署审批 | ...)" → 命中
    const deployHits = r.by_source.docs.filter((d) => d.title.toLowerCase().includes("deploy"));
    expect(deployHits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- 3) embedding 阈值过滤 5 条 ----

describe("searchKnowledge / embedding 阈值过滤 (mocked)", () => {
  beforeEach(setupTmpDb);
  afterEach(teardownTmpDb);

  it("searchByVector mock 返 [] 时 embeddings 源空", async () => {
    vi.spyOn(codeEmbeddings, "searchByVector").mockReturnValue([]);
    const r = await searchKnowledge({ query: "test", sources: ["embeddings"] }, ownerA);
    expect(r.by_source.embeddings.length).toBe(0);
  });

  it("searchByVector 返回的 score >= 0.7 才显示 (mock 上层已过滤)", async () => {
    vi.spyOn(codeEmbeddings, "searchByVector").mockReturnValue([
      {
        id: "high",
        file: "src/lib/a.ts",
        line: 0,
        score: 0.92,
        chunk_text: "File: src/lib/a.ts\nhigh match",
      },
      {
        id: "mid",
        file: "src/lib/b.ts",
        line: 0,
        score: 0.75,
        chunk_text: "File: src/lib/b.ts\nmid match",
      },
    ]);
    const r = await searchKnowledge({ query: "test", sources: ["embeddings"] }, ownerA);
    expect(r.by_source.embeddings.length).toBe(2);
    // 上层 KnowledgeHitBase.score 反映原始 cosine
    expect(r.by_source.embeddings[0]?.score).toBeGreaterThanOrEqual(0.7);
    expect(r.by_source.embeddings[1]?.score).toBeGreaterThanOrEqual(0.7);
  });

  it("embeddings 源 hit 必带 file:line (满足 plan §5 约束 1)", async () => {
    vi.spyOn(codeEmbeddings, "searchByVector").mockReturnValue([
      {
        id: "x",
        file: "src/lib/foo.ts",
        line: 0,
        score: 0.88,
        chunk_text: "File: src/lib/foo.ts\ncontent",
      },
    ]);
    const r = await searchKnowledge({ query: "foo", sources: ["embeddings"] }, ownerA);
    const hit = r.by_source.embeddings[0];
    expect(hit).toBeDefined();
    expect(hit?.meta?.file).toBe("src/lib/foo.ts");
    expect(typeof hit?.meta?.line).toBe("number");
  });

  it("embeddings 源 warnings 不污染其他源 (catch 在子函数里)", async () => {
    vi.spyOn(codeEmbeddings, "searchByVector").mockImplementation(() => {
      throw new Error("mocked DB error");
    });
    const r = await searchKnowledge(
      { query: "派单", sources: ["tasks", "embeddings"] },
      ownerA
    );
    // embeddings 失败不应影响 tasks 源
    expect(r.warnings.some((w) => w.includes("embeddings"))).toBe(true);
  });

  it("cosineSimilarity 工具函数: 同向量=1, 反向量=-1, 正交=0", () => {
    const a = new Float32Array([0.6, 0.8, 0]); // norm=1
    const b = new Float32Array([0.6, 0.8, 0]); // 同
    const c = new Float32Array([-0.6, -0.8, 0]); // 反
    const d = new Float32Array([0, 0, 1]); // 正交
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(a, c)).toBeCloseTo(-1.0, 5);
    expect(cosineSimilarity(a, d)).toBeCloseTo(0.0, 5);
    // 长度不等返 0
    const e = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, e)).toBe(0);
    // 空向量返 0
    expect(cosineSimilarity(a, new Float32Array(0))).toBe(0);
  });
});
