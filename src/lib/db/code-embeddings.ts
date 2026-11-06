// code-embeddings — Code Knowledge Index L3 CRUD (飞书 R92 第二阶段, T4).
//
// 设计要点:
//   - 单一入口操作 code_embeddings 表 (v128 migration, schema 已就位).
//   - upsertEmbedding: INSERT OR REPLACE 走 PRIMARY KEY (id) 冲突路径.
//     id 派生见 src/lib/embeddings/bge-small.ts 的 fileChunkId().
//   - deleteByFile: 单文件失效时批量删 (mtime 变化触发).
//   - clearAll: 全量重建前清表 (scripts/reindex-embeddings.sh 走全量).
//   - searchByVector: 内存 cosine 计算 (SQLite 无向量索引), threshold=0.7 默认
//     (plan §5 约束 2: 低于静默丢, 不显示). 返回 topK + file:line meta.
//   - 永不抛错 (searchByVector 失败返空, caller 仍可继续).
//   - countAll: 自检 + bootstrap 进度面板.
//
// 关注点:
//   - searchByVector 走内存 brute-force: ~150 个 file chunk O(N) 可接受 (ms 级);
//     上 1000 行再考虑 sqlite-vss 等扩展, 本阶段不引入新依赖.
//   - vector BLOB 反序列化走 bufferToFloat32() — 与 float32ToBuffer() 配对.
//   - searchByVector 的 meta 字段由 caller 决定 (file/line/chunk_text), 本函数
//     只返 row 原始字段, 让 knowledge.ts 转 KnowledgeHitBase.
//   - score 仅在同一 source (embeddings) 内排序, 不跨 source 比较.

import { getDb } from "./index";
import {
  bufferToFloat32,
  cosineSimilarity,
} from "../embeddings/bge-small";

export type ChunkKind = "file" | "function";

export type CodeEmbedding = {
  id: string;
  chunk_kind: ChunkKind;
  chunk_text: string;
  vector: Buffer;
  model: string;
  indexed_at: string;
  file_mtime: string;
};

// searchByVector 的返回行 — caller 直接组装 KnowledgeHitBase.
export type EmbeddingSearchResult = {
  id: string;
  file: string; // 从 chunk_text/file_mtime 派生 — 当前 chunk_kind=file 时 chunk_text 第一行 "File: <rel>"
  line: number; // file chunk 固定 0 (整文件); caller 可自己映射
  score: number;
  chunk_text: string;
};

// ---- CRUD ----

/**
 * 写入或覆盖单个 code embedding. INSERT OR REPLACE 走 PRIMARY KEY (id).
 *
 * 关注点:
 *   - id 由 caller 算 (src/lib/embeddings/bge-small.ts:fileChunkId).
 *   - chunk_text 限长 (BLOB 不限, TEXT 列无显式上限, 但 ≤ 8000 字符截断已
 *     在 embed() 内做).
 */
export function upsertEmbedding(emb: CodeEmbedding): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO code_embeddings
         (id, chunk_kind, chunk_text, vector, model, indexed_at, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      emb.id,
      emb.chunk_kind,
      emb.chunk_text,
      emb.vector,
      emb.model,
      emb.indexed_at,
      emb.file_mtime
    );
}

/**
 * 批量写入 — 给 import-code-embeddings.ts 用, 单事务全 upsert.
 *
 * 关注点: 任一行 fail = 整批回滚. caller 负责事前校验 (vector Buffer 非空等).
 */
export function upsertEmbeddings(embs: CodeEmbedding[]): number {
  if (embs.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO code_embeddings
       (id, chunk_kind, chunk_text, vector, model, indexed_at, file_mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const e of embs) {
      stmt.run(
        e.id,
        e.chunk_kind,
        e.chunk_text,
        e.vector,
        e.model,
        e.indexed_at,
        e.file_mtime
      );
    }
  })();
  return embs.length;
}

/**
 * 删除单文件全部 embedding — mtime 变化时调 (post-commit hook 增量).
 * 关注点: 当前 chunk_kind='file' 为主, 一行一文件; 后续 function chunk
 * 落地后, 本函数应按 chunk_text LIKE '%<rel-file>%' 删, 暂不实现.
 */
