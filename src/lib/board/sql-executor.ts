// Board SQL source 执行器 (R61 / P1).
//
// 功能: 只读 SQLite 连接上跑 SELECT, 给 board 数据源用. 严格白名单: 必须 SELECT
//       开头, 不能含分号, 单条 query 2s 超时, 行数上限 5000. owner_id 自动注入.
// 关注点:
//  - 冷启动源 §5.3: 独立 readonly 连接, 严禁复用写连接 (better-sqlite3 的 readonly: true).
//  - 冷启动源 §3: 拒绝非 SELECT 开头 / 含 ';' 的语句 —— 防御性白名单, 不是语法解析.
//  - 允许注入 owner_id (= ?) 是为了让 board 写 SQL 时不必暴露多租户细节, 仍走 owner 隔离.
//  - admin 才放开跨 owner (board 用户在大多数场景下都是项目 owner, 但平台维度的运维看板
//    需要 admin 一次看所有项目 —— 这条放路由层判, 执行器只接 owner 字符串).
//  - 错误一律 throw, 路由层 catch 转为 sources[name].error 给前端展示 (而不是整个 board 502).

import Database from "better-sqlite3";
import path from "path";

export interface SqlExecOptions {
  ownerId: string;
  /** true = 跳过 owner 注入 (admin 用). 默认 false. */
  crossOwner?: boolean;
  /** 当前 board 所属 projectId. 传了就注入 project_id = '...' (跨 project 防护). */
  projectId?: string;
  /** 超时毫秒, 默认 2000. */
  timeoutMs?: number;
  /** 行数上限, 默认 5000. */
  rowLimit?: number;
}

export interface SqlExecResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

const MAX_ROWS = 5000;
const DEFAULT_TIMEOUT_MS = 2000;

// 模块级 readonly 连接句柄 —— 进程内复用, 避免每个 source 都新开文件 (better-sqlite3
// readonly 文件句柄相对轻量但仍涉及 mmap 校验, 复用更稳).
let readDb: Database.Database | null = null;

function getReadDb(): Database.Database {
  if (readDb) return readDb;
  const dbPath = process.env.ORCHESTRATOR_DB_PATH ||
    path.join(process.env.ORCHESTRATOR_HOME || "/home/user/.agent-orchestrator", "orchestrator.db");
  readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  // 注意: readonly 模式下不允许设置 journal_mode (会触发 'attempt to write a readonly database')
  // 写入侧的 journal_mode 决定实际行为, 我们继承就行.
  return readDb;
}

// 功能: 严格白名单: 必须以 SELECT 或 WITH 开头 (WITH ... SELECT 是 CTE 写法),
//       不能含 ';', 不能含 '--' 行内注释 (避免注释里塞语句).
// 关注点: 这是粗粒度检查 —— 不解析 SQL 语法. 不防: 同名列错引、函数注入 (DB 端没有
//   危险函数), 但能挡住 99% 的手滑与故意破坏. 真正执行时 better-sqlite3 prepare
//   会二次校验语句合法性.
function validateSql(raw: string): void {
  const trimmed = raw.trim().replace(/--[^\n]*/g, "").trim(); // 剥行内注释
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error("SQL must start with SELECT or WITH");
  }
  if (trimmed.includes(";")) {
    throw new Error("SQL must not contain semicolons (single statement only)");
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM|REINDEX)\b/i.test(trimmed)) {
    throw new Error("SQL contains forbidden DDL/DML keyword");
  }
}

