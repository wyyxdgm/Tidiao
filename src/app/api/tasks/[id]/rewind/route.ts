// POST /api/tasks/[id]/rewind - Rewind files to a specific message state
// Body: { user_message_id: string, dry_run?: boolean }

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

  if (!body.user_message_id) {
    return NextResponse.json({ error: "user_message_id is required" }, { status: 400 });
  }

  try {
    const result = await getRuntime().rewindFiles(id, body.user_message_id, body.dry_run);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
