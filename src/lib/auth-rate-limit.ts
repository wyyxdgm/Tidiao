// SQLite-persisted brute-force protection for the auth endpoints.
//
// No new dependencies - uses the existing better-sqlite3 handle (getDb). State
// lives in `auth_attempts` (migration v18), so a locked identifier stays locked
// across server restarts. The rate-limit key (`identifier`) is namespaced by
// the caller per action ("login:<email>" / "register:<email>"), keeping login
// and register counters independent.
//
// Strategy: identifier = lowercased email (limit per account, the main brute-
// force / credential-stuffing threat). IP-based limiting as a second layer is
// NOT implemented here - the table stores `ip` for audit, so it can be layered
// on later without a migration. See docs/phase-1-progress.md 决策记录.

import { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db";

export interface RateLimitConfig {
  /** Deny once this many failures accumulate inside the window. */
  maxAttempts: number;
  /** Sliding-window size in minutes. */
  windowMinutes: number;
}

// Login: 5 failures -> locked 15 min (sliding window). bt trusted-team deploy;
// tight enough to stop sustained credential stuffing, loose enough for the
// occasional fat-fingered password.
export const LOGIN_LIMIT: RateLimitConfig = { maxAttempts: 5, windowMinutes: 15 };

// Register: looser - 10 failures -> locked 60 min. Register "failures" are
// repeated attempts on an already-registered email (409). First-time successful
// registrations don't count (success rows are excluded by the failure query).
export const REGISTER_LIMIT: RateLimitConfig = { maxAttempts: 10, windowMinutes: 60 };

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest failing attempt exits the window (only when denied). */
  retryAfter?: number;
}

/**
 * Count failures for `identifier` within the sliding window. Deny (return
 * allowed=false + retryAfter) once failures >= config.maxAttempts. Successful
 * attempts (success=1) are stored but excluded from the count.
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = LOGIN_LIMIT
): RateLimitResult {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c, MIN(created_at) AS oldest
       FROM auth_attempts
       WHERE identifier = ? AND success = 0
         AND created_at >= datetime('now', ?)`
    )
    .get(identifier, `-${config.windowMinutes} minutes`) as
    | { c: number; oldest: string | null }
    | undefined;

  const count = row?.c ?? 0;
  if (count < config.maxAttempts) {
    return { allowed: true };
  }

  // Locked. retryAfter = seconds until the oldest in-window failure ages out.
  let retryAfter = config.windowMinutes * 60;
  if (row?.oldest) {
    const oldestMs = Date.parse(row.oldest.replace(" ", "T") + "Z");
    if (!Number.isNaN(oldestMs)) {
      const windowMs = config.windowMinutes * 60 * 1000;
      const remaining = Math.ceil((oldestMs + windowMs - Date.now()) / 1000);
      if (remaining > 0) retryAfter = remaining;
    }
  }
  return { allowed: false, retryAfter };
}

/** Persist one attempt. Call after the auth outcome is known. */
export function recordAttempt(
  identifier: string,
  ip: string | null,
  success: boolean
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO auth_attempts (id, identifier, ip, success) VALUES (?, ?, ?, ?)`
  ).run(uuidv4(), identifier, ip, success ? 1 : 0);
}

/** Drop all attempts for `identifier` (used on successful login to reset the
 *  failure counter so the user can retry immediately). */
export function clearAttempts(identifier: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM auth_attempts WHERE identifier = ?`).run(identifier);
}

/** Best-effort client IP from x-forwarded-for (first hop) or request.ip. */
export function getClientIp(request: NextRequest): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const direct = (request as unknown as { ip?: string }).ip;
  return direct ?? null;
}
