// 重启恢复回归 (damo 2026-10-13 GDM 4 条 pending 躺平实证)
//
// 覆盖两条不变量:
//   1. start 过但没起 session 的 queued 任务 (重启翻 pending 前的 DB 真相),
//      新进程 init() 必须重新按 start 入队 —— 调度队列是内存态, 无人认领
//      = 永久 pending (旧行为, 已修).
//   2. 创建后从未 start 的 pending 任务仍保持 pending —— 等手动启动是预期,
//      恢复逻辑不得越俎代庖.
//
// 真 SQLite + 真 TaskScheduler; runner 假 (挂住不返回), SDK 不参与.

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
const stopScheduleRunner = vi.fn();
const startScheduleRunner = vi.fn();
vi.mock("./schedule-runner", () => ({
  stopScheduleRunner: () => stopScheduleRunner(),
  startScheduleRunner: () => startScheduleRunner(),
}));

import { AgentRuntime } from "./agent-runtime";
import { TaskScheduler, type RunMode } from "./task-scheduler";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createTask, getTaskById, updateTaskStatus } from "../db/tasks";

let tmpDir: string;
let projectId: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-restart-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, "restart-test@example.com", "x", "admin");
  projectId = createProject({ name: "restart-test-project", ownerId: userId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function schedulerOf(runtime: AgentRuntime): TaskScheduler {
  return (runtime as unknown as { scheduler: TaskScheduler }).scheduler;
}

/** runner 挂住不返回: 任务跑起来后停在 running, 供断言。 */
function hangRunner(runtime: AgentRuntime): void {
  schedulerOf(runtime).setRunner(
    (_task: Task, _mode: RunMode) => new Promise<void>(() => {})
  );
}

function newTask(title: string): Task {
  return createTask({ title, prompt: "test prompt", project_id: projectId });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("重启恢复: queued 无 session 任务重新入队", () => {
  it("start 过但没跑起来的 queued 任务, init() 后重新入队并跑到 running", async () => {
    const task = newTask("e2e 验收(重启前排队)");
    // 模拟「start 后停在调度队列」的 DB 真相: queued + 无 session_id
    updateTaskStatus(task.id, "queued");

    // 模拟 pm2 restart: 全新 runtime + init() (同一个 DB 文件)
    const fresh = new AgentRuntime();
    hangRunner(fresh);
    fresh.init();
    schedulerOf(fresh).setConcurrency(2);
    await tick();

    // 重新入队 → 出队 → runner 挂住前已翻 running (而不是永躺 pending)
    expect(getTaskById(task.id)?.status).toBe("running");
  });

  it("创建后从未 start 的 pending 任务不被自动启动", async () => {
    const task = newTask("只创建没点启动");

    const fresh = new AgentRuntime();
    hangRunner(fresh);
    fresh.init();
    schedulerOf(fresh).setConcurrency(2);
    await tick();

    expect(getTaskById(task.id)?.status).toBe("pending");
  });
});
