// R155 sendUserMessage: pending 任务 + session_id + pending_messages 非空 →
//   auto-start 走 queued (消费已排队的 user message). 修复前 pending 状态走不到
//   canAutoStart, 用户再发消息会 throw "任务当前状态为 pending, 请先启动/恢复".
//
// 🆕 damo 2026-10-31「排队中的任务允许发消息」: 真·未启动 (无 session_id) 的
//   pending/queued 任务发消息不再 throw —— 消息缓存进 metadata.pending_messages,
//   任务保持原状态 (不自动拉起, R155 的防误拉起意图保留), 等 start() 真正启动时
//   一次性 drain 投给 AI (见 start-drains-queued-messages.test.ts).
//
// 关注点:
//   - pending + session_id + 非空队列 仍走 auto-start (server_restart 降级态,
//     R155 原行为不变).
//   - queued ± session_id / pending 无 session → 一律缓存不拉起.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, peekPendingMessages } from "../db/tasks";
import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-send-pending-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x");

  projectId = createProject({
    name: "send-pending",
    cwd: tmpDir,
    ownerId,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(): AgentRuntime {
  const runtime = new AgentRuntime();
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) => new Promise<void>(() => {}),
  );
  return runtime;
}

// 强设 task 状态为 pending + session_id + 可选地写入 metadata.pending_messages.
function makePendingTask(
  sessionId: string | null,
  pendingMessages: string[],
): Task {
  const t = createTask({
    title: "pending-task",
    prompt: "p",
    project_id: projectId,
  });
  const db = getDb();
  db.prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(ownerId, t.id);
  db.prepare(`UPDATE tasks SET status = 'pending', session_id = ? WHERE id = ?`).run(
    sessionId,
    t.id,
  );
  if (pendingMessages.length > 0) {
    db.prepare(
      `UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.pending_messages', json(?)) WHERE id = ?`,
    ).run(JSON.stringify(pendingMessages), t.id);
  }
  return getTaskById(t.id)!;
}

describe("sendUserMessage: pending + 已排队消息 (R155)", () => {
  it("pending + session_id + pending_messages 非空 → auto-start queued (不 throw)", () => {
    // 场景: task 700d5434 server_restart 后卡 pending + 上一轮 sendUserMessage
    //  已经把消息排进 metadata.pending_messages. 用户再发一条, 应当:
    //   1. 不 throw "请先启动/恢复任务后再发送消息"
    //   2. 把第二条消息也入 metadata.pending_messages
    //   3. 调 startTask 把 status 推到 queued
    const runtime = makeRuntime();
    const t = makePendingTask("sess-existing", ["上一轮已排队的消息"]);

    // 关键断言: sendUserMessage 不 throw, 且 task 不再卡 pending.
    //   (startTask → queued → schedule() 立即拉到 running, 我们用挂起 runner
    //   所以会停在 running. 关键不在 queued/running 终态, 而在不再 pending.)
    expect(() => runtime.sendUserMessage(t.id, "本轮新增消息", undefined, undefined, "user")).not.toThrow();

    const after = getTaskById(t.id)!;
    expect(after.status).not.toBe("pending");
    expect(["queued", "running"]).toContain(after.status);

    // 验证 metadata.pending_messages 含两条 (原有 + 新增).
    const meta = JSON.parse((after.metadata as string) || "{}");
    expect(meta.pending_messages).toEqual([
      "上一轮已排队的消息",
      "本轮新增消息",
    ]);
  });

  it("pending + session_id + pending_messages 空 → 缓存不自动拉起 (damo 2026-10-31 改)", () => {
    // damo 2026-10-31: 排队中的任务允许发消息 —— 旧 throw 换成入 metadata 队列,
    // 但 R155 的「不自动拉起」意图保留: 消息缓存, 任务仍停在 pending, 等它
    // 被正常启动时由 start() drain 投递.
    const runtime = makeRuntime();
    const t = makePendingTask("sess-existing", []);

    expect(() => runtime.sendUserMessage(t.id, "go", undefined, undefined, "user")).not.toThrow();

    const after = getTaskById(t.id)!;
    expect(after.status).toBe("pending"); // 未被拉起
    expect(peekPendingMessages(t.id)).toEqual(["go"]);
  });

  it("pending + 无 session_id → 缓存不自动拉起 (damo 2026-10-31 改)", () => {
    // 真·新创建任务: session_id 还没分配. 消息缓存进 metadata, 任务保持 pending
    // (等手动启动 / cron 触发), 不因发消息被拉起.
    const runtime = makeRuntime();
    const t = makePendingTask(null, []);

    expect(() => runtime.sendUserMessage(t.id, "go", undefined, undefined, "user")).not.toThrow();

    const after = getTaskById(t.id)!;
    expect(after.status).toBe("pending");
    expect(peekPendingMessages(t.id)).toEqual(["go"]);
  });

  it("queued + 无 session_id → 缓存, 启动时由 start() 投递 (damo 2026-10-31 新增)", () => {
    // 排队等槽位的任务: 用户先补一条指令, 消息进缓存, 任务保持 queued 等调度.
    const runtime = makeRuntime();
    const t = makePendingTask(null, []);
    getDb().prepare(`UPDATE tasks SET status = 'queued' WHERE id = ?`).run(t.id);

    expect(() => runtime.sendUserMessage(t.id, "补充指令", undefined, undefined, "user")).not.toThrow();

    const after = getTaskById(t.id)!;
    expect(after.status).toBe("queued"); // 未被推走, 等调度器拉起
    expect(peekPendingMessages(t.id)).toEqual(["补充指令"]);

    // transcript 落了一条 queued 标记的 user message 事件 (UI 显示 ⏳ 已排队)
    const row = getDb()
      .prepare(`SELECT data FROM events WHERE task_id = ? AND type = 'message' ORDER BY created_at DESC LIMIT 1`)
      .get(t.id) as { data: string };
    const ev = JSON.parse(row.data);
    expect(ev.queued).toBe(true);
    expect(ev.text).toBe("补充指令");
  });
});