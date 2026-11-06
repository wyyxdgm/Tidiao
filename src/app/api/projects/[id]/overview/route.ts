// GET/PUT/DELETE /api/projects/[id]/overview — 项目概览单文件 markdown.
//
// 用途: 每个项目一份 md 看板 (状态 / 常用链接 / 凭据备注), 人读的. 真相源是
// project_configs 表 (AES-256-GCM 加密), 不落 cwd 文件 —— 凭据不进 git.
//
// 关注点:
//   - **owner 隔离**: 读/写/删都先 getProjectById(id, userId) 校验归属, 404 而非
//     403 (不暴露项目存在性). admin **不**豁免写 —— 与 /api/projects/[id] 的
//     「admin 只放行读」口径一致.
//   - PUT body = {markdown: string}. 必填, 字符串. 空串 = 存一个空概览 (合法,
//     用户就是想把内容清空但保留 key); 想彻底删掉用 DELETE.
//   - 超出 MAX_OVERVIEW_BYTES 返 400 (不截断 —— 截断会让用户以为存全了).
//   - 解密失败 = 404 (视作没写过), 不 500.

import { NextRequest, NextResponse } from "next/server";
import { requireExistingUser } from "@/lib/auth-user-exists";
import { getProjectById } from "@/lib/db/projects";
import {
  deleteProjectOverview,
  getProjectOverview,
  setProjectOverview,
} from "@/lib/db/project-overview";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const { id } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const overview = getProjectOverview(id);
  if (!overview) {
    return NextResponse.json({
      exists: false,
      markdown: null,
      updated_at: null,
      updated_by: null,
    });
  }
  return NextResponse.json({ exists: true, ...overview });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const { id } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: { markdown?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.markdown !== "string") {
    return NextResponse.json(
      { error: "markdown must be a string" },
      { status: 400 }
    );
  }

  try {
    const overview = setProjectOverview(id, body.markdown, userId);
    return NextResponse.json({ exists: true, ...overview });
  } catch (err) {
    // 超限等校验错误 → 400 (带人话原因), 不 500.
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
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
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const { id } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const deleted = deleteProjectOverview(id);
  if (!deleted) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
