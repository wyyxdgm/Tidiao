// GET/POST /api/user/llm-config — 当前用户自己的 LLM 配置 (list + create).
// 单行 PUT/DELETE 走 /api/user/llm-config/[id]; default 切走 /api/user/llm-config/[id]/default。

import { NextRequest, NextResponse } from "next/server";
import {
  listLlmConfigs,
  createLlmConfig,
  toSafeLlmConfig,
  attachCoefficients,
  getCostBaselineConfigId,
  LlmConfigError,
} from "@/lib/db/llm-configs";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const configs = listLlmConfigs("user", userId);
  const baselineId = getCostBaselineConfigId();
  const safe = attachCoefficients(
    configs.map((c) => toSafeLlmConfig(c)).filter((c): c is NonNullable<ReturnType<typeof toSafeLlmConfig>> => c != null),
    baselineId,
  );
  return NextResponse.json({ configs: safe, baseline_id: baselineId });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const config = createLlmConfig("user", userId, {
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
