// GET /api/tasks/[id]/dependents - List tasks that depend on this task (reverse lookup)

import { NextRequest, NextResponse } from "next/server";
import { getTaskById, getDependentTaskIds } from "@/lib/db/tasks";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const root = getTaskById(id, userId, { includeDeleted: true });
  if (!root) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const dependentIds = getDependentTaskIds(id);
  // Only surface dependents the caller owns (dependents inherit the same owner
  // since dependencies are created within a user's own tasks).
  const dependents = dependentIds
    .map((depId) => getTaskById(depId, userId))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  return NextResponse.json({
    root_task_id: id,
    dependent_ids: dependentIds,
    dependents,
  });
}
