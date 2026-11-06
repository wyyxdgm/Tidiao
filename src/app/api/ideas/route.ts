// GET  /api/ideas - 列构思（含 node/task/signal 计数 + 球间关联边，画布一次拉全）
// POST /api/ideas - 建构思（可带 hypothesis/success_criteria/deadline，假设-验证回路入口）
//
// idea-canvas P0 (docs/plans/idea-canvas.md §3 v520 + §6). 多租户硬隔离 owner_id.

import { NextRequest, NextResponse } from "next/server";
import {
  createIdea,
  listIdeas,
  listIdeaLinks,
  IDEA_STATUSES,
  type IdeaStatus,
} from "@/lib/db/ideas";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ideas = listIdeas(userId);
  const links = listIdeaLinks(userId);
  return NextResponse.json({ ideas, links });
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
  if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json(
      { error: "title is required", code: "TITLE_REQUIRED" },
      { status: 400 }
    );
  }
  if (body.status !== undefined && !IDEA_STATUSES.includes(body.status as IdeaStatus)) {
    return NextResponse.json(
      { error: `status must be one of ${IDEA_STATUSES.join("|")}`, code: "STATUS_INVALID" },
      { status: 400 }
    );
  }
  for (const field of ["hypothesis", "success_criteria", "description"] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
      return NextResponse.json(
        { error: `${field} must be string or null`, code: `${field.toUpperCase()}_INVALID` },
        { status: 400 }
      );
    }
  }
  if (body.deadline !== undefined && body.deadline !== null && Number.isNaN(Date.parse(body.deadline))) {
    return NextResponse.json(
      { error: "deadline must be a parseable date", code: "DEADLINE_INVALID" },
      { status: 400 }
    );
  }
  const idea = createIdea({
    owner_id: userId,
    title: body.title.trim(),
    description: body.description ?? null,
    status: body.status,
    hypothesis: body.hypothesis ?? null,
    success_criteria: body.success_criteria ?? null,
    deadline: body.deadline ?? null,
    project_id: body.project_id ?? null,
  });
  return NextResponse.json(idea, { status: 201 });
}
