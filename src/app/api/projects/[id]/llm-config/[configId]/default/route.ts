// POST /api/projects/[id]/llm-config/[configId]/default — 设为项目默认 LLM 配置.

import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/db/projects";
import {
  getLlmConfigById,
  setDefaultLlmConfig,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; configId: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id, configId } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const cfg = getLlmConfigById(configId);
  if (!cfg || cfg.owner_type !== "project" || cfg.owner_id !== id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const config = setDefaultLlmConfig("project", id, configId);
    return NextResponse.json(toSafeLlmConfig(config));
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
