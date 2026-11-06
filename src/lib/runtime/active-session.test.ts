/**
 * ExitPlanMode headless 死循环回归测试.
 *
 * 复现 2026-08-21 task cde3b5a9 在 auto_approve=1 下调 ExitPlanMode, SDK
 *   内部 inputClosed 状态机冲突 → 每次 allow 后 sendRequest() 抛
 *   "AbortError: Stream closed" → 包成 "Tool permission request failed"
 *   deny → agent 死循环重试（113s 内 3 次）.
 *
 * 断言: createCanUseTool 对 ExitPlanMode 一律 deny, 不论 autoApprove 与否;
 *   AskUserQuestion 仍走原有 user-dialog 路径（反测，确认插入位置不破坏
 *   既有行为）.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// 不需要跑 SDK 实际流, 把整个 SDK mock 成空 — 我们只调 canUseTool 回调.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

// 无出网副作用
vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTask, updateTaskStatus } from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-exitplanmode-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "exitplanmode-test@example.com", "x", "admin");
  // start() 前置校验要求 api_key 非空 — 我们不 start, 但构造 ActiveSession
  // 会调 resolveLlmConfig, 没 key 会抛. 提前注入一个 stub.
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "exitplanmode-test", ownerId: userId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(autoApprove: 0 | 1 = 0): Task {
  const task = createTask({
    title: "exitplanmode-regression",
    prompt: "请写一个 plan 然后 ExitPlanMode",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ?, auto_approve = ? WHERE id = ?`).run(userId, autoApprove, task.id);
  return getTaskById(task.id)!;
}

// 拿到 createCanUseTool 返回的回调, 不动 SDK 实际流.
function canUseToolFor(task: Task) {
  const session = new ActiveSession(task);
  // @ts-expect-error private, 测试需要触达
  return session.createCanUseTool();
}

const baseOptions = {
  signal: new AbortController().signal,
  toolUseID: "tool-use-test-1",
  requestId: "req-test-1",
} as Parameters<ReturnType<typeof canUseToolFor>>[2];

describe("canUseTool: ExitPlanMode headless 死循环回归", () => {
  it("ExitPlanMode → deny（autoApprove=0）", async () => {
    const task = makeTask(0);
    const canUseTool = canUseToolFor(task);
    const result = await canUseTool("ExitPlanMode", { plan: "## plan\n- step 1" }, baseOptions);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toMatch(/headless|Stream closed/i);
      expect(result.toolUseID).toBe(baseOptions.toolUseID);
    }
  });

  it("ExitPlanMode → deny（autoApprove=1，关键：必须在 autoApprove 检查之前）", async () => {
    // 复现 task cde3b5a9 的 auto_approve=1 配置；旧逻辑会走 allow 分支
    // 然后 SDK 报 Stream closed → 死循环。修复后必须在这里 deny。
    const task = makeTask(1);
    const canUseTool = canUseToolFor(task);
    const result = await canUseTool("ExitPlanMode", { plan: "## plan\n- step 1" }, baseOptions);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("docs/plans");
      expect(result.message).toContain("AskUserQuestion");
    }
  });

  it("ExitPlanMode 的 deny 立即返回（不挂 pendingApprovals，不 await 用户）", async () => {
    // 关键反测: 修复后 SDK 拿到 deny 必须同步返回, agent 才能停止重试.
    // 如果实现里退化成「弹 UI 等用户」, 跟原 bug 一样 agent 等不到 → 又循环.
    const task = makeTask(0);
    const canUseTool = canUseToolFor(task);
    const t0 = Date.now();
    const result = await canUseTool("ExitPlanMode", { plan: "x" }, baseOptions);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(50); // 同步 deny
    expect(result.behavior).toBe("deny");
  });

  it("AskUserQuestion 仍走原有 user-dialog 路径（反测：插入位置不破坏既有行为）", async () => {
    const task = makeTask(0);
    const canUseTool = canUseToolFor(task);
    // AskUserQuestion 应该返回一个 Promise（挂 pending user dialog），
    // 不像 ExitPlanMode 那样立即 deny。短超时验证它确实在等待。
    const ac = new AbortController();
    const opts = { ...baseOptions, signal: ac.signal, requestId: "req-auq" };
    const promise = canUseTool("AskUserQuestion", {
      questions: [{ question: "q?", header: "h", options: [{ label: "a", description: "d" }], multi_select: false }],
    }, opts);
    // 立即检查：还没 resolve（在等用户）
    let resolved = false;
    promise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(false);
    ac.abort(); // 清理：取消挂起的 dialog，避免测试间残留
    await promise;
  });

  it("Bash 在 autoApprove=1 下仍走 allow（反测：只拦截 ExitPlanMode）", async () => {
    const task = makeTask(1);
    const canUseTool = canUseToolFor(task);
    const result = await canUseTool("Bash", { command: "echo hello" }, baseOptions);
    expect(result.behavior).toBe("allow");
  });
});
// R113 (2026-09-07): <git commit-id="..." desc="..." files="..."/> marker 解析测试.
// 覆盖 parseGitCommitAttrs static method (private, 通过 typecast 调):
//   - 正常 hex short/full hash + desc + files → 解析正确
//   - 顺序无关 (desc 在 commit-id 前 / 单引号)
//   - commit-id 不合规 (非 hex / 太短) → 整条 marker 丢弃
//   - desc 过长 (>512) → 截断
//   - files 解析: 逗号分隔 + trim + 过滤空串 + 上限 256

describe("R113 parseGitCommitAttrs", () => {
  // parseGitCommitAttrs is private static; access via typecast for black-box testing.
  const parse = (attrs: string) =>
    (ActiveSession as unknown as {
      parseGitCommitAttrs(s: string): {
        commit_id: string;
        desc: string | null;
        files: string[];
      } | null;
    }).parseGitCommitAttrs(attrs);

  it("parses commit-id + desc + files in canonical order", () => {
    const r = parse(`commit-id="abc1234" desc="fix: 修复 foo" files="src/foo.ts,src/bar.ts"`);
    expect(r).not.toBeNull();
    expect(r!.commit_id).toBe("abc1234");
    expect(r!.desc).toBe("fix: 修复 foo");
    expect(r!.files).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("attribute order is irrelevant", () => {
    const r = parse(`files="a.ts,b.ts" desc="reorder test" commit-id="deadbee"`);
    expect(r).not.toBeNull();
    expect(r!.commit_id).toBe("deadbee");
    expect(r!.desc).toBe("reorder test");
    expect(r!.files).toEqual(["a.ts", "b.ts"]);
  });

  it("supports single-quoted values", () => {
    const r = parse(`commit-id='1234567' desc='single quote test' files='x.ts'`);
    expect(r!.commit_id).toBe("1234567");
    expect(r!.desc).toBe("single quote test");
    expect(r!.files).toEqual(["x.ts"]);
  });

  it("lowercases commit-id (git hashes are case-insensitive)", () => {
    const r = parse(`commit-id="ABCDEF1"`);
    expect(r!.commit_id).toBe("abcdef1");
  });

  it("rejects commit-id shorter than 7 chars", () => {
    expect(parse(`commit-id="abc123"`)).toBeNull(); // 6 chars
    expect(parse(`commit-id=""`)).toBeNull();
  });

  it("rejects commit-id with non-hex chars", () => {
    expect(parse(`commit-id="xyz1234"`)).toBeNull();
    expect(parse(`commit-id="abc!234"`)).toBeNull();
  });

  it("accepts full 64-char hash", () => {
    const full = "a".repeat(64);
    const r = parse(`commit-id="${full}"`);
    expect(r!.commit_id).toBe(full);
  });

  it("rejects commit-id longer than 64 chars", () => {
    const tooLong = "a".repeat(65);
    expect(parse(`commit-id="${tooLong}"`)).toBeNull();
  });

  it("desc is optional (commit-id-only marker)", () => {
    const r = parse(`commit-id="abc1234"`);
    expect(r!.desc).toBeNull();
    expect(r!.files).toEqual([]);
  });

  it("truncates desc longer than 512 chars", () => {
    const longDesc = "x".repeat(1000);
    const r = parse(`commit-id="abc1234" desc="${longDesc}"`);
    expect(r!.desc).not.toBeNull();
    expect(r!.desc!.length).toBe(512);
  });

  it("files: comma-separated, trim, filter empty strings", () => {
    const r = parse(`commit-id="abc1234" files=" a.ts ,, b.ts ,  ,c.ts "`);
    expect(r!.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("files: caps at 256 entries (defensive)", () => {
    const many = Array.from({ length: 300 }, (_, i) => `f${i}.ts`).join(",");
    const r = parse(`commit-id="abc1234" files="${many}"`);
    expect(r!.files.length).toBe(256);
  });

  it("files: missing attribute → empty array", () => {
    const r = parse(`commit-id="abc1234" desc="no files here"`);
    expect(r!.files).toEqual([]);
  });

  it("rejects empty attribute string (commit-id required)", () => {
    expect(parse("")).toBeNull();
  });
});

// Goal-driven loop 阶段 3 (D20, damo 2026-09-14 拍板) — ActiveSession 集成测试.
//   覆盖 plan §阶段 3 验收:
//     1) 构造函数解析 <goal> marker → this.goalText + task.metadata.goal_text
//     2) 无 marker → this.goalText = null, 原行为不变
//     3) D16 cap: 4KB 截断 + warning
//     4) runGoalGate → met (走原路径) / impossible (翻 failed) / not_yet_met (stub pushMessage)
//     5) gradeGoal 抛错 → 视为 not_yet_met (不阻断 task)
// 关注点:
//   - 不真跑 SDK, 也不真调 gradeGoal — mock 掉 goal-grader + llm-summarize.
//   - 翻 status 用 updateTaskStatus (集成函数, 跟 production 同款), 然后
//     getTaskById 读回断言. 不抽到 mockStatus — 这样能 catch SQL 漏写等真错.
//   - 漏洞 #13 (P2, 阶段 3 修): success → 调 grader → 还没 close → pushMessage
//     时序. runGoalGate 调用是 await, 但 pushMessage 在 success 拦截块后才
//     触发, 所以 session 还没 close. 这里测 stub 行为 = pushMessage(text, "system")
//     进了 this.pendingMessages, 不进 this.messageResolvers.

const gradeGoalMock = vi.hoisted(() => vi.fn());
const continueGoalLoopMock = vi.hoisted(() => vi.fn());

vi.mock("./goal-grader", () => ({
  gradeGoal: gradeGoalMock,
}));

// 阶段 4: 替换 continueGoalStub → 调真 continueGoalLoop. mock 这个出口测
//   active-session 的 continueGoalLoopDispatch 真把它调起来 (而不是 stub).
vi.mock("./agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("./agent-runtime")>(
    "./agent-runtime",
  );
  return {
    ...actual,
    continueGoalLoop: continueGoalLoopMock,
  };
});

function getGoalText(session: ActiveSession): string | null {
  // @ts-expect-error private field — 测试需要触达
  return session.goalText ?? null;
}

function makeTaskWithPrompt(prompt: string, autoApprove: 0 | 1 = 1): Task {
  const task = createTask({
    title: "goal-loop-test",
    prompt,
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb()
    .prepare(`UPDATE tasks SET owner_id = ?, auto_approve = ? WHERE id = ?`)
    .run(userId, autoApprove, task.id);
  return getTaskById(task.id)!;
}

describe("ActiveSession 阶段 3: goal marker 解析 (D20, 漏洞 #1 #10)", () => {
  it("prompt 含 <goal> → this.goalText 缓存 + task.metadata.goal_text 落库", () => {
    const task = makeTaskWithPrompt(
      "请把 README 第一段第一个词改成 bar.\n<goal>README 第一段第一个词是 bar</goal>",
    );
    const session = new ActiveSession(task);
    expect(getGoalText(session)).toBe("README 第一段第一个词是 bar");
    // 落库断言
    const after = getTaskById(task.id)!;
    const meta = after.metadata ? JSON.parse(after.metadata) : {};
    expect(meta.goal_text).toBe("README 第一段第一个词是 bar");
  });

  it("prompt 不含 marker → this.goalText = null, metadata 不写 goal_text", () => {
    const task = makeTaskWithPrompt("普通 task, 不带 marker");
    const session = new ActiveSession(task);
    expect(getGoalText(session)).toBeNull();
    // 不写 goal_text (caller 不依赖这个区分, 写不写都 ok — 但目前实现是只命中才写)
    const after = getTaskById(task.id)!;
    const meta = after.metadata ? JSON.parse(after.metadata) : {};
    expect(meta.goal_text).toBeUndefined();
  });

  it("D16 cap: goal marker > 4KB → 截断到 4096 字符", () => {
    const longGoal = "x".repeat(8000);
    const task = makeTaskWithPrompt(`改一下\n<goal>${longGoal}</goal>`);
    const session = new ActiveSession(task);
    const gt = getGoalText(session);
    expect(gt).not.toBeNull();
    expect(gt!.length).toBe(4096);
  });

  it("prompt 含 <config> 但没 <goal> → 不误伤 (漏洞 #1 P1)", () => {
    const task = makeTaskWithPrompt("请修改 <config> 块的 foo 字段");
    const session = new ActiveSession(task);
    expect(getGoalText(session)).toBeNull();
  });

  it("goal marker 空 (空内容 trim 后) → this.goalText = null (空 goal 不算命中)", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>   </goal>");
    const session = new ActiveSession(task);
    expect(getGoalText(session)).toBeNull();
  });
});

describe("ActiveSession 阶段 3: runGoalGate 三态 + 抛错兜底 (D20)", () => {
  it("gradeGoal met → 返回 met (走原 success 路径)", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "met",
      reason: "README 已改对",
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    const result = await session.runGoalGate();
    expect(result).toBe("met");
    expect(gradeGoalMock).toHaveBeenCalledTimes(1);
    // @ts-expect-error private
    expect(session.lastGoalGraderReason).toBe("README 已改对");
  });

  it("gradeGoal impossible → 返回 impossible (caller 翻 failed)", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "impossible",
      reason: "README 不存在, 无法改",
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    const result = await session.runGoalGate();
    expect(result).toBe("impossible");
  });

  it("gradeGoal not_yet_met → 返回 not_yet_met (caller 调 stub pushMessage)", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "not_yet_met",
      reason: "第一段还没动",
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    const result = await session.runGoalGate();
    expect(result).toBe("not_yet_met");
  });

  it("gradeGoal 抛错 (SDK fail / JSON 解析失败) → 视为 not_yet_met + reason 标 grader_error", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockRejectedValueOnce(new Error("grader_sdk_failed: network 502"));
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    const result = await session.runGoalGate();
    expect(result).toBe("not_yet_met");
    // @ts-expect-error private
    expect(session.lastGoalGraderReason).toMatch(/^grader_error: /);
  });

  it("this.goalText 为空 → 防御性直接返 met (caller 不应调到)", async () => {
    gradeGoalMock.mockReset();
    const task = makeTaskWithPrompt("无 marker 的 task");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    const result = await session.runGoalGate();
    expect(result).toBe("met");
    expect(gradeGoalMock).not.toHaveBeenCalled();
  });
});

describe("ActiveSession 阶段 3: failGoalUnreachable 翻 failed (impossible 终点)", () => {
  it("调用后 task 状态 = failed + error 含 goal_unreachable", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    // 模拟 running 状态 (setRunningFromReviewing 太复杂, 直接 setStatus)
    getDb()
      .prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`)
      .run(task.id);
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    session.failGoalUnreachable("goal_unreachable: 目标不可能达成");
    const after = getTaskById(task.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/goal_unreachable/);
  });
});

describe("ActiveSession 阶段 4: continueGoalLoopDispatch 替换 stub (D21)", () => {
  // 阶段 4 把阶段 3 的 continueGoalStub 替换为 continueGoalLoopDispatch.
  //   验证 dispatch 调真 continueGoalLoop (不是 stub), 并传 taskId / feedback /
  //   contextUsage 三个参数. 不验证 continueGoalLoop 内部逻辑 (那是
  //   continueGoalLoop.test.ts 的责任), 这里只验证 active-session 真把它调起来.

  beforeEach(() => {
    continueGoalLoopMock.mockReset();
    continueGoalLoopMock.mockResolvedValue({ action: "continue" });
  });

  it("调 dispatch → 触发真 continueGoalLoop (非 stub, 非 pushMessage)", async () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    session.lastGoalGraderReason = "第一段还没动";
    // @ts-expect-error private
    await session.continueGoalLoopDispatch(
      "[goal grader] 目标尚未达成, 请根据以上反馈继续推进。",
      { contextTokens: 100, contextMax: 1000 },
    );
    // 验证 continueGoalLoop 被调 (mock) — 不再调 stub
    expect(continueGoalLoopMock).toHaveBeenCalledTimes(1);
    const callArgs = continueGoalLoopMock.mock.calls[0]!;
    expect(callArgs[0]).toBe(task.id); // taskId
    expect(callArgs[1]).toContain("目标尚未达成"); // feedback
    expect(callArgs[2]).toEqual({ contextTokens: 100, contextMax: 1000 }); // ctx
    // stub 不再存在 → 直接调 stub 应该不存在 (sanity check)
    expect((session as unknown as { continueGoalStub?: unknown }).continueGoalStub).toBeUndefined();
  });

  it("dispatch 写入 cost log (cost_usd + goal_grader_reason, 跟 stub 阶段对齐)", async () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    session.lastGoalGraderReason = "第一段还没动";
    // @ts-expect-error private
    session.costUsd = 1.23; // 模拟累计 cost
    // @ts-expect-error private
    await session.continueGoalLoopDispatch(
      "[goal grader] 反馈",
      { contextTokens: 100, contextMax: 1000 },
    );
    // continueGoalLoop 已被调
    expect(continueGoalLoopMock).toHaveBeenCalledTimes(1);
  });

  it("fork 决策 → 父 session 关闭 + task 翻 paused (释放 cwd 防 fork 排队死锁)", async () => {
    // 2026-10-14 实证 (task 0955d855): fork 路径以前不关父 session, 父继续占
    //   cwd 锁 (parallel_limit=1), fork 永远 queued. 修复: fork 决策后父翻
    //   paused (可 resume) + close 释放 generator.
    continueGoalLoopMock.mockResolvedValue({
      action: "fork",
      newTaskId: "new-task-id",
      newSessionId: "new-session-id",
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    updateTaskStatus(task.id, "running"); // 模拟父任务在跑
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    session.lastGoalGraderReason = "第一段还没动";
    // @ts-expect-error private
    await session.continueGoalLoopDispatch(
      "[goal grader] 反馈",
      { contextTokens: 900, contextMax: 1000 },
    );
    expect(getTaskById(task.id)!.status).toBe("paused");
    // session 已关闭 → generator 退出 → scheduler onTaskDone 释放 cwd
    // @ts-expect-error private
    expect(session.closed).toBe(true);
  });

  it("giveUp 决策 → 不重复翻状态 (continueGoalLoop 内部已翻 failed), session 不关", async () => {
    continueGoalLoopMock.mockResolvedValue({ action: "giveUp", reason: "max rounds" });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    updateTaskStatus(task.id, "running");
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    session.lastGoalGraderReason = "第一段还没动";
    // @ts-expect-error private
    await session.continueGoalLoopDispatch(
      "[goal grader] 反馈",
      { contextTokens: 100, contextMax: 1000 },
    );
    // giveUp 由 continueGoalLoop 内部翻 failed, dispatch 不动 status
    expect(getTaskById(task.id)!.status).toBe("running");
    // @ts-expect-error private
    expect(session.closed).toBe(false);
  });
});

describe("ActiveSession 阶段 4: runGoalGate 漏洞 #4 cost 归因 (D21)", () => {
  // 阶段 4 runGoalGate 在拿到 gradeGoal result 后:
  //   - 累加 r.costUsd 到 this.costUsd (session 累计)
  //   - logEvent "cost" + cost_attribution=goal_grader
  // 验证 gradeGoal 返回 costUsd > 0 时, session 累计 + logEvent 都正确.

  beforeEach(() => {
    gradeGoalMock.mockReset();
    continueGoalLoopMock.mockReset();
    continueGoalLoopMock.mockResolvedValue({ action: "continue" });
  });

  it("grader costUsd > 0 → 累加到 session.costUsd + logEvent cost_attribution=goal_grader", async () => {
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "not_yet_met",
      reason: "第一段还没动",
      model: "claude-haiku-test",
      durationMs: 200,
      costUsd: 0.005, // grader 自身 cost
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    const before = session.costUsd;
    // @ts-expect-error private
    await session.runGoalGate();
    // 累计
    // @ts-expect-error private
    expect(session.costUsd).toBe(before + 0.005);
  });

  it("grader costUsd = 0 → 不累加 (保持原值) + logEvent cost_attribution 仍写", async () => {
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "met",
      reason: "OK",
      model: "claude-haiku-test",
      durationMs: 100,
      costUsd: 0, // 阶段 2 占位 0
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    const before = session.costUsd;
    // @ts-expect-error private
    await session.runGoalGate();
    // 0 不累加
    // @ts-expect-error private
    expect(session.costUsd).toBe(before);
  });

  it("gradeGoal 抛错 → 视为 not_yet_met + 不写 cost log (无 r 可读)", async () => {
    gradeGoalMock.mockRejectedValueOnce(new Error("grader_sdk_failed: 502"));
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(getTaskById(task.id)!);
    // @ts-expect-error private
    const before = session.costUsd;
    // @ts-expect-error private
    const verdict = await session.runGoalGate();
    expect(verdict).toBe("not_yet_met");
    // 抛错不累加 cost
    // @ts-expect-error private
    expect(session.costUsd).toBe(before);
    // @ts-expect-error private
    expect(session.lastGoalGraderReason).toMatch(/^grader_error: /);
  });
});

// Goal-driven loop D28: grader 改用 agent self-report 替代 transcript 截断.
//   根因: D27 demo 暴露 case 1/case 2 agent 真写了文件 (goal 完美匹配), 但
//   grader 永远判 not_yet_met —— summarizeTranscriptForGrader 是 4KB 字符串截断,
//   Write/Bash content 字段不在截断范围内, grader 看不到写文件证据.
//   方案 c+d: 让 agent 自报告 (c) + grader 直接看 self-report 而非 transcript (d).
//
// 🆕 D29 重大变更: self-report 提醒从「success 后 pushMessage」改为「拼到首轮
//   prompt 头部」. D28 旧路径失灵: success 时 session 已收尾, push 进 pendingMessages
//   的 reminder 没人读 → grader 拿 success resultText 找不到 goal_report 块
//   → fallback transcriptSummary → 仍判 not_yet_met (case1 D28 实证: 5 轮 →
//   failed, cost=$1.04). 新设计: start() 时 goalSelfReportPromptPrefix() 返回
//   reminder, 拼到 head (跟 modelGuidanceReminder 同源), agent 第一轮 query
//   就看到 → 收尾 resultText 自带 ```goal_report``` → grader 主依据拿到 → met.
//
// 验证 4 个核心行为:
//   1) goalSelfReportPromptPrefix: goal marker 存在时返回 reminder 字符串
//      含三态格式示例 (done/not_done/impossible), flag 置 true.
//   2) 第二次调用返回 null (flag 防重入, 不重投).
//   3) runGoalGate 从 latestResultText 提取 ```goal_report\n[内容]\n``` 块作为 selfReport
//      传给 gradeGoal —— caller 不再用 4KB 截断 transcript.
//   4) selfReport 缺失 (agent 没写 goal_report 块) → gradeGoal 拿到空 selfReport,
//      但 caller 仍传 transcriptSummary 作 fallback (旧路径保留).
// + edge:
//   - 无 goal marker → prefix 返回 null, flag 保持 false.
//   - start() 拼接 head 时 reminder 出现在首轮 prompt (verify 整链路).
//   - gradeGoal 抛错 → 行为不变 (视为 not_yet_met), 不影响 self-report 注入路径.

describe("ActiveSession D34: success 路径前置 self-report 缺失检测 (替换 D29 拼 head)", () => {
  it("goalSelfReportNudgeText: 不含完整 fence 范例 (避免 GOAL_REPORT_RE 自抓)", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    const nudge = session.goalSelfReportNudgeText(1);
    // 含 system-reminder 包裹
    expect(nudge).toContain("<system-reminder>");
    // 含三态首词 (明列, 不在 fence 里)
    expect(nudge).toContain("done");
    expect(nudge).toContain("not_done");
    expect(nudge).toContain("impossible");
    // 含「第 N / MAX 次」 体感
    expect(nudge).toContain("第 1 /");
    // 关键: 不含完整 fence 范例 (否则 GOAL_REPORT_RE 自抓)
    expect(nudge).not.toMatch(/```goal_report\s*\n/);
    expect(nudge).not.toMatch(/```goal_report\n\[done\|not_done\|impossible\]/);
  });

  it("checkGoalSelfReportOrNudge: resultText 含 goal_report 块 → 不 nudge, 返 'proceed'", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    const resultText = `已改完.

\`\`\`goal_report
done
Write README.md
bar 是第一段第一个词
\`\`\``;
    // @ts-expect-error protected
    const action = session.checkGoalSelfReportOrNudge(resultText);
    expect(action).toBe("proceed");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(0);
    // @ts-expect-error private
    expect(session.pendingMessages.length).toBe(0);
  });

  it("checkGoalSelfReportOrNudge: resultText 缺块 + nudges=0 → pushMessage + nudges=1 + 返 'nudge'", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    const resultText = "已尝试修改, 不知道改对没.";
    // @ts-expect-error protected
    const action = session.checkGoalSelfReportOrNudge(resultText);
    expect(action).toBe("nudge");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(1);
    // pushMessage 进了 pendingMessages
    // @ts-expect-error private
    expect(session.pendingMessages.length).toBe(1);
    // @ts-expect-error private
    const nudged = session.pendingMessages[0] as string;
    // 含三态首词 (告知 agent 格式)
    expect(nudged).toContain("done");
    expect(nudged).toContain("not_done");
    expect(nudged).toContain("impossible");
    // 不含完整 fence 范例 (regex 自抓防护)
    expect(nudged).not.toMatch(/```goal_report\s*\n/);
    // 含「第 1 / 3」 体感
    expect(nudged).toContain("第 1 / 3");
  });

  it("checkGoalSelfReportOrNudge: nudges=MAX-1 (即2) → 再 nudge 一次 (nudges=3=MAX)", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // 先模拟 2 次 nudge (nudges=MAX-1=2)
    // @ts-expect-error private
    session.goalSelfReportNudges = ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES - 1;
    const resultText = "第二轮: 仍没写 block.";
    // @ts-expect-error protected
    const action = session.checkGoalSelfReportOrNudge(resultText);
    // 仍 nudge (3 次 = MAX 是边界, 但 MAX 是「用尽后停止」的下一次检查门槛)
    //   nudges=0,1,2 触发; nudges=3 (= MAX) 不触发.
    expect(action).toBe("nudge");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES);
    // @ts-expect-error private
    expect(session.pendingMessages.length).toBe(1);
  });

  it("checkGoalSelfReportOrNudge: nudges=MAX (即3) → 走 grader 兜底 (返 'proceed')", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // 已 nudge 用尽
    // @ts-expect-error private
    session.goalSelfReportNudges = ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES;
    const resultText = "第 4 轮: 还是没写.";
    // @ts-expect-error protected
    const action = session.checkGoalSelfReportOrNudge(resultText);
    // nudges 已达 MAX → 不再触发, 走原 grader 路径
    expect(action).toBe("proceed");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(ActiveSession.MAX_GOAL_SELF_REPORT_NUDGES);
    // @ts-expect-error private
    expect(session.pendingMessages.length).toBe(0);
  });

  it("checkGoalSelfReportOrNudge: 无 goal marker → 永远 'proceed'", () => {
    const task = makeTaskWithPrompt("不带 marker 的 task");
    const session = new ActiveSession(task);
    const resultText = "随便写点东西";
    // @ts-expect-error protected
    const action = session.checkGoalSelfReportOrNudge(resultText);
    expect(action).toBe("proceed");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(0);
    // @ts-expect-error private
    expect(session.pendingMessages.length).toBe(0);
  });

  it("D34 反向断言: start() 不再拼 reminder 到 prompt 头部", () => {
    // 验证 start() 拼的 head 不再包含 D29 旧 reminder 内容 (防止回滚时被覆盖).
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // 模拟 start() 拼 head: 仅 guidance + platformDoc (D34 已删 goalReminder).
    // @ts-expect-error private
    const guidance = session.modelGuidanceReminder();
    // @ts-expect-error private
    const platformDoc = session.platformDocsReminder();
    const head = [guidance, platformDoc]
      .filter((s): s is string => !!s)
      .join("\n\n");
    // D29 旧 reminder 内容不该出现 (D34 已删)
    expect(head).not.toContain("[Goal-Loop 自我报告请求]");
    // 不含完整 fence 范例 (跟 nudgeText 一致约束, 避免污染)
    expect(head).not.toMatch(/```goal_report\n\[done\|not_done\|impossible\]/);
    // 不含 D29 旧 prompt 的关键词 (D34 已删)
    expect(head).not.toContain("你即将结束本轮");
  });

  it("warnMissingGoalSelfReport: 写 logEvent + emitEvent (DB audit 留痕)", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // logEvent 是 protected, emitEvent 是 private, 测会调用但不强断言具体数据
    // (避免 mock logEvent/emitEvent 复杂 setup; 改测 nudges 累加 + pendingMessages 触发)
    // @ts-expect-error private
    session.goalSelfReportNudges = 1;
    const resultText = "缺 block.";
    // @ts-expect-error protected
    const action = session.checkGoalSelfReportOrNudge(resultText);
    expect(action).toBe("nudge");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(2);
  });
});

describe("ActiveSession D28: runGoalGate 提取 self-report + 透传给 gradeGoal (d 方案)", () => {
  it("latestResultText 含 goal_report 块 → 提取作为 selfReport + transcriptSummary 不传 (有 self-report 时)", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "met",
      reason: "self-report done 且内容匹配",
      model: "claude-haiku-test",
      durationMs: 50,
      costUsd: 0,
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    const resultText = `已改完 README.

\`\`\`goal_report
done
Write README.md
路径: README.md
内容: bar 是第一段第一个词
\`\`\`

收尾.`;
    // @ts-expect-error private
    await session.runGoalGate(resultText);
    // gradeGoal 拿到 selfReport (从 goal_report 块提取的内容)
    expect(gradeGoalMock).toHaveBeenCalledTimes(1);
    const callArgs = gradeGoalMock.mock.calls[0]![0];
    expect(callArgs.selfReport).toContain("done");
    expect(callArgs.selfReport).toContain("Write README.md");
    expect(callArgs.selfReport).toContain("bar 是第一段第一个词");
    // transcriptSummary 在有 self-report 时不传 (active-session 已判定用主依据)
    expect(callArgs.transcriptSummary).toBeUndefined();
    // goalText 仍传
    expect(callArgs.goalText).toBe("README 第一个词是 bar");
  });

  it("latestResultText 无 goal_report 块 → selfReport 空 + transcriptSummary 作 fallback", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "not_yet_met",
      reason: "信息不足",
      model: "claude-haiku-test",
      durationMs: 50,
      costUsd: 0,
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // agent 没写 goal_report 块 (但 runGoalGate 仍要从 SDK 拉 transcript 走 fallback)
    const resultText = "已尝试修改, 不知道改对没改对.";
    // @ts-expect-error private
    await session.runGoalGate(resultText);
    expect(gradeGoalMock).toHaveBeenCalledTimes(1);
    const callArgs = gradeGoalMock.mock.calls[0]![0];
    expect(callArgs.selfReport).toBe("");
    // transcriptSummary 仍传 (fallback)
    expect(callArgs.transcriptSummary).toBeDefined();
    expect(typeof callArgs.transcriptSummary).toBe("string");
  });

  it("latestResultText 是空字符串 → selfReport 空 + transcriptSummary 仍 fallback", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "not_yet_met",
      reason: "信息不足",
      model: "claude-haiku-test",
      durationMs: 50,
      costUsd: 0,
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // @ts-expect-error private
    await session.runGoalGate("");
    const callArgs = gradeGoalMock.mock.calls[0]![0];
    expect(callArgs.selfReport).toBe("");
    expect(callArgs.transcriptSummary).toBeDefined();
  });

  it("latestResultText 含多个 goal_report 块 → 只取第一个 (non-greedy 闭包)", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "met",
      reason: "ok",
      model: "claude-haiku-test",
      durationMs: 50,
      costUsd: 0,
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    const resultText = `第一次报告:
\`\`\`goal_report
done
Write README.md
路径: README.md
内容: bar 是第一段第一个词
\`\`\`

后来又写了一个:
\`\`\`goal_report
done
第二次报告
\`\`\``;
    // @ts-expect-error private
    await session.runGoalGate(resultText);
    const callArgs = gradeGoalMock.mock.calls[0]![0];
    // 只取第一个 — "bar 是第一段第一个词" 不该被吞
    expect(callArgs.selfReport).toContain("bar 是第一段第一个词");
    expect(callArgs.selfReport).not.toContain("第二次报告");
  });

  it("goal_report 块含前后空格 → trim 后传 (跟 caller 写法一致)", async () => {
    gradeGoalMock.mockReset();
    gradeGoalMock.mockResolvedValueOnce({
      verdict: "met",
      reason: "ok",
      model: "claude-haiku-test",
      durationMs: 50,
      costUsd: 0,
    });
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    const resultText = `\`\`\`goal_report

done
内容

\`\`\``;
    // @ts-expect-error private
    await session.runGoalGate(resultText);
    const callArgs = gradeGoalMock.mock.calls[0]![0];
    // 前后空行被 trim
    expect(callArgs.selfReport.startsWith("done")).toBe(true);
    expect(callArgs.selfReport.endsWith("内容")).toBe(true);
  });

  it("D34 集成: 多轮 nudge 计数累加 (取代 D29 flag 防重入)", () => {
    // D34 设计: goalSelfReportNudges 累加到 MAX_GOAL_SELF_REPORT_NUDGES (=3) 后停止 nudge,
    //   走 grader 路径兜底. 不同于 D29 flag 锁死一次性注入 (该方案污染中间轮输出).
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    const resultText = "缺 block.";

    // 第 1 轮: nudges 0→1
    // @ts-expect-error protected
    expect(session.checkGoalSelfReportOrNudge(resultText)).toBe("nudge");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(1);

    // 第 2 轮: nudges 1→2
    // @ts-expect-error protected
    expect(session.checkGoalSelfReportOrNudge(resultText)).toBe("nudge");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(2);

    // 第 3 轮: nudges 2→3 (=MAX, 仍触发)
    // @ts-expect-error protected
    expect(session.checkGoalSelfReportOrNudge(resultText)).toBe("nudge");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(3);

    // 第 4 轮: nudges 已达 MAX → 返 'proceed' (走 grader 兜底)
    // @ts-expect-error protected
    expect(session.checkGoalSelfReportOrNudge(resultText)).toBe("proceed");
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(3); // 不再自增

    // pendingMessages 应有 3 条 (前 3 轮 nudge 各 push 1 条)
    // @ts-expect-error private
    expect(session.pendingMessages.length).toBe(3);
  });

  it("D34 反向断言: 旧字段 _goalSelfReportInjected 已不存在", () => {
    const task = makeTaskWithPrompt("改 README\n<goal>README 第一个词是 bar</goal>");
    const session = new ActiveSession(task);
    // D29 的 _goalSelfReportInjected flag 已删 (D34 不需要一次性防重入)
    expect((session as unknown as Record<string, unknown>)._goalSelfReportInjected).toBeUndefined();
    // D29 的 goalSelfReportPromptPrefix 方法也已删
    expect((session as unknown as Record<string, unknown>).goalSelfReportPromptPrefix).toBeUndefined();
    // D34 新字段 goalSelfReportNudges 存在, 初值 0
    // @ts-expect-error private
    expect(session.goalSelfReportNudges).toBe(0);
  });
});
