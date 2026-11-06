// 飞书 intake 事件回调 (D2, docs/plans/intake-channel-unify.md).
//
// 功能: 飞书开放平台事件订阅的收侧 —— encrypt_key AES 解密、verification_token 校验、
//   im.message.receive_v1 文本消息解析. 凭据从 channel_configs (channel=feishu) 行
//   加密体内查表还原 (getWecomChannelByKfId 同款模式).
// 关注点: 本线路只管「收」, 发消息走部署机 lark-cli (收发分治) —— 这里没有
//   access_token / send API, 也没有 env 兜底 (feishu intake 是新线路, 无历史 env 凭据);
//   回调 URL 是飞书后台单值配置带不了 ?c= 参数, 多实例靠逐启用行试解密命中
//   (谁验签通过用谁, 同 wecom 候选遍历).

import { createHash, createDecipheriv } from "node:crypto";
import { listChannelConfigs } from "@/lib/db/channel-configs";

export interface FeishuCredentials {
  verificationToken: string;
  encryptKey: string;
}

export interface FeishuResolved {
  channelId: string; // channel_configs 行 id
  channel: string; // 渠道类型: "feishu" | "lark" (lark 扫码绑定 D2, 同协议不同部署域名)
  boundProjectId: string; // 渠道绑定项目
  roleId: string | null; // 渠道默认角色 (v526 D3); NULL = 未配
  versionId: string | null; // 渠道绑定版本 (v529); NULL = 跟随项目 current_version
  creds: FeishuCredentials;
}

// 功能: 解析 channel 行 secret 里的打包 JSON (verificationToken/encryptKey).
// 关注点: 两项必填, 缺一或 JSON 非法返 null (坏行不进候选); 凭据边界只此两项
//   —— app_id/app_secret 不进平台 (发消息走部署机 lark-cli, 收发分治).
export function parseFeishuSecret(secret: string | null): FeishuCredentials | null {
  if (!secret) return null;
  try {
    const j = JSON.parse(secret) as Record<string, unknown>;
    if (typeof j.verificationToken !== "string" || typeof j.encryptKey !== "string") {
      return null;
    }
    return { verificationToken: j.verificationToken, encryptKey: j.encryptKey };
  } catch {
    return null;
  }
}

// 功能: 列出全部启用的 feishu/lark channel 行, 解密还原凭据.
// 关注点: 坏 secret 行静默跳过 (同 wecom 候选过滤); lark 与 feishu 同回调协议
//   (验签解密与域名无关), 靠 channel type 区分, 候选一起遍历.
export function listFeishuChannels(): FeishuResolved[] {
  const rows = listChannelConfigs().filter(
    (c) => (c.channel === "feishu" || c.channel === "lark") && c.enabled,
  );
  const out: FeishuResolved[] = [];
  for (const row of rows) {
    const creds = parseFeishuSecret(row.secret);
    if (creds) {
      out.push({
        channelId: row.id,
        channel: row.channel,
        boundProjectId: row.bound_project_id,
        roleId: row.role_id,
        versionId: row.bound_version_id ?? null,
        creds,
      });
    }
  }
  return out;
}

// 功能: 飞书 encrypt_key AES 解密回调加密包. key = sha256(encrypt_key), IV = key 前 16 字节.
// 关注点: 飞书用标准 PKCS7 (块 16), autoPadding 默认开即可 (与企微块 32 自实现
//   填充不同, 勿混用); 解密失败返 null (候选遍历换下一行), 不抛.
export function decryptEvent(encrypted: string, encryptKey: string): string | null {
  try {
    const key = createHash("sha256").update(encryptKey, "utf8").digest();
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    const buf = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final(),
    ]);
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

// 功能: 从事件 JSON 提取验证 token (v2 事件在 header.token, v1 事件/验证请求在顶层 token).
export function extractEventToken(evt: Record<string, unknown>): string | null {
  const header = evt.header as Record<string, unknown> | undefined;
  if (header && typeof header.token === "string") return header.token;
  return typeof evt.token === "string" ? evt.token : null;
}

