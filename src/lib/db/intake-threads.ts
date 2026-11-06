// Intake thread CRUD - maps an external 甲方 (企微/飞书 user) to a persistent
// platform task that serves as the requirement conversation thread.

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";

// lark = 飞书国际版 (Lark), 与 feishu 同一回调协议 (验签解密与域名无关), 仅出站域名不同
// (open.feishu.cn vs open.larksuite.com) —— intake 线路只收不发, 两者同 route 处理.
// weixin = 个人微信, 腾讯官方 iLink bot 开放协议 (ilinkai.weixin.qq.com), 长轮询收发
// (channel-qr-bind.md D3): 无 webhook, 入站走 weixin-worker 轮询, 出站走 sendmessage.
export const INTAKE_CHANNELS = ["wecom", "feishu", "lark", "openclaw", "telegram", "weixin"] as const;
export type IntakeChannel = (typeof INTAKE_CHANNELS)[number];

interface IntakeThreadRow {
  id: string;
  channel: string;
  external_user_id: string;
  external_user_name: string | null;
  task_id: string;
  project_id: string;
  owner_id: string;
  created_at: string;
  last_inbound_at: string | null;
  msg_sent_in_window: number;
}

export interface IntakeThread {
  id: string;
  channel: IntakeChannel;
  external_user_id: string;
  external_user_name: string | null;
  task_id: string;
  project_id: string;
  owner_id: string;
  created_at: string;
  last_inbound_at: string | null;
  msg_sent_in_window: number;
}

export interface IntakeThreadDefinition {
  channel: IntakeChannel;
  external_user_id: string;
  external_user_name?: string;
  task_id: string;
  project_id: string;
  owner_id: string;
}

function toThread(row: IntakeThreadRow): IntakeThread {
  return {
    id: row.id,
    channel: row.channel as IntakeChannel,
    external_user_id: row.external_user_id,
    external_user_name: row.external_user_name,
    task_id: row.task_id,
    project_id: row.project_id,
    owner_id: row.owner_id,
    created_at: row.created_at,
    last_inbound_at: row.last_inbound_at,
    msg_sent_in_window: row.msg_sent_in_window,
  };
}

export function createIntakeThread(def: IntakeThreadDefinition): IntakeThread {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO intake_threads (id, channel, external_user_id, external_user_name, task_id, project_id, owner_id, created_at, last_inbound_at, msg_sent_in_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    def.channel,
    def.external_user_id,
    def.external_user_name ?? null,
    def.task_id,
    def.project_id,
    def.owner_id,
    now,
    now
  );
  return getIntakeThreadById(id)!;
}

export function getIntakeThreadById(id: string): IntakeThread | null {
  const row = getDb().prepare("SELECT * FROM intake_threads WHERE id = ?").get(id) as
    | IntakeThreadRow
    | undefined;
  return row ? toThread(row) : null;
}

// 功能: 按 channel + external_user_id 查线程（入站时判断甲方是否已有线程）.
export function getIntakeThreadByExternal(
  channel: IntakeChannel,
  externalUserId: string
): IntakeThread | null {
  const row = getDb()
    .prepare("SELECT * FROM intake_threads WHERE channel = ? AND external_user_id = ?")
    .get(channel, externalUserId) as IntakeThreadRow | undefined;
  return row ? toThread(row) : null;
}

// 功能: 按 task_id 反查线程（出站时 task->reviewing 触发，判断是否 intake task）.
export function getIntakeThreadByTask(taskId: string): IntakeThread | null {
  const row = getDb().prepare("SELECT * FROM intake_threads WHERE task_id = ?").get(taskId) as
    | IntakeThreadRow
    | undefined;
  return row ? toThread(row) : null;
}

// 功能: 甲方新消息进来时刷新 last_inbound_at + 重置 48h 窗口计数.
// 关注点: 甲方每发一条就重置窗口（企微规则：用户发消息后 48h/5条 重新计）.
export function markInbound(threadId: string): void {
  getDb()
    .prepare(
      "UPDATE intake_threads SET last_inbound_at = ?, msg_sent_in_window = 0 WHERE id = ?"
    )
    .run(new Date().toISOString(), threadId);
}

// 功能: 出站发了一条消息后计数 +1.
export function incrementSentCount(threadId: string): void {
  getDb()
    .prepare(
      "UPDATE intake_threads SET msg_sent_in_window = msg_sent_in_window + 1 WHERE id = ?"
    )
    .run(threadId);
}
