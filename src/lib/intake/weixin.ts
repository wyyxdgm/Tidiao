import { createDecipheriv } from "node:crypto";

// 微信个人号 iLink bot 协议客户端 (docs/plans/channel-qr-bind.md D3).
//
// 功能: 封装腾讯官方 iLink bot 开放平台 (ilinkai.weixin.qq.com/ilink/bot) 五类调用:
//   1. 扫码登录: get_bot_qrcode + get_qrcode_status (免鉴权, 挂起式)
//   2. 收: getupdates 长轮询 (游标 get_updates_buf, 服务端 ack 语义 —— 提交才算消费)
//   3. 发: sendmessage (msg.item_list 文本)
//   4. 消息解析: buildInboundMessage (message_type=2 是 bot 自发消息, 跳过)
//   5. 语音: 入站 audio_item → CDN 下载 + AES-128-ECB 解密 (出站语音未实现, 协议无样例)
// 协议契约从 zai-org/ZCode weixinProvider.ts / weixinRegistration.ts 提取 (2026-10-13),
// 响应容器字段做了防御式多形态读取 (msgs/messages/updates/items/list ×
// get_updates_buf/buf/next_buf), iLink 无公开协议文档, 宽进严出.
//
// 关注点:
// - 所有请求带 base_info.channel_version 包装 + 4 个鉴权头 (ZCode 同款);
//   X-WECHAT-UIN 是随机 uin 的 base64 (协议要求但不校验值).
// - get_qrcode_status 会挂起等手机确认, 超时 ≠ 失败 —— 调用方 (qr-login status
//   route) 把 AbortError/TimeoutError 归 pending 让前端继续轮询.
// - 出站文本统一 LF→CRLF (微信 iLink 不同客户端对 LF 处理不一致, ZCode Bugfix 同款).
// - ilinkai.weixin.qq.com 国内直连可达 (2026-10-13 WSL 探针验证), 无需代理.

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const API_PREFIX = "/ilink/bot";
// base_info.channel_version —— ZCode weixinProvider 常量, 协议握手用
const CHANNEL_VERSION = "2.0.0";
// message_type 枚举: 2 = bot 发出的消息 (轮询回包里会出现自己发的回显, 跳过)
const MESSAGE_TYPE_BOT = 2;
const GET_UPDATES_TIMEOUT_MS = 90_000; // 长轮询挂起上限 (ZCode 同款)
const QR_STATUS_TIMEOUT_MS = 25_000; // qr-login status route 的 fetch 超时 (超时归 pending)

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(rec: Record<string, unknown> | null | undefined, key: string): string {
  const v = rec?.[key];
  return typeof v === "string" ? v : "";
}

