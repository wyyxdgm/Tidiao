// Telegram 渠道插件 (飞书 R184, P0).
//
// 功能: Telegram Bot API 适配 —— webhook 入站 (update) 解析 + sendMessage 出站.
// 收: Telegram -> POST /api/intake/telegram?c=<config_id>, X-Telegram-Bot-Api-Secret-Token 头比对防伪.
// 发: POST api.telegram.org/bot<token>/sendMessage.
//
// 关注点:
// - 出站直连 api.telegram.org 国内被墙 (实测 000 超时), 部署 env 必须
//   NODE_USE_ENV_PROXY=1 + HTTPS_PROXY (Node 24 内置 fetch 读这两个 env, 实测 200).
//   代理挂了 = 通道瘫 (入站不受影响, Telegram 服务器 -> dao.example.com 入站无需代理).
// - 无 48h/5 条窗口 (对比 wecom), Telegram bot 主动发无限制, 不实现 outboundGate.
// - 仅处理 private chat 文本消息; 群消息/附件/非文本返回 null 忽略.

import type { ChannelAdapter, InboundMessage, OutboundTarget } from "./types";
import type { ChannelConfig } from "@/lib/db/channel-configs";

interface TgUpdate {
  message?: {
    chat?: { id?: number; type?: string };
    from?: { id?: number; first_name?: string; username?: string };
    text?: string;
  };
}

export const telegramAdapter: ChannelAdapter = {
  type: "telegram",
  label: "Telegram",
  askStyleChannel: "h5", // 无窗口限制, 多回合逐个问 (同 h5 风格, 见 prompt.ts ASK_STYLE)

  verifyRequest(request: Request, config: ChannelConfig): boolean {
    // Telegram webhook 建立时设置的 secret_token 会原样回传在请求头.
    // 未配 webhook_secret 的 config 不校验 (弱安全, 建议配置).
    if (!config.webhook_secret) return true;
    return request.headers.get("x-telegram-bot-api-secret-token") === config.webhook_secret;
  },

  parseInbound(payload: unknown): InboundMessage | null {
    const update = payload as TgUpdate;
    const msg = update?.message;
    if (!msg?.text || msg.chat?.type !== "private" || !msg.chat.id || !msg.from?.id) {
      return null;
    }
    const name = msg.from.first_name || msg.from.username || String(msg.from.id);
    return {
      externalUserId: String(msg.from.id),
      externalUserName: name,
      threadKey: String(msg.chat.id),
      text: msg.text,
    };
  },

  async sendMessage(config: ChannelConfig, target: OutboundTarget, text: string): Promise<void> {
    const token = config.secret;
    if (!token) throw new Error("telegram bot token not configured");
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target.externalUserId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`telegram sendMessage failed: ${res.status} ${body.slice(0, 200)}`);
    }
  },
};
