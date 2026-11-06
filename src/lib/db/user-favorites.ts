// User favorites — per-user "star" on tasks.
//
// 中间表 user_favorites (src/lib/db/index.ts v57), PK (user_id, task_id).
// 每个用户对每个 task 一行, UNIQUE 约束防重复. FK CASCADE 跟随 getDb() 的
// foreign_keys=ON: 删用户 / 删 task 自动清相关收藏, 无需应用层手动级联.
//
// 关注点:
//  - 不存 denormalize 字段到 tasks 表: 收藏是用户维度偏好, 与 task 本体正交.
//  - addFavorite 用 INSERT OR IGNORE 而非 ON CONFLICT DO NOTHING + RETURNING:
//    SQLite + better-sqlite3 的 RETURNING 不一致, IGNORE + read-back 更稳.
//  - listFavoriteTaskIds 走 idx_fav_user 索引, O(log n + page_size).
//  - isFavoriteByUser 单行查, idx_fav_user.user_id 部分命中, B 树 O(log n).

import { getDb } from "./index";

export interface UserFavorite {
  user_id: string;
  task_id: string;
  created_at: string;
}

/**
 * Add a favorite for (user, task). Idempotent: re-adding is a no-op
 * (returns the existing row's created_at). No error on UNIQUE conflict.
 *
 * Returns the (final) row. Caller does not need to handle the UNIQUE
 * conflict — this is the canonical entry point.
 */
export function addFavorite(userId: string, taskId: string): UserFavorite {
  const db = getDb();
  // FK target existence is checked lazily via the FK CASCADE at deletion
  // time, but we still want INSERT-time 404 semantics in API routes.
  // Application layer (API route) calls getTaskById first → 404 if missing.
  db.prepare(
    "INSERT OR IGNORE INTO user_favorites (user_id, task_id) VALUES (?, ?)"
  ).run(userId, taskId);

  const row = db
    .prepare(
      "SELECT user_id, task_id, created_at FROM user_favorites WHERE user_id = ? AND task_id = ?"
    )
    .get(userId, taskId) as UserFavorite | undefined;

  if (!row) {
    // Should not happen — INSERT OR IGNORE + SELECT WHERE always finds a
    // row or returns undefined only if FK blocked the INSERT. API route
    // is responsible for pre-checking task existence; throw here surfaces
    // any logic drift.
    throw new Error(
      `addFavorite: row missing after INSERT for user=${userId} task=${taskId}`
    );
  }
  return row;
}

/**
 * Remove a favorite for (user, task). Idempotent: removing a non-existent
 * favorite is a no-op (returns 0).
 */
export function removeFavorite(userId: string, taskId: string): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM user_favorites WHERE user_id = ? AND task_id = ?")
    .run(userId, taskId);
  return result.changes;
}

/**
 * List all task IDs this user has favorited. Ordered by created_at DESC
 * (most recently favorited first). Backed by idx_fav_user.
 */
export function listFavoriteTaskIds(userId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT task_id FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC"
    )
    .all(userId) as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

/**
 * List full favorite rows (with created_at) for this user. Useful for UI
 * that wants to show "favorited at" timestamps.
 */
export function listFavorites(userId: string): UserFavorite[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT user_id, task_id, created_at FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC"
    )
    .all(userId) as UserFavorite[];
}

/**
 * Single-row lookup: is (user, task) a favorite?
 * Returns false for non-existent task — caller should pre-check task
 * existence (404 vs favorite status are different concerns).
 */
export function isFavoriteByUser(userId: string, taskId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT 1 as hit FROM user_favorites WHERE user_id = ? AND task_id = ?"
    )
    .get(userId, taskId) as { hit: number } | undefined;
  return row?.hit === 1;
}

/**
 * Count of favorites for this user. Cheaper than listFavoriteTaskIds().length
 * when caller only wants the badge count.
 */
export function countFavorites(userId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?")
    .get(userId) as { c: number };
  return row.c;
}