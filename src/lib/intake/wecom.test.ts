import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "../db/index";
import { createChannelConfig, listChannelConfigs } from "../db/channel-configs";
import { createRole } from "../db/roles";

const TOKEN = "testTokenForCryptoRoundTrip";
const AESKEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CORPID = "wwTESTCORPID";

// 模拟企微加密 echostr（与平台解密逻辑对称）
function encrypt(plain: string): string {
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
  return Buffer.concat([c.update(padded), c.final()]).toString("base64");
}

function sign(ts: string, nonce: string, enc: string): string {
  return createHash("sha1").update([TOKEN, ts, nonce, enc].sort().join("")).digest("hex");
}

describe("wecom callback crypto", () => {
  it("AESKey decodes to 32 bytes", () => {
    expect(Buffer.from(AESKEY + "=", "base64").length).toBe(32);
  });

  it("round-trips echostr through verify+decrypt", async () => {
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    const { handleUrlVerification, isUrlVerification } = await import("./wecom");

    const echostr = "1616140317555161061";
    const enc = encrypt(echostr);
    const ts = "1409659589", nonce = "263014780";
    const q = new URLSearchParams({
      msg_signature: sign(ts, nonce, enc), timestamp: ts, nonce, echostr: enc,
    });

    expect(isUrlVerification(q)).toBe(true);
    expect(handleUrlVerification(q)).toBe(echostr);
  });

  it("rejects a tampered signature", async () => {
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    const { handleUrlVerification } = await import("./wecom");
    const enc = encrypt("hello");
    const q = new URLSearchParams({
      msg_signature: "deadbeef", timestamp: "1", nonce: "2", echostr: enc,
    });
    expect(handleUrlVerification(q)).toBeNull();
  });

  // 回归: 企微按块大小 32 做 PKCS7 填充，Node autoPadding 按 16 校验，
  // 填充量 >16 时旧实现抛 "bad decrypt"。这里挑一个 pad=17 的长度复现。
  it("decrypts payloads whose 32-byte PKCS7 pad exceeds 16", async () => {
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    const { decryptCallback } = await import("./wecom");

    // raw = 16 random + 4 len + msg + corpid(12) => 32 + msgLen
    // 要 pad = 32 - (raw % 32) = 17 需 raw % 32 == 15 => msgLen % 32 == 15
    const msg = "x".repeat(47); // 47 % 32 == 15
    const raw = 16 + 4 + msg.length + CORPID.length;
    expect(32 - (raw % 32)).toBe(17);

    expect(decryptCallback(encrypt(msg))).toBe(msg);
  });

  it("decrypts a realistic kf_msg_or_event callback XML", async () => {
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    const { decryptCallbackBody, extractCallbackCursor } = await import("./wecom");

    const xml =
      "<xml><ToUserName><![CDATA[wwa2af38f64f86a441]]></ToUserName>" +
      "<CreateTime>1348831860</CreateTime><MsgType><![CDATA[event]]></MsgType>" +
      "<Event><![CDATA[kf_msg_or_event]]></Event>" +
      "<Token><![CDATA[ENCApHxnGDNAVNY4AaSJKj4Tb5mwsEMzxhFmHVGcra996NR]]></Token>" +
      "<OpenKfId><![CDATA[wkHJDOUwAASJaozivqpcQy90KoKiDVeA]]></OpenKfId></xml>";
    const enc = encrypt(xml);
    const ts = "1409659589", nonce = "263014780";
    const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
    const q = new URLSearchParams({ msg_signature: sign(ts, nonce, enc), timestamp: ts, nonce });

    const plain = decryptCallbackBody(body, q);
    expect(plain).toBe(xml);
    expect(extractCallbackCursor(plain!)).toBe("ENCApHxnGDNAVNY4AaSJKj4Tb5mwsEMzxhFmHVGcra996NR");
  });
});

// ---- D1 (docs/plans/intake-channel-unify.md): 凭据查表 + env 兜底 ----

const SECRET_JSON = {
  corpId: "wwCHANcorpid",
  corpSecret: "chanCorpSecret",
  aesKey: AESKEY,
  callbackToken: TOKEN,
  kfId: "wkChannelKfId01",
};

