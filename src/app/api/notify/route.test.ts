// POST /api/notify 集成测试 (v47).
//
// 覆盖五件事:
//   1. 鉴权: 401 (无 x-user-id) / 200 (有 user-id)
//   2. 校验: 400 (channel 缺失 / 非法 / 缺 subject / 缺 message / 缺 user_id 404)
//   3. 开放中继闸门: 非 admin 传 user_id/to → 403
//   4. email 渠道: 复用 mailer.sendNotifyToUser (mock nodemailer) —
//      users.notify_email 非空 → 用它; 未配 → 回落 NOTIFY_FALLBACK_TO; SMTP 未配置 →
//      { sent:false }, HTTP 整体仍 200.
//   5. feishu 渠道: 复用 feishu.sendFeishuWebhook (mock fetch) —
//      users.feishu_webhook_url 非空 → POST; 未配 → { sent:false, reason }.
//   6. channel=both 并发: 两渠道结果都进 results, summary 字段正确 (all_ok/partial/none).
//   7. admin 特权: admin 可指定 user_id / to, 不被 403.
//
// 关注点:
//   - mock nodemailer (同 task-timeout.test.ts) + mock fetch (globalThis.fetch stub).
//   - 不真发任何东西. 真发验证在 verify-notify-usage.sh --send-feishu 手动触发.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SMTP mock (mailer.ts 依赖 nodemailer) — 与 task-timeout.test.ts 同款
const sendMailMock = vi.fn();
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail: sendMailMock }),
  },
}));

import { POST as notifyPost } from "./route";
import { closeDb, getDb } from "@/lib/db";
import {
  setUserNotifyEmail,
  setUserFeishuWebhook,
  createUser,
} from "@/lib/db/users";

let tmpDir: string;
let adminId: string;
let userId: string;
let otherUserId: string;

const SMTP_ENV = {
  SMTP_HOST: "mail.example.test",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "sender@example.test",
  SMTP_PASS: "x",
  NOTIFY_FROM: "sender@example.test",
};

const VALID_FEISHU =
  "https://open.feishu.cn/open-apis/bot/v2/hook/abcdef0123456789abcdef0123456789";

function setSmtpEnv() {
  for (const [k, v] of Object.entries(SMTP_ENV)) process.env[k] = v;
}
function clearSmtpEnv() {
  for (const k of Object.keys(SMTP_ENV)) delete process.env[k];
  delete process.env.NOTIFY_FALLBACK_TO;
}