function readNumberOrString(rec: Record<string, unknown> | null | undefined, key: string): string {
  const v = rec?.[key];
  if (typeof v === "string") return v;
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function randomWechatUin(): string {
  return Buffer.from(String(Math.floor(Math.random() * 0x1_0000_0000)), "utf8").toString("base64");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

function appendBaseInfo(body: unknown): unknown {
  if (!isRecord(body)) return body;
  return { base_info: { channel_version: CHANNEL_VERSION }, ...body };
}

// iLink 响应可能把业务字段包在 data 里 (unwrapData 兼容两种)
function unwrapData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
}

// 功能: POST 请求 + ret/errcode 双错误码检查 (iLink 混用两种, 任一非 0 = 业务失败).
async function postIl<T>(token: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(`${ILINK_BASE_URL}${API_PREFIX}${path}`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(appendBaseInfo(body ?? {})),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`weixin ilink ${path} failed: HTTP ${res.status}`);
  }
  const payload = await res.json();
  const data = unwrapData(payload);
  const ret = typeof data.ret === "number" ? data.ret : null;
  const errcode = typeof data.errcode === "number" ? data.errcode : null;
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const msg = readString(data, "errmsg") || readString(data, "message") || `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    throw new Error(`weixin ilink ${path} failed: ${msg}`);
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// 凭据解析
// ---------------------------------------------------------------------------

export interface WeixinSecret {
  bot_token: string;
  ilink_bot_id: string;
}

// 功能: 从 channel 行 secret 解出 iLink 凭据. 扫码登录写入的是 JSON; 兼容手填纯
//   token 字符串 (fallback ilink_bot_id 为空串, sendmessage 的 from_user_id 用它).
export function parseWeixinSecret(secret: string | null): WeixinSecret | null {
  const raw = (secret ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const token = typeof parsed.bot_token === "string" ? parsed.bot_token.trim() : "";
    if (token) {
      return {
        bot_token: token,
        ilink_bot_id: typeof parsed.ilink_bot_id === "string" ? parsed.ilink_bot_id.trim() : "",
      };
    }
  } catch {
    // 非 JSON —— 按纯 token 字符串处理 (手动建行的路径)
  }
  return { bot_token: raw, ilink_bot_id: "" };
}

// ---------------------------------------------------------------------------
// 扫码登录 (免鉴权 GET, header iLink-App-ClientVersion)
// ---------------------------------------------------------------------------

export interface WeixinQrBegin {
  qrcode: string;
  qrcode_img_content: string;
}

// 功能: 取登录二维码. 注意 QR 图编码的是 qrcode_img_content 这个 URL (liteapp 微信
//   打开链接), 不是 qrcode 码值 —— 码值只用于查状态.
export async function getBotQrcode(): Promise<WeixinQrBegin> {
  const res = await fetch(`${ILINK_BASE_URL}${API_PREFIX}/get_bot_qrcode?bot_type=3`, {
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`get_bot_qrcode failed: HTTP ${res.status}`);
  }
  const data = unwrapData(await res.json());
  const ret = typeof data.ret === "number" ? data.ret : null;
  if (ret !== null && ret !== 0) {
    throw new Error(readString(data, "errmsg") || `get_bot_qrcode ret=${ret}`);
  }
  const qrcode = readString(data, "qrcode") || readString(data, "qr_code");
  const img = readString(data, "qrcode_img_content") || readString(data, "qrcode_url");
  if (!qrcode || !img) {
    throw new Error("get_bot_qrcode returned no qrcode");
  }
  return { qrcode, qrcode_img_content: img };
}

export type WeixinQrStatus = "pending" | "scanned" | "success" | "expired" | "error";

export interface WeixinQrPollResult {
  status: WeixinQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  message?: string;
}

// 功能: 归一化 get_qrcode_status 的 status 字段 (数字枚举 + 字符串别名, ZCode 同款映射).
export function normalizeQrStatus(status: unknown): WeixinQrStatus {
  if (typeof status === "number") {
    if (status === 0) return "pending";
    if (status === 1) return "scanned";
    if (status === 2) return "success";
    if (status === 3 || status === 4) return "expired";
    return "pending";
  }
  if (typeof status !== "string") return "pending";
  const s = status.toLowerCase();
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(s)) return "success";
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(s)) return "scanned";
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(s)) return "expired";
  if (["error", "failed", "fail"].includes(s)) return "error";
  return "pending";
}

// 功能: 轮询扫码状态. 🔴 挂起式接口 —— 手机确认前服务端不返回, fetch 超时归
//   pending (超时 ≠ 失败), 由调用方决定下一轮. success 时返回 bot_token + ilink_bot_id.
export async function pollQrcodeStatus(qrcode: string): Promise<WeixinQrPollResult> {
  let payload: Record<string, unknown>;
  try {
    const res = await fetch(
      `${ILINK_BASE_URL}${API_PREFIX}/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { headers: { "iLink-App-ClientVersion": "1" }, signal: AbortSignal.timeout(QR_STATUS_TIMEOUT_MS) },
    );
    if (!res.ok) {
      throw new Error(`get_qrcode_status failed: HTTP ${res.status}`);
    }
    payload = unwrapData(await res.json());
  } catch (err) {
    // TimeoutError (AbortSignal.timeout) / abort = 服务端挂起中, 不是失败
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { status: "pending" };
    }
    throw err;
  }
  const ret = typeof payload.ret === "number" ? payload.ret : null;
  if (ret !== null && ret !== 0) {
    return { status: "error", message: readString(payload, "errmsg") || `ret=${ret}` };
  }
  const status = normalizeQrStatus(payload.status ?? payload.qrcode_status ?? payload.qr_status);
  if (status === "success") {
    const token = readString(payload, "bot_token") || readString(payload, "token");
    if (!token) {
      return { status: "error", message: "扫码成功但未返回 bot_token" };
    }
    return {
      status: "success",
      bot_token: token,
      ilink_bot_id: readString(payload, "ilink_bot_id") || readString(payload, "bot_id"),
    };
  }
  return { status };
}

