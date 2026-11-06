// POST /api/admin/llm-config/[id]/duplicate — 复制一份平台 LLM 配置.
// Admin-only. 仅允许 admin owner_type 的行被复制.
// 新行 name 加 "-拷贝" 后缀, is_default 强制 0 (不抢源行默认位).

import { NextRequest, NextResponse } from "next/server";
import {
  duplicateLlmConfig,
  getLlmConfigById,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const { id } = await params;
  const existing = getLlmConfigById(id);
  if (!existing || existing.owner_type !== "admin") {
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