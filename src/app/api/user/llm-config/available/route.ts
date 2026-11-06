// GET /api/user/llm-config/available — 当前用户可见的全部 LLM 配置.
// 自配 + (若 admin 授权) 平台所有. 模板/任务创建时从这里选.
// 收回授权 -> 仅自配. 管理员 (role=admin) 始终能看到 admin 的列表 (他们 = admin owner).

import { NextRequest, NextResponse } from "next/server";
import { listAvailableLlmConfigs } from "@/lib/db/llm-configs";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  const userRole = request.headers.get("x-user-role") || "";
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const configs = listAvailableLlmConfigs(userId, userRole);
  return NextResponse.json({ configs });
}
