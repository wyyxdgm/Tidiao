// POST /api/templates/[id]/instantiate - Create a task from a template
// Template must be owned by the current user; the target project must also be
// owned by the current user (404 otherwise).

import { NextRequest, NextResponse } from "next/server";
import { getTemplateById } from "@/lib/db/templates";
import { getProjectById } from "@/lib/db/projects";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { TaskLocationError } from "@/lib/db/tasks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const template = getTemplateById(id, userId);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const body = await request.json();

  // The target project must be owned by the current user (no existence leak).
  if (typeof body.project_id !== "string" || !getProjectById(body.project_id, userId)) {
    return NextResponse.json(
      { error: "Project not found", code: "PROJECT_NOT_FOUND" },
      { status: 404 }
    );
  }

  // Template fields as defaults, body overrides
  const def = {
    title: body.title || template.name,
    prompt: body.prompt || template.prompt,
    description: body.description || template.description || undefined,
    model: body.model || template.model || undefined,
    allowedTools: body.allowedTools || (template.allowed_tools ? JSON.parse(template.allowed_tools) : undefined),
    maxTurns: body.maxTurns || template.max_turns || undefined,
    effort: body.effort || template.effort || undefined,
    auto_approve: body.autoApprove ?? (template.auto_approve === 1),
    tags: body.tags || (template.tags ? JSON.parse(template.tags) : undefined),
    dependsOn: body.dependsOn,
    project_id: body.project_id,
    version_id: body.version_id,
  };

  try {
    const task = getRuntime().createTask(def);
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    if (err instanceof TaskLocationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
