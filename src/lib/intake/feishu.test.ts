// 飞书 intake 收侧单测 (D2, docs/plans/intake-channel-unify.md).
// 覆盖: encrypt_key AES 解密回路 / resolveEvent 逐行验签 (加密包 + 明文包) /
//   channel 行查表过滤 / im.message.receive_v1 解析 / event_id 去重.
// fixture 与平台解密逻辑对称: key = sha256(encryptKey), IV = key[0:16], 标准 PKCS7.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, createCipheriv } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "../db/index";
import { createChannelConfig } from "../db/channel-configs";

const ENC_KEY = "feishuTestEncryptKey";
const VERIFY_TOKEN = "feishuVerifyToken123";

// 与 feishu.ts decryptEvent 对称的加密 fixture (标准 PKCS7, Node auto padding)
function encryptPayload(plain: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

// 飞书 url_verification 握手事件体 fixture
function challengeEvent(token = VERIFY_TOKEN): Record<string, unknown> {
  return { challenge: "ajls384kdd", token, type: "url_verification" };
}

// 飞书 v2 事件体 fixture (im.message.receive_v1)
function messageEvent(
  opts: { chatId?: string; text?: string; chatType?: string; token?: string; eventId?: string } = {},
): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: opts.eventId ?? "evt-1",
      event_type: "im.message.receive_v1",
      token: opts.token ?? VERIFY_TOKEN,
      create_time: "1609286482000",
    },
    event: {
      sender: { sender_id: { open_id: "ou_sender1" }, sender_type: "user" },
      message_id: "om_msg1",
      chat_id: opts.chatId ?? "oc_chat1",
      chat_type: opts.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: opts.text ?? "登录页要加导出按钮" }),
    },
  };
}

function encryptedBody(evt: unknown, key = ENC_KEY): { encrypt: string } {
  return { encrypt: encryptPayload(JSON.stringify(evt), key) };
}

