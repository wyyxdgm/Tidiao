// GET /api/requirements/[id]/tasks - 拉需求点的关联 task 列表 (森林 API)
//
// 飞书 R60 P0 §3.1: 一个 requirement 可关联 N 个 task, 拉出有/无依赖关系的任务树.
//   - with_deps=false (默认): 只返 task 列表 {id, title, status, depends_on}
//   - with_deps=true: 额外返 edges (a depends on b)
//
// 关注点:
//   - 不递归展开依赖闭包, 只返 1 层直接依赖 (depends_on JSON 里的 task id 列表).
//     客户端按需递归拉各 task 详情.
//   - 跨 owner 不抛错, 返回空列表 (按 task.requirement_id 过滤, 等同已过滤 owner).
//   - 401/404 错误保持与其他 requirements 路由一致.

import { NextRequest, NextResponse } from "next/server";
import { getRequirementById, getRequirementTasks } from "@/lib/db/requirements";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // 校验 requirement 存在 + 属当前 user. 没有就 404 (no existence leak).
  const req = getRequirementById(id, userId);
  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  const withDeps = request.nextUrl.searchParams.get("with_deps") === "true"
    || request.nextUrl.searchParams.get("with_deps") === "1";

  const out = getRequirementTasks(id, withDeps);
  return NextResponse.json(out);
}
