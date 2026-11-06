// POST /api/tasks/[id]/evaluate - Score a completed/rejected task 1-5.
// Body: { event: 'approved'|'rejected', score: 1-5, note?: string }

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import { createEval } from "@/lib/db/evals";
import { dispatchEvaluatedWebhook } from "@/lib/webhooks/dispatcher";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json();

  // Validate the task is in an evaluable state (and owned by the caller).
  const task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.status !== "completed" && task.status !== "rejected") {
    return NextResponse.json(
      { error: `Task must be completed or rejected to evaluate (current: ${task.status})` },
      { status: 400 }
    );
  }

  // score 1-5
  if (!Number.isInteger(body.score) || body.score < 1 || body.score > 5) {
    return NextResponse.json({ error: "score must be integer 1-5" }, { status: 400 });
  }

  // event matches the status_change that prompted the eval
  const event = task.status === "completed" ? "approved" : "rejected";
  if (body.event && body.event !== event) {
    return NextResponse.json(
      { error: `event mismatch: task is ${task.status}, expected event=${event}` },
      { status: 400 }
    );
  }

  try {
    const evalRow = createEval({
      task_id: id,
      event,
      score: body.score,
      note: typeof body.note === "string" ? body.note : undefined,
    });
    // Notify subscribers (optional, controlled by webhook subscription).
    dispatchEvaluatedWebhook(task, evalRow.score, evalRow.note ?? undefined);
    return NextResponse.json(evalRow, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}