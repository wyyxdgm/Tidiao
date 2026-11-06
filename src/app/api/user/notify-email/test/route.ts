// POST /api/user/notify-email/test —— 真发一封测试邮件到该账号的通知邮箱。
//
// 为什么单独开一个端点而不塞进 PATCH /api/user/me: 保存和试发是两个意图 ——
// 用户可能想在不改设置的情况下确认「现在这个地址能收到吗」, 而 PATCH 里附带
// 发信会让每次保存都烧一封邮件(发信信誉是有限资源)。
//
// 关注点:
//  - 收件人走 resolveNotifyTo(即真实通知链路), **不接受请求体里的任意地址** ——
//    否则这就是个开放中继, 任何登录用户都能借平台的 SMTP 往外发信。
//  - 发送失败回 200 + { sent:false, reason }, 不回 5xx: 这是「诊断结果」而不是
//    「接口出错」, 前端要把 reason 原样显示给用户看。

import { NextRequest, NextResponse } from "next/server";
import { getUserById } from "@/lib/db/users";
import { resolveNotifyTo, sendNotify } from "@/lib/notify/mailer";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const to = resolveNotifyTo(userId);
  if (!to) {
    return NextResponse.json({
      sent: false,
      reason:
        "没有可用收件人：本账号未配置通知邮箱，且平台未设置系统兜底邮箱(NOTIFY_FALLBACK_TO)",
    });
  }

  const usingFallback = !user.notify_email?.trim();
  const result = await sendNotify({
    to,
    subject: "【提调】通知邮箱测试",
    text: [
      "这是一封测试邮件，说明你的通知邮箱配置可用。",
      "",
      `收件地址：${to}`,
      `来源：${usingFallback ? "系统兜底邮箱（本账号未单独配置）" : "本账号配置的通知邮箱"}`,
      `账号：${user.email}`,
      "",
      "任务超时时，平台会往这个地址发通知。",
    ].join("\n"),
  });

  return NextResponse.json({
    ...result,
    to,
    using_fallback: usingFallback,
  });
}
