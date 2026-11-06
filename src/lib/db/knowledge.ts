// knowledge 模块 —— 单任务执行期的跨源知识检索 (飞书 R92, 2026-09-06 拍板).
//
// 设计要点:
//   - 单一入口 searchKnowledge(query, userId, opts) 并发跑 4 个源:
//     ① tasks              —— 平台 task title/prompt/result LIKE
//     ② requirements       —— in_app 需求点 (v64) LIKE
//     ③ requirement_cache  —— 飞书需求点镜像 (v73 新表) LIKE
//     ④ docs               —— 项目 cwd 内 .md 文件 fs 读 + substring
//   - 多租户硬隔离: 所有 SQL 走 owner_id 过滤; docs 走 getProjectById(userId) 拿到的项目列表.
//   - 永不抛错: 任一源失败 = 该源空结果 + warn 日志, 不影响其他源.
//   - 高亮: snippet 里出现 query 词时包 <mark>...</mark>, 前端拿到再决定是否渲染.
//   - relevance 评分: title 命中 = 3, snippet 命中 = 1, 总分降序.
//
// 关注点:
//   - LIKE 转义: user query 里的 % / _ 必须前置 ESCAPE 转义, 否则 q="100%" 会通配.
//     SQLite 默认 LIKE 不区分大小写 (ASCII only); 中文检索按字面 substring 也够用.
//   - 飞书 source 由 cache 表的 sheet_url + sheet_name 提供, 命中行附 version 信息供前端跳转.
//   - docs 走 fs 读, 限制文件大小 (≤ 256 KiB, 单文件超限静默跳过, 与 wiki-files 的 1 MiB 一致思想).
//   - "score" 仅在同一源内排序, 不跨源比较 (跨源不可比: doc 命中与 task 命中语义不同).
//     searchKnowledge 最终按 source 固定优先级: tasks > in_app > cache > docs (R92 拍板).

import { getDb } from "./index";
import { listProjects } from "./projects";
import { getVersionById } from "./versions";
import { getProjectById } from "./projects";
import { searchSymbols, type SearchResult as CodeSymbolResult } from "./code-symbols";
import { searchLinks, type SearchResult as BusinessLinkResult } from "./code-business-links";
import { searchByVector, type EmbeddingSearchResult } from "./code-embeddings";
import { expandQueryTerms } from "./business-terms";
import { embed } from "../embeddings/bge-small";
import fs from "fs";
import path from "path";

// ---- 类型 ----

export type KnowledgeSource =
  | "tasks"
  | "requirements"
  | "requirement_cache"
  | "docs"
  | "symbols"
  | "links"
  | "embeddings";

// 源固定排序 (plan §3.2.3 + T4 拍板): 代码字面 > 业务标签 > 语义近似.
//   symbols > links > requirements > tasks > requirement_cache > docs > embeddings.
// embeddings 排最后: score > 0.7 过滤后量少 + 易飘, 仅作模糊搜补充.
export const SOURCE_ORDER: KnowledgeSource[] = [
  "symbols",
  "links",
  "requirements",
  "tasks",
  "requirement_cache",
  "docs",
  "embeddings",
];

export interface KnowledgeHitBase {
  source: KnowledgeSource;
  id: string;
  title: string;
  snippet: string;        // 含 query 的上下文片段, 已带 <mark> 高亮
  score: number;          // 源内评分: title 命中=3, 其它命中=1
  url?: string;           // 前端跳转链接 (task 详情 / requirement 详情 / wiki 路径)
  meta?: Record<string, string | number | null>; // 源相关的附注 (status / updated_at / sheet_url)
}

export interface SearchKnowledgeInput {
  query: string;
  project_id?: string;        // 单项目限定; 不传 = 搜 user 全部可见项目
  sources?: KnowledgeSource[]; // 子集; 不传 = 4 个源全跑
  limit_per_source?: number;  // 默认 20, max 50
}

export interface SearchKnowledgeResult {
  query: string;
  total_hits: number;
  by_source: Record<KnowledgeSource, KnowledgeHitBase[]>;
  warnings: string[];         // 源失败记录, 前端可见 (但接口仍 200)
}

