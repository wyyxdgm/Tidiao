// 企微微信客服 API client.
//
// 功能: 企微微信客服的 access_token 管理、回调加解密 (WXBizMsgCrypt)、
//   sync_msg 拉取甲方消息、send_msg 发送蒸馏回复.
// 关注点: 微信客服用 sync_msg 拉取模式--回调只通知有新消息，需调 sync_msg
//   带 cursor 拉实际内容; cursor 暂存模块变量（重启会重拉，靠 msgid 去重兜底）;
//   48h/5条 窗口由出站路由用 intake_threads 表跟踪，这里只管发.
//   凭据 (D1, docs/plans/intake-channel-unify.md): channel_configs 查表优先
//   (getWecomChannelByKfId / listWecomCandidates), env 五常量兜底 —— 全部函数
//   的 creds 参数缺省时读 env, 查不到表行行为不回退 (现网回调不能断).

import { createHash, createDecipheriv } from "node:crypto";
import { listChannelConfigs } from "@/lib/db/channel-configs";

const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

// --- 凭据: 表行优先, env 兜底 ---

export interface WecomCredentials {
  corpId: string;
  corpSecret: string;
  aesKey: string; // EncodingAESKey (43 char base64)
  callbackToken: string;
  kfId: string; // open_kfid 客服账号 ID
}

export interface WecomResolved {
  channelId: string | null; // channel_configs 行 id; env 兜底时为 null
  boundProjectId: string | null; // 渠道绑定项目; env 兜底时为 null (route 落 INTAKE_PROJECT_ID)
  roleId: string | null; // 渠道默认角色 (v526 D3); env 兜底时为 null
  versionId: string | null; // 渠道绑定版本 (v529); null = 跟随项目 current_version; env 兜底时为 null
  creds: WecomCredentials;
}

// 功能: 解析 channel 行 secret 里的打包 JSON (corpId/corpSecret/aesKey/callbackToken/kfId).
// 关注点: KF_ID 也进 secret JSON —— v526 列够用不加列, 靠解密后匹配查回;
//   必填三项 (corpSecret/aesKey/callbackToken) 缺一或 JSON 非法都返 null.
export function parseWecomSecret(secret: string | null): WecomCredentials | null {
  if (!secret) return null;
  try {
    const j = JSON.parse(secret) as Record<string, unknown>;
    if (
      typeof j.corpSecret !== "string" ||
      typeof j.aesKey !== "string" ||
      typeof j.callbackToken !== "string"
    ) {
      return null;
    }
    return {
      corpId: typeof j.corpId === "string" ? j.corpId : "",
      corpSecret: j.corpSecret,
      aesKey: j.aesKey,
      callbackToken: j.callbackToken,
      kfId: typeof j.kfId === "string" ? j.kfId : "",
    };
  } catch {
    return null;
  }
}

// 功能: env 五常量兜底 (查不到表行时走旧路径, 现网回调不能断).
// 关注点: 调用时读 env (非模块级常量); 部分变量缺失也原样返回 (空串),
//   与旧模块级常量行为一致 —— API 调用会在请求期失败, 不在这里抛.
export function getWecomCredentialsFromEnv(): WecomCredentials {
  return {
    corpId: process.env.WECOM_CORP_ID ?? "",
    corpSecret: process.env.WECOM_CORP_SECRET ?? "",
    aesKey: process.env.WECOM_ENCODING_AES_KEY ?? "",
    callbackToken: process.env.WECOM_CALLBACK_TOKEN ?? "",
    kfId: process.env.WECOM_KF_ID ?? "",
  };
}

// 功能: 按 kf_id 查启用的 wecom channel 行, 解密还原凭据 + 绑定项目 + 默认角色.
// 关注点: kfId 为空 = 单实例场景, 唯一启用行才直取 (多行歧义返 null);
//   匹配靠解密后的 secret JSON (KF_ID 在加密体内, 不明文存列, v526 schema 不动).
export function getWecomChannelByKfId(kfId?: string): WecomResolved | null {
  const rows = listChannelConfigs().filter((c) => c.channel === "wecom" && c.enabled);
  const hits: WecomResolved[] = [];
  for (const row of rows) {
    const creds = parseWecomSecret(row.secret);
    if (!creds) continue;
    if (kfId && creds.kfId !== kfId) continue;
    hits.push({
      channelId: row.id,
      boundProjectId: row.bound_project_id,
      roleId: row.role_id,
      versionId: row.bound_version_id ?? null,
      creds,
    });
  }
  if (kfId) return hits[0] ?? null;
  return hits.length === 1 ? hits[0] : null;
}

