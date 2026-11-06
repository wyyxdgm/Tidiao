// POST /api/tasks/[id]/unawait - await_user → running, 等结束了
//
// 🆕 R131 (damo 2026-09-15): agent 自决 / 用户超时 / 外部事件 — 恢复 running.
//   区别 approve (→ completed): unawait 不完成 task, 仅清 await 标记回到 running,
//   agent 可以继续工作. body schema:
//   {
//     reason: "agent_self_resolved" | "user_timeout" | "external_event",  // 必填
//     note?: string,                                                        // 可选自由文本
//     requested_by: "damo" | "agent",                                       // 默认 "agent"
//   }

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

const UNAWAIT_REASONS = ["agent_self_resolved", "user_timeout", "external_event"] as const;
type UnawaitReason = (typeof UNAWAIT_REASONS)[number];

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
  if (!body.reason || !UNAWAIT_REASONS.includes(body.reason)) {
    return NextResponse.json(
      { error: `reason must be one of: ${UNAWAIT_REASONS.join(", ")}` },
      { status: 400 }
    );
  }
  const requestedBy = body.requested_by === "damo" ? "damo" : "agent";
  try {
    getRuntime().unawaitTask(id, body.reason as UnawaitReason, body.note, requestedBy);
    return NextResponse.json({ ok: true, status: "running" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
