// 企微 intake 端到端测试 (mock wecom API + 真实解密/验签/HMAC/DB).
//
// 功能: 不启动 HTTP server, 直接调 route handler 走完整链路:
//   入站: encrypt(回调 XML) → POST /api/intake/wecom
//         → 解密+验签 → sync_msg (mock) → intake_threads 落库
//         → runtime.createTask (mock) → intake_thread 关联
//   出站: pre-seed task+assistant event → POST /api/intake/wecom/outbound (HMAC)
//         → getSessionHistory (mock) → 提取 <<<REPLY>>>
//         → 48h/5 窗口判定 → sendKfMessage (mock) 验发往甲方的内容
//
// 关注点: 加密载荷刻意构造 pad>16 (复现 2026-08-09 setAutoPadding(true) 旧实现的
//   "bad decrypt" 必败区); 入站 mock runtime 的 createTask 用真实 db/tasks.createTask
//   (跟现有 allowed-tools.test.ts 一致) 让 task 真落库可断言; 出站 mock runtime
//   提供 getSessionHistory 返回 canned assistant 消息; wecom 的 syncMessages /
//   sendKfMessage / ensureBotServiceState 走 vi.spyOn, 真实解密函数保持原样.
//
//   这条链路跑绿 = 平台入站→partner→出站的"消息到 agent、结果回微信"全闭环打通.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";

const TOKEN = "testTokenForE2E";
const AESKEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORPID = "wwTESTCORPIDe2e";
const KFID = "wkTESTKFIDe2e";
const WEBHOOK_SECRET = "testWebhookSecretE2E";
const EXTERNAL_USER = "wmEXTERNAL_USER_42";

// --- 企微加密/签名工具（与 wecom.ts:45-77 对称） ---

