// GET /api/projects/[id]/config - list all config keys for a project (values 不返)
// 关注点: 列表只返 key, 不解密 — 调用方按需 GET 单条拿到明文. 防 API 一把泄露所有
//   敏感配置.
//
// 🔴 owner 隔离 (2026-11-01 补): 本路由原先只校验「用户存在」, 没校验项目归属 ——
//   任何登录用户都能列出别人项目的 config key 名 (key 名本身泄露业务信息, 如
//   bank_card_no). 口径对齐 /api/projects/[id]: getProjectById(id, userId) 不过返 404.

import { NextRequest, NextResponse } from "next/server";
import { requireExistingUser } from "@/lib/auth-user-exists";
import { getProjectById } from "@/lib/db/projects";
import { listProjectConfigKeys } from "@/lib/db/project-configs";

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
  const keys = listProjectConfigKeys(id);
  return NextResponse.json({ keys });
}