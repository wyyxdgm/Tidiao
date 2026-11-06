// POST /api/user/llm-config/[id]/duplicate — 复制自己的一份 LLM 配置.
// 新行 name 加 "-拷贝" 后缀 (冲突时自动 "-拷贝-2/-3/..."), is_default 强制为 0
// (不抢源行默认位), api_key 加密字段直接复用.
// 鉴权: 仅允许 user 复制自己的配置 (admin_grant 那些平台配置不允许复制).

import { NextRequest, NextResponse } from "next/server";
import {
  duplicateLlmConfig,
  getLlmConfigById,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = getLlmConfigById(id);
  if (!existing || existing.owner_type !== "user" || existing.owner_id !== userId) {
    // 管理员配置 (admin_grant) 故意不让用户从这里拷 -> 404, 不是 403
    // (避免泄漏「id 存在但你没权」的存在性信息)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const config = duplicateLlmConfig(id);
    return NextResponse.json(toSafeLlmConfig(config));
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}