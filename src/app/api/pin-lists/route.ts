// GET    /api/pin-lists - 列全部列表（含解引用条目，控制台一次拉全）
// POST   /api/pin-lists - 建列表（任意标题）
// PUT    /api/pin-lists - 批量改列表顺序 [{id, sort_key}]

import { NextRequest, NextResponse } from "next/server";
import {
  createPinList,
  listPinLists,
  listItemsWithRefs,
} from "@/lib/db/pin-lists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const projectId = new URL(request.url).searchParams.get("project_id");
  const lists = listPinLists(userId, projectId === "null" ? null : projectId ?? undefined).map((l) => ({
    ...l,
    items: listItemsWithRefs(l.id, userId),
  }));
  return NextResponse.json({ lists });
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
  if (body.data_schema !== undefined && body.data_schema !== null) {
    try { JSON.parse(body.data_schema); } catch {
      return NextResponse.json({ error: "data_schema must be valid JSON string", code: "SCHEMA_INVALID" }, { status: 400 });
    }
  }
  if (body.project_id) {
    const { getProjectById } = await import("@/lib/db/projects");
    if (!getProjectById(body.project_id, userId)) {
      return NextResponse.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
    }
  }
  const list = createPinList({
    owner_id: userId,
    title: body.title.trim(),
    description: body.description ?? null,
    project_id: body.project_id ?? null,
    data_schema: body.data_schema ?? null,
  });
  return NextResponse.json({ ...list, items: [] }, { status: 201 });
}

export async function PUT(request: NextRequest) {
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
  if (!Array.isArray(body.orders)) {
    return NextResponse.json({ error: "orders must be [{id, sort_key}]", code: "ORDERS_INVALID" }, { status: 400 });
  }
  const { updatePinList } = await import("@/lib/db/pin-lists");
  for (const o of body.orders) {
    if (typeof o.id !== "string" || typeof o.sort_key !== "number") {
      return NextResponse.json({ error: "orders must be [{id, sort_key}]", code: "ORDERS_INVALID" }, { status: 400 });
    }
    updatePinList(o.id, userId, { sort_key: o.sort_key });
  }
  return NextResponse.json({ ok: true });
}
