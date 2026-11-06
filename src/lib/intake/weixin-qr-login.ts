// 微信扫码登录会话管理 (docs/plans/channel-qr-bind.md D3).
//
// 功能: qr-login 两端点共享的状态机 —— POST 建 login 会话 (取 iLink QR + 内存 Map
//   TTL 10min), GET 轮询状态 (挂起式归一化), success 时自动创建 channel 行.
// 独立成模块 (不放 route 文件): 两个 route 文件必须共享同一份 Map, 且状态机
// 逻辑集中才可测 (mock iLink 端点直测状态迁移).
//
// 关注点:
// - Map 是进程内存态, 重启清零可接受 (用户重扫一次, 与 bind-qr 的 username 缓存同语义).
// - success 建行: secret = 加密 JSON {bot_token, ilink_bot_id} (parseWeixinSecret 消费),
//   bind_code 由 createChannelConfig 自动生成 (用户侧绑定仍走 bind <码> 两段式);
//   bound_project_id 建 QR 前必选 (channel 行归属必填), role_id/bound_version_id 可选.
// - expired/error 后条目即删 (QR 不可复用, 前端重新生成); success 同删.

import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";
import { createChannelConfig, type ChannelConfig } from "@/lib/db/channel-configs";
import { getBotQrcode, pollQrcodeStatus } from "@/lib/intake/weixin";

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface WeixinLoginSession {
  qrcode: string;
  owner_id: string;
  bound_project_id: string;
  role_id: string | null;
  bound_version_id: string | null;
  created_at: number;
  /** 服务端生成的 QR SVG (编码 qrcode_img_content URL, 前端直接渲染) */
  qr_svg: string;
  /** 原始打开链接 (QR 编码内容, 备用展示) */
  qr_url: string;
}

// 内存会话表: login_id → session
const sessions = new Map<string, WeixinLoginSession>();

// 功能: 清过期会话 (读时顺手, 不依赖后台 GC).
function sweepExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.created_at > LOGIN_TTL_MS) sessions.delete(id);
  }
}

// 功能: 建登录会话 —— 调 iLink 取 QR, 服务端把 qrcode_img_content 编码成 SVG,
//   存内存 Map (TTL 10min), 返回 login_id + SVG. iLink 调用失败抛 Error (route 转 502).
export async function createLoginSession(input: {
  owner_id: string;
  bound_project_id: string;
  role_id?: string | null;
  bound_version_id?: string | null;
}): Promise<{ login_id: string; qr_svg: string; qr_url: string; expires_in: number }> {
  sweepExpired();
  const qr = await getBotQrcode();
  // 🔴 QR 编码的是 qrcode_img_content (liteapp.weixin.qq.com 打开链接), 不是 qrcode 码值
  const qrSvg = await QRCode.toString(qr.qrcode_img_content, { type: "svg", margin: 1 });
  const loginId = uuidv4();
  sessions.set(loginId, {
    qrcode: qr.qrcode,
    owner_id: input.owner_id,
    bound_project_id: input.bound_project_id,
    role_id: input.role_id ?? null,
    bound_version_id: input.bound_version_id ?? null,
    created_at: Date.now(),
    qr_svg: qrSvg,
    qr_url: qr.qrcode_img_content,
  });
  return { login_id: loginId, qr_svg: qrSvg, qr_url: qr.qrcode_img_content, expires_in: LOGIN_TTL_MS / 1000 };
}

export interface WeixinLoginPollResult {
  status: "pending" | "scanned" | "success" | "expired" | "error";
  /** success 时返回新建渠道行 (db 形态; route 层转 public 剥凭据) */
  channel?: ChannelConfig;
  message?: string;
}

// 功能: 轮询登录状态. login_id 不存在 / 跨 owner / TTL 过 → expired (前端重新生成);
//   iLink pending/scanned 透传; success 建 channel 行并删除会话.
export async function pollLoginStatus(loginId: string, ownerId: string): Promise<WeixinLoginPollResult> {
  sweepExpired();
  const session = sessions.get(loginId);
  // 跨 owner: 拒判 expired 但不动别人的会话 (no existence leak + 防误删)
  if (session && session.owner_id !== ownerId) {
    return { status: "expired", message: "登录会话不存在或已过期" };
  }
  // 不存在 / TTL 过: 统一 expired 语义 (前端引导重新生成)
  if (!session || Date.now() - session.created_at > LOGIN_TTL_MS) {
    sessions.delete(loginId);
    return { status: "expired", message: "登录会话已过期，请重新生成二维码" };
  }
  const poll = await pollQrcodeStatus(session.qrcode);
  if (poll.status === "success") {
    sessions.delete(loginId); // QR 一次性: 登录成功即作废
    const botId = poll.ilink_bot_id ?? "";
    const config: ChannelConfig = createChannelConfig({
      channel: "weixin",
      name: `weixin-iLink-${botId.slice(0, 8) || "bot"}`,
      secret: JSON.stringify({ bot_token: poll.bot_token, ilink_bot_id: botId }),
      bound_project_id: session.bound_project_id,
      bound_version_id: session.bound_version_id,
      role_id: session.role_id,
      owner_id: session.owner_id,
    });
    return { status: "success", channel: config };
  }
  if (poll.status === "expired") {
    sessions.delete(loginId);
    return { status: "expired", message: "二维码已过期，请重新生成" };
  }
  return { status: poll.status, message: poll.message };
}

// 测试辅助: 清会话表
export function _resetWeixinLoginForTest(): void {
  sessions.clear();
}
