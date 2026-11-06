// PATCH  /api/pin-lists/[id] - 改列表（标题/描述/排序键）
// DELETE /api/pin-lists/[id] - 删列表（条目清掉，ref 对象不动）

import { NextRequest, NextResponse } from "next/server";
import { updatePinList, deletePinList } from "@/lib/db/pin-lists";

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
  const list = updatePinList(id, userId, body);
  if (!list) {
    return NextResponse.json({ error: "List not found", code: "LIST_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json(list);
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
  const ok = deletePinList(id, userId);
  if (!ok) {
    return NextResponse.json({ error: "List not found", code: "LIST_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
