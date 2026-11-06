// Runner registry CRUD — see src/lib/db/index.ts for migration v51.
// Runner = a long-lived remote daemon (R2 = agent-orch-runner, Go) that
// the platform can dispatch commands to. R1 only ships the DB + auth surface;
// command execution is R3 (canUseTool 拦截).
//
// Auth: 256-bit shared secret, stored as three AES-256-GCM columns
// (auth_token_encrypted / auth_token_iv / auth_token_tag) via src/lib/crypto.ts.
// Token plaintext is returned ONCE on create() then discarded — verify is the
// only later access path, and it never stores or logs the plaintext.

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";

export const OS_TYPES = ["macos", "windows", "linux"] as const;
export type OsType = (typeof OS_TYPES)[number];

export const RUNNER_STATUSES = ["online", "offline", "dead"] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

export interface Runner {
  id: string;
  owner_id: string | null;
  name: string;
  host: string;
  port: number;
  os_type: OsType;
  capabilities: string | null;        // JSON: {shells, max_concurrent, ...}
  status: RunnerStatus;
  last_heartbeat_at: string | null;
  last_health_json: string | null;
  created_at: string;
  updated_at: string;
}

// Safe shape for API responses. Deliberately omits the three token columns —
// the plaintext is returned once from createRunner and never persisted in
// retrievable form.
export type SafeRunner = Omit<Runner, ""> & {
  // keep all columns; Runner interface doesn't include the secret columns to
  // begin with. Auth columns are internal-only and never selected by getRunner.
};

export interface CreateRunnerInput {
  name: string;
  host: string;
  port: number;
  os_type: OsType;
  ownerId?: string;
}

/**
 * Register a runner. Generates a 256-bit random token, encrypts it via
 * src/lib/crypto.ts, and returns {runner, token} where token is the plaintext.
 * The plaintext is only available in this call's return value — the caller is
 * responsible for showing it to the operator exactly once.
 *
 * 关注点:
 *   - UNIQUE (host, port) on the table → duplicate registration surfaces as a
 *     SQLite UNIQUE error. Route layer catches and translates to 409.
 *   - ENCRYPTION_KEY rotation makes these tokens invalid — heartbeat handler
 *     logs warn + marks runner 'dead' so operator knows to re-register. Same
 *     pattern as llm_configs (v22) and user_media_keys (v48).
 */
export function createRunner(input: CreateRunnerInput): { runner: Runner; token: string } {
  const db = getDb();
  const id = uuidv4();
  const token = randomBytes(32).toString("hex"); // 256-bit, 64-char hex
  const enc = encrypt(token);

  db.prepare(`
    INSERT INTO runners
      (id, owner_id, name, host, port, os_type,
       auth_token_encrypted, auth_token_iv, auth_token_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.ownerId ?? null,
    input.name,
    input.host,
    input.port,
    input.os_type,
    enc.encrypted,
    enc.iv,
    enc.tag
  );

  return { runner: getRunnerById(id)!, token };
}

/**
 * Fetch a runner by id without exposing auth columns. userId gates ownership
 * for non-admin callers; omit to fetch unconditionally (used by
 * verifyRunnerToken below, which already knows the id from the URL).
 */
export function getRunnerById(id: string, userId?: string): Runner | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, owner_id, name, host, port, os_type, capabilities, status,
              last_heartbeat_at, last_health_json, created_at, updated_at
       FROM runners WHERE id = ?${userId ? " AND owner_id = ?" : ""}`
    )
    .get(...(userId ? [id, userId] : [id])) as Runner | undefined;
  return row ?? null;
}

export function listRunners(userId?: string): Runner[] {
  const db = getDb();
  return (userId
    ? db
        .prepare(
          `SELECT id, owner_id, name, host, port, os_type, capabilities, status,
                  last_heartbeat_at, last_health_json, created_at, updated_at
           FROM runners WHERE owner_id = ? ORDER BY created_at DESC`
        )
        .all(userId)
    : db
        .prepare(
          `SELECT id, owner_id, name, host, port, os_type, capabilities, status,
                  last_heartbeat_at, last_health_json, created_at, updated_at
           FROM runners ORDER BY created_at DESC`
        )
        .all()) as Runner[];
}

