/**
 * R182 回归: SDK 在 API 层错误 (429 限流 / 鉴权失败) 时不走 result 的 error
 * subtype, 而是以 model="<synthetic>" 的 assistant 消息 + subtype=success 的
 * result 收尾. 旧版 consumeMessages 只看 subtype=success → 零 token 消耗的报错
 * 任务进 reviewing, 看着"正常待审"实际一个字没跑 (2026-10-04 实测 7 个
 * glm-5.3-flash 周配额 429 任务全中招, 其中 3 个标题还被 auto-rename 的
 * llm-summarize 档改写成「API Error: Request re…」).
 *
 * 解法 (两处):
 *   (1) active-session: assistant 消息 model="<synthetic>" 且文本以 "API Error"
 *       开头 → 打标 syntheticApiErrorText; result 收尾命中标 → 翻 failed 而非
 *       reviewing, error 字段带 api_error: 前缀.
 *   (2) llm-summarize runSingleTurnLlm: success result 的文本以 "API Error"
 *       开头 → 返 null (别把错误文本当标题).
 *
 * 测试覆盖 (本文件 = active-session 侧):
 *   - synthetic API 错误 + success result → failed + error 带 api_error 前缀
 *   - synthetic 错误后跟正常 assistant 轮次 → 标被清, 照常 reviewing (不误伤)
 *   - 非 synthetic 消息文本以 "API Error" 开头 (agent 在讨论 API 错误) → 不触发,
 *     照常 reviewing (不误报)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Mock SDK: query() 返回受脚本控制的 message stream (同 pause-buffered-messages.test.ts).
const h = vi.hoisted(() => ({
  messages: [] as unknown[],
  endResolvers: [] as Array<() => void>,
  closed: false,
  // R175 追加二: 置位时 stream 顶部抛出 (仿真真实 SDK 对 result subtype=error
  //   的行为 —— 不 yield error result 而是直接 throw "Claude Code returned an
  //   error result: ...", consumeMessages 的 for-await 因此 reject).
  throwErr: null as Error | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})),
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
    async function* stream() {
      await prompt.next();
      while (!h.closed) {
        if (h.throwErr) {
          const e = h.throwErr;
          h.throwErr = null;
          throw e;
        }
        if (h.messages.length > 0) {
          const msg = h.messages.shift();
          yield msg;
          // 真实 SDK: result 是最后一条消息, 之后迭代器结束 (consumeMessages 的
          // for-await 因此收尾, start() 的 fallback 重试循环才能继续). mock 必须
          // 同仿真, 否则 consume 卡死、重试路径测不到.
          if ((msg as { type?: string }).type === "result") return;
          continue;
        }
        await new Promise<void>((resolve) => h.endResolvers.push(resolve));
        if (h.closed) return;
      }
    }
    const it = stream();
    (it as unknown as { close: () => void }).close = () => {
      h.closed = true;
      while (h.endResolvers.length > 0) {
        const r = h.endResolvers.shift()!;
        r();
      }
    };
    return it;
  }),
}));

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { AgentRuntime } from "./agent-runtime";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";
import { getEventsByTaskId } from "../db/events";
import { upsertLlmConfig } from "../db/llm-configs";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-synth-err-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "synth-err@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test" });
  projectId = createProject({ name: "synth-err-test", ownerId: userId }).id;

  h.messages = [];
  h.endResolvers = [];
  h.closed = false;
  h.throwErr = null;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunningTask(): Task {
  const task = createTask({
    title: "synthetic-error-test",
    prompt: "test prompt",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  updateTaskStatus(task.id, "running", {
    session_id: `sess-${task.id.slice(0, 8)}`,
    started_at: new Date().toISOString(),
  });
  return getTaskById(task.id)!;
}

function attachSession(runtime: AgentRuntime, task: Task): ActiveSession {
  const session = new ActiveSession(task);
  (runtime as unknown as { sessions: Map<string, ActiveSession> }).sessions.set(task.id, session);
  return session;
}

// R175 追加: 给 session 注入带 fallback 链的 resolvedConfig (绕过 resolveLlmConfig,
//   构造后直接覆盖私有字段 —— 链成员用不同 api_key/base_url 表示跨凭证).
function stubChain(session: ActiveSession) {
  (session as unknown as { resolvedConfig: unknown }).resolvedConfig = {
    api_key: "k1",
    base_url: "https://gw1.example",
    model: "model-a",
    source_config_id: "cfg-1",
    fallback_chain: [
      { config_id: "cfg-1", name: "cfg-1", model: "model-a", base_url: "https://gw1.example", api_key: "k1", same_credentials: true, supports_vision: null },
      { config_id: "cfg-2", name: "cfg-2", model: "model-b", base_url: "https://gw2.example", api_key: "k2", same_credentials: false, supports_vision: null },
    ],
    fallback_models: [],
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// 429 场景的 SDK 消息形态 (取自 2026-10-04 task c6d50986 的 jsonl 实录):
// assistant 消息 model="<synthetic>" + 文本以 "API Error" 开头, 随后 result
// subtype=success (SDK 把 API 层错误当正常完成收尾).
function pushSyntheticApiError(sessionId: string | null | undefined) {
  h.messages.push({
    type: "assistant",
    uuid: "msg-synth-err",
    session_id: sessionId || "sess-x",
    model: "<synthetic>",
    content: [
      {
        type: "text",
        text: "API Error: Request rejected (429) · You have exceeded the weekly usage quota.",
      },
    ],
  });
  h.messages.push({
    type: "result",
    session_id: sessionId || "sess-x",
    subtype: "success",
    total_cost_usd: 0.0001,
    result: "API Error: Request rejected (429) · You have exceeded the weekly usage quota.",
  });
}

describe("R182: synthetic API 错误 (429 等) 不再伪装成成功", () => {
  it("synthetic API 错误 + success result → failed, error 带 api_error 前缀", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    pushSyntheticApiError(task.session_id);

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: API Error: Request rejected \(429\)/);
    // result 字段保留原始错误文本, 详情页一眼看出是配额问题
    expect(after?.result).toContain("weekly usage quota");

    await session.close();
    await startP;
  });

  it("synthetic 错误后跟正常 assistant 轮次 → 标被清, 照常 reviewing (不误伤)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 第一轮: synthetic 429 错误 (但 SDK 不收尾 — 模拟注入续跑场景)
    h.messages.push({
      type: "assistant",
      uuid: "msg-synth-err",
      session_id: task.session_id,
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: Request rejected (429)" }],
    });
    // 第二轮: 正常消息到达, 标应被清
    h.messages.push({
      type: "assistant",
      uuid: "msg-ok",
      session_id: task.session_id,
      model: "glm-5.3-flash",
      content: [{ type: "text", text: "处理完毕, 全部改好。" }],
    });
    h.messages.push({
      type: "result",
      session_id: task.session_id,
      subtype: "success",
      total_cost_usd: 0.01,
      result: "done",
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    await session.close();
    await startP;
  });

  it("R182 追加: 真实 SDK 形状 (model 在 message 里 + error 字段 + Failed to authenticate 前缀) → failed", async () => {
    // 首版翻车点: SDKAssistantMessage = { type:'assistant', message: BetaMessage,
    //   error?: SDKAssistantMessageError } (sdk.d.ts:2854) —— model 在 message.model,
    //   顶层没有. 只读 msg.model = 永远 undefined = 检测空转, 线上 401 任务仍进
    //   reviewing (2026-10-04 14:05 probe 6e7f17f0 实证). 本测锁定真实形状.
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 401 形态 (2026-10-04 13:49 实录): "Failed to authenticate." 前缀
    h.messages.push({
      type: "assistant",
      uuid: "msg-auth-err",
      session_id: task.session_id,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Failed to authenticate. API Error: 401 The API key format is incorrect." }],
      },
      error: "authentication_failed",
    });
    h.messages.push({
      type: "result",
      session_id: task.session_id,
      subtype: "success",
      total_cost_usd: 0.0001,
      result: "Failed to authenticate. API Error: 401 The API key format is incorrect.",
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    let after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: Failed to authenticate/);

    await session.close();
    await startP;

    // 429 形态 + error='rate_limit' + model 只在 message.model (顶层无 model 字段)
    h.messages = [];
    h.closed = false;
    const task2 = makeRunningTask();
    const session2 = attachSession(runtime, task2);
    h.messages.push({
      type: "assistant",
      uuid: "msg-rate-err",
      session_id: task2.session_id,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: Request rejected (429) · weekly usage quota." }],
      },
      error: "rate_limit",
    });
    h.messages.push({
      type: "result",
      session_id: task2.session_id,
      subtype: "success",
      total_cost_usd: 0.0001,
      result: "API Error: Request rejected (429) · weekly usage quota.",
    });

    const startP2 = session2.start(task2).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    after = getTaskById(task2.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("429");

    await session2.close();
    await startP2;
  });

  it("R175 追加: 配了链 + 首个 attempt 撞 synthetic 错误 → 换凭证重跑成功, 不写中间 failed", async () => {
    // damo 2026-10-04 反馈实证 (363f0c90): 假 success 不抛错 → start() 直接 return,
    // fallback 循环永远不触发. 修后应换链上下一凭证重跑且不落中间态 failed
    // (避免 task.failed webhook / R107 父通知双跳).
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    // attempt 1: synthetic 429 + success result (consumeMessages 正常 resolve)
    pushSyntheticApiError(task.session_id);
    // attempt 2 的消息延迟注入 —— 同一个 h.messages 队列, 太早推会被 attempt 1 消费掉;
    // 推完必须 resolve 挂起的 endResolvers (mock 2 此刻正阻塞等待, 不唤醒永远看不到队列)
    const attempt2 = setTimeout(() => {
      h.messages.push({
        type: "assistant",
        uuid: "msg-ok-after-fallback",
        session_id: task.session_id,
        model: "model-b",
        content: [{ type: "text", text: "换凭证后正常完成。" }],
      });
      h.messages.push({
        type: "result",
        session_id: task.session_id,
        subtype: "success",
        total_cost_usd: 0.02,
        result: "done after fallback",
      });
      while (h.endResolvers.length > 0) h.endResolvers.shift()!();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    // 最终态 = reviewing (attempt 2 成功), 不是 failed
    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    // 不允许出现任何 running -> failed 中间态 (双跳防线)
    const events = getEventsByTaskId(task.id);
    const failedTransition = events.find(
      (e) => e.type === "status_change" && JSON.parse(e.data).to === "failed",
    );
    expect(failedTransition).toBeFalsy();

    // llm_fallback 事件留痕 (换凭证发生)
    const fb = events.find((e) => e.type === "llm_fallback");
    expect(fb).toBeTruthy();
    expect(JSON.parse(fb!.data).to_config).toBe("cfg-2");

    await session.close();
  });

  it("R175 追加: 链上全部成员都撞 synthetic 错误 → 链尽后干净落 failed", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    pushSyntheticApiError(task.session_id);
    const attempt2 = setTimeout(() => {
      pushSyntheticApiError(task.session_id); // attempt 2 也 429 (同形态)
      while (h.endResolvers.length > 0) h.endResolvers.shift()!();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: API Error: Request rejected \(429\)/);

    await session.close();
  });

  it("R175 追加二: throw 形态 (result subtype=error → SDK 抛错) + 链 → 换凭证重跑成功", async () => {
    // 本地复现实证 (2026-10-04 task 3c30b466): 起跑 401 走的是 throw 路径而非假
    //   success —— synthetic assistant 消息先到 (带 session_id, 把 sessionId 置上,
    //   旧判据 !this.sessionId 因此永远不成立), 随后 SDK 对 error result 直接
    //   throw "Claude Code returned an error result: ...". 线上 c6d50986 同形态
    //   (resume 任务 + 每 3 分钟 failed→queued 循环, 零 llm_fallback 事件).
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    // attempt 1: synthetic 401 消息 + SDK 抛错
    h.messages.push({
      type: "assistant",
      uuid: "msg-throw-err",
      session_id: task.session_id,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Failed to authenticate. API Error: 401 令牌已过期或验证不正确" }],
      },
      error: "authentication_failed",
    });
    h.throwErr = new Error(
      "Claude Code returned an error result: Failed to authenticate. API Error: 401 令牌已过期或验证不正确",
    );

    // attempt 2: 换凭证后正常完成 (延迟注入 + 唤醒, 同既有模式)
    const attempt2 = setTimeout(() => {
      h.messages.push({
        type: "assistant",
        uuid: "msg-ok-after-throw-fallback",
        session_id: task.session_id,
        model: "model-b",
        content: [{ type: "text", text: "换凭证后正常完成。" }],
      });
      h.messages.push({
        type: "result",
        session_id: task.session_id,
        subtype: "success",
        total_cost_usd: 0.02,
        result: "done after throw fallback",
      });
      while (h.endResolvers.length > 0) h.endResolvers.shift()!();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    // llm_fallback 事件留痕
    const events = getEventsByTaskId(task.id);
    const fb = events.find((e) => e.type === "llm_fallback");
    expect(fb).toBeTruthy();

    // 不允许出现 running -> failed 中间态
    const failedTransition = events.find(
      (e) => e.type === "status_change" && JSON.parse(e.data).to === "failed",
    );
    expect(failedTransition).toBeFalsy();

    await session.close();
  });

  it("R175 追加二: throw 形态链尽 → failed 且 error 带 api_error 前缀", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    h.messages.push({
      type: "assistant",
      uuid: "msg-throw-err",
      session_id: task.session_id,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: Request rejected (429)" }],
      },
      error: "rate_limit",
    });
    h.throwErr = new Error("Claude Code returned an error result: API Error: Request rejected (429)");

    // attempt 2 (最后一个成员) 也撞同款 throw
    const attempt2 = setTimeout(() => {
      h.messages.push({
        type: "assistant",
        uuid: "msg-throw-err-2",
        session_id: task.session_id,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: Request rejected (429)" }],
        },
        error: "rate_limit",
      });
      h.throwErr = new Error("Claude Code returned an error result: API Error: Request rejected (429)");
      while (h.endResolvers.length > 0) h.endResolvers.shift()!();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(
      /^api_error: Claude Code returned an error result: API Error: Request rejected \(429\)/,
    );

    await session.close();
  });

  it("非 synthetic 消息文本以 API Error 开头 (agent 在讨论错误) → 不触发, 照常 reviewing", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // agent 排查 429 问题的任务, 正文以 API Error 开头但 model 是真模型
    h.messages.push({
      type: "assistant",
      uuid: "msg-discuss",
      session_id: task.session_id,
      model: "glm-5.3-flash",
      content: [{ type: "text", text: "API Error: Request rejected (429) 的根因是配额…" }],
    });
    h.messages.push({
      type: "result",
      session_id: task.session_id,
      subtype: "success",
      total_cost_usd: 0.01,
      result: "排查完毕",
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    await session.close();
    await startP;
  });
});
