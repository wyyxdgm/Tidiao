// 被打断的任务(cancel / pause)的成本记账
//
// 背景: interrupt 之后的会话不会再走到 result 消息, 而 tasks.cost_usd 只在
// result 分支才写 -> 被 cancel/pause 的任务花费恒为 0, 平台成本统计系统性低估。
// 修复是把 ActiveSession 内存里的部分累计值(handleMessage 在任意带
// total_cost_usd 的消息上都更新它)在打断时落库。
//
// 这里断言的是「落库」这一件事本身, 外加两条不许被破坏的既有行为:
//   - session 不存在时不写 0 覆盖库里已有的值
//   - pause 的 session_id 保全逻辑(无 session_id 则标 failed)
//
// 真 SQLite + 真 AgentRuntime; SDK 与 runner 是假的。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(async () => ({ sessionId: "mock-forked-session" })),
  getSessionMessages: vi.fn(async () => [{ uuid: "msg-1", role: "user" }]),
  query: vi.fn(),
}));
vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import { ActiveSession } from "./active-session";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";
import { estimateCostUsd } from "./cost-estimate";
import { createLlmConfig } from "../db/llm-configs";

let tmpDir: string;
let projectId: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cost-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "cost-test@example.com", "x", "admin");
  projectId = createProject({ name: "cost-test-project", ownerId: userId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Helpers ----

function schedulerOf(runtime: AgentRuntime): TaskScheduler {
  return (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
}

function sessionsOf(runtime: AgentRuntime): Map<string, unknown> {
  return (runtime as unknown as { sessions: Map<string, unknown> }).sessions;
}

// runner 挂住不返回, 任务停在 running 直到 resolve
function makeRuntime(): { runtime: AgentRuntime; resolve: (taskId: string) => void } {
  const resolvers = new Map<string, () => void>();
  const runtime = new AgentRuntime();
  schedulerOf(runtime).setRunner(
    (task: Task, _mode: RunMode) =>
      new Promise<void>((resolve) => {
        resolvers.set(task.id, resolve);
      })
  );
  return { runtime, resolve: (taskId: string) => resolvers.get(taskId)?.() };
}

// 假 ActiveSession: cancel/pause 路径只用到 interrupt / close / getSessionId /
// getCostSnapshot / getTokenUsage / takeUnansweredUserTurn。close 后仍返回同一个
// cost —— 与真 ActiveSession 一致(见下方用真对象的那条测试)。
// tokens 参数模拟「拿不到 total_cost_usd 但 assistant 消息带了 usage」的中断场景。
function fakeSession(
  sessionId: string | null,
  costUsd: number,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
) {
  return {
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getSessionId: () => sessionId,
    getCostUsd: () => costUsd,
    getTokenUsage: () => tokens,
    getCostSnapshot: () =>
      costUsd > 0
        ? { cost: costUsd, source: "measured" as const }
        : { cost: estimateCostUsd(tokens), source: "estimated" as const },
    // pause 时会读它回填未被回答的指令; 这里只测记账, 给 null(没什么要回填)。
    // 回填本身由 resume-continuation.test.ts 覆盖。
    takeUnansweredUserTurn: () => null,
    markExternallyTerminated: () => {},
    get isClosed() {
      return false;
    },
  };
}

function newTask(title: string): Task {
  return createTask({ title, prompt: "test prompt", project_id: projectId });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- ActiveSession.getCostUsd ----

describe("ActiveSession.getCostUsd", () => {
  it("close() 之后依然读得到打断那一刻的累计花费", async () => {
    const task = newTask("真 session");
    const session = new ActiveSession(task);
    // 模拟 handleMessage 在流式过程中累计出来的部分值
    (session as unknown as { costUsd: number }).costUsd = 0.1234;

    expect(session.getCostUsd()).toBe(0.1234);
    await session.interrupt(); // 无 queryInstance -> no-op, 但确认它不重置 cost
    await session.close();
    expect(session.getCostUsd()).toBe(0.1234);
  });

  it("从未产生花费时返回 0", () => {
    const session = new ActiveSession(newTask("零花费 session"));
    expect(session.getCostUsd()).toBe(0);
  });

  // 走真 accumulateUsage 路径, 不靠 fakeSession. SDK 中途消息带的 usage(input/
  // output/cache) 通过私有方法累加成全程 token, getCostSnapshot 据此折算 —— 删
  // 掉 handleMessage 里的 this.accumulateUsage(message) 调用, 这条必须变红.
  it("accumulateUsage: 多条带 usage 的中途消息累计 token, getCostSnapshot 返回非 0 估算", () => {
    const session = new ActiveSession(newTask("真中途消息 session"));
    // 三条 assistant 消息, 每条带 usage; 同一行没有 total_cost_usd
    const msg1 = {
      message: {
        usage: {
          input_tokens: 20000,
          output_tokens: 5000,
          cache_read_input_tokens: 300000,
          cache_creation_input_tokens: 10000,
        },
      },
    };
    const msg2 = {
      message: {
        usage: {
          input_tokens: 5000,
          output_tokens: 2000,
          cache_read_input_tokens: 100000,
          cache_creation_input_tokens: 0,
        },
      },
    };
    const msg3 = {
      // 部分消息没有 usage (比如 tool_result/user), 不该崩
      message: { content: [{ type: "tool_result" }] },
    };
    (session as any).accumulateUsage(msg1);
    (session as any).accumulateUsage(msg2);
    (session as any).accumulateUsage(msg3);

    // 累计应等于三条之和
    const tokens = (session as any).getTokenUsage();
    expect(tokens.input).toBe(25000);
    expect(tokens.output).toBe(7000);
    expect(tokens.cacheRead).toBe(400000);
    expect(tokens.cacheWrite).toBe(10000);

    // 走 getCostSnapshot: costUsd=0 -> 走估算
    const snap = (session as any).getCostSnapshot();
    expect(snap.source).toBe("estimated");
    expect(snap.cost).toBeGreaterThan(0);
    expect(snap.cost).toBeCloseTo(estimateCostUsd(tokens), 6);

    // close 之后仍读得到(不重置累计)
    return session.close().then(() => {
      expect((session as any).getCostSnapshot().cost).toBeCloseTo(
        estimateCostUsd(tokens),
        6,
      );
    });
  });
});

// ---- cancelTask ----

describe("cancelTask 的成本记账", () => {
  it("session 存在且 costUsd>0 -> 落库到 tasks.cost_usd", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("cancel 带花费");
    runtime.startTask(task.id);
    await tick();
    expect(getTaskById(task.id)?.status).toBe("running");

    sessionsOf(runtime).set(task.id, fakeSession("sess-cancel-1", 0.0731));
    await runtime.cancelTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("cancelled");
    // 修复前这里恒为 0/null = 成本记账洞
    expect(after?.cost_usd).toBeCloseTo(0.0731, 6);

    resolve(task.id);
  });

  it("session 不存在 -> 不抛异常、状态照常 cancelled、不写 0 覆盖库里已有的值", async () => {
    const { runtime } = makeRuntime();
    const task = newTask("cancel 无 session");
    // 库里已有一笔花费(如之前那轮跑出来的), cancel 不该把它抹成 0
    updateTaskStatus(task.id, "pending", { cost_usd: 0.5 });
    expect(sessionsOf(runtime).has(task.id)).toBe(false);

    await expect(runtime.cancelTask(task.id)).resolves.toBeUndefined();

    const after = getTaskById(task.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.cost_usd).toBeCloseTo(0.5, 6);
  });

  it("session 存在但 costUsd=0 -> 同样不写 0 覆盖", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("cancel 零花费 session");
    runtime.startTask(task.id);
    await tick();
    updateTaskStatus(task.id, "running", { cost_usd: 0.42 });

    sessionsOf(runtime).set(task.id, fakeSession("sess-cancel-2", 0));
    await runtime.cancelTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.cost_usd).toBeCloseTo(0.42, 6);

    resolve(task.id);
  });
});

// ---- pauseTask ----

describe("pauseTask 的成本记账", () => {
  it("cost 落库, 且 session_id 保全逻辑不变", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("pause 带花费");
    runtime.startTask(task.id);
    await tick();
    expect(getTaskById(task.id)?.status).toBe("running");

    sessionsOf(runtime).set(task.id, fakeSession("sess-pause-1", 0.0219));
    await runtime.pauseTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("paused");
    expect(after?.cost_usd).toBeCloseTo(0.0219, 6);
    // 既有行为: 上下文可恢复的前提
    expect(after?.session_id).toBe("sess-pause-1");

    resolve(task.id);
  });

  it("没有 session_id -> 仍标 failed(既有行为), 但花费也要落库", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("pause 无 session_id");
    runtime.startTask(task.id);
    await tick();

    sessionsOf(runtime).set(task.id, fakeSession(null, 0.0088));
    await runtime.pauseTask(task.id);

    const after = getTaskById(task.id);
    // 这段是有意为之: 无 session_id 就没法 resume, 不许假装能
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/cannot resume/i);
    expect(after?.cost_usd).toBeCloseTo(0.0088, 6);

    resolve(task.id);
  });

  it("costUsd=0 时不写 0 覆盖库里已有的值", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("pause 零花费");
    runtime.startTask(task.id);
    await tick();
    updateTaskStatus(task.id, "running", { cost_usd: 0.33 });

    sessionsOf(runtime).set(task.id, fakeSession("sess-pause-2", 0));
    await runtime.pauseTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("paused");
    expect(after?.cost_usd).toBeCloseTo(0.33, 6);

    resolve(task.id);
  });
});

