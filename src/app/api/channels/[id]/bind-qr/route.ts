// GET /api/channels/[id]/bind-qr - 渠道扫码绑定 QR (docs/plans/channel-qr-bind.md D1)
//
// 功能: owner 校验后按渠道类型返回 { qr_content, qr_svg, hint, copy_text }:
//   telegram: QR = https://t.me/<bot_username>?start=<bind_code> 深链 (bot_username
//     用渠道 token 调 Bot API getMe 取, 进程内存缓存 24h); 失败 400 BOT_UNREACHABLE.
//   feishu/lark: QR = 纯文本 "bind <码>" (hint 按类型分 feishu.cn / larksuite.com 域名).
//   wecom: qr_content = null (凭据即绑定, 诚实 UI 不做假 QR).
// 关注点: SVG 由服务端 qrcode 库生成, SPA 零新依赖; v-html 只渲染本库产物
//   (纯 path 静态 SVG, bind_code 白名单字符, bot_username 走 Telegram API 但
//   仅进 QR 编码不进 SVG 标签), 无注入面; getMe 失败不缓存 (下次重试).

import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getChannelConfigById, type ChannelConfig } from "@/lib/db/channel-configs";

export interface BindQrResponse {
  /** QR 编码内容; null = 该渠道无扫码动作 (wecom) */
  qr_content: string | null;
  /** 服务端生成的 SVG 字符串 (qr_content 为 null 时同样 null) */
  qr_svg: string | null;
  hint: string;
  /** 一键复制文本 (telegram = 深链, feishu/lark = bind 命令; wecom = null) */
  copy_text: string | null;
}

// telegram bot_username 缓存: key = channel id. 24h TTL, 只缓存成功结果.
// 关注点: 进程内存态, 重启清零可接受 (getMe 只是慢一下, 不影响正确性).
const botUsernameCache = new Map<string, { username: string; expires: number }>();
const BOT_USERNAME_TTL_MS = 24 * 60 * 60 * 1000;

// 功能: 用 bot token 调 Telegram Bot API getMe 拿 bot_username (带 24h 缓存).
// 关注点: api.telegram.org 国内被墙, 部署 env 需 NODE_USE_ENV_PROXY + HTTPS_PROXY
//   (同 telegram adapter 出站); 失败抛 Error 由 route 转 400 BOT_UNREACHABLE.
async function getBotUsername(config: ChannelConfig): Promise<string> {
  const cached = botUsernameCache.get(config.id);
  if (cached && cached.expires > Date.now()) return cached.username;

  const token = (config.secret ?? "").trim();
  if (!token) throw new Error("no bot token");
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`getMe HTTP ${res.status}`);
  const j = (await res.json()) as { ok?: boolean; result?: { username?: string } };
  const username = j.ok === true && typeof j.result?.username === "string" ? j.result.username : null;
  if (!username) throw new Error("getMe returned no username");
  botUsernameCache.set(config.id, { username, expires: Date.now() + BOT_USERNAME_TTL_MS });
  return username;
}

// 功能: 按渠道类型产出 QR 内容 + hint + 复制文本; 不支持的类型抛 Error.
async function buildBindQr(config: ChannelConfig): Promise<BindQrResponse> {
  const code = config.bind_code;
  if (config.channel === "telegram") {
    const username = await getBotUsername(config);
    const deepLink = `https://t.me/${username}?start=${code}`;
    return {
      qr_content: deepLink,
      qr_svg: await QRCode.toString(deepLink, { type: "svg", margin: 1 }),
      hint: "扫码在 Telegram 中打开对话，发送 /start 即完成绑定。",
      copy_text: deepLink,
    };
  }
  if (config.channel === "feishu" || config.channel === "lark") {
    const domain = config.channel === "feishu" ? "feishu.cn" : "larksuite.com";
    const cmd = `bind ${code}`;
    return {
      qr_content: cmd,
      qr_svg: await QRCode.toString(cmd, { type: "svg", margin: 1 }),
      hint: `扫码得到命令，在${config.channel === "feishu" ? "飞书" : "Lark"}（${domain}）机器人会话中发送该命令完成绑定。`,
      copy_text: cmd,
    };
  }
  if (config.channel === "weixin") {
    // 微信渠道: 渠道行凭据来自扫码登录 (渠道身份), 用户↔项目绑定仍是 bind <码> 两段式
    // (feishu 同款文本 QR —— 扫码识别出命令, 粘贴到微信会话发送)
    const cmd = `bind ${code}`;
    return {
      qr_content: cmd,
      qr_svg: await QRCode.toString(cmd, { type: "svg", margin: 1 }),
      hint: "扫码得到命令，在微信里发给该微信号完成绑定。",
      copy_text: cmd,
    };
  }
  if (config.channel === "wecom") {
    // 凭据即绑定 (企微客服账号在企微后台接到平台), 无用户侧扫码动作, 不做假 QR
    return {
      qr_content: null,
      qr_svg: null,
      hint: "企微客服账号已通过凭据绑定，无需扫码。",
      copy_text: null,
    };
  }
  throw new Error(`unsupported channel: ${config.channel}`);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const config = getChannelConfigById(id);
  // no existence leak: 不存在与跨 owner 同码 404 (与 PATCH/DELETE 同语义)
  if (!config || config.owner_id !== userId) {
    return NextResponse.json(
      { error: "Channel not found", code: "CHANNEL_NOT_FOUND" },
      { status: 404 },
    );
  }
  try {
    return NextResponse.json(await buildBindQr(config));
  } catch (err: any) {
    if (config.channel === "telegram") {
      return NextResponse.json(
        { error: "Telegram bot 不可达（token 无效或网络失败）", code: "BOT_UNREACHABLE" },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