describe("wecom channel_configs 查表 + env 兜底 (D1)", () => {
  let tmpDir: string;
  let ownerId: string;
  let projectId: string;

  // roles.owner_id REFERENCES users, 建角色前补 users 行 (同 channel-configs.test.ts)
  function ensureUser(id: string): void {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", "user");
  }

  function createWecomRow(opts: { kfId?: string; roleId?: string; enabled?: boolean } = {}) {
    const cfg = createChannelConfig({
      channel: "wecom",
      name: `wecom-测试-${Math.random().toString(36).slice(2, 8)}`,
      secret: JSON.stringify({ ...SECRET_JSON, kfId: opts.kfId ?? SECRET_JSON.kfId }),
      bound_project_id: projectId,
      owner_id: ownerId,
      role_id: opts.roleId,
    });
    if (opts.enabled === false) {
      getDb().prepare("UPDATE channel_configs SET enabled = 0 WHERE id = ?").run(cfg.id);
    }
    return cfg;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wecom-chan-"));
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

  it("凭据解密回路: 表行 secret 解密还原 → 用还原凭据验签+解密回调", async () => {
    const role = createRole({ name: "wecom-sales", system_prompt: "你是售前", ownerId });
    createWecomRow({ roleId: role.id });

    const { getWecomChannelByKfId, decryptCallbackBody, extractCallbackCursor } = await import("./wecom");
    const resolved = getWecomChannelByKfId(SECRET_JSON.kfId);
    expect(resolved).not.toBeNull();
    expect(resolved!.creds).toEqual(SECRET_JSON);
    expect(resolved!.roleId).toBe(role.id);
    expect(resolved!.boundProjectId).toBe(projectId);
    expect(resolved!.channelId).toMatch(/^ch_/);

    // 用表行还原的凭据走完整解密回路 (不依赖 env)
    const xml =
      "<xml><Token><![CDATA[cursorTok123]]></Token>" +
      "<OpenKfId><![CDATA[wkChannelKfId01]]></OpenKfId></xml>";
    const enc = encrypt(xml);
    const ts = "1409659589", nonce = "263014780";
    const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
    const q = new URLSearchParams({ msg_signature: sign(ts, nonce, enc), timestamp: ts, nonce });
    const plain = decryptCallbackBody(body, q, resolved!.creds);
    expect(plain).toBe(xml);
    expect(extractCallbackCursor(plain!)).toBe("cursorTok123");
  });

  it("kf_id 不匹配 / disabled 行不命中; 无参唯一启用行直取, 多行歧义返 null", async () => {
    const { getWecomChannelByKfId } = await import("./wecom");

    expect(getWecomChannelByKfId("wkNone")).toBeNull(); // 空表

    createWecomRow({ kfId: "wkA" });
    createWecomRow({ kfId: "wkB", enabled: false });

    expect(getWecomChannelByKfId("wkA")!.creds.kfId).toBe("wkA");
    expect(getWecomChannelByKfId("wkB")).toBeNull(); // disabled 不命中
    expect(getWecomChannelByKfId("wkNone")).toBeNull();

    // 唯一启用行 (wkA): 无参直取 (单实例场景)
    const unique = getWecomChannelByKfId();
    expect(unique).not.toBeNull();
    expect(unique!.creds.kfId).toBe("wkA");

    // 第二个启用行出现 → 无参歧义返 null, 按 kf_id 仍可精确命中
    createWecomRow({ kfId: "wkC" });
    expect(getWecomChannelByKfId()).toBeNull();
    expect(getWecomChannelByKfId("wkC")!.creds.kfId).toBe("wkC");
  });

  it("secret 非法 (坏 JSON / 缺必填项) 的行不进候选; 候选顺序 = 表行在前 env 殿后", async () => {
    createChannelConfig({
      channel: "wecom",
      name: "坏行",
      secret: "not-json",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    createWecomRow({ kfId: "wkGood" });
    // telegram 行混入不应被算进 wecom 候选
    createChannelConfig({
      channel: "telegram",
      name: "tg bot",
      secret: "123:ABC",
      bound_project_id: projectId,
      owner_id: ownerId,
    });

    process.env.WECOM_CORP_ID = "wwEnvFallback";
    const { listWecomCandidates, getWecomChannelByKfId } = await import("./wecom");
    const candidates = listWecomCandidates();
    expect(candidates).toHaveLength(2); // 坏行被过滤, telegram 行不算
    expect(candidates[0].channelId).not.toBeNull();
    expect(candidates[0].creds.kfId).toBe("wkGood");
    expect(candidates[1]).toEqual({
      channelId: null,
      boundProjectId: null,
      roleId: null,
      versionId: null,
      creds: {
        corpId: "wwEnvFallback",
        corpSecret: process.env.WECOM_CORP_SECRET ?? "",
        aesKey: AESKEY,
        callbackToken: TOKEN,
        kfId: process.env.WECOM_KF_ID ?? "",
      },
    });

    // 坏 JSON 行按 kf_id 也查不到
    expect(getWecomChannelByKfId("wkGood")!.creds.kfId).toBe("wkGood");
    expect(getWecomChannelByKfId("not-json")).toBeNull();
  });

  it("fallback: 无表行时走旧 env 五常量解密; role 挂载条件展开语义", async () => {
    const { getWecomChannelByKfId, decryptCallbackBody } = await import("./wecom");

    // 空表 + env (文件顶部既有测试已设 WECOM_CALLBACK_TOKEN/ENCODING_AES_KEY)
    process.env.WECOM_CALLBACK_TOKEN = TOKEN;
    process.env.WECOM_ENCODING_AES_KEY = AESKEY;
    expect(getWecomChannelByKfId(SECRET_JSON.kfId)).toBeNull(); // 查不到表行

    const xml = "<xml><Token><![CDATA[envTok]]></Token></xml>";
    const enc = encrypt(xml);
    const ts = "1", nonce = "2";
    const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
    const q = new URLSearchParams({ msg_signature: sign(ts, nonce, enc), timestamp: ts, nonce });
    // 不传 creds → env 兜底, 行为不回退
    expect(decryptCallbackBody(body, q)).toBe(xml);

    // role 挂载条件展开 (同 telegram route :101-102): 表行 roleId 传入, env 兜底 null 不传
    const role = createRole({ name: "wecom-role-2", system_prompt: "你是售前", ownerId });
    createWecomRow({ kfId: "wkRole", roleId: role.id });
    const fromRow = getWecomChannelByKfId("wkRole")!;
    const withRow: Record<string, unknown> = {
      title: "t",
      ...(fromRow.roleId ? { role_id: fromRow.roleId } : {}),
    };
    expect(withRow.role_id).toBe(role.id);

    const fromEnv = getWecomChannelByKfId("missing") ?? {
      channelId: null,
      boundProjectId: null,
      roleId: null,
      creds: { corpId: "", corpSecret: "", aesKey: "", callbackToken: "", kfId: "" },
    };
    const withoutRole: Record<string, unknown> = {
      title: "t",
      ...(fromEnv.roleId ? { role_id: fromEnv.roleId } : {}),
    };
    expect("role_id" in withoutRole).toBe(false);
  });
});
