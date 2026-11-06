// Event logging operations

import { getDb } from "./index";
import type { TaskEvent } from "../runtime/types";

export function insertEvent(event: Omit<TaskEvent, "id" | "created_at">): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO events (task_id, session_id, type, data)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(event.task_id, event.session_id || null, event.type, event.data);
}

export function getEventsByTaskId(taskId: string, limit?: number): TaskEvent[] {
  const db = getDb();
  const sql = limit
    ? "SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?"
    : "SELECT * FROM events WHERE task_id = ? ORDER BY id ASC";
  const stmt = db.prepare(sql);
  return limit
    ? (stmt.all(taskId, limit) as TaskEvent[])
    : (stmt.all(taskId) as TaskEvent[]);
}

// 功能: 会话消息变更指纹探针 — 该 task 的 MAX(events.id) + 最后一个非空
// session_id. 给 /api/tasks/[id]/messages 的 ETag 用 (2026-10-08 压测: 会话
// 历史全量 282KB/次, 公网隧道 0.8~3.3s, 是任务详情页最大 payload; 条件拉取
// 后二次打开 304 零传输).
// 关注点: 两条都走 idx_events_task_id 索引, 毫秒级; agent 流式写入 events 时
// maxEventId 必涨 → 指纹必变 (漏检方向被堵死), 没写入时稳定 → 304 可命中.
export function getMessagesFingerprintProbes(taskId: string): {
  maxEventId: number;
  lastSessionId: string | null;
} {
  const db = getDb();
  const maxRow = db
    .prepare("SELECT MAX(id) AS max_id FROM events WHERE task_id = ?")
    .get(taskId) as { max_id: number | null };
  const sessRow = db
    .prepare(
      "SELECT session_id FROM events WHERE task_id = ? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1"
    )
    .get(taskId) as { session_id: string | null } | undefined;
  return {
    maxEventId: maxRow.max_id ?? 0,
    lastSessionId: sessRow?.session_id ?? null,
  };
}

export function getRecentEvents(taskId: string, sinceId: number): TaskEvent[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC"
  );
  return stmt.all(taskId, sinceId) as TaskEvent[];
}

// Webhook delivery log: scan events for rows whose data JSON contains the
// given webhook_id and type is a delivery row. Cheap given SQLite + WAL at our scale;
// if it gets hot, add a (type, webhook_id) index via migration.
// 功能: 判断这条父子通知是否为「父还没处理就重复推」的冗余通知.
//   true = 已经给同一 (parent, child, child_to) 推过, 且此后子任务**没有**被真正处置过
//   (唯一离开该状态的方式是 parent_notify 自身触发的 resume) → 调用方应抑制.
// 关注点:
//   - 判据全部落在 events 表已有行上 (parent_notify_dispatched + status_change), 零 migration.
//   - 「真正处置」= 子任务离开 `to` 状态, 且该 status_change 的 reason 不在
//     PLATFORM_REASONS = {parent_notify, drain_stranded, restart} 里 —— 那三个都是平台
//     自己把任务拽回 queued (不是人处置过), 算进去等于抑制永远失效.
//     approve (reviewing→completed) / reject / 人工 resume (无 reason) 才算处置, 之后
//     再进 reviewing 是**新**信息, 必须放行.
//   - 逃生窗口 MAX_SUPPRESS_AGE_HOURS: 上次通知超过 24h 仍未被处置 → 放行一次,
//     避免「父确实漏了消息」被永久掐死 (每 24h 至多一次, 不构成烧钱).
//   - 只读, 不写. 抑制留痕由调用方落 parent_notify_suppressed event.
const MAX_SUPPRESS_AGE_HOURS = 24;

export function isRedundantParentNotify(
  childTaskId: string,
  parentId: string,
  childTo: string
): boolean {
  const db = getDb();
  const last = db
    .prepare(
      `SELECT id, created_at FROM events
       WHERE task_id = ? AND type = 'parent_notify_dispatched'
         AND json_extract(data, '$.parent_id') = ?
         AND json_extract(data, '$.child_to') = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(childTaskId, parentId, childTo) as
    | { id: number; created_at: string }
    | undefined;
  if (!last) return false;

  const aged = db
    .prepare(
      `SELECT 1 AS ok WHERE datetime(?) < datetime('now', ?)`
    )
    .get(last.created_at, `-${MAX_SUPPRESS_AGE_HOURS} hours`) as
    | { ok: number }
    | undefined;
  if (aged) return false;

  const handled = db
    .prepare(
      `SELECT 1 AS ok FROM events
       WHERE task_id = ? AND id > ? AND type = 'status_change'
         AND json_extract(data, '$.from') = ?
         AND COALESCE(json_extract(data, '$.reason'), '')
             NOT IN ('parent_notify', 'drain_stranded', 'restart')
       LIMIT 1`
    )
    .get(childTaskId, last.id, childTo) as { ok: number } | undefined;

  return !handled;
}

export function getWebhookDeliveryEvents(
  webhookId: string,
  limit = 50
): TaskEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE type IN ('webhook_delivered', 'webhook_delivery_failed')
         AND data LIKE ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(`%"webhook_id":"${webhookId}"%`, limit) as TaskEvent[];
  return rows;
}
