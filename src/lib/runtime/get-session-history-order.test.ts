// getSessionHistory 二分插入兜底语义测试.
//
// 关注 bug: [subtask-notify] 跑到前面.
// 根因: agent-runtime.ts:1977 (修复前) `eventTs.get(u) ?? 0` → DB event created_at
//   解析失败时 ts = 0, 而 SDK 消息 ts (UUID v7 反算) 远大于 0 → 二分插入把 DB
//   event 排到 SDK 消息最前. 修复: 兜底改 Number.MAX_SAFE_INTEGER → 排末尾.
// 验证: 一条 SDK 消息 (ts = T_real) + 一条 DB event (created_at = NULL, ts = ?),
//   断言 DB event 在 SDK 消息之后.
//
// 关注点:
//   - 项目未配 jsdom, 直接测 React 组件不现实, 但 runtime 类单测是真 DB +
//     真 AgentRuntime + mock 外部 SDK. 与 parent-notify-e2e.test.ts 同款模式.
//   - UUID v7 构造: 12 hex = unix_ms, 版本字段 7xxx, variant 8/9/a/b. tsOf 只读
//     前 12 hex (uuidToTimestamp slice(0,12)), 后 80 bit 不参与 ts 解析.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../webhooks/dispatcher", () => ({ dispatchWebhook: vi.fn() }));
vi.mock("./rule-engine", () => ({ runRules: vi.fn() }));

// 不启动 SDK subprocess. getSessionMessages 走 mock 拿 SDK 消息.
const getSessionMessagesMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  query: vi.fn(),
  getSessionMessages: (...args: unknown[]) => getSessionMessagesMock(...args),
}));

import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, updateTask } from "../db/tasks";
import { insertEvent } from "../db/events";
import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;
let runtime: AgentRuntime;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-history-order-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x", "user");

  projectId = createProject({
    name: "history-order",
    cwd: tmpDir,
    ownerId,
  }).id;

  // 不真启动 runner — 用挂起 promise 模式, 与 parent-notify-e2e.test.ts 一致.
  const scheduler = new TaskScheduler({ maxConcurrent: 1 });
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) => new Promise<void>(() => {}),
  );
  runtime = new AgentRuntime(scheduler);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 构造 UUID v7: 前 12 hex = unix_ms, 后续随便填. tsOf 只解析前 12 hex, 后 80 bit
// 不影响 ts. 但版本字段 (第 13 hex) = 7, variant (第 17 hex) = 8/9/a/b 才像 v7.
function uuidV7(ms: number, seq = 0): string {
  const hex12 = ms.toString(16).padStart(12, "0");
  return [
    hex12.slice(0, 8),
    hex12.slice(8, 12),
    "7000",
    "8000",
    seq.toString(16).padStart(12, "0"),
  ].join("-");
}

