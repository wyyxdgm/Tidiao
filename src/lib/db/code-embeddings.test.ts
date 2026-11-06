// code-embeddings.test.ts — Code Knowledge Index L3 单元测试 (飞书 R92 第二阶段, T4).
//
// 测试分布 (plan §5 测试策略):
//   - 5 条 CRUD (upsert / deleteByFile / clearAll / countAll / listAllMeta)
//   - 10 条 searchByVector score 阈值过滤 (< 0.7 不返回)
//   - 5 条 失效率 (mtime 变化 / stale 标记)
//
// 关注点:
//   - 用 ORCHESTRATOR_DB_PATH 指向 tmpDir, 走 v128 migration 自动建表.
//   - 不调真实 embed() — 测试 fixture 直接造伪 embedding (3 维向量 + 已知 cosine).
//   - cosineSimilarity / bufferToFloat32 是 bge-small.ts 公开工具, 这里测语义.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "./index";
import {
  clearAll,
  countAll,
  countByModel,
  deleteByFile,
  getById,
  listAllMeta,
  searchByVector,
  upsertEmbedding,
  upsertEmbeddings,
  type CodeEmbedding,
} from "./code-embeddings";
import { cosineSimilarity, float32ToBuffer } from "../embeddings/bge-small";

// ---- 测试工具 ----

let tmpDir: string;
const MODEL_TAG = "bge-small-test";

function setupTmpDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-emb-test-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
}

function teardownTmpDb(): void {
  closeDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  delete process.env.ORCHESTRATOR_DB_PATH;
}

// 造伪 384 维归一化向量 (cosine 可算). 3 维足够测算法.
// 关注点: 已知 cosine(query, exact)=1.0, cosine(query, ortho)=0, cosine(query, partial)=cosθ.
function makeVec(seed: number, dims = 384): Float32Array {
  const v = new Float32Array(dims);
  // 用 seed 生成方向固定的伪归一化向量
  for (let i = 0; i < dims; i++) {
    v[i] = Math.sin(seed * (i + 1)) * Math.cos(seed * i * 0.5);
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i]! /= norm;
  return v;
}

function makeRow(seed: number, opts: {
  id?: string;
  file?: string;
  mtime?: string;
  content?: string;
} = {}): CodeEmbedding {
  const id = opts.id ?? `emb-${seed}`;
  const file = opts.file ?? `src/lib/test-${seed}.ts`;
  const mtime = opts.mtime ?? "2026-09-07T00:00:00.000Z";
  const content = opts.content ?? `function test${seed}() { return ${seed}; }`;
  return {
    id,
    chunk_kind: "file",
    chunk_text: `File: ${file}\n${content}`,
    vector: float32ToBuffer(makeVec(seed)),
    model: MODEL_TAG,
    indexed_at: mtime,
    file_mtime: mtime,
  };
}

// ---- 1) CRUD 5 条 ----

describe("code-embeddings / CRUD", () => {
  beforeEach(setupTmpDb);
  afterEach(teardownTmpDb);

  it("upsertEmbedding 单条写入 + getById 反查", () => {
    const row = makeRow(1);
    upsertEmbedding(row);
    const got = getById(row.id);
    expect(got).not.toBeNull();
    expect(got?.id).toBe(row.id);
    expect(got?.chunk_text.startsWith("File: src/lib/test-1.ts")).toBe(true);
    expect(got?.model).toBe(MODEL_TAG);
  });

  it("upsertEmbeddings 批量写入 + countAll 正确", () => {
    const rows = [makeRow(1), makeRow(2), makeRow(3), makeRow(4), makeRow(5)];
    const n = upsertEmbeddings(rows);
    expect(n).toBe(5);
    expect(countAll()).toBe(5);
    expect(countByModel(MODEL_TAG)).toBe(5);
    expect(countByModel("other-model")).toBe(0);
  });

  it("upsertEmbedding 同 id 覆盖 (INSERT OR REPLACE)", () => {
    upsertEmbedding(makeRow(1, { content: "version 1" }));
    upsertEmbedding(makeRow(1, { content: "version 2" }));
    expect(countAll()).toBe(1);
    const got = getById("emb-1");
    expect(got?.chunk_text).toContain("version 2");
  });

  it("deleteByFile 按 file marker 删除", () => {
    upsertEmbedding(makeRow(1, { file: "src/lib/a.ts" }));
    upsertEmbedding(makeRow(2, { file: "src/lib/a.ts" }));
    upsertEmbedding(makeRow(3, { file: "src/lib/b.ts" }));
    expect(countAll()).toBe(3);
    deleteByFile("src/lib/a.ts");
    expect(countAll()).toBe(1);
    expect(getById("emb-3")).not.toBeNull();
  });

  it("clearAll 清空整表", () => {
    upsertEmbedding(makeRow(1));
    upsertEmbedding(makeRow(2));
    clearAll();
    expect(countAll()).toBe(0);
  });
});

