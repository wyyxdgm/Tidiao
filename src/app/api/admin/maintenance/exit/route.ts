// POST /api/admin/maintenance/exit - 退出维护模式（部署后恢复）
//
// 开调度闸门 + 逐个恢复关停时挂起的任务（paused 走 resume 续 transcript，
// pending 走 start 重新入队）+ 重启定时轮询。只恢复关停时记下的那批，用户
// 自己手动 pause 的不碰。admin only。
//
// 幂等：不在维护中调用也安全 —— suspended 为空，等于只确认开闸 + 起轮询。

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function POST(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }

  const result = await getRuntime().exitMaintenance();

  return NextResponse.json({
    ok: true,
    was_active: result.active_before,
    resumed: result.resumed,
    requeued: result.requeued,
    skipped: result.skipped,
    failed: result.failed,
    counts: {
      resumed: result.resumed.length,
      requeued: result.requeued.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
  });
}
