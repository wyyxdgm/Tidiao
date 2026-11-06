// 飞书自定义机器人 webhook 出站 —— 通用通知 (v47) 的飞书渠道。
//
// 走 v2 自定义机器人, 不需要 app_id / app_secret (那需要 tenant access token 流程);
//   简单直接: POST JSON 到 https://open.feishu.cn/open-apis/bot/v2/hook/<token>.
//
// 与 mailer.ts 同口径:
//   - **永不抛错**, 失败返 { sent:false, reason }, 调用方在任务状态机里也敢用。
//   - URL 必须先过 isValidFeishuWebhookUrl, 否则拒; 测试 webhook 端点也只走 DB 里
//     已存的 URL, 不接受请求体传入 (防开放中继)。
//   - 没有发出去不要拖垮调用方 —— console.warn 一行, 返回 sent:false。
//
// 关注点:
//   - signing (HmacSHA256 timestamp+secret): 本期不做, 用户选 "简单方式"; 启用后再扩。
//   - msg_type 三选一: text (纯文本) / markdown (默认, 部分 webhook 不支持如 code:10208)
//     / post (富文本, 拼 inline tags, 不依赖 markdown 语法, 适合链接/标题/@人).
//     群机器人的 "关键词策略" 在飞书群机器人配置时设, 不在本模块做限制。

import { isValidFeishuWebhookUrl } from "../db/users";

export type FeishuMsgType = "text" | "markdown" | "post";

/** post 富文本的 inline element. 飞书支持的 tag: text / a / at / img */
export interface FeishuPostElement {
  tag: "text" | "a" | "at" | "img";
  text?: string;
  href?: string;
  user_id?: string;
  image_key?: string;
}

/** post 富文本消息体. content 是二维数组, 每个内层数组 = 一行, 内含若干 inline element */
export interface FeishuPost {
  /** 飞书 locale key, 默认 zh_cn */
  locale?: "zh_cn" | "en_us" | "ja_jp";
  title?: string;
  content: FeishuPostElement[][];
}

export interface FeishuSendResult {
  sent: boolean;
  /** 失败原因(sent:false 时必有), 给人看的短句 */
  reason?: string;
  /** HTTP 状态码, 排障用 (e.g. 19001 = 关键词校验失败, 19002 = IP 不在白名单) */
  status?: number;
}

export interface FeishuSendInput {
  webhookUrl: string | null | undefined;
  /** text / markdown 模式时必填 */
  message?: string;
  /** post 模式时必填, 与 message 互斥 */
  post?: FeishuPost;
  msgType?: FeishuMsgType;
}

// 功能: 发一条飞书自定义机器人消息. 成功返 { sent:true, status }, 失败返
//   { sent:false, reason } —— **永不抛错**.
// 关注点:
//   - 与 sendNotify 同语义: webhookUrl 为空 / URL 不合法 / 内容为空都返回失败
//     但不抛 —— 没配渠道的实例要能正常跑, 通知能力静默不可用(只 warn 一条).
//   - 调用方在任务生命周期里(如超时回调后续接入)应该 void + .catch(), 不要 await,
//     通知的网络往返不该压在状态机路径上。
export async function sendFeishuWebhook(input: FeishuSendInput): Promise<FeishuSendResult> {
  const url = input.webhookUrl?.trim();
  if (!url) {
    console.warn("[feishu] 没有 webhook URL(用户未配 feishu_webhook_url), 跳过发送");
    return { sent: false, reason: "no webhook url configured" };
  }
  if (!isValidFeishuWebhookUrl(url)) {
    console.warn(`[feishu] webhook URL 格式不合法, 跳过发送: ${url.slice(0, 60)}…`);
    return { sent: false, reason: "invalid webhook url format" };
  }

  const msgType: FeishuMsgType = input.msgType ?? "markdown";

  // 校验: 三种模式互斥且各自必填
  if (msgType === "post") {
    if (!input.post || !Array.isArray(input.post.content) || input.post.content.length === 0) {
      console.warn("[feishu] post 模式要求 post.content 是非空二维数组");
      return { sent: false, reason: "post mode requires post.content (non-empty 2D array)" };
    }
    if (input.message?.trim()) {
      console.warn("[feishu] post 模式下 message 被忽略 (互斥)");
    }
  } else {
    const message = input.message?.trim();
    if (!message) {
      console.warn("[feishu] 消息为空, 跳过发送");
      return { sent: false, reason: "empty message" };
    }
  }

  // 构造请求体
  let requestBody: unknown;
  if (msgType === "post") {
    const locale = input.post!.locale ?? "zh_cn";
    requestBody = {
      msg_type: "post",
      content: {
        post: {
          [locale]: {
            ...(input.post!.title ? { title: input.post!.title } : {}),
            content: input.post!.content,
          },
        },
      },
    };
  } else {
    requestBody = {
      msg_type: msgType,
      content: { [msgType]: input.message!.trim() },
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(requestBody),
    });

    // 飞书机器人 4xx 和"HTTP 200 + body.code!=0"两类都要当失败. 后者典型:
    //   - code 10208 "msg type markdown not support" (webhook 不支持 md)
    //   - code 19001 "关键词校验失败" (群机器人开了关键词策略)
    //   - code 190002 等限流类
    // body 一次性读完解析, 限长防 traceback 撑爆 console; 非 JSON 视为 OK.
    let bodyText = "";
    let bodyJson: { code?: number; msg?: string } | null = null;
    try {
      bodyText = await res.text();
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = null;
    }

    if (!res.ok) {
      const reasonDetail = bodyJson?.msg
        ? `: ${String(bodyJson.msg).slice(0, 200)}`
        : `: ${bodyText.slice(0, 200)}`;
      const reason = `HTTP ${res.status}${reasonDetail}`;
      console.warn(`[feishu] 投递失败: ${reason}`);
      return { sent: false, reason, status: res.status };
    }
    if (bodyJson && typeof bodyJson.code === "number" && bodyJson.code !== 0) {
      const msgDetail = bodyJson.msg ? `: ${String(bodyJson.msg).slice(0, 200)}` : "";
      const reason = `feishu code ${bodyJson.code}${msgDetail}`;
      console.warn(`[feishu] 投递被拒 (HTTP 200 但 body.code!=0): ${reason}`);
      return { sent: false, reason, status: res.status };
    }
    console.log(`[feishu] 已投递 (HTTP ${res.status})`);
    return { sent: true, status: res.status };
  } catch (err) {
    const reason = (err as Error).message || String(err);
    console.warn(`[feishu] 投递异常: ${reason}`);
    return { sent: false, reason };
  }
}