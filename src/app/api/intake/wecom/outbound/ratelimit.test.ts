// 企微 intake 出站 48h / 5 窗口边界测试.
//
// 功能: 验证出站路由在窗口判定上的不变量:
//   1. 窗口内第 5 条 OK, 第 6 条被拒 (skip + intake_send_skipped 事件)
//   2. markInbound 后窗口重置, msg_sent_in_window 归 0
//   3. 48h 超窗后即便没发满 5 条也 skip
// 关注点: 这些不变量是企微硬约束在平台的镜像; 出站若不守 = 烧光甲方配额后
//   send_msg 持续失败 / 平台刷屏甲方. 边界用真 DB + mock sendKfMessage + mock
//   getSessionHistory (返回 canned REPLY).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import {
  createIntakeThread,
  getIntakeThreadByExternal,
  markInbound,
  incrementSentCount,
} from "@/lib/db/intake-threads";
import { getEventsByTaskId } from "@/lib/db/events";

const WEBHOOK_SECRET = "testWebhookSecretRatelimit";
const EXTERNAL_USER = "wmRATELIMIT_USER";
const REPLY_TEXT = "好的，正在处理";

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function postOutbound(taskId: string): Promise<Response> {
  const body = JSON.stringify({
    task: { id: taskId, status: "reviewing" },
    event: "task.reviewing",
  });
  const url = new URL("http://localhost/api/intake/wecom/outbound");
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature": sign(body) },
    body,
  });
  const { POST } = await import("@/app/api/intake/wecom/outbound/route");
  return POST(req);
}

