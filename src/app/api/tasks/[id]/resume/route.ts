// POST /api/tasks/[id]/resume - Resume a paused task

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { parseRunOpts } from "@/lib/runtime/active-session";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  let body: unknown = undefined;
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  try {
    const opts = parseRunOpts(body);
    getRuntime().resumeTask(id, opts, "manual_resume");
    // Read real status - see start/route.ts for why we don't hardcode "queued".
    const task = getTaskById(id, userId);
    return NextResponse.json({ ok: true, status: task?.status || "queued" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
