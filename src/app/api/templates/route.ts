// GET /api/templates - List templates (scoped to current user)
// POST /api/templates - Create template (owner = current user from session)

import { NextRequest, NextResponse } from "next/server";
import { listTemplates, createTemplate } from "@/lib/db/templates";
import type { TemplateDefinition } from "@/lib/db/templates";
import { requireExistingUser } from "@/lib/auth-user-exists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(listTemplates(userId));
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const body = await request.json();

  const def: TemplateDefinition = {
    name: body.name,
    prompt: body.prompt,
    description: body.description,
    model: body.model,
    llm_config_id: body.llm_config_id ?? null,
    allowedTools: body.allowedTools,
    maxTurns: body.maxTurns,
    effort: body.effort,
    autoApprove: body.autoApprove,
    tags: body.tags,
    ownerId: userId,
  };

  if (!def.name || !def.prompt) {
    return NextResponse.json(
      { error: "name and prompt are required" },
      { status: 400 }
    );
  }

  const template = createTemplate(def);
  return NextResponse.json(template, { status: 201 });
}
