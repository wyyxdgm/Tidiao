// requirements-cache 模块 —— 飞书需求点本地缓存 (v73 requirement_cache 表).
//
// 设计动机 (damo 0906 拍板 R92):
//   - 飞书 API 限速, agent 高频 LIKE 不可能每轮都打.
//   - 本地镜像 sheet 行 → SQLite 表, LIKE 走本地 (0 飞书调用, 跨 project 0 飞书调用).
//   - 拉取走 cron 15min + 手动 /api/knowledge/refresh-cache 双通道.
//
// 设计要点:
//   - 1 行 = 1 飞书需求点 (镜像). 拉取时按 version 全量替换 (DELETE+INSERT), 不 diff
//     —— sheet 本身有几十行级别, replace 一次几 ms, diff 复杂度不值得.
//   - id = "{version_id}:{row_number}" 保证同 sheet 内唯一 + 跨 version 不撞.
//   - 软删 sheet 行 (deleted_at IS NULL) 仍可读到; 但 fly 没有 deleted_at 概念,
//     所以一旦飞书删了行, 缓存也跟着 DELETE+INSERT 不再有 (下次拉取自然消失).
//   - 拉取失败 → 旧 cache 保留 + 写一行 fetch_error 记录, 不抛错 (cron 视图看到).
//   - owner_id 直接镜像行内 owner, 走 users.id 软关联 (不挂 FK: 飞书删人后行可能仍存在).
//
// 关注点:
//   - 默认按 sheet 行 1-100 拉 (anflow 实测几十行; 上限 100 兜底防爆).
//   - 多租户: getVersionById 必须传 userId (走 v33 软删过滤 + owner_id 隔离).
//   - 不挂 externalProcess retry: 飞书瞬时失败由下次 cron 兜底; 单次失败不阻断.
//   - 不在本模块同步 in_app requirements (那是 v64 独立链路); 飞书行有映射字段
//     requirement_id 指向本地 in_app row (sync 层负责填), 本模块只管镜像 sheet 行.

import { getDb } from "./index";
import { getVersionById } from "./versions";
import { readRows, type FeishuRow } from "../feishu/sheets";
import { getSnapshot, saveSnapshot } from "../feishu/feishu-snapshot";

// ---- 类型 ----

export interface RequirementCacheRow {
  id: string;
  version_id: string;
  sheet_url: string;
  sheet_name: string;
  row_number: number;
  requirement_id: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  priority: number | null;
  owner_id: string | null;
  tags: string | null;
  raw_row: string | null;
  fetched_at: string;
  fetch_error: string | null;
}

export interface CacheStatus {
  version_id: string;
  row_count: number;
  error_count: number;
  latest_fetched_at: string | null;
  latest_error: string | null;
}

export interface RefreshResult {
  version_id: string;
  row_count: number;        // 本次拉取成功行数
  errored: boolean;         // 本次拉取失败
  error?: string;           // 失败原因 (errored=true 时)
  duration_ms: number;
}

// ---- 内部 ----

function rowToCacheRow(r: any): RequirementCacheRow {
  return {
    id: r.id,
    version_id: r.version_id,
    sheet_url: r.sheet_url,
    sheet_name: r.sheet_name,
    row_number: r.row_number,
    requirement_id: r.requirement_id ?? null,
    title: r.title ?? null,
    description: r.description ?? null,
    status: r.status ?? null,
    priority: r.priority ?? null,
    owner_id: r.owner_id ?? null,
    tags: r.tags ?? null,
    raw_row: r.raw_row ?? null,
    fetched_at: r.fetched_at,
    fetch_error: r.fetch_error ?? null,
  };
}

// 把 FeishuRow.fields 转成本地缓存行的简化视图 (title = requirement_id 行/字段名;
// description = 三段内容拼; status = O 列; priority = K 列数字).
function feishuFieldsToCacheFields(fields: Record<string, string>): {
  title: string | null;
  description: string | null;
  status: string | null;
  priority: number | null;
  tags: string | null;
} {
  // 标题 = C 列 (anflow 默认 module) 或 requirement_id
  const moduleName = fields["module"] ?? "";
  const problem = fields["problem"] ?? "";
  const expected = fields["expected"] ?? "";
  const title = moduleName || fields["id"] || null;
  const description = [problem, expected].filter((s) => s.length > 0).join(" | ") || null;
  const status = fields["status"] ?? fields["o"] ?? null;
  let priority: number | null = null;
  const kStr = fields["priority"] ?? fields["k"] ?? "";
  if (kStr) {
    const n = parseInt(kStr, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 5) priority = n;
  }
  const tags = fields["tags"] ?? null;
  return { title, description, status, priority, tags };
}

