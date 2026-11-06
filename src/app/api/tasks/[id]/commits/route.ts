// GET /api/tasks/[id]/commits
//
// R113 (2026-09-07): data model reshaped from "task chain + checkpoint
//   snapshots" to a real git log view. Each row in the response is one
//   agent-emitted <git commit-id="..." desc="..." files="..."/> marker,
//   upserted into task_commits by active-session.ts transcript parser.
//
//   - this task's own commits
//   - all fork-descendant tasks' commits (recurse by forked_from_session_id)
//   - merged into a single commit-log list, newest first
//
//   If neither this task nor any descendant emitted any <git/> markers,
//   the response is `{ entries: [] }` and the UI renders "区间内无 commit".
//   R158 (damo 2026-09-26): auto-collect at agent exit closes the marker gap
//   for most tasks. Endpoints /api/tasks/[id]/collect-commits lets damo
//   manually backfill pre-R158 completed tasks whose task_commits is empty.

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import { getDb } from "@/lib/db/index";
import { getTaskCommitsByTaskId } from "@/lib/db/task-commits";
import type { CommitLogEntry } from "@/lib/db/task-commits";

interface CommitWithTask {
  task_id: string;
  task_title: string;
  commit_id: string;
  desc: string | null;
  files_json: string | null;
  created_at: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId, { includeDeleted: true });
  if (!task) return NextResponse.json({ error: `Task ${id} not found` }, { status: 404 });

  // Walk forward: this task + every task that forked from this task's session_id.
  // Same CTE shape as before — we now collect (task_id, task_title) for each
  // descendant so the UI can attribute commits to the task that emitted them.
  const db = getDb();
  const descendants = db
    .prepare(
      `WITH RECURSIVE chain(id, title, session_id, forked_from_session_id) AS (
         SELECT id, title, session_id, forked_from_session_id
         FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.title, t.session_id, t.forked_from_session_id
         FROM tasks t JOIN chain c ON t.forked_from_session_id = c.session_id
         WHERE t.session_id != c.session_id
       )
       SELECT id, title FROM chain`,
    )
    .all(id) as Array<{ id: string; title: string }>;

  // Fetch commits for each descendant task. N roundtrips is acceptable
  // here because fork chains are short (< 10 in practice) and this endpoint
  // is called on panel open / refresh, not per-keystroke.
  //
  // R113 schema change: we previously returned `task_id + checkpoints[]`
  // per descendant (with task_card-shape). Now we return one row per
  // commit, merged across all descendants. UI is responsible for the
  // "git log" presentation (commit_id[0:7] + desc + date + click to expand
  // files list).
  const entries: CommitLogEntry[] = [];
  for (const row of descendants) {
    const taskCommits = getTaskCommitsByTaskId(row.id);
    for (const c of taskCommits) {
      entries.push({
        ...c,
        // Inject task_id for UI attribution. Keep raw created_at + commit_id
        // verbatim from the row; the helper already expanded files.
      });
    }
  }

  // Cross-task ordering: newest first by created_at, commit_id tiebreak for
  // stable order when timestamps collide (SQLite datetime() granularity =
  // 1 second, so two commits in the same second need a deterministic order).
  entries.sort((a, b) => {
    const ta = a.created_at.localeCompare(b.created_at);
    if (ta !== 0) return -ta; // DESC
    return a.commit_id.localeCompare(b.commit_id);
  });

  // For the UI to render the "forked from this task" topology hint at the
  // top of the panel, we also return the list of descendant task_ids +
  // titles. The UI hides this behind a small collapsed section by default
  // — the main flow is the commit log.
  const descendantTasks = descendants.map((d) => ({ task_id: d.id, task_title: d.title }));

  return NextResponse.json({
    root_task_id: id,
    depth: descendants.length,
    entries,
    descendant_tasks: descendantTasks,
  });
}
