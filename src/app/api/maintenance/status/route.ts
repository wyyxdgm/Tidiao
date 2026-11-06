// GET /api/maintenance/status - 当前维护模式状态（最小公开版）
//
// 拆分依据: /api/admin/maintenance 是 admin only, 返回完整字段
// (suspended 任务列表 / scheduler counts / entered_by) —— 这些不该暴露给全员。
// 这里只回 active + reason + entered_at, 任何已登录用户可读。
// 前端 NavSidebar 30s 轮询, 用作侧栏横幅提醒。
//
// 注意: reason 字段由 admin 在设置页写入, 可能含敏感描述。v1 不过滤,
//  文档约定 admin 写理由时避免敏感词。

import { NextRequest, NextResponse } from "next/server";
import { getMaintenanceState } from "@/lib/db/maintenance";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const state = getMaintenanceState();
  return NextResponse.json({
    active: state.active,
    reason: state.reason,
    entered_at: state.entered_at,
  });
}