describe("飞书回调加密 + 逐行验签 (D2)", () => {
  let tmpDir: string;
  let ownerId: string;
  let projectId: string;

  // roles/users FK: channel 行的 owner 需真实 users 行 (同 wecom.test.ts)
  function ensureUser(id: string): void {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", "user");
  }

  function createFeishuRow(opts: { token?: string; encKey?: string; enabled?: boolean } = {}) {
    const cfg = createChannelConfig({
      channel: "feishu",
      name: `feishu-测试-${Math.random().toString(36).slice(2, 8)}`,
      secret: JSON.stringify({
        verificationToken: opts.token ?? VERIFY_TOKEN,
        encryptKey: opts.encKey ?? ENC_KEY,
      }),
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    if (opts.enabled === false) {
      getDb().prepare("UPDATE channel_configs SET enabled = 0 WHERE id = ?").run(cfg.id);
    }
    return cfg;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-feishu-intake-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();
    ownerId = uuidv4();
    projectId = uuidv4();
    ensureUser(ownerId);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("decryptEvent 回路: sha256(encryptKey) 做 key, 标准密文解回明文; 错 key 返 null 不抛", async () => {
    const { decryptEvent } = await import("./feishu");

    const plain = JSON.stringify(challengeEvent());
    expect(decryptEvent(encryptPayload(plain, ENC_KEY), ENC_KEY)).toBe(plain);
    expect(decryptEvent(encryptPayload(plain, ENC_KEY), "wrongKey")).toBeNull();
    expect(decryptEvent("not-base64!!", ENC_KEY)).toBeNull();
  });

  it("加密 url_verification: 逐行试解密命中 → challenge 事件 + 命中渠道行", async () => {
    createFeishuRow();
    const { resolveEvent } = await import("./feishu");

    const resolved = resolveEvent(encryptedBody(challengeEvent()));
    expect(resolved).not.toBeNull();
    expect(resolved!.event).toEqual(challengeEvent());
    expect(resolved!.channel.boundProjectId).toBe(projectId);
    expect(resolved!.channel.channelId).toMatch(/^ch_/);
  });

  it("token 不匹配 / 全部行解不开 → 返 null (route 转 403, fail-closed)", async () => {
    createFeishuRow();
    const { resolveEvent } = await import("./feishu");

    // 加密包: 密文能解 (同 key) 但事件内 token 不是本应用
    expect(resolveEvent(encryptedBody(challengeEvent("otherToken")))).toBeNull();
    // 加密包: 用别家 encryptKey 加密, 本行解不开
    expect(resolveEvent(encryptedBody(challengeEvent(), "otherEncryptKey"))).toBeNull();
    // 明文包: token 不匹配
    expect(resolveEvent(challengeEvent("otherToken"))).toBeNull();
    // 空表 / 非 object
    expect(resolveEvent("str")).toBeNull();
  });

  it("明文包按 token 命中 (v2 header.token / v1 顶层 token 都认)", async () => {
    createFeishuRow();
    const { resolveEvent } = await import("./feishu");

    expect(resolveEvent(messageEvent())!.event).toEqual(messageEvent());

    const v1 = { event: { text: "x" }, token: VERIFY_TOKEN, type: "event_callback" };
    expect(resolveEvent(v1)!.event).toEqual(v1);
  });

  it("查表过滤: disabled 行 / telegram 行 / 坏 secret 行不进候选", async () => {
    const { listFeishuChannels, parseFeishuSecret, resolveEvent } = await import("./feishu");

    expect(listFeishuChannels()).toHaveLength(0); // 空表

    createFeishuRow({ enabled: false });
    createChannelConfig({
      channel: "telegram",
      name: "tg bot",
      secret: "123:ABC",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    createChannelConfig({
      channel: "feishu",
      name: "坏行",
      secret: "not-json",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    createFeishuRow(); // 唯一有效行

    const chans = listFeishuChannels();
    expect(chans).toHaveLength(1);
    expect(chans[0].creds).toEqual({ verificationToken: VERIFY_TOKEN, encryptKey: ENC_KEY });
    expect(chans[0].roleId).toBeNull();

    // 加密回调仍可命中唯一有效行 (坏行被过滤后不干扰试解密)
    expect(resolveEvent(encryptedBody(messageEvent()))!.channel.channelId).toBe(chans[0].channelId);

    expect(parseFeishuSecret(null)).toBeNull();
    expect(parseFeishuSecret('{"verificationToken":"x"}')).toBeNull(); // 缺 encryptKey
  });
});

describe("im.message.receive_v1 解析 + event_id 去重", () => {
  it("文本消息解出 chat_id / chat_type / text; content 是 JSON 字符串", async () => {
    const { parseMessageEvent } = await import("./feishu");

    const msg = parseMessageEvent(messageEvent({ chatId: "oc_group9", chatType: "group" }))!;
    expect(msg.chatId).toBe("oc_group9");
    expect(msg.chatType).toBe("group");
    expect(msg.text).toBe("登录页要加导出按钮");
    expect(msg.messageId).toBe("om_msg1");
  });

  it("非文本 / 非目标事件 / 缺 chat_id / 空 text / 坏 content 一律返 null", async () => {
    const { parseMessageEvent } = await import("./feishu");

    const img = messageEvent();
    (img.event as Record<string, unknown>).message_type = "image";
    expect(parseMessageEvent(img)).toBeNull();

    const other = messageEvent();
    ((other.header as Record<string, unknown>)).event_type = "im.chat.updated_v1";
    expect(parseMessageEvent(other)).toBeNull();

    const noChat = messageEvent();
    (noChat.event as Record<string, unknown>).chat_id = "";
    expect(parseMessageEvent(noChat)).toBeNull();

    const badContent = messageEvent();
    (badContent.event as Record<string, unknown>).content = "not-json";
    expect(parseMessageEvent(badContent)).toBeNull();

    expect(parseMessageEvent(challengeEvent())).toBeNull(); // url_verification 不是消息
  });

  it("consumeEventId: 首见 false, 重投 true", async () => {
    const { consumeEventId } = await import("./feishu");
    expect(consumeEventId("evt-dup-1")).toBe(false);
    expect(consumeEventId("evt-dup-1")).toBe(true);
    expect(consumeEventId("evt-dup-2")).toBe(false);
  });
});