// ---- 工具 ----

// 转义 user query 里的 LIKE 元字符 (% _ \), 给 ESCAPE '\\' 模式用.
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// 把 substring 包 <mark>...</mark>; 大小写不敏感保留原文大小写 (replacement 来自原串).
function highlight(text: string, query: string, maxLen = 200): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) {
    // query 不在 text 里 —— 截断返回 (理论上不会, 命中了 LIKE 必然在 text)
    return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
  }
  // 围绕首个命中切 ±60 字符, 给上下文
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + q.length + 60);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  const matched = text.slice(idx, idx + q.length);
  const before = text.slice(start, idx);
  const after = text.slice(idx + q.length, end);
  return `${prefix}${before}<mark>${matched}</mark>${after}${suffix}`;
}

// 给 docs 命中生成 wiki URL (project:{UUID}?path=...) 用到的相对路径.
// 注意: 走绝对路径 -> 相对 cwd, 不做 URL 编码 (前端会做).
function makeDocsUrl(projectId: string, absPath: string, projectCwd: string): string {
  const rel = path.relative(projectCwd, absPath);
  return `/wiki?project=${projectId}&path=${rel}`;
}

// ---- 源 1: tasks ----

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  prompt: string | null;
  result: string | null;
  error: string | null;
  status: string;
  updated_at: string;
  project_id: string | null;
}

function searchTasksByQuery(
  terms: string[],
  userId: string,
  projectId: string | undefined,
  limit: number
): { hits: KnowledgeHitBase[]; warning?: string } {
  try {
    const db = getDb();
    // D5: 每个 term 都参与 LIKE (OR 拼接) → 跨变体命中.
    // 5 字段 × N terms 的 OR 矩阵; 每个 term 对应 5 个 `?`, 都喂同一个 like.
    const fieldOr = terms
      .map(() => "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const where: string[] = [
      "owner_id = ?",
      "deleted_at IS NULL",
      fieldOr,
    ];
    const params: any[] = [userId];
    for (const t of terms) {
      const like = `%${escapeLike(t)}%`;
      params.push(like, like, like, like, like);
    }
    if (projectId) {
      where.push("project_id = ?");
      params.push(projectId);
    }
    const rows = db
      .prepare(
        `SELECT id, title, description, prompt, result, error, status, updated_at, project_id
         FROM tasks WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...params, limit) as TaskRow[];

    const hits: KnowledgeHitBase[] = rows.map((r) => {
      // 评分 + snippet 选最优字段 (用首个 term 作为主 query, 命中评分)
      const lower = terms[0]?.toLowerCase() ?? "";
      const inTitle = r.title.toLowerCase().includes(lower);
      const inDesc = r.description?.toLowerCase().includes(lower) ?? false;
      const inPrompt = r.prompt?.toLowerCase().includes(lower) ?? false;
      const inResult = r.result?.toLowerCase().includes(lower) ?? false;
      const inError = r.error?.toLowerCase().includes(lower) ?? false;
      const score =
        (inTitle ? 3 : 0) +
        (inDesc || inPrompt || inResult || inError ? 1 : 0);
      const source = inResult ? r.result : inPrompt ? r.prompt : inError ? r.error : inDesc ? r.description ?? "" : r.title;
      return {
        source: "tasks",
        id: r.id,
        title: r.title,
        snippet: highlight(source ?? "", terms[0] ?? ""),
        score,
        // SPA hash 路由深链 (旧壳无 /projects/[pid]/tasks 路由, 统一走 /#/tasks/)
        url: `/#/tasks/${r.id}`,
        meta: { status: r.status, updated_at: r.updated_at },
      };
    });
    // 源内按 score desc, 然后 updated_at desc
    hits.sort((a, b) => b.score - a.score || String(b.meta?.updated_at ?? "").localeCompare(String(a.meta?.updated_at ?? "")));
    return { hits };
  } catch (e) {
    return { hits: [], warning: `tasks 源失败: ${(e as Error).message}` };
  }
}