// ---- 读 ----

// 功能: 拉 version 的全部 cache 行 (按 row_number ASC).
export function listCachedRequirementsByVersion(
  versionId: string,
  userId?: string
): RequirementCacheRow[] {
  // 先做 owner 隔离校验 (路由层也会做, 这里是双兜底)
  if (userId) {
    const v = getVersionById(versionId, userId);
    if (!v) return [];
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM requirement_cache WHERE version_id = ? ORDER BY row_number ASC`
    )
    .all(versionId) as any[];
  return rows.map(rowToCacheRow);
}

// 功能: 查 version 缓存状态 (行数 / 错误数 / 最近拉取).
export function getCacheStatus(
  versionId: string,
  userId?: string
): CacheStatus | null {
  if (userId) {
    const v = getVersionById(versionId, userId);
    if (!v) return null;
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN fetch_error IS NOT NULL THEN 1 ELSE 0 END) AS err_n,
              MAX(fetched_at) AS latest
       FROM requirement_cache WHERE version_id = ?`
    )
    .get(versionId) as { total: number; err_n: number | null; latest: string | null };
  const errRow = db
    .prepare(
      `SELECT fetch_error FROM requirement_cache
       WHERE version_id = ? AND fetch_error IS NOT NULL
       ORDER BY fetched_at DESC LIMIT 1`
    )
    .get(versionId) as { fetch_error: string } | undefined;
  return {
    version_id: versionId,
    row_count: row.total,
    error_count: row.err_n ?? 0,
    latest_fetched_at: row.latest,
    latest_error: errRow?.fetch_error ?? null,
  };
}

// ---- 写 ----

