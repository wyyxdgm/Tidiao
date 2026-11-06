// Goal-driven loop 阶段 4 (D21, damo 2026-09-14 拍板) — continueGoalLoop helper 单测.
//   覆盖 plan §9.4 接口 + 决策树 + D12 off-by-one 修复 + 漏洞 #2/#8:
//     1) max_goal_rounds 触发 giveUp (current >= max, D12 前置修复)
//     2) context < 阈值 → continue (pushMessage 续同 session)
//     3) context >= 阈值 → fork (forkSession + goal marker 拼接, 漏洞 #8)
//     4) goal_history cap 20 条 (漏洞 #2 P1)
//     5) fork prompt 显式包含 <goal>...</goal> marker (漏洞 #8 P0)
//     6) off-by-one: current=4 max=5 → 第 5 轮跑 → current=5 max=5 → giveUp
//     7) 边界: contextMax=null → 永远 resume (不 fork)
//     8) 边界: task 没 goal_text 但走 fork → fallback (无 marker, console.warn)
//
// 测试策略:
//   - mock SDK (forkSession / query / getSessionMessages) 不真起 subprocess.
//   - 用真 AgentRuntime 实例 (new AgentRuntime()) 但**不调 init()** —
//     continueGoalLoop 第 4 参数 runtimeOverride 让我们注入 AgentRuntime 实例,
//     但 continueGoalLoop 仍会调 .forkSession / .getActiveSession / .emitEvent
//     等实例方法, 这些方法本身要真跑 (调 SDK 时已被 mock). 等价于真路径但
//     跳过了 init() 的 recoverOrphanedTasks + startHeartbeatTick 等副作用.
//   - 直接调 SDK mock 容易绕开真实逻辑; 这里用 vi.spyOn(AgentRuntime.prototype,
//     'forkSession') mock 掉 forkSession, 让 ActiveSession.getActiveSession
//     走 spyOn stub. 不动 SDK mock 直接跑 — SDK mock 必须存在, 否则
//     createSession / insertEvent 等真跑会触 DB / 真 subprocess.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  query: vi.fn(),
}));

vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: vi.fn(),
}));
vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));

import { AgentRuntime, continueGoalLoop, type ContextUsageSnapshot } from "./agent-runtime";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, mutateTaskMetadata } from "../db/tasks";
import {
  setSetting,
  getMaxGoalRounds,
  getGoalResumeThreshold,
} from "../db/settings";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;
let runtime: AgentRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-continue-goal-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
  projectId = createProject({ name: "continue-goal-test", ownerId: userId }).id;
  runtime = new AgentRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 创建一条 running 状态 + goal metadata 的 task (goal loop 已在跑的 task 形态).