// ---------------------------------------------------------------------------
// 收: getupdates 长轮询
// ---------------------------------------------------------------------------

/** 归一化后的入站消息 (worker 消费形态) */
export interface WeixinInbound {
  /** 渠道消息 ID (去重用; 部分消息形态无 id, 为空串) */
  msgId: string;
  /** 发送方用户 ID (thread 的 external_user_id) */
  fromUserId: string;
  displayName?: string;
  /** 群 ID (私聊无); 私聊 = 个人微信 bot 的主场景 */
  chatId?: string;
  text: string;
  /** 语音媒体信息 (有值 = 可尝试下载 + ASR 转写) */
  audio?: WeixinAudioSource;
  /** 非文本媒体消息 (图片/视频/文件等, 本渠道不转写, worker 回兜底话术) */
  unsupported?: boolean;
  /** 回复时要回传的上下文 token (sendmessage context_token) */
  contextToken?: string;
  /** 原始 message_type (buildInboundMessage 过滤依据, 测试/诊断用) */
  messageType?: number;
}

/** 语音媒体下载要素 (iLink CDN 直链 + AES 解密 key) */
export interface WeixinAudioSource {
  downloadUrl: string;
  aesKey: string;
}

// 功能: 从 item_list 提取语音媒体要素. 协议契约从 ZCode readWeixinAttachmentItem 提取:
//   audio_item (可能嵌套 media) 内含 url/download_url/full_url 直链 + aes_key (hex32 或
//   base64 16 字节). 缺任一要素 = 拿不到媒体数据, 返回 null (走 unsupported 兜底).
function readAudioItem(raw: Record<string, unknown>): WeixinAudioSource | null {
  const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : null;
  const items = Array.isArray(raw.item_list)
    ? raw.item_list
    : inner && Array.isArray(inner.item_list)
      ? inner.item_list
      : [];
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.audio_item)) continue;
    const media = item.audio_item;
    const nested = isRecord(media.media) ? media.media : null;
    const src = nested ? { ...media, ...nested } : media;
    const url =
      readString(src, "url") ||
      readString(src, "download_url") ||
      readString(src, "downloadUrl") ||
      readString(src, "full_url") ||
      readString(src, "fullUrl");
    const key = readString(src, "aes_key") || readString(src, "aesKey") || readString(src, "aeskey");
    if (url && key) return { downloadUrl: url, aesKey: key };
  }
  return null;
}

// 功能: item_list 里有没有非文本媒体 item (图片/视频/文件等) —— 用于把纯媒体消息
//   透传给 worker 回兜底话术 (而不是静默吞掉, damo 实测对着空气说话的根因).
function hasNonTextMediaItem(raw: Record<string, unknown>): boolean {
  const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : null;
  const items = Array.isArray(raw.item_list)
    ? raw.item_list
    : inner && Array.isArray(inner.item_list)
      ? inner.item_list
      : [];
  return items.some((item) => {
    if (!isRecord(item)) return false;
    const textItem = isRecord(item.text_item) ? item.text_item : null;
    return !(readString(textItem, "text") || readString(item, "text") || readString(item, "content"));
  });
}

// 功能: 从原始消息提取文本 (顶层 text/content/message 或 msg.item_list[].text_item.text).
function readText(raw: Record<string, unknown>): string {
  const top = readString(raw, "text") || readString(raw, "content") || readString(raw, "message");
  if (top) return top;
  const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : null;
  const items = Array.isArray(raw.item_list)
    ? raw.item_list
    : inner && Array.isArray(inner.item_list)
      ? inner.item_list
      : [];
  const joined = items
    .map((item) => {
      if (!isRecord(item)) return "";
      const textItem = isRecord(item.text_item) ? item.text_item : null;
      return readString(textItem, "text") || readString(item, "text") || readString(item, "content");
    })
    .filter(Boolean)
    .join("\n");
  return joined || readString(inner, "text") || readString(inner, "content");
}

