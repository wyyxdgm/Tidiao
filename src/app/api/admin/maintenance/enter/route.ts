// POST /api/admin/maintenance/enter - 进入维护模式（部署前关停）
//
// 关调度闸门 + 停定时轮询 + 摘下排队任务 + pause 全部 running（保住 session_id
// 以便恢复时续上下文）。幂等：已在维护中直接返回当前状态，不重复 pause，
// 部署脚本重跑安全。admin only —— 影响全平台所有租户。

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function POST(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const userId = request.headers.get("x-user-id");
  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" && body.reason ? body.reason : null;

  const result = await getRuntime().enterMaintenance({ by: userId, reason });

  return NextResponse.json({
    ok: true,
    already: result.already,
    paused: result.paused,
    dequeued: result.dequeued,
    failed: result.failed,
    counts: {
      paused: result.paused.length,
      dequeued: result.dequeued.length,
      failed: result.failed.length,
    },
    state: {
      active: result.state.active,
      entered_at: result.state.entered_at,
      reason: result.state.reason,
    },
  });
}
