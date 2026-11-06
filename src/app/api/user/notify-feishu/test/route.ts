// POST /api/user/notify-feishu/test —— 真发一条飞书测试消息.
//
// 关注点:
//   - 优先用 body.webhook_url (用户输入框里未保存的 draft), 不合法返 400.
//   - draft 缺失/空 → 回落 DB 里存的 feishu_webhook_url (旧行为).
//   - draft 与 saved 都为空 → 200 + { sent:false, reason }.
//   - draft 走 isValidFeishuWebhookUrl 校验, 与 PATCH /api/user/me 同口径.
//     不构成开放中继: 用户本来就是 webhook owner, 测的是自己 draft.
//   - webhook 发送走 feishu.sendFeishuWebhook, 它已经永不抛错.
//   - msg_type 可选 text/markdown/post, 默认 text (兼容不支持 markdown 的 webhook,
//     2026-08-17 之前默认 markdown, 老 webhook 上 draft-test 永远失败但静默报 sent:true).

import { NextRequest, NextResponse } from "next/server";
import {
  getUserById,
  isValidFeishuWebhookUrl,
  maskFeishuWebhookUrl,
} from "@/lib/db/users";
import { sendFeishuWebhook, type FeishuPost } from "@/lib/notify/feishu";

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // 解析可选 body. body 缺失 / 空 JSON / 非 JSON 都视为"没传 draft",
  // 回落 saved 行为 —— 不要因为格式错误就 400.
  let draftUrl: string | undefined;
  let msgType: "text" | "markdown" | "post" = "text"; // 默认 text (兼容老 webhook)
  let post: FeishuPost | undefined;
  try {
    const text = await request.text();
    if (text) {
      const body = JSON.parse(text);
      if (typeof body.webhook_url === "string") {
        draftUrl = body.webhook_url.trim() || undefined;
      }
      if (body.msg_type === "markdown" || body.msg_type === "post") {
        msgType = body.msg_type;
      }
      if (body.post && typeof body.post === "object" && Array.isArray(body.post.content)) {
        post = body.post as FeishuPost;
      }
    }
  } catch {
    // body 不是合法 JSON —— 当作没传, 回落 saved
  }

  let targetUrl: string | undefined;
  if (draftUrl !== undefined) {
    if (!isValidFeishuWebhookUrl(draftUrl)) {
      return NextResponse.json(
        { error: "invalid webhook_url format" },
        { status: 400 }
      );
    }
    targetUrl = draftUrl;
  } else {
    targetUrl = user.feishu_webhook_url?.trim() || undefined;
  }

  if (!targetUrl) {
    return NextResponse.json({
      sent: false,
      reason: "未配置飞书 webhook URL —— 在设置页填一个再测试",
    });
  }

  // 构造测试消息
  let result;
  if (msgType === "post") {
    // post 模式必须有 content; 缺则降级 text, 避免 draft-test 永远失败
    if (!post || !post.content || post.content.length === 0) {
      return NextResponse.json(
        { error: "msg_type=post 时必须传 post.content (非空二维数组)" },
        { status: 400 }
      );
    }
    result = await sendFeishuWebhook({
      webhookUrl: targetUrl,
      msgType: "post",
      post,
    });
  } else {
    const message =
      "🤖 飞书机器人测试\n\n" +
      `这是一条测试消息,说明飞书机器人配置可用。\n` +
      `账号: ${user.email}\n` +
      `时间: ${new Date().toISOString()}\n\n` +
      "后续通用通知 (email + feishu) 会往这个 webhook 推送。";
    result = await sendFeishuWebhook({
      webhookUrl: targetUrl,
      message,
      msgType,
    });
  }

  return NextResponse.json({
    ...result,
    masked_url: maskFeishuWebhookUrl(targetUrl),
    msg_type: msgType,
  });
}