// ---- 2) searchByVector 阈值过滤 10 条 ----

describe("code-embeddings / searchByVector 阈值过滤", () => {
  beforeEach(setupTmpDb);
  afterEach(teardownTmpDb);

  it("完全相同向量 cosine=1.0 > 0.7 返回", () => {
    const seed = 42;
    const v = makeVec(seed);
    upsertEmbedding(makeRow(seed));
    const out = searchByVector(v, { threshold: 0.7 });
    expect(out.length).toBe(1);
    expect(out[0]?.score).toBeCloseTo(1.0, 2);
  });

  it("正交向量 cosine=0 不返回 (< 0.7)", () => {
    // a 与 b: a[i] = 1 for i%2=0, 0 else; b 反过来 → cosine ≈ 0
    const a = new Float32Array(384);
    const b = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      a[i] = i % 2 === 0 ? 1 / Math.sqrt(192) : 0;
      b[i] = i % 2 === 0 ? 0 : 1 / Math.sqrt(192);
    }
    upsertEmbedding({
      id: "a",
      chunk_kind: "file",
      chunk_text: "File: src/a.ts\nx",
      vector: float32ToBuffer(a),
      model: MODEL_TAG,
      indexed_at: "2026-09-07T00:00:00.000Z",
      file_mtime: "2026-09-07T00:00:00.000Z",
    });
    const out = searchByVector(b, { threshold: 0.7 });
    expect(out.length).toBe(0);
  });

  it("完全反向量 cosine=-1 < 0.7 不返回", () => {
    const v = makeVec(7);
    const neg = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) neg[i] = -v[i]!;
    upsertEmbedding({
      id: "neg",
      chunk_kind: "file",
      chunk_text: "File: src/neg.ts\nx",
      vector: float32ToBuffer(neg),
      model: MODEL_TAG,
      indexed_at: "2026-09-07T00:00:00.000Z",
      file_mtime: "2026-09-07T00:00:00.000Z",
    });
    const out = searchByVector(v, { threshold: 0.7 });
    expect(out.length).toBe(0);
  });

  it("threshold 可配 (0.5 / 0.7 / 0.9 三档)", () => {
    upsertEmbedding(makeRow(100)); // 与 query 完全相同 → 1.0
    const v = makeVec(100);
    expect(searchByVector(v, { threshold: 0.5 }).length).toBeGreaterThanOrEqual(1);
    expect(searchByVector(v, { threshold: 0.7 }).length).toBe(1);
    expect(searchByVector(v, { threshold: 0.9 }).length).toBe(1);
  });

  it("limit 上限生效 (返回 ≤ limit 条)", () => {
    // 10 条 embedding, query 与其中之一相同
    for (let i = 0; i < 10; i++) upsertEmbedding(makeRow(i));
    const out = searchByVector(makeVec(5), { threshold: 0.0, limit: 3 });
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("按 score 降序排列", () => {
    upsertEmbedding(makeRow(1)); // cosine ≈ 1.0
    upsertEmbedding(makeRow(2));
    upsertEmbedding(makeRow(3));
    const v = makeVec(1);
    // threshold=-1.1 确保 cosine 任意值都不过滤 (含负值)
    const out = searchByVector(v, { threshold: -1.1, limit: 10 });
    expect(out.length).toBe(3);
    // 第一个 score 应该 ≥ 第二个
    expect(out[0]!.score).toBeGreaterThanOrEqual(out[1]!.score);
    expect(out[1]!.score).toBeGreaterThanOrEqual(out[2]!.score);
    // 第一条 score 应该接近 1.0 (与自身 cosine)
    expect(out[0]!.score).toBeCloseTo(1.0, 2);
  });

  it("返回行带 file:line meta (chunk_text 第一行抽 file)", () => {
    upsertEmbedding(makeRow(1, { file: "src/lib/foo.ts" }));
    const out = searchByVector(makeVec(1), { threshold: 0.7 });
    expect(out[0]?.file).toBe("src/lib/foo.ts");
    expect(out[0]?.line).toBe(0); // file chunk 无 line 概念
  });

  it("空 queryVec 返空 (不抛错)", () => {
    upsertEmbedding(makeRow(1));
    const out = searchByVector(new Float32Array(0), { threshold: 0.0 });
    expect(out.length).toBe(0);
  });

  it("无 embedding 行时返空 (不抛错)", () => {
    const out = searchByVector(makeVec(1), { threshold: 0.7 });
    expect(out.length).toBe(0);
  });

  it("chunk_text 200 字截断在 KnowledgeHitBase 上层做 (本函数返原)", () => {
    // 本函数只返 chunk_text 原文, 截断是 searchCodeEmbeddings() 上层职责.
    const long = "x".repeat(5000);
    upsertEmbedding(makeRow(1, { content: long }));
    const out = searchByVector(makeVec(1), { threshold: 0.7 });
    expect(out[0]?.chunk_text.length).toBeGreaterThan(200);
  });
});

