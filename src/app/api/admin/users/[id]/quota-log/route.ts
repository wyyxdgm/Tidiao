// GET /api/admin/users/[id]/quota-log — 拉单个 user 的配额变更历史. Admin only.
//
// 关注点:
//   - 复用 Phase 1 commit 431d4c1 的 getQuotaChangeLog(targetUserId, limit=50)
//   - 给 admin 详情面板 "查看变更历史" 按钮点开时调用
//   - 渲染 operator_id 时, 应用层 (前端) 自行 try-resolve 成 email; 不想批量
//     预 join users 表避免 N+1 —— 历史面板 50 条上限, 单次请求还好.

import { NextRequest, NextResponse } from "next/server";
import { getQuotaChangeLog } from "@/lib/db/users";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const { id } = await params;
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") || "50", 10) || 50,
    200,
  );
  const log = getQuotaChangeLog(id, limit);
  return NextResponse.json({ log });
}