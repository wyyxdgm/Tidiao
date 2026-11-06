// GET /api/dashboard-blocks - 读积木布局
// PUT /api/dashboard-blocks - 存积木布局（整组替换，前端拖完一把保存）

import { NextRequest, NextResponse } from "next/server";
import { listDashboardBlocks, saveDashboardBlocks } from "@/lib/db/pin-lists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ blocks: listDashboardBlocks(userId) });
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
  if (!Array.isArray(body.blocks)) {
    return NextResponse.json({ error: "blocks must be array", code: "BLOCKS_INVALID" }, { status: 400 });
  }
  try {
    const blocks = saveDashboardBlocks(userId, body.blocks);
    return NextResponse.json({ blocks });
  } catch (err: any) {
    if (err?.code === "BLOCK_TYPE_INVALID") {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
