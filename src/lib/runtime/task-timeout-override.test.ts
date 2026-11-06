// Per-task timeout override 回归测试
//
// 覆盖三件事:
//   1. getTaskTimeoutOverrideMinutes: 从 metadata JSON 读出 timeout_minutes, 各种脏值都返回 null
//   2. resolveTaskTimeoutMs: task 行 override > project > 全局 的优先级不被改乱
//   3. AgentRuntime.setTaskTimeout: 在跑的任务重挂定时器 (clearTimeout + 新 setTimeout),
//      没在跑的任务返回 false 不抛错

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// agent-runtime 顶层会 import SDK, stub 掉.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

import { resolveTaskTimeoutMs, AgentRuntime } from "./agent-runtime";
import type { Task } from "./types";
import { getDb, closeDb } from "../db";
import { createProject, updateProject } from "../db/projects";
import {
  getGlobalTaskTimeoutMinutes,
  setGlobalTaskTimeoutMinutes,
  DEFAULT_TASK_TIMEOUT_MINUTES,
  MAX_TASK_TIMEOUT_MINUTES,
} from "../db/settings";
import {
  createTask,
  getTaskById,
  updateTask,
  mutateTaskMetadata,
  getTaskTimeoutOverrideMinutes,
} from "../db/tasks";

let tmpDir: string;
let projectId: string;
let userId: string;

// 只有 task 行的 metadata / project_id 参与解析, 其余字段不影响.
function fakeTask(metadata: string | null, project_id: string | null = null): Task {
  return { id: "task-x", metadata, project_id } as Task;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-task-timeout-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_TIMEOUT_MIN;
  delete process.env.ORCHESTRATOR_MAX_CONCURRENCY;
  closeDb();
  getDb(); // 跑 migration
  const project = createProject({ name: "p" });
  projectId = project.id;
  userId = "u1";
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_TASK_TIMEOUT_MIN;
  delete process.env.ORCHESTRATOR_MAX_CONCURRENCY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getTaskTimeoutOverrideMinutes - 脏值兜底", () => {
  it("metadata 为 null 返回 null", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(null))).toBeNull();
  });

  it("空字符串 metadata 返回 null", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(""))).toBeNull();
  });

  it("metadata 不合法 JSON 不抛错, 返回 null", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask("not json"))).toBeNull();
  });

  it("metadata 里没 timeout_minutes 键返回 null", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(JSON.stringify({ foo: 1 })))).toBeNull();
  });

  it("timeout_minutes 是字符串返回 null", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(JSON.stringify({ timeout_minutes: "30" })))).toBeNull();
  });

  it("timeout_minutes 是浮点数返回 null", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(JSON.stringify({ timeout_minutes: 30.5 })))).toBeNull();
  });

  it("timeout_minutes 是 0 / 负数返回 null (setTimeout(0) 等于一启动就 pause)", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(JSON.stringify({ timeout_minutes: 0 })))).toBeNull();
    expect(getTaskTimeoutOverrideMinutes(fakeTask(JSON.stringify({ timeout_minutes: -5 })))).toBeNull();
  });

  it("合法正整数返回数值", () => {
    expect(getTaskTimeoutOverrideMinutes(fakeTask(JSON.stringify({ timeout_minutes: 60 })))).toBe(60);
  });
});

describe("resolveTaskTimeoutMs - 三层优先级", () => {
  it("task override > project > 全局", () => {
    setGlobalTaskTimeoutMinutes(30);
    updateProject(projectId, { timeout_minutes: 120 });
    const task = fakeTask(JSON.stringify({ timeout_minutes: 240 }));
    expect(resolveTaskTimeoutMs(task)).toBe(240 * 60 * 1000);
  });

  it("task 没 override 时 project 兜底", () => {
    setGlobalTaskTimeoutMinutes(30);
    updateProject(projectId, { timeout_minutes: 120 });
    const task = fakeTask(JSON.stringify({ other_key: "x" }), projectId);
    expect(resolveTaskTimeoutMs(task)).toBe(120 * 60 * 1000);
  });

  it("task override 脏值 (字符串) 回退到 project", () => {
    setGlobalTaskTimeoutMinutes(30);
    updateProject(projectId, { timeout_minutes: 120 });
    const task = fakeTask(JSON.stringify({ timeout_minutes: "abc" }), projectId);
    expect(resolveTaskTimeoutMs(task)).toBe(120 * 60 * 1000);
  });

  it("task 没 override + project 没配 = 全局", () => {
    setGlobalTaskTimeoutMinutes(45);
    const task = fakeTask(null);
    // 没 projectId 走全局
    expect(resolveTaskTimeoutMs(task)).toBe(45 * 60 * 1000);
  });

  it("task 没 override + project 配了 NULL 时走全局 (不是 0)", () => {
    setGlobalTaskTimeoutMinutes(30);
    updateProject(projectId, { timeout_minutes: null });
    const task = fakeTask(null);
    expect(resolveTaskTimeoutMs(task)).toBe(30 * 60 * 1000);
  });
});

