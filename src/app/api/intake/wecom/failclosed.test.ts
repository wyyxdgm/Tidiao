// 企微 intake 入站 fail-closed 边界测试.
//
// 功能: 验证未配 WECOM_CALLBACK_TOKEN / WECOM_ENCODING_AES_KEY 时, 入站路由必须
//   拒绝请求 (403), 不能因 env 缺失而走兼容路径.
// 关注点: 这两个 env 是 HMAC 验签和 AES 解密的必备密钥; 缺失时任何"宽容"行为
//   (例如跳过验签、放行) 都是安全洞. 当前实现是 verifySignature 用空 token
//   算 hash 必不匹配 client 签名, decryptCallback 用空 AESKey 解密抛错, 两条路径
//   都返回 403 = fail-closed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";

const TOKEN = "realToken";
const AESKEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORPID = "wwFAILCLOSED";

function encrypt(plain: string, aesKey: string, corpId: string): string {
  const key = Buffer.from(aesKey + "=", "base64");
  const iv = key.subarray(0, 16);
  const msg = Buffer.from(plain, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([randomBytes(16), lenBuf, msg, Buffer.from(corpId, "utf8")]);
  const pad = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const c = createCipheriv("aes-256-cbc", key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]).toString("base64");
}

function signWithToken(ts: string, nonce: string, enc: string, token: string): string {
  return createHash("sha1").update([token, ts, nonce, enc].sort().join("")).digest("hex");
}

describe("企微 intake 入站 fail-closed", () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-fc-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();
    const ownerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(ownerId, `${ownerId}@example.com`, "x", "user");
    projectId = createProject({ name: "failclosed", ownerId }).id;
    process.env.INTAKE_PROJECT_ID = projectId;
    process.env.WECOM_CORP_ID = CORPID;
    process.env.WECOM_KF_ID = "wkFC";

    // vi.doMock runtime 避免 sendUserMessage 等副作用
    vi.doMock("@/lib/runtime/agent-runtime", () => ({
      getRuntime: () => ({
        createTask: () => {
          throw new Error("createTask should not be called when fail-closed");
        },
        startTask: () => {},
        sendUserMessage: () => {},
      }),
    }));
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
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("缺 WECOM_CALLBACK_TOKEN: POST 入站必须 403, 不能走兼容路径", async () => {
    process.env.WECOM_CALLBACK_TOKEN = ""; // 显式清空
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;

    // 客户端用真实 TOKEN 签的请求
    const xml = `<xml><Token><![CDATA[CURSOR]]></Token></xml>`;
    const enc = encrypt(xml, AESKEY, CORPID);
    const ts = "1", nonce = "n";
    const sig = signWithToken(ts, nonce, enc, TOKEN);
    const url = new URL("http://localhost/api/intake/wecom");
    url.searchParams.set("msg_signature", sig);
    url.searchParams.set("timestamp", ts);
    url.searchParams.set("nonce", nonce);

    const { POST } = await import("@/app/api/intake/wecom/route");
    const res = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/decrypt|signature/);

    // task 不能被创建
    const tasks = getDb().prepare(`SELECT * FROM tasks`).all();
    expect(tasks).toHaveLength(0);
  });

  it("缺 WECOM_ENCODING_AES_KEY: 服务端解密抛错被外层 try/catch 吞掉 (防企微重试), 但任务创建必须被阻断", async () => {
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = ""; // 显式清空

    // 用真实 AESKEY 加密客户端测, 但服务端 AESKey 为空 -> 解密抛 ERR_CRYPTO_INVALID_IV
    const xml = `<xml><Token><![CDATA[CURSOR]]></Token></xml>`;
    const enc = encrypt(xml, AESKEY, CORPID);
    const ts = "1", nonce = "n";
    const sig = signWithToken(ts, nonce, enc, TOKEN);
    const url = new URL("http://localhost/api/intake/wecom");
    url.searchParams.set("msg_signature", sig);
    url.searchParams.set("timestamp", ts);
    url.searchParams.set("nonce", nonce);

    const { POST } = await import("@/app/api/intake/wecom/route");
    const res = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
      }),
    );
    // 路由外层 try/catch 故意返回 200 (防企微重试风暴: 错配不会自愈, 反复回调
    // 只会重复打日志); fail-closed 的安全边界 = "没建任务 + 没人造消息给甲方".
    // 这是有意设计, 不是 bug. 详见 src/app/api/intake/wecom/route.ts:92 注释.
    expect(res.status).toBe(200);

    // 安全不变量: 不能因为 env 缺失就静默放行造出 task / intake_thread
    expect(getDb().prepare(`SELECT * FROM tasks`).all()).toHaveLength(0);
    expect(getDb().prepare(`SELECT * FROM intake_threads`).all()).toHaveLength(0);
  });

  it("两个 env 都缺: 任意错配下入站仍是 403 (不是 200/500)", async () => {
    process.env.WECOM_CALLBACK_TOKEN = "";
    process.env.WECOM_ENCODING_AES_KEY = "";

    const url = new URL("http://localhost/api/intake/wecom");
    url.searchParams.set("msg_signature", "deadbeef");
    url.searchParams.set("timestamp", "1");
    url.searchParams.set("nonce", "n");
    url.searchParams.set("echostr", "anything");

    const { GET, POST } = await import("@/app/api/intake/wecom/route");

    // GET URL 验证: 缺 TOKEN 验签必败, 应 403
    const g = await GET(new NextRequest(url));
    expect(g.status).toBe(403);

    // POST 回调: 缺 TOKEN 验签必败, 应 403
    const p = await POST(
      new NextRequest(url, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: `<xml><Encrypt><![CDATA[deadbeef]]></Encrypt></xml>`,
      }),
    );
    expect(p.status).toBe(403);
  });

  it("URL 验证 GET: 缺 TOKEN 时返回 403 (而不是明文 echostr)", async () => {
    process.env.WECOM_CALLBACK_TOKEN = "";
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;

    const url = new URL("http://localhost/api/intake/wecom");
    url.searchParams.set("msg_signature", "deadbeef");
    url.searchParams.set("timestamp", "1");
    url.searchParams.set("nonce", "n");
    url.searchParams.set("echostr", "should-never-leak");

    const { GET } = await import("@/app/api/intake/wecom/route");
    const res = await GET(new NextRequest(url));
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("should-never-leak");
  });
});