// requirement_revisions 模块 —— 飞书 R63 需求点字段级变更时间线.
//
// 功能:
//   - recordRevision(): 一次写一条字段级 diff (create / update / softDelete 三处用).
//   - listRevisions(): 列某 requirement 的全部变更 (详情页时间线用).
//   - getLatestRevision(): 取最近一次变更 (列表页胶囊用, 1 次 query 代替 N+1).
//
// 关注点:
//   - owner_id 隔离: 通过 requirement_id → requirements.owner_id 间接过滤 (listRevisions
//     调用方先 verify 可读, 这里不再二次 owner 过滤, 避免 N+1 join).
//   - 旧值/新值都序列化为 TEXT 存: status 用原值; tags 用 JSON 字符串; null = 显式置空.
//   - 写操作失败不回滚 caller 的事务: recordRevision 独立 try/catch, 失败仅 log,
//     不阻断主路径 (与 attach audit log 同根选择, R63 范畴的"可观察性"优于"强一致").
//   - actor 语义: actor_type='user' = 浏览器/手动; 'agent' = x-actor-type header
//     或显式传; 'system' = 平台内部 (例: future 批量 reconcile). actor_id =
//     user_id / agent 名. task_id 可空, agent 改时记录来源 task 便于回溯 transcript.

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import { type RequirementStatus } from "./requirements";

export type ActorType = "user" | "agent" | "system";

export interface RequirementRevision {
  id: string;
  requirement_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  task_id: string | null;
  created_at: string;
}

export interface RevisionActor {
  type: ActorType;
  id?: string | null;
  task_id?: string | null;
}

function rowToRevision(r: any): RequirementRevision {
  return {
    id: r.id,
    requirement_id: r.requirement_id,
    field: r.field,
    old_value: r.old_value ?? null,
    new_value: r.new_value ?? null,
    actor_type: r.actor_type,
    actor_id: r.actor_id ?? null,
    task_id: r.task_id ?? null,
    created_at: r.created_at,
  };
}

// 功能: 写一条字段级 diff. 失败不抛, 仅 console.warn (不阻断主路径).
// 关注点:
//   - created_at 用 sqlite 默认值, 与 requirements 表口径一致 (秒精度).
//   - new_value === old_value 时调用方应跳过 (避免噪音), 此函数不做去重.
export function recordRevision(
  requirementId: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  actor: RevisionActor
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO requirement_revisions
         (id, requirement_id, field, old_value, new_value, actor_type, actor_id, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(),
      requirementId,
      field,
      oldValue,
      newValue,
      actor.type,
      actor.id ?? null,
      actor.task_id ?? null
    );
  } catch (err) {
    console.warn(`[requirement_revisions] record failed:`, (err as Error).message);
  }
}

// 功能: 列某 requirement 的全部变更, 按时间倒序, 默认 limit 100.
// 关注点: 不做 owner 过滤 (调用方负责前置 verify).
export function listRevisions(
  requirementId: string,
  limit: number = 100
): RequirementRevision[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM requirement_revisions
       WHERE requirement_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(requirementId, Math.min(500, Math.max(1, limit))) as any[];
  return rows.map(rowToRevision);
}

// 功能: 批量取多条 requirement 的"最近一次变更" (列表页 N+1 优化).
// 关注点:
//   - 入参 requirementIds 数组 (空数组直接返空 Map).
//   - 内部用 window function 取每条 requirement_id 的最新一行; sqlite 3.25+ 支持.
//   - 返回 Map<requirement_id, RequirementRevision>, 列表页 O(1) 查询.
export function getLatestRevisions(
  requirementIds: string[]
): Map<string, RequirementRevision> {
  const out = new Map<string, RequirementRevision>();
  if (requirementIds.length === 0) return out;
  const db = getDb();
  const placeholders = requirementIds.map(() => "?").join(",");
  // ROW_NUMBER 需稳定 tiebreaker: 同 created_at 时按 id DESC (uuidv4 后写的 = 时间晚).
  const rows = db
    .prepare(
      `SELECT id, requirement_id, field, old_value, new_value, actor_type, actor_id, task_id, created_at FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY requirement_id ORDER BY created_at DESC, id DESC
         ) AS rn
         FROM requirement_revisions
         WHERE requirement_id IN (${placeholders})
       ) WHERE rn = 1`
    )
    .all(...requirementIds) as any[];
  for (const r of rows) {
    out.set(r.requirement_id, rowToRevision(r));
  }
  return out;
}

