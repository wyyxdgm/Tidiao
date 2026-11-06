// GET /api/config-snapshots - List snapshots (owner-scoped)
//   ?project=X&version=Y -> applicable snapshots (global + this project + this version), most-specific first
//   no params -> all snapshots owned by the current user
// POST /api/config-snapshots - Create snapshot (owner = current user; project/version scope requires owning the project)

import { NextRequest, NextResponse } from "next/server";
import {
  listConfigSnapshots,
  listApplicableSnapshots,
  createConfigSnapshot,
} from "@/lib/db/config-snapshots";
import type { ConfigSnapshotDefinition, SnapshotScope } from "@/lib/db/config-snapshots";
import { getProjectById } from "@/lib/db/projects";
import { requireExistingUser } from "@/lib/auth-user-exists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project");
  const version = searchParams.get("version");

  if (project || version) {
    return NextResponse.json(listApplicableSnapshots(project, version, userId));
  }
  return NextResponse.json(listConfigSnapshots(userId));
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

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
    ownerId: userId,
  };

  if (!def.name || !def.scope) {
    return NextResponse.json({ error: "name and scope are required" }, { status: 400 });
  }

  // A project/version-scoped snapshot must bind to a project owned by the
  // current user (no existence leak). Global snapshots need no project.
  if (def.scope !== "global") {
    if (typeof def.projectId !== "string" || !getProjectById(def.projectId, userId)) {
      return NextResponse.json(
        { error: "Project not found", code: "PROJECT_NOT_FOUND" },
        { status: 404 }
      );
    }
  }

  try {
    const snapshot = createConfigSnapshot(def);
    return NextResponse.json(snapshot, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