function encrypt(plain: string): { b64: string; pad: number } {
  const key = Buffer.from(AESKEY + "=", "base64");
  const iv = key.subarray(0, 16);
  const msg = Buffer.from(plain, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([randomBytes(16), lenBuf, msg, Buffer.from(CORPID, "utf8")]);
  const pad = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const c = createCipheriv("aes-256-cbc", key, iv);
  c.setAutoPadding(false);
  const b64 = Buffer.concat([c.update(padded), c.final()]).toString("base64");
  return { b64, pad };
}

function sign(ts: string, nonce: string, enc: string): string {
  return createHash("sha1")
    .update([TOKEN, ts, nonce, enc].sort().join(""))
    .digest("hex");
}

// 构造一个 kf_msg_or_event XML, 让 Token 段长度使 PKCS7 pad > 16 (回归旧 bug 必败区)
function makeEventXml(msgTokenSeed = "SIM"): { xml: string; b64: string; pad: number } {
  for (let extra = 0; extra < 32; extra++) {
    const msgToken = `${msgTokenSeed}_` + "x".repeat(43) + "y".repeat(extra);
    const xml =
      `<xml><ToUserName><![CDATA[${CORPID}]]></ToUserName>` +
      `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
      `<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg_or_event]]></Event>` +
      `<Token><![CDATA[${msgToken}]]></Token>` +
      `<OpenKfId><![CDATA[${KFID}]]></OpenKfId></xml>`;
    const enc = encrypt(xml);
    if (enc.pad > 16) return { xml, b64: enc.b64, pad: enc.pad };
  }
  throw new Error("could not produce pad>16 payload");
}

function makeInboundRequest(
  b64: string,
  ts: string,
  nonce: string,
): NextRequest {
  const url = new URL("http://localhost/api/intake/wecom");
  url.searchParams.set("msg_signature", sign(ts, nonce, b64));
  url.searchParams.set("timestamp", ts);
  url.searchParams.set("nonce", nonce);
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: `<xml><Encrypt><![CDATA[${b64}]]></Encrypt></xml>`,
  });
}

describe("企微 intake 端到端", () => {
  let tmpDir: string;
  let projectId: string;
  let wecomModule: typeof import("@/lib/intake/wecom");
  let inboundPOST: (req: Request) => Promise<Response>;
  let outboundPOST: (req: Request) => Promise<Response>;
  let sendUserMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // 1) env: 全部 6 个 intake 相关变量
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    process.env.WECOM_CORP_ID = CORPID;
    process.env.WECOM_KF_ID = KFID;
    process.env.INTAKE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    // 2) DB
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-e2e-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();

    // 3) owner + project + INTAKE_PROJECT_ID
    const ownerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(ownerId, `${ownerId}@example.com`, "x", "user");
    projectId = createProject({ name: "intake-e2e", ownerId }).id;
    process.env.INTAKE_PROJECT_ID = projectId;

    // 4) 真实 wecom 模块（要用到 decrypt + verifySignature + extractCallbackCursor）
    wecomModule = await import("@/lib/intake/wecom");

    // 5) spy 异步 API（不真打企微）
    vi.spyOn(wecomModule, "syncMessages").mockResolvedValue([
      {
        msgid: "m-e2e-001",
        externalUserId: EXTERNAL_USER,
        content: "测试需求：甲方要登录页加个导出按钮",
        msgType: "text",
        sendTime: Math.floor(Date.now() / 1000),
      },
    ]);
    vi.spyOn(wecomModule, "ensureBotServiceState").mockResolvedValue(undefined);
    vi.spyOn(wecomModule, "sendKfMessage").mockResolvedValue(undefined);

    // 6) spy sendUserMessage, 让入站续聊断言到
    sendUserMessageSpy = vi.fn();

    // 7) runtime mock: 入站用真 createTask (让 task 落库), 出站 canned session history
    vi.doMock("@/lib/runtime/agent-runtime", () => ({
      getRuntime: () => ({
        createTask,
        startTask: () => {},
        sendUserMessage: sendUserMessageSpy,
        getSessionHistory: async () => [
          {
            type: "assistant",
            uuid: "fake-asst-1",
            session_id: "sess-e2e",
            message: {
              content: [
                {
                  type: "text",
                  text:
                    "好的，已收到您的需求，正在定位模块。" +
                    "\n\n<<<REPLY>>>\n好的，您说的登录页导出是要哪种格式？Excel 还是 PDF？\n<<<END>>>",
                },
              ],
            },
          },
        ],
      }),
    }));

    // 8) dynamic import route (env 已就位, route 顶层 INTAKE_PROJECT_ID 读得对)
    inboundPOST = (await import("@/app/api/intake/wecom/route")).POST;
    outboundPOST = (await import("@/app/api/intake/wecom/outbound/route")).POST;
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/runtime/agent-runtime");
    vi.resetModules();
    delete process.env.ORCHESTRATOR_DB_PATH;
    delete process.env.INTAKE_PROJECT_ID;
    delete process.env.WECOM_CALLBACK_TOKEN;
    delete process.env.WECOM_ENCODING_AES_KEY;
    delete process.env.WECOM_CORP_ID;
    delete process.env.WECOM_KF_ID;
    delete process.env.INTAKE_WEBHOOK_SECRET;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("端到端: 加密回调 → 入站建 thread + task → 出站取 REPLY → 调 sendKfMessage", async () => {
    // === 入站: POST /api/intake/wecom ===
    const { b64, pad } = makeEventXml();
    expect(pad).toBeGreaterThan(16); // 强制命中回归区

    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "e2e_nonce_001";
    const inboundRes = await inboundPOST(makeInboundRequest(b64, ts, nonce));
    expect(inboundRes.status).toBe(200);

    // sync_msg 被真实调用 (cursor 来自 Token 字段)
    expect(wecomModule.syncMessages).toHaveBeenCalledTimes(1);
    expect(wecomModule.syncMessages.mock.calls[0]?.[0]).toContain("SIM_");

    // intake_thread 落库
    const threads = getDb()
      .prepare(`SELECT * FROM intake_threads`)
      .all() as Array<{
        id: string;
        channel: string;
        external_user_id: string;
        task_id: string;
        msg_sent_in_window: number;
        last_inbound_at: string | null;
      }>;
    expect(threads).toHaveLength(1);
    expect(threads[0].channel).toBe("wecom");
    expect(threads[0].external_user_id).toBe(EXTERNAL_USER);
    expect(threads[0].msg_sent_in_window).toBe(0);
    expect(threads[0].last_inbound_at).not.toBeNull();

    // task 落库
    const taskRows = getDb()
      .prepare(`SELECT * FROM tasks`)
      .all() as Array<{
        id: string;
        title: string;
        tags: string;
        allowed_tools: string | null;
      }>;
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].title).toContain("甲方需求线程");
    expect(taskRows[0].tags).toContain("intake");
    expect(taskRows[0].tags).toContain("wecom");
    const tools = JSON.parse(taskRows[0].allowed_tools!) as string[];
    expect(tools).toContain("Read");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");

    // thread.task_id 与 task.id 关联
    expect(threads[0].task_id).toBe(taskRows[0].id);

    const taskId = taskRows[0].id;

    // === 出站: POST /api/intake/wecom/outbound ===
    const webhookPayload = JSON.stringify({
      task: { id: taskId, status: "reviewing" },
      event: "task.reviewing",
    });
    const sig = require("node:crypto")
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(webhookPayload)
      .digest("hex");

    const outboundUrl = new URL("http://localhost/api/intake/wecom/outbound");
    const outboundReq = new NextRequest(outboundUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-signature": sig },
      body: webhookPayload,
    });
    const outboundRes = await outboundPOST(outboundReq);
    expect(outboundRes.status).toBe(200);

    // sendKfMessage 被调用, 内容是 <<<REPLY>>> 之间的蒸馏段, 不是整段 assistant 文本
    expect(wecomModule.sendKfMessage).toHaveBeenCalledTimes(1);
    const [calledUser, calledText] = wecomModule.sendKfMessage.mock.calls[0]!;
    expect(calledUser).toBe(EXTERNAL_USER);
    expect(calledText).toBe("好的，您说的登录页导出是要哪种格式？Excel 还是 PDF？");
    // 完整 assistant 文本不能泄漏给甲方
    expect(calledText).not.toContain("正在定位模块");

    // msg_sent_in_window 计数 +1
    const threadAfter = getDb()
      .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
      .get(threads[0].id) as { msg_sent_in_window: number };
    expect(threadAfter.msg_sent_in_window).toBe(1);
  });

  it("入站续聊: 第二次同甲方消息命中已有 thread, 不建新 task, 走 sendUserMessage 续", async () => {
    // 第一次: 建 thread + task
    const first = makeEventXml("SIM_first");
    const r1 = await inboundPOST(makeInboundRequest(first.b64, "1", "n1"));
    expect(r1.status).toBe(200);
    const initialTaskCount = (
      getDb().prepare(`SELECT COUNT(*) as c FROM tasks`).get() as { c: number }
    ).c;
    expect(initialTaskCount).toBe(1);
    sendUserMessageSpy.mockClear();

    // 第二次: 同 external user, 应走 sendUserMessage 续聊, 不建新 task
    const second = makeEventXml("SIM_second");
    const r2 = await inboundPOST(makeInboundRequest(second.b64, "2", "n2"));
    expect(r2.status).toBe(200);

    const afterCount = (
      getDb().prepare(`SELECT COUNT(*) as c FROM tasks`).get() as { c: number }
    ).c;
    expect(afterCount).toBe(1);

    // sendUserMessage 被调用一次, 参数是 (task_id, 内容)
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const [calledTaskId, calledContent] = sendUserMessageSpy.mock.calls[0]!;
    const threadRow = getDb()
      .prepare(`SELECT task_id FROM intake_threads`)
      .get() as { task_id: string };
    expect(calledTaskId).toBe(threadRow.task_id);
    expect(calledContent).toBe("测试需求：甲方要登录页加个导出按钮");

    // last_inbound_at 已被 markInbound 重置 (新时间)
    const ts = getDb()
      .prepare(`SELECT last_inbound_at FROM intake_threads`)
      .get() as { last_inbound_at: string | null };
    expect(ts.last_inbound_at).not.toBeNull();
  });
});