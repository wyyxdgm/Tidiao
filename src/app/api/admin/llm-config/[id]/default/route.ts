// POST /api/admin/llm-config/[id]/default — 设为平台默认 LLM 配置.
// Admin-only. 切换是事务: 同 owner 其它 default 清零, 目标行 set=1.

import { NextRequest, NextResponse } from "next/server";
import {
  setDefaultLlmConfig,
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
    const config = setDefaultLlmConfig("admin", "system", id);
    return NextResponse.json(toSafeLlmConfig(config));
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