// ---- 源 2: in_app requirements (v64) ----

interface ReqRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number | null;
  project_id: string;
  updated_at: string;
  version_id: string | null;
}

function searchInAppRequirementsByQuery(
  terms: string[],
  userId: string,
  projectId: string | undefined,
  limit: number
): { hits: KnowledgeHitBase[]; warning?: string } {
  try {
    const db = getDb();
    const fieldOr = terms
      .map(() => "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const where: string[] = [
      "owner_id = ?",
      "status != 'closed'",
      fieldOr,
    ];
    const params: any[] = [userId];
    for (const t of terms) {
      const like = `%${escapeLike(t)}%`;
      params.push(like, like);
    }
    if (projectId) {
      where.push("project_id = ?");
      params.push(projectId);
    }
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, project_id, updated_at, version_id
         FROM requirements WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...params, limit) as ReqRow[];

    const lower = terms[0]?.toLowerCase() ?? "";
    const hits: KnowledgeHitBase[] = rows.map((r) => {
      const inTitle = r.title.toLowerCase().includes(lower);
      const inDesc = r.description?.toLowerCase().includes(lower) ?? false;
      const score = (inTitle ? 3 : 0) + (inDesc ? 1 : 0);
      const source = inDesc ? r.description ?? "" : r.title;
      return {
        source: "requirements",
        id: r.id,
        title: r.title,
        snippet: highlight(source, terms[0] ?? ""),
        score,
        url: `/projects/${r.project_id}/requirements/${r.id}`,
        meta: { status: r.status, priority: r.priority ?? null, updated_at: r.updated_at },
      };
    });
    hits.sort((a, b) => b.score - a.score || String(b.meta?.updated_at ?? "").localeCompare(String(a.meta?.updated_at ?? "")));
    return { hits };
  } catch (e) {
    return { hits: [], warning: `requirements 源失败: ${(e as Error).message}` };
  }
}

// ---- 源 3: requirement_cache (v73, 飞书镜像) ----

interface CacheRow {
  id: string;
  sheet_url: string;
  sheet_name: string;
  row_number: number;
  requirement_id: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  priority: number | null;
  version_id: string;
  fetched_at: string;
  fetch_error: string | null;
}

function searchCachedRequirementsByQuery(
  terms: string[],
  userId: string,
  projectId: string | undefined,
  limit: number
): { hits: KnowledgeHitBase[]; warning?: string } {
  try {
    const db = getDb();
    const fieldOr = terms
      .map(() => "(rc.title LIKE ? ESCAPE '\\' OR rc.description LIKE ? ESCAPE '\\' OR rc.raw_row LIKE ? ESCAPE '\\')")
      .join(" OR ");
    // 飞书镜像无 owner_id 列; 靠 versions.project_id -> projects.owner_id 关联做隔离.
    // LEFT JOIN: 没关联到 version / project 时整行丢, 防越权 (项目被硬删时 cache 还在).
    const where: string[] = [
      "p.owner_id = ?",
      "p.deleted_at IS NULL",
      "v.deleted_at IS NULL",
      "rc.fetch_error IS NULL",
      fieldOr,
    ];
    const params: any[] = [userId];
    for (const t of terms) {
      const like = `%${escapeLike(t)}%`;
      params.push(like, like, like);
    }
    if (projectId) {
      where.push("p.id = ?");
      params.push(projectId);
    }
    const rows = db
      .prepare(
        `SELECT rc.id, rc.sheet_url, rc.sheet_name, rc.row_number, rc.requirement_id,
                rc.title, rc.description, rc.status, rc.priority,
                rc.version_id, rc.fetched_at, rc.fetch_error
         FROM requirement_cache rc
         JOIN versions v ON v.id = rc.version_id
         JOIN projects p ON p.id = v.project_id
         WHERE ${where.join(" AND ")}
         ORDER BY rc.fetched_at DESC LIMIT ?`
      )
      .all(...params, limit) as CacheRow[];

    const lower = terms[0]?.toLowerCase() ?? "";
    const hits: KnowledgeHitBase[] = rows.map((r) => {
      const inTitle = r.title?.toLowerCase().includes(lower) ?? false;
      const inDesc = r.description?.toLowerCase().includes(lower) ?? false;
      const score = (inTitle ? 3 : 0) + (inDesc ? 1 : 0);
      const source = inDesc ? r.description ?? "" : r.title ?? "(无标题)";
      return {
        source: "requirement_cache",
        id: r.id,
        title: r.title ?? `R${r.row_number}`,
        snippet: highlight(source, terms[0] ?? ""),
        score,
        url: r.requirement_id
          ? `/projects/${projectId ?? ""}/requirements/${r.requirement_id}`
          : r.sheet_url, // 没 requirement_id 时给 sheet URL (无法直跳)
        meta: {
          sheet_url: r.sheet_url,
          sheet_name: r.sheet_name,
          row_number: r.row_number,
          status: r.status ?? "",
          priority: r.priority ?? null,
          fetched_at: r.fetched_at,
        },
      };
    });
    hits.sort((a, b) => b.score - a.score);
    return { hits };
  } catch (e) {
    return { hits: [], warning: `requirement_cache 源失败: ${(e as Error).message}` };
  }
}