export function deleteByFile(file: string): void {
  // chunk_text 第一行 "File: <rel>" 标记 — LIKE 删稳.
  const marker = `File: ${file}`;
  getDb()
    .prepare(`DELETE FROM code_embeddings WHERE chunk_text LIKE ? ESCAPE '\\'`)
    .run(`%${marker.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
}

/**
 * 清空整张表 — 全量重建前用 (scripts/reindex-embeddings.sh 链).
 * 关注点: 真 DELETE ALL, 不 TRUNCATE (SQLite 无 TRUNCATE).
 */
export function clearAll(): void {
  getDb().prepare("DELETE FROM code_embeddings").run();
}

/**
 * 整表行数 — 自检 / 验收用.
 */
export function countAll(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM code_embeddings")
    .get() as { n: number };
  return row.n;
}

/**
 * 按 model 过滤的行数 — 切模型后重算验证用.
 */
export function countByModel(model: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM code_embeddings WHERE model = ?")
    .get(model) as { n: number };
  return row.n;
}

// ---- search ----

interface SearchByVectorOpts {
  limit?: number;
  threshold?: number; // 默认 0.7 (plan §5 约束 2)
}

/**
 * 用 query 向量 + cosine similarity 检索 embeddings.
 *
 * 关注点:
 *   - 内存 brute-force: ~150 行 O(N) ~ms 级; 1000+ 行再考虑 sqlite-vss.
 *   - threshold 默认 0.7, 低于静默丢 (plan §5 约束 2: 不误导).
 *   - 每个 hit 必带 file:line (chunk_text 第一行 "File: <rel>" 拿 file,
 *     line 固定 0 = file chunk; caller 转 KnowledgeHitBase 时补全).
 *   - 永不抛错 (catch → 返空).
 */
export function searchByVector(
  queryVec: Float32Array,
  options: SearchByVectorOpts = {}
): EmbeddingSearchResult[] {
  try {
    if (!queryVec || queryVec.length === 0) return [];
    const threshold = options.threshold ?? 0.7;
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));

    const rows = getDb()
      .prepare(
        `SELECT id, chunk_kind, chunk_text, vector, model, indexed_at, file_mtime
           FROM code_embeddings`
      )
      .all() as Array<{
        id: string;
        chunk_kind: ChunkKind;
        chunk_text: string;
        vector: Buffer;
        model: string;
        indexed_at: string;
        file_mtime: string;
      }>;

    const scored: Array<EmbeddingSearchResult & { _score: number }> = [];
    for (const r of rows) {
      const vec = bufferToFloat32(r.vector);
      const score = cosineSimilarity(queryVec, vec);
      if (score < threshold) continue;
      // 从 chunk_text 第一行抽 file (格式: "File: <rel>\n<content>")
      const fileMatch = /^File: (.+)\n/.exec(r.chunk_text);
      const file = fileMatch?.[1] ?? r.id;
      scored.push({
        id: r.id,
        file,
        line: 0, // file chunk 无 line 概念; caller 渲染为 "整文件"
        score,
        chunk_text: r.chunk_text,
        _score: score,
      });
    }
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit).map(({ _score, ...rest }) => rest);
  } catch {
    return [];
  }
}

/**
 * 拿整行 (测试用) — 给单条 id 反查元数据.
 */
export function getById(id: string): CodeEmbedding | null {
  const row = getDb()
    .prepare(
      `SELECT id, chunk_kind, chunk_text, vector, model, indexed_at, file_mtime
         FROM code_embeddings WHERE id = ?`
    )
    .get(id) as CodeEmbedding | undefined;
  return row ?? null;
}

/**
 * 列出所有 id + meta — 失效率测试用 (对比 file_mtime).
 */
export function listAllMeta(): Array<{
  id: string;
  chunk_kind: ChunkKind;
  file_mtime: string;
  indexed_at: string;
  file: string;
}> {
  const rows = getDb()
    .prepare(
      `SELECT id, chunk_kind, file_mtime, indexed_at, chunk_text FROM code_embeddings`
    )
    .all() as Array<{
      id: string;
      chunk_kind: ChunkKind;
      file_mtime: string;
      indexed_at: string;
      chunk_text: string;
    }>;
  return rows.map((r) => ({
    id: r.id,
    chunk_kind: r.chunk_kind,
    file_mtime: r.file_mtime,
    indexed_at: r.indexed_at,
    file: /^File: (.+)\n/.exec(r.chunk_text)?.[1] ?? r.id,
  }));
}
