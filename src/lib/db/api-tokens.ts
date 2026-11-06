// API token metadata CRUD - see src/lib/db/index.ts (migration v25) for schema.
// The token itself is a stateless JWT (src/lib/auth.ts); this table only holds
// metadata for the management UI (list/create/delete). No token_hash: the JWT
// signature is the proof, so there's nothing secret to store here.

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: string;
}

/** Safe shape for API responses - identical to the row (no secret column). */
export type SafeApiToken = ApiTokenRow;

export function toSafeApiToken(row: ApiTokenRow): SafeApiToken {
  return { ...row };
}

export function createApiToken(
  userId: string,
  name: string,
  prefix: string
): ApiTokenRow {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO api_tokens (id, user_id, name, prefix) VALUES (?, ?, ?, ?)
  `).run(id, userId, name, prefix);
  return getApiTokenById(userId, id)!;
}

export function listApiTokens(userId: string): ApiTokenRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId) as ApiTokenRow[];
}

export function getApiTokenById(
  userId: string,
  id: string
): ApiTokenRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM api_tokens WHERE id = ? AND user_id = ?`)
    .get(id, userId) as ApiTokenRow | undefined;
  return row ?? null;
}

/** Look up a token row by (user, name). Used by login/switch to reuse the
 *  well-known "switch-account" token rather than mint a new one every login. */
export function getApiTokenByName(
  userId: string,
  name: string
): ApiTokenRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM api_tokens WHERE user_id = ? AND name = ?`)
    .get(userId, name) as ApiTokenRow | undefined;
  return row ?? null;
}

/** Delete a token metadata row. Returns true if a row was removed. */
export function deleteApiToken(userId: string, id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return res.changes > 0;
}

/** Bulk delete token metadata rows. Returns the number actually removed.
 * 关注点: ids 为空返回 0（路由层应已挡 400）；跨用户 id 静默忽略，不报错；
 *          单条 SQL + 动态占位符保证 IN(...) 不会因 ids 含奇怪字符而注入。 */
export function deleteApiTokens(userId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const res = db
    .prepare(
      `DELETE FROM api_tokens WHERE user_id = ? AND id IN (${placeholders})`
    )
    .run(userId, ...ids);
  return res.changes;
}