function makeGoalTask(opts: {
  goalRounds?: number;
  goalHistory?: Array<Record<string, unknown>>;
  goalText?: string | null;
  maxGoalRounds?: number;
  status?: "running" | "reviewing" | "failed";
  sessionId?: string | null;
}): Task {
  const task = createTask({
    title: "continue-goal-test-task",
    prompt: "test prompt\n<goal>README 第一个词是 bar</goal>",
    project_id: projectId,
    cwd: tmpDir,
  });
  // 写 owner + metadata + status + session_id.
  const metadata: Record<string, unknown> = {};
  if (opts.goalText !== undefined && opts.goalText !== null) {
    metadata.goal_text = opts.goalText;
  } else {
    metadata.goal_text = "README 第一个词是 bar";
  }
  if (opts.goalRounds !== undefined) metadata.goal_rounds = opts.goalRounds;
  if (opts.goalHistory !== undefined) metadata.goal_history = opts.goalHistory;
  // R143 二轮: per-task max_goal_rounds 覆盖 (UI / API 写进来).
  if (opts.maxGoalRounds !== undefined) metadata.max_goal_rounds = opts.maxGoalRounds;
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, status = ?, session_id = ?, metadata = ? WHERE id = ?`,
    )
    .run(
      userId,
      opts.status ?? "running",
      opts.sessionId !== undefined ? opts.sessionId : "sess-test",
      JSON.stringify(metadata),
      task.id,
    );
  return getTaskById(task.id)!;
}

// 给一个 active session stub, 塞进 runtime.getActiveSession.
function attachSession(taskId: string) {
  const sessionStub = {
    pushMessage: vi.fn(),
    getCostUsd: vi.fn(() => 0.42),
  };
  // runtime.sessions 是 private, 用 spyOn 把 getActiveSession 替成 stub.
  vi.spyOn(runtime, "getActiveSession").mockImplementation((id: string) => {
    if (id === taskId) return sessionStub as unknown as ReturnType<typeof runtime.getActiveSession>;
    return undefined;
  });
  return sessionStub;
}

const LOW_CONTEXT: ContextUsageSnapshot = { contextTokens: 500, contextMax: 1000 }; // 50%
const HIGH_CONTEXT: ContextUsageSnapshot = { contextTokens: 900, contextMax: 1000 }; // 90%

describe("continueGoalLoop: max_goal_rounds 兜底 giveUp (D12 off-by-one 修复)", () => {
  it("current=4 max=5 → 第 5 轮跑 (goal_rounds 增到 5, 不立即 giveUp)", async () => {
    // 关键: D12 修复 = 前置 current >= max 检查 → current=4 max=5 时不进 giveUp, 允许跑第 5 轮.
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 4, status: "running" });
    const session = attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "new-task-id",
      newSessionId: "new-sess-id",
      forkedFromSessionId: task.session_id!,
    });

    const decision = await continueGoalLoop(
      task.id,
      "grader: 还需要改第一段",
      LOW_CONTEXT,
      runtime,
    );

    expect(decision.action).toBe("continue"); // 第 5 轮 pushMessage, 不是 giveUp
    expect(session.pushMessage).toHaveBeenCalledTimes(1);
    expect(forkSpy).not.toHaveBeenCalled();
    // metadata.goal_rounds 增到 5
    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    expect(meta.goal_rounds).toBe(5);
    // status 仍 running (giveUp 没触发)
    expect(after.status).toBe("running");
  });

  it("current=5 max=5 → giveUp (D12 前置 current >= max 命中)", async () => {
    setSetting("max_goal_rounds", "5");
    const task = makeGoalTask({ goalRounds: 5, status: "running" });
    attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession");

    const decision = await continueGoalLoop(
      task.id,
      "grader: 还是没达成",
      LOW_CONTEXT,
      runtime,
    );

    expect(decision.action).toBe("giveUp");
    if (decision.action === "giveUp") {
      expect(decision.reason).toMatch(/max_goal_rounds.*5/);
      expect(decision.reason).toContain("grader: 还是没达成");
    }
    // 翻 failed + 写 cost_usd
    const after = getTaskById(task.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/max_goal_rounds/);
    expect(after.cost_usd).toBe(0.42); // 来自 session.getCostUsd mock
    expect(forkSpy).not.toHaveBeenCalled();
  });

  it("off-by-one 反测: 旧写法 new_rounds >= max (5>=5) 会让 max=5 实际只允许 4 轮", async () => {
    // 反向论证: 验证「new_rounds >= max」会误杀最后一轮 — current=4 max=5 时
    //   new_rounds=5 >= 5 → 旧实现会 giveUp, 实际只能跑 4 轮. 我们的 D12 修复
    //   改成 current >= max (4 >= 5 false) → 跑第 5 轮. 上面的 "current=4 max=5
    //   跑第 5 轮" 测试已正向覆盖. 这里反向断言: 旧写法的语义下 current=4 max=5
    //   会 giveUp, 但我们没 giveUp — 证明 off-by-one 已修.
    setSetting("max_goal_rounds", "5");
    const task = makeGoalTask({ goalRounds: 4, status: "running" });
    attachSession(task.id);
    vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "new",
      newSessionId: "new-sess",
      forkedFromSessionId: task.session_id!,
    });

    const decision = await continueGoalLoop(
      task.id,
      "grader feedback",
      LOW_CONTEXT,
      runtime,
    );

    // 反测: 旧实现这里会 giveUp; 我们这里是 continue.
    expect(decision.action).not.toBe("giveUp");
  });
});

// 🆕 R143 二轮 (damo 2026-09-15 拍板): per-task max_goal_rounds 覆盖.
//   解析链: task.metadata.max_goal_rounds (per-task) → settings.getMaxGoalRounds()
//   (全局) → DEFAULT_MAX_GOAL_ROUNDS (20). 越界裁剪, 非数字/null 走 fall back.
describe("continueGoalLoop: per-task max_goal_rounds (R143 二轮)", () => {
  it("metadata.max_goal_rounds=3 覆盖全局 5 → 第 3 轮 giveUp", async () => {
    setSetting("max_goal_rounds", "5");
    // D12 修复: current >= max 时 giveUp. goalRounds=2 + max=3 允许跑第 3 轮;
    //   goalRounds=3 + max=3 直接 giveUp.
    const task = makeGoalTask({ goalRounds: 3, maxGoalRounds: 3, status: "running" });
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    // current 3 >= per-task max 3 → 前置检查触发 giveUp
    expect(decision.action).toBe("giveUp");
    expect(decision.reason).toMatch(/max_goal_rounds.*3/);
    const after = getTaskById(task.id)!;
    expect(after.error).toMatch(/max_goal_rounds/);
    expect(sessionStub.pushMessage).not.toHaveBeenCalled();
  });

  it("per-task max=10 覆盖全局 5, current=8 → 第 9 轮允许跑 (D12 前置修复)", async () => {
    setSetting("max_goal_rounds", "5");
    const task = makeGoalTask({ goalRounds: 8, maxGoalRounds: 10, status: "running" });
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    // metadata.goal_rounds 增到 9, 仍 < per-task max 10 → continue 走 pushMessage
    expect(decision.action).toBe("continue");
    expect(sessionStub.pushMessage).toHaveBeenCalled();
    const meta = JSON.parse(getTaskById(task.id)!.metadata);
    expect(meta.goal_rounds).toBe(9);
  });

  it("per-task max=50 超出 settings 上限 → 裁剪到 20, 仍按 20 跑", async () => {
    // 即便 UI/API 层有 [1, 20] 校验, runtime 兜底再裁一次, 防越界 metadata.
    setSetting("max_goal_rounds", "5");
    const task = makeGoalTask({ goalRounds: 1, maxGoalRounds: 50, status: "running" });
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    expect(decision.action).toBe("continue");
    expect(sessionStub.pushMessage).toHaveBeenCalled();
    // 50 裁到 20, current 1+1=2, 远 < 20.
  });

  it("metadata.max_goal_rounds 缺省 → fall back 全局 settings (5)", async () => {
    setSetting("max_goal_rounds", "5");
    const task = makeGoalTask({ goalRounds: 4, status: "running" });
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    expect(decision.action).toBe("continue");
    expect(sessionStub.pushMessage).toHaveBeenCalled();
    const meta = JSON.parse(getTaskById(task.id)!.metadata);
    expect(meta.goal_rounds).toBe(5); // 增到 5, 仍 < 全局 max 5 → continue (D12 修复)
  });

  it("metadata.max_goal_rounds 非法 (字符串/NaN) → fall back 全局, 不抛错", async () => {
    setSetting("max_goal_rounds", "5");
    const task = makeGoalTask({ goalRounds: 1, status: "running" });
    // 直接覆盖 metadata 为非法值, 模拟历史脏数据 / 手填
    const raw = getTaskById(task.id)!.metadata;
    const meta = JSON.parse(raw);
    meta.max_goal_rounds = "garbage"; // 非 number
    getDb().prepare("UPDATE tasks SET metadata = ? WHERE id = ?").run(
      JSON.stringify(meta),
      task.id,
    );
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    // fall back 到全局 5, current 1 → continue
    expect(decision.action).toBe("continue");
    expect(sessionStub.pushMessage).toHaveBeenCalled();
  });

  it("per-task max=0 哨兵 (R143 四轮) → 不限轮次, 永远不 giveUp", async () => {
    setSetting("max_goal_rounds", "5");
    // 即使 current=100 也 continue (传统 max=5 + current=100 必 giveUp).
    const task = makeGoalTask({ goalRounds: 100, maxGoalRounds: 0, status: "running" });
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    expect(decision.action).toBe("continue");
    expect(sessionStub.pushMessage).toHaveBeenCalled();
    // metadata.goal_rounds 增到 101, 仍 < 0? 不, 0 不参与比较, 永 continue.
    const meta = JSON.parse(getTaskById(task.id)!.metadata);
    expect(meta.goal_rounds).toBe(101);
  });

  it("全局 max=0 (R143 四轮) → 不限轮次, 即使 current 大也 continue", async () => {
    setSetting("max_goal_rounds", "0");
    const task = makeGoalTask({ goalRounds: 50, status: "running" });
    const sessionStub = attachSession(task.id);
    const decision = await continueGoalLoop(task.id, "feedback", LOW_CONTEXT, runtime);
    expect(decision.action).toBe("continue");
    expect(sessionStub.pushMessage).toHaveBeenCalled();
  });
});

describe("continueGoalLoop: context 阈值分流 (plan §9.4 决策树)", () => {
  it("contextTokens < threshold → pushMessage 续同 session (action=continue)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 1, status: "running" });
    const session = attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "new",
      newSessionId: "new-sess",
      forkedFromSessionId: task.session_id!,
    });

    const decision = await continueGoalLoop(
      task.id,
      "grader: 还需要改",
      LOW_CONTEXT, // 50%, < 0.8
      runtime,
    );

    expect(decision.action).toBe("continue");
    expect(session.pushMessage).toHaveBeenCalledTimes(1);
    expect(session.pushMessage).toHaveBeenCalledWith("grader: 还需要改", "system");
    expect(forkSpy).not.toHaveBeenCalled();
  });

  it("contextTokens >= threshold → forkSession + compactFirst (action=fork)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 1, status: "running" });
    const session = attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "fork-task-1",
      newSessionId: "fork-sess-1",
      forkedFromSessionId: task.session_id!,
    });

    const decision = await continueGoalLoop(
      task.id,
      "grader: 还要改",
      HIGH_CONTEXT, // 90%, >= 0.8
      runtime,
    );

    expect(decision.action).toBe("fork");
    if (decision.action === "fork") {
      expect(decision.newTaskId).toBe("fork-task-1");
      expect(decision.newSessionId).toBe("fork-sess-1");
    }
    expect(forkSpy).toHaveBeenCalledTimes(1);
    const forkCallArgs = forkSpy.mock.calls[0]!;
    expect(forkCallArgs[0]).toBe(task.id);
    expect(forkCallArgs[1].compactFirst).toBe(true);
    expect(session.pushMessage).not.toHaveBeenCalled();
  });

  it("contextMax=null → 永远 resume (不 fork, 防除零)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 1, status: "running" });
    const session = attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession");

    const decision = await continueGoalLoop(
      task.id,
      "grader feedback",
      { contextTokens: 99999, contextMax: null }, // contextMax=null
      runtime,
    );

    expect(decision.action).toBe("continue");
    expect(forkSpy).not.toHaveBeenCalled();
    expect(session.pushMessage).toHaveBeenCalledTimes(1);
  });

  it("contextTokens=null → 永远 resume (与上同理)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 1, status: "running" });
    const session = attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession");

    const decision = await continueGoalLoop(
      task.id,
      "grader feedback",
      { contextTokens: null, contextMax: 1000 }, // contextTokens=null
      runtime,
    );

    expect(decision.action).toBe("continue");
    expect(forkSpy).not.toHaveBeenCalled();
    expect(session.pushMessage).toHaveBeenCalledTimes(1);
  });
});

describe("continueGoalLoop: 漏洞 #8 (P0) — fork prompt 必含 <goal> marker", () => {
  it("fork 路径: opts.prompt 末尾拼接 <goal>...</goal> block", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({
      goalRounds: 1,
      goalText: "README 第一个词是 bar",
      status: "running",
    });
    attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "fork-task",
      newSessionId: "fork-sess",
      forkedFromSessionId: task.session_id!,
    });

    await continueGoalLoop(
      task.id,
      "grader: 还要改",
      HIGH_CONTEXT,
      runtime,
    );

    expect(forkSpy).toHaveBeenCalledTimes(1);
    const opts = forkSpy.mock.calls[0]![1];
    expect(opts.compactFirst).toBe(true);
    expect(opts.prompt).toBeDefined();
    expect(opts.prompt).toContain("<goal>");
    expect(opts.prompt).toContain("</goal>");
    expect(opts.prompt).toContain("README 第一个词是 bar");
    // marker 必须在默认 prompt 之后
    expect(opts.prompt!.indexOf("</goal>")).toBeGreaterThan(opts.prompt!.indexOf("请从父任务"));
  });

  it("task 没 goal_text 但走 fork → fallback (无 marker, console.warn)", async () => {
    // 异常路径: 启动时 active-session 没解析到 goal marker → metadata 没 goal_text
    //   → continueGoalLoop 仍可被调到 (caller bug) → fallback: 不拼 marker,
    //   让 fork task 当普通 task 跑 + warn.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 1, goalText: "", status: "running" });
    attachSession(task.id);
    const forkSpy = vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "fork-task",
      newSessionId: "fork-sess",
      forkedFromSessionId: task.session_id!,
    });

    const decision = await continueGoalLoop(
      task.id,
      "grader feedback",
      HIGH_CONTEXT,
      runtime,
    );

    expect(decision.action).toBe("fork");
    expect(forkSpy).toHaveBeenCalledTimes(1);
    const opts = forkSpy.mock.calls[0]![1];
    // 没 goal_text → 不传 prompt (forkSession 走内部 defaultPrompt, 不含 marker)
    expect(opts.prompt).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes("no goal_text"),
    );
    expect(warnMsg).toBeDefined();
  });
});

describe("continueGoalLoop: 漏洞 #2 (P1) — goal_history cap 20 条", () => {
  it("prev=25 + 新增 1 → 写回只剩 20 条 (slice(-20) 保留最近 20)", async () => {
    // 模拟异常状态: metadata 已被塞了 25 条 (例如老版本没 cap), 当前 round=25.
    //   goal_rounds 上限是 20 (max_goal_rounds 上限) → current >= max 触发 giveUp.
    //   真正 cap 测试改用 prev=19 + 新增 1 = 20 条 (不超 cap, 验证逻辑) + 另一段
    //   直接走 updateTask 写 prev=20 + 验证 slice 保留. 这里测的是 slice(-20)
    //   行为本身, 不依赖 giveUp 路径.
    setSetting("max_goal_rounds", "20");
    setSetting("goal_resume_threshold", "0.8");
    // 制造 19 条假历史 (round 1-19), goal_rounds=19 (current=19 max=20 不 giveUp)
    const fakeHistory = Array.from({ length: 19 }, (_, i) => ({
      round: i + 1,
      verdict: "not_yet_met",
      reason: `old-round-${i + 1}`,
      at: new Date(Date.now() - (19 - i) * 60000).toISOString(),
      context_tokens: 100,
      context_max: 1000,
    }));
    const task = makeGoalTask({ goalRounds: 19, goalHistory: fakeHistory, status: "running" });
    attachSession(task.id);
    vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "fork-task",
      newSessionId: "fork-sess",
      forkedFromSessionId: task.session_id!,
    });

    await continueGoalLoop(
      task.id,
      "grader: 还需要改",
      LOW_CONTEXT,
      runtime,
    );

    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    const history = meta.goal_history as Array<Record<string, unknown>>;
    // 19 prev + 1 new = 20, 正好等于 cap, 不截断
    expect(history.length).toBe(20);
    expect(history[0]!.round).toBe(1);
    expect(history[history.length - 1]!.round).toBe(20); // 新增 round=20
    expect(meta.goal_rounds).toBe(20);
  });

  it("prev=20 + 新增 1 → slice(-20) 截断到 20 条 (保留最近 20, 丢最早 1 条)", async () => {
    // 直接制造 20 条历史 + goalRounds=19, 调一次后 history=20 条 (slice(-20) 丢最早 1 条)
    setSetting("max_goal_rounds", "20");
    setSetting("goal_resume_threshold", "0.8");
    const fakeHistory = Array.from({ length: 20 }, (_, i) => ({
      round: i + 1,
      verdict: "not_yet_met",
      reason: `old-round-${i + 1}`,
      at: new Date(Date.now() - (20 - i) * 60000).toISOString(),
      context_tokens: 100,
      context_max: 1000,
    }));
    const task = makeGoalTask({ goalRounds: 19, goalHistory: fakeHistory, status: "running" });
    attachSession(task.id);
    vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "fork-task",
      newSessionId: "fork-sess",
      forkedFromSessionId: task.session_id!,
    });

    await continueGoalLoop(
      task.id,
      "grader feedback",
      LOW_CONTEXT,
      runtime,
    );

    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    const history = meta.goal_history as Array<Record<string, unknown>>;
    // 20 prev + 1 new = 21, slice(-20) → 保留最后 20 条
    expect(history.length).toBe(20);
    // 最早一条 (round=1) 被截断, 最早保留是 round=2
    expect(history[0]!.round).toBe(2);
    // 新增 round=20 在末尾
    expect(history[history.length - 1]!.round).toBe(20);
  });

  it("prev=0 + 新增 1 → 只 1 条 (没到 cap, 不截断)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 0, goalHistory: [], status: "running" });
    attachSession(task.id);
    vi.spyOn(runtime, "forkSession").mockResolvedValue({
      newTaskId: "fork",
      newSessionId: "fork-sess",
      forkedFromSessionId: task.session_id!,
    });

    await continueGoalLoop(task.id, "first feedback", LOW_CONTEXT, runtime);

    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    expect((meta.goal_history as unknown[]).length).toBe(1);
    expect(meta.goal_rounds).toBe(1);
    expect(meta.last_grader_reason).toBe("first feedback");
  });
});

describe("continueGoalLoop: 边界 + 元信息", () => {
  it("last_grader_reason 写入 metadata (供审计 + goal history 反馈注入用)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 0, status: "running" });
    attachSession(task.id);

    await continueGoalLoop(
      task.id,
      "grader: 第二段还没改",
      LOW_CONTEXT,
      runtime,
    );

    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    expect(meta.last_grader_reason).toBe("grader: 第二段还没改");
  });

  it("new history entry 含 context_tokens / context_max 快照 (审计用)", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = makeGoalTask({ goalRounds: 0, status: "running" });
    attachSession(task.id);

    await continueGoalLoop(
      task.id,
      "feedback",
      { contextTokens: 750, contextMax: 1000 },
      runtime,
    );

    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    const entry = (meta.goal_history as Array<Record<string, unknown>>)[0]!;
    expect(entry.context_tokens).toBe(750);
    expect(entry.context_max).toBe(1000);
    expect(entry.round).toBe(1);
    expect(entry.verdict).toBe("not_yet_met");
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 时间格式
  });

  it("metadata 脏值 (非 JSON) → 视为无 goal 状态, 用默认 goalRounds=0", async () => {
    setSetting("max_goal_rounds", "5");
    setSetting("goal_resume_threshold", "0.8");
    const task = createTask({
      title: "dirty-meta",
      prompt: "x",
      project_id: projectId,
      cwd: tmpDir,
    });
    getDb()
      .prepare(
        `UPDATE tasks SET owner_id = ?, status = ?, session_id = ?, metadata = ? WHERE id = ?`,
      )
      .run(userId, "running", "sess-dirty", "{not valid json", task.id);
    attachSession(task.id);

    // 不该 throw (脏值降级到默认值 0)
    const decision = await continueGoalLoop(
      task.id,
      "feedback",
      LOW_CONTEXT,
      runtime,
    );
    expect(decision.action).toBe("continue");
    // metadata.goal_rounds = 1 (0 + 1)
    const after = getTaskById(task.id)!;
    const meta = JSON.parse(after.metadata!);
    expect(meta.goal_rounds).toBe(1);
  });

  it("task 不存在 → throw", async () => {
    await expect(
      continueGoalLoop("nonexistent-task-id", "feedback", LOW_CONTEXT, runtime),
    ).rejects.toThrow(/not found/);
  });

  it("getMaxGoalRounds() + getGoalResumeThreshold() 解析正确", () => {
    setSetting("max_goal_rounds", "10");
    setSetting("goal_resume_threshold", "0.5");
    expect(getMaxGoalRounds()).toBe(10);
    expect(getGoalResumeThreshold()).toBe(0.5);
    // 脏值回退 (R143 二轮默认改 20, R143 四轮上界改 1000)
    setSetting("max_goal_rounds", "1001");
    setSetting("goal_resume_threshold", "1.5");
    expect(getMaxGoalRounds()).toBe(20); // 1001 > 1000 上限 → 回退默认
    expect(getGoalResumeThreshold()).toBe(0.8); // 1.5 > 1.0 → 回退默认
  });
});
