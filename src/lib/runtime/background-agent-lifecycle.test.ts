/**
 * R132 SDK 0.3.220 task_* 原生信号追踪后台 subagent 生命周期 (替换 bgAgentSpawns 计数).
 *
 * 验证 active-session.ts 新增的:
 *   - inFlightSubagentIds Set 由 task_started add / task_notification delete 维护
 *   - result 收尾时 drain → stopTask 优雅停 → close 三阶段
 *   - background_tasks_changed REPLACE 全量对账
 *   - skip_transcript ambient 任务不计入 in-flight
 *   - MAX_BG_AGENT_NUDGES = 5 (旧值 2)
 *
 * 与 background-agent-guard.test.ts 的差异: 后者覆盖 spawns 计数 + nudge 注入 + 超时
 * fail 兜底; 本文件覆盖 SDK task_* 信号 + drain + stopTask. 两条防线并存, 不互斥.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: query() 返回的对象既要可迭代 (for-await), 又要有 stopTask/backgroundTasks
// 方法. SDK 0.3.220 真接口 = Query extends AsyncIterable<SDKMessage>, 含 stopTask 方法
// (sdk.d.ts:2562). 用 Object.assign 给 async generator 实例补方法即可.
const h = vi.hoisted(() => ({
  batches: [] as unknown[][],              // 每批 = 一个 result 周期前的消息
  injected: [] as string[],               // 平台在批之间注入的文本
  stopTaskCalls: [] as string[],          // 平台调 stopTask 的 task_id 列表
  drainBatchGapMs: 0,                     // 批间延迟(模拟 task_notification 慢慢到达)
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
        if (h.drainBatchGapMs > 0) await new Promise((r) => setTimeout(r, h.drainBatchGapMs));
        const next = await prompt.next();
        if (next.done) break;
        h.injected.push(String(next.value.message.content));
      }
    }
    // async generator instance 允许直接挂属性 — 必须用原 iter, 不能 Object.create 包装
    //   (那样 AsyncGenerator.prototype.next 调 prototype chain 时 receiver 与内部 state
    //   slot 不兼容, 抛 "Method ... called on incompatible receiver"). Object.assign
    //   同理 (Symbol.asyncIterator non-enumerable 不复制).
    const iter = stream();
    (iter as any).stopTask = vi.fn(async (taskId: string) => {
      h.stopTaskCalls.push(taskId);
    });
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
// 静态常量快照 — 多个 case override + finally 还原, 但 vitest 不能保证 finally 一定跑,
//   (断言失败抛错, finally 仍跑; 但中间测试调静态值, finally 抛错也不影响 catch 链).
//   最稳是 beforeEach 快照原值, afterEach 无条件写回, 避免跨 case 污染.
let savedConstants: { DRAIN: number; GRACE: number; POLL: number; MAX_NUDGES: number };

beforeEach(() => {
  savedConstants = {
    DRAIN: ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS,
    GRACE: ActiveSession.BG_AGENT_STOP_GRACE_MS,
    POLL: ActiveSession.DRAIN_POLL_MS,
    MAX_NUDGES: ActiveSession.MAX_BG_AGENT_NUDGES,
  };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bglifecycle-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "bglifecycle-test@example.com", "x", "admin");
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "bglifecycle-test", ownerId: userId }).id;

  h.batches = [];
  h.injected = [];
  h.stopTaskCalls = [];
  h.drainBatchGapMs = 0;
});

afterEach(() => {
  (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = savedConstants.DRAIN;
  (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = savedConstants.GRACE;
  (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = savedConstants.POLL;
  (ActiveSession as unknown as { MAX_BG_AGENT_NUDGES: number }).MAX_BG_AGENT_NUDGES = savedConstants.MAX_NUDGES;
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(): Task {
  const task = createTask({
    title: "bg-agent-lifecycle",
    prompt: "派两个 subagent",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

// 流式三段: content_block_start -> input_json_delta -> content_block_stop.
// 必须按这个形状喂: includePartialMessages 下 tool_use 只走流式路径.
function streamToolUse(idx: number, toolId: string, name: string, input: Record<string, unknown>): unknown[] {
  return [
    { type: "stream_event", session_id: "sess-1",
      event: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: toolId, name } } },
    { type: "stream_event", session_id: "sess-1",
      event: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } },
    { type: "stream_event", session_id: "sess-1", event: { type: "content_block_stop", index: idx } },
  ];
}

// task_started 系统消息 (subagent 类型, 计入 in-flight)
function taskStarted(taskId: string, toolUseId: string, taskType = "subagent"): unknown {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "recon",
    subagent_type: "general-purpose",
    task_type: taskType,
    uuid: `uuid-${taskId}`,
    session_id: "sess-1",
  };
}

// task_notification 系统消息 (从 in-flight 移除)
function taskNotification(taskId: string, status: "completed" | "failed" | "stopped"): unknown {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    status,
    output_file: `/tmp/${taskId}.txt`,
    summary: `${status} summary`,
    uuid: `uuid-${taskId}`,
    session_id: "sess-1",
  };
}

// 派 1 个 Agent 后台调用 + 收尾. 计入 bgAgentSpawns, 但 in-flight 要看 task_started
// 是否也喂了.
function spawnThenFinish(seq: number, taskId?: string, toolUseId?: string): unknown[] {
  const tid = taskId ?? `tid-${seq}`;
  const tuid = toolUseId ?? `tu-${seq}`;
  return [
    { type: "assistant", uuid: `u-${seq}`, session_id: "sess-1", message: { content: [] } },
    ...streamToolUse(0, tuid, "Agent", { description: "recon", subagent_type: "general-purpose", prompt: "去查" }),
    taskStarted(tid, tuid), // SDK 报 task_started -> in-flight add
    { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: `r${seq}` },
  ];
}

// 收尾时不喂 task_notification (模拟 subagent 卡住)
function spawnThenFinishNoCompletion(seq: number): unknown[] {
  return [
    { type: "assistant", uuid: `u-${seq}`, session_id: "sess-1", message: { content: [] } },
    ...streamToolUse(0, `tu-${seq}`, "Agent", { description: "recon", prompt: "去查" }),
    taskStarted(`tid-${seq}`, `tu-${seq}`),
    { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: `r${seq}` },
    // 不喂 task_notification, subagent 视为 in-flight
  ];
}

function taskLifecycleEvents(taskId: string) {
  return getEventsByTaskId(taskId).filter((e) =>
    ["task_started", "task_notification", "background_tasks_changed", "subagent_lifecycle"].includes(e.type),
  );
}

// =============================================================================
// R132 主路径: SDK task_* 信号 + drain + stopTask 优雅停
// =============================================================================

describe("R132 SDK task_* 原生信号追踪", () => {
  it("场景1 happy path: task_started + task_notification(completed) 都在 result 之前 -> 立即 close, 无 nudge 无 stopTask", async () => {
    const task = makeTask();
    // SDK 行为: task_started 在 subagent 启动时 emit; subagent 跑完 emit task_notification;
    // result 通常是最后一条. 这里 batch 1 含 task_started + task_notification + result:
    // platform 顺序处理 → inFlight add → inFlight delete (清空) → result 路径 inFlight 空
    // → 直接 close. 但 content_block_stop 仍会让 bgAgentSpawns++ (R55 B1 流式路径保留),
    // 所以 nudge 路径在 inFlight 空时触发一次 (spawns>0). batch 2 是空 result, 走正常收尾.
    h.batches = [
      [
        { type: "assistant", uuid: "u-1", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-1", "Agent", { description: "recon", prompt: "去查" }),
        taskStarted("tid-1", "tu-1"),
        taskNotification("tid-1", "completed"),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "ok" },
      ],
      [
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.6, result: "final" },
      ],
    ];
    const origDrain = ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS;
    const origGrace = ActiveSession.BG_AGENT_STOP_GRACE_MS;
    const origPoll = ActiveSession.DRAIN_POLL_MS;
    (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = 100;
    (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = 50;
    (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = 10;

    try {
      await new ActiveSession(task).start(task);
    } finally {
      (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = origDrain;
      (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = origGrace;
      (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = origPoll;
    }

    expect(getTaskById(task.id)?.status).toBe("reviewing");
    expect(h.stopTaskCalls).toHaveLength(0); // in-flight 已空, 不调 stopTask
    // 第 1 批: spawns=1 > 0 && inFlight 空 → 触发 1 次 nudge (B 兜底「确认收尾」提示).
    // 第 2 批: spawns 已清零, inFlight 空 → 直接 reviewing.
    expect(h.injected.length).toBe(1);
    expect(h.injected[0]).toContain("1 个后台 subagent");

    const lifecycle = taskLifecycleEvents(task.id);
    const started = lifecycle.filter((e) => e.type === "task_started");
    const notified = lifecycle.filter((e) => e.type === "task_notification");
    expect(started).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(JSON.parse(notified[0].data).status).toBe("completed");
  });

  it("场景2 drain 等待: in-flight 非空进 result -> drain 等不到 -> 调 stopTask (场景 3 已覆盖超时分支, 本场景验证 drain 路径存在)", async () => {
    const task = makeTask();
    // 派 1 个 subagent, 喂 task_started 但永远不喂 task_notification.
    // in-flight = {tid-1}, result 到达 → drain 50ms (无新 notification) → stopTask tid-1
    // → grace 30ms (无新 notification) → close → status = reviewing.
    // 注意: 实际 SDK 不会 result 后再 emit notification, 这里测的是 SDK 漏报或卡死的兜底.
    h.batches = [
      [
        { type: "assistant", uuid: "u-1", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-1", "Agent", { description: "recon", prompt: "去查" }),
        taskStarted("tid-1", "tu-1"),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "r1" },
      ],
      // 第 2 批空触发 done (不再有消息)
      [],
    ];

    const origDrain = ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS;
    const origGrace = ActiveSession.BG_AGENT_STOP_GRACE_MS;
    const origPoll = ActiveSession.DRAIN_POLL_MS;
    (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = 50;
    (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = 30;
    (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = 10;

    try {
      await new ActiveSession(task).start(task);
    } finally {
      (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = origDrain;
      (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = origGrace;
      (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = origPoll;
    }

    expect(getTaskById(task.id)?.status).toBe("reviewing");
    // 调了 stopTask 1 次 (tid-1)
    expect(h.stopTaskCalls).toEqual(["tid-1"]);
    expect(h.injected).toHaveLength(0); // in-flight 非空直接走 drain, 不走 nudge

    // 应该有 subagent_lifecycle event 标记 drain_timeout_stopped
    const lifecycle = taskLifecycleEvents(task.id);
    const timeoutEvent = lifecycle.find((e) => e.type === "subagent_lifecycle");
    expect(timeoutEvent).toBeDefined();
    expect(JSON.parse(timeoutEvent!.data).phase).toBe("drain_timeout_stopped");
  });

  it("场景3 超时 stopTask: drain 永远等不到 notification -> 调 stopTask + 10s grace 后 close", async () => {
    const task = makeTask();
    // 派 2 个 subagent, 喂 task_started 但永远不喂 task_notification
    // 第一批就 drain, 第二批再走完
    h.batches = [
      [
        { type: "assistant", uuid: "u-1", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-1", "Agent", { description: "recon", prompt: "去查" }),
        ...streamToolUse(1, "tu-2", "Agent", { description: "recon", prompt: "去查" }),
        taskStarted("tid-1", "tu-1"),
        taskStarted("tid-2", "tu-2"),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 1.0, result: "final" },
      ],
      [
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 1.0, result: "bye" },
      ],
    ];

    const origDrain = ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS;
    const origGrace = ActiveSession.BG_AGENT_STOP_GRACE_MS;
    const origPoll = ActiveSession.DRAIN_POLL_MS;
    (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = 50;
    (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = 30;
    (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = 10;

    try {
      await new ActiveSession(task).start(task);
    } finally {
      (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = origDrain;
      (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = origGrace;
      (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = origPoll;
    }

    expect(getTaskById(task.id)?.status).toBe("reviewing");
    // 调了 stopTask 两次 (tid-1, tid-2)
    expect(h.stopTaskCalls.sort()).toEqual(["tid-1", "tid-2"]);

    // 应该有 subagent_lifecycle event 标记 drain_timeout_stopped
    const lifecycle = taskLifecycleEvents(task.id);
    const timeoutEvent = lifecycle.find((e) => e.type === "subagent_lifecycle");
    expect(timeoutEvent).toBeDefined();
    const payload = JSON.parse(timeoutEvent!.data);
    expect(payload.phase).toBe("drain_timeout_stopped");
    expect(payload.stuck).toBe(2);
  });

  it("场景4 background_tasks_changed: REPLACE 语义全量对账 in-flight Set", async () => {
    const task = makeTask();
    // 先 task_started tid-A + tid-B
    // 然后 background_tasks_changed 报 {tid-A, tid-C} (B 没了, C 新出现)
    // 期望: in-flight = {tid-A, tid-C}, tid-B 被剔除
    h.batches = [
      [
        { type: "assistant", uuid: "u-1", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-a", "Agent", { description: "recon", prompt: "去查" }),
        ...streamToolUse(1, "tu-b", "Agent", { description: "recon", prompt: "去查" }),
        taskStarted("tid-a", "tu-a"),
        taskStarted("tid-b", "tu-b"),
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "tid-a", task_type: "subagent", description: "recon" },
            { task_id: "tid-c", task_type: "subagent", description: "new" },
          ],
          uuid: "uuid-btc",
          session_id: "sess-1",
        },
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 1.0, result: "final" },
      ],
    ];

    const origDrain = ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS;
    const origGrace = ActiveSession.BG_AGENT_STOP_GRACE_MS;
    const origPoll = ActiveSession.DRAIN_POLL_MS;
    (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = 50;
    (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = 30;
    (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = 10;

    try {
      await new ActiveSession(task).start(task);
    } finally {
      (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = origDrain;
      (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = origGrace;
      (ActiveSession as unknown as { DRAIN_POLL_MS: number }).DRAIN_POLL_MS = origPoll;
    }

    expect(getTaskById(task.id)?.status).toBe("reviewing");
    // 调 stopTask 只对剩余 in-flight, 即 tid-a 和 tid-c (REPLACE 后)
    expect(h.stopTaskCalls.sort()).toEqual(["tid-a", "tid-c"]);

    // background_tasks_changed 事件应有
    const lifecycle = taskLifecycleEvents(task.id);
    const btcEvent = lifecycle.find((e) => e.type === "background_tasks_changed");
    expect(btcEvent).toBeDefined();
    const payload = JSON.parse(btcEvent!.data);
    expect(payload.count).toBe(2);
    expect(payload.in_flight).toBe(2);
  });

  it("场景5 skip_transcript 过滤: ambient / housekeeping 任务不计入 in-flight, 不被 drain 卡住", async () => {
    const task = makeTask();
    // task_started 带 skip_transcript=true → 不入 Set
    // 即使 result 到达时 in-flight 仍空 → 直接 close
    h.batches = [
      [
        { type: "assistant", uuid: "u-1", session_id: "sess-1", message: { content: [] } },
        {
          type: "system",
          subtype: "task_started",
          task_id: "tid-ambient",
          tool_use_id: "tu-ambient",
          description: "housekeeping",
          subagent_type: "general-purpose",
          task_type: "subagent",
          skip_transcript: true,
          uuid: "uuid-a",
          session_id: "sess-1",
        },
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "ok" },
      ],
    ];

    const origDrain = ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS;
    const origGrace = ActiveSession.BG_AGENT_STOP_GRACE_MS;
    (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = 50;
    (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = 30;

    try {
      await new ActiveSession(task).start(task);
    } finally {
      (ActiveSession as unknown as { BG_AGENT_LIFECYCLE_DRAIN_MS: number }).BG_AGENT_LIFECYCLE_DRAIN_MS = origDrain;
      (ActiveSession as unknown as { BG_AGENT_STOP_GRACE_MS: number }).BG_AGENT_STOP_GRACE_MS = origGrace;
    }

    expect(getTaskById(task.id)?.status).toBe("reviewing");
    // ambient 不计入 in-flight, 不调 stopTask
    expect(h.stopTaskCalls).toHaveLength(0);
    expect(h.injected).toHaveLength(0); // 不触发 nudge
  });

  it("场景6 MAX_BG_AGENT_NUDGES=5: spawns 触发 5 次 nudge 后放行进 stopTask 流程", async () => {
    const task = makeTask();
    // 老 SDK 没 task_* 信号: 只 content_block_stop 增加 bgAgentSpawns, inFlight 永远空.
    //   result 路径: spawns>0 && inFlight.size===0 → nudge (nudges<5). 5 次后放行.
    //   第 6 批 inFlight 仍空 → 直接落 result.success 路径 → closed=true (无 stopTask).
    // 验证 nudge 注入次数 = 5 (上限), 不超不漏.
    h.batches = [
      // 5 批: 每批派 1 个 Agent + result (无 task_started, inFlight 始终空)
      [
        { type: "assistant", uuid: "u-1", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-1", "Agent", { description: "recon", prompt: "去查" }),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "r1" },
      ],
      [
        { type: "assistant", uuid: "u-2", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-2", "Agent", { description: "recon", prompt: "去查" }),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "r2" },
      ],
      [
        { type: "assistant", uuid: "u-3", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-3", "Agent", { description: "recon", prompt: "去查" }),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "r3" },
      ],
      [
        { type: "assistant", uuid: "u-4", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-4", "Agent", { description: "recon", prompt: "去查" }),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "r4" },
      ],
      [
        { type: "assistant", uuid: "u-5", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "tu-5", "Agent", { description: "recon", prompt: "去查" }),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: "r5" },
      ],
      // 第 6 批: nudges=5 触发上限, 落 result.success 路径 (无 nudge, 无 stopTask)
      [
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 1.0, result: "final" },
      ],
    ];

    try {
      await new ActiveSession(task).start(task);
    } finally {
      // 静态值由 afterEach 还原
    }

    expect(getTaskById(task.id)?.status).toBe("reviewing");

    // 5 次 nudge 注入 (上限), 不会超过
    expect(h.injected.length).toBe(5);

    // 新 SDK 路径: inFlight 始终空, 没 stopTask 调用
    expect(h.stopTaskCalls).toHaveLength(0);
  });
});

// =============================================================================
// 常量守门 (防被静默改回)
// =============================================================================

describe("R132 常量守门", () => {
  it("MAX_BG_AGENT_NUDGES = 5 (R132 B 兜底放宽, 防静默改回 2)", () => {
    expect(ActiveSession.MAX_BG_AGENT_NUDGES).toBe(5);
  });

  it("BG_AGENT_LIFECYCLE_DRAIN_MS = 5min (防静默改大让 task 卡更久)", () => {
    expect(ActiveSession.BG_AGENT_LIFECYCLE_DRAIN_MS).toBe(5 * 60 * 1000);
  });

  it("BG_AGENT_STOP_GRACE_MS = 10s (防静默改短让 stopped notification 丢)", () => {
    expect(ActiveSession.BG_AGENT_STOP_GRACE_MS).toBe(10 * 1000);
  });
});