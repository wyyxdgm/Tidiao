// R132+ regression: sendUserMessage 在 live running session 分支不发 SSE `message` 事件,
//   导致前端乐观插入的 user 消息在 SDK 还没把 user msg 落进 JSONL 的窗口里被 mergeHistory
//   按 text 错位冲掉, 表现 = "刚发送消息出去, 会看不见. 刷新可见."
//
// 5 个分支里 4 个都 emit SSE `message` 事件 (paused / terminal auto-start / queued /
// closed-session), 只有 live running session 分支漏了. 本测试覆盖这个分支.
//
// 关注点:
//   - 用 vi.fn() mock ActiveSession 替身, 直接塞进 runtime.sessions Map (避开真实 SDK).
//   - 父测试 (parent-notify-e2e.test.ts) 是 "hanging runner" 模式, 但要走 live session 分支
//     必须 runtime.sessions.get(taskId) 不为 undefined — 因此直接 push mock.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: vi.fn(),
}));
vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));
// 不启动 SDK subprocess — 防保险.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(async () => []),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById } from "../db/tasks";
import type { Task } from "./types";

let tmpDir: string;
let projectId: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-send-user-msg-emit-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(ownerId, `${ownerId}@example.com`, "x");

  projectId = createProject({
    name: "send-user-msg-emit",
    cwd: tmpDir,
    ownerId,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 构造一个 AgentRuntime, scheduler 用挂起 runner (不真启动 SDK).
function makeRuntime() {
  const runtime = new AgentRuntime();
  const scheduler = (runtime as unknown as { scheduler: TaskScheduler })
    .scheduler;
  scheduler.setRunner(
    (_task: Task, _mode: RunMode) =>
      new Promise<void>(() => {
        /* hang */
      }),
  );
  return runtime;
}

// 强设 task 状态 + session_id (匹配 live running 场景).
function makeRunningTask(sessionId: string): Task {
  const t = createTask({
    title: "running-task",
    prompt: "live session prompt",
    project_id: projectId,
  });
  getDb()
    .prepare(
      `UPDATE tasks SET owner_id = ?, status = 'running', session_id = ? WHERE id = ?`,
    )
    .run(ownerId, sessionId, t.id);
  return getTaskById(t.id)!;
}

// Minimal ActiveSession 替身 — sendUserMessage 只需要 pushMessage / getSessionId / isClosed 三个成员.
function makeMockSession(sessionId: string) {
  return {
    pushMessage: vi.fn(),
    getSessionId: vi.fn(() => sessionId),
    isClosed: false,
  };
}

describe("sendUserMessage live session 分支必须 emit SSE `message` 事件", () => {
  it("running + 有 session_id → emitEvent(type=message) 被订阅方收到, text/sender_type/timestamp 完整", () => {
    const runtime = makeRuntime();
    const task = makeRunningTask("sess-live-1");
    const mockSession = makeMockSession("sess-live-1");
    // 直接塞进 runtime.sessions Map — 替身只暴露 sendUserMessage 调用的三个成员.
    (runtime as unknown as { sessions: Map<string, unknown> }).sessions.set(
      task.id,
      mockSession,
    );

    // 订阅事件
    const events: unknown[] = [];
    runtime.subscribeToEvents(task.id, (ev) => {
      events.push(ev);
    });

    // 触发
    runtime.sendUserMessage(task.id, "fix this bug", undefined, undefined, "user");

    // 断言 1: pushMessage 被调 (live session 分支没退化)
    expect(mockSession.pushMessage).toHaveBeenCalledWith("fix this bug", "user");

    // 断言 2 (核心): SSE `message` 事件被 emit 出去 (R132+ bug 修复目标)
    const messageEvents = events.filter(
      (e): e is { type: string; data: string } =>
        typeof e === "object" && e !== null && (e as { type: string }).type === "message",
    );
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);

    // 断言 3: 事件 data 含完整字段, 前端 SSE handler 能正常解析
    const last = messageEvents[messageEvents.length - 1] as { type: string; data: string };
    const data = JSON.parse(last.data);
    expect(data.role).toBe("user");
    expect(data.text).toBe("fix this bug");
    expect(data.sender_type).toBe("user");
    expect(typeof data.timestamp).toBe("number");
    expect(data.timestamp).toBeGreaterThan(Date.now() - 5000);
  });

  it("script sender → sender_type=script 正确透传", () => {
    const runtime = makeRuntime();
    const task = makeRunningTask("sess-live-2");
    const mockSession = makeMockSession("sess-live-2");
    (runtime as unknown as { sessions: Map<string, unknown> }).sessions.set(
      task.id,
      mockSession,
    );

    const events: unknown[] = [];
    runtime.subscribeToEvents(task.id, (ev) => events.push(ev));

    runtime.sendUserMessage(task.id, "script run", undefined, undefined, "script");

    const messageEvent = events.find(
      (e): e is { type: string; data: string } =>
        typeof e === "object" && e !== null && (e as { type: string }).type === "message",
    ) as { type: string; data: string } | undefined;
    expect(messageEvent).toBeDefined();
    const data = JSON.parse(messageEvent!.data);
    expect(data.sender_type).toBe("script");
    expect(data.text).toBe("script run");
  });
});
