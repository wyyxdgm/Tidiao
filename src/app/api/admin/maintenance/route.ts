// GET /api/admin/maintenance - 当前维护状态 + 调度器实时计数
//
// 维护模式影响全平台所有租户的任务调度，故 admin only（同 /api/config PATCH）。
// 部署脚本用它核对关停是否真的生效（running_count 应为 0）。

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getMaintenanceState, getLastCompletedMaintenanceLog } from "@/lib/db/maintenance";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const state = getMaintenanceState();
  const scheduler = getRuntime().getScheduler();
  // v53: 「上次维护」快照给 UI 卡片用. 当前进行中不算 (active=true 时不读,
  //   让 UI 渲染「维护中」优先, 不显示「上次维护」避免歧义).
  const last = state.active ? null : getLastCompletedMaintenanceLog();
  return NextResponse.json({
    active: state.active,
    entered_at: state.entered_at,
    entered_by: state.entered_by,
    reason: state.reason,
    suspended: state.suspended,
    suspended_count: state.suspended.length,
    scheduler_paused: scheduler.isPaused(),
    running_count: scheduler.getRunningCount(),
    queue_size: scheduler.getQueueSize(),
    last_maintenance: last
      ? {
          id: last.id,
          started_at: last.started_at,
          ended_at: last.ended_at,
          duration_seconds: last.duration_seconds,
          reason: last.reason,
          paused_count: last.paused_count,
          dequeued_count: last.dequeued_count,
          failed_count: last.failed_count,
          result: last.result,
        }
      : null,
  });
}
