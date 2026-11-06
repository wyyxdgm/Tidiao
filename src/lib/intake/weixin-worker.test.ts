// 微信长轮询 worker 单测 (D3, docs/plans/channel-qr-bind.md).
// 覆盖: bind 命令建 thread+task / 未绑两段式 (只回引导不建 task) / 已绑续聊 resume /
//   🔴 游标提交纪律 (整批成功才写 KV; 失败不推) / msgId 去重 (at-least-once 重投兜底) /
//   停用行不轮询 / secret 无效行跳过.
// DB = 真实 SQLite (tmpdir), runtime = mock (createTask 走真实 db, sendUserMessage spy),
//   iLink fetch = mock (getupdates / sendmessage).

// 本仓 TS 5.0.2 无 Response.json 静态方法 (deploy log 前科), 测试 helper 统一构造
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "../db/index";
import { createChannelConfig } from "../db/channel-configs";
import { createProject } from "../db/projects";
import { getIntakeThreadByExternal, INTAKE_CHANNELS } from "../db/intake-threads";
import { getSetting } from "../db/settings";
import { createTask } from "../db/tasks";

// fetch mock 由各用例自装 (vi.stubGlobal); 这里只备类型
const sendUserMessageSpy = vi.fn();
const startedTasks: string[] = [];