describe("企微 intake 出站 48h/5 窗口", () => {
  let tmpDir: string;
  let projectId: string;
  let taskId: string;
  let threadId: string;
  let sendKfSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.INTAKE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-intake-rl-"));
    process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
    closeDb();
    getDb();

    const ownerId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(ownerId, `${ownerId}@example.com`, "x", "user");
    projectId = createProject({ name: "ratelimit", ownerId }).id;

    // 预建 thread + task, last_inbound_at = now (窗口内)
    const taskRow = getDb()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, project_id, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv4(), "rl-task", "p", projectId, ownerId, "reviewing", new Date().toISOString());
    taskId = String(taskRow.lastInsertRowid);

    // 修正: tasks 表主键是 TEXT, 用 uuid 直接
    taskId = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, project_id, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, "rl-task", "p", projectId, ownerId, "reviewing", new Date().toISOString());

    const thread = createIntakeThread({
      channel: "wecom",
      external_user_id: EXTERNAL_USER,
      task_id: taskId,
      project_id: projectId,
      owner_id: ownerId,
    });
    threadId = thread.id;

    // mock wecom.sendKfMessage 计数
    sendKfSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/intake/wecom", () => ({
      sendKfMessage: sendKfSpy,
    }));

    // mock runtime: 返回 canned REPLY
    vi.doMock("@/lib/runtime/agent-runtime", () => ({
      getRuntime: () => ({
        getSessionHistory: async () => [
          {
            type: "assistant",
            uuid: "asst-1",
            session_id: "s1",
            message: {
              content: [
                { type: "text", text: `分析正文\n\n<<<REPLY>>>\n${REPLY_TEXT}\n<<<END>>>` },
              ],
            },
          },
        ],
      }),
    }));
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/intake/wecom");
    vi.doUnmock("@/lib/runtime/agent-runtime");
    vi.resetModules();
    delete process.env.ORCHESTRATOR_DB_PATH;
    delete process.env.INTAKE_WEBHOOK_SECRET;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("窗口内前 5 条发送 OK, 第 6 条被拒 + 记 intake_send_skipped 事件", async () => {
    // 起点 msg_sent_in_window=0
    let thread = getDb()
      .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
      .get(threadId) as { msg_sent_in_window: number };
    expect(thread.msg_sent_in_window).toBe(0);

    // 5 次连发: 全部应成功, sendKfMessage 调用 5 次
    for (let i = 1; i <= 5; i++) {
      const res = await postOutbound(taskId);
      expect(res.status).toBe(200);
      thread = getDb()
        .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
        .get(threadId) as { msg_sent_in_window: number };
      expect(thread.msg_sent_in_window).toBe(i);
    }
    expect(sendKfSpy).toHaveBeenCalledTimes(5);

    // 第 6 次: 应被拒, sendKfMessage 不再调用, msg_sent_in_window 仍为 5
    const res6 = await postOutbound(taskId);
    expect(res6.status).toBe(200);
    const body6 = await res6.json();
    expect(body6.skipped).toBe("window/limit");
    expect(sendKfSpy).toHaveBeenCalledTimes(5); // 未增

    thread = getDb()
      .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
      .get(threadId) as { msg_sent_in_window: number };
    expect(thread.msg_sent_in_window).toBe(5);

    // 必记事件: intake_send_skipped, 原因 5 msg limit reached
    const events = getEventsByTaskId(taskId);
    const skipEvts = events.filter((e) => e.type === "intake_send_skipped");
    expect(skipEvts).toHaveLength(1);
    expect(JSON.parse(skipEvts[0].data)).toMatchObject({
      reason: "5 msg limit reached",
      thread_id: threadId,
    });
  });

  it("markInbound 重置窗口: 触顶后再来一条甲方消息, 计数归 0 可再发 5 条", async () => {
    // 烧光 5 条
    for (let i = 0; i < 5; i++) await postOutbound(taskId);

    // 第 6 条拒
    const r6 = await postOutbound(taskId);
    expect((await r6.json()).skipped).toBe("window/limit");

    // 甲方又发了一条: markInbound 重置窗口
    markInbound(threadId);
    const after = getDb()
      .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
      .get(threadId) as { msg_sent_in_window: number };
    expect(after.msg_sent_in_window).toBe(0);

    // 现在又能发了
    const r = await postOutbound(taskId);
    expect(r.status).toBe(200);
    const after2 = getDb()
      .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
      .get(threadId) as { msg_sent_in_window: number };
    expect(after2.msg_sent_in_window).toBe(1);
  });

  it("48h 超窗: msg_sent_in_window 未到 5 但超 48h, 出站仍 skip", async () => {
    // 把 last_inbound_at 改到 49h 前
    const oldTs = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    getDb()
      .prepare(`UPDATE intake_threads SET last_inbound_at = ? WHERE id = ?`)
      .run(oldTs, threadId);

    const res = await postOutbound(taskId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("window/limit");
    expect(body.inWindow).toBe(false);

    // sendKfMessage 不应被调
    expect(sendKfSpy).not.toHaveBeenCalled();

    // 必记 intake_send_skipped, reason = 48h window expired
    const events = getEventsByTaskId(taskId);
    const skipEvts = events.filter((e) => e.type === "intake_send_skipped");
    expect(skipEvts).toHaveLength(1);
    expect(JSON.parse(skipEvts[0].data).reason).toBe("48h window expired");
  });

  it("DB 唯一约束: (channel, external_user_id) 防同甲方重复建线程", async () => {
    // 已经建过 thread 了 (beforeEach), 再调 createIntakeThread 同 (channel, ext) 应抛
    expect(() =>
      createIntakeThread({
        channel: "wecom",
        external_user_id: EXTERNAL_USER,
        task_id: uuidv4(),
        project_id: projectId,
        owner_id: uuidv4(),
      }),
    ).toThrow();

    // getIntakeThreadByExternal 仍只返回 1 条
    const found = getIntakeThreadByExternal("wecom", EXTERNAL_USER);
    expect(found?.id).toBe(threadId);
  });

  it("incrementSentCount 累加正确", () => {
    expect(getDb().prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`).get(threadId)).toMatchObject({ msg_sent_in_window: 0 });
    incrementSentCount(threadId);
    incrementSentCount(threadId);
    incrementSentCount(threadId);
    expect(
      (
        getDb()
          .prepare(`SELECT msg_sent_in_window FROM intake_threads WHERE id = ?`)
          .get(threadId) as { msg_sent_in_window: number }
      ).msg_sent_in_window,
    ).toBe(3);
  });
});