// ---- 源 4: 项目 cwd 内 .md 文档 (fs substring) ----

const MAX_DOC_BYTES = 256 * 1024; // 256 KiB 单文件上限
const DOC_GLOB_EXTS = new Set(["md"]); // 仅 .md, 与 wiki 默认行为一致

function searchDocsInProject(
  terms: string[],
  userId: string,
  projectId: string | undefined,
  limit: number
): { hits: KnowledgeHitBase[]; warning?: string } {
  try {
    // 列出 user 的可见项目 (软删排除)
    const projects = projectId
      ? (() => {
          const p = getProjectById(projectId, userId);
          return p ? [p] : [];
        })()
      : listProjects(userId);

    // D5: 任意 term 命中即算 (OR 语义); 首个 term 作为 highlight/scoring 主词.
    const lowers = terms.map((t) => t.toLowerCase());
    const primaryLower = lowers[0] ?? "";
    const primaryQuery = terms[0] ?? "";

    const hits: KnowledgeHitBase[] = [];
    const seenAbs = new Set<string>(); // 防 symlink 循环

    for (const p of projects) {
      if (!p.cwd) continue; // 没 cwd 的项目 (e.g. 历史未归类) 跳过
      const cwd = p.cwd;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(cwd);
      } catch {
        continue; // cwd 不存在 = 跳过 (Mac/Win/pulu 路径差异常见)
      }
      if (!stat.isDirectory()) continue;

      // 简易 walk: 跳过隐藏目录 + node_modules + .git, 限制深度 5
      const walk = (dir: string, depth: number): void => {
        if (depth > 5) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (seenAbs.has(full)) continue;
          if (ent.name.startsWith(".")) continue; // 隐藏段
          if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".next") continue;
          if (ent.isDirectory()) {
            walk(full, depth + 1);
          } else if (ent.isFile() && DOC_GLOB_EXTS.has(path.extname(ent.name).slice(1).toLowerCase())) {
            seenAbs.add(full);
            let buf: Buffer;
            try {
              buf = fs.readFileSync(full);
            } catch {
              continue;
            }
            if (buf.byteLength > MAX_DOC_BYTES) continue;
            const content = buf.toString("utf8");
            const contentLower = content.toLowerCase();
            // 任意 term 命中 → 算 hit; 记首个命中的 idx 用于 highlight 锚点.
            let firstIdx = -1;
            for (const lower of lowers) {
              const idx = contentLower.indexOf(lower);
              if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
            }
            if (firstIdx < 0) continue;
            // 用文件首行非空作为 title (fallback 文件名)
            const firstNonEmpty = content.split("\n").find((l) => l.trim().length > 0) ?? ent.name;
            const title = firstNonEmpty.replace(/^#+\s*/, "").slice(0, 80);
            const inTitle = lowers.some((l) => title.toLowerCase().includes(l));
            const score = (inTitle ? 3 : 0) + 1;
            // 选 score 时, 也用 primaryLower 优先命中 title, 但 snippet highlight 走 primaryQuery.
            hits.push({
              source: "docs",
              id: full,
              title,
              snippet: highlight(content, primaryQuery),
              score,
              url: makeDocsUrl(p.id, full, cwd),
              meta: { project_id: p.id, size_bytes: buf.byteLength },
            });
          }
        }
      };
      try {
        walk(cwd, 0);
      } catch {
        // 跳过该项目 (e.g. permission denied)
        continue;
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, limit) };
  } catch (e) {
    return { hits: [], warning: `docs 源失败: ${(e as Error).message}` };
  }
}

