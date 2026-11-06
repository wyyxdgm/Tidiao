// POST /api/tasks/[id]/await - Running → await_user, 等用户介入
//
// 🆕 R131 (damo 2026-09-15): 等派发实现 / 等拍板 / 有建议 — 统一进 await_user.
//   区别 pending (= 等系统) / awaiting_owner_review (= reviewing 内 flag 细化).
//   body schema:
//   {
//     reason: "dispatch_needed" | "decision_pending" | "suggestion",  // 必填
//     note?: string,                                                    // 可选自由文本
//     requested_by: "damo" | "agent",                                   // 默认 "damo"
//   }

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

const AWAIT_REASONS = ["dispatch_needed", "decision_pending", "suggestion"] as const;
type AwaitReason = (typeof AWAIT_REASONS)[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const body = await request.json();
  if (!body.reason || !AWAIT_REASONS.includes(body.reason)) {
    return NextResponse.json(
      { error: `reason must be one of: ${AWAIT_REASONS.join(", ")}` },
      { status: 400 }
    );
  }
  const requestedBy = body.requested_by === "agent" ? "agent" : "damo";
  try {
    getRuntime().awaitTask(id, body.reason as AwaitReason, body.note, requestedBy);
    return NextResponse.json({ ok: true, status: "await_user" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
