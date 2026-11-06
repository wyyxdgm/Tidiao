// code-symbols — Code Knowledge Index L1 CRUD (飞书 R92 第二阶段, T2).
//
// 设计要点:
//   - 单一入口操作 code_symbols 表 (v126 migration).
//   - upsertCodeSymbol: INSERT OR REPLACE — 重复 (file, line, name) 直接覆盖 (id 同).
//   - deleteByFile: 单文件失效时批量删 (post-commit hook 调).
//   - listByFile: 拿单文件 symbol 列表 (诊断 / 自检).
//   - searchSymbols: 字面 LIKE 命中 name + signature + docstring, score =
//     name/title 命中 3 + signature 命中 2 + docstring 命中 1.
//   - 永不抛错 (searchSymbols 失败返空, caller 仍可继续).
//
// 关注点:
//   - 复 searchKnowledge() 风格: escapeLike + ESCAPE '\\' 模式防 % _ 通配.
//   - SQLite LIKE 不区分大小写 (ASCII only); 中文检索按字面 substring 也够用.
//   - score 仅在同一 source 内排序, 不跨 source 比较.
//   - file_mtime 是失效判据 (查时 file_mtime != current_file_mtime 触发重抽,
//     计划 §4.2); 本模块不负责抽, 只负责存.

import { getDb } from "./index";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "default";

export type CodeSymbol = {
  id: string; // {file_hash}:{line}
  file: string;
  line: number;
  kind: SymbolKind;
  name: string;
  signature: string;
  docstring: string | null;
  exported: 0 | 1;
  indexed_at: string;
  file_mtime: string;
};

export type SearchResult = CodeSymbol & { score: number };

// ---- 工具 ----

// 转义 LIKE 元字符 (% _ \) 给 ESCAPE '\\' 模式用 — 与 searchKnowledge() 同款.
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---- CRUD ----

// 功能: 写入或覆盖单个 code symbol. INSERT OR REPLACE 走 PRIMARY KEY (id) 冲突路径.
// 关注点: id 由 caller 算 ({file_hash}:{line}); 同 id 重复写 = 覆盖, 不会重复行.
export function upsertCodeSymbol(symbol: CodeSymbol): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO code_symbols
       (id, file, line, kind, name, signature, docstring, exported, indexed_at, file_mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    symbol.id,
    symbol.file,
    symbol.line,
    symbol.kind,
    symbol.name,
    symbol.signature,
    symbol.docstring,
    symbol.exported,
    symbol.indexed_at,
    symbol.file_mtime
  );
}

// 功能: 批量写入 — 给 import-code-symbols.ts 用, 单事务全 upsert.
// 关注点: 用 transaction 包, 单 symbol 失败回滚整批; caller 负责事前校验.
export function upsertCodeSymbols(symbols: CodeSymbol[]): void {
  if (symbols.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO code_symbols
       (id, file, line, kind, name, signature, docstring, exported, indexed_at, file_mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows: CodeSymbol[]) => {
    for (const s of rows) {
      stmt.run(
        s.id,
        s.file,
        s.line,
        s.kind,
        s.name,
        s.signature,
        s.docstring,
        s.exported,
        s.indexed_at,
        s.file_mtime
      );
    }
  });
  tx(symbols);
}

// 功能: 删除单文件全部 code symbol. post-commit hook 增量更新前调用, 防残留.
// 关注点: 不返回删除数量 (caller 不依赖); FK CASCADE 会带走 code_business_links (T3).
export function deleteByFile(file: string): void {
  const db = getDb();
  db.prepare("DELETE FROM code_symbols WHERE file = ?").run(file);
}

// 功能: 清空整张表 — 全量重建前用 (scripts/reindex-code-symbols.sh --all).
// 关注点: 真 DELETE ALL, 不 TRUNCATE (SQLite 无 TRUNCATE); FK CASCADE 同步清 links.
export function clearAll(): void {
  const db = getDb();
  db.prepare("DELETE FROM code_symbols").run();
}

