// 微信 iLink 客户端单测 (D3, docs/plans/channel-qr-bind.md).
// 覆盖: 消息解析 (message_type=2 过滤 / 多形态字段提取) / QR 状态归一化 /
//   getupdates 响应多形态容器 + 游标保留语义 / sendmessage body 结构 (LF→CRLF) /
//   secret 解析 (JSON + 纯 token 兜底) / 挂起超时归 pending.
// fetch 全部 mock (不真连 ilinkai.weixin.qq.com).

// 本仓 TS 5.0.2 无 Response.json 静态方法 (deploy log 前科), 测试 helper 统一构造
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv } from "node:crypto";
import {
  buildInboundMessage,
  decryptWeixinCdnMedia,
  getUpdates,
  normalizeQrStatus,
  parseWeixinAesKey,
  parseWeixinSecret,
  pollQrcodeStatus,
  sendText,
} from "./weixin";

// ---------------------------------------------------------------------------
// 消息解析
// ---------------------------------------------------------------------------

describe("buildInboundMessage 消息解析", () => {
  it("标准形态: from_user_id + msg.item_list[].text_item.text", () => {
    const msg = buildInboundMessage({
      id: "m1",
      message_type: 1,
      from_user_id: "wxid_abc",
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "帮我加个导出按钮" } }],
    });
    expect(msg).toEqual({
      msgId: "m1",
      fromUserId: "wxid_abc",
      displayName: undefined,
      chatId: undefined,
      text: "帮我加个导出按钮",
      contextToken: "ctx-1",
      messageType: 1,
    });
  });

  it("message_type=2 (bot 自发回显) 返回 null", () => {
    expect(
      buildInboundMessage({ message_type: 2, from_user_id: "wxid_x", text: "hi" }),
    ).toBeNull();
  });

  it("item_list 为空 (纯空消息) 返回 null", () => {
    expect(buildInboundMessage({ message_type: 1, from_user_id: "wxid_x", item_list: [] })).toBeNull();
  });

  it("语音消息: audio_item 带 url + aes_key → 透传 audio 要素", () => {
    const msg = buildInboundMessage({
      message_type: 1,
      from_user_id: "wxid_v",
      id: "m-voice",
      item_list: [
        {
          type: 4,
          audio_item: {
            media: {
              url: "https://cdn.example.com/voice.bin",
              aes_key: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
              size: 12345,
            },
          },
        },
      ],
    });
    expect(msg?.text).toBe("");
    expect(msg?.audio).toEqual({
      downloadUrl: "https://cdn.example.com/voice.bin",
      aesKey: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    });
    expect(msg?.unsupported).toBeUndefined();
  });

  it("audio_item 缺 aes_key → 无 audio 要素 (标 unsupported 走兜底)", () => {
    const msg = buildInboundMessage({
      message_type: 1,
      from_user_id: "wxid_v",
      item_list: [{ audio_item: { media: { url: "https://cdn.example.com/v.bin" } } }],
    });
    expect(msg?.audio).toBeUndefined();
    expect(msg?.unsupported).toBe(true);
  });

  it("图片消息 (image_item, 无文本) → text 空 + unsupported (worker 回兜底话术, 不再静默)", () => {
    const msg = buildInboundMessage({
      message_type: 1,
      from_user_id: "wxid_img",
      item_list: [{ type: 3, image_item: { media: { full_url: "https://cdn.example.com/a.jpg" } } }],
    });
    expect(msg).not.toBeNull();
    expect(msg?.text).toBe("");
    expect(msg?.unsupported).toBe(true);
  });

  it("aes_key 两种形态归一化 (hex32 / base64→16B)", () => {
    expect(parseWeixinAesKey("a1b2c3d4e5f60718293a4b5c6d7e8f90")?.byteLength).toBe(16);
    const b64 = Buffer.from("0123456789abcdef", "utf8").toString("base64");
    expect(parseWeixinAesKey(b64)?.toString("utf8")).toBe("0123456789abcdef");
    expect(parseWeixinAesKey("not-a-key")).toBeNull();
  });

  it("CDN 媒体 AES-128-ECB 解密 roundtrip (ZCode 同款算法)", () => {
    const cipherEnc = createCipheriv("aes-128-ecb", Buffer.from("0123456789abcdef", "utf8"), null);
    const encrypted = Buffer.concat([cipherEnc.update(Buffer.from("fake-silk-bytes-123")), cipherEnc.final()]);
    const plain = decryptWeixinCdnMedia(encrypted, Buffer.from("0123456789abcdef", "utf8").toString("base64"));
    expect(plain.toString("utf8")).toBe("fake-silk-bytes-123");
  });

  it("无发送方返回 null", () => {
    expect(buildInboundMessage({ message_type: 1, text: "hi" })).toBeNull();
  });

  it("顶层 text 直取 + from.id 嵌套提取 + room 群 ID", () => {
    const msg = buildInboundMessage({
      text: "顶层文本",
      from: { id: "wxid_nested", nickname: "张三" },
      room: "room_9",
    });
    expect(msg?.text).toBe("顶层文本");
    expect(msg?.fromUserId).toBe("wxid_nested");
    expect(msg?.displayName).toBe("张三");
    expect(msg?.chatId).toBe("room_9");
  });

  it("msg 内嵌形态 (inner.msg.item_list + inner.msgid)", () => {
    const msg = buildInboundMessage({
      msg: { msgid: "inner-7", item_list: [{ text_item: { text: "内嵌" } }] },
      from_user_id: "wxid_abc",
    });
    expect(msg?.msgId).toBe("inner-7");
    expect(msg?.text).toBe("内嵌");
  });

  it("多 item 文本按行拼接", () => {
    const msg = buildInboundMessage({
      item_list: [
        { type: 1, text_item: { text: "第一行" } },
        { type: 1, text_item: { text: "第二行" } },
      ],
      from_user_id: "wxid_abc",
    });
    expect(msg?.text).toBe("第一行\n第二行");
  });
});

