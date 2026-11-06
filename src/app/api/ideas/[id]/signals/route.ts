// POST /api/ideas/[id]/signals - 录反馈信号（咨询/注册/收入/审核/使用，归因挂回 idea）

import { NextRequest, NextResponse } from "next/server";
import {
  addIdeaSignal,
  listIdeaSignals,
  getIdea,
  IDEA_SIGNAL_KINDS,
  type IdeaSignalKind,
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
  if (!getIdea(id, userId)) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ signals: listIdeaSignals(id, userId) });
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
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!IDEA_SIGNAL_KINDS.includes(body.kind as IdeaSignalKind)) {
    return NextResponse.json(
      { error: `kind must be one of ${IDEA_SIGNAL_KINDS.join("|")}`, code: "KIND_INVALID" },
      { status: 400 }
    );
  }
  if (body.value !== undefined && body.value !== null && typeof body.value !== "number") {
    return NextResponse.json({ error: "value must be number or null", code: "VALUE_INVALID" }, { status: 400 });
  }
  const sig = addIdeaSignal({
    idea_id: id,
    owner_id: userId,
    source: typeof body.source === "string" ? body.source : "manual",
    kind: body.kind,
    value: body.value ?? null,
    note: body.note ?? null,
    ref: body.ref ?? null,
    occurred_at: body.occurred_at ?? null,
  });
  if (!sig) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json(sig, { status: 201 });
}
