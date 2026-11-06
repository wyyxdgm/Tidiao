// GET/POST /api/projects/[id]/llm-config — 项目的 LLM 配置 (list + create).
// Ownership gate: 项目必须属于当前用户.
// 单行 PUT/DELETE 走 /api/projects/[id]/llm-config/[configId]。

import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/db/projects";
import {
  listLlmConfigs,
  createLlmConfig,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const configs = listLlmConfigs("project", id);
  return NextResponse.json({ configs: configs.map(toSafeLlmConfig) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getProjectById(id, userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const config = createLlmConfig("project", id, {
      name: body.name,
      type: body.type,
      api_key: body.api_key,
      base_url: body.base_url,
      model: body.model,
      fallback_ids: body.fallback_ids,
      supports_vision: body.supports_vision,
    });
    return NextResponse.json(toSafeLlmConfig(config));
  } catch (err) {
    if (err instanceof LlmConfigError) {
      const status = err.code === "name_conflict" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
