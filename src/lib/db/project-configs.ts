// 功能: project_configs 表 CRUD — 每个 project 自己的 KV 配置 (AES-256-GCM 加密存).
// 关注点: 所有 value 一律加密存 (caller 用 key 命名区分敏感/非敏感); 解密失败一律
//   视作 null + console.warn (不抛), 因为 ENCRYPTION_KEY 切换 / 旧密文损坏不应该
//   让 API 500. 写路径必须 upsert (ON CONFLICT) — 同样 key 二次写是覆盖语义.

import { getDb } from "./index";
import { encrypt, decrypt } from "@/lib/crypto";

export interface ProjectConfigEntry {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

// 功能: 列出某 project 的所有 config key (不含 value).
// 关注点: 不解密 — 只返 key 列表, 防 API 一把返回所有明文.
export function listProjectConfigKeys(projectId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT key FROM project_configs WHERE project_id = ? ORDER BY key")
    .all(projectId) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

// 功能: 读单条 config (明文 value). 不存在或解密失败返 null.
export function getProjectConfig(
  projectId: string,
  key: string
): ProjectConfigEntry | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT key, encrypted_value, iv, tag, updated_at, updated_by FROM project_configs WHERE project_id = ? AND key = ?"
    )
    .get(projectId, key) as
    | {
        key: string;
        encrypted_value: string;
        iv: string;
        tag: string;
        updated_at: string;
        updated_by: string | null;
      }
    | undefined;
  if (!row) return null;
  try {
    const value = decrypt(row.encrypted_value, row.iv, row.tag);
    return {
      key: row.key,
      value,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  } catch (err) {
    console.warn(
      `[project-configs] decrypt failed for ${projectId}/${key}:`,
      (err as Error).message
    );
    return null;
  }
}

// 功能: 写一条 config (upsert). updatedBy 记入 updated_by 字段.
export function setProjectConfig(
  projectId: string,
  key: string,
  value: string,
  updatedBy: string
): ProjectConfigEntry {
  const db = getDb();
  const { encrypted, iv, tag } = encrypt(value);
  db.prepare(
    `INSERT INTO project_configs (project_id, key, encrypted_value, iv, tag, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(project_id, key) DO UPDATE SET
       encrypted_value = excluded.encrypted_value,
       iv = excluded.iv,
       tag = excluded.tag,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`
  ).run(projectId, key, encrypted, iv, tag, updatedBy);
  return {
    key,
    value,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
}

// 功能: 删一条 config. 返 true = 真删了, false = 不存在.
export function deleteProjectConfig(projectId: string, key: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM project_configs WHERE project_id = ? AND key = ?")
    .run(projectId, key);
  return result.changes > 0;
}