// Channel config CRUD - 多渠道消息接入配置 (飞书 R184).
// 每行 = 一个渠道实例 (如一个 Telegram bot), 绑定一个 project, 持有渠道凭据.

import { v4 as uuidv4 } from "uuid";
import { randomBytes } from "node:crypto";
import { getDb } from "./index";
import { encrypt, decrypt } from "@/lib/crypto";
import { getRoleById } from "./roles";

interface ChannelConfigRow {
  id: string;
  channel: string;
  name: string;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  bound_project_id: string;
  bound_version_id: string | null;
  bind_code: string;
  webhook_secret: string | null;
  role_id: string | null;
  enabled: number;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelConfig {
  id: string;
  channel: string;
  name: string;
  secret: string | null;
  bound_project_id: string;
  bind_code: string;
  webhook_secret: string | null;
  bound_version_id: string | null; // v529: null = follow project current_version
  role_id: string | null; // 渠道默认角色 (v526, D3): intake 首 task 挂此 role; NULL = 未配
  enabled: boolean;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

function toConfig(row: ChannelConfigRow): ChannelConfig {
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    secret:
      row.secret_encrypted && row.secret_iv && row.secret_tag
        ? decrypt(row.secret_encrypted, row.secret_iv, row.secret_tag)
        : null,
    bound_project_id: row.bound_project_id,
    bind_code: row.bind_code,
    bound_version_id: row.bound_version_id ?? null,
    webhook_secret: row.webhook_secret,
    role_id: row.role_id ?? null,
    enabled: row.enabled === 1,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 功能: 校验渠道默认角色可用 (D3) —— role 存在且属渠道同 owner.
// 关注点: 调 roles.ts 现有查询 (getRoleById 带 userId 限定 owner), 不在渠道层复制 SQL;
//   失败抛 Error, 由调用方 (route 层) 转 4xx —— 与 createTask 的 role 校验同语义
//   (显式配了 role 但查不到 = 硬错误, 不静默回落 NULL).
function assertRoleUsable(roleId: string, ownerId: string): void {
  const role = getRoleById(roleId, ownerId);
  if (!role) {
    throw new Error(`Role ${roleId} not found for owner ${ownerId}`);
  }
}

/** 生成绑定码: 8 位大写字母数字, 去掉易混淆字符 (0/O/1/I). */
export function generateBindCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export interface CreateChannelConfigInput {
  channel: string;
  name: string;
  secret?: string;
  bound_project_id: string;
  owner_id: string;
  bound_version_id?: string | null;
  webhook_secret?: string;
  role_id?: string | null;
}

// 功能: 建渠道配置, bind_code 自动生成. 返回含明文 secret 的完整 config.
// 关注点: secret 加密落库; bind_code 冲突概率 ~38^8 可忽略, 不做重试;
//   role_id 传入时校验存在且属同 owner (v526 D3), 不合法直接抛错不落库.
export function createChannelConfig(input: CreateChannelConfigInput): ChannelConfig {
  const db = getDb();
  if (input.role_id) {
    assertRoleUsable(input.role_id, input.owner_id);
  }
  const id = `ch_${uuidv4()}`;
  const enc = input.secret ? encrypt(input.secret) : null;
  db.prepare(
    `INSERT INTO channel_configs
       (id, channel, name, secret_encrypted, secret_iv, secret_tag,
        bound_project_id, bound_version_id, bind_code, webhook_secret, role_id, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.channel,
    input.name,
    enc?.encrypted ?? null,
    enc?.iv ?? null,
    enc?.tag ?? null,
    input.bound_project_id,
    input.bound_version_id ?? null,
    generateBindCode(),
    input.webhook_secret ?? null,
    input.role_id ?? null,
    input.owner_id,
  );
  return getChannelConfigById(id)!;
}

export function getChannelConfigById(id: string): ChannelConfig | null {
  const row = getDb()
    .prepare("SELECT * FROM channel_configs WHERE id = ?")
    .get(id) as ChannelConfigRow | undefined;
  return row ? toConfig(row) : null;
}

export function getChannelConfigsByOwner(ownerId: string): ChannelConfig[] {
  const rows = getDb()
    .prepare("SELECT * FROM channel_configs WHERE owner_id = ? ORDER BY created_at DESC")
    .all(ownerId) as ChannelConfigRow[];
  return rows.map(toConfig);
}

export function listChannelConfigs(): ChannelConfig[] {
  const rows = getDb()
    .prepare("SELECT * FROM channel_configs ORDER BY created_at DESC")
    .all() as ChannelConfigRow[];
  return rows.map(toConfig);
}

// 功能: 按绑定码查启用的渠道配置 (Telegram inbound "bind <code>" 校验入口).
export function getChannelConfigByBindCode(code: string): ChannelConfig | null {
  const row = getDb()
    .prepare("SELECT * FROM channel_configs WHERE bind_code = ? AND enabled = 1")
    .get(code.toUpperCase()) as ChannelConfigRow | undefined;
  return row ? toConfig(row) : null;
}

export interface UpdateChannelConfigInput {
  name?: string;
  secret?: string;
  bound_project_id?: string;
  enabled?: boolean;
  webhook_secret?: string;
  rotate_bind_code?: boolean;
  role_id?: string | null;
  bound_version_id?: string | null;
}

// 功能: 更新配置. 关注点: secret 传 undefined = 不改; 传 null 或空串 = 清除凭据;
//   rotate_bind_code = true 换新绑定码 (旧码作废);
//   role_id 传 undefined = 不改; 传 null = 清除默认角色; 传 string = 设置 (校验存在且属同 owner).
export function updateChannelConfig(id: string, input: UpdateChannelConfigInput): ChannelConfig | null {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (input.name !== undefined) { sets.push("name = ?"); vals.push(input.name); }
  if (input.secret !== undefined) {
    if (input.secret) {
      const enc = encrypt(input.secret);
      sets.push("secret_encrypted = ?", "secret_iv = ?", "secret_tag = ?");
      vals.push(enc.encrypted, enc.iv, enc.tag);
    } else {
      sets.push("secret_encrypted = NULL", "secret_iv = NULL", "secret_tag = NULL");
    }
  }
  if (input.bound_project_id !== undefined) { sets.push("bound_project_id = ?"); vals.push(input.bound_project_id); }
  if (input.enabled !== undefined) { sets.push("enabled = ?"); vals.push(input.enabled ? 1 : 0); }
  if (input.webhook_secret !== undefined) { sets.push("webhook_secret = ?"); vals.push(input.webhook_secret); }
  if (input.role_id !== undefined) {
    if (input.role_id) {
      // 行 owner 优先于任何入参 (渠道行的归属不随 update 改变), 跨 owner role 拒绝.
      const existing = getChannelConfigById(id);
      if (!existing) return null;
      assertRoleUsable(input.role_id, existing.owner_id);
    }
    sets.push("role_id = ?");
    vals.push(input.role_id);
  }
  // bound_version_id (v529): undefined = keep; null/"" = clear; string = set.
  // Version-ownership check (version must belong to bound_project_id) lives in the route layer.
  if (input.bound_version_id !== undefined) {
    sets.push("bound_version_id = ?");
    vals.push(input.bound_version_id || null);
  }
  if (input.rotate_bind_code) { sets.push("bind_code = ?"); vals.push(generateBindCode()); }

  if (sets.length === 0) return getChannelConfigById(id);

  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE channel_configs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getChannelConfigById(id);
}

export function deleteChannelConfig(id: string): void {
  getDb().prepare("DELETE FROM channel_configs WHERE id = ?").run(id);
}
