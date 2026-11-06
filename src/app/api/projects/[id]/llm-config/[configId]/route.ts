// PUT/DELETE /api/projects/[id]/llm-config/[configId] — 单条项目 LLM 配置.
// + POST /default 设为项目默认.

import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/db/projects";
import {
  getLlmConfigById,
  updateLlmConfig,
  deleteLlmConfigById,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

async function authorize(userId: string | null, projectId: string, configId: string) {
  if (!userId) return { error: "unauthorized", status: 401 };
  if (!getProjectById(projectId, userId)) {
    return { error: "Not found", status: 404 };
  }
  const cfg = getLlmConfigById(configId);
  if (!cfg || cfg.owner_type !== "project" || cfg.owner_id !== projectId) {
    return { error: "not found", status: 404 };
  }
  return { cfg };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; configId: string }> }
) {
  const userId = request.headers.get("x-user-id");
  const { id, configId } = await params;
  const auth = await authorize(userId, id, configId);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const config = updateLlmConfig(configId, {
      name: body.name,
      type: body.type,
      api_key: body.api_key,
      clear_api_key: body.clear_api_key === true,
      base_url: body.base_url,
      model: body.model,
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; configId: string }> }
) {
  const userId = request.headers.get("x-user-id");
  const { id, configId } = await params;
  const auth = await authorize(userId, id, configId);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    deleteLlmConfigById(configId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LlmConfigError) {
      const status = err.code === "default_in_use" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
