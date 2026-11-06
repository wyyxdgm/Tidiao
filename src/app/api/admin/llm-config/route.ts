// GET/POST /api/admin/llm-config — admin's LLM configurations (list + create).
// Admin-only access. PUT/DELETE 单行操作走 /api/admin/llm-config/[id]。

import { NextRequest, NextResponse } from "next/server";
import {
  listLlmConfigs,
  createLlmConfig,
  toSafeLlmConfig,
  attachCoefficients,
  getCostBaselineConfigId,
  LlmConfigError,
} from "@/lib/db/llm-configs";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const configs = listLlmConfigs("admin", "system");
  const baselineId = getCostBaselineConfigId();
  const safe = attachCoefficients(
    configs.map((c) => toSafeLlmConfig(c)).filter((c): c is NonNullable<ReturnType<typeof toSafeLlmConfig>> => c != null),
    baselineId,
  );
  return NextResponse.json({ configs: safe, baseline_id: baselineId });
}

export async function POST(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const config = createLlmConfig("admin", "system", {
      name: body.name,
      type: body.type,
      api_key: body.api_key,
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
