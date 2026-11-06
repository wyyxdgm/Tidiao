// Webhook CRUD operations

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";

export const WEBHOOK_EVENTS = [
  "task.created",
  "task.started",
  "task.reviewing",
  "task.completed",
  "task.failed",
  // ⚠️ R131 (damo 2026-09-15) 退役: rejected 已从 in-flight 状态流转移除, 不再
  //   主动 dispatch. 保留为历史兼容 (旧 task 重启到 running 不会触发 task.rejected,
  //   仅历史数据曾触发过的事件保留接口契约).
  "task.rejected",
  "task.cancelled",
  // 🆕 R131 (damo 2026-09-15): 等用户介入事件 — 外部系统可订阅以触发提醒/工作流.
  "task.await_user",
  "task.dependency_changed",
  "task.evaluated",
  // R107 父子任务通知兜底 (damo 0825 拍板). 见 src/lib/runtime/parent-notify.ts.
  //   默认无 webhook 订阅此事件 — 仅当父 task session_id 为空时触发 (sendUserMessage
  //   会抛 "No active session"). listActiveWebhooks 按 events 数组 include 过滤,
  //   现有订阅方不订阅此事件则不触发, 不破坏既有契约.
  "task.parent_child_notify",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  secret: string;
  active: number;
  owner_id: string | null; // FK users.id (T3); NULL = pre-auth legacy row
  created_at: string;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  created_at: string;
  has_secret: boolean;
}

export interface WebhookDefinition {
  name: string;
  url: string;
  events: WebhookEventType[];
  secret: string;
  active?: boolean;
  ownerId?: string; // from session (x-user-id); API routes always set this
}

export interface WebhookUpdate {
  name?: string;
  url?: string;
  events?: WebhookEventType[];
  secret?: string;
  active?: boolean;
}

export interface DeliverableWebhook extends Omit<Webhook, "has_secret"> {
  secret: string;
}

function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: JSON.parse(row.events) as WebhookEventType[],
    active: row.active === 1,
    created_at: row.created_at,
    has_secret: Boolean(row.secret),
  };
}

export function createWebhook(def: WebhookDefinition): Webhook {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO webhooks (id, name, url, events, secret, active, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    def.name,
    def.url,
    JSON.stringify(def.events),
    def.secret,
    def.active === false ? 0 : 1,
    def.ownerId ?? null
  );
  return getWebhookById(id)!;
}

// userId is optional: API routes pass it to enforce ownership (non-owner gets
// null -> 404); internal callers omit it for an unfiltered read.
export function getWebhookById(id: string, userId?: string): Webhook | null {
  const sql = userId
    ? "SELECT * FROM webhooks WHERE id = ? AND owner_id = ?"
    : "SELECT * FROM webhooks WHERE id = ?";
  const row = getDb().prepare(sql).get(...(userId ? [id, userId] : [id])) as WebhookRow | undefined;
  return row ? toWebhook(row) : null;
}

export function listWebhooks(userId?: string): Webhook[] {
  const sql = userId
    ? "SELECT * FROM webhooks WHERE owner_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM webhooks ORDER BY created_at DESC";
  const rows = getDb().prepare(sql).all(...(userId ? [userId] : [])) as WebhookRow[];
  return rows.map(toWebhook);
}

// Active webhooks for an event, scoped to a task's owner so a task only fires
// its owner's webhooks (no cross-user event delivery). ownerId is optional for
// internal callers that haven't been wired yet, but the dispatcher always passes
// task.owner_id.
export function listActiveWebhooks(event: WebhookEventType, ownerId?: string): DeliverableWebhook[] {
  const sql = ownerId
    ? "SELECT * FROM webhooks WHERE active = 1 AND owner_id = ? ORDER BY created_at ASC"
    : "SELECT * FROM webhooks WHERE active = 1 ORDER BY created_at ASC";
  const rows = getDb().prepare(sql).all(...(ownerId ? [ownerId] : [])) as WebhookRow[];
  return rows
    .filter((row) => (JSON.parse(row.events) as string[]).includes(event))
    .map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      events: JSON.parse(row.events) as WebhookEventType[],
      secret: row.secret,
      active: true,
      created_at: row.created_at,
    }));
}

export function updateWebhook(id: string, updates: WebhookUpdate, userId?: string): Webhook | null {
  const db = getDb();
  if (!getWebhookById(id, userId)) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.url !== undefined) { fields.push("url = ?"); values.push(updates.url); }
  if (updates.events !== undefined) { fields.push("events = ?"); values.push(JSON.stringify(updates.events)); }
  if (updates.secret !== undefined) { fields.push("secret = ?"); values.push(updates.secret); }
  if (updates.active !== undefined) { fields.push("active = ?"); values.push(updates.active ? 1 : 0); }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }
  return getWebhookById(id);
}

export function deleteWebhook(id: string, userId?: string): boolean {
  const sql = userId
    ? "DELETE FROM webhooks WHERE id = ? AND owner_id = ?"
    : "DELETE FROM webhooks WHERE id = ?";
  return getDb().prepare(sql).run(...(userId ? [id, userId] : [id])).changes > 0;
}
