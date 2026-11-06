// PATCH  /api/idea-nodes/[id] - 更新节点（title/detail/status/pos_x/pos_y/sort_key；body.deps 存在则整组替换依赖）
// DELETE /api/idea-nodes/[id] - 删节点（任务弱引用置 NULL，依赖边清理）

import { NextRequest, NextResponse } from "next/server";
import { updateIdeaNode, deleteIdeaNode, setNodeDeps, getIdeaNode } from "@/lib/db/ideas";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const { deps, ...fields } = body;
    if (Array.isArray(deps)) {
      const node = setNodeDeps(id, userId, deps);
      if (!node) {
        return NextResponse.json({ error: "Node not found", code: "NODE_NOT_FOUND" }, { status: 404 });
      }
    }
    const node = updateIdeaNode(id, userId, fields);
    if (!node) {
      return NextResponse.json({ error: "Node not found", code: "NODE_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json(node);
  } catch (err: any) {
    if (err?.code && ["DEP_SELF", "DEP_CROSS_IDEA", "DEP_CYCLE", "STATUS_INVALID"].includes(err.code)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
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
  const ok = deleteIdeaNode(id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Node not found", code: "NODE_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
