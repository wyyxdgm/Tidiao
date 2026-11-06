// GET /api/channels/weixin/qr-login/status?login_id= - 微信扫码登录状态轮询 (D3)
//
// 功能: 查内存会话 → 调 iLink get_qrcode_status (挂起式, fetch 25s 超时归 pending)
//   → success 时自动创建 channel 行 (secret = 加密 {bot_token, ilink_bot_id}) 并
//   删除会话 → 返回 { status, channel? }.
// 关注点: status 枚举 pending(等待扫码)/scanned(已扫待确认)/success/expired/
//   error; expired/error 会话即删 (QR 不可复用). 本端点可能挂起最长 ~25s
//   (iLink 长挂 + 25s fetch 超时), 前端轮询间隔 3s 需容忍慢响应.

import { NextRequest, NextResponse } from "next/server";
import { pollLoginStatus } from "@/lib/intake/weixin-qr-login";
import { toPublicChannelConfig } from "@/app/api/channels/route";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const loginId = request.nextUrl.searchParams.get("login_id");
  if (!loginId) {
    return NextResponse.json({ error: "login_id is required" }, { status: 400 });
  }
  try {
    const result = await pollLoginStatus(loginId, userId);
    // lib 层回 db 形态 channel, 这里剥凭据转 public (与 GET /api/channels 同掩码语义)
    return NextResponse.json({
      ...result,
      channel: result.channel ? toPublicChannelConfig(result.channel) : undefined,
    });
  } catch (err) {
    console.error("[channels/weixin/qr-login/status] iLink error:", err);
    // iLink 瞬时故障不终止登录流程: 归 pending 让前端下一轮重试
    return NextResponse.json({ status: "pending" });
  }
}