// ---- 反测: 估算兜底 vs 实测, 两个方向都要断言 ----
//
// 这组是本次修复的核心。旧实现 `cost > 0 ? { cost_usd } : {}` 在真实中断路径上
// 恒走假分支(total_cost_usd 只在 result 消息上出现, 被中断的会话永远走不到
// result) -> cost_usd 永久留 NULL。而 ac19cdf 的测试构造的消息带 total_cost_usd,
// 覆盖的是不会发生的情况, 所以代码在 master 上而指标没停止增长。
describe("记账兜底: 拿不到 total_cost_usd 时必须落估算值而不是 NULL", () => {
  it("中断时没有 total_cost_usd 但有 token usage -> 落估算值, 并标 cost_source=estimated", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("pause 无账单有 token");
    runtime.startTask(task.id);
    await tick();

    // 真实的超时中断场景: costUsd=0(从没见过 total_cost_usd), 但各轮 usage 累计到了 token
    const tokens = { input: 20000, output: 5000, cacheRead: 300000, cacheWrite: 10000 };
    sessionsOf(runtime).set(task.id, fakeSession("sess-est-1", 0, tokens));
    await runtime.pauseTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.status).toBe("paused");
    // 🔴 核心断言: 不是 NULL
    expect(after?.cost_usd).not.toBeNull();
    expect(after?.cost_usd).toBeGreaterThan(0);
    expect(after?.cost_usd).toBeCloseTo(estimateCostUsd(tokens), 6);

    // 估算值必须显式标注, 不许假装实测
    const meta = JSON.parse(after?.metadata || "{}");
    expect(meta.cost_source).toBe("estimated");
    expect(meta.cost_tokens).toEqual(tokens);

    resolve(task.id);
  });

  it("连 token 都没有的中断也不留 NULL(落最小估算值)", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("pause 啥都没有");
    runtime.startTask(task.id);
    await tick();

    sessionsOf(runtime).set(task.id, fakeSession("sess-est-2", 0));
    await runtime.pauseTask(task.id);

    const after = getTaskById(task.id);
    // 库里本来是 NULL(没被 updateTaskStatus 写过 cost), 兜底后必须有值
    expect(after?.cost_usd).not.toBeNull();
    expect(after?.cost_usd).toBeGreaterThan(0);
    expect(JSON.parse(after?.metadata || "{}").cost_source).toBe("estimated");

    resolve(task.id);
  });

  it("反向: 拿到了 total_cost_usd -> 落实测值, cost_source=measured, 不带 cost_tokens", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("cancel 有真实账单");
    runtime.startTask(task.id);
    await tick();

    // 同时给 token: 断言实测值优先, 估算不许把它盖掉
    const tokens = { input: 99999, output: 99999, cacheRead: 0, cacheWrite: 0 };
    sessionsOf(runtime).set(task.id, fakeSession("sess-meas-1", 1.2345, tokens));
    await runtime.cancelTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.cost_usd).toBeCloseTo(1.2345, 6);
    // 落的必须是实测值, 不是按 token 算出来的那个数
    expect(after?.cost_usd).not.toBeCloseTo(estimateCostUsd(tokens), 6);

    const meta = JSON.parse(after?.metadata || "{}");
    expect(meta.cost_source).toBe("measured");
    expect(meta.cost_tokens).toBeUndefined();

    resolve(task.id);
  });

  it("估算值不许覆盖库里已有的实测值", async () => {
    const { runtime, resolve } = makeRuntime();
    const task = newTask("pause 已有实测值");
    runtime.startTask(task.id);
    await tick();
    // resume 之前那轮已记过真实账单
    updateTaskStatus(task.id, "running", { cost_usd: 5.5 });

    sessionsOf(runtime).set(
      task.id,
      fakeSession("sess-keep", 0, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }),
    );
    await runtime.pauseTask(task.id);

    const after = getTaskById(task.id);
    expect(after?.cost_usd).toBeCloseTo(5.5, 6);

    resolve(task.id);
  });
});

