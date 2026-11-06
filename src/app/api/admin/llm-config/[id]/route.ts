// PUT/DELETE /api/admin/llm-config/[id] — 修改/删除单条 admin LLM 配置.
// Admin-only. R215: 默认行 / 最后一份也允许删 (default_in_use catch 保留作防御).

import { NextRequest, NextResponse } from "next/server";
import {
  getLlmConfigById,
  updateLlmConfig,
  deleteLlmConfigById,
  toSafeLlmConfig,
  LlmConfigError,
} from "@/lib/db/llm-configs";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function PUT(
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
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const { id } = await params;
  const existing = getLlmConfigById(id);
  if (!existing || existing.owner_type !== "admin") {
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