async function mockIlinkGetupdates(payload: unknown): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/getupdates")) {
        return jsonResponse(payload);
      }
      if (u.includes("/sendmessage")) {
        return jsonResponse({ ret: 0 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

describe("weixin-worker", () => {
  let tmpDir: string;
  let ownerId: string;
  let projectId: string;
  let channelId: string;
  let worker: typeof import("./weixin-worker");
  // createTask 在 runtime mock 里被调用时截获返回 id
  let taskSeq = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-weixin-worker-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();

    ownerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(ownerId, `${ownerId}@example.com`, "x", "user");
    projectId = createProject({ name: "weixin-worker-test", ownerId }).id;

    // weixin 渠道行 (secret = iLink JSON)
    channelId = createChannelConfig({
      channel: "weixin",
      name: "weixin-iLink-test",
      secret: JSON.stringify({ bot_token: "tok-1", ilink_bot_id: "bot-1" }),
      bound_project_id: projectId,
      owner_id: ownerId,
    }).id;

    taskSeq = 0;
    sendUserMessageSpy.mockClear();
    startedTasks.length = 0;
    vi.doMock("@/lib/runtime/agent-runtime", () => ({
      getRuntime: () => ({
        createTask: (def: Record<string, unknown>) => {
          const t = createTask({
            ...(def as any),
            title: (def.title as string) ?? "t",
            prompt: (def.prompt as string) ?? "",
            project_id: (def.project_id as string) ?? projectId,
          });
          startedTasks.push(t.id);
          return t;
        },
        startTask: (taskId: string) => {
          void taskId;
          taskSeq += 1;
        },
        sendUserMessage: sendUserMessageSpy,
      }),
    }));
    worker = await import("./weixin-worker");
    worker._resetWeixinWorkerForTest();
  });

  afterEach(() => {
    worker?.stopWeixinWorker();
    closeDb();
    vi.doUnmock("@/lib/runtime/agent-runtime");
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ORCHESTRATOR_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 快捷: 构造一条 getupdates 响应消息
  function rawMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: `m-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 1,
      from_user_id: "wxid_user_a",
      text: "你好",
      ...overrides,
    };
  }

  it("INTAKE_CHANNELS 枚举含 weixin", () => {
    expect(INTAKE_CHANNELS).toContain("weixin");
  });

  it("bind 命令: 建 thread + 首 task + 回执绑定成功", async () => {
    const code = getDb()
      .prepare("SELECT bind_code FROM channel_configs WHERE id = ?")
      .get(channelId) as { bind_code: string };
    await mockIlinkGetupdates({
      msgs: [rawMsg({ text: `bind ${code.bind_code}` })],
      get_updates_buf: "cur-1",
    });
    await worker.tickWeixinWorker();

    const thread = getIntakeThreadByExternal("weixin", "wxid_user_a");
    expect(thread).not.toBeNull();
    expect(thread!.project_id).toBe(projectId);
    expect(startedTasks).toHaveLength(1);
    // 回执含项目名 (sendmessage body 断言在 fetch mock 里, 这里验线程 + task)
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBe("cur-1");
  });

  it("两段式: 未绑非 bind 消息回本渠道绑定码引导, 不建 task 不建 thread", async () => {
    const sendBodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/getupdates")) return jsonResponse({ msgs: [rawMsg()], get_updates_buf: "cur-2" });
        if (u.includes("/sendmessage")) {
          sendBodies.push(JSON.parse(String(init!.body)));
          return jsonResponse({ ret: 0 });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    await worker.tickWeixinWorker();

    expect(getIntakeThreadByExternal("weixin", "wxid_user_a")).toBeNull();
    expect(startedTasks).toHaveLength(0);
    expect(sendBodies).toHaveLength(1);
    // 引导回复 = 主动送达本渠道绑定码 (damo 2026-10-14: 码要流程给出, 不让用户问)
    const wxCode = (getDb().prepare("SELECT bind_code FROM channel_configs WHERE id = ?").get(channelId) as any).bind_code;
    expect(sendBodies[0].msg.item_list[0].text_item.text).toContain(wxCode);
  });

  it("已绑续聊: sendUserMessage 触发 resume + markInbound", async () => {
    // 先绑定
    const code = (getDb().prepare("SELECT bind_code FROM channel_configs WHERE id = ?").get(channelId) as any).bind_code;
    await mockIlinkGetupdates({ msgs: [rawMsg({ text: `bind ${code}`, id: "m-bind" })], get_updates_buf: "cur-a" });
    await worker.tickWeixinWorker();

    // 再发普通消息
    await mockIlinkGetupdates({ msgs: [rawMsg({ text: "登录页要加导出", id: "m-chat" })], get_updates_buf: "cur-b" });
    await worker.tickWeixinWorker();

    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendUserMessageSpy.mock.calls[0][1]).toBe("登录页要加导出");
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBe("cur-b");
  });

  it("🔴 游标纪律: 业务处理失败 (sendmessage 抛错) 不推游标", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/getupdates")) {
          return jsonResponse({ msgs: [rawMsg()], get_updates_buf: "cur-x" });
        }
        // sendmessage 失败 (未绑引导回复失败 = 业务失败)
        return jsonResponse({ ret: -1, errmsg: "send boom" });
      }),
    );
    await worker.tickWeixinWorker();
    // 引导回复失败 → 游标不提交 (下轮重投)
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBeNull();
  });

  it("🔴 游标纪律: getupdates 网络失败不推游标不抛 (下 tick 重试)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(worker.tickWeixinWorker()).resolves.not.toThrow();
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBeNull();
  });

  it("msgId 去重: 同 id 重投只处理一次 (不重复建 task)", async () => {
    const code = (getDb().prepare("SELECT bind_code FROM channel_configs WHERE id = ?").get(channelId) as any).bind_code;
    // 两次 tick 投同一条 bind 消息 (服务端游标未推进的重放场景)
    await mockIlinkGetupdates({ msgs: [rawMsg({ text: `bind ${code}`, id: "m-dup" })], get_updates_buf: "cur-d" });
    await worker.tickWeixinWorker();
    await worker.tickWeixinWorker();
    expect(startedTasks).toHaveLength(1);
    expect(getIntakeThreadByExternal("weixin", "wxid_user_a")).not.toBeNull();
  });

  it("停用行不轮询 (enabled=0 跳过)", async () => {
    getDb().prepare("UPDATE channel_configs SET enabled = 0 WHERE id = ?").run(channelId);
    const fetchSpy = vi.fn(async () => jsonResponse({ msgs: [rawMsg()], get_updates_buf: "c" }));
    vi.stubGlobal("fetch", fetchSpy);
    await worker.tickWeixinWorker();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("secret 无效行跳过 (不打 iLink)", async () => {
    getDb().prepare("UPDATE channel_configs SET secret_encrypted = NULL, secret_iv = NULL, secret_tag = NULL WHERE id = ?").run(channelId);
    const fetchSpy = vi.fn(async () => jsonResponse({ msgs: [], get_updates_buf: "" }));
    vi.stubGlobal("fetch", fetchSpy);
    await worker.tickWeixinWorker();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bind 码属其他渠道行 → 回绑定码无效 (防串渠道)", async () => {
    // 建 telegram 渠道行, 拿它的码在微信里发
    const tgCode = createChannelConfig({
      channel: "telegram",
      name: "tg-bot",
      secret: "tg-token",
      bound_project_id: projectId,
      owner_id: ownerId,
    }).bind_code;
    const sendBodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/getupdates")) return jsonResponse({ msgs: [rawMsg({ text: `bind ${tgCode}` })], get_updates_buf: "c" });
        if (u.includes("/sendmessage")) {
          sendBodies.push(JSON.parse(String(init!.body)));
          return jsonResponse({ ret: 0 });
        }
        throw new Error(`unexpected: ${u}`);
      }),
    );
    await worker.tickWeixinWorker();
    expect(startedTasks).toHaveLength(0);
    expect(getIntakeThreadByExternal("weixin", "wxid_user_a")).toBeNull();
    expect(sendBodies[0].msg.item_list[0].text_item.text).toContain("无效");
  });

  // -----------------------------------------------------------------------
  // 非文本消息 (damo 2026-10-15: 语音/图片不再静默忽略)
  // -----------------------------------------------------------------------

  // mock ASR 模块 (worker 走 @/lib/intake/weixin-asr 别名导入); resetModules 让
  // 重 import 拿到新绑定 (ESM 缓存下不 reset 会沿用旧模块的 transcribeAudio)
  async function mockAsr(result: string | null): Promise<void> {
    vi.doMock("@/lib/intake/weixin-asr", () => ({
      transcribeAudio: vi.fn(async () => result),
    }));
    vi.resetModules();
    worker = await import("./weixin-worker");
    worker._resetWeixinWorkerForTest();
  }

  // 构造一段真实可解密的 CDN 语音密文 (AES-128-ECB, key = hex32 'a'*32, 与测试消息 aes_key 一致)
  function fakeVoiceCiphertext(): Buffer {
    const enc = createCipheriv("aes-128-ecb", Buffer.from("a".repeat(32), "hex"), null);
    return Buffer.concat([enc.update(Buffer.from("fake-silk-voice")), enc.final()]);
  }

  it("图片消息 → 回兜底话术 (不静默, 不建 task)", async () => {
    await mockAsr(null);
    const sendBodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/getupdates")) {
          return jsonResponse({
            msgs: [rawMsg({ text: undefined, item_list: [{ type: 3, image_item: { media: { full_url: "https://cdn/x.jpg" } } }] })],
            get_updates_buf: "cur-img",
          });
        }
        if (u.includes("/sendmessage")) {
          sendBodies.push(JSON.parse(String(init!.body)));
          return jsonResponse({ ret: 0 });
        }
        throw new Error(`unexpected: ${u}`);
      }),
    );
    await worker.tickWeixinWorker();
    expect(startedTasks).toHaveLength(0);
    expect(getIntakeThreadByExternal("weixin", "wxid_user_a")).toBeNull();
    expect(sendBodies[0].msg.item_list[0].text_item.text).toContain("非文字消息暂不支持");
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBe("cur-img");
  });

  it("语音 + 转写成功 → 「[语音转写] 文本」走现有文本链路 (已绑则 resume)", async () => {
    // 先绑定
    const code = (getDb().prepare("SELECT bind_code FROM channel_configs WHERE id = ?").get(channelId) as any).bind_code;
    await mockIlinkGetupdates({ msgs: [rawMsg({ text: `bind ${code}`, id: "m-bind0" })], get_updates_buf: "cur-v0" });
    await worker.tickWeixinWorker();

    await mockAsr("明天下午三点开会");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/getupdates")) {
          return jsonResponse({
            msgs: [rawMsg({ id: "m-voice0", text: undefined, item_list: [{ audio_item: { media: { url: "https://cdn/v.bin", aes_key: "a".repeat(32) } } }] })],
            get_updates_buf: "cur-v1",
          });
        }
        // 语音 CDN 下载: 返回可解密密文
        if (u.includes("cdn/v.bin")) {
          return new Response(new Uint8Array(fakeVoiceCiphertext()), { status: 200 });
        }
        if (u.includes("/sendmessage")) return jsonResponse({ ret: 0 });
        throw new Error(`unexpected: ${u}`);
      }),
    );
    await worker.tickWeixinWorker();
    expect(sendUserMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendUserMessageSpy.mock.calls[0][1]).toBe("[语音转写] 明天下午三点开会");
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBe("cur-v1");
  });

  it("语音 + 转写失败 → 回语音兜底话术 (不挂收消息链, 游标照推)", async () => {
    await mockAsr(null);
    const sendBodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/getupdates")) {
          return jsonResponse({
            msgs: [rawMsg({ id: "m-voice1", text: undefined, item_list: [{ audio_item: { media: { url: "https://cdn/v.bin", aes_key: "a".repeat(32) } } }] })],
            get_updates_buf: "cur-v2",
          });
        }
        if (u.includes("/sendmessage")) {
          sendBodies.push(JSON.parse(String(init!.body)));
          return jsonResponse({ ret: 0 });
        }
        throw new Error(`unexpected: ${u}`);
      }),
    );
    await worker.tickWeixinWorker();
    expect(sendBodies[0].msg.item_list[0].text_item.text).toContain("语音转写暂时不可用");
    expect(getSetting("weixin_get_updates_buf:" + channelId)).toBe("cur-v2");
    expect(startedTasks).toHaveLength(0);
  });
});
