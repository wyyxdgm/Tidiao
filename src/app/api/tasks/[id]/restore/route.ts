// POST /api/tasks/[id]/restore - Restore a soft-deleted task

import { NextRequest, NextResponse } from "next/server";
import { getTaskById, restoreTask } from "@/lib/db/tasks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate: check with includeDeleted so we can find soft-deleted tasks.
  const task = getTaskById(id, userId, { includeDeleted: true });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (!task.deleted_at) {
    return NextResponse.json({ error: "Task is not deleted" }, { status: 409 });
  }
  const restored = restoreTask(id);
  if (!restored) {
    return NextResponse.json({ error: "Restore failed" }, { status: 500 });
  }
  return NextResponse.json(restored);
}
