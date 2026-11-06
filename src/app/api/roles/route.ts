// GET /api/roles - list roles (owner-scoped)
//   ?projectId=X → getRolesForProject 语义 (波1 D1: 全局 + 该项目专属合并);
//   无参 → listRoles 全量 (Settings 管理页用).
// POST /api/roles - create role (owner = current user from session)
//   波3 P5 (docs/plans/role-scoped-roles.md D5): 透传 project_id (项目绑定) +
//   feishu_writeback (回写开关) — db 层 RoleInput 早已支持 (v525/v527), route 层
//   此前漏接线导致 SPA 管理页存不进去.

import { NextRequest, NextResponse } from "next/server";
import { createRole, getRolesForProject, listRoles } from "@/lib/db/roles";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (projectId) {
    return NextResponse.json(getRolesForProject(projectId, userId));
  }
  return NextResponse.json(listRoles(userId));
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json();
  if (!body.name || !body.system_prompt) {
    return NextResponse.json({ error: "name and system_prompt are required" }, { status: 400 });
  }
  try {
    const role = createRole({
      name: String(body.name).trim(),
      system_prompt: String(body.system_prompt),
      description: body.description ? String(body.description) : undefined,
      model: body.model ? String(body.model) : undefined,
      allowed_tools: Array.isArray(body.allowed_tools) ? body.allowed_tools.map(String) : undefined,
      effort: body.effort ? String(body.effort) : undefined,
      max_turns: Number.isInteger(body.max_turns) ? body.max_turns : undefined,
      memory_doc: body.memory_doc ? String(body.memory_doc) : undefined,
      // 波3 P5 D5: 项目绑定 (空串/null/undefined = 全局) + 回写开关 (缺省 = 1 允许)
      projectId: body.project_id ? String(body.project_id) : null,
      feishuWriteback:
        body.feishu_writeback === 0 || body.feishu_writeback === false ? 0 : 1,
      ownerId: userId,
    });
    return NextResponse.json(role, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