// 全局增量查询参数 (R63 N 列: 给外部 webhook / 看板).
// 关注点:
//   - since / until 都是 ISO timestamp 字符串 (与 sqlite datetime('now') 格式对齐:
//     "YYYY-MM-DD HH:MM:SS" 无 T 无 Z). 客户端传 ISO 8601 时用 .replace('T',' ').slice(0,19).
//   - cursor 由 encodeRevisionCursor() 生成, 客户端透传: (created_at, id) 锚点稳定分页.
//   - actor_type 不限 'user'/'agent'/'system'; 不传 = 三类全收.
//   - owner_id 由 caller 强制注入 (multi-tenant 隔离, 不许接口层透传).
export interface ListRevisionsRangeInput {
  since?: string;
  until?: string;
  actor_type?: ActorType;
  requirement_id?: string;
  limit?: number;
  cursor?: string | null;
}

// 功能: 跨 requirement 的全局增量查询, 时间倒序 (R63 N 列建议采纳).
// 关注点:
//   - owner 隔离走 JOIN requirements (owner_id 命中 idx_requirements_owner).
//   - 时间范围 [since, until) 半开区间; since 缺省 = 全部; until 缺省 = 至今.
//   - cursor 锚点 (created_at, id): 取比 (cursor_created_at, cursor_id) 更"旧"的下一批,
//     用 `<` 复合条件保证稳定分页 (同 created_at 时按 id 决断).
//   - limit 默认 100, 上限 500 (与 per-id 端点一致, 防 list all 拖死库).
//   - 多读 limit+1 行探测 has_more; 多读的那行不返回.
export interface ListRevisionsRangeResult {
  items: RequirementRevision[];
  next_cursor: string | null;
  has_more: boolean;
}

export function listRevisionsByTimeRange(
  input: ListRevisionsRangeInput,
  ownerId: string
): ListRevisionsRangeResult {
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));

  const where: string[] = ["req.owner_id = ?"];
  const params: any[] = [ownerId];

  if (input.actor_type) {
    where.push("r.actor_type = ?");
    params.push(input.actor_type);
  }
  if (input.requirement_id) {
    where.push("r.requirement_id = ?");
    params.push(input.requirement_id);
  }
  if (input.since) {
    where.push("r.created_at >= ?");
    params.push(input.since);
  }
  if (input.until) {
    where.push("r.created_at < ?");
    params.push(input.until);
  }

  if (input.cursor) {
    const decoded = decodeRevisionCursor(input.cursor);
    if (decoded) {
      // 稳定分页: 严格小于 (cursor_created_at, cursor_id) 的下一个时间窗.
      // 同 created_at 时按 id DESC, 所以下一页 = (created_at < cursor_ts) OR
      // (created_at = cursor_ts AND id < cursor_id).
      where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
      params.push(decoded.created_at, decoded.created_at, decoded.id);
    }
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.* FROM requirement_revisions r
       JOIN requirements req ON req.id = r.requirement_id
       ${whereSql}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`
    )
    .all(...params, limit + 1) as any[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToRevision);
  const nextCursor = hasMore && items.length > 0
    ? encodeRevisionCursor({
        created_at: items[items.length - 1].created_at,
        id: items[items.length - 1].id,
      })
    : null;

  return { items, next_cursor: nextCursor, has_more: hasMore };
}

// 功能: 把 (created_at, id) 锚点编码成 opaque cursor 字符串 (base64url JSON).
// 关注点:
//   - base64url = 无 padding / 替换 +→- /→_, URL 安全不需 encode.
//   - schema 演进时 (新增 anchor 字段) 用 version 字段标记, 旧 cursor 走
//     decodeRevisionCursor 兼容.
export interface RevisionCursor {
  v: 1;
  created_at: string;
  id: string;
}

export function encodeRevisionCursor(c: { created_at: string; id: string }): string {
  const payload: RevisionCursor = { v: 1, created_at: c.created_at, id: c.id };
  return Buffer.from(JSON.stringify(payload), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeRevisionCursor(s: string): RevisionCursor | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const raw = Buffer.from(padded, "base64").toString("utf-8");
    const obj = JSON.parse(raw);
    if (obj && obj.v === 1 && typeof obj.created_at === "string" && typeof obj.id === "string") {
      return obj as RevisionCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// 工具: 把 RequirementStatus / tag[] / number 转成 revision 可存的 string.
// 关注点: 反序列化由前端按 field 名各自解析 (详情页时间线用), 这里是单向往 string.
export function revisionStringify(
  field: string,
  value: unknown
): string | null {
  if (value === null || value === undefined) return null;
  if (field === "tags" && Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (field === "status" && typeof value === "string") {
    return value as RequirementStatus;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