// ---- 估算函数本身 ----
describe("estimateCostUsd", () => {
  it("cache_read 按低单价折算, 不与 input 同价(否则长会话高估几倍)", () => {
    const asInput = estimateCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const asCacheRead = estimateCostUsd({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 });
    expect(asCacheRead).toBeLessThan(asInput / 5);
  });

  it("output 比 input 贵", () => {
    const inp = estimateCostUsd({ input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const out = estimateCostUsd({ input: 0, output: 100_000, cacheRead: 0, cacheWrite: 0 });
    expect(out).toBeGreaterThan(inp);
  });

  it("token 全 0 也恒返回 >0 —— 返回 0 会被上游 `cost > 0` 判据当成没数据而退回 NULL", () => {
    expect(estimateCostUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeGreaterThan(0);
  });
});

// ---- R239: per-model 单价 (cost_source=priced) ----

describe("per-model 单价精确计费 (R239 cost_source=priced)", () => {
  // ActiveSession.priced 路径读 this.resolvedConfig.source_config_id →
  // llm_configs.price_*; 测试里直接种 resolvedConfig (真 ActiveSession + 真库)。
  function pricedSession(task: Task, configId: string | null): ActiveSession {
    const session = new ActiveSession(task);
    (session as unknown as { resolvedConfig: unknown }).resolvedConfig = {
      source_config_id: configId,
    };
    return session;
  }

  function feed(session: ActiveSession, input: number, output: number): void {
    (session as unknown as { accumulateUsage: (m: unknown) => void }).accumulateUsage({
      message: {
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  it("配置了单价 → getCostSnapshot 走 priced, 金额=token×配置单价", () => {
    const cfg = createLlmConfig("admin", "system", { name: "priced-1", price_in: 3, price_out: 15 });
    const session = pricedSession(newTask("priced session"), cfg.id);
    feed(session, 1_000_000, 1_000_000);
    const snap = (session as unknown as { getCostSnapshot(): { cost: number; source: string } }).getCostSnapshot();
    expect(snap.source).toBe("priced");
    expect(snap.cost).toBe(18);
    session.close();
  });

  it("优先级: SDK 给了 total_cost_usd (measured 候选) 但配置了单价 → 仍走 priced", () => {
    const cfg = createLlmConfig("admin", "system", { name: "priced-2", price_in: 1, price_out: 2 });
    const session = pricedSession(newTask("priced beats measured"), cfg.id);
    (session as unknown as { costUsd: number }).costUsd = 0.5; // Anthropic 牌价实测值
    feed(session, 1_000_000, 1_000_000);
    const snap = (session as unknown as { getCostSnapshot(): { cost: number; source: string } }).getCostSnapshot();
    expect(snap.source).toBe("priced");
    expect(snap.cost).toBe(3);
    session.close();
  });

  it("没配单价 → 既有行为不变 (estimated), resolvedConfig 缺 source_config_id 也安全", () => {
    const session = pricedSession(newTask("no price"), null);
    feed(session, 1_000_000, 0);
    const snap = (session as unknown as { getCostSnapshot(): { cost: number; source: string } }).getCostSnapshot();
    expect(snap.source).toBe("estimated");
    expect(snap.cost).toBeGreaterThan(0);
    session.close();
  });
});
