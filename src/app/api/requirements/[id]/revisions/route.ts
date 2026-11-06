// GET /api/requirements/[id]/revisions - 列某需求点的字段级变更时间线 (R63).
//
// 关注点:
//   - owner_id 隔离由 caller (前端/SSR) 通过 GET /api/requirements/[id] 校验; 本端点
//     简化为 "先 verify 再列", 复用 getRequirementById 触发 404.
//   - 不分页 (limit 默认 100, 客户端按需 ?limit=N 上调), 时间线诉求是看近期不是全量.

import { NextRequest, NextResponse } from "next/server";
import { getRequirementById } from "@/lib/db/requirements";
import { listRevisions } from "@/lib/db/requirement-revisions";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const exists = getRequirementById(id, userId);
  if (!exists) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const limitRaw = searchParams.get("limit");
  let limit = 100;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (Number.isInteger(n) && n > 0 && n <= 500) limit = n;
  }
  return NextResponse.json({ requirement_id: id, revisions: listRevisions(id, limit) });
}