export interface ResolvedFeishuEvent {
  channel: FeishuResolved; // 验签命中的渠道行 (boundProjectId / roleId 从这取)
  event: Record<string, unknown>; // 解密后 (或明文) 的事件 JSON
}

// 功能: 验签 + 解析回调体 —— 加密包 ({encrypt: ...}) 逐启用 feishu 行试解密,
//   明文包逐行比对 token. 谁验签通过用谁, 返回命中行 + 事件 JSON.
// 关注点: 加密包解密成功后仍比对 verification_token (encrypt_key 证明来自飞书,
//   token 证明是同一应用, 双保险); 挑不出命中行返 null (route 转 403, fail-closed).
export function resolveEvent(
  body: unknown,
  channels: FeishuResolved[] = listFeishuChannels(),
): ResolvedFeishuEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const encrypted = typeof b.encrypt === "string" ? b.encrypt : null;
  for (const ch of channels) {
    let evt: Record<string, unknown> | null = null;
    if (encrypted !== null) {
      const plain = decryptEvent(encrypted, ch.creds.encryptKey);
      if (plain === null) continue;
      try {
        evt = JSON.parse(plain) as Record<string, unknown>;
      } catch {
        continue;
      }
    } else {
      evt = b;
    }
    const token = extractEventToken(evt);
    if (token !== null && token === ch.creds.verificationToken) {
      return { channel: ch, event: evt };
    }
  }
  return null;
}

// 事件去重缓冲 (飞书 at-least-once: 非 200 / 超时会带同 event_id 重投).
// 关注点: 内存态, 重启清零可接受 (重投窗口短); 超 500 条按插入序裁剪到 400,
//   防 Map 只增不减 (可持续性反模式兜底).
const seenEventIds = new Map<string, number>();

// 功能: 事件去重. 首见记录并返 false, 重复投递返 true.
export function consumeEventId(eventId: string): boolean {
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.set(eventId, Date.now());
  if (seenEventIds.size > 500) {
    for (const k of seenEventIds.keys()) {
      seenEventIds.delete(k);
      if (seenEventIds.size <= 400) break;
    }
  }
  return false;
}

export interface FeishuInboundMessage {
  chatId: string; // oc_... (thread 的 external_user_id; p2p/群聊 chat_id 各自稳定)
  chatType: string; // p2p | group
  messageId: string; // om_... (飞书侧消息 id)
  text: string;
}

// 功能: 解析 im.message.receive_v1 的文本消息; 其他事件 / 非文本消息返 null.
// 关注点: content 是 JSON 字符串 (text 类型形如 {"text":"..."}); 群聊正文里的
//   @机器人 at 标记保留原样 (不影响语义, 去 mention 需 mention 列表切片, 后续要再做).
export function parseMessageEvent(evt: unknown): FeishuInboundMessage | null {
  if (!evt || typeof evt !== "object") return null;
  const e = evt as Record<string, unknown>;
  const header = e.header as Record<string, unknown> | undefined;
  if (!header || header.event_type !== "im.message.receive_v1") return null;
  const ev = e.event as Record<string, unknown> | undefined;
  if (!ev || ev.message_type !== "text") return null;
  const chatId = typeof ev.chat_id === "string" ? ev.chat_id : "";
  if (!chatId) return null;
  let text = "";
  try {
    const content = JSON.parse(
      typeof ev.content === "string" ? ev.content : "{}",
    ) as Record<string, unknown>;
    text = typeof content.text === "string" ? content.text : "";
  } catch {
    text = "";
  }
  if (!text) return null;
  return {
    chatId,
    chatType: typeof ev.chat_type === "string" ? ev.chat_type : "",
    messageId: typeof ev.message_id === "string" ? ev.message_id : "",
    text,
  };
}
