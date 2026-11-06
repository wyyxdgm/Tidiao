// 飞书 intake route 测试 (D2, docs/plans/intake-channel-unify.md).
// 功能: 不启动 HTTP server, 直接调 POST handler 走完整链路:
//   加密回调体 → resolveEvent 验签 → challenge 应答 / 建 thread+task / 续聊.
// 关注点: mock runtime 的 createTask 用真实 db/tasks.createTask (task 真落库可断言
//   role_id/tags/allowed_tools), sendUserMessage 用 spy 断言续聊; channel 行走真实
//   channel_configs 表 (secret AES-GCM 落库再解密还原, 覆盖凭据回路).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, createCipheriv } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createChannelConfig } from "@/lib/db/channel-configs";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { createRole } from "@/lib/db/roles";
import { createVersion } from "@/lib/db/versions";

const ENC_KEY = "feishuRouteTestEncryptKey";
const VERIFY_TOKEN = "feishuRouteVerifyToken";
const CHAT_ID = "oc_route_chat_001";

// 与 feishu.ts decryptEvent 对称的加密 fixture
function encryptPayload(plain: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

function encryptedRequest(evt: unknown, key = ENC_KEY): NextRequest {
  return new NextRequest(new URL("http://localhost/api/intake/feishu"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encrypt: encryptPayload(JSON.stringify(evt), key) }),
  });
}

function challengeEvt(): Record<string, unknown> {
  return { challenge: "route_challenge_42", token: VERIFY_TOKEN, type: "url_verification" };
}

function messageEvt(opts: { chatId?: string; text?: string; eventId?: string } = {}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: opts.eventId ?? "evt-route-1",
      event_type: "im.message.receive_v1",
      token: VERIFY_TOKEN,
      create_time: "1609286482000",
    },
    event: {
      sender: { sender_id: { open_id: "ou_route_sender" }, sender_type: "user" },
      message_id: "om_route_msg",
      chat_id: opts.chatId ?? CHAT_ID,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: opts.text ?? "甲方需求：登录页要加导出按钮" }),
    },
  };
}