describe("mutateTaskMetadata 写入 timeout_minutes 后 resolveTaskTimeoutMs 立刻读到", () => {
  it("存进去就解析得到", () => {
    setGlobalTaskTimeoutMinutes(30);
    const created = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
    } as any);
    const taskId = created.id;

    mutateTaskMetadata(taskId, (meta) => {
      meta.timeout_minutes = 90;
    });

    // 不传 userId 跳过 owner 过滤 —— 测试不依赖 users 表 FK
    const reread = getTaskById(taskId)!;
    expect(getTaskTimeoutOverrideMinutes(reread)).toBe(90);
    expect(resolveTaskTimeoutMs(reread)).toBe(90 * 60 * 1000);
  });

  it("null 删掉 (走 project/全局)", () => {
    setGlobalTaskTimeoutMinutes(30);
    updateProject(projectId, { timeout_minutes: 60 });
    const created = createTask({
      title: "t",
      prompt: "p",
      project_id: projectId,
    } as any);
    const taskId = created.id;

    // 先设
    mutateTaskMetadata(taskId, (meta) => {
      meta.timeout_minutes = 999;
    });
    expect(resolveTaskTimeoutMs(getTaskById(taskId)!)).toBe(999 * 60 * 1000);

    // 再删
    mutateTaskMetadata(taskId, (meta) => {
      delete meta.timeout_minutes;
    });
    expect(getTaskTimeoutOverrideMinutes(getTaskById(taskId)!)).toBeNull();
    expect(resolveTaskTimeoutMs(getTaskById(taskId)!)).toBe(60 * 60 * 1000);
  });
});

describe("AgentRuntime.setTaskTimeout", () => {
  it("没在跑的任务返回 false, 不抛错", () => {
    const runtime = new AgentRuntime();
    expect(runtime.setTaskTimeout("never-started", 60)).toBe(false);
  });

  it("在跑的任务: clearTimeout + setTimeout, timer map 更新", () => {
    vi.useFakeTimers();
    try {
      const runtime = new AgentRuntime();
      const taskId = "running-task-1";

      // 模拟 runTask 把 timer 塞进 map
      const oldTimer = setTimeout(() => {}, 100_000);
      (runtime as any).timeoutTimers.set(taskId, oldTimer);
      const clearSpy = vi.spyOn(global, "clearTimeout");

      const ok = runtime.setTaskTimeout(taskId, 60);
      expect(ok).toBe(true);
      expect(clearSpy).toHaveBeenCalledWith(oldTimer);

      // map 里的 timer 是新的
      const newTimer = (runtime as any).timeoutTimers.get(taskId);
      expect(newTimer).toBeDefined();
      expect(newTimer).not.toBe(oldTimer);

      clearTimeout(newTimer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("新 timer 按新时长触发", () => {
    vi.useFakeTimers();
    try {
      const runtime = new AgentRuntime();
      const taskId = "running-task-2";
      const pauseSpy = vi.spyOn(runtime as any, "pauseTask").mockResolvedValue(undefined);
      const cancelSpy = vi.spyOn(runtime as any, "cancelTask").mockResolvedValue(undefined);

      (runtime as any).timeoutTimers.set(taskId, setTimeout(() => {}, 100_000));
      // 改成 5 分钟
      runtime.setTaskTimeout(taskId, 5);

      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(pauseSpy).toHaveBeenCalledWith(taskId, "auto");
      // cancelTask 不应被调用 (pauseTask 没抛)
      expect(cancelSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("常量边界", () => {
  it("MAX_TASK_TIMEOUT_MINUTES 仍是 1440 (24h)", () => {
    expect(MAX_TASK_TIMEOUT_MINUTES).toBe(1440);
  });

  it("DEFAULT_TASK_TIMEOUT_MINUTES 仍是 30", () => {
    expect(DEFAULT_TASK_TIMEOUT_MINUTES).toBe(30);
  });
});