function readFromUserId(raw: Record<string, unknown>): string {
  const from = isRecord(raw.from) ? raw.from : null;
  const sender = isRecord(raw.sender) ? raw.sender : null;
  return (
    readString(raw, "from_user_id") ||
    readString(raw, "from") ||
    readString(raw, "from_user") ||
    readString(raw, "fromUser") ||
    readString(raw, "user_id") ||
    readString(raw, "userId") ||
    readString(from, "id") ||
    readString(from, "wxid") ||
    readString(sender, "id") ||
    readString(sender, "wxid")
  );
}

function readDisplayName(raw: Record<string, unknown>): string | undefined {
  const from = isRecord(raw.from) ? raw.from : null;
  const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : null;
  return (
    readString(raw, "name") ||
    readString(raw, "displayName") ||
    readString(raw, "nickname") ||
    readString(from, "name") ||
    readString(from, "nickname") ||
    readString(inner, "sender_name") ||
    undefined
  );
}

function readChatId(raw: Record<string, unknown>): string | undefined {
  return (
    readString(raw, "room") ||
    readString(raw, "room_id") ||
    readString(raw, "roomId") ||
    readString(raw, "chat") ||
    readString(raw, "chat_id") ||
    readString(raw, "chatId") ||
    undefined
  );
}

function readMsgId(raw: Record<string, unknown>): string {
  const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : null;
  return (
    readString(raw, "id") ||
    readString(raw, "msgid") ||
    readString(raw, "msgId") ||
    readNumberOrString(raw, "message_id") ||
    readString(inner, "id") ||
    readString(inner, "msgid") ||
    readString(inner, "msgId") ||
    readNumberOrString(inner, "message_id")
  );
}

function readContextToken(raw: Record<string, unknown>): string | undefined {
  const inner = isRecord(raw.msg) ? raw.msg : isRecord(raw.message) ? raw.message : null;
  return (
    readString(raw, "context_token") ||
    readString(raw, "contextToken") ||
    readString(inner, "context_token") ||
    undefined
  );
}

// 功能: 原始消息 → WeixinInbound. message_type=2 (bot 自发回显) / 无发送方 / 纯空
//   消息 → null. 无文本时: 语音 (audio_item 齐全) 带 audio 要素; 其他媒体
//   (图片/视频/文件) 标 unsupported=true —— worker 回兜底话术, 不再静默忽略
//   (damo 2026-10-15: 发语音毫无反应的根因就是这里整条返回 null).
export function buildInboundMessage(raw: Record<string, unknown>): WeixinInbound | null {
  const messageType = typeof raw.message_type === "number" ? raw.message_type : undefined;
  if (messageType === MESSAGE_TYPE_BOT) return null;
  const fromUserId = readFromUserId(raw).trim();
  if (!fromUserId) return null;
  const text = readText(raw).trim();
  const audio = readAudioItem(raw);
  if (!text && !audio) {
    if (!hasNonTextMediaItem(raw)) return null;
    return {
      msgId: readMsgId(raw),
      fromUserId,
      displayName: readDisplayName(raw),
      chatId: readChatId(raw),
      text: "",
      unsupported: true,
      contextToken: readContextToken(raw),
      messageType,
    };
  }
  return {
    msgId: readMsgId(raw),
    fromUserId,
    displayName: readDisplayName(raw),
    chatId: readChatId(raw),
    text,
    ...(audio ? { audio } : {}),
    contextToken: readContextToken(raw),
    messageType,
  };
}

export interface WeixinGetUpdatesResult {
  messages: WeixinInbound[];
  /** 下一游标: 响应里有新 buf 用新的, 没有保留旧 buf (ZCode readNextBuf ?? params.buf 语义) */
  buf: string;
}

