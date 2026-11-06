// Checkpoint CRUD operations
//
// A checkpoint is a git-like commit anchor within a task's transcript:
// it captures a step tag, a human-readable summary, the current git
// HEAD commit_id, and the transcript slice up to and including that
// assistant message. Combined with the SDK's standalone forkSession() API
// we can fork from any checkpoint into a brand-new session.
//
// step is a STRING tag, not a sequence number: accepts numeric ("1", "2")
// or semantic names ("final", "milestone-1"). Regex
// `[A-Za-z0-9_-]{1,64}` enforces the charset/length at parse time.
// Ordering is by created_at (not step value) so multiple `step=final`
// markers across chat turns each get their own row, in order.
//
// R108: 扩 by (agent / 上游标识) + status (reviewing 卡片细化子状态) 两可选
//   字段. 老 checkpoint 行 NULL, UI 视作无细化归属/状态 (向后兼容).
//
// Checkpoints are best-effort: parsing depends on the agent emitting
// <checkpoint step=... summary="..." by="..." status="..."/> markers in
// its output. Tasks that never emit a marker simply have no checkpoints.

import { getDb } from "./index";
import type { Checkpoint } from "../runtime/types";

export function insertCheckpoint(cp: Omit<Checkpoint, "id" | "created_at">): Checkpoint {
  const db = getDb();
  // ON CONFLICT (task_id, step, up_to_message_id): same step in the same
  // assistant message = replay/retry → overwrite (idempotent for replays
  // of the same transcript region). Same step in a DIFFERENT message =
  // distinct stage → new row. The up_to_message_id is nullable; SQLite
  // treats NULL as distinct in UNIQUE, so two anchor-only rows with
  // matching (task, step) but no message anchor are both kept.
  // R108: ON CONFLICT DO UPDATE 同步更新 by/status — 老 replay 重写时如果
  //   marker 带了新 by/status, 必须跟着覆盖, 不能让老 NULL 残留误导后续 UI.
  const stmt = db.prepare(`
    INSERT INTO checkpoints (task_id, session_id, step, summary, by, status, commit_id, transcript_slice, up_to_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, step, up_to_message_id) DO UPDATE SET
      summary = excluded.summary,
      by = excluded.by,
      status = excluded.status,
      commit_id = excluded.commit_id,
      transcript_slice = excluded.transcript_slice,
      up_to_message_id = excluded.up_to_message_id,
      created_at = datetime('now')
  `);
  stmt.run(
    cp.task_id,
    cp.session_id,
    cp.step,
    cp.summary || null,
    cp.by || null,
    cp.status || null,
    cp.commit_id || null,
    cp.transcript_slice || null,
    cp.up_to_message_id || null,
  );

  // Read back the row by its full unique key (task_id, step, up_to_message_id).
  const fetched = db
    .prepare(
      "SELECT * FROM checkpoints WHERE task_id = ? AND step = ? AND IFNULL(up_to_message_id, '') = IFNULL(?, '')"
    )
    .get(cp.task_id, cp.step, cp.up_to_message_id) as Checkpoint | undefined;
  if (!fetched) throw new Error("insertCheckpoint: failed to read back row");
  return fetched;
}

export function getCheckpointsByTaskId(taskId: string): Checkpoint[] {
  const db = getDb();
  // Order by created_at (with id as sub-second tiebreak), not by step.
  // step is a tag — "final" and "1" can't be compared; even purely
  // numeric steps order the same as their insertion order, which is
  // also their created_at order, so this is strictly more correct.
  return db
    .prepare(
      "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY datetime(created_at) ASC, id ASC"
    )
    .all(taskId) as Checkpoint[];
}

export function getCheckpointById(id: number): Checkpoint | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as Checkpoint) || null;
}

export function getLatestCheckpoint(taskId: string): Checkpoint | null {
  const db = getDb();
  return (
    (db
      .prepare(
        "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT 1"
      )
      .get(taskId) as Checkpoint) || null
  );
}