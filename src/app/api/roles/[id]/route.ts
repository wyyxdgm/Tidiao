// GET/PATCH/DELETE /api/roles/[id] - owner-scoped

import { NextRequest, NextResponse } from "next/server";
import { getRoleById, updateRole, deleteRole } from "@/lib/db/roles";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const role = getRoleById(id, userId);
  if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 });
  return NextResponse.json(role);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json();
  try {
    const role = updateRole(id, {
      name: body.name ? String(body.name).trim() : undefined,
      system_prompt: body.system_prompt ? String(body.system_prompt) : undefined,
      description: body.description !== undefined ? String(body.description) : undefined,
      model: body.model !== undefined ? (body.model ? String(body.model) : undefined) : undefined,
      allowed_tools: Array.isArray(body.allowed_tools) ? body.allowed_tools.map(String) : undefined,
      effort: body.effort !== undefined ? (body.effort ? String(body.effort) : undefined) : undefined,
      max_turns: Number.isInteger(body.max_turns) ? body.max_turns : undefined,
      memory_doc: body.memory_doc !== undefined ? (body.memory_doc ? String(body.memory_doc) : undefined) : undefined,
      // 波3 P5 D5: 项目绑定 (undefined=不改; null/''=清成全局) + 回写开关
      // (undefined=不改; 0/false=禁, 1/true=允) — key 用 RoleInput 的 camelCase.
      projectId: body.project_id !== undefined ? (body.project_id ? String(body.project_id) : null) : undefined,
      feishuWriteback:
        body.feishu_writeback !== undefined ? (body.feishu_writeback === 0 || body.feishu_writeback === false ? 0 : 1) : undefined,
    }, userId);
    if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 });
    return NextResponse.json(role);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!deleteRole(id, userId)) return NextResponse.json({ error: "Role not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