export function deleteRunner(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM runners WHERE id = ?`).run(id);
  return res.changes > 0;
}

/**
 * Stamp status='online' + last_heartbeat_at=now. Called by heartbeat route
 * after a successful token verification.
 */
export function updateRunnerHeartbeat(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE runners SET status = 'online', last_heartbeat_at = datetime('now'),
            updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

/**
 * Mark a runner 'dead'. Used when:
 *   - Agent/manual explicitly kills it
 *   - Decrypt fails during heartbeat verification (likely ENCRYPTION_KEY drift)
 */
export function markRunnerDead(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE runners SET status = 'dead', updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

/**
 * Cache the JSON returned by runner's GET /v1/health. Free-form string; route
 * layer does the fetch and validates response shape before calling here.
 */
export function updateRunnerHealth(id: string, healthJson: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE runners SET last_health_json = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(healthJson, id);
}

/**
 * Look up the encrypted token columns and constant-time-compare against a
 * plaintext presented by the caller (typically via Authorization: Bearer).
 *
 * Returns false on:
 *   - Missing row
 *   - Decrypt failure (ENCRYPTION_KEY rotated, corrupt columns, malformed hex)
 *   - Plaintext mismatch
 *
 * Never throws on the decrypt path — callers (heartbeat route) depend on a
 * boolean answer; throwing would surface a 500 to the runner daemon and
 * confuse logs (operator needs the 401 + console.warn path to diagnose).
 *
 * 关注点: timingSafeEqual requires same-length Buffers. We early-return false
 * if lengths differ rather than throwing — the length difference itself
 * leaks a single bit but that bit (auth-token length) is constant per
 * deployment, so it's not exploitable here.
 */
export function verifyRunnerToken(id: string, presentedToken: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT auth_token_encrypted, auth_token_iv, auth_token_tag
       FROM runners WHERE id = ?`
    )
    .get(id) as
    | { auth_token_encrypted: string; auth_token_iv: string; auth_token_tag: string }
    | undefined;
  if (!row) return false;

  let plaintext: string;
  try {
    plaintext = decrypt(row.auth_token_encrypted, row.auth_token_iv, row.auth_token_tag);
  } catch {
    // decrypt failure: ENCRYPTION_KEY drift, corrupt columns, malformed hex.
    // Caller (heartbeat route) should console.warn + markRunnerDead.
    return false;
  }

  const a = Buffer.from(plaintext, "utf8");
  const b = Buffer.from(presentedToken, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Internal helper for tests + future admin paths that need the columns
// explicitly. Not exported via the public surface (no API route uses it).
export function _readRunnerAuthColumns(id: string): {
  encrypted: string;
  iv: string;
  tag: string;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT auth_token_encrypted, auth_token_iv, auth_token_tag
       FROM runners WHERE id = ?`
    )
    .get(id) as
    | { auth_token_encrypted: string; auth_token_iv: string; auth_token_tag: string }
    | undefined;
  return row
    ? {
        encrypted: row.auth_token_encrypted,
        iv: row.auth_token_iv,
        tag: row.auth_token_tag,
      }
    : null;
}

/**
 * Probe whether the runner's stored auth columns can be decrypted at all
 * (without exposing the plaintext). Used by the heartbeat route to
 * distinguish "presented token is wrong" (401, no DB change) from
 * "ENCRYPTION_KEY rotated / columns corrupt" (401, console.warn,
 * markRunnerDead) — verifyRunnerToken folds both into one boolean answer,
 * so this probe is the only way to surface the more serious case to ops.
 *
 * 关注点: 写坏的密文 (auth 列被改坏) 在生产里几乎只有 ENCRYPTION_KEY
 *   rotation 一种来源 —— 见 v22 llm_configs / v48 user_media_keys 的
 *   同样模式. heartbeat 路由应该把这种情况标 dead 而不是让它永远 offline,
 *   让 admin 在 UI 上看到就重 register.
 */
export function isRunnerDecryptable(id: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT auth_token_encrypted, auth_token_iv, auth_token_tag
       FROM runners WHERE id = ?`
    )
    .get(id) as
    | { auth_token_encrypted: string; auth_token_iv: string; auth_token_tag: string }
    | undefined;
  if (!row) return false;
  try {
    decrypt(row.auth_token_encrypted, row.auth_token_iv, row.auth_token_tag);
    return true;
  } catch {
    return false;
  }
}
