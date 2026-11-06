// DELETE /api/pin-list-items/[id] - 摘掉一条（ref 对象本体不动）

import { NextRequest, NextResponse } from "next/server";
import { removePinListItem, updatePinListItemData } from "@/lib/db/pin-lists";

// PATCH - 更新条目扩展数据 (AI 遵循 list.data_schema 整理; 整组替换语义)
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
  if (body.data === undefined || body.data === null) {
    return NextResponse.json({ error: "data is required", code: "DATA_INVALID" }, { status: 400 });
  }
  const dataJson = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
  try {
    const item = updatePinListItemData(id, userId, dataJson);
    if (!item) {
      return NextResponse.json({ error: "Item not found", code: "ITEM_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (err: any) {
    if (err?.code === "DATA_INVALID") {
      return NextResponse.json({ error: err.message, code: "DATA_INVALID" }, { status: 400 });
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
  const ok = removePinListItem(id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Item not found", code: "ITEM_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
