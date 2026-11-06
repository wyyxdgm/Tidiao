/**
 * resume 的「有话可说」保证.
 *
 * 复现 2026-08-11 task 9b812564: 用户在 reviewing 后发了一条指令 -> 平台投给模型
 * (pending_messages 当场排空) -> 19s 后 pause, 模型一个字都还没回 -> 恢复时
 * initialPrompt 与 preMessages 双空, generator 一条不 yield -> agent 干等 5min
 * 零 event, 那条指令实际丢了(transcript 里它带着 [Request interrupted by user],
 * 模型只会读成「用户叫我别做了」).
 *
 * 两层断言:
 *   L1 resume 双空时补一条「继续」, 不再零 turn 空转;
 *   L2 pause 时把「投出去但模型零输出」的指令回填 pending_messages, 下次原样补投;
 *      模型已经开口的不回填(否则 resume 会让 agent 重做已做的活).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: 把平台交给 query() 的 user turn 依次抓下来, 再按脚本回吐消息.
const h = vi.hoisted(() => ({
  turns: [] as string[], // 平台投给模型的用户消息
  reply: [] as unknown[], // 模型这一轮回吐的消息(空 = 一个字都没回)
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})), // media MCP (start 路径) — mock 缺这个 export 会全红, 2026-10-03 补
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => {
    async function* stream() {
      const first = await prompt.next();
      if (!first.done) h.turns.push(String(first.value.message.content));
      for (const msg of h.reply) yield msg;
      // 不再向 generator 要输入: 模型「收工」, resume() 随之返回
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
import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler } from "./task-scheduler";
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
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-resume-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "resume-test@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "resume-test", ownerId: userId }).id;

  h.turns = [];
  h.reply = [];
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 一个「已经跑过、有 session_id、现在 paused」的任务 —— resume 的前提
function pausedTask(): Task {
  const task = createTask({
    title: "resume-continuation",
    prompt: "原始 prompt",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  updateTask(task.id, { session_id: "sess-resume-1" });
  return getTaskById(task.id)!;
}

const assistantTurn = () => [
  { type: "assistant", uuid: "u-1", session_id: "sess-resume-1", message: { content: [] } },
  {
    type: "stream_event",
    session_id: "sess-resume-1",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "在做了" } },
  },
];

describe("L1 resume 至少有一个 turn 可做", () => {
  it("无待发消息时补一条「继续」, 而不是零 yield 空转", async () => {
    const task = pausedTask();

    await new ActiveSession(task).resume(task);

    expect(h.turns).toEqual(["继续"]);
  });

  it("有待发留言时投递留言本身, 不补「继续」", async () => {
    const task = pausedTask();
    queuePendingMessage(task.id, "按方案 B 改");

    await new ActiveSession(task).resume(getTaskById(task.id)!);

    expect(h.turns).toEqual(["按方案 B 改"]);
    expect(peekPendingMessages(task.id)).toEqual([]); // resume 已排空
  });
});

describe("L2 被打断且模型零输出的消息不丢", () => {
  it("模型一个字都没回 -> 该消息标为未响应, 可被取回补投", async () => {
    const task = pausedTask();
    queuePendingMessage(task.id, "派个任务给他, 你只管验收");
    const session = new ActiveSession(task);

    h.reply = []; // 模型零输出(等价于投出去就被 interrupt)
    await session.resume(getTaskById(task.id)!);

    expect(session.takeUnansweredUserTurn()).toBe("派个任务给他, 你只管验收");
    expect(session.takeUnansweredUserTurn()).toBeNull(); // 一次性, 不会回填两次
  });

  it("模型已经开口 -> 不算未响应, 不重发(避免重做已做的活)", async () => {
    const task = pausedTask();
    queuePendingMessage(task.id, "派个任务给他, 你只管验收");
    const session = new ActiveSession(task);

    h.reply = assistantTurn();
    await session.resume(getTaskById(task.id)!);

    expect(session.takeUnansweredUserTurn()).toBeNull();
  });

  it("pauseTask 把未响应的消息回填进 pending_messages", async () => {
    const runtime = new AgentRuntime();
    const scheduler = (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
    // runner 挂住不返回, 任务停在 running 直到测试结束（同 maintenance.test 的做法）
    scheduler.setRunner(() => new Promise<void>(() => {}));

    const task = createTask({
      title: "pause-refill",
      prompt: "p",
      project_id: projectId,
      cwd: tmpDir,
    });
    runtime.startTask(task.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(getTaskById(task.id)?.status).toBe("running");

    (runtime as unknown as { sessions: Map<string, unknown> }).sessions.set(task.id, {
      interrupt: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      getSessionId: () => "sess-resume-1",
      // pause 时会读它把被打断的花费落库; 这条只测回填, 给零 token 的估算形态。
      getCostUsd: () => 0,
      getTokenUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      getCostSnapshot: () => ({ cost: 0.0001, source: "estimated" as const }),
      takeUnansweredUserTurn: () => "刚发出去还没被回答的指令",
      markExternallyTerminated: () => {},
      get isClosed() {
        return false;
      },
    });

    await runtime.pauseTask(task.id);

    expect(getTaskById(task.id)?.status).toBe("paused");
    expect(peekPendingMessages(task.id)).toEqual(["刚发出去还没被回答的指令"]);
  });
});
