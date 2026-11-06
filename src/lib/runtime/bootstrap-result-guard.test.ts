/**
 * resume bootstrap 空转伪 result 守卫 (task cee8c410, 2026-11-05 实证).
 *
 * 场景: resume 注入消息到达 CLI 时若初始化未完成, CLI 先回一条 synthetic
 * "No response requested." 伪轮 (num_turns=0) + success result, 紧接着才把
 * 排队真消息作为新一轮跑. 旧代码把伪 result 当正常收尾 → 写 reviewing +
 * closed=true → 真轮在 query teardown 中途跑 → 工具调用被 CLI abort canned
 * 文本拒绝 → 弱模型读成「用户叫停」→「收到，我停下」+ end_turn.
 *
 * 验证 active-session.ts result 分支新增的 num_turns===0 吞掉守卫:
 *   - 伪 result 被吞 (warning bootstrap_result_swallowed), 不写 reviewing 不关 session
 *   - 同流后面的真 result 正常收尾, task.result 用真文本
 *   - num_turns 缺失 (>0/undefined) 不吞, 正常关闭 (保守口径)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: 与 background-agent-lifecycle.test.ts 同款 — query() 返回可迭代对象.
// 单批次流: [synthetic assistant, 伪 result(num_turns=0), 真 assistant, 真 result].
// 旧代码在伪 result 处 closed=true → generator 结束 → prompt.next() done → break,
// 真 assistant/result 根本不会被消费 (断言 task.result 为空 = 复现 bug).
// 新代码在伪 result 处 continue → 继续消费同批次后续消息 → 真 result 正常收尾.
const h = vi.hoisted(() => ({
  batches: [] as unknown[][],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})),
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => {
    async function* stream() {
      await prompt.next();
      for (const batch of h.batches) {
        for (const msg of batch) yield msg;
        const next = await prompt.next();
        if (next.done) break;
      }
    }
    const iter = stream();
    (iter as any).stopTask = vi.fn(async () => {});
    (iter as any).backgroundTasks = vi.fn(async () => true);
    return iter;
  }),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import { getEventsByTaskId } from "../db/events";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bootstrap-result-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "bootstrap-result-test@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "bootstrap-result-test", ownerId: userId }).id;

  h.batches = [];
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(): Task {
  const task = createTask({
    title: "bootstrap-result-guard",
    prompt: "继续上次的工作",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

// synthetic 伪轮 assistant 消息 (CLI resume bootstrap 时本地生成, 非模型 API 产出)
function syntheticAssistant(): unknown {
  return {
    type: "assistant",
    uuid: uuidv4(),
    session_id: "sess-1",
    message: {
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "No response requested." }],
    },
  };
}

describe("resume bootstrap 伪 result (num_turns=0) 吞掉守卫", () => {
  it("伪 result 被吞: 不提前关闭, 同流真 result 正常收尾写 reviewing", async () => {
    const task = makeTask();
    h.batches = [
      [
        syntheticAssistant(),
        // 伪 result: 零 API 轮, 空文本 (旧代码在这里 closed=true 提前收尾)
        { type: "result", subtype: "success", num_turns: 0, session_id: "sess-1", total_cost_usd: 0, result: "" },
        // 真轮: 模型实际处理注入消息后的产出 + 真 result
        {
          type: "assistant",
          uuid: uuidv4(),
          session_id: "sess-1",
          message: { model: "glm-5.3-flash", stop_reason: "end_turn", content: [{ type: "text", text: "干完了" }] },
        },
        { type: "result", subtype: "success", num_turns: 1, session_id: "sess-1", total_cost_usd: 0.5, result: "final-真结果" },
      ],
    ];

    await new ActiveSession(task).start(task);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");
    // 真 result 的文本落库 (旧代码会在这里落空串/null = bug 复现点)
    expect(after?.result).toBe("final-真结果");
    // 守卫留痕
    const warnings = getEventsByTaskId(task.id).filter((e) => e.type === "warning");
    const swallowed = warnings.find((e) => e.data.includes("bootstrap_result_swallowed"));
    expect(swallowed).toBeTruthy();
  });

  it("num_turns 缺失不吞: 走正常关闭 (保守口径)", async () => {
    const task = makeTask();
    h.batches = [
      [
        {
          type: "assistant",
          uuid: uuidv4(),
          session_id: "sess-1",
          message: { model: "glm-5.3-flash", stop_reason: "end_turn", content: [{ type: "text", text: "完成" }] },
        },
        // 老 SDK result 可能没有 num_turns 字段 — 不得误吞
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.4, result: "ok-正常收尾" },
      ],
    ];

    await new ActiveSession(task).start(task);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");
    expect(after?.result).toBe("ok-正常收尾");
    const warnings = getEventsByTaskId(task.id).filter((e) => e.type === "warning");
    expect(warnings.find((e) => e.data.includes("bootstrap_result_swallowed"))).toBeFalsy();
  });
});
