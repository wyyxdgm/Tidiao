// POST /api/tasks/[id]/notify-dependents
// Body: { message?: string }
// Triggers task.dependency_changed webhook to all subscribers, listing tasks that
// directly depend on this one. Use when a root requirement/design changes and
// downstream tasks need to be informed or re-evaluated.

import { NextRequest, NextResponse } from "next/server";
import { getTaskById, getDependentTaskIds } from "@/lib/db/tasks";
import { dispatchDependencyChangeWebhook } from "@/lib/webhooks/dispatcher";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let message: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    if (body && typeof body.message === "string") message = body.message;
  } catch {
    // empty body is fine
  }

  const { id } = await params;
  const root = getTaskById(id, userId);
  if (!root) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const dependentIds = getDependentTaskIds(id);
  // Only notify dependents the caller owns.
  const dependents = dependentIds
    .map((depId) => getTaskById(depId, userId))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  dispatchDependencyChangeWebhook(root, dependents, message);

  return NextResponse.json({
    ok: true,
    root_task_id: id,
    notified_count: dependents.length,
    dependent_ids: dependentIds,
  });
}