// 功能: 回调解密候选列表 —— 启用的 wecom channel 行在前, env 兜底殿后.
// 关注点: 企微回调进来时还不知道 kf_id (消息体是加密的), 只能逐候选试解密,
//   谁验签通过用谁; route 层拿到消息里的 kf_id 后再用 getWecomChannelByKfId 精确定位.
export function listWecomCandidates(): WecomResolved[] {
  const rows = listChannelConfigs().filter((c) => c.channel === "wecom" && c.enabled);
  const candidates: WecomResolved[] = [];
  for (const row of rows) {
    const creds = parseWecomSecret(row.secret);
    if (creds) {
      candidates.push({
        channelId: row.id,
        boundProjectId: row.bound_project_id,
        roleId: row.role_id,
        versionId: row.bound_version_id ?? null,
        creds,
      });
    }
  }
  candidates.push({
    channelId: null,
    boundProjectId: null,
    roleId: null,
    versionId: null,
    creds: getWecomCredentialsFromEnv(),
  });
  return candidates;
}

// --- access_token 缓存 (按 corp 账号分开, 多账号各取各的 token) ---

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function credsKey(creds: WecomCredentials): string {
  return `${creds.corpId}|${creds.corpSecret}`;
}

// 功能: 获取企微 access_token，缓存至过期前 5 分钟.
// 关注点: 2h 有效期; 并发调用可能重复请求（无锁，可接受）;
//   缓存按 corpId+corpSecret 键控 —— 表行与 env 兜底是不同账号时互不覆盖.
export async function getAccessToken(
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): Promise<string> {
  const key = credsKey(creds);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(creds.corpId)}&corpsecret=${encodeURIComponent(creds.corpSecret)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`getAccessToken failed: ${data.errcode} ${data.errmsg}`);
  }
  if (!data.access_token) {
    throw new Error("getAccessToken returned no access_token");
  }
  tokenCache.set(key, {
    token: data.access_token as string,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  });
  return data.access_token as string;
}

// --- WXBizMsgCrypt 加解密 ---

// 功能: EncodingAESKey (43 char base64) -> 32 字节 AES key.
function decodeAesKey(b64: string): Buffer {
  return Buffer.from(b64 + "=", "base64");
}

// 功能: 企微回调签名验证. sha1(sort([token, timestamp, nonce, encrypted])).
export function verifySignature(
  timestamp: string,
  nonce: string,
  encrypted: string,
  msgSignature: string,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): boolean {
  const parts = [creds.callbackToken, timestamp, nonce, encrypted].sort();
  const calc = createHash("sha1").update(parts.join("")).digest("hex");
  return calc === msgSignature;
}

// 功能: AES-256-CBC 解密企微回调消息.
// 关注点: 解密后结构 = random(16) + msg_len(4 big-endian) + msg + corpid;
//   IV = key 前 16 字节.
//   必须 setAutoPadding(false): 企微 WXBizMsgCrypt 按 **块大小 32** 做 PKCS7 填充，
//   而 Node aes-256-cbc 的自动去填充按块大小 16 校验，填充量 >16 时会抛
//   "bad decrypt"（长 XML 极易触发，短 echostr 常侥幸通过）。
//   这里手动按 msg_len 切片，本就不依赖填充。
export function decryptCallback(
  encrypted: string,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): string {
  const key = decodeAesKey(creds.aesKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
  // skip 16 random + 4 msg_len
  const msgLen = decrypted.readUInt32BE(16);
  return decrypted.subarray(20, 20 + msgLen).toString("utf8");
}

// --- sync_msg 拉取消息 ---

let syncCursor: string = "";

export interface KfMessage {
  msgid: string;
  externalUserId: string; // external_userid
  content: string;
  msgType: string;
  sendTime: number;
  kfId?: string; // open_kfid, 消息所属客服账号 (旧版 API 可能不带)
}

// 功能: 拉取微信客服新消息（origin=3 用户发送的）.
// 关注点: cursor 暂存模块变量（重启会从 3 天内最早消息重拉）; 回调给的 callbackToken
//   10 分钟有效，带上可免频率限制; has_more=1 需循环拉（这里拉一轮，回调会再次触发）.
export async function syncMessages(
  callbackToken?: string,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): Promise<KfMessage[]> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${API_BASE}/kf/sync_msg?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cursor: syncCursor,
      open_kfid: creds.kfId,
      ...(callbackToken ? { token: callbackToken } : {}),
      limit: 1000,
      voice_format: 0,
    }),
  });
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`sync_msg failed: ${data.errcode} ${data.errmsg}`);
  }
  if (data.next_cursor) syncCursor = data.next_cursor;
  const list = (data.msg_list ?? []) as any[];
  // origin=3 = 微信客户发送; 跳过 4 (系统事件) / 5 (接待人员发送)，避免回环
  return list
    .filter((m) => m.origin === 3 && m.msgtype === "text")
    .map((m) => ({
      msgid: m.msgid,
      externalUserId: m.external_userid,
      content: m.text?.content ?? "",
      msgType: m.msgtype,
      sendTime: m.send_time,
      kfId: typeof m.open_kfid === "string" ? m.open_kfid : undefined,
    }));
}

