// GET /api/user/me/webhook-meta —— 返回当前用户的飞书 webhook 配置脱敏信息.
//
// 为什么单独开这个端点而不是 GET /api/user/me 直接回:
//   - webhook URL 是半秘密: 拿到就能往那个群发机器人消息.
//   - GET /api/user/me 只回 feishu_configured 布尔, 不回任何 URL.
//   - 设置页要显示「已配/未配 + 末 4 位脱敏确认」, 单独走这个端点.

import { NextRequest, NextResponse } from "next/server";
import { getUserById, maskFeishuWebhookUrl } from "@/lib/db/users";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const url = user.feishu_webhook_url?.trim() || null;
  return NextResponse.json({
    feishu_configured: !!url,
    masked_url: maskFeishuWebhookUrl(url),
  });
}