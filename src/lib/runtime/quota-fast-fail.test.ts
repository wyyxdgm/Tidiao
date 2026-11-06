/**
 * R227 (damo 2026-10-09 拍板「429 允许重试 5 次, 没额度的跳过」, 修订 R212 口径)
 * + R212 (damo 2026-10-07 拍板「同一个凭证不重试」, task 6af660e4 实证):
 * SDK 对 429/配额类 API 错误默认对同一凭证退避重试 10 次耗时 ~3min (session
 * jsonl 10 条 subtype=api_error 行) 才以 synthetic 消息收尾, 期间任务干等.
 *
 * R227 分档 (active-session):
 *   - rate_limit (HTTP 429 / rate_limit 枚举, 文本无额度耗尽关键词): 瞬时限流,
 *     放行 SDK 退避重试最多 5 次 (计数 api_retry/api_error 信号条数), 第 6 条
 *     信号才 close 快速失败.
 *   - quota_exhausted (AccountQuotaExceeded / usage quota 关键词, 兜住 ark 月
 *     配额 429 实录 6af660e4: 状态码 429 但额度已耗尽, 重试无用): 首次命中即
 *     close query 快速失败, start() 零进度且有链 → 换凭证重跑, 链尽 / 已有进度
 *     → failed(api_error:...); resume() 无链循环直接落 failed.
 *
 * 测试覆盖 (本文件):
 *   - api_retry 429 前 5 条 → 放行不 close (R227)
 *   - api_retry 429 第 6 条 → close 快速失败, failed(api_error:) (R227)
 *   - api_error transcript 形态 (error.status=429 + 月配额 formatted) → 归
 *     quota_exhausted, 首条即 close (R212 不回归)
 *   - api_retry 非配额 (5xx) 不快速失败, 照常跑完 → reviewing (不回归)
 *   - 配了链 + 零进度 429×6 → 换凭证重跑成功 (llm_fallback 留痕, 无中间 failed)
 *   - 配了链 + 两次 attempt 都 429×6 → 链尽 failed(api_error:)
 *   - 已有进度后中途 429×6 → 不重跑 (进度丢失不可接受), 直接 failed
 *   - error-only turn: synthetic 错误 + 空壳 real 消息 + success → failed (不清标)
 *   - synthetic 错误 + 流式 tool_use + success → reviewing (tool_use 算实质产出)
 *   - resume 路径 429×6 → failed(api_error:) (6af660e4 实录场景)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Mock SDK: query() 返回受脚本控制的 message stream (同 synthetic-api-error.test.ts,
// 但 closed / resolvers 按 query 实例隔离 —— R212 快速失败会在 attempt 中途 close,
// 换凭证重跑的 attempt 2 必须拿到全新活流, 共享 closed 标会让它胎死腹中).
const h = vi.hoisted(() => ({
  messages: [] as unknown[],
  closeCount: 0,
  // 每个 query 实例的 endResolvers 登记在这里, 测试注入消息后统一 flush
  // (R212 快速失败在 attempt 中途 close, 换凭证重跑的 attempt 2 是全新流).
  allResolvers: [] as Array<Array<() => void>>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})),
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
    let closed = false;
    const resolvers: Array<() => void> = [];
    h.allResolvers.push(resolvers);
    async function* stream() {
      await prompt.next();
      while (!closed) {
        if (h.messages.length > 0) {
          const msg = h.messages.shift();
          yield msg;
          if ((msg as { type?: string }).type === "result") return;
          continue;
        }
        await new Promise<void>((resolve) => resolvers.push(resolve));
        if (closed) return;
      }
    }
    const it = stream();
    (it as unknown as { close: () => void }).close = () => {
      closed = true;
      while (resolvers.length > 0) resolvers.shift()!();
      h.closeCount++;
    };
    return it;
  }),
}));

// 唤醒所有在等消息的 stream 实例 (attempt 2 注入后必须 flush, 否则流看不到队列).
function flushAllStreams() {
  for (const rs of h.allResolvers) {
    while (rs.length > 0) rs.shift()!();
  }
}

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-quota-ff-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "quota-ff@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test" });
  projectId = createProject({ name: "quota-ff-test", ownerId: userId }).id;

  h.messages = [];
  h.closeCount = 0;
  h.allResolvers = [];
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunningTask(): Task {
  const task = createTask({
    title: "quota-fast-fail-test",
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

// 同 synthetic-api-error.test.ts: 给 session 注入带 fallback 链的 resolvedConfig.
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

// api_retry 形态 (SDK 官方重试通知, sdk.d.ts SDKAPIRetryMessage): error_status
// 带数字 + error 为枚举串. 6af660e4 实录里 jsonl 是 api_error 行, 但 JS 流收到的
// 官方形态是 api_retry.
function pushApiRetry(status: number, enumErr: string) {
  h.messages.push({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 513,
    error_status: status,
    error: enumErr,
    uuid: `retry-${Math.random()}`,
    session_id: "sess-x",
  });
}

// api_error 形态 (transcript 重试行被 CLI 转发): error 为对象, 带formatted 文本.
function pushApiErrorTranscript(status: number, formatted: string) {
  h.messages.push({
    type: "system",
    subtype: "api_error",
    level: "error",
    error: { status, formatted, message: `${status} ${formatted}` },
    retryInMs: 513,
    retryAttempt: 1,
    maxRetries: 10,
    source: "request_retry",
  });
}

// R227: 限流重试放行 5 次, 连推 n 条 429 信号 (api_retry 形态) 模拟 SDK 连续退避.
function pushRateLimitBurst(n: number) {
  for (let i = 0; i < n; i++) pushApiRetry(429, "rate_limit");
}

describe("R227: 429 允许重试 5 次, 没额度的跳过 (修订 R212)", () => {
  it("api_retry 429 前 5 条 → 放行不 close (SDK 继续退避)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    pushRateLimitBurst(5);

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    expect(h.closeCount).toBe(0); // 5 次以内不放弃
    const after = getTaskById(task.id);
    expect(after?.status).toBe("running"); // 还在跑, 没被快速失败打死

    const events = getEventsByTaskId(task.id);
    expect(events.find((e) => e.type === "api_error_quota_fast_fail")).toBeFalsy();
    expect(events.filter((e) => e.type === "api_error_rate_limit_retry")).toHaveLength(5);

    await session.close();
    await startP;
  });

  it("api_retry 429 第 6 条 → close query 快速失败, failed 且 error 带 api_error: 前缀", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 只推 api_retry 信号, 不推 result —— 快速失败不该等 SDK 重试耗尽.
    pushRateLimitBurst(6);

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    expect(h.closeCount).toBe(1); // query 被 close, 不是等流自然结束

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: /);
    expect(after?.error).toContain("429");

    // 快速失败留痕 (巡检/排查用)
    const events = getEventsByTaskId(task.id);
    const ff = events.find((e) => e.type === "api_error_quota_fast_fail");
    expect(ff).toBeTruthy();
    expect(JSON.parse(ff!.data).rate_limit_retries).toBe(5);

    await session.close();
    await startP;
  });

  it("api_error transcript 形态 (formatted 月配额文本, status=429) → 归 quota_exhausted 首条即 close, result 保留原始文本", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    pushApiErrorTranscript(
      429,
      "429 You have exceeded the monthly usage quota. It will reset at 2026-10-14 23:59:59 +0800 CST.",
    );

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    expect(h.closeCount).toBe(1); // 额度耗尽不重试, 首条即 close (6af660e4 场景)
    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: 429 You have exceeded the monthly usage quota/);
    expect(after?.result).toContain("monthly usage quota");

    await session.close();
    await startP;
  });

  it("api_retry 5xx (非配额) 不快速失败 → 后续正常消息照常 reviewing (不回归)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    pushApiRetry(500, "server_error");
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

    expect(h.closeCount).toBe(0); // 没有快速失败
    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    const events = getEventsByTaskId(task.id);
    expect(events.find((e) => e.type === "api_error_quota_fast_fail")).toBeFalsy();

    await session.close();
    await startP;
  });

  it("配了链 + 零进度 429×6 → 换凭证重跑成功, llm_fallback 留痕且无中间 failed", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    pushRateLimitBurst(6);
    // attempt 2 延迟注入 (换凭证后的活流), 同既有模式
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
      flushAllStreams();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");

    const events = getEventsByTaskId(task.id);
    const fb = events.find((e) => e.type === "llm_fallback");
    expect(fb).toBeTruthy();
    expect(JSON.parse(fb!.data).to_config).toBe("cfg-2");
    expect(JSON.parse(fb!.data).reason).toContain("429");

    // 不允许 running -> failed 中间态 (R175 双跳防线)
    const failedTransition = events.find(
      (e) => e.type === "status_change" && JSON.parse(e.data).to === "failed",
    );
    expect(failedTransition).toBeFalsy();

    await session.close();
  });

  it("配了链 + 两次 attempt 都 429×6 → 链尽后 failed(api_error:)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    pushRateLimitBurst(6);
    const attempt2 = setTimeout(() => {
      pushRateLimitBurst(6);
      flushAllStreams();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: /);

    await session.close();
  });

  it("已有进度后中途 429×6 → 不重跑 (进度丢失不可接受), 直接 failed(api_error:)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    // 模型先说了一轮真话 (attempt 已有进度), 然后中途撞限流且重试耗尽
    h.messages.push({
      type: "assistant",
      uuid: "msg-progress",
      session_id: task.session_id,
      model: "model-a",
      content: [{ type: "text", text: "已改完一半..." }],
    });
    pushRateLimitBurst(6);

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: /);

    // 有进度不换链: 不该出现 llm_fallback
    const events = getEventsByTaskId(task.id);
    expect(events.find((e) => e.type === "llm_fallback")).toBeFalsy();

    await session.close();
    await startP;
  });

  it("canned no-op 应答 (No response requested.) + 429×6 → 不算进度, 仍换链重跑 (218c47dc 实录)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);
    stubChain(session);

    // resume/queue 注入轮的 no-op 应答: 非空文本但零信息. 修复前它置
    //   attemptHadModelOutput = true → 后续 429 被判「已有进度」不换链,
    //   任务直接 failed (2026-10-07 taoke 218c47dc 17:16 resume 实录).
    h.messages.push({
      type: "assistant",
      uuid: "msg-noop",
      session_id: task.session_id,
      model: "model-a",
      content: [{ type: "text", text: "No response requested." }],
    });
    pushRateLimitBurst(6);

    // 换链后的 attempt 2 正常完成
    const attempt2 = setTimeout(() => {
      h.messages.push({
        type: "assistant",
        uuid: "msg-ok-after-noop-fallback",
        session_id: task.session_id,
        model: "model-b",
        content: [{ type: "text", text: "换凭证后正常回答。" }],
      });
      h.messages.push({
        type: "result",
        session_id: task.session_id,
        subtype: "success",
        total_cost_usd: 0.01,
        result: "answered after fallback",
      });
      flushAllStreams();
    }, 400);

    const startP = session.start(task).catch(() => {});
    await startP;
    clearTimeout(attempt2);

    // no-op 不算进度 → 正常换链, 任务不被 429 打死
    const after = getTaskById(task.id);
    expect(after?.status).toBe("reviewing");
    const events = getEventsByTaskId(task.id);
    expect(events.find((e) => e.type === "llm_fallback")).toBeTruthy();

    await session.close();
  });
});

describe("R212: error-only turn 判 failed 不判 reviewing", () => {
  it("synthetic 错误 + 空壳 real 消息 (零 content) + success → failed (空壳不清标)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    // 第一轮: synthetic 429 错误
    h.messages.push({
      type: "assistant",
      uuid: "msg-synth-err",
      session_id: task.session_id,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: Request rejected (429) · monthly quota." }],
      },
      error: "rate_limit",
    });
    // 空壳 finalized 消息 (includePartialMessages 常见): 真文本走 stream_event,
    // finalized 恒空. 旧版 !synth 即清标 → 零产出 turn 被洗成 reviewing.
    h.messages.push({
      type: "assistant",
      uuid: "msg-empty-shell",
      session_id: task.session_id,
      message: { role: "assistant", model: "glm-5.3-flash", content: [] },
      content: [],
    });
    h.messages.push({
      type: "result",
      session_id: task.session_id,
      subtype: "success",
      total_cost_usd: 0.0001,
      result: "API Error: Request rejected (429) · monthly quota.",
    });

    const startP = session.start(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: API Error: Request rejected \(429\)/);

    await session.close();
    await startP;
  });

  it("synthetic 错误 + 流式 tool_use + success → reviewing (tool_use 算实质产出, 不误伤)", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    h.messages.push({
      type: "assistant",
      uuid: "msg-synth-err",
      session_id: task.session_id,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: Request rejected (429)" }],
      },
      error: "rate_limit",
    });
    // 下一轮真实开工: 流式 tool_use (includePartialMessages 下 finalized 为空壳)
    h.messages.push({
      type: "stream_event",
      session_id: task.session_id,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu-1", name: "Bash" },
      },
    });
    h.messages.push({
      type: "assistant",
      uuid: "msg-shell",
      session_id: task.session_id,
      message: { role: "assistant", model: "glm-5.3-flash", content: [] },
      content: [],
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
});

describe("R227: resume 路径限流重试耗尽快速失败 (6af660e4 实录场景)", () => {
  it("resume 中 api_retry 429×6 → failed(api_error:), 不等 SDK 重试耗尽", async () => {
    const runtime = new AgentRuntime();
    const task = makeRunningTask();
    const session = attachSession(runtime, task);

    pushRateLimitBurst(6);

    const resumeP = session.resume(task).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await tick();

    expect(h.closeCount).toBe(1);
    const after = getTaskById(task.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^api_error: /);

    await session.close();
    await resumeP;
  });
});