// ---- 源 5: code symbols (L1 AST 索引层, T2) ----

interface SymbolOpts {
  kind?: "function" | "class" | "interface" | "type" | "const" | "default";
  exported?: boolean;
}

function searchCodeSymbols(
  terms: string[],
  opts: SymbolOpts,
  limit: number
): { hits: KnowledgeHitBase[]; warning?: string } {
  try {
    const rows = searchSymbols(terms, {
      kind: opts.kind,
      exported: opts.exported,
      limit,
    });
    const hits: KnowledgeHitBase[] = (rows as CodeSymbolResult[]).map((r) => {
      // snippet 用 signature (200 字内的真签名) + docstring 头 — 让前端能渲染"在哪"
      const doc = r.docstring ? ` — ${r.docstring}` : "";
      const snippet = `${r.signature}${doc}`;
      return {
        source: "symbols",
        id: r.id,
        title: r.name,
        snippet,
        score: r.score,
        // wiki URL — 用项目 UUID 渲染 file:line, 让前端可点跳转.
        meta: {
          file: r.file,
          line: r.line,
          kind: r.kind,
          exported: r.exported,
          file_mtime: r.file_mtime,
        },
      };
    });
    return { hits };
  } catch (e) {
    return { hits: [], warning: `symbols 源失败: ${(e as Error).message}` };
  }
}

// ---- 源 6: code business links (L2 业务衔接层, T3) ----

// 功能: 搜 code_business_links + join code_symbols. 静默过滤 llm_suggested.
// 关注点:
//   - 用 expandQuery 后的 query (上层 searchKnowledge 已做) — 让 "派单" / "dispatch task"
//     都能命中 (D5 双向扩展).
//   - 命中行带 @feature / @requirement / @module 等标签语义, 前端按 ref_kind 渲染.
//   - 每个 hit 必带 file:line (通过 join 拿到 symbol) — 满足 §5 约束 1.
function searchCodeBusinessLinks(
  terms: string[],
  limit: number
): { hits: KnowledgeHitBase[]; warning?: string } {
  try {
    const rows = searchLinks(terms, { limit });
    const hits: KnowledgeHitBase[] = (rows as BusinessLinkResult[]).map((r) => {
      const refLabel = r.ref_alias ? ` (${r.ref_alias})` : "";
      const snippet = `${r.kind} ${r.ref_kind}: ${r.ref_id}${refLabel} — ${r.symbol.name} @ ${r.symbol.file}:${r.symbol.line}`;
      return {
        source: "links",
        id: r.id,
        title: `${r.symbol.name} → ${r.ref_id}`,
        snippet,
        score: r.score,
        meta: {
          symbol_id: r.symbol_id,
          file: r.symbol.file,
          line: r.symbol.line,
          kind: r.symbol.kind,
          ref_kind: r.ref_kind,
          ref_id: r.ref_id,
          link_kind: r.kind,
          provenance: r.provenance,
        },
      };
    });
    return { hits };
  } catch (e) {
    return { hits: [], warning: `links 源失败: ${(e as Error).message}` };
  }
}

// ---- 源 7: code embeddings (L3 向量层, T4) ----

