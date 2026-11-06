// GET    /api/idea-links - 全部球间关联（画布边集）
// POST   /api/idea-links - 加/更新关联 {idea_id, linked_idea_id, relation?, weight?}
// DELETE /api/idea-links?idea_id=&linked_idea_id= - 删关联

import { NextRequest, NextResponse } from "next/server";
import { addIdeaLink, removeIdeaLink, listIdeaLinks } from "@/lib/db/ideas";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ links: listIdeaLinks(userId) });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.idea_id || !body.linked_idea_id) {
    return NextResponse.json(
      { error: "idea_id and linked_idea_id are required", code: "IDS_REQUIRED" },
      { status: 400 }
    );
  }
  try {
    const ok = addIdeaLink(userId, body.idea_id, body.linked_idea_id, body.relation ?? "related", body.weight ?? 1);
    if (!ok) {
      return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err: any) {
    if (err?.code === "LINK_SELF") {
      return NextResponse.json({ error: err.message, code: "LINK_SELF" }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ideaId = new URL(request.url).searchParams.get("idea_id");
  const linkedId = new URL(request.url).searchParams.get("linked_idea_id");
  if (!ideaId || !linkedId) {
    return NextResponse.json({ error: "idea_id and linked_idea_id required", code: "IDS_REQUIRED" }, { status: 400 });
  }
  const ok = removeIdeaLink(userId, ideaId, linkedId);
  if (!ok) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
