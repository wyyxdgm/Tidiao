// POST /api/ideas/[id]/nodes - 建构思节点（可带 deps 同步设依赖）

import { NextRequest, NextResponse } from "next/server";
import { createIdeaNode, getIdea, listIdeaNodes } from "@/lib/db/ideas";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getIdea(id, userId)) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ nodes: listIdeaNodes(id, userId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getIdea(id, userId)) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json(
      { error: "title is required", code: "TITLE_REQUIRED" },
      { status: 400 }
    );
  }
  try {
    const node = createIdeaNode({
      idea_id: id,
      owner_id: userId,
      title: body.title.trim(),
      detail: body.detail ?? null,
      deps: Array.isArray(body.deps) ? body.deps : undefined,
      pos_x: typeof body.pos_x === "number" ? body.pos_x : null,
      pos_y: typeof body.pos_y === "number" ? body.pos_y : null,
    });
    return NextResponse.json(node, { status: 201 });
  } catch (err: any) {
    if (err?.code && ["DEP_SELF", "DEP_CROSS_IDEA", "DEP_CYCLE"].includes(err.code)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
