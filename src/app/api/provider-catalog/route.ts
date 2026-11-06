// GET /api/provider-catalog — 国内 LLM 厂商供应商目录 (R240).
// 给 SPA LLM 编辑表单的「快捷选择供应商」下拉喂数据: 选厂商 → 自动填 base_url +
// 模型 datalist 切到该厂商列表 → 用户只需填 key. 数据源 src/lib/provider-catalog/
// catalog.json (scripts/update-provider-catalog.ts 日更). 登录即可读, 目录无敏感信息.

import { NextRequest, NextResponse } from "next/server";
import { getProviderCatalog } from "@/lib/provider-catalog";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const catalog = getProviderCatalog();
    return NextResponse.json(catalog);
  } catch (e) {
    return NextResponse.json(
      { error: "catalog_unavailable", message: (e as Error).message },
      { status: 500 },
    );
  }
}
