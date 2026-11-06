// POST /api/tasks/[id]/unset-awaiting-review — v56
// damo 拍板完成后, 把 awaiting_owner_review flag 置 0, 之后 POST /approve 才能转 completed.
// 与 /approve 互不耦合 (damo 也可选择 reject 让任务重跑, 此时 flag 也得先 unset).

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  try {
    const result = getRuntime().unsetAwaitingOwnerReview(id);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}