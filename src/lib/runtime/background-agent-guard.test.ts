/**
 * L2 后台 subagent 逃逸防线.
 *
 * 复现 2026-08-11 task 14c38246: agent 用会话内 `Agent` 工具派了 2 个后台 subagent,
 * 53s 后就把这一轮收了 -> result 到达 -> closed=true 关 SDK 子进程 -> 进程内 in-flight
 * subagent 被一起杀掉, 报告永远回不来.
 *
 * 断言: 平台不再直接转 reviewing, 而是注入纠正指令续跑; 且提醒有上限, 用尽后放行并留痕.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// SDK mock: query() 返回一个受脚本控制的消息流, 并把平台注入回 generator 的文本抓下来.
const h = vi.hoisted(() => ({
  batches: [] as unknown[][], // 每批 = SDK 的一个 result 周期
  injected: [] as string[], // 平台在批次之间注入的文本
  delayMs: 0, // 批间延迟(给超时分支时间触发)
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
  createSdkMcpServer: vi.fn(() => ({})),
  query: vi.fn(({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => {
    async function* stream() {
      await prompt.next(); // 吃掉平台的初始 prompt
      for (const batch of h.batches) {
        for (const msg of batch) yield msg;
        if (h.delayMs > 0) await new Promise((r) => setTimeout(r, h.delayMs));
        // 批次之间向 generator 要下一条输入: 平台若注入了纠正指令, 这里能拿到;
        // 平台若直接收尾(closed=true), generator 结束 -> done -> 流也结束.
        const next = await prompt.next();
        if (next.done) break;
        h.injected.push(String(next.value.message.content));
      }
    }
    return stream();
  }),
}));

// 无出网副作用
vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";
import { getEventsByTaskId } from "../db/events";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";
// @ts-expect-error protected static, 测试需要把超时压到 1ms
const { BG_AGENT_NUDGE_TIMEOUT_MS } = ActiveSession;

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bgagent-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "bgagent-test@example.com", "x", "admin");
  // start() 前置校验要求 api_key 非空
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "bgagent-test", ownerId: userId }).id;

  h.batches = [];
  h.injected = [];
  h.delayMs = 0;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(): Task {
  const task = createTask({
    title: "bg-agent-guard",
    prompt: "派两个 subagent 去侦查",
    project_id: projectId,
    cwd: tmpDir,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return getTaskById(task.id)!;
}

// 一次工具调用的流式三段: content_block_start -> input_json_delta -> content_block_stop.
// 必须按这个形状喂: 生产开了 includePartialMessages, tool_use 只从流式路径进平台
// (finalized SDKAssistantMessage 的内容在 message.message.content, 平台读的 msg.content 恒空).
function streamToolUse(
  idx: number,
  toolId: string,
  name: string,
  input: Record<string, unknown>
): unknown[] {
  return [
    {
      type: "stream_event",
      session_id: "sess-1",
      event: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: toolId, name } },
    },
    {
      type: "stream_event",
      session_id: "sess-1",
      event: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    },
    { type: "stream_event", session_id: "sess-1", event: { type: "content_block_stop", index: idx } },
  ];
}

// 一批: 流式派 n 个后台 Agent, 紧接着 result success(= 派完就收尾)
function spawnThenFinish(n: number, seq: number): unknown[] {
  return [
    { type: "assistant", uuid: `u-${seq}`, session_id: "sess-1", message: { content: [] } },
    ...Array.from({ length: n }, (_, i) =>
      streamToolUse(i, `t-${seq}-${i}`, "Agent", {
        description: `recon-${i}`,
        subagent_type: "general-purpose",
        prompt: "去查",
      })
    ).flat(),
    { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.5, result: `r${seq}` },
  ];
}

// 一批: 纯收尾, 不派任何 subagent
function justFinish(seq: number): unknown[] {
  return [
    { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.9, result: `r${seq}` },
  ];
}

function warnings(taskId: string) {
  return getEventsByTaskId(taskId)
    .filter((e) => e.type === "warning")
    .map((e) => JSON.parse(e.data) as { kind: string; action: string; spawned: number });
}

describe("后台 subagent 逃逸防线", () => {
  it("派完就收尾 -> 注入纠正指令续跑, 而不是直接转 reviewing", async () => {
    const task = makeTask();
    h.batches = [spawnThenFinish(2, 1), justFinish(2)];

    await new ActiveSession(task).start(task);

    // 平台注入了一条 system-reminder, 点名了数量与两条出路
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toContain("<system-reminder>");
    expect(h.injected[0]).toContain("2 个后台 subagent");
    expect(h.injected[0]).toContain("ao-dispatch.sh");

    // 留痕: 一条 resumed 告警, 无 gave_up
    const w = warnings(task.id);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "background_agent_escape", action: "resumed", spawned: 2 });

    // 第二批没再派 -> 正常收尾
    expect(getTaskById(task.id)?.status).toBe("reviewing");
  });

  it("没派后台 subagent 时不打扰: 零注入零告警, 直接 reviewing", async () => {
    const task = makeTask();
    h.batches = [justFinish(1)];

    await new ActiveSession(task).start(task);

    expect(h.injected).toHaveLength(0);
    expect(warnings(task.id)).toHaveLength(0);
    expect(getTaskById(task.id)?.status).toBe("reviewing");
  });

  it("run_in_background: false(前台等结果)不计入, 不该被拦", async () => {
    const task = makeTask();
    h.batches = [
      [
        { type: "assistant", uuid: "u-fg", session_id: "sess-1", message: { content: [] } },
        ...streamToolUse(0, "t-fg", "Agent", { description: "recon", prompt: "去查", run_in_background: false }),
        { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.2, result: "ok" },
      ],
    ];

    await new ActiveSession(task).start(task);

    expect(h.injected).toHaveLength(0);
    expect(warnings(task.id)).toHaveLength(0);
    expect(getTaskById(task.id)?.status).toBe("reviewing");
  });

  it("模型屡教不改时提醒有上限: 5 次 resumed 后放行并留 gave_up (R132 放宽上限)", async () => {
    const task = makeTask();
    // 连续六批都是「派完就收尾」: 前五批各触发一次提醒 (MAX_BG_AGENT_NUDGES=5), 第六批
    // 用尽后放行, 但仍有 spawns>0 → 留痕 gave_up. 第六批需要再 spawn 一次让 gave_up 触发
    // (give_up warning 在 spawns>0 路径, 不在 nudges 用尽路径).
    h.batches = [
      spawnThenFinish(1, 1), spawnThenFinish(1, 2), spawnThenFinish(1, 3),
      spawnThenFinish(1, 4), spawnThenFinish(1, 5), spawnThenFinish(1, 6),
    ];

    await new ActiveSession(task).start(task);

    expect(h.injected).toHaveLength(5); // R132 上限 = MAX_BG_AGENT_NUDGES, 第 6 批不再注入
    const w = warnings(task.id);
    expect(w.map((x) => x.action)).toEqual(["resumed", "resumed", "resumed", "resumed", "resumed", "gave_up"]);
    expect(getTaskById(task.id)?.status).toBe("reviewing");
  });
});

// ===========================================================================
// 5min 超时兜底
// ===========================================================================

describe("5min 超时兜底", () => {
  it("注入 reminder 后模型卡死超过超时, 下次 result 到达时主动 fail 不再续命", async () => {
    const task = makeTask();
    // start() 不动 status -> 模拟 scheduler 已把它翻成 running
    updateTaskStatus(task.id, "running", { session_id: "sess-timeout" });
    // 批 1: 派 1 个后台 Agent + result -> 注入 reminder(记下时间)
    // 批 2: 不派任何 subagent, 直接 result(模型空转) -> 走超时分支 -> 主动 fail
    // 把超时压到 1ms 才能在单测里复现
    const original = (ActiveSession as unknown as { BG_AGENT_NUDGE_TIMEOUT_MS: number }).BG_AGENT_NUDGE_TIMEOUT_MS;
    (ActiveSession as unknown as { BG_AGENT_NUDGE_TIMEOUT_MS: number }).BG_AGENT_NUDGE_TIMEOUT_MS = 1;
    h.delayMs = 20; // 批间 20ms, 远超 1ms 超时
    try {
      h.batches = [spawnThenFinish(1, 1), justFinish(2)];
      await new ActiveSession(task).start(task);
    } finally {
      (ActiveSession as unknown as { BG_AGENT_NUDGE_TIMEOUT_MS: number }).BG_AGENT_NUDGE_TIMEOUT_MS = original;
      h.delayMs = 0;
    }

    expect(getTaskById(task.id)?.status).toBe("failed");
    expect(getTaskById(task.id)?.error).toMatch(/主动 fail/);
    const w = warnings(task.id);
    expect(w.some((x) => x.kind === "background_agent_escape" && x.action === "resumed")).toBe(true);
  });
});

// 防止 BG_AGENT_NUDGE_TIMEOUT_MS 静默被改大/改小
describe("常量守门", () => {
  it("BG_AGENT_NUDGE_TIMEOUT_MS = 5min(防被静默改大让 task 卡死更长)", () => {
    expect(BG_AGENT_NUDGE_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});
