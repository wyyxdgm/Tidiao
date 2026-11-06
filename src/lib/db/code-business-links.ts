// code-business-links — Code Knowledge Index L2 业务衔接层 (飞书 R92 第二阶段, T3).
//
// 设计要点:
//   - 单一入口操作 code_business_links 表 (v127 migration).
//   - upsertBusinessLink / upsertBusinessLinks: INSERT OR REPLACE 走 UNIQUE
//     (symbol_id, kind, ref_id), 重复写 = 覆盖 (id 同); 不靠 id 显式指定, 由 caller 派生.
//   - getBySymbol: 单 symbol 的全部 link, 给前端 "this function links to" 渲染.
//   - getByRef: 反向 query — 找所有实现某 requirement / 命中某 feature 的代码,
//     是 plan §3.2.1 "反向查询" 主入口 (--linked-to 走这里).
//   - searchLinks: 与 searchSymbols / searchKnowledge 同套 score 规则 (ref_id 3 + ref_alias 2
//     + kind 1), 默认 limit=20, 上限 50. **静默过滤 provenance = 'llm_suggested'**
//     (plan §5 约束 5: 档 1 LLM 输出不直接进 search, 等人审核才升 manual_confirmed).
//   - deleteBySymbol: 单 symbol 重抽时级联清理 link (与 code_symbols FK CASCADE 互补,
//     本函数用于 caller 想显式提前删的场景).
//   - countAll / countByProvenance: 自检 + bootstrap 进度面板用.
//
// 关注点:
//   - searchLinks 永不抛错 (catch → 返空, caller 继续).
//   - LIKE escape 与 searchKnowledge() 同款 (ESCAPE '\\' 模式).
//   - score 仅在同一 source 内排序, 不跨 source 比较.
//   - llm_suggested 过滤是**本模块强约束**: caller 拿到结果里不应出现
//     provenance='llm_suggested' 的行. 后续 UI 待审入口直接查表 (不过本函数).

import { getDb } from "./index";
import type { SearchResult as CodeSymbolSearchResult } from "./code-symbols";

export type BusinessLinkKind =
  | "@requirement"
  | "@feature"
  | "@module"
  | "@see"
  | "@doc"
  | "@task"
  | "manual";

export type BusinessRefKind =
  | "requirement"
  | "feature"
  | "module"
  | "doc_path"
  | "script"
  | "task"
  | "external";

export type BusinessLinkProvenance =
  | "jsdoc"
  | "frontmatter"
  | "llm_suggested"
  | "manual_confirmed"
  | "learned_md"
  | "doc_extracted";

export type BusinessLink = {
  id: string;
  symbol_id: string;
  kind: BusinessLinkKind;
  ref_kind: BusinessRefKind;
  ref_id: string;
  ref_alias: string | null;
  provenance: BusinessLinkProvenance;
  created_at: string;
};

// 暴露给前端的 type (从 symbol join 出来一行), 用于 "this function links to" 渲染.
export type BusinessLinkHit = BusinessLink & {
  symbol_name: string;
  symbol_file: string;
  symbol_line: number;
  symbol_kind: string;
};

export type SearchResult = BusinessLink & {
  score: number;
  symbol: CodeSymbolSearchResult;
};

// ---- 工具 ----

// 功能: 生成稳定 id = "{symbol_id}:{kind}:{ref_id_hash8}".
// 关注点: hash8 = sha1(ref_id).slice(0,8), 跨机器/重启稳定; UNIQUE(symbol_id, kind, ref_id)
//   兜底 (id 仅用于 PRIMARY KEY).
function makeId(symbolId: string, kind: string, refId: string): string {
  // 用 node:crypto 的动态 import 避免顶层拉 crypto (vitest mock 兼容).
  // 这里走模块顶部 import, 简单.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const hash8 = crypto.createHash("sha1").update(refId).digest("hex").slice(0, 8);
  return `${symbolId}:${kind}:${hash8}`;
}

