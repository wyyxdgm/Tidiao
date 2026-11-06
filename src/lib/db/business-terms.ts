// business-terms — Code Knowledge Index L2 术语映射 (飞书 R92 第二阶段, T3).
//
// 设计要点:
//   - 单一入口操作 business_terms 表 (v127 migration).
//   - damo_term UNIQUE 是主键; canonical = 平台概念名; aliases = 逗号分隔的其他叫法.
//   - expandQuery() 双向扩展 (D5 拍板 "全开"): rawQuery = "派单" → "(dispatch task | 派发 | 分发任务)"
//     让 SQLite LIKE 检索自动跨变体命中. 入口供 searchKnowledge() 在所有 source 前跑.
//   - loadFromText() 解析 markdown 表格行, 给 scripts/load-terminology.ts + 测试 fixture 用.
//   - listTerms() 给前端术语表 + damo 自查.
//
// 关注点:
//   - expandQuery 不抛错 (catch → 返原 query); 永不阻断 caller.
//   - expandQuery 只替换能精确匹配的 damo_term / alias (不做 fuzzy, 防过匹配).
//     例: raw "派单" 命中 (damo_term=派单, aliases="分发任务,派发,dispatch") → 扩展;
//         raw "派单子" 不命中 (派单 != 派单子) → 不扩展, 原样透传.
//   - LIKE 兜底: 原 query 永远保留在结果里 (防术语表没覆盖时 0 命中).
//   - 改术语改 docs/learned/terminology.md (D2 拍板: md 是单源真理, DB 是运行时索引).

import { getDb } from "./index";

export type BusinessTerm = {
  id: string;
  damo_term: string;
  canonical: string;
  aliases: string | null;
  domain: string | null;
  notes: string | null;
  created_at: string;
};

// ---- CRUD ----

// 功能: 写入或覆盖单个 business term (按 damo_term UNIQUE 判重).
// 关注点: id 由 caller 派生 (md 解析时可走 "<damo_term>:<sha1>" 稳定 hash), 这里接
//   直接传 id 的形式; 也接受不传 id (随机生成) 的 lazy 入口.
export function upsertTerm(input: {
  damo_term: string;
  canonical: string;
  aliases?: string | null;
  domain?: string | null;
  notes?: string | null;
  id?: string;
}): BusinessTerm {
  const id =
    input.id ??
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require("node:crypto") as typeof import("node:crypto"))
      .createHash("sha1")
      .update(input.damo_term)
      .digest("hex")
      .slice(0, 16);
  const row: BusinessTerm = {
    id,
    damo_term: input.damo_term,
    canonical: input.canonical,
    aliases: input.aliases ?? null,
    domain: input.domain ?? null,
    notes: input.notes ?? null,
    created_at: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO business_terms
         (id, damo_term, canonical, aliases, domain, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.damo_term,
      row.canonical,
      row.aliases,
      row.domain,
      row.notes,
      row.created_at
    );
  return row;
}

// 功能: 批量 upsert (md → DB).
// 关注点: 单事务包整批.
export function upsertTerms(
  terms: Array<{
    damo_term: string;
    canonical: string;
    aliases?: string | null;
    domain?: string | null;
    notes?: string | null;
    id?: string;
  }>
): number {
  if (terms.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO business_terms
       (id, damo_term, canonical, aliases, domain, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const t of terms) {
      const id =
        t.id ??
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        (require("node:crypto") as typeof import("node:crypto"))
          .createHash("sha1")
          .update(t.damo_term)
          .digest("hex")
          .slice(0, 16);
      stmt.run(id, t.damo_term, t.canonical, t.aliases ?? null, t.domain ?? null, t.notes ?? null, now);
    }
  })();
  return terms.length;
}

