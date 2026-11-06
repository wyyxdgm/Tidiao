// GET/PATCH/DELETE /api/projects/[id]

import { NextRequest, NextResponse } from "next/server";
import { getProjectById, updateProject, deleteProject } from "@/lib/db/projects";
import { PortPoolConflictError } from "@/lib/db/port-pool-error";
import { validateCwdFromBody } from "@/lib/cwd-validate";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Admin bypass on READ, mirroring GET /api/projects (route.ts:30) which passes
  // `undefined` as userId for admin so listProjects skips owner_id filtering
  // (board 2026-08-19: "operator sees every project"). Without this the list
  // shows a project the admin can never open — 404 on click (2026-09-29 实测:
  // playcanvas-micraft 属测试账号, 列表可见 / 详情 404).
  // 关注点: PATCH/DELETE **故意不**放行 —— 写操作仍严格 owner 隔离, 避免 admin
  // 误改/误删他人项目。要放开写权限得单独拍板, 别顺手把下面两处的 userId 也改了。
  const role = request.headers.get("x-user-role");
  const project = getProjectById(id, role === "admin" ? undefined : userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project });
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
  // Ownership gate before mutating.
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  // cwd 本机校验 (damo 2026-10-31): 同 POST /api/projects —— 路径不存在默认拒绝,
  // 显式 git_remote / create_if_missing=true 才放行; 通过时放行参数被剥掉再进 DB 层.
  const cwdFailure = validateCwdFromBody(body);
  if (cwdFailure) {
    return NextResponse.json(cwdFailure, { status: 400 });
  }
  // updateProject 对 wiki_extra_extensions 做白名单校验并抛错(非法扩展名/`*`/超额).
  // 必须回 400 带 message —— 静默 200 会让用户以为配好了, 然后在 wiki 上找不到文件.
  // R18 P2: PortPoolConflictError 用结构化 409 (code+conflict) 透传, 不是普通 400.
  let project;
  try {
    project = updateProject(id, body);
  } catch (err) {
    if (err instanceof PortPoolConflictError || (err as { code?: string }).code === "PORT_POOL_CONFLICT") {
      const e = err as PortPoolConflictError;
      return NextResponse.json(
        { error: e.message, code: e.code, conflict: e.conflict },
        { status: e.status }
      );
    }
    // v532 (重命名): 撞同名活项目 (uq_projects_live partial unique) 回 409 带
    // 人话 message, 与 POST /api/projects 同款口径 —— 裸 SQLITE "UNIQUE
    // constraint failed" 会原样透给前端 UI, 用户看不懂.
    const msg = (err as Error).message;
    if (/UNIQUE/i.test(msg)) {
      return NextResponse.json(
        { error: `已存在同名项目「${String(body.name ?? "").trim()}」`, code: "DUPLICATE_NAME" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project });
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
  // Ownership gate: only the owner may delete (no existence leak).
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // v33: 级联软删(项目 + 其下 version + task 全部 deleted_at), 不是硬删 ——
  // 数据保留可恢复. 失败时回具体 message, 别让前端只看到裸 500.
  try {
    const result = deleteProject(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: `删除项目失败: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
