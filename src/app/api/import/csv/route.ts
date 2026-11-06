// POST /api/import/csv - Import tasks from CSV
// Target project must be owned by the current user (404 otherwise).

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { parseCsvImport } from "@/lib/import/parsers";
import { TaskLocationError, validateTaskLocation } from "@/lib/db/tasks";
import { getProjectById } from "@/lib/db/projects";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  // Ownership gate: the target project must be owned by the current user.
  if (typeof body.project_id !== "string" || !getProjectById(body.project_id, userId)) {
    return NextResponse.json(
      { error: "Project not found", code: "PROJECT_NOT_FOUND" },
      { status: 404 }
    );
  }

  let location: ReturnType<typeof validateTaskLocation>;
  try {
    location = validateTaskLocation(body.project_id, body.version_id);
  } catch (err) {
    if (err instanceof TaskLocationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }

  const content = body.content;
  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "content (string) is required" }, { status: 400 });
  }

  const { tasks, errors } = parseCsvImport(content);

  if (tasks.length === 0) {
    return NextResponse.json({ error: "No valid tasks found", errors }, { status: 400 });
  }

  const created = tasks.map((def) => getRuntime().createTask({ ...def, ...location }));

  return NextResponse.json({
    imported: created.length,
    task_ids: created.map((t) => t.id),
    errors: errors.length > 0 ? errors : undefined,
  });
}
