// POST /api/tasks/[id]/dequeue - Pull a queued task OUT of the scheduler queue.
//
// 🆕 R162 (damo 2026-09-22): 看板拖拽 queued → pending 走本端点. 与 cancel
//   不同: 不删 session_id、不算终止态, 任务保留在 pending 等用户后续手动
//   start. 与 cancel 端点结构对齐 (同 ownership gate + 同错误码 + 同
//   `{ ok, status }` 响应), 便于 board-client runAction 通用处理.

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
    getRuntime().dequeueTask(id);
    return NextResponse.json({ ok: true, status: "pending" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