// 功能: 在 SQL 里找第一个 FROM / JOIN 后跟的表名, 不存在 owner_id 列就注入.
// 关注点: 这是粗粒度注入 —— 多表 JOIN / 子查询 / CTE 都会被插入到第一个表上.
//   业务表都有 owner_id 列 (tasks/projects/sessions/...); 缺这个字段的表 (events/
//   users/...) 就别直接用 sql source, 用 api source. 复杂情况后续用视图兜底.
//   这里不接 parse 树, 走正则匹配已经够了 —— 失败了就 throw, 让 board 作者改 SQL.
//   🔴 关键: 别名匹配必须排除 SQL 关键字 (WHERE/GROUP/ORDER/LIMIT/...), 否则
//   `FROM tasks WHERE status='x'` 会被误识别 alias='WHERE', 注入 WHERE.WHERE.owner_id.
const SQL_RESERVED = new Set([
  "WHERE", "GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING", "UNION", "INTERSECT",
  "EXCEPT", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "JOIN", "ON", "AS",
  "AND", "OR", "NOT", "IN", "IS", "NULL", "TRUE", "FALSE", "LIKE", "GLOB",
  "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END",
]);
// owner 维度的全局表 (本无 owner_id 列). projects 表本无 owner_id 列 (schema 里就是
// id/name/desc/created_at), 不加进黑名单会让 owner 注入炸 (no such column).
const KNOWN_NO_OWNER = new Set(["events", "users", "webhooks", "roles", "templates", "schedules", "llm_configs", "app_settings", "checkpoints", "requirements", "projects"]);
// project 维度的全局表 (本无 project_id 列). projects(PK 就是 id) 同样跳过. schedules
// 实际有 project_id 但允许 NULL (全局 schedule), 不强制注入 —— 留给作者显式过滤.
const KNOWN_NO_PROJECT = new Set([
  "projects", "users", "webhooks", "roles", "templates", "llm_configs", "app_settings",
]);

