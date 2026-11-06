// Telegram adapter 单测 (飞书 R184, P0).
// 覆盖:
//   1. parseInbound: private 文本消息解析 / 群聊忽略 / 非文本忽略 / 无 message 忽略
//   2. verifyRequest: 配 secret 时头比对 (对/错/缺), 未配 secret 放行
//   3. sendMessage: 成功调用 sendMessage API (chat_id+text) / token 缺失抛错 / HTTP 非 2xx 抛错

import { describe, it, expect, vi, afterEach } from "vitest";
import { telegramAdapter } from "./telegram";
import type { ChannelConfig } from "@/lib/db/channel-configs";

function cfg(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: "ch_t1",
    channel: "telegram",
    name: "bot",
    secret: "123:abc",
    bound_project_id: "p1",
    bind_code: "ABCD2345",
    webhook_secret: null,
    enabled: true,
    owner_id: "u1",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://x/api/intake/telegram", { headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegramAdapter.parseInbound", () => {
  it("解析 private 文本消息", () => {
    const msg = telegramAdapter.parseInbound({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 111, first_name: "damo" },
        chat: { id: 111, type: "private" },
        text: "bind ABCD2345",
        date: 1,
      },
    });
    expect(msg).toEqual({
      externalUserId: "111",
      externalUserName: "damo",
      threadKey: "111",
      text: "bind ABCD2345",
    });
  });

  it("群聊消息忽略", () => {
    expect(
      telegramAdapter.parseInbound({
        message: { from: { id: 1 }, chat: { id: -100, type: "group" }, text: "hi" },
      }),
    ).toBeNull();
  });

  it("非文本 (图片/sticker) 忽略", () => {
    expect(
      telegramAdapter.parseInbound({
        message: { from: { id: 1 }, chat: { id: 1, type: "private" }, sticker: {} },
      }),
    ).toBeNull();
  });

  it("无 message 的 update (callback_query 等) 忽略", () => {
    expect(telegramAdapter.parseInbound({ update_id: 2, edited_message: {} })).toBeNull();
  });
});

describe("telegramAdapter.verifyRequest", () => {
  it("未配 webhook_secret 放行", () => {
    expect(telegramAdapter.verifyRequest(req(), cfg({ webhook_secret: null }))).toBe(true);
  });

  it("配 secret: 头匹配过, 不匹配/缺失拒", () => {
    const c = cfg({ webhook_secret: "s3cret" });
    expect(telegramAdapter.verifyRequest(req({ "x-telegram-bot-api-secret-token": "s3cret" }), c)).toBe(true);
    expect(telegramAdapter.verifyRequest(req({ "x-telegram-bot-api-secret-token": "wrong" }), c)).toBe(false);
    expect(telegramAdapter.verifyRequest(req(), c)).toBe(false);
  });
});

describe("telegramAdapter.sendMessage", () => {
  it("POST sendMessage 到正确的 bot API URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await telegramAdapter.sendMessage(cfg({ secret: "TOK" }), { externalUserId: "111" }, "你好");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOK/sendMessage");
    expect(init.body).toBe(JSON.stringify({ chat_id: "111", text: "你好" }));
  });

  it("token 未配置抛错", async () => {
    await expect(
      telegramAdapter.sendMessage(cfg({ secret: null }), { externalUserId: "1" }, "x"),
    ).rejects.toThrow("token not configured");
  });

  it("非 2xx 抛错并带状态码", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 400 })));
    await expect(
      telegramAdapter.sendMessage(cfg(), { externalUserId: "1" }, "x"),
    ).rejects.toThrow("400");
  });
});
