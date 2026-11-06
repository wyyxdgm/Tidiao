// POST /api/notify —— 通用通知出站 (v47)。
//
// 支持三种 channel:
//   - "email"  : 走 v41 SMTP 链路 (mailer.sendNotifyToUser → resolveNotifyTo)
//   - "feishu" : 走 v47 飞书自定义机器人 webhook (feishu.sendFeishuWebhook)
//   - "both"   : 两个渠道并发执行 (Promise.all), 互不阻塞
//
// 收件人解析:
//   - 默认发件人 = 当前登录用户 (callUserId): email 走 resolveNotifyTo(callUserId),
//     feishu 拿 callUserId 的 users.feishu_webhook_url。
//   - admin 可指定 user_id (覆盖收件人) 或 to (覆盖 email 收件人字符串):
//     用来"代发"或"测试某个 webhook"。
//   - 非 admin 传 user_id/to → 403 (防开放中继: 否则任何登录用户都能借平台 SMTP
//     往外发信, 或者往别人的群里塞机器人消息)。
//
// 关注点:
//   - 与 mailer.ts / feishu.ts 同口径: **永不抛错**, 任何渠道失败都返 { sent:false, reason },
//     HTTP 整体仍 200 —— 调用方/CLI 要看 summary 判断 "all_ok / partial / none"。
//   - 校验错 (channel 缺失/格式错) 才返 4xx。
//   - channel=both 时并发, 不串行; 总耗时 ≈ max(两者), 不是 sum。

import { NextRequest, NextResponse } from "next/server";
import { getUserById } from "@/lib/db/users";
import {
  sendNotify,
  sendNotifyToUser,
  type SendResult as EmailSendResult,
} from "@/lib/notify/mailer";
import { sendFeishuWebhook, type FeishuSendResult, type FeishuPost } from "@/lib/notify/feishu";

type Channel = "email" | "feishu" | "both";

interface NotifyRequest {
  channel?: Channel;
  /** Admin-only: 覆盖默认收件人 user_id */
  user_id?: string;
  /** Admin-only: 覆盖 email 收件人字符串(直接发到这个邮箱, 不走 resolveNotifyTo) */
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  /** channel 含 feishu 时 (msg_type=post 除外) 必填 */
  message?: string;
  /** channel 含 feishu 且 msg_type=post 时必填; 与 message 互斥 */
  post?: FeishuPost;
  msg_type?: "text" | "markdown" | "post";
}

interface NotifyResponse {
  results: Array<
    | (EmailSendResult & { channel: "email" })
    | (FeishuSendResult & { channel: "feishu" })
  >;
  summary: "all_ok" | "partial" | "none";
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const callerRole = request.headers.get("x-user-role");
  const isAdmin = callerRole === "admin";

  let body: NotifyRequest;
  try {
    body = (await request.json()) as NotifyRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const channel = body.channel;
  if (channel !== "email" && channel !== "feishu" && channel !== "both") {
    return NextResponse.json(
      { error: "channel 必须是 email | feishu | both" },
      { status: 400 }
    );
  }

  // 🔴 非 admin 禁止 user_id / to —— 开放中继闸门
  if (!isAdmin) {
    if (body.user_id) {
      return NextResponse.json(
        { error: "user_id 仅 admin 可指定" },
        { status: 403 }
      );
    }
    if (body.to) {
      return NextResponse.json(
        { error: "to 仅 admin 可指定" },
        { status: 403 }
      );
    }
  }

  // 解析目标 user_id: admin 指定则用指定的, 否则就是当前用户
  const targetUserId = body.user_id || userId;
  const targetUser = getUserById(targetUserId);
  if (!targetUser) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // 校验: channel 含 email 时必须 subject + (text 或 html)
  if (channel === "email" || channel === "both") {
    if (!body.subject?.trim()) {
      return NextResponse.json(
        { error: "channel 含 email 时必须传 subject" },
        { status: 400 }
      );
    }
    if (!body.text?.trim() && !body.html?.trim()) {
      return NextResponse.json(
        { error: "channel 含 email 时必须传 text 或 html" },
        { status: 400 }
      );
    }
  }
  // 校验: channel 含 feishu 时, message (text/markdown) 或 post (post 富文本) 二选一
  if (channel === "feishu" || channel === "both") {
    const wantPost = body.msg_type === "post";
    if (wantPost) {
      if (!body.post || !Array.isArray(body.post.content) || body.post.content.length === 0) {
        return NextResponse.json(
          { error: "msg_type=post 时必须传 post.content (非空二维数组)" },
          { status: 400 }
        );
      }
    } else {
      if (!body.message?.trim()) {
        return NextResponse.json(
          { error: "channel 含 feishu 时必须传 message (text/markdown) 或 post (msg_type=post)" },
          { status: 400 }
        );
      }
    }
  }

  // 拼装任务: channel=both 时并发
  const wantEmail = channel === "email" || channel === "both";
  const wantFeishu = channel === "feishu" || channel === "both";

  const tasks: Array<Promise<NotifyResponse["results"][number]>> = [];

  if (wantEmail) {
    tasks.push(
      (async (): Promise<EmailSendResult & { channel: "email" }> => {
        // admin 显式指定 to → 直接发到那个邮箱 (绕过 resolveNotifyTo);
        // 否则走 sendNotifyToUser 走 resolveNotifyTo(targetUserId)。
        if (body.to?.trim()) {
          const r = await sendNotify({
            to: body.to,
            subject: body.subject!,
            text: body.text,
            html: body.html,
          });
          return { channel: "email", ...r };
        }
        // 普通路径 (admin/非 admin 都走这条, 除非上面 if 进 body.to 分支)
        const r = await sendNotifyToUser(targetUserId, {
          subject: body.subject!,
          text: body.text,
          html: body.html,
        });
        return { channel: "email", ...r };
      })()
    );
  }

  if (wantFeishu) {
    tasks.push(
      (async (): Promise<FeishuSendResult & { channel: "feishu" }> => {
        const webhookUrl = targetUser.feishu_webhook_url;
        const r = await sendFeishuWebhook({
          webhookUrl,
          ...(body.msg_type === "post"
            ? { post: body.post, msgType: "post" as const }
            : {
                message: body.message!,
                msgType: body.msg_type === "text" ? ("text" as const) : ("markdown" as const),
              }),
        });
        return { channel: "feishu", ...r };
      })()
    );
  }

  // 并发执行
  const results = await Promise.all(tasks);

  // 计算 summary
  let sentCount = 0;
  let failedCount = 0;
  for (const r of results) {
    if (r.sent) sentCount++;
    else failedCount++;
  }
  const summary: NotifyResponse["summary"] =
    failedCount === 0 ? "all_ok" : sentCount === 0 ? "none" : "partial";

  return NextResponse.json({ results, summary } satisfies NotifyResponse);
}