// GET /api/config-snapshots/[id] - Get snapshot (owner-scoped)
// PUT /api/config-snapshots/[id] - Update snapshot (owner-scoped; new project/version scope requires owning the project)
// DELETE /api/config-snapshots/[id] - Delete snapshot (owner-scoped)

import { NextRequest, NextResponse } from "next/server";
import {
  getConfigSnapshotById,
  updateConfigSnapshot,
  deleteConfigSnapshot,
} from "@/lib/db/config-snapshots";
import type { ConfigSnapshotDefinition, SnapshotScope } from "@/lib/db/config-snapshots";
import { getProjectById } from "@/lib/db/projects";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const snapshot = getConfigSnapshotById(id, userId);
  if (!snapshot) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json();

  const def: ConfigSnapshotDefinition = {
    name: body.name,
    description: body.description,
    scope: body.scope as SnapshotScope,
    projectId: body.projectId,
    versionId: body.versionId,
    model: body.model,
    effort: body.effort,
    maxTurns: body.maxTurns,
    autoApprove: body.autoApprove,
    allowedTools: body.allowedTools,
    tags: body.tags,
    type: body.type,
    llmConfigId: body.llm_config_id,
  };

  if (!def.name || !def.scope) {
    return NextResponse.json({ error: "name and scope are required" }, { status: 400 });
  }

  // A project/version-scoped snapshot must bind to a project owned by the
  // current user (no existence leak).
  if (def.scope !== "global") {
    if (typeof def.projectId !== "string" || !getProjectById(def.projectId, userId)) {
      return NextResponse.json(
        { error: "Project not found", code: "PROJECT_NOT_FOUND" },
        { status: 404 }
      );
    }
  }

  try {
    const snapshot = updateConfigSnapshot(id, def, userId);
    if (!snapshot) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
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
  if (!deleteConfigSnapshot(id, userId)) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