// 功能: 按 damo_term 单查 (精确匹配); 给 expandQuery / UI 反查用.
export function getByDamoTerm(damoTerm: string): BusinessTerm | null {
  const row = getDb()
    .prepare(
      `SELECT id, damo_term, canonical, aliases, domain, notes, created_at
         FROM business_terms WHERE damo_term = ?`
    )
    .get(damoTerm) as BusinessTerm | undefined;
  return row ?? null;
}

// 功能: 列全部术语 (按 damo_term ASC, UI 列表用).
// 关注点: 不分页 (术语表 < 100 行, 全量返即可).
export function listTerms(): BusinessTerm[] {
  return getDb()
    .prepare(
      `SELECT id, damo_term, canonical, aliases, domain, notes, created_at
         FROM business_terms ORDER BY damo_term ASC`
    )
    .all() as BusinessTerm[];
}

// 功能: 整表行数 (自检 / 验收用).
export function countAll(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM business_terms")
    .get() as { n: number };
  return row.n;
}

// ---- expandQuery (D5 = 全开双向扩展) ----

/**
 * 把 damo 口语 query 双向扩展为 OR 字符串, 给 SQLite LIKE 检索用.
 *   例子: "派单" → "(派单 | dispatch task | 派发 | 分发任务)"
 *
 * 注意 (T4 round-8 修复): 该函数返回的是"展示串", 直接喂 SQLite LIKE 会因 `|`
 *   字符导致 0 命中 (数据库字段里没有 `|` 字面). T4 之前调用方 searchKnowledge
 *   就是这么用的 → D5 双向扩展从未端到端生效. 修复方案 = 新增
 *   `expandQueryTerms()` 返回 string[] 数组, 配合各 LIKE 源做 OR-of-LIKE 拼接.
 *   本函数保留向后兼容 (旧测试断言 toContain) + 供 logging/UI 展示用.
 *
 * @requirement 飞书 R92
 * @feature knowledge-recall
 * @module knowledge
 * @see-exclusive src/lib/db/business-terms.ts:170 getByDamoTerm
 * @see-info docs/learned/terminology.md
 */
export function expandQuery(rawQuery: string): string {
  try {
    const q = (rawQuery ?? "").trim();
    if (!q) return q;
    // 短词不扩展 — 防止单字符 LIKE 把全部术语拼进去
    if (q.length < 2) return q;

    // 多词 query 不扩展 (扩展只在 1:1 词级生效; 多词 LIKE 本身够用).
    // 例: "派单 task" 不扩展, 让原词直接走 LIKE.
    if (/\s/.test(q)) return q;

    const term = resolveTerm(q);
    if (!term) return q;
    return buildDisplayString(q, term);
  } catch {
    // 永不抛错 — caller 继续 (原样透传)
    return rawQuery ?? "";
  }
}

/**
 * 双向扩展为 term 数组 — T4 round-8 D5 真修复的主入口.
 *   "派单" → ["派单", "dispatch task", "分发任务", "派发", "dispatch"]
 *   "过卡" → ["过卡", "deploy approval", "部署审批", "通过审批", "deploy-approval"]
 *   "派单 task" (含空格) → ["派单 task"]   不扩展, LIKE 直接按原串
 *   "" → [""]
 *   "绝对不存在" → ["绝对不存在"]   兜底原样透传
 *
 * 各 LIKE 源用本数组构建 "title LIKE ? OR title LIKE ? OR ..." 多 OR 子句,
 *   让 SQLite 真正跨变体命中. embed() 输入取数组首项 (= 原 query) 保证语义质量.
 */
export function expandQueryTerms(rawQuery: string): string[] {
  try {
    const q = (rawQuery ?? "").trim();
    if (!q) return [""];
    // 短词 / 多词 / 未命中术语 都不扩展, 单元素数组兜底
    if (q.length < 2) return [q];
    if (/\s/.test(q)) return [q];

    const term = resolveTerm(q);
    if (!term) return [q];
    return buildTermList(q, term);
  } catch {
    return [rawQuery ?? ""];
  }
}

// ---- 内部工具 ----

