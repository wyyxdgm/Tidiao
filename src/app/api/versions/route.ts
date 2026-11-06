// GET /api/versions - list versions (optional ?project= filter, scoped to current user)
// POST /api/versions - create a version (parent project must be owned by current user)

import { NextRequest, NextResponse } from "next/server";
import { listVersions, createVersion } from "@/lib/db/versions";
import { getProjectById } from "@/lib/db/projects";
import { normalizeSheetUrl } from "@/lib/feishu/url";
import { validateCwdFromBody } from "@/lib/cwd-validate";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project") || undefined;
  const versions = listVersions(projectId, userId);
  return NextResponse.json({ versions });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    project_id: string;
    name: string;
    // v513 (飞书 R172): 版本描述（「版本干啥的」）.
    description?: string;
    feishu_url?: string;
    feishu_sheet?: string;
    cwd?: string;
    // cwd 本机校验放行参数 (damo 2026-10-31): 默认不传 = 路径不存在即拒绝.
    create_if_missing?: boolean;
    git_remote?: string;
    // v45 强同步: 不传默认 'weak'. 校验: 没配 feishu_url 的 version 只能是 'manual'.
    sync_strategy?: "weak" | "strong" | "manual";
    // v512: sheetwatch 开关. 不传默认 true (兼容老 version). 限布尔, 非布尔返 400.
    enable?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.project_id?.trim() || !body.name?.trim()) {
    return NextResponse.json({ error: "project_id and name are required" }, { status: 400 });
  }

  // 兜底归一化:防止 curl/外部调用绕过 UI 直接 POST 带 ?sheet= 的脏 URL.
  // UI 层 (projects-client.tsx) 已 normalize,这里再 normalize 一次幂等无副作用.
  let normalizedFeishuUrl: string | undefined = body.feishu_url;
  if (normalizedFeishuUrl?.trim()) {
    try {
      normalizedFeishuUrl = normalizeSheetUrl(normalizedFeishuUrl).wikiUrl || undefined;
    } catch (err) {
      return NextResponse.json(
        { error: `invalid feishu_url: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 },
      );
    }
  }

  // v45: sync_strategy 校验. 没配 feishu_url 的 version 没有外部源, 强同步无意义.
  // 静默回退到 'manual' 而不是 400 —— 创建时不强阻, 只在强同步 API 时再卡.
  const syncStrategy = body.sync_strategy;
  if (syncStrategy && !["weak", "strong", "manual"].includes(syncStrategy)) {
    return NextResponse.json(
      { error: `invalid sync_strategy: ${syncStrategy}`, allowed: ["weak", "strong", "manual"] },
      { status: 400 },
    );
  }
  const effectiveStrategy = !normalizedFeishuUrl?.trim()
    ? "manual"
    : (syncStrategy ?? "weak");

  // v512: enable 校验 —— 限 boolean. 不传默认 true (写库时 ORM 转 1).
  if (body.enable !== undefined && typeof body.enable !== "boolean") {
    return NextResponse.json(
      { error: `invalid enable: must be boolean, got ${typeof body.enable}`, allowed: [true, false] },
      { status: 400 },
    );
  }

  // cwd 本机校验 (damo 2026-10-31): 同 projects 路由 —— 不存在默认拒绝 + 核查提示,
  // 显式 git_remote / create_if_missing=true 放行; 通过后放行参数已剥掉.
  const cwdFailure = validateCwdFromBody(body);
  if (cwdFailure) {
    return NextResponse.json(cwdFailure, { status: 400 });
  }

  // Gate: the parent project must exist AND be owned by the current user.
  // A missing/foreign project returns 404 (no existence leak).
  if (!getProjectById(body.project_id.trim(), userId)) {
    return NextResponse.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 });
  }

  // 重名走 409 而不是裸 500（同 /api/projects）: versions 上有 partial unique
  // index (uq_versions_live ... WHERE deleted_at IS NULL), 同项目下同名的**活**
  // 版本会抛 UNIQUE; 软删掉的同名版本不占名字.
  try {
    const version = createVersion({
      project_id: body.project_id.trim(),
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      feishu_url: normalizedFeishuUrl,
      feishu_sheet: body.feishu_sheet,
      cwd: body.cwd,
      sync_strategy: effectiveStrategy,
      enable: body.enable,
    });
    return NextResponse.json({ version }, { status: 201 });
  } catch (err) {
    const msg = (err as Error).message;
    if (/UNIQUE/i.test(msg)) {
      return NextResponse.json(
        { error: `该项目下已存在同名版本「${body.name.trim()}」`, code: "DUPLICATE_NAME" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: `创建版本失败: ${msg}` }, { status: 500 });
  }
}