function makeTask(sessionId: string): string {
  const t = createTask({
    title: "history-order-task",
    prompt: "initial prompt",
    project_id: projectId,
  });
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, session_id = ?, status = ? WHERE id = ?`,
    )
    .run(ownerId, sessionId, "running", t.id);
  return t.id;
}

describe("getSessionHistory: DB event created_at 异常的兜底语义", () => {
  it("DB event created_at=NULL → 排在 SDK 消息之后 (修复前会排最前)", async () => {
    const taskId = makeTask("sess-bug-test");

    // SDK 消息: ts = 真实时间戳 (10s 前)
    const sdkTs = Date.now() - 10_000;
    getSessionMessagesMock.mockResolvedValueOnce([
      {
        type: "user",
        uuid: uuidV7(sdkTs, 0),
        session_id: "sess-bug-test",
        message: { role: "user", content: "SDK 真实消息" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    // DB event: 模拟 created_at 异常 (NULL). 这条 [subtask-notify] 在生产中
    // 就是「created_at 异常时被误排到前面」的高频场景.
    insertEvent({
      task_id: taskId,
      session_id: "sess-bug-test",
      type: "message",
      data: JSON.stringify({
        role: "user",
        text: "[subtask-notify] 子任务 xxxx 已进入 reviewing。",
      }),
    });
    // 强制覆盖 created_at 为 NULL — 模拟 SQLite 写入竞争 / 迁移数据异常 / 等场景.
    const updated = getDb()
      .prepare(`UPDATE events SET created_at = NULL WHERE task_id = ?`)
      .run(taskId);
    expect(updated.changes).toBe(1);

    const history = await runtime.getSessionHistory(taskId);

    // 关键断言: SDK 消息在前, DB event 在末尾 — 不是最前.
    // 修复前: DB event tsOf = 0 < SDK tsOf = sdkTs → 排最前 → "跑到前面" bug.
    // 修复后: DB event tsOf = MAX_SAFE_INTEGER > SDK tsOf → 排末尾 ✓.
    expect(history).toHaveLength(2);
    const contents = history.map((m: any) => m.message?.content);
    expect(contents).toEqual([
      "SDK 真实消息",
      "[subtask-notify] 子任务 xxxx 已进入 reviewing。",
    ]);

    // 进一步断言: DB event 的 uuid 形态 = event-${id} (DB 来源标识).
    const dbEvent = history[1] as any;
    expect(dbEvent.uuid).toMatch(/^event-\d+$/);
  });

  it("DB event created_at 正常 → 按时间戳二分插入到 SDK 消息之间 (基线)", async () => {
    // 对照组: 验证修复没误伤正常路径. created_at 正常时, DB event 应按时间
    // 戳插到 SDK 消息正确位置.
    const taskId = makeTask("sess-baseline");

    const sdkTs = Date.now() - 10_000; // SDK 消息 10s 前
    const eventTs = Date.now() - 5_000; // DB event 5s 前 (在 SDK 之后)
    getSessionMessagesMock.mockResolvedValueOnce([
      {
        type: "user",
        uuid: uuidV7(sdkTs, 0),
        session_id: "sess-baseline",
        message: { role: "user", content: "SDK 消息" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    insertEvent({
      task_id: taskId,
      session_id: "sess-baseline",
      type: "message",
      data: JSON.stringify({ role: "user", text: "DB event (后到)" }),
    });
    // 强制覆盖 created_at 为精确控制的时间.
    getDb()
      .prepare(`UPDATE events SET created_at = ? WHERE task_id = ?`)
      .run(new Date(eventTs).toISOString().replace("T", " ").replace("Z", ""), taskId);

    const history = await runtime.getSessionHistory(taskId);
    expect(history).toHaveLength(2);
    const contents = history.map((m: any) => m.message?.content);
    // SDK 10s 前 < DB event 5s 前 → SDK 在前, DB event 在后
    expect(contents).toEqual(["SDK 消息", "DB event (后到)"]);
  });
});

describe("getSessionHistory: prompt 重投时间修正 (2026-10-07 taoke task)", () => {
  // 场景: 用户 12:04 用 prompt 建任务; 12:13 / 15:57 两条 follow-up 走 DB event;
  //   15:57 LLM fallback fresh-start 把 prompt 重新喂进新 session —
  //   JSONL uuid ts = 重投时间 (15:57) > 两条 follow-up → 修复前 prompt 排最后.
  it("prompt 被 fallback 重投 → 按 tasks.created_at 排序, 显示时间同步修正", async () => {
    const t = createTask({
      title: "taoke-replay",
      prompt: "怎么开始，我们来协作一起搞事情。目标：赚钱",
      project_id: projectId,
    });
    const taskId = t.id;
    // 固定 created_at = 4h 前, 模拟「任务早建、prompt 晚重投」.
    const createdMs = Date.now() - 4 * 3600_000;
    getDb()
      .prepare(`UPDATE tasks SET owner_id = ?, session_id = ?, created_at = ? WHERE id = ?`)
      .run(
        ownerId,
        "sess-replay",
        new Date(createdMs).toISOString().replace("T", " ").slice(0, 19),
        taskId,
      );

    // SDK (重投后的 fresh session): prompt 副本 uuid ts = 重投时间 (1min 前)
    //   + 一条 assistant 回复. 注意 prompt 的 uuid ts 晚于两条 DB event —
    //   修复前 merge 排序会把它推到最后.
    const refeedMs = Date.now() - 60_000;
    getSessionMessagesMock.mockResolvedValueOnce([
      {
        type: "user",
        uuid: uuidV7(refeedMs, 0),
        session_id: "sess-replay",
        message: { role: "user", content: "怎么开始，我们来协作一起搞事情。目标：赚钱" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: "assistant",
        uuid: uuidV7(refeedMs + 5_000, 1),
        session_id: "sess-replay",
        message: { role: "assistant", content: "协作模式已就位" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    // 两条 follow-up 走 DB event (真实发送时间): 12:13 (=created_at+9min) 和 15:57.
    const events: Array<[string, number]> = [
      ["继续", createdMs + 9 * 60_000],
      ["进度：淘宝联盟已注册", createdMs + 3 * 3600_000 + 53 * 60_000],
    ];
    for (const [text, ts] of events) {
      insertEvent({
        task_id: taskId,
        session_id: "sess-replay",
        type: "message",
        data: JSON.stringify({ role: "user", text, timestamp: ts }),
      });
      getDb()
        .prepare(`UPDATE events SET created_at = ? WHERE task_id = ? AND id = (SELECT MAX(id) FROM events)`)
        .run(new Date(ts).toISOString().replace("T", " ").slice(0, 19), taskId);
    }

    const history = await runtime.getSessionHistory(taskId);

    // 修复前: [继续, 进度, prompt, assistant] (prompt uuid ts=重投时间 最大).
    // 修复后: prompt 按 created_at 排最前 → [prompt, 继续, 进度, assistant].
    const contents = history.map((m: any) => m.message?.content);
    expect(contents).toEqual([
      "怎么开始，我们来协作一起搞事情。目标：赚钱",
      "继续",
      "进度：淘宝联盟已注册",
      "协作模式已就位",
    ]);

    // 前端显示时间同源: prompt 副本带 timestamp = created_at ISO (SDK 消息
    //   本身无顶层 timestamp, 这个字段是本次修正写入的). DB created_at 是
    //   秒级精度 (datetime('now')), 所以比到秒 (toISOString 会补 .000Z).
    expect(new Date((history[0] as any).timestamp).getTime()).toBe(
      new Date(new Date(createdMs).toISOString().slice(0, 19) + "Z").getTime(),
    );
    // 非 prompt 消息不受影响 — assistant 无 timestamp 字段 (uuid 反算).
    expect((history[3] as any).timestamp).toBeUndefined();
  });

  it("用户事后把 prompt 原文再发一遍 → 只有首条命中修正, 后发的保留真实时间", async () => {
    const t = createTask({
      title: "replay-second-copy",
      prompt: "目标：赚钱",
      project_id: projectId,
    });
    const taskId = t.id;
    const createdMs = Date.now() - 2 * 3600_000;
    getDb()
      .prepare(`UPDATE tasks SET owner_id = ?, session_id = ?, created_at = ? WHERE id = ?`)
      .run(
        ownerId,
        "sess-second",
        new Date(createdMs).toISOString().replace("T", " ").slice(0, 19),
        taskId,
      );

    const laterMs = Date.now() - 60_000; // 用户事后手动重发的 prompt 原文
    getSessionMessagesMock.mockResolvedValueOnce([
      {
        type: "user",
        uuid: uuidV7(createdMs + 1_000, 0),
        session_id: "sess-second",
        message: { role: "user", content: "目标：赚钱" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: "user",
        uuid: uuidV7(laterMs, 1),
        session_id: "sess-second",
        message: { role: "user", content: "目标：赚钱" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    const history = await runtime.getSessionHistory(taskId);
    expect(history).toHaveLength(2);
    // 首条 (fresh-start 重投的那份) → created_at; 第二条 (手动重发) → uuid 真实时间.
    expect(new Date((history[0] as any).timestamp).getTime()).toBe(
      new Date(new Date(createdMs).toISOString().slice(0, 19) + "Z").getTime(),
    );
    expect((history[1] as any).timestamp).toBeUndefined();
  });
});