// 功能: 解析 raw query → 命中的 BusinessTerm (damo_term 精确 OR alias 命中).
function resolveTerm(q: string): BusinessTerm | null {
  const direct = getByDamoTerm(q);
  if (direct) return direct;
  // 命中 alias 也算 — 遍历一遍术语表
  const all = listTerms();
  for (const t of all) {
    if (!t.aliases) continue;
    const aliasList = t.aliases
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (aliasList.includes(q)) return t;
  }
  return null;
}

// 功能: 收集所有要参与 LIKE / embed 的词项, 去重保序 (原 query 在最前).
function buildTermList(raw: string, term: BusinessTerm): string[] {
  const parts: string[] = [raw];
  if (term.canonical && term.canonical !== raw) parts.push(term.canonical);
  if (term.aliases) {
    for (const a of term.aliases.split(",")) {
      const trimmed = a.trim();
      if (trimmed && trimmed !== raw) parts.push(trimmed);
    }
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  return unique;
}

// 功能: 拼展示串 (旧 expandQuery 兼容路径 + logging/UI 用).
function buildDisplayString(raw: string, term: BusinessTerm): string {
  return `(${buildTermList(raw, term).join(" | ")})`;
}

// ---- md 解析 (供 scripts/load-terminology.ts + 测试 fixture) ----

// 功能: 解析 markdown 表格行 — 抽 damo_term / canonical / aliases / domain / notes.
//   期望格式: `| <damo_term> | <canonical> | <aliases> | <domain> | <notes> |`
//   注: 仅抽列, 不依赖表头 (header 校验 caller 负责).
// 关注点:
//   - 跳过空行 / 分隔行 (|---|---|...) / 含 `damo_term` 表头关键字的行.
//   - aliases 列空字符串 → null.
//   - 解析失败抛 Error (caller 是 load-terminology.ts, 必须 fail-fast 让用户看见
//     md 格式错; expandQuery 等运行时路径不调本函数, 不污染).
export function parseTermRow(line: string): {
  damo_term: string;
  canonical: string;
  aliases: string | null;
  domain: string | null;
  notes: string | null;
} | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // 跳分隔行 (---)
  if (/^\|?[\s-:|]+\|?$/.test(trimmed)) return null;
  // 跳 md 标题 (# / ##)
  if (/^#{1,6}\s/.test(trimmed)) return null;
  // 跳 frontmatter (--- 单行)
  if (/^---+\s*$/.test(trimmed)) return null;
  // 跳 md 引用块 (> 开头)
  if (/^>/.test(trimmed)) return null;
  // 跳表头 (含 "damo_term" 字面)
  if (trimmed.toLowerCase().includes("damo_term")) return null;

  // 拆 "|" 分隔的列
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

  if (cells.length < 2) {
    throw new Error(`terminology.md 行格式错 (列数 < 2): ${line}`);
  }
  const [damo_term, canonical, aliases = "", domain = "", notes = ""] = cells;
  if (!damo_term || !canonical) {
    throw new Error(`terminology.md 行格式错 (damo_term / canonical 空): ${line}`);
  }
  return {
    damo_term,
    canonical,
    aliases: aliases || null,
    domain: domain || null,
    notes: notes || null,
  };
}

// 功能: 把整个 markdown 文本解析成 term 数组 (一行一 term).
// 关注点: 跳过 frontmatter / 空行 / 分隔行 / 表头.
export function parseTerminologyMd(md: string): Array<{
  damo_term: string;
  canonical: string;
  aliases: string | null;
  domain: string | null;
  notes: string | null;
}> {
  const out: Array<{
    damo_term: string;
    canonical: string;
    aliases: string | null;
    domain: string | null;
    notes: string | null;
  }> = [];
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    try {
      const row = parseTermRow(line);
      if (row) out.push(row);
    } catch (e) {
      // re-throw 加行号
      throw new Error(`terminology.md 解析失败: ${(e as Error).message}`);
    }
  }
  return out;
}