// ---------------------------------------------------------------------------
// QR 状态归一化
// ---------------------------------------------------------------------------

describe("normalizeQrStatus", () => {
  it("数字枚举 0/1/2/3/4", () => {
    expect(normalizeQrStatus(0)).toBe("pending");
    expect(normalizeQrStatus(1)).toBe("scanned");
    expect(normalizeQrStatus(2)).toBe("success");
    expect(normalizeQrStatus(3)).toBe("expired");
    expect(normalizeQrStatus(4)).toBe("expired");
  });
  it("字符串别名", () => {
    expect(normalizeQrStatus("confirmed")).toBe("success");
    expect(normalizeQrStatus("scaned")).toBe("scanned");
    expect(normalizeQrStatus("timeout")).toBe("expired");
    expect(normalizeQrStatus("failed")).toBe("error");
    expect(normalizeQrStatus(undefined)).toBe("pending");
    expect(normalizeQrStatus("weird")).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// pollQrcodeStatus (mock fetch)
// ---------------------------------------------------------------------------

describe("pollQrcodeStatus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("success: 提取 bot_token + ilink_bot_id (bot_id 兜底)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: 2, bot_token: "tok1", ilink_bot_id: "bot9" }),
      ),
    );
    const r = await pollQrcodeStatus("qr1");
    expect(r).toEqual({ status: "success", bot_token: "tok1", ilink_bot_id: "bot9" });
  });

  it("data 包装形态 unwrap 后照读", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ret: 0, data: { status: 1 } }),
      ),
    );
    expect((await pollQrcodeStatus("qr1")).status).toBe("scanned");
  });

  it("挂起超时 (TimeoutError) 归 pending 不抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }),
    );
    expect(await pollQrcodeStatus("qr1")).toEqual({ status: "pending" });
  });

  it("ret != 0 → error + errmsg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ret: -1, errmsg: "bad qrcode" })),
    );
    expect(await pollQrcodeStatus("qr1")).toEqual({ status: "error", message: "bad qrcode" });
  });

  it("status=2 但缺 bot_token → error (成功却没凭据)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 2 })));
    const r = await pollQrcodeStatus("qr1");
    expect(r.status).toBe("error");
  });

  it("expired (status=4) 透传", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 4 })));
    expect((await pollQrcodeStatus("qr1")).status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// getUpdates (mock fetch)
// ---------------------------------------------------------------------------

describe("getUpdates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("解析 messages + 新游标; body 带 base_info 包装 + get_updates_buf", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        captured = { url: String(url), init: init! };
        return jsonResponse({
          msgs: [{ id: "m1", message_type: 1, from_user_id: "u1", text: "hi" }],
          get_updates_buf: "cursor-next",
        });
      }),
    );
    const r = await getUpdates("tok", "cursor-old");
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.text).toBe("hi");
    expect(r.buf).toBe("cursor-next");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.base_info).toEqual({ channel_version: "2.0.0" });
    expect(body.get_updates_buf).toBe("cursor-old");
    expect(captured!.url).toContain("/ilink/bot/getupdates");
    expect((captured!.init.headers as Record<string, string>).AuthorizationType).toBe("ilink_bot_token");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("响应无新 buf 时保留旧游标 (不回退)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ msgs: [] })));
    const r = await getUpdates("tok", "keep-me");
    expect(r.buf).toBe("keep-me");
  });

  it("ret != 0 抛错 (worker 侧不推游标)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ret: -2, errmsg: "token expired" })));
    await expect(getUpdates("tok", "")).rejects.toThrow("token expired");
  });
});

// ---------------------------------------------------------------------------
// sendText
// ---------------------------------------------------------------------------

describe("sendText", () => {
  afterEach(() => vi.restoreAllMocks());

  it("msg 结构: message_type=2 / message_state=2 / item_list 文本 + LF→CRLF", async () => {
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        body = JSON.parse(String(init!.body));
        return jsonResponse({ ret: 0 });
      }),
    );
    await sendText("tok", "bot1", "user1", "第一行\n第二行", "ctx-9");
    expect(body.base_info).toEqual({ channel_version: "2.0.0" });
    expect(body.msg).toMatchObject({
      from_user_id: "bot1",
      to_user_id: "user1",
      message_type: 2,
      message_state: 2,
      context_token: "ctx-9",
    });
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: "第一行\r\n第二行" } }]);
    expect(typeof body.msg.client_id).toBe("string");
  });

  it("失败 (ret!=0) 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errcode: 400, errmsg: "bad" })));
    await expect(sendText("tok", "b", "u", "hi")).rejects.toThrow("bad");
  });
});

// ---------------------------------------------------------------------------
// parseWeixinSecret
// ---------------------------------------------------------------------------

describe("parseWeixinSecret", () => {
  it("JSON 形态解出 bot_token + ilink_bot_id", () => {
    expect(parseWeixinSecret(JSON.stringify({ bot_token: "t1", ilink_bot_id: "b1" }))).toEqual({
      bot_token: "t1",
      ilink_bot_id: "b1",
    });
  });
  it("纯 token 字符串兜底 (手动建行路径)", () => {
    expect(parseWeixinSecret("raw-token")).toEqual({ bot_token: "raw-token", ilink_bot_id: "" });
  });
  it("空 / null → null", () => {
    expect(parseWeixinSecret(null)).toBeNull();
    expect(parseWeixinSecret("")).toBeNull();
  });
});
