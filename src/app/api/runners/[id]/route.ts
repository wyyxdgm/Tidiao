// GET    /api/runners/[id] - admin: 单个 runner (不返回 auth 列)
// DELETE /api/runners/[id] - admin: 删除 + 撤销 token. 不带 owner 检查
//                            (admin 全权, 跨用户共用 runner).
//
// 关注点:
//  - 404-not-403: 非 admin 看到的存在/不存在的 row 都回 401 (admin gating 在
//    这里走 header 而非 DB) —— GET 单条仍然 404 是设计选择, 跟 projects/[id]
//    对齐. DELETE 也是 admin 才进得来这里, 不存在 row 回 404 而不是 403.
//  - DELETE 是硬删 (跟 projects 的级联软删不同): runner 是个外部进程的
//    注册, 删除 = 撤销注册, 不需要保留历史. cascade 不必要 (没人 FK runners).

import { NextRequest, NextResponse } from "next/server";
import { getRunnerById, deleteRunner } from "@/lib/db/runners";

function isAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  const { id } = await params;
  const runner = getRunnerById(id);
  if (!runner) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ runner });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  const { id } = await params;
  const ok = deleteRunner(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