/**
 * 跑 bge-small embedding → cosine similarity 搜 code_embeddings 表.
 *   threshold = 0.7 (plan §5 约束 2), 低于静默丢 (不显示 = 不误导).
 *   永不抛错 (catch → 返空 + warning), embed 失败 / DB 失败都兜底.
 *
 * 关注点:
 *   - T4 round-8: embed 输入取 terms[0] (rawQuery), 不用展示串
 *     "(派单 | ...)" — 短清晰的中/英文原文语义质量最高, 避免 bge-small 在长
 *     串 + `|` 噪声下退化.
 *   - 每 hit 必带 file:line (chunk_text 第一行抽 file); line=0 = 整文件 chunk.
 *   - embeddings 源在 SOURCE_ORDER 排最末; 命中量少但提供"代码里出现过这词"的语义近似.
 *   - async 因 embed() 是 async (transformers.js 模型推理); searchKnowledge 改 async.
 */
async function searchCodeEmbeddings(
  terms: string[],
  limit: number
): Promise<{ hits: KnowledgeHitBase[]; warning?: string }> {
  try {
    // T4 round-8 D5 修复: 用 rawQuery (= terms[0]) 而非展示串喂模型.
    const queryVec = await embed(terms[0] ?? "");
    if (queryVec.length === 0) return { hits: [] }; // 模型未就位, 静默跳过 (warning 太噪)
    const rows = searchByVector(queryVec, { limit, threshold: 0.7 });
    const hits: KnowledgeHitBase[] = rows.map((r: EmbeddingSearchResult) => {
      const snippet = r.chunk_text.length > 200
        ? r.chunk_text.slice(0, 200) + "..."
        : r.chunk_text;
      return {
        source: "embeddings",
        id: r.id,
        title: r.file, // file:line 不强制 title, 用 file 做 title 也可
        snippet,
        score: r.score, // cosine 0.7~1.0
        meta: {
          file: r.file,
          line: r.line,
          score: r.score, // 冗余: UI 可单独展示 cosine 分数
        },
      };
    });
    return { hits };
  } catch (e) {
    return { hits: [], warning: `embeddings 源失败: ${(e as Error).message}` };
  }
}

// ---- 主入口 ----

/**
 * 跨源并发检索, 返回每个源的命中 + 汇总. 永不抛错.
 *
 * T4 改造: 改 async 因 embeddings 源需 await embed(). 同步源维持
 *   同步实现, await 包一下语义不变. caller (route.ts) 已改 await.
 *
 * @requirement 飞书 R92
 * @feature knowledge-recall
 * @module knowledge
 * @see-info scripts/ao-recall.sh
 * @see-info docs/usage/09-wiki.md §ao recall
 */
