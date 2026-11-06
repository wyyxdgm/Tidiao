// GET /api/assets - list attachments across all of a user's tasks.
//
// 全平台资源池页数据源 (PR-2). JOIN tasks 拿 project_id / version_id / owner_id.
// 严格按 owner_id = userId 过滤, 跨租户不可见.
//
// 关注点:
//   - 6 维筛选: project_id / version_id / task_id / type (image|video|audio|file) / source (upload|fork|agent_generated) / q (filename LIKE)
//   - 时间窗: since / until (ISO 字符串, 闭区间)
//   - 排序: created_at (默认 desc) | size | filename, 加 asc/desc 后缀
//   - 分页: ?limit=&offset=, 默认 limit=50
//   - 大表性能: 已有 idx_attachments_owner / idx_attachments_task, owner_id 是高基,
//     JOIN tasks 走主键. LIMIT 50 + created_at 倒序避免全表扫.

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SORT_KEYS = new Set(["created_at", "size_bytes", "filename"]);

// type -> media_type 前缀映射 (前缀过滤)
const TYPE_PREFIX: Record<string, string> = {
  image: "image/",
  video: "video/",
  audio: "audio/",
};
// 哪几个 type 是「前缀包含」 (image/video/audio); 其他 (如 file) 走 NOT IN.
const TYPE_PREFIX_TYPES = new Set(Object.keys(TYPE_PREFIX));
// NOT LIKE 前缀列表 —— 用于 type=file 排除 image/video/audio.
const NOT_PREFIX = ["image/%", "video/%", "audio/%"];

export interface AssetListItem {
  id: string;
  task_id: string;
  task_title: string | null;
  project_id: string | null;
  version_id: string | null;
  owner_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  source: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get("project_id") || null;
  // 飞书 AO-DEV R218: version_id=null (字面量) = 只看未挂版本的条目 (t.version_id IS NULL),
  //   与 GET /api/requirements 的 ?version_id=null 约定同款; 其余值 = 精确匹配。
  const versionIdRaw = url.searchParams.get("version_id") || null;
  const unversionedOnly = versionIdRaw === "null";
  const versionId = unversionedOnly ? null : versionIdRaw;
  const taskId = url.searchParams.get("task_id") || null;
  const type = url.searchParams.get("type") || null;
  const source = url.searchParams.get("source") || null;
  const since = url.searchParams.get("since") || null;
  const until = url.searchParams.get("until") || null;
  const q = url.searchParams.get("q")?.trim() || null;
  const sort = url.searchParams.get("sort") || "created_at:desc";

  // source 白名单 (attachments 表 source 枚举: upload | fork | agent_generated).
  // 不在白名单 = 无效 = 不加条件 (前端脏数据不会 500).
  const SOURCE_VALUES = new Set(["upload", "fork", "agent_generated"]);

  // limit/offset 容错
  const rawLimit = parseInt(url.searchParams.get("limit") || "", 10);
  const rawOffset = parseInt(url.searchParams.get("offset") || "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  // sort 校验: created_at | size_bytes | filename + 可选 :asc / :desc
  const [sortKey = "created_at", sortDirRaw = "desc"] = sort.split(":");
  const sortKeySafe = SORT_KEYS.has(sortKey) ? sortKey : "created_at";
  const sortDir = sortDirRaw === "asc" ? "ASC" : "DESC";

  const db = getDb();
  const conditions: string[] = ["a.owner_id = ?"];
  const params: unknown[] = [userId];
  if (taskId) {
    conditions.push("a.task_id = ?");
    params.push(taskId);
  }
  if (projectId) {
    conditions.push("t.project_id = ?");
    params.push(projectId);
  }
  if (unversionedOnly) {
    conditions.push("t.version_id IS NULL");
  } else if (versionId) {
    conditions.push("t.version_id = ?");
    params.push(versionId);
  }
  if (type && TYPE_PREFIX_TYPES.has(type)) {
    conditions.push("a.media_type LIKE ?");
    params.push(`${TYPE_PREFIX[type]}%`);
  } else if (type === "file") {
    // 排除 image/* / video/* / audio/* —— 其余归"文件"
    for (const p of NOT_PREFIX) {
      conditions.push("a.media_type NOT LIKE ?");
      params.push(p);
    }
  }
  if (source && SOURCE_VALUES.has(source)) {
    conditions.push("a.source = ?");
    params.push(source);
  }
  if (since) {
    conditions.push("a.created_at >= ?");
    params.push(since);
  }
  if (until) {
    conditions.push("a.created_at <= ?");
    params.push(until);
  }
  if (q) {
    conditions.push("a.filename LIKE ?");
    params.push(`%${q}%`);
  }

  const where = conditions.join(" AND ");

  // JOIN tasks: 取 project_id / version_id / task_title (供列表展示).
  // tasks 表没有 owner_id 单独存 (项目级 owner 在 projects/version), 但 attachments
  // 自己存了 owner_id, 用 attachments.owner_id 即可过滤跨租户.
  const baseQuery = `
    FROM attachments a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE ${where}
  `;

  // total 先 COUNT 一次. LIMIT 50 + 总数 ≤ 几千的场景下, 加一次 COUNT
  // 不会成为瓶颈 (idx_attachments_owner 命中). 真大表再切窗口函数.
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${baseQuery}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(`
      SELECT
        a.id, a.task_id, a.owner_id, a.filename, a.media_type,
        a.size_bytes, a.source, a.created_at,
        t.title AS task_title,
        t.project_id AS project_id,
        t.version_id AS version_id
      ${baseQuery}
      ORDER BY a.${sortKeySafe} ${sortDir}, a.id ASC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as AssetListItem[];

  return NextResponse.json({
    assets: rows,
    total: totalRow.total,
    limit,
    offset,
  });
}