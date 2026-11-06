// GET /api/tasks/[id]/checkpoints — list checkpoints for a task
// POST /api/tasks/[id]/checkpoints — write a manual checkpoint
//
// Manual checkpoints are useful when the agent forgets to emit a marker
// but the user wants to anchor a fork point (e.g. after a successful
// git commit the user wants to mark as a checkpoint). The POST anchors
// up_to_message_id to the session's last assistant message so the row can
// be forked via /api/tasks/{id}/fork-at-checkpoint; if the transcript
// can't be read or has no assistant message yet, it degrades to an
// anchor-only row (up_to_message_id=null).

import { NextRequest, NextResponse } from "next/server";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import path from "path";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { insertCheckpoint } from "@/lib/db/checkpoints";
import { getCurrentGitHead } from "@/lib/runtime/git";
import { ORCHESTRATOR_HOME } from "@/lib/constants";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate: a non-owner (or non-existent) task returns 404.
  if (!getTaskById(id, userId, { includeDeleted: true })) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  try {
    const checkpoints = getRuntime().getCheckpoints(id);
    return NextResponse.json(checkpoints);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId);
  if (!task) return NextResponse.json({ error: `Task ${id} not found` }, { status: 404 });
  if (!task.session_id) {
    return NextResponse.json({ error: "Task has no session_id yet" }, { status: 400 });
  }

  let body: { step?: string; summary?: string } = {};
  try {
    const text = await request.text();
    if (text.length > 0) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // step is a string tag (v46): accept any [A-Za-z0-9_-]{1,64} value from
  // the caller; fall back to the current ms timestamp as a string when the
  // user leaves the field empty (kept numeric to preserve prior UX of
  // "auto-generated step"). We deliberately do NOT validate the charset
  // here — the DB layer (step TEXT) is permissive; the agent-emitted path
  // is gated by the regex in active-session.ts instead.
  const step = typeof body.step === "string" && body.step.length > 0
    ? body.step
    : String(Date.now());

  // Anchor the checkpoint at the last assistant message so it can serve as
  // a fork point - fork-at-checkpoint requires up_to_message_id, and without
  // this manual checkpoints were fork-dead-ends (only agent-emitted
  // <checkpoint> markers carried a message id). Resolve the SDK session dir
  // with the same fallback ActiveSession uses when task.cwd is NULL.
  const sessionDir = task.cwd || (task.project_id
    ? path.join(ORCHESTRATOR_HOME, "projects", task.project_id, task.id)
    : path.join(ORCHESTRATOR_HOME, "workspace", task.id));

  let upToMessageId: string | null = null;
  try {
    const messages = await getSessionMessages(task.session_id, { dir: sessionDir });
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "assistant") {
        upToMessageId = messages[i].uuid;
        break;
      }
    }
  } catch (err) {
    console.warn(`[checkpoints] getSessionMessages failed for task ${id}:`, (err as Error).message);
  }

  try {
    // Anchor the manual checkpoint to the last assistant message so it can
    // serve as a fork point (fork-at-checkpoint requires up_to_message_id).
    // Resolve the same session dir the SDK used (matches AgentRuntime's
    // fallback when task.cwd is NULL). Degrade to anchor-only on any failure.
    let upToMessageId: string | null = null;
    try {
      const sessionDir = task.cwd || (task.project_id
        ? path.join(ORCHESTRATOR_HOME, "projects", task.project_id, task.id)
        : path.join(ORCHESTRATOR_HOME, "workspace", task.id));
      const messages = await getSessionMessages(task.session_id, { dir: sessionDir });
      const lastAssistant = [...messages].reverse().find((m) => m.type === "assistant");
      upToMessageId = lastAssistant?.uuid || null;
    } catch (err) {
      console.warn(
        `[checkpoints POST] failed to read session messages for task ${id}:`,
        (err as Error).message,
      );
    }

    const row = insertCheckpoint({
      task_id: id,
      session_id: task.session_id,
      step,
      summary: body.summary || null,
      by: null,
      status: null,
      commit_id: getCurrentGitHead(task.cwd || process.cwd()),
      transcript_slice: null,
      up_to_message_id: upToMessageId,
    });
    return NextResponse.json(row);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}