// 功能: 单 version 拉取 + 全量替换. 失败 = 旧 cache 保留 + fetch_error 写入.
// 关注点:
//   - 锁: 单 version 串行; 跨 version 由调用方 (cron / admin) 控制并发.
//   - 拉取范围: row 1..maxRow (默认 100). anflow 实测 < 50 行; 100 兜底防爆.
//   - 拉取不到任何行 (sheet 空 / 全 padding row) = 视为成功, row_count=0, 缓存清空.
//   - snapshot 优先 (R92 path J): TTL 内读 $ORCHESTRATOR_HOME/feishu-snapshots/<vid>.json,
//     miss / 过期 / ttlSeconds=-1 才走 lark-cli, 拉完写 .tmp + rename. ttlSeconds 默认 3600s.
export async function refreshRequirementCache(
  versionId: string,
  userId?: string,
  opts?: { maxRow?: number; ttlSeconds?: number; forceRefresh?: boolean }
): Promise<RefreshResult> {
  const start = Date.now();
  const v = getVersionById(versionId, userId);
  if (!v) {
    return {
      version_id: versionId,
      row_count: 0,
      errored: true,
      error: "version 不存在 / 已删 / 无权访问",
      duration_ms: Date.now() - start,
    };
  }
  if (!v.feishu_url) {
    return {
      version_id: versionId,
      row_count: 0,
      errored: true,
      error: "version 未配 feishu_url (无 sheet 来源)",
      duration_ms: Date.now() - start,
    };
  }
  const maxRow = opts?.maxRow ?? 100;
  const ttlSeconds = opts?.ttlSeconds ?? 3600;
  const sheetName = v.feishu_sheet ?? "Sheet2";

  try {
    // 1. 优先读 snapshot (R92 path J, 1h TTL → cron 每 15min 触发基本走本地毫秒级)
    let rows: FeishuRow[];
    let fromSnapshot = false;
    const cached = !opts?.forceRefresh ? getSnapshot(versionId, ttlSeconds) : null;
    if (cached) {
      rows = cached;
      fromSnapshot = true;
    } else {
      // 2. snapshot miss / 过期 / force → 走 lark-cli + 写 snapshot (原子)
      const rowIndices = Array.from({ length: maxRow }, (_, i) => i + 1);
      rows = await readRows(rowIndices, {
        sheetName,
        sheetUrl: v.feishu_url,
      });
      // 写 snapshot 失败不阻断主流程 (catch 后继续走 DB 写入)
      try {
        saveSnapshot(versionId, rows);
      } catch (e) {
        console.warn(
          `[refreshRequirementCache] saveSnapshot 失败 ${versionId}: ${(e as Error).message}`
        );
      }
    }
    // 防御: snapshot 路径也要把 null fields 标准化, 走原 feishuFieldsToCacheFields 同样转换
    void fromSnapshot; // 暂未用, 留口子给未来监控 (snapshot_hit / total ratio)

    // 2. 转换 + 拼 id
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM requirement_cache WHERE version_id = ?`).run(versionId);
      const insert = db.prepare(
        `INSERT INTO requirement_cache
           (id, version_id, sheet_url, sheet_name, row_number, requirement_id,
            title, description, status, priority, owner_id, tags, raw_row,
            fetched_at, fetch_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      );
      for (const r of rows) {
        const fields = feishuFieldsToCacheFields(r.fields);
        // 存原始需求点编号 (e.g. "R12" / "v1.6-R12") 供前端跳转参考;
        // 不挂 FK, 不在此层做 row_number → in_app.requirement_id 解析
        // (那是 sync 链路的事, 与本缓存职责分离).
        const reqId = r.fields["id"] ?? r.fields["code"] ?? null;
        const ownerId = (r.fields["owner"] ?? r.fields["i"] ?? null) || null;
        const tagsJson = fields.tags ? JSON.stringify([fields.tags]) : null;
        insert.run(
          `${versionId}:${r.row}`,
          versionId,
          v.feishu_url,
          sheetName,
          r.row,
          reqId,
          fields.title,
          fields.description,
          fields.status,
          fields.priority,
          ownerId,
          tagsJson,
          JSON.stringify(r.fields),
          now
        );
      }
    });
    tx();

    return {
      version_id: versionId,
      row_count: rows.length,
      errored: false,
      duration_ms: Date.now() - start,
    };
  } catch (e) {
    const msg = (e as Error).message;
    // 拉取失败: 旧 cache 保留 + 写一行 error 记录
    try {
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const db = getDb();
      // 占位 row_number 用 -1 (负数永不与真行撞), id 加 err 前缀
      db.prepare(
        `INSERT OR REPLACE INTO requirement_cache
           (id, version_id, sheet_url, sheet_name, row_number, requirement_id,
            title, description, status, priority, owner_id, tags, raw_row,
            fetched_at, fetch_error)
         VALUES (?, ?, ?, ?, -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).run(
        `${versionId}:__err__`,
        versionId,
        v.feishu_url,
        sheetName,
        now,
        msg.slice(0, 1000) // 限长防爆库
      );
    } catch {
      // 写 error 也失败 = 静默 (e.g. DB 锁), 留 trace 给 cron log
    }
    return {
      version_id: versionId,
      row_count: 0,
      errored: true,
      error: msg,
      duration_ms: Date.now() - start,
    };
  }
}

// 功能: 列出 user 全部「已配 feishu_url 且软删=NULL」的 versions, 给 cron / admin 用.
export function listFeishuEnabledVersions(userId?: string): Array<{
  version_id: string;
  project_id: string;
  version_name: string;
  feishu_url: string;
  sheet_name: string;
}> {
  const db = getDb();
  const sql = userId
    ? `SELECT v.id AS version_id, v.project_id, v.name AS version_name, v.feishu_url, v.feishu_sheet
       FROM versions v JOIN projects p ON p.id = v.project_id
       WHERE v.feishu_url IS NOT NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL
         AND p.owner_id = ?`
    : `SELECT v.id AS version_id, v.project_id, v.name AS version_name, v.feishu_url, v.feishu_sheet
       FROM versions v JOIN projects p ON p.id = v.project_id
       WHERE v.feishu_url IS NOT NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL`;
  const rows = db.prepare(sql).all(...(userId ? [userId] : [])) as Array<{
    version_id: string;
    project_id: string;
    version_name: string;
    feishu_url: string;
    feishu_sheet: string | null;
  }>;
  return rows.map((r) => ({
    version_id: r.version_id,
    project_id: r.project_id,
    version_name: r.version_name,
    feishu_url: r.feishu_url,
    sheet_name: r.feishu_sheet ?? "Sheet2",
  }));
}

// 功能: cron 入口 —— 跑全 user (admin) / 单 user 全部 feishu versions 的拉取。
// 关注点: 串行跑 (防 lark-cli 并发限制); 失败不阻断后续 version.
export async function refreshAllCachesForUser(
  userId: string
): Promise<RefreshResult[]> {
  const versions = listFeishuEnabledVersions(userId);
  const out: RefreshResult[] = [];
  for (const v of versions) {
    const r = await refreshRequirementCache(v.version_id, userId);
    out.push(r);
  }
  return out;
}