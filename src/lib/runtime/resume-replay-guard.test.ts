/**
 * resume 的「一次性消息只投一次」保证.
 *
 * 复现 2026-08-12 task 5d6efbf3: 用户给一个 reviewing 的 fork 任务发新消息, 平台
 * 却把 fork 的原始 task.prompt 重投了一遍, 而且排在新消息「前面」-> 模型先答旧的,
 * 表现为「新消息发不进去、旧消息一直重复」(实测重放 3 次, agent 自己都在说
 * 「第三次说了」). 同一段代码里另有两个同类缺陷, 一起锁住:
 *
 *   L1 fork 的 initialPrompt 只在首次 resume 投递, 之后一律不再重投;
 *      判据是 fork_prompt_sent(投过没有), 不是 reject_count(被驳回没有) ——
 *      parent_session_id 是永久标记, 用「有没有被驳回」挡不住给终态发消息这条路.
 *   L2 reject_reason 消费完即从 metadata 销掉; 否则它会在之后每次 resume 被追加到
 *      用户新消息「后面」= 成为最后一个 user turn, 模型优先答这条旧反馈.
 *      (includes 守卫挡不住: 入队的是裸 feedback, 追加的带 [驳回反馈] 前缀.)
 *   L3 compact 阶段清理 compact_first 时必须重新读库, 不能写回进 resume() 时的
 *      metadata 快照 —— 那会把 drainPendingMessages 刚排空的 pending_messages
 *      复活, 接着被 maybeDrainStrandedMessages 当成「还有留言」再投一遍.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const PENDING = Symbol("pending");

// SDK mock: 把平台交给 query() 的 user turn 全部抓下来(抓到阻塞就停, 因为
// generator 投完排队的消息后会 await 下一条用户输入), 再按脚本回吐消息.
const h = vi.hoisted(() => ({
  turns: [] as string[],
  reply: [] as unknown[],
  compactCalls: 0,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})), // media MCP (start 路径) — mock 缺这个 export 会全红, 2026-10-03 补
  query: vi.fn(({ prompt }: { prompt: unknown }) => {
    // /compact 阶段: prompt 是 string(斜杠命令), 不是 generator
    if (typeof prompt === "string") {
      h.compactCalls++;
      async function* compactStream() {
        yield { type: "result", subtype: "success", session_id: "sess-replay-1" } as unknown;
      }
      return compactStream();
    }
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
      for (const msg of h.reply) yield msg;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-replay-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "replay-test@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "replay-test", ownerId: userId }).id;

  h.turns = [];
  h.reply = [];
  h.compactCalls = 0;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 一个「已跑过、有 session_id」的任务, metadata 由各用例注入.
// prompt 覆写成裸串: createTask 会加 preflight 前言, 而本文件断言的是「这条 prompt
// 有没有被重投」, 前言只会让断言难读.
function seedTask(prompt: string, meta: Record<string, unknown>): string {
  const task = createTask({ title: "replay-guard", prompt, project_id: projectId, cwd: tmpDir });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  updateTask(task.id, {
    prompt,
    session_id: "sess-replay-1",
    metadata: JSON.stringify(meta),
  });
  return task.id;
}

const resumeOnce = async (taskId: string) => {
  const task = getTaskById(taskId)!;
  await new ActiveSession(task).resume(task);
};

const meta = (taskId: string) => JSON.parse(getTaskById(taskId)!.metadata || "{}");

describe("L1 fork 的 initialPrompt 只投一次", () => {
  it("首次 resume 投 task.prompt, 并打上 fork_prompt_sent", async () => {
    const id = seedTask("原始 fork prompt", { parent_session_id: "sess-parent" });

    await resumeOnce(id);

    expect(h.turns).toEqual(["原始 fork prompt"]);
    expect(meta(id).fork_prompt_sent).toBe(true);
  });

  it("再次 resume 时只投用户新消息, 不重放 task.prompt", async () => {
    const id = seedTask("原始 fork prompt", { parent_session_id: "sess-parent" });
    await resumeOnce(id);

    h.turns = [];
    queuePendingMessage(id, "我说的是另一件事");
    await resumeOnce(id);

    expect(h.turns).toEqual(["我说的是另一件事"]);
  });

  it("从未被驳回的 fork 任务也挡得住 —— 判据不是 reject_count", async () => {
    const id = seedTask("原始 fork prompt", { parent_session_id: "sess-parent" });
    await resumeOnce(id);
    expect(meta(id).reject_count).toBeUndefined(); // 没驳回过, 旧判据在这里失效

    h.turns = [];
    queuePendingMessage(id, "第二条");
    await resumeOnce(id);
    h.turns = [];
    queuePendingMessage(id, "第三条");
    await resumeOnce(id);

    expect(h.turns).toEqual(["第三条"]);
  });

  it("parent_session_id 保留下来(fork 血缘不能靠删它来止重放)", async () => {
    const id = seedTask("原始 fork prompt", { parent_session_id: "sess-parent" });
    await resumeOnce(id);

    expect(meta(id).parent_session_id).toBe("sess-parent");
  });
});

describe("L2 reject_reason 消费后即销毁", () => {
  it("驳回后紧接的 resume 投一次反馈, 且不重复投", async () => {
    const id = seedTask("p", { reject_reason: "重做验收部分", reject_count: 1 });
    queuePendingMessage(id, "重做验收部分"); // rejectTask 入队的是裸 feedback

    await resumeOnce(id);

    expect(h.turns).toEqual(["重做验收部分"]); // 没有额外的 [驳回反馈] 副本
    expect(meta(id).reject_reason).toBeUndefined();
  });

  it("之后的 resume 不再把旧反馈追加到用户新消息后面", async () => {
    const id = seedTask("p", { reject_reason: "重做验收部分", reject_count: 1 });
    queuePendingMessage(id, "重做验收部分");
    await resumeOnce(id);

    h.turns = [];
    queuePendingMessage(id, "先别管验收, 看下这个报错");
    await resumeOnce(id);

    expect(h.turns).toEqual(["先别管验收, 看下这个报错"]);
    expect(h.turns.join()).not.toContain("驳回反馈");
  });

  it("反馈没进队列时仍走 fallback 投递一次(不能因销毁而丢)", async () => {
    const id = seedTask("p", { reject_reason: "补一个回归测试", reject_count: 1 });

    await resumeOnce(id);

    expect(h.turns).toEqual(["[驳回反馈] 补一个回归测试"]);
    expect(meta(id).reject_reason).toBeUndefined();
  });
});

describe("L3 compact 清理不复活已排空的留言", () => {
  it("compact fork resume 后 pending_messages 保持空", async () => {
    const id = seedTask("fork 续接 prompt", {
      parent_session_id: "sess-parent",
      compact_first: true,
    });
    queuePendingMessage(id, "顺手把这个也改了");

    await resumeOnce(id);

    expect(h.compactCalls).toBe(1); // 确实走了 compact 分支(否则这条用例没测到东西)
    expect(peekPendingMessages(id)).toEqual([]);
    expect(meta(id).compact_first).toBeUndefined();
    expect(meta(id).fork_prompt_sent).toBe(true);
  });
});