async function callNotify(
  body: Record<string, unknown>,
  opts: { asUserId?: string; asRole?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-user-id": opts.asUserId ?? userId,
  };
  if (opts.asRole) headers["x-user-role"] = opts.asRole;
  const req = new Request("http://localhost/api/notify", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const res = await notifyPost(req as any);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-notify-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑 migration 含 v47 feishu_webhook_url
  const u1 = await createUser("admin@example.test", "pw");
  adminId = u1.id;
  // 把 admin 升成 admin 角色 (createUser 默认 user)
  getDb().prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(adminId);
  const u2 = await createUser("user@example.test", "pw");
  userId = u2.id;
  const u3 = await createUser("other@example.test", "pw");
  otherUserId = u3.id;

  // mock sendMail + fetch
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({
    response: "250 2.0.0 OK: queued",
    messageId: "<test@example.test>",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"StatusCode":0,"msg":"success"}',
    })
  );
  setSmtpEnv();
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  clearSmtpEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("POST /api/notify 鉴权 + 校验", () => {
  it("无 x-user-id → 401", async () => {
    const req = new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "email", subject: "s", text: "t" }),
    });
    const res = await notifyPost(req as any);
    expect(res.status).toBe(401);
  });

  it("channel 缺失 → 400", async () => {
    const { status, body } = await callNotify({ subject: "s", text: "t" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/channel/);
  });

  it("channel 非法 → 400", async () => {
    const { status, body } = await callNotify({
      channel: "sms",
      subject: "s",
      text: "t",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/channel/);
  });

  it("channel=email 缺 subject → 400", async () => {
    const { status, body } = await callNotify({ channel: "email", text: "t" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/subject/);
  });

  it("channel=email 缺 text/html → 400", async () => {
    const { status, body } = await callNotify({
      channel: "email",
      subject: "s",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/text 或 html/);
  });

  it("channel=feishu 缺 message → 400", async () => {
    const { status, body } = await callNotify({ channel: "feishu" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/message/);
  });

  it("非 admin 传 user_id → 403 (开放中继闸门)", async () => {
    const { status, body } = await callNotify({
      channel: "email",
      user_id: otherUserId,
      subject: "s",
      text: "t",
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/user_id 仅 admin/);
  });

  it("非 admin 传 to → 403 (开放中继闸门)", async () => {
    const { status, body } = await callNotify({
      channel: "email",
      to: "elsewhere@example.test",
      subject: "s",
      text: "t",
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/to 仅 admin/);
  });

  it("不存在的 user_id (admin 指定) → 404", async () => {
    const fakeId = uuidv4();
    const { status, body } = await callNotify(
      { channel: "email", user_id: fakeId, subject: "s", text: "t" },
      { asUserId: adminId, asRole: "admin" }
    );
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/);
  });
});

describe("POST /api/notify email 渠道", () => {
  it("普通用户发给自己, notify_email 非空 → 用它", async () => {
    setUserNotifyEmail(userId, "me@example.test");
    const { status, body } = await callNotify({
      channel: "email",
      subject: "hi",
      text: "body",
    });
    expect(status).toBe(200);
    expect(body.summary).toBe("all_ok");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].channel).toBe("email");
    expect(body.results[0].sent).toBe(true);
    expect(body.results[0].to).toBe("me@example.test");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].subject).toBe("hi");
  });

  it("普通用户没配 notify_email, 回落系统邮箱", async () => {
    process.env.NOTIFY_FALLBACK_TO = "sys@example.test";
    const { status, body } = await callNotify({
      channel: "email",
      subject: "hi",
      text: "body",
    });
    expect(status).toBe(200);
    expect(body.results[0].to).toBe("sys@example.test");
  });

  it("SMTP env 未配 → sent:false, summary=none, HTTP 仍 200", async () => {
    clearSmtpEnv();
    setUserNotifyEmail(userId, "me@example.test");
    const { status, body } = await callNotify({
      channel: "email",
      subject: "hi",
      text: "body",
    });
    expect(status).toBe(200);
    expect(body.results[0].sent).toBe(false);
    expect(body.results[0].reason).toMatch(/not configured/);
    expect(body.summary).toBe("none");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("admin 可指定 user_id → 拿那个用户的 notify_email", async () => {
    setUserNotifyEmail(otherUserId, "other-me@example.test");
    const { status, body } = await callNotify(
      { channel: "email", user_id: otherUserId, subject: "hi", text: "body" },
      { asUserId: adminId, asRole: "admin" }
    );
    expect(status).toBe(200);
    expect(body.results[0].to).toBe("other-me@example.test");
  });

  it("admin 用 to 覆盖 → 直接发到那个邮箱, 不走 resolveNotifyTo", async () => {
    setUserNotifyEmail(userId, "self@example.test");
    const { status, body } = await callNotify(
      {
        channel: "email",
        to: "third-party@example.test",
        subject: "hi",
        text: "body",
      },
      { asUserId: adminId, asRole: "admin" }
    );
    expect(status).toBe(200);
    expect(body.results[0].to).toBe("third-party@example.test");
  });
});

describe("POST /api/notify feishu 渠道", () => {
  it("用户配了 webhook → 真发(在这里是 mock fetch), sent:true", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU);
    const { status, body } = await callNotify({
      channel: "feishu",
      message: "**部署完成**",
    });
    expect(status).toBe(200);
    expect(body.summary).toBe("all_ok");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].channel).toBe("feishu");
    expect(body.results[0].sent).toBe(true);
    expect(body.results[0].status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const fetchUrl = vi.mocked(fetch).mock.calls[0][0];
    expect(fetchUrl).toBe(VALID_FEISHU);
  });

  it("用户没配 webhook → sent:false, reason 含 no webhook, 不调 fetch", async () => {
    const { status, body } = await callNotify({
      channel: "feishu",
      message: "hi",
    });
    expect(status).toBe(200);
    expect(body.results[0].sent).toBe(false);
    expect(body.results[0].reason).toMatch(/no webhook url/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(body.summary).toBe("none");
  });

  it("webhook URL 非法(被手工改脏) → sent:false, 不调 fetch", async () => {
    setUserFeishuWebhook(userId, "https://evil.com/x");
    const { status, body } = await callNotify({
      channel: "feishu",
      message: "hi",
    });
    expect(status).toBe(200);
    expect(body.results[0].sent).toBe(false);
    expect(body.results[0].reason).toMatch(/invalid/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("fetch 返 4xx → sent:false, status, reason", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"code":19001,"msg":"关键词校验失败"}',
      })
    );
    const { status, body } = await callNotify({
      channel: "feishu",
      message: "hi",
    });
    expect(status).toBe(200);
    expect(body.results[0].sent).toBe(false);
    expect(body.results[0].status).toBe(400);
    expect(body.results[0].reason).toMatch(/关键词/);
  });

  it("msg_type=text → fetch body 含 text 字段", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU);
    await callNotify({
      channel: "feishu",
      message: "plain",
      msg_type: "text",
    });
    const fetchBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(fetchBody.msg_type).toBe("text");
    expect(fetchBody.content.text).toBe("plain");
  });
});

describe("POST /api/notify channel=both 并发", () => {
  it("两渠道都配 + 都成功 → all_ok", async () => {
    setUserNotifyEmail(userId, "me@example.test");
    setUserFeishuWebhook(userId, VALID_FEISHU);
    const { status, body } = await callNotify({
      channel: "both",
      subject: "hi",
      text: "body",
      message: "**md**",
    });
    expect(status).toBe(200);
    expect(body.summary).toBe("all_ok");
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r: any) => r.channel).sort()).toEqual(["email", "feishu"]);
  });

  it("email 失败 + feishu 成功 → partial", async () => {
    setUserFeishuWebhook(userId, VALID_FEISHU);
    // SMTP 故意未配, email 渠道会 sent:false
    clearSmtpEnv();
    setUserNotifyEmail(userId, "me@example.test");
    const { status, body } = await callNotify({
      channel: "both",
      subject: "hi",
      text: "body",
      message: "**md**",
    });
    expect(status).toBe(200);
    expect(body.summary).toBe("partial");
    const emailRes = body.results.find((r: any) => r.channel === "email");
    const feishuRes = body.results.find((r: any) => r.channel === "feishu");
    expect(emailRes.sent).toBe(false);
    expect(feishuRes.sent).toBe(true);
  });

  it("两边都失败 → none", async () => {
    clearSmtpEnv();
    // feishu 也不配
    const { status, body } = await callNotify({
      channel: "both",
      subject: "hi",
      text: "body",
      message: "**md**",
    });
    expect(status).toBe(200);
    expect(body.summary).toBe("none");
  });
});

describe("POST /api/notify 兜底", () => {
  it("body 不是合法 JSON → 400", async () => {
    const req = new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": userId },
      body: "{not json",
    });
    const res = await notifyPost(req as any);
    expect(res.status).toBe(400);
  });
});