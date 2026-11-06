// POST /api/user/llm-config/[id]/default — 设为自己默认 LLM 配置.

import { NextRequest, NextResponse } from "next/server";
import {
  setDefaultLlmConfig,
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
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const config = setDefaultLlmConfig("user", userId, id);
    return NextResponse.json(toSafeLlmConfig(config));
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