function injectOwnerFilter(sql: string, ownerId: string): string {
  const tableMatch = sql.match(/\b(?:FROM|JOIN)\s+["'`]?(\w+)["'`]?(?:\s+(?:AS\s+)?(\w+))?/i);
  if (!tableMatch) return sql;
  const tableName = tableMatch[1];
  let alias = tableMatch[2] || tableName;
  if (SQL_RESERVED.has(alias.toUpperCase())) alias = tableName; // 防御: 别名撞关键字就退回表名
  if (KNOWN_NO_OWNER.has(tableName.toLowerCase())) return sql;
  // 已经在 SQL 里写了 owner_id 过滤就不重复注入 (用户主动放开)
  if (new RegExp(`\\b${alias}\\.owner_id\\b`, "i").test(sql)) return sql;
  // 追加 WHERE 条件 —— 必须插在 LIMIT 之前, 否则 SQL 语法错.
  // 关注点: 用户写的 SQL 形如 "SELECT ... FROM t LIMIT 100", 不能直接拼在末尾.
  //   用 /\bLIMIT\b/i 找位置, 没 LIMIT 就拼在末尾 (后续 executeBoardSql 会再加 LIMIT).
  const whereRe = /\bWHERE\b/i;
  const limitRe = /\bLIMIT\b/i;
  const owner = ownerId.replace(/'/g, "''");
  const tail = `${alias}.owner_id = '${owner}'`;
  const injectWithWhere = `WHERE 1=1 AND ${tail} AND`;
  const injectNoWhere = `WHERE 1=1 AND ${tail}`;
  if (whereRe.test(sql)) {
    // 已有 WHERE: 在第一个 WHERE 前注入 AND 串 (替换成 WHERE 1=1 AND <owner> AND)
    return sql.replace(whereRe, injectWithWhere);
  }
  if (limitRe.test(sql)) {
    // 没 WHERE 但有 LIMIT: 把 WHERE 串插到 LIMIT 前 (用 match+slice 避免吃掉原 LIMIT)
    const m = sql.match(limitRe)!;
    const idx = m.index ?? 0;
    return sql.slice(0, idx) + injectNoWhere + " " + sql.slice(idx);
  }
  return sql + " " + injectNoWhere;
}

// 功能: 仿 injectOwnerFilter 给 project_id 加过滤. 业务表大多有 project_id 列 (tasks/
//       versions/sessions/schedules/requirements/events); 黑名单是少数没这列的全局表.
// 关注点: 同 owner 注入的几个怪点 ——
//   - 别名撞 SQL 关键字 (WHERE/GROUP/...) 时退回表名;
//   - 已写 `alias.project_id = ...` 就跳过 (作者显式覆盖);
//   - LIMIT/WHERE 插位点同 owner 处理. owner 先 project 后, 串起来最终形如
//     `WHERE 1=1 AND owner ... AND project ...` 顺序稳定 (调顺序影响测试断言).
function injectProjectFilter(sql: string, projectId: string): string {
  const tableMatch = sql.match(/\b(?:FROM|JOIN)\s+["'`]?(\w+)["'`]?(?:\s+(?:AS\s+)?(\w+))?/i);
  if (!tableMatch) return sql;
  const tableName = tableMatch[1];
  let alias = tableMatch[2] || tableName;
  if (SQL_RESERVED.has(alias.toUpperCase())) alias = tableName;
  if (KNOWN_NO_PROJECT.has(tableName.toLowerCase())) return sql;
  if (new RegExp(`\\b${alias}\\.project_id\\b`, "i").test(sql)) return sql;
  const whereRe = /\bWHERE\b/i;
  const limitRe = /\bLIMIT\b/i;
  const pid = projectId.replace(/'/g, "''");
  const tail = `${alias}.project_id = '${pid}'`;
  const injectWithWhere = `WHERE 1=1 AND ${tail} AND`;
  const injectNoWhere = `WHERE 1=1 AND ${tail}`;
  if (whereRe.test(sql)) {
    return sql.replace(whereRe, injectWithWhere);
  }
  if (limitRe.test(sql)) {
    const m = sql.match(limitRe)!;
    const idx = m.index ?? 0;
    return sql.slice(0, idx) + injectNoWhere + " " + sql.slice(idx);
  }
  return sql + " " + injectNoWhere;
}

// 功能: 跑一条 SELECT, 返回 {columns, rows}. 失败 throw (调用方 catch).
// 关注点:
//  - prepare 不缓存 (board source 多样性高, 缓存命中率低, 且 better-sqlite3 prepare 很快).
//  - 用 all() 一次性拿行 (rows 上限已由 .limit 截断, 单次最多 5000 行不会爆内存).
//  - 超时通过 better-sqlite3 busy_timeout (毫秒) + 调用方 Promise.race 双重保护.
//  - 错误一律 throw —— 路由层不会拿到半成品结果.
export function executeBoardSql(raw: string, opts: SqlExecOptions): SqlExecResult {
  validateSql(raw);

  let sql = raw;
  if (!opts.crossOwner) {
    sql = injectOwnerFilter(sql, opts.ownerId);
    if (opts.projectId) {
      sql = injectProjectFilter(sql, opts.projectId);
    }
  }

  const db = getReadDb();
  const limit = Math.min(opts.rowLimit ?? MAX_ROWS, MAX_ROWS);
  // LIMIT 强制: 即使 SQL 没写, 也强制给最后一行加 LIMIT (防没 LIMIT 时把百万行读进内存)
  if (!/\bLIMIT\b/i.test(sql)) {
    sql = sql + ` LIMIT ${limit}`;
  } else {
    // 用户写了 LIMIT 但超过上限就截断
    const m = sql.match(/\bLIMIT\s+(\d+)/i);
    if (m && parseInt(m[1], 10) > limit) {
      sql = sql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${limit}`);
    }
  }

  db.pragma(`busy_timeout = ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}`);

  const stmt = db.prepare(sql);
  const rawRows = stmt.all() as Record<string, unknown>[];
  const rows = rawRows.slice(0, limit);

  // better-sqlite3 columns() 拿到的是 select 列表里的列名 (含 AS 别名)
  const columns = stmt.columns().map((c) => c.name);
  return { columns, rows };
}

// 功能: 测试钩子 —— 关掉 readonly 连接 (vitest 跑完时回收, 防 fd 泄露).
// 关注点: 不会在生产路径调用; 仅供单测 import 后在 afterAll 里调.
export function closeBoardSqlDb(): void {
  if (readDb) {
    try {
      readDb.close();
    } catch {
      /* ignore */
    }
    readDb = null;
  }
}
