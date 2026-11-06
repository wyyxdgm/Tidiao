// Session CRUD operations

import { getDb } from "./index";
import type { Session } from "../runtime/types";

export function createSession(session: {
  id: string;
  task_id?: string;
  cwd?: string | null;
  title?: string;
  forked_from?: string | null;
  tags?: string[];
  source_message_id?: string | null;
}): Session {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, task_id, forked_from, cwd, title, tags, source_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    session.id,
    session.task_id || null,
    session.forked_from || null,
    session.cwd || null,
    session.title || null,
    session.tags ? JSON.stringify(session.tags) : null,
    session.source_message_id || null,
  );

  return getSessionById(session.id)!;
}

export function getSessionById(id: string): Session | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  return (stmt.get(id) as Session) || null;
}

export function getSessionsByTaskId(taskId: string): Session[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at DESC");
  return stmt.all(taskId) as Session[];
}

export function updateSessionCost(id: string, costUsd: number): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE sessions SET cost_usd = ?, updated_at = datetime('now') WHERE id = ?
  `);
  stmt.run(costUsd, id);
}

export function updateSessionStatus(id: string, status: Session["status"]): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?
  `);
  stmt.run(status, id);
}

// Mark a session row as forked — sets forked_from + forked_at + status.
export function markSessionForked(
  id: string,
  parentSessionId: string,
  sourceMessageId?: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions
    SET status = 'forked',
        forked_from = ?,
        forked_at = datetime('now'),
        source_message_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(parentSessionId, sourceMessageId || null, id);
}