export async function searchKnowledge(
  input: SearchKnowledgeInput,
  userId: string
): Promise<SearchKnowledgeResult> {
  const rawQuery = (input.query ?? "").trim();
  const limit = Math.min(50, Math.max(1, input.limit_per_source ?? 20));
  const sources = input.sources ?? [
    "tasks",
    "requirements",
    "requirement_cache",
    "docs",
    "symbols",
    "links",
    "embeddings",
  ];
  const warnings: string[] = [];

  // 空 query = 返空 (前端应做非空校验, 这里兜底)
  if (!rawQuery) {
    return {
      query: "",
      total_hits: 0,
      by_source: {
        tasks: [],
        requirements: [],
        requirement_cache: [],
        docs: [],
        symbols: [],
        links: [],
        embeddings: [],
      },
      warnings: ["query 不能为空"],
    };
  }

  // D5 双向扩展: 把 "派单" 自动展成 ["派单", "dispatch task", "分发任务", "派发", "dispatch"].
  // 透传给 SQLite LIKE 检索 — 各源按 term 数量展开 OR-of-LIKE.
  // 短词 (<2 字符) / 多词 不扩展 (由 expandQueryTerms 内判断), 原样 [query] 透传.
  const terms = expandQueryTerms(rawQuery);
  // 兼容展示: API response.query 仍返展示串 "(派单 | ...)", 给 UI 回显 D5 命中提示.
  const query = terms.length > 1 ? `(${terms.join(" | ")})` : (terms[0] ?? "");

  const all: Record<KnowledgeSource, KnowledgeHitBase[]> = {
    tasks: [],
    requirements: [],
    requirement_cache: [],
    docs: [],
    symbols: [],
    links: [],
    embeddings: [],
  };

  // 7 源顺序跑 (R92 拍板 + T2/T3/T4 加 symbols/links/embeddings).
  // 不真并发: 各自很快, 真并发会撞 SQLite 锁和 fs 句柄复杂度, 不值得.
  if (sources.includes("tasks")) {
    const r = searchTasksByQuery(terms, userId, input.project_id, limit);
    all.tasks = r.hits;
    if (r.warning) warnings.push(r.warning);
  }
  if (sources.includes("requirements")) {
    const r = searchInAppRequirementsByQuery(terms, userId, input.project_id, limit);
    all.requirements = r.hits;
    if (r.warning) warnings.push(r.warning);
  }
  if (sources.includes("requirement_cache")) {
    const r = searchCachedRequirementsByQuery(terms, userId, input.project_id, limit);
    all.requirement_cache = r.hits;
    if (r.warning) warnings.push(r.warning);
  }
  if (sources.includes("docs")) {
    const r = searchDocsInProject(terms, userId, input.project_id, limit);
    all.docs = r.hits;
    if (r.warning) warnings.push(r.warning);
  }
  if (sources.includes("symbols")) {
    // symbols 源不接受 project_id (跨项目全局索引, T2 简化); kind/exported 子过滤
    // 由 input.symbols_opts (未来扩展) 传入, 本 T2 用空 opts.
    const r = searchCodeSymbols(terms, {}, limit);
    all.symbols = r.hits;
    if (r.warning) warnings.push(r.warning);
  }
  if (sources.includes("links")) {
    const r = searchCodeBusinessLinks(terms, limit);
    all.links = r.hits;
    if (r.warning) warnings.push(r.warning);
  }
  if (sources.includes("embeddings")) {
    // T4: 异步跑 (embed 是 async). errors 落到 warnings, 不阻断其他源.
    try {
      const r = await searchCodeEmbeddings(terms, limit);
      all.embeddings = r.hits;
      if (r.warning) warnings.push(r.warning);
    } catch (e) {
      warnings.push(`embeddings 源失败: ${(e as Error).message}`);
    }
  }

  const total =
    all.tasks.length +
    all.requirements.length +
    all.requirement_cache.length +
    all.docs.length +
    all.symbols.length +
    all.links.length +
    all.embeddings.length;

  return { query, total_hits: total, by_source: all, warnings };
}

// ---- cache 健康检查 (供 /api/knowledge/refresh-cache 用) ----

// 功能: 列出 user 可见项目下, 飞书版本已配但 requirement_cache 拉取失败的 versions.
// 关注点: 失败行不删 (fetch_error 留底), 但 7 天前的失败视为可清理 (cron 决定); 本函数只返回当前错误集.
export function listStaleCacheErrors(userId: string): Array<{
  version_id: string;
  project_id: string;
  version_name: string;
  error_count: number;
  latest_error: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rc.version_id, p.id AS project_id, v.name AS version_name,
              COUNT(*) AS error_count, MAX(rc.fetched_at) AS latest_fetched,
              (SELECT fetch_error FROM requirement_cache rc2
               WHERE rc2.version_id = rc.version_id AND rc2.fetch_error IS NOT NULL
               ORDER BY rc2.fetched_at DESC LIMIT 1) AS latest_error
       FROM requirement_cache rc
       JOIN versions v ON v.id = rc.version_id
       JOIN projects p ON p.id = v.project_id
       WHERE p.owner_id = ? AND p.deleted_at IS NULL AND v.deleted_at IS NULL
         AND rc.fetch_error IS NOT NULL
       GROUP BY rc.version_id`
    )
    .all(userId) as Array<{
      version_id: string;
      project_id: string;
      version_name: string;
      error_count: number;
      latest_fetched: string | null;
      latest_error: string | null;
    }>;
  return rows.map((r) => ({
    version_id: r.version_id,
    project_id: r.project_id,
    version_name: r.version_name,
    error_count: r.error_count,
    latest_error: r.latest_error ?? "",
  }));
}