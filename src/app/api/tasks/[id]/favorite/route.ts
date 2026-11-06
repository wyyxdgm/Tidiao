// /api/tasks/[id]/favorite — per-user task 收藏 (飞书 R15, v57).
//
// POST    — 收藏 (幂等, 重复 POST 仍 200 + already=true)
// DELETE  — 取消收藏 (幂等, 未收藏 DELETE 仍 204)
// GET     — 查询当前用户的收藏状态 {favorite: boolean}
//
// 关注点:
//  - 鉴权靠 x-user-id (与其他 task 子路由一致, 见 approve/route.ts).
//  - 404 走 getTaskById 先查, 与 task 鉴权/可见性复用同一道闸.
//  - 不发通知 / 不写 events 表: 收藏是 UI 偏好, 不属于 task 业务事件.

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import {
  addFavorite,
  removeFavorite,
  isFavoriteByUser,
} from "@/lib/db/user-favorites";

async function resolveTaskContext(
  request: NextRequest,
  params: Promise<{ id: string }>
): Promise<{ userId: string; taskId: string } | NextResponse> {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return { userId, taskId: id };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await resolveTaskContext(request, params);
  if (ctx instanceof NextResponse) return ctx;

  const existed = isFavoriteByUser(ctx.userId, ctx.taskId);
  addFavorite(ctx.userId, ctx.taskId);
  return NextResponse.json({
    ok: true,
    favorite: true,
    already: existed,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await resolveTaskContext(request, params);
  if (ctx instanceof NextResponse) return ctx;

  removeFavorite(ctx.userId, ctx.taskId);
  return new NextResponse(null, { status: 204 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await resolveTaskContext(request, params);
  if (ctx instanceof NextResponse) return ctx;

  const favorite = isFavoriteByUser(ctx.userId, ctx.taskId);
  return NextResponse.json({ favorite });
}