// 转义 LIKE 元字符 (% _ \) 给 ESCAPE '\\' 模式用 — 与 code-symbols 同款.
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---- CRUD ----

// 功能: 写入或覆盖单个 business link. INSERT OR REPLACE 走 PRIMARY KEY 冲突路径.
// 关注点: id 由 makeId 派生 (caller 可不传); UNIQUE(symbol_id, kind, ref_id) 是
//   兜底去重键. provenance NOT NULL 由 schema 兜底.
export function upsertBusinessLink(input: {
  symbol_id: string;
  kind: BusinessLinkKind;
  ref_kind: BusinessRefKind;
  ref_id: string;
  ref_alias?: string | null;
  provenance: BusinessLinkProvenance;
}): BusinessLink {
  const id = makeId(input.symbol_id, input.kind, input.ref_id);
  const row: BusinessLink = {
    id,
    symbol_id: input.symbol_id,
    kind: input.kind,
    ref_kind: input.ref_kind,
    ref_id: input.ref_id,
    ref_alias: input.ref_alias ?? null,
    provenance: input.provenance,
    created_at: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO code_business_links
         (id, symbol_id, kind, ref_kind, ref_id, ref_alias, provenance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.symbol_id,
      row.kind,
      row.ref_kind,
      row.ref_id,
      row.ref_alias,
      row.provenance,
      row.created_at
    );
  return row;
}

// 功能: 批量写入 — 给 import-business-links.ts 用 (JSDoc 一次性抽完整仓后灌).
// 关注点: 单事务包整批, 任一行 fail = 整批回滚. caller 负责事前校验 (含 provenance
//   是否合法 enum). 返回写入数 (与入参长度一致).
export function upsertBusinessLinks(
  links: Array<{
    symbol_id: string;
    kind: BusinessLinkKind;
    ref_kind: BusinessRefKind;
    ref_id: string;
    ref_alias?: string | null;
    provenance: BusinessLinkProvenance;
  }>
): number {
  if (links.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO code_business_links
       (id, symbol_id, kind, ref_kind, ref_id, ref_alias, provenance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const tx = db.transaction(
    (
      rows: Array<{
        symbol_id: string;
        kind: BusinessLinkKind;
        ref_kind: BusinessRefKind;
        ref_id: string;
        ref_alias?: string | null;
        provenance: BusinessLinkProvenance;
      }>
    ) => {
      for (const r of rows) {
        const id = makeId(r.symbol_id, r.kind, r.ref_id);
        stmt.run(
          id,
          r.symbol_id,
          r.kind,
          r.ref_kind,
          r.ref_id,
          r.ref_alias ?? null,
          r.provenance,
          now
        );
      }
    }
  );
  tx(links);
  return links.length;
}

// 功能: 按 symbol_id 取单个 symbol 的全部 link.
// 关注点: 按 kind ASC + ref_id ASC 排序, 渲染稳定. 含所有 provenance (UI 待审视图也查这里).
export function getBySymbol(symbolId: string): BusinessLink[] {
  return getDb()
    .prepare(
      `SELECT id, symbol_id, kind, ref_kind, ref_id, ref_alias, provenance, created_at
         FROM code_business_links WHERE symbol_id = ?
        ORDER BY kind ASC, ref_id ASC`
    )
    .all(symbolId) as BusinessLink[];
}

// 功能: 反向查询 — 给 (ref_kind, ref_id) 找所有实现它的代码. "找实现 R92 的代码" 主入口.
// 关注点: 默认含所有 provenance (UI 可加 provenance 过滤), join code_symbols 拿 file/line
//   给前端跳转. 按 created_at ASC 排序 (先建先看).
export function getByRef(
  refKind: BusinessRefKind,
  refId: string,
  options: { provenance?: BusinessLinkProvenance } = {}
): BusinessLinkHit[] {
  const where: string[] = ["bl.ref_kind = ?", "bl.ref_id = ?"];
  const params: any[] = [refKind, refId];
  if (options.provenance) {
    where.push("bl.provenance = ?");
    params.push(options.provenance);
  }
  return getDb()
    .prepare(
      `SELECT bl.id, bl.symbol_id, bl.kind, bl.ref_kind, bl.ref_id, bl.ref_alias,
              bl.provenance, bl.created_at,
              s.name AS symbol_name, s.file AS symbol_file, s.line AS symbol_line,
              s.kind AS symbol_kind
         FROM code_business_links bl
         JOIN code_symbols s ON s.id = bl.symbol_id
        WHERE ${where.join(" AND ")}
        ORDER BY bl.created_at ASC`
    )
    .all(...params) as BusinessLinkHit[];
}

// ---- search ----

interface SearchOpts {
  kind?: BusinessLinkKind | "@see-exclusive" | "@see-info";
  ref_kind?: BusinessRefKind;
  provenance?: BusinessLinkProvenance | BusinessLinkProvenance[];
  limit?: number;
}

// 功能: 字面搜 code_business_links. score = ref_id 命中 3 + ref_alias 命中 2 + kind 命中 1.
// 关注点:
//   - **静默过滤 provenance = 'llm_suggested'** (plan §5 约束 5: UI 待审入口才显示,
//     search 默认不该出现). 即使 caller 显式传 provenance = 'llm_suggested' 也照样过滤
//     (硬不变量; caller 想查待审 = 直接查表, 不过本函数).
//   - 不抛错 (catch → 返空).
//   - 默认 limit=20, 上限 50 (与 searchSymbols / searchKnowledge 对齐).
//   - LIKE 不区分大小写, 中文按字面 substring 命中.
//   - T4 round-8 D5 真修复: query 接受 string | string[] — 多 term 时按 term 数量
//     展开 OR-of-LIKE, 让双向扩展端到端生效. score 用首个 term 计算 (用户输入主词).
export function searchLinks(
  query: string | string[],
  options: SearchOpts = {}
): SearchResult[] {
  try {
    const terms = Array.isArray(query)
      ? query.map((t) => (t ?? "").trim()).filter(Boolean)
      : [(query ?? "").trim()].filter(Boolean);
    if (terms.length === 0) return [];
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const lower = terms[0].toLowerCase();

    const fieldOrPerTerm = (): string =>
      "(bl.ref_id LIKE ? ESCAPE '\\' OR bl.ref_alias LIKE ? ESCAPE '\\' OR bl.kind LIKE ? ESCAPE '\\')";
    const where: string[] = [
      terms.map(fieldOrPerTerm).join(" OR "),
      // 静默过滤 llm_suggested — 与 caller 选项无关, 硬不变量.
      "(bl.provenance IS NULL OR bl.provenance != 'llm_suggested')",
    ];
    const params: any[] = [];
    for (const t of terms) {
      const like = `%${escapeLike(t)}%`;
      params.push(like, like, like);
    }

    if (options.kind) {
      where.push("bl.kind = ?");
      params.push(options.kind);
    }
    if (options.ref_kind) {
      where.push("bl.ref_kind = ?");
      params.push(options.ref_kind);
    }
    if (options.provenance) {
      // 与硬过滤叠加: 显式传 provenance 时仍排除 llm_suggested (防 caller 误传绕过).
      const provList = Array.isArray(options.provenance)
        ? options.provenance
        : [options.provenance];
      const placeholders = provList.map(() => "?").join(",");
      where.push(`bl.provenance IN (${placeholders}) AND bl.provenance != 'llm_suggested'`);
      params.push(...provList);
    }

    const rows = getDb()
      .prepare(
        `SELECT bl.id, bl.symbol_id, bl.kind, bl.ref_kind, bl.ref_id, bl.ref_alias,
                bl.provenance, bl.created_at,
                s.id AS s_id, s.file AS s_file, s.line AS s_line, s.kind AS s_kind,
                s.name AS s_name, s.signature AS s_signature, s.docstring AS s_docstring,
                s.exported AS s_exported, s.indexed_at AS s_indexed_at, s.file_mtime AS s_file_mtime
           FROM code_business_links bl
           JOIN code_symbols s ON s.id = bl.symbol_id
          WHERE ${where.join(" AND ")}
          ORDER BY bl.created_at DESC LIMIT ?`
      )
      .all(...params, limit) as Array<
      BusinessLink & {
        s_id: string;
        s_file: string;
        s_line: number;
        s_kind: string;
        s_name: string;
        s_signature: string;
        s_docstring: string | null;
        s_exported: 0 | 1;
        s_indexed_at: string;
        s_file_mtime: string;
      }
    >;

    const results: SearchResult[] = rows.map((r) => {
      const inRefId = r.ref_id.toLowerCase().includes(lower);
      const inAlias = r.ref_alias ? r.ref_alias.toLowerCase().includes(lower) : false;
      const inKind = r.kind.toLowerCase().includes(lower);
      const score = (inRefId ? 3 : 0) + (inAlias ? 2 : 0) + (inKind ? 1 : 0);
      return {
        id: r.id,
        symbol_id: r.symbol_id,
        kind: r.kind,
        ref_kind: r.ref_kind,
        ref_id: r.ref_id,
        ref_alias: r.ref_alias,
        provenance: r.provenance,
        created_at: r.created_at,
        score,
        symbol: {
          id: r.s_id,
          file: r.s_file,
          line: r.s_line,
          kind: r.s_kind as CodeSymbolSearchResult["kind"],
          name: r.s_name,
          signature: r.s_signature,
          docstring: r.s_docstring,
          exported: r.s_exported,
          indexed_at: r.s_indexed_at,
          file_mtime: r.s_file_mtime,
          score,
        },
      };
    });
    results.sort((a, b) => b.score - a.score);
    return results;
  } catch {
    // 永不抛错 — caller 继续.
    return [];
  }
}

// 功能: 清空整表 — 全量重建前用 (scripts/reindex-business-links.sh 走全量).
// 关注点: 真 DELETE ALL, 不 TRUNCATE; FK CASCADE 不影响 code_symbols (方向反).
export function clearAll(): void {
  getDb().prepare("DELETE FROM code_business_links").run();
}

// 功能: 整表行数 + 按 provenance 统计 — 自检 / bootstrap 进度面板.
export function countAll(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM code_business_links")
    .get() as { n: number };
  return row.n;
}

export function countByProvenance(): Record<BusinessLinkProvenance, number> {
  const rows = getDb()
    .prepare(
      `SELECT provenance, COUNT(*) AS n FROM code_business_links GROUP BY provenance`
    )
    .all() as Array<{ provenance: BusinessLinkProvenance; n: number }>;
  const out: Record<string, number> = {
    jsdoc: 0,
    frontmatter: 0,
    llm_suggested: 0,
    manual_confirmed: 0,
    learned_md: 0,
    doc_extracted: 0,
  };
  for (const r of rows) out[r.provenance] = r.n;
  return out as Record<BusinessLinkProvenance, number>;
}

// 功能: 按 provenance 列行 — 给 UI 待审入口 (provenance='llm_suggested' 列表).
// 关注点: 不走 searchLinks (硬过滤掉); 这里显式列, 给 reviewer 看. 按 created_at DESC.
export function listByProvenance(
  provenance: BusinessLinkProvenance,
  limit = 100
): BusinessLinkHit[] {
  return getDb()
    .prepare(
      `SELECT bl.id, bl.symbol_id, bl.kind, bl.ref_kind, bl.ref_id, bl.ref_alias,
              bl.provenance, bl.created_at,
              s.name AS symbol_name, s.file AS symbol_file, s.line AS symbol_line,
              s.kind AS symbol_kind
         FROM code_business_links bl
         JOIN code_symbols s ON s.id = bl.symbol_id
        WHERE bl.provenance = ?
        ORDER BY bl.created_at DESC LIMIT ?`
    )
    .all(provenance, limit) as BusinessLinkHit[];
}