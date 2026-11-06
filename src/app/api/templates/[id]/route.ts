// GET /api/templates/[id] - Get template (owner-scoped)
// PATCH /api/templates/[id] - Update template (owner-scoped)
// DELETE /api/templates/[id] - Delete template (owner-scoped)

import { NextRequest, NextResponse } from "next/server";
import { getTemplateById, deleteTemplate, updateTemplate } from "@/lib/db/templates";

export async function GET(
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
  return NextResponse.json(template);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const template = updateTemplate(id, userId, {
    name: body.name,
    description: body.description,
    prompt: body.prompt,
    model: body.model,
    llm_config_id: body.llm_config_id,
    allowedTools: body.allowedTools,
    maxTurns: body.maxTurns,
    effort: body.effort,
    autoApprove: body.autoApprove,
    tags: body.tags,
  });
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  return NextResponse.json(template);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!deleteTemplate(id, userId)) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
