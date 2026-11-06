// POST /api/pin-lists/[id]/items - 加条目（ref_type: task|idea|node|plan(v530)；added_by 归因）
// PUT  /api/pin-lists/[id]/items - 重排（整组替换：{item_ids: [...]}}）

import { NextRequest, NextResponse } from "next/server";
import {
  addPinListItem,
  reorderPinListItems,
  listItemsWithRefs,
  PIN_REF_TYPES,
  type PinRefType,
} from "@/lib/db/pin-lists";

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
  if (!PIN_REF_TYPES.includes(body.ref_type as PinRefType)) {
    return NextResponse.json(
      { error: `ref_type must be one of ${PIN_REF_TYPES.join("|")}`, code: "REF_TYPE_INVALID" },
      { status: 400 }
    );
  }
  if (!body.ref_id || typeof body.ref_id !== "string") {
    return NextResponse.json({ error: "ref_id is required", code: "REF_ID_REQUIRED" }, { status: 400 });
  }
  try {
    // data: 对象或 JSON 字符串都收 (对象自动 stringify) — schema 校验在 db 层
    let dataJson: string | null = null;
    if (body.data !== undefined && body.data !== null) {
      dataJson = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
    }
    const item = addPinListItem({
      list_id: id,
      owner_id: userId,
      ref_type: body.ref_type,
      ref_id: body.ref_id,
      note: body.note ?? null,
      data: dataJson,
      added_by: typeof body.added_by === "string" && body.added_by ? body.added_by : "damo",
    });
    if (!item) {
      return NextResponse.json({ error: "List not found", code: "LIST_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json(item, { status: 201 });
  } catch (err: any) {
    if (err?.code === "REF_NOT_FOUND") {
      return NextResponse.json({ error: err.message, code: "REF_NOT_FOUND" }, { status: 404 });
    }
    if (err?.code === "DATA_INVALID") {
      return NextResponse.json({ error: err.message, code: "DATA_INVALID" }, { status: 400 });
    }
    if (err?.code?.startsWith("SQLITE_CONSTRAINT")) {
      return NextResponse.json({ error: "already in list", code: "ALREADY_IN_LIST" }, { status: 409 });
    }
    throw err;
  }
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
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.item_ids)) {
    return NextResponse.json({ error: "item_ids must be string[]", code: "ITEM_IDS_INVALID" }, { status: 400 });
  }
  const ok = reorderPinListItems(id, userId, body.item_ids);
  if (!ok) {
    return NextResponse.json({ error: "List not found", code: "LIST_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ items: listItemsWithRefs(id, userId) });
}