// ---- 3) 失效率 5 条 ----

describe("code-embeddings / 失效率 (mtime + stale)", () => {
  beforeEach(setupTmpDb);
  afterEach(teardownTmpDb);

  it("listAllMeta 返回 id + file + mtime (用于失效率判据)", () => {
    upsertEmbedding(makeRow(1, { mtime: "2026-09-01T00:00:00.000Z" }));
    upsertEmbedding(makeRow(2, { mtime: "2026-09-02T00:00:00.000Z" }));
    const meta = listAllMeta();
    expect(meta.length).toBe(2);
    const m1 = meta.find((m) => m.id === "emb-1");
    const m2 = meta.find((m) => m.id === "emb-2");
    expect(m1?.file).toBe("src/lib/test-1.ts");
    expect(m1?.file_mtime).toBe("2026-09-01T00:00:00.000Z");
    expect(m2?.file_mtime).toBe("2026-09-02T00:00:00.000Z");
  });

  it("mtime 更新 → indexed_at 同步更新 (upsert 写入新 mtime)", () => {
    upsertEmbedding(makeRow(1, { mtime: "2026-09-01T00:00:00.000Z" }));
    const before = listAllMeta().find((m) => m.id === "emb-1");
    expect(before?.file_mtime).toBe("2026-09-01T00:00:00.000Z");

    // 模拟 mtime 变了 → 重抽时 indexed_at 更新
    upsertEmbedding(makeRow(1, { mtime: "2026-09-07T12:00:00.000Z" }));
    const after = listAllMeta().find((m) => m.id === "emb-1");
    expect(after?.file_mtime).toBe("2026-09-07T12:00:00.000Z");
  });

  it("post-commit hook 场景: deleteByFile + 重抽 → 索引同步", () => {
    upsertEmbedding(makeRow(1, { file: "src/lib/foo.ts", mtime: "2026-09-01" }));
    upsertEmbedding(makeRow(2, { file: "src/lib/bar.ts", mtime: "2026-09-01" }));
    expect(countAll()).toBe(2);

    // foo.ts 改了 → 删旧行 + 灌新行
    deleteByFile("src/lib/foo.ts");
    upsertEmbedding(makeRow(1, { file: "src/lib/foo.ts", mtime: "2026-09-07" }));
    expect(countAll()).toBe(2);
    const foo = listAllMeta().find((m) => m.id === "emb-1");
    expect(foo?.file_mtime).toBe("2026-09-07");
  });

  it("chunk_text 改后 searchByVector 还能命中 (vector 不变)", () => {
    upsertEmbedding(makeRow(7, { content: "version 1 content" }));
    const v = makeVec(7);
    expect(searchByVector(v, { threshold: 0.7 }).length).toBe(1);
    // 改 chunk_text 不改 vector (reindex 不重算时)
    upsertEmbedding(makeRow(7, { content: "version 2 content - different words but same vector" }));
    expect(searchByVector(v, { threshold: 0.7 }).length).toBe(1);
  });

  it("model 切换 → countByModel 隔离统计", () => {
    upsertEmbedding(makeRow(1, { id: "old-1" }));
    upsertEmbedding({ ...makeRow(2, { id: "old-2" }), model: "text-embed-3-small" });
    upsertEmbedding(makeRow(3, { id: "new-1" }));
    upsertEmbedding({ ...makeRow(4, { id: "new-2" }), model: "text-embed-3-small" });
    expect(countByModel(MODEL_TAG)).toBe(2);
    expect(countByModel("text-embed-3-small")).toBe(2);
  });
});
