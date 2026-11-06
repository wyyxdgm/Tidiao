// GET/POST /api/admin/llm-config/baseline — 成本系数基准配置（全局单值，存 app_settings KV）.
// POST body {config_id: string|null}: null = 清除基准（所有系数变 null）.

import { NextRequest, NextResponse } from "next/server";
import {
  getCostBaselineConfigId,
  setCostBaselineConfigId,
  LlmConfigError,
} from "@/lib/db/llm-configs";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  return NextResponse.json({ baseline_id: getCostBaselineConfigId() });
}

export async function POST(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    setCostBaselineConfigId(body.config_id ?? null);
    return NextResponse.json({ baseline_id: getCostBaselineConfigId() });
  } catch (err) {
    if (err instanceof LlmConfigError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