// 功能: 拿单文件全部 symbol — 诊断 + 测试 fixture 用.
// 关注点: 按 line ASC, 与源码阅读顺序一致.
export function listByFile(file: string): CodeSymbol[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, file, line, kind, name, signature, docstring, exported,
              indexed_at, file_mtime
         FROM code_symbols WHERE file = ? ORDER BY line ASC`
    )
    .all(file) as CodeSymbol[];
}

// 功能: 整表行数 — 给自检 / 进度面板用.
// 关注点: 直接 COUNT(*) — 全表 ~750 行 O(1) (SQLite 维护 row count 近似值).
export function countAll(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM code_symbols").get() as { n: number };
  return row.n;
}

// ---- search ----

interface SearchOpts {
  kind?: SymbolKind;
  exported?: boolean;
  limit?: number;
}

// 功能: 字面搜 code_symbols. score = name 命中 3 + signature 命中 2 + docstring 命中 1.
// 关注点:
//   - 不抛错 (catch → 返空); 永不阻断 caller.
//   - LIKE 不区分大小写, 中文按字面 substring 命中.
//   - options.exported = true 仅返回 exported=1; false 仅返回非 exported (P3 helper).
//   - 默认 limit=20, 上限 50 (与 searchKnowledge 对齐, 防止单源膨胀).
//   - T4 round-8 D5 真修复: query 接受 string | string[] — 多个 term 时按 term
//     数量展开 OR-of-LIKE, 让双向扩展端到端生效. 直接传 string 的旧 caller
//     (tests) 自动归一为 [query], 行为不变.
export function searchSymbols(
  query: string | string[],
  options: SearchOpts = {}
): SearchResult[] {
  try {
    // 归一: string → [string], string[] 原样
    const terms = Array.isArray(query)
      ? query.map((t) => (t ?? "").trim()).filter(Boolean)
      : [(query ?? "").trim()].filter(Boolean);
    if (terms.length === 0) return [];

    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    // score 用首个 term 做命中判定 (= 用户实际输入 / 展示主词)
    const lower = terms[0].toLowerCase();

    // 每个 term 都参与 LIKE OR (D5 双向扩展端到端命中)
    const fieldOrPerTerm = (): string =>
      "(name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\' OR docstring LIKE ? ESCAPE '\\')";
    const where: string[] = [terms.map(fieldOrPerTerm).join(" OR ")];
    const params: any[] = [];
    for (const t of terms) {
      const like = `%${escapeLike(t)}%`;
      params.push(like, like, like);
    }

    if (options.kind) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    if (options.exported !== undefined) {
      where.push("exported = ?");
      params.push(options.exported ? 1 : 0);
    }

    const rows = getDb()
      .prepare(
        `SELECT id, file, line, kind, name, signature, docstring, exported,
                indexed_at, file_mtime
           FROM code_symbols WHERE ${where.join(" AND ")}
          ORDER BY indexed_at DESC LIMIT ?`
      )
      .all(...params, limit) as CodeSymbol[];

    const results: SearchResult[] = rows.map((r) => {
      const inName = r.name.toLowerCase().includes(lower);
      const inSig = r.signature.toLowerCase().includes(lower);
      const inDoc = r.docstring ? r.docstring.toLowerCase().includes(lower) : false;
      const score = (inName ? 3 : 0) + (inSig ? 2 : 0) + (inDoc ? 1 : 0);
      return { ...r, score };
    });
    // 源内按 score desc, 然后 indexed_at desc (新索引优先 — 防 stale 行卡 top).
    results.sort(
      (a, b) =>
        b.score - a.score || String(b.indexed_at ?? "").localeCompare(String(a.indexed_at ?? ""))
    );
    return results;
  } catch {
    // 永不抛错 — caller 继续.
    return [];
  }
}