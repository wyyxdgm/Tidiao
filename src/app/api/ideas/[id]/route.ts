// GET    /api/ideas/[id] - 构思详情（idea + nodes DAG + signals + ROI 收益面板 + 挂的任务）
// PATCH  /api/ideas/[id] - 白名单字段更新（title/description/status/hypothesis/criteria/deadline/pinned/project_id）
// DELETE /api/ideas/[id] - 删构思（级联清 nodes/links/signals/pin 条目；任务弱引用置 NULL 不删任务）

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/index";
import {
  getIdea,
  updateIdea,
  deleteIdea,
  listIdeaNodes,
  listIdeaSignals,
  getIdeaROI,
  listIdeaLinks,
} from "@/lib/db/ideas";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const idea = getIdea(id, userId);
  if (!idea) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  const nodes = listIdeaNodes(id, userId);
  const signals = listIdeaSignals(id, userId);
  const roi = getIdeaROI(id, userId);
  const tasks = getDb()
    .prepare(
      `SELECT id, title, status, cost_usd, idea_id, node_id, work_class, created_at, completed_at
       FROM tasks WHERE idea_id = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
    )
    .all(id, userId);
  const links = listIdeaLinks(userId).filter(
    (l) => l.idea_id === id || l.linked_idea_id === id
  );
  return NextResponse.json({ idea, nodes, signals, roi, tasks, links });
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
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const idea = updateIdea(id, userId, body);
    if (!idea) {
      return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json(idea);
  } catch (err: any) {
    if (err?.code === "STATUS_INVALID") {
      return NextResponse.json({ error: err.message, code: "STATUS_INVALID" }, { status: 400 });
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
  const ok = deleteIdea(id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