describe("飞书 intake route (D2)", () => {
  let tmpDir: string;
  let projectId: string;
  let ownerId: string;
  let POST: (req: NextRequest) => Promise<Response>;
  let sendUserMessageSpy: ReturnType<typeof vi.fn>;

  function createFeishuRow(
    roleId?: string,
    boundVersionId?: string,
    channel: "feishu" | "lark" = "feishu",
  ): { id: string; bindCode: string } {
    const cfg = createChannelConfig({
      channel,
      name: `${channel}-route-test`,
      secret: JSON.stringify({ verificationToken: VERIFY_TOKEN, encryptKey: ENC_KEY }),
      bound_project_id: projectId,
      owner_id: ownerId,
      ...(roleId ? { role_id: roleId } : {}),
      ...(boundVersionId ? { bound_version_id: boundVersionId } : {}),
    });
    return { id: cfg.id, bindCode: cfg.bind_code };
  }

  // 扫码绑定 D2 后首条消息必须 bind: 发 "bind <码>" 完成 thread 建立
  async function bindFirst(bindCode: string, eventId = "evt-bind"): Promise<Response> {
    return POST(encryptedRequest(messageEvt({ text: `bind ${bindCode}`, eventId })));
  }

  beforeEach(async () => {
    // 1) DB
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-feishu-route-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();

    // 2) owner + project
    ownerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(ownerId, `${ownerId}@example.com`, "x", "user");
    projectId = createProject({ name: "feishu-intake-route", ownerId }).id;

    // 3) runtime mock: createTask 走真实 db (落库可断言), startTask noop, sendUserMessage spy
    sendUserMessageSpy = vi.fn();
    vi.doMock("@/lib/runtime/agent-runtime", () => ({
      getRuntime: () => ({
        createTask,
        startTask: () => {},
        sendUserMessage: sendUserMessageSpy,
      }),
    }));

    // 4) dynamic import (mock 就位后)
    POST = (await import("./route")).POST;
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/runtime/agent-runtime");
    vi.resetModules(); // feishu.ts 的 event 去重 Map / 模块级状态随模块重建
    delete process.env.ORCHESTRATOR_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("url_verification: 加密 challenge 应答 {challenge} (飞书后台配 URL 的握手)", async () => {
    createFeishuRow();
    const res = await POST(encryptedRequest(challengeEvt()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "route_challenge_42" });

    // 握手不产生任何线程/task
    expect((getDb().prepare(`SELECT COUNT(*) c FROM intake_threads`).get() as { c: number }).c).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(0);
  });

  it("验签失败 403: 异 encryptKey 密文 / token 不匹配明文 / 空表, 均不建 task", async () => {
    createFeishuRow();

    // 别家 encryptKey 加的密 → 本行解不开
    const r1 = await POST(encryptedRequest(messageEvt(), "otherEncryptKey"));
    expect(r1.status).toBe(403);
    // 明文包 token 不匹配
    const plainReq = new NextRequest(new URL("http://localhost/api/intake/feishu"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: { event_id: "evt-x", event_type: "im.message.receive_v1", token: "wrong" },
        event: messageEvt().event,
      }),
    });
    const r3 = await POST(plainReq);
    expect(r3.status).toBe(403);

    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(0);
  });

  it("chat_id 线程幂等: bind 建 thread+task, 之后同 chat 续聊不建新 task", async () => {
    const { bindCode } = createFeishuRow();

    // bind: 建 task + thread
    const r1 = await bindFirst(bindCode, "evt-first");
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, created: expect.any(String) });

    const tasks = getDb().prepare(`SELECT * FROM tasks`).all() as Array<{
      id: string;
      title: string;
      tags: string;
      allowed_tools: string | null;
      role_id: string | null;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain("甲方需求线程");
    expect(JSON.parse(tasks[0].tags)).toEqual(expect.arrayContaining(["intake", "feishu"]));
    // 只读探索集 (外部渠道任意文本, 不给 Bash/Write/Edit)
    const tools = JSON.parse(tasks[0].allowed_tools!) as string[];
    expect(tools).toContain("Read");
    expect(tools).not.toContain("Bash");

    const threads = getDb().prepare(`SELECT * FROM intake_threads`).all() as Array<{
      channel: string;
      external_user_id: string;
      task_id: string;
      last_inbound_at: string | null;
    }>;
    expect(threads).toHaveLength(1);
    expect(threads[0].channel).toBe("feishu");
    expect(threads[0].external_user_id).toBe(CHAT_ID);
    expect(threads[0].task_id).toBe(tasks[0].id);
    expect(threads[0].last_inbound_at).not.toBeNull();

    // 第二条: 同 chat_id → 续聊, 不建新 task
    sendUserMessageSpy.mockClear();
    const r2 = await POST(encryptedRequest(messageEvt({ text: "补充：要 Excel 格式", eventId: "evt-second" })));
    expect(r2.status).toBe(200);
    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(1);
    expect((getDb().prepare(`SELECT COUNT(*) c FROM intake_threads`).get() as { c: number }).c).toBe(1);
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    const [calledTaskId, calledText] = sendUserMessageSpy.mock.calls[0]!;
    expect(calledTaskId).toBe(tasks[0].id);
    expect(calledText).toBe("补充：要 Excel 格式");
  });

  it("role 挂载: 渠道行配了 role → 首 task 落 role_id; 未配 → role_id 为空", async () => {
    const role = createRole({ name: "feishu-sales", system_prompt: "你是售前", ownerId });
    const { bindCode } = createFeishuRow(role.id);

    await bindFirst(bindCode, "evt-role");
    const task = getDb().prepare(`SELECT role_id FROM tasks`).get() as { role_id: string | null };
    expect(task.role_id).toBe(role.id);
  });

  it("role 未配: role_id NULL 时不传, task 走原逻辑 (role_id 空)", async () => {
    const { bindCode } = createFeishuRow(); // 无 role

    await bindFirst(bindCode, "evt-norole");
    const task = getDb().prepare(`SELECT role_id FROM tasks`).get() as { role_id: string | null };
    expect(task.role_id).toBeNull();
  });

  it("绑定版本 (v529): 渠道行钉了 bound_version_id → 首 task 落该 version", async () => {
    const version = createVersion({ project_id: projectId, name: "v-feishu" });
    const { bindCode } = createFeishuRow(undefined, version.id);

    await bindFirst(bindCode, "evt-ver");
    const task = getDb().prepare(`SELECT version_id FROM tasks`).get() as { version_id: string | null };
    expect(task.version_id).toBe(version.id);
  });

  it("绑定版本 (v529): bound_version_id NULL → task.version_id 空, 跟随项目 current (行为不变)", async () => {
    const { bindCode } = createFeishuRow(); // 无版本

    await bindFirst(bindCode, "evt-nover");
    const task = getDb().prepare(`SELECT version_id FROM tasks`).get() as { version_id: string | null };
    expect(task.version_id).toBeNull();
  });

  it("event_id 重投去重: 同 event_id 第二次 200 + dedup, 不重复触发续聊", async () => {
    const { bindCode } = createFeishuRow();

    await bindFirst(bindCode, "evt-bind-dup");
    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(1);

    await POST(encryptedRequest(messageEvt({ text: "首问", eventId: "evt-dup" })));
    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(1);

    sendUserMessageSpy.mockClear();
    const res = await POST(encryptedRequest(messageEvt({ text: "补充", eventId: "evt-dup" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dedup: true });
    expect(sendUserMessageSpy).not.toHaveBeenCalled();
    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(1);
  });

  it("未绑渠道行收到非 bind 消息 → 跳过不建 task (防陌生人白烧额度)", async () => {
    createFeishuRow();

    const res = await POST(encryptedRequest(messageEvt({ text: "随便聊聊", eventId: "evt-unbound" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "not bound" });
    expect((getDb().prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) c FROM intake_threads`).get() as { c: number }).c).toBe(0);
  });
});

// 扫码绑定 D2 (docs/plans/channel-qr-bind.md): bind 命令门控 + lark 渠道行同逻辑.
// 关注点: lark 与 feishu 同回调协议 (验签解密与域名无关), 候选一起遍历,
//   thread.channel 落行自己的类型; 回执文案无法 route 直发 (收发分治), 走 agent 首轮 REPLY.
describe("飞书/Lark bind 命令 (扫码绑定 D2)", () => {
  let tmpDir: string;
  let projectId: string;
  let ownerId: string;
  let POST: (req: NextRequest) => Promise<Response>;
  let sendUserMessageSpy: ReturnType<typeof vi.fn>;

  function createChannelRow(channel: "feishu" | "lark"): { id: string; bindCode: string } {
    const cfg = createChannelConfig({
      channel,
      name: `${channel}-bind-test`,
      secret: JSON.stringify({ verificationToken: VERIFY_TOKEN, encryptKey: ENC_KEY }),
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    return { id: cfg.id, bindCode: cfg.bind_code };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-feishu-bind-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();

    ownerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(ownerId, `${ownerId}@example.com`, "x", "user");
    projectId = createProject({ name: "feishu-bind-route", ownerId }).id;

    sendUserMessageSpy = vi.fn();
    vi.doMock("@/lib/runtime/agent-runtime", () => ({
      getRuntime: () => ({
        createTask,
        startTask: () => {},
        sendUserMessage: sendUserMessageSpy,
      }),
    }));

    POST = (await import("./route")).POST;
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/runtime/agent-runtime");
    vi.resetModules();
    delete process.env.ORCHESTRATOR_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bind 命中 feishu 渠道行 → 建 thread + task (channel=feishu, 绑定码大小写不敏感)", async () => {
    const { bindCode } = createChannelRow("feishu");

    const res = await POST(
      encryptedRequest(messageEvt({ text: `bind ${bindCode.toLowerCase()}`, eventId: "evt-bind-1" })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: expect.any(String) });

    const thread = getDb().prepare(`SELECT * FROM intake_threads`).get() as {
      channel: string;
      external_user_id: string;
    };
    expect(thread.channel).toBe("feishu");
    expect(thread.external_user_id).toBe(CHAT_ID);
  });

  it("lark 渠道行同逻辑: bind 命中 → thread.channel = lark", async () => {
    const { bindCode } = createChannelRow("lark");

    const res = await POST(encryptedRequest(messageEvt({ text: `bind ${bindCode}`, eventId: "evt-lark" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: expect.any(String) });

    const thread = getDb().prepare(`SELECT * FROM intake_threads`).get() as { channel: string };
    expect(thread.channel).toBe("lark");

    // lark thread 也能续聊
    sendUserMessageSpy.mockClear();
    const r2 = await POST(
      encryptedRequest(messageEvt({ text: "lark 甲方需求", eventId: "evt-lark-2" })),
    );
    expect(await r2.json()).toMatchObject({ ok: true, resumed: expect.any(String) });
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("bind 码无效 / 码属其他渠道类型 → 跳过不建线程", async () => {
    createChannelRow("feishu");

    // 无效码
    const r1 = await POST(encryptedRequest(messageEvt({ text: "bind WRONG123", eventId: "evt-bad" })));
    expect(await r1.json()).toEqual({ ok: true, skipped: "invalid bind code" });

    // 码存在但属 telegram 渠道 (不归 feishu 线路处理)
    const tgCfg = createChannelConfig({
      channel: "telegram",
      name: "tg",
      bound_project_id: projectId,
      owner_id: ownerId,
    });
    const r2 = await POST(
      encryptedRequest(messageEvt({ text: `bind ${tgCfg.bind_code}`, eventId: "evt-tgcode" })),
    );
    expect(await r2.json()).toEqual({ ok: true, skipped: "invalid bind code" });

    expect((getDb().prepare(`SELECT COUNT(*) c FROM intake_threads`).get() as { c: number }).c).toBe(0);
  });
});
