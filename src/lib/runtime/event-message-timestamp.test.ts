// getSessionHistory: DB event message 应把 data.timestamp 透传到顶层 timestamp 字段.
//
// 关注 bug: R155 实测 task 700d5434 「直接触发发送。我看看」消息没时间戳 + 排
//   第一位. 根因 = agent-runtime.ts:2135 把 DB event 转 SessionMessage 时只构造
//   5 个字段, 完全漏了 data.timestamp. 前端 messageTimestamp 拿不到 timestamp,
//   fallback 到 uuidToTimestamp("event-${id}") 又 parseInt 出 NaN → 显示空时间.
//
//   真实影响: UI 把这条消息按"没时间戳 = epoch 0"处理, insertByTimestamp 排序时
//   跑到所有 SDK uuid-v7 时间戳(2026+)前面. 视觉上像"最新消息成首条".
//
// 修法: getSessionHistory 提取 DB event message 时, 把 data.timestamp(ms) 转 ISO
//   透传到顶层 timestamp 字段. 前端 messageTimestamp 第一行 if (m.timestamp) 就
//   能拿到真实时间, 不再走 uuidToTimestamp 兜底.
//
// 关注点:
//   - data.timestamp 是 Date.now() ms number (见 agent-runtime.ts sendUserMessage
//     多处构造的 data JSON). 需 new Date(ms).toISOString() 转 ISO string 与 SDK
//     消息 timestamp 格式对齐.
//   - 兜底链: data.timestamp → event.created_at → Date.now(). 后者保证永远有值,
//     不会让前端 UI 显示空. 优先 data.timestamp 因为这是 sendUserMessage 写入时
//     的真实时刻,比 event.created_at(SQLite datetime('now') 写库时刻)更准.
//   - 类型: SessionMessage 是 SDK 导出类型, 没顶层 timestamp 字段, 用 (m as any)
//     加字段与 tsOf 同风格, frontend messageTimestamp 也用 m.timestamp? 宽松接.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

const getSessionMessagesMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  query: vi.fn(),
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
}));

import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask } from "../db/tasks";
import { insertEvent } from "../db/events";
import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;
let runtime: AgentRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-event-ts-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user");

  projectId = createProject({
    name: "event-ts-test",
    cwd: tmpDir,
    ownerId,
  }).id;

  const scheduler = new TaskScheduler(1);
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) => new Promise<void>(() => {}),
  );
  runtime = new AgentRuntime(scheduler);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getSessionHistory: DB event message 的 timestamp 透传", () => {
  it("data.timestamp 存在 → 顶层 timestamp 字段是 ISO 字符串", async () => {
    const t = createTask({
      title: "ts-test",
      prompt: "p",
      project_id: projectId,
    });
    getDb()
      .prepare(
        `UPDATE tasks SET owner_id = ?, session_id = ?, status = ? WHERE id = ?`,
      )
      .run(ownerId, "sess-ts-test", "running", t.id);

    // 没有 SDK 消息,纯 DB event 路径.
    getSessionMessagesMock.mockResolvedValueOnce([]);

    const sentMs = Date.now() - 60_000; // 1 分钟前 sendUserMessage 写入
    insertEvent({
      task_id: t.id,
      session_id: "sess-ts-test",
      type: "message",
      data: JSON.stringify({
        role: "user",
        text: "直接触发发送。我看看",
        sender_type: "user",
        queued: true,
        timestamp: sentMs,
      }),
    });

    const history = await runtime.getSessionHistory(t.id);
    expect(history).toHaveLength(1);
    const msg = history[0] as any;
    // 关键断言: 顶层 timestamp 字段存在 + 是合法 ISO string.
    expect(msg.timestamp).toBeDefined();
    expect(typeof msg.timestamp).toBe("string");
    const parsed = new Date(msg.timestamp).getTime();
    expect(parsed).toBe(sentMs); // 1ms 精度对得上
    expect(msg.message.content).toBe("直接触发发送。我看看");
  });

  it("data.timestamp 缺失 → 兜底用 event.created_at", async () => {
    // 历史 / 旧事件 / 异常写入路径里 data 可能没 timestamp 字段.
    // 兜底走 events.created_at (SQLite 写入时刻, ISO 字符串).
    const t = createTask({
      title: "ts-fallback",
      prompt: "p",
      project_id: projectId,
    });
    getDb()
      .prepare(
        `UPDATE tasks SET owner_id = ?, session_id = ?, status = ? WHERE id = ?`,
      )
      .run(ownerId, "sess-ts-fallback", "running", t.id);

    getSessionMessagesMock.mockResolvedValueOnce([]);

    insertEvent({
      task_id: t.id,
      session_id: "sess-ts-fallback",
      type: "message",
      data: JSON.stringify({ role: "user", text: "no ts data" }), // ← 没 timestamp
    });

    const history = await runtime.getSessionHistory(t.id);
    const msg = history[0] as any;
    expect(msg.timestamp).toBeDefined();
    // 兜底时间戳应不晚于「现在」(因为 events 刚刚 insert)
    const parsed = new Date(msg.timestamp).getTime();
    expect(parsed).toBeLessThanOrEqual(Date.now());
    expect(parsed).toBeGreaterThan(Date.now() - 60_000); // 60s 内
  });

  it("DB event message 与 SDK message 同数组时,event 透传的 timestamp 让前端拿到正确时间", async () => {
    // 端到端: 模拟 task 700d5434 的真实场景 — SDK 消息 (uuid v7) + 后续通过
    // sendUserMessage 注入的 DB event message. 前端拿到的两条都应该有 ISO
    // timestamp 字段,前端 messageTimestamp 不会 fallback 到 uuidToTimestamp.
    const t = createTask({
      title: "ts-mixed",
      prompt: "p",
      project_id: projectId,
    });
    getDb()
      .prepare(
        `UPDATE tasks SET owner_id = ?, session_id = ?, status = ? WHERE id = ?`,
      )
      .run(ownerId, "sess-ts-mixed", "running", t.id);

    // SDK 第一条 (00:13:57 等价)
    const sdkMs = Date.now() - 600_000;
    const sdkIso = new Date(sdkMs).toISOString();
    getSessionMessagesMock.mockResolvedValueOnce([
      {
        type: "user",
        uuid: uuidv4(), // 真实 uuid v4; SDK 实际给 v7, 测试不关心 tsOf 排序
        session_id: "sess-ts-mixed",
        message: { role: "user", content: "原始 prompt" },
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: sdkIso,
      },
    ]);

    // DB event (07:51 等价,远晚于 SDK 第一条)
    const eventMs = Date.now() - 60_000;
    insertEvent({
      task_id: t.id,
      session_id: "sess-ts-mixed",
      type: "message",
      data: JSON.stringify({
        role: "user",
        text: "直接触发发送。我看看",
        sender_type: "user",
        queued: true,
        timestamp: eventMs,
      }),
    });

    const history = await runtime.getSessionHistory(t.id);
    expect(history).toHaveLength(2);

    // 关键断言: DB event message 顶层 timestamp 是真实 ISO 字符串,前端可读.
    const eventMsg = history.find((m: any) =>
      m.message?.content?.includes("直接触发发送"),
    ) as any;
    expect(eventMsg).toBeDefined();
    expect(eventMsg.timestamp).toBeDefined();
    expect(typeof eventMsg.timestamp).toBe("string");
    const parsed = new Date(eventMsg.timestamp).getTime();
    expect(parsed).toBe(eventMs);
  });
});