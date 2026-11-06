// POST /api/tasks/[id]/user-dialog - Resolve a pending user dialog (e.g. AskUserQuestion)
// Body: { request_id: string, answers?: { [question: string]: string }, cancelled?: boolean, feedback?: string }

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const body = await request.json();

  if (!body.request_id) {
    return NextResponse.json({ error: "request_id is required" }, { status: 400 });
  }

  if (body.cancelled && typeof body.cancelled !== "boolean") {
    return NextResponse.json({ error: "cancelled must be a boolean" }, { status: 400 });
  }

  if (
    body.cancelled !== true &&
    (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))
  ) {
    return NextResponse.json(
      { error: "answers (object) is required when not cancelled" },
      { status: 400 }
    );
  }

  try {
    getRuntime().resolveUserDialog(id, body.request_id, {
      answers: body.answers,
      cancelled: body.cancelled,
      feedback: body.feedback,
    });
    return NextResponse.json({
      ok: true,
      request_id: body.request_id,
      cancelled: !!body.cancelled,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
