// GET/PATCH/DELETE /api/versions/[id] - scoped to current user via parent project's owner

import { NextRequest, NextResponse } from "next/server";
import { getVersionById, updateVersion, deleteVersion } from "@/lib/db/versions";
import { normalizeSheetUrl } from "@/lib/feishu/url";
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
  const version = getVersionById(id, userId);
  if (!version) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ version });
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
  const body = await request.json().catch(() => ({}));

  // cwd 本机校验 (damo 2026-10-31): 同 POST /api/versions —— 不存在默认拒绝 + 核查提示,
  // 显式 git_remote / create_if_missing=true 放行; 通过后放行参数已剥掉再进 DB 层.
  const cwdFailure = validateCwdFromBody(body);
  if (cwdFailure) {
    return NextResponse.json(cwdFailure, { status: 400 });
  }

  // 兜底归一化:防 curl 外部调用绕过 UI 直接 PATCH 带 ?sheet= 的脏 URL.
  // UI 层 (projects-client.tsx) 已 normalize,这里再 normalize 一次幂等无副作用.
  if (body.feishu_url !== undefined && typeof body.feishu_url === "string" && body.feishu_url.trim()) {
    try {
      body.feishu_url = normalizeSheetUrl(body.feishu_url).wikiUrl || null;
    } catch (err) {
      return NextResponse.json(
        { error: `invalid feishu_url: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  }

  // v513: description 校验 —— 限 string, 截 2000 字符 (AI 解析输入可能带长上下文).
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return NextResponse.json({ error: "invalid description: must be string or null" }, { status: 400 });
    }
    body.description = typeof body.description === "string" ? body.description.slice(0, 2000) : null;
  }

  // v512: enable 校验 —— 限 boolean. 不传 = 不动该列 (跟其他字段「undefined 即不改」一致).
  if (body.enable !== undefined && typeof body.enable !== "boolean") {
    return NextResponse.json(
      { error: `invalid enable: must be boolean, got ${typeof body.enable}`, allowed: [true, false] },
      { status: 400 },
    );
  }

  // Ownership gate before mutating. A non-owner (or non-existent) version
  // returns 404. If project_id is being moved, the new parent must also be
  // owned by the current user; updateVersion's underlying getVersionById re-read
  // is unfiltered, so we validate the target project ownership here.
  if (body.project_id !== undefined) {
    const { getProjectById } = await import("@/lib/db/projects");
    if (!getProjectById(body.project_id, userId)) {
      return NextResponse.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
    }
  }
  if (!getVersionById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const version = updateVersion(id, body);
  if (!version) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ version });
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
  // Ownership gate: only delete if the version (and its parent project) is
  // owned by the current user.
  if (!getVersionById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // v33: 级联软删(版本 + 其下 task), 不是硬删. 失败回具体 message.
  try {
    const result = deleteVersion(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: `删除版本失败: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