// 功能: getupdates 长轮询 (90s 挂起). 返回解析后的消息 + 下一游标.
//   🔴 游标纪律: 返回的 buf 只是「服务端给的下一游标」, 提交 (持久化) 与否由
//   worker 决定 —— 整批消息业务处理成功才写, 失败不提交, 下轮重投本批.
export async function getUpdates(token: string, buf: string): Promise<WeixinGetUpdatesResult> {
  const payload = await postIl<Record<string, unknown>>(token, "/getupdates", { get_updates_buf: buf }, GET_UPDATES_TIMEOUT_MS);
  const container = unwrapData(payload);
  const rawMessages =
    container.msgs ?? container.messages ?? container.updates ?? container.items ?? container.list;
  const list: Record<string, unknown>[] = Array.isArray(rawMessages)
    ? rawMessages.filter(isRecord)
    : isRecord(rawMessages)
      ? [rawMessages]
      : [];
  const nextBuf =
    readString(container, "get_updates_buf") ||
    readString(container, "buf") ||
    readString(container, "next_buf") ||
    readString(container, "nextBuf") ||
    readString(container, "getUpdatesBuf") ||
    readString(container, "syncKey");
  return {
    messages: list.map(buildInboundMessage).filter((m): m is WeixinInbound => m !== null),
    buf: nextBuf || buf,
  };
}

// ---------------------------------------------------------------------------
// 语音媒体: CDN 下载 + AES 解密 (入站; 出站语音未实现 —— ZCode sendmessage 只有
//   text_item, 协议侧无发语音样例, 不硬造)
// ---------------------------------------------------------------------------

const VOICE_DOWNLOAD_TIMEOUT_MS = 15_000;
const VOICE_MAX_BYTES = 5 * 1024 * 1024; // 60s 语音远小于此, 超限按异常处理

// 功能: aes_key 归一化成 16 字节 AES-128 key. iLink 用 hex32 或 base64(解出 16 字节,
//   或解出的是 hex32 字符串再转) 两种形态 (ZCode parseWeixinAesKey 同款).
export function parseWeixinAesKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (/^[a-f0-9]{32}$/iu.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) return decoded;
    const decodedText = decoded.toString("utf8").trim();
    if (/^[a-f0-9]{32}$/iu.test(decodedText)) return Buffer.from(decodedText, "hex");
  } catch {
    return null;
  }
  return null;
}

// 功能: 解密 iLink CDN 媒体字节. 🔴 CDN 返回 AES-128-ECB + PKCS7 密文 (ZCode 实证,
//   直接保存是乱码文件), node crypto autoPadding 默认开 = PKCS7.
export function decryptWeixinCdnMedia(cipher: Buffer, aesKey: string): Buffer {
  const key = parseWeixinAesKey(aesKey);
  if (!key) throw new Error("weixin media aes_key invalid");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

// 功能: 下载语音媒体并解密, 返回明文音频字节 (silk/mp3 等原始格式, 由 ASR 层嗅探).
// 关注点: 15s 超时 + 5MB 上限; 调用方 (worker) 需 catch —— 下载失败降级兜底话术,
//   不能让语音挂掉整条收消息链 (游标纪律下抛错 = 整批重投).
export async function downloadWeixinAudio(audio: WeixinAudioSource, timeoutMs = VOICE_DOWNLOAD_TIMEOUT_MS): Promise<Buffer> {
  const res = await fetch(audio.downloadUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`weixin audio download failed: HTTP ${res.status}`);
  const cipher = Buffer.from(await res.arrayBuffer());
  if (cipher.byteLength === 0 || cipher.byteLength > VOICE_MAX_BYTES) {
    throw new Error(`weixin audio size out of range: ${cipher.byteLength}`);
  }
  return decryptWeixinCdnMedia(cipher, audio.aesKey);
}

// ---------------------------------------------------------------------------
// 发: sendmessage (文本 only)
// ---------------------------------------------------------------------------

// 功能: 发文本消息. from_user_id = ilink_bot_id (扫码登录返回), to_user_id = 对话方.
//   context_token 可选 (入站消息带回则回传, 协议上下文连续性).
export async function sendText(
  token: string,
  fromUserId: string,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  // 微信 iLink 不同客户端对 LF 处理不一致, 统一 CRLF (ZCode Bugfix 同款)
  const normalized = text.replace(/\r\n|\r|\n/g, "\r\n");
  await postIl(
    token,
    "/sendmessage",
    {
      msg: {
        from_user_id: fromUserId,
        to_user_id: toUserId,
        client_id: `hufu-weixin-${crypto.randomUUID()}`,
        message_type: MESSAGE_TYPE_BOT,
        message_state: 2, // FINISH
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: 1, text_item: { text: normalized } }],
      },
    },
    15_000,
  );
}
