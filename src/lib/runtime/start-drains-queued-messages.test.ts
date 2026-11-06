/**
 * damo 2026-10-31「排队中的任务允许发消息」的 start() 侧保证.
 *
 * 任务在 pending/queued (从未启动) 期间收到的用户消息被 sendUserMessage 缓存进
 * metadata.pending_messages (见 send-user-message-pending.test.ts). start() 负责
 * 在真正启动时把它们一次性投给 AI —— 复用 resume() 的同一份契约:
 *
 *   S1 顺序: task.prompt 在前 (先答原始指令), 攒下的消息逐条跟在后面;
 *   S2 消费即销毁: drain 在 query 启动前执行 (resume-contract.md §2 红线 ——
 *      中途崩了宁可丢一次投递, 也不要留着无限重放);
 *   S3 没有缓存消息的全新任务零变化 (空 drain 是 no-op, 不写库).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const PENDING = Symbol("pending");

// SDK mock: 把平台交给 query() 的 user turn 全部抓下来(抓到阻塞就停, 因为
// generator 投完排队的消息后会 await 下一条用户输入).
const h = vi.hoisted(() => ({
  turns: [] as string[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})), // media MCP (start 路径) — mock 缺这个 export 会全红
  query: vi.fn(({ prompt }: { prompt: unknown }) => {
    const gen = prompt as AsyncGenerator<{ message: { content: string } }>;
    async function* stream() {
      for (;;) {
        const next = await Promise.race([
          gen.next(),
          new Promise((r) => setTimeout(() => r(PENDING), 10)),
        ]);
        if (next === PENDING) break; // generator 在等新用户消息 = 排队的都投完了
        const step = next as IteratorResult<{ message: { content: string } }>;
        if (step.done) break;
        h.turns.push(String(step.value.message.content));
      }
      // 流自然结束 (同 resume-replay-guard.test.ts 的 h.reply 空数组形态),
      // 让 start() 的 query await 收尾.
    }
    return stream();
  }),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));
vi.mock("./schedule-runner", () => ({
  stopScheduleRunner: vi.fn(),
  startScheduleRunner: vi.fn(),
}));

import { ActiveSession } from "./active-session";
import type { TaskStatus } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import {
  createTask,
  getTaskById,
  updateTask,
  queuePendingMessage,
  peekPendingMessages,
} from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-start-drain-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "start-drain@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "start-drain-test", ownerId: userId }).id;

  h.turns = [];
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 一个「从未启动」的任务: 无 session_id, prompt 覆写成裸串 (createTask 会加
// preflight 前言, 而本文件断言的是投递顺序, 前言只会让断言难读).
function seedTask(prompt: string, status: TaskStatus = "queued"): string {
  const task = createTask({ title: "start-drain", prompt, project_id: projectId, cwd: tmpDir });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  updateTask(task.id, { prompt, status });
  return task.id;
}

const startOnce = async (taskId: string) => {
  const task = getTaskById(taskId)!;
  await new ActiveSession(task).start(task);
};

const meta = (taskId: string) => JSON.parse(getTaskById(taskId)!.metadata || "{}");

describe("start() 投递排队期缓存的消息", () => {
  // start() 会往首 turn 拼 head (R222 用户身份等 reminder), 首条断言用
  // endsWith 而非全等; 缓存消息 turn 是裸串, 全等.
  it("S1: prompt 在前, 缓存消息按到达顺序逐条跟后", async () => {
    const id = seedTask("原始任务指令");
    queuePendingMessage(id, "排队时补的第一条");
    queuePendingMessage(id, "排队时补的第二条");

    await startOnce(id);

    expect(h.turns.length).toBe(3);
    expect(h.turns[0].endsWith("原始任务指令")).toBe(true);
    expect(h.turns.slice(1)).toEqual([
      "排队时补的第一条",
      "排队时补的第二条",
    ]);
  });

  it("S2: 消费即销毁 —— 启动后 pending_messages 清空, 不会在下次 resume 重放", async () => {
    const id = seedTask("原始任务指令");
    queuePendingMessage(id, "只投一次的消息");

    await startOnce(id);

    expect(peekPendingMessages(id)).toEqual([]);
    expect(meta(id).pending_messages).toBeUndefined();
    expect(h.turns.length).toBe(2);
    expect(h.turns[0].endsWith("原始任务指令")).toBe(true);
    expect(h.turns[1]).toBe("只投一次的消息");
  });

  it("S3: 没有缓存消息的全新任务零变化 (turns 只有 prompt)", async () => {
    const id = seedTask("原始任务指令");

    await startOnce(id);

    expect(h.turns.length).toBe(1);
    expect(h.turns[0].endsWith("原始任务指令")).toBe(true);
    expect(meta(id).pending_messages).toBeUndefined();
  });
});