// --- service_state 会话状态 ---

// 功能: 把会话转为「由智能助手接待」(state=1)，使 send_msg 可用.
// 关注点: send_msg 仅在 state 0(未处理)/1(智能助手接待) 下可发; 若会话流入
//   待接入池(2) 或人工接待(3) 则发送失败。入站时置 1 把会话锁在 AI 接待路径.
//   失败不抛（state 0 本身也能发），仅告警.
export async function ensureBotServiceState(
  externalUserId: string,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): Promise<void> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${API_BASE}/kf/service_state/trans?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      open_kfid: creds.kfId,
      external_userid: externalUserId,
      service_state: 1,
    }),
  });
  const data = await res.json();
  if (data.errcode !== 0) {
    console.warn(`[intake/wecom] service_state/trans -> 1 failed: ${data.errcode} ${data.errmsg}`);
  }
}

// --- send_msg 发送回复 ---

// 功能: 通过微信客服给甲方发文本消息.
// 关注点: 48h 窗口 + 5 条/轮限制由调用方（出站路由）用 intake_threads 跟踪;
//   这里只发，不判窗口（调用方已判）. creds 缺省走 env (出站路由现网行为不回退).
export async function sendKfMessage(
  externalUserId: string,
  text: string,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): Promise<void> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${API_BASE}/kf/send_msg?access_token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      touser: externalUserId,
      open_kfid: creds.kfId,
      msgtype: "text",
      text: { content: text },
    }),
  });
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`send_msg failed: ${data.errcode} ${data.errmsg}`);
  }
}

// --- 回调 XML 解析 ---

// 功能: 从解密后的 XML 提取 cursor Token（微信客服回调的 kf_msg_or_event 事件）.
// 关注点: 微信客服回调不含消息正文，只给一个 Token cursor，需调 sync_msg 取消息.
export function extractCallbackCursor(plainXml: string): string | null {
  const m = plainXml.match(/<Token><!\[CDATA\[([^\]]*)\]\]><\/Token>/);
  if (m) return m[1];
  const m2 = plainXml.match(/<Token>([^<]+)<\/Token>/);
  return m2 ? m2[1] : null;
}

// 功能: 判断是否 URL 验证请求（企微配回调 URL 时的 GET 验证）.
export function isUrlVerification(query: URLSearchParams): boolean {
  return Boolean(query.get("msg_signature") && query.get("echostr"));
}

// 功能: 处理 GET 验证 -- 验签 + 解密 echostr，返回明文.
export function handleUrlVerification(
  query: URLSearchParams,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): string | null {
  const msgSignature = query.get("msg_signature")!;
  const timestamp = query.get("timestamp")!;
  const nonce = query.get("nonce")!;
  const echostr = query.get("echostr")!;
  if (!verifySignature(timestamp, nonce, echostr, msgSignature, creds)) return null;
  return decryptCallback(echostr, creds);
}

// 功能: 解密 POST 回调体，返回明文 XML.
export function decryptCallbackBody(
  body: string,
  query: URLSearchParams,
  creds: WecomCredentials = getWecomCredentialsFromEnv(),
): string | null {
  const msgSignature = query.get("msg_signature")!;
  const timestamp = query.get("timestamp")!;
  const nonce = query.get("nonce")!;
  // body 是 XML，提取 <Encrypt> 段
  const m = body.match(/<Encrypt><!\[CDATA\[([^\]]*)\]\]><\/Encrypt>/) ?? body.match(/<Encrypt>([^<]+)<\/Encrypt>/);
  if (!m) return null;
  const encrypted = m[1];
  if (!verifySignature(timestamp, nonce, encrypted, msgSignature, creds)) return null;
  return decryptCallback(encrypted, creds);
}
