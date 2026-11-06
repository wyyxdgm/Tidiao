// PUT/DELETE /api/user/llm-config/[id] — 修改/删除自己的一份配置.

import { NextRequest, NextResponse } from "next/server";
import {
  getLlmConfigById,
  updateLlmConfig,
  deleteLlmConfigById,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

export async function PUT(
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
  const body = await request.json().catch(() => ({}));
  try {
    const config = updateLlmConfig(id, {
      name: body.name,
      type: body.type,
      api_key: body.api_key,
      clear_api_key: body.clear_api_key === true,
      base_url: body.base_url,
      model: body.model,
      fallback_ids: body.fallback_ids,
      supports_vision: body.supports_vision,
      price_in: body.price_in,
      price_out: body.price_out,
      price_cache_read: body.price_cache_read,
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
    deleteLlmConfigById(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LlmConfigError) {
      const status = err.code === "default_in_use" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
