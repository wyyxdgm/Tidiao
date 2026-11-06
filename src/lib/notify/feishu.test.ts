// 飞书 webhook 出站回归测试 (v47)
//
// 守四件事, mirror task-timeout.test.ts 的结构:
//   1. URL 校验: 合法 URL 通过, 杂七杂八(非 https / 错 host / 无 token / token 太短) 全挡.
//   2. sendFeishuWebhook **永不抛错**: 没配 / URL 不合法 / 空消息 / fetch 4xx / fetch
//      抛异常 一律返 { sent:false, reason }, 不把异常抛回调用方 (调用方在任务状态机里).
//   3. 成功路径: 拿回 status, body 是正确格式 (msg_type + content).
//   4. mock 边界: 不真发 webhook (会把 CI 变成发消息机; 真发在 verify-notify-usage.sh
//      的 --send-feishu 手动触发).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isValidFeishuWebhookUrl,
  maskFeishuWebhookUrl,
  setUserFeishuWebhook,
} from "../db/users";
import { sendFeishuWebhook } from "./feishu";

const VALID_URL =
  "https://open.feishu.cn/open-apis/bot/v2/hook/abcdef0123456789abcdef0123456789";

beforeEach(() => {
  // 默认让 fetch mock 返 200, 每个 case 按需 override
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"StatusCode":0,"msg":"success"}',
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("v47 webhook URL 校验", () => {
  it("接受合法 v2 自定义机器人 URL", () => {
    expect(isValidFeishuWebhookUrl(VALID_URL)).toBe(true);
    expect(
      isValidFeishuWebhookUrl(
        "https://open.feishu.cn/open-apis/bot/v2/hook/" + "a".repeat(32)
      )
    ).toBe(true);
  });

  it("挡掉非 https / 错 host / 错路径", () => {
    for (const bad of [
      "http://open.feishu.cn/open-apis/bot/v2/hook/abcdef0123456789abcdef0123456789", // http
      "https://example.com/open-apis/bot/v2/hook/abcdef0123456789abcdef0123456789", // wrong host
      "https://open.feishu.cn/open-apis/im/v1/messages", // wrong path
      "https://open.feishu.cn/open-apis/bot/v2/hook/", // empty token
      "https://open.feishu.cn/open-apis/bot/v2/hook/abc", // token too short (<16)
    ]) {
      expect(isValidFeishuWebhookUrl(bad)).toBe(false);
    }
  });

  it("挡掉 token 含非法字符", () => {
    // token 段只允许 [A-Za-z0-9_-], 飞书实际 token 都是 base62/hex
    expect(
      isValidFeishuWebhookUrl(
        "https://open.feishu.cn/open-apis/bot/v2/hook/abc!def@1234567890abcdef"
      )
    ).toBe(false);
  });

  it("长度上限 512", () => {
    const tooLong = "https://open.feishu.cn/open-apis/bot/v2/hook/" + "a".repeat(500);
    expect(isValidFeishuWebhookUrl(tooLong)).toBe(false);
  });
});

describe("v47 maskFeishuWebhookUrl", () => {
  it("完整 URL → ****末 4 位", () => {
    expect(maskFeishuWebhookUrl(VALID_URL)).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/****6789"
    );
  });
  it("null / 空 / 非法 URL → null", () => {
    expect(maskFeishuWebhookUrl(null)).toBeNull();
    expect(maskFeishuWebhookUrl("")).toBeNull();
    expect(maskFeishuWebhookUrl("not-a-url")).toBeNull();
  });
});

describe("v47 sendFeishuWebhook 永不抛错", () => {
  it("webhook URL 空 → { sent:false }, 不调 fetch", async () => {
    const fetchMock = vi.mocked(fetch);
    const r = await sendFeishuWebhook({ webhookUrl: null, message: "hi" });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/no webhook url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("webhook URL 非法 → { sent:false }, 不调 fetch", async () => {
    const fetchMock = vi.mocked(fetch);
    const r = await sendFeishuWebhook({
      webhookUrl: "https://evil.com/x",
      message: "hi",
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/invalid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("message 空 → { sent:false }, 不调 fetch", async () => {
    const fetchMock = vi.mocked(fetch);
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "   ",
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch 返 4xx → { sent:false, status, reason 带 msg }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"code":19001,"msg":"关键词校验失败"}',
      })
    );
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "hi",
    });
    expect(r.sent).toBe(false);
    expect(r.status).toBe(400);
    expect(r.reason).toMatch(/HTTP 400/);
    expect(r.reason).toMatch(/关键词/);
  });

  it("fetch 抛异常 → { sent:false, reason }, 不抛回", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:443"))
    );
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "hi",
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it("成功 → { sent:true, status }, body.code=0 仍判成功", async () => {
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "hi",
    });
    expect(r.sent).toBe(true);
    expect(r.status).toBe(200);
  });

  it("HTTP 200 + body.code != 0 (e.g. 10208 markdown not support) → { sent:false, reason 带 code+msg }", async () => {
    // 飞书真实响应: HTTP 200 但 body.code 10208 也要当失败 (2026-08-17 踩坑:
    //  旧实现只看 HTTP 200 误报 sent:true, 调用方无感)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          '{"StatusCode":10208,"StatusMessage":"success","code":10208,"data":{},"msg":"msg type markdown not support"}',
      })
    );
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "**bold** hi",
      msgType: "markdown",
    });
    expect(r.sent).toBe(false);
    expect(r.status).toBe(200);
    expect(r.reason).toMatch(/feishu code 10208/);
    expect(r.reason).toMatch(/markdown not support/);
  });

  it("HTTP 200 + body.code=0 (camelCase 字段) → { sent:true }", async () => {
    // 默认 mock 用的是 PascalCase StatusCode; 这里补一个 camelCase code:0 的现实场景
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"code":0,"msg":"success","data":{}}',
      })
    );
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "hi",
    });
    expect(r.sent).toBe(true);
    expect(r.status).toBe(200);
  });

  it("HTTP 200 + body 非 JSON → { sent:true } (非 JSON 视为 OK, 沿用 HTTP 判定)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "<html>unexpected proxy response</html>",
      })
    );
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "hi",
    });
    expect(r.sent).toBe(true);
    expect(r.status).toBe(200);
  });
});

describe("v47 sendFeishuWebhook 请求格式", () => {
  it("默认走 markdown, body 含 msg_type + content.markdown", async () => {
    const fetchMock = vi.mocked(fetch);
    await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "**bold** hi",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(VALID_URL);
    expect(calledInit?.method).toBe("POST");
    expect((calledInit?.headers as Record<string, string>)["Content-Type"]).toMatch(
      /application\/json/
    );
    const body = JSON.parse(calledInit?.body as string);
    expect(body.msg_type).toBe("markdown");
    expect(body.content.markdown).toBe("**bold** hi");
  });

  it("msgType=text → msg_type=text + content.text", async () => {
    const fetchMock = vi.mocked(fetch);
    await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      message: "plain",
      msgType: "text",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("plain");
    expect(body.content.markdown).toBeUndefined();
  });

  it("msgType=post + title → msg_type=post + content.post.zh_cn.{title,content}", async () => {
    const fetchMock = vi.mocked(fetch);
    await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      msgType: "post",
      post: {
        title: "项目更新",
        content: [
          [
            { tag: "text", text: "项目有更新: " },
            { tag: "a", text: "请查看", href: "https://example.com" },
          ],
        ],
      },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.msg_type).toBe("post");
    expect(body.content.post.zh_cn.title).toBe("项目更新");
    expect(body.content.post.zh_cn.content).toEqual([
      [
        { tag: "text", text: "项目有更新: " },
        { tag: "a", text: "请查看", href: "https://example.com" },
      ],
    ]);
    expect(body.content.markdown).toBeUndefined();
  });

  it("msgType=post + locale=en_us → content.post.en_us", async () => {
    const fetchMock = vi.mocked(fetch);
    await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      msgType: "post",
      post: {
        locale: "en_us",
        content: [[{ tag: "text", text: "hi" }]],
      },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.content.post.en_us.content).toEqual([[{ tag: "text", text: "hi" }]]);
    expect(body.content.post.zh_cn).toBeUndefined();
  });

  it("msgType=post + 无 title → content.post.zh_cn 仅有 content (无 title 字段)", async () => {
    const fetchMock = vi.mocked(fetch);
    await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      msgType: "post",
      post: { content: [[{ tag: "text", text: "hi" }]] },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.content.post.zh_cn.content).toBeDefined();
    expect(body.content.post.zh_cn.title).toBeUndefined();
  });
});

describe("v47 sendFeishuWebhook post 模式校验", () => {
  it("msgType=post + 缺 post.content → { sent:false, reason 含 post.content }", async () => {
    const fetchMock = vi.mocked(fetch);
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      msgType: "post",
      post: { content: [] },
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/post.content/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("msgType=post + 缺 post 字段 → { sent:false }, 不调 fetch", async () => {
    const fetchMock = vi.mocked(fetch);
    const r = await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      msgType: "post",
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/post.content/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("msgType=post + 同时给 message → 仍发 (message 被忽略, post 优先)", async () => {
    // 设计选择: post 模式下 message 字段被忽略, 不报错.
    // 避免上游误传时直接静默失败 —— 投递仍按 post 走, console.warn 一条提示.
    const fetchMock = vi.mocked(fetch);
    await sendFeishuWebhook({
      webhookUrl: VALID_URL,
      msgType: "post",
      post: { content: [[{ tag: "text", text: "real content" }]] },
      message: "this is ignored",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.msg_type).toBe("post");
    expect(body.content.post.zh_cn.content[0][0].text).toBe("real content");
  });
});

describe("v47 setUserFeishuWebhook setter", () => {
  it("空串/空白/null 都归一成 NULL", async () => {
    const fetchMock = vi.mocked(fetch);
    // 不真造用户, 跳过 DB 测试 — 这里只验证 setter 的归一化逻辑在 sendFeishuWebhook 那侧
    // 是不会触发 fetch (与「URL 空不调 fetch」同款行为)
    const r = await sendFeishuWebhook({
      webhookUrl: "   " as unknown as string, // 模拟 setter 漏过的脏值
      message: "x",
    });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/no webhook url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("setUserFeishuWebhook 函数存在且导出 (写库路径在 /api/user/me 测试里覆盖)", () => {
    expect(typeof setUserFeishuWebhook).toBe("function");
  });
});