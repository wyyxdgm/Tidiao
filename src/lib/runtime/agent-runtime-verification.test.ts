// DAG P3 (B2/B3/B4/B5 拍板 2026-09-05+06) — agent-runtime 端到端测试
//
// 覆盖 6 条核心场景 (设计稿 docs/plans/dag-verification.md §4.3 + §6):
//   1) L1 平台级 false → 项目级配了 command 也不进 verifying (byte-identical)
//   2) L1 true + L2 项目级 command null → 也不进 verifying (byte-identical)
//   3) L1 true + L2 有效 command + 成功 → verifying → completed (事件双发)
//   4) L1 true + L2 失败一次后重试成功 → verifying → running + 反馈 → verifying → completed
//      verification_attempts = 1 (成功时不增)
//   5) L1 true + L2 重试耗尽 → verifying → failed, verification_attempts = N
//   6) 跨项目隔离: A 项目配 command / B 项目不配 → B 的 task 不进 verifying
//
// 不变量:
//   - L1 关 = byte-identical 行为 (B5 拍板默认 false)
//   - L1 开但 L2 null = byte-identical 行为 (项目级兜底)
//   - L1 + L2 都开才进 verifying
//   - 反馈注入走 queuePendingMessage (tasks.metadata.pending_messages), agent 看到后自己改

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../webhooks/dispatcher", () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock("./rule-engine", () => ({
  runRules: vi.fn(),
}));

import { AgentRuntime } from "./agent-runtime";
import { getDb, closeDb } from "../db";
import { createProject, updateProject } from "../db/projects";
import {
  createTask,
  getTaskById,
  updateTaskStatus,
  drainPendingMessages,
} from "../db/tasks";
import { getEventsByTaskId } from "../db/events";
import {
  setVerificationGloballyEnabled,
  resolveVerificationGloballyEnabled,
} from "../db/settings";

let tmpDir: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dag-p3-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb(); // run migrations (including v72 verification_*)

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 创建一条 reviewing 状态的 task (approveTask 入口只接受 reviewing/paused/rejected/await_user)
function makeReviewingTask(projectId: string, title = "task"): string {
  const task = createTask({
    title,
    prompt: "test prompt",
    project_id: projectId,
  });
  // reviewing 状态必须有 session_id + completed_at + result, 仿 status-transitions.test.ts
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, session_id = ?, completed_at = ?, result = ? WHERE id = ?`,
    )
    .run("reviewing", `sess-${task.id.slice(0, 8)}`, new Date().toISOString(), "agent finished", task.id);
  return task.id;
}

// 提取 task 的所有 status_change 事件到 (from, to, reason) 三元组
function statusChanges(taskId: string): Array<{ from: string; to: string; reason?: string }> {
  return getEventsByTaskId(taskId)
    .filter((e) => e.type === "status_change")
    .map((e) => JSON.parse(e.data) as { from: string; to: string; reason?: string });
}

describe("DAG P3: approveTask 拦截 + 机械验收门", () => {
  it("L1 平台级 false → 项目配了 command 也不进 verifying (byte-identical, B5 默认)", () => {
    // B5 默认 false: 不用 setVerificationGloballyEnabled 也行, 但显式重置一下保险
    setVerificationGloballyEnabled(false);
    expect(resolveVerificationGloballyEnabled()).toBe(false);

    const project = createProject({ name: "p-verify-l1-off", ownerId });
    updateProject(project.id, { verification_command: "echo should_not_run" });

    const taskId = makeReviewingTask(project.id);
    const runtime = new AgentRuntime();
    runtime.approveTask(taskId, /* skipReviewGate */ true);

    // 直接翻 completed, 没有 verifying
    const t = getTaskById(taskId)!;
    expect(t.status).toBe("completed");
    const events = statusChanges(taskId);
    expect(events.map((e) => e.to)).toEqual(["completed"]);
  });

  it("L1 true 但 L2 项目级 command null → 不进 verifying (byte-identical)", () => {
    setVerificationGloballyEnabled(true);
    const project = createProject({ name: "p-l2-null", ownerId });
    // 不配 verification_command = null (默认)

    const taskId = makeReviewingTask(project.id);
    const runtime = new AgentRuntime();
    runtime.approveTask(taskId, /* skipReviewGate */ true);

    const t = getTaskById(taskId)!;
    expect(t.status).toBe("completed");
    expect(statusChanges(taskId).map((e) => e.to)).toEqual(["completed"]);
  });

  it("L1+L2 都开 + 命令成功 → verifying → completed (事件双发)", () => {
    setVerificationGloballyEnabled(true);
    const project = createProject({ name: "p-success", ownerId });
    updateProject(project.id, {
      verification_command: "echo success-marker",
      verification_max_retries: 2,
    });

    const taskId = makeReviewingTask(project.id);
    const runtime = new AgentRuntime();
    runtime.approveTask(taskId, /* skipReviewGate */ true);

    const t = getTaskById(taskId)!;
    expect(t.status).toBe("completed");

    const events = statusChanges(taskId);
    const transitions = events.map((e) => `${e.from}→${e.to}`);
    // 期望序列: reviewing → verifying → completed
    expect(transitions).toContain("reviewing→verifying");
    expect(transitions[transitions.length - 1]).toBe("verifying→completed");

    // verification_attempts 写 metadata = 0 (成功时不增)
    const meta = JSON.parse(t.metadata ?? "{}");
    expect(meta.verification_attempts).toBe(0);
    expect(meta.verification_last_result?.succeeded).toBe(true);
    expect(meta.verification_last_result?.exit_code).toBe(0);
  });

  it("L1+L2 都开 + 第一次失败, 第二次成功 → verifying → running + 反馈 → verifying → completed", () => {
    setVerificationGloballyEnabled(true);
    // 设项目 cwd 到 tmpDir 子目录, 让 task.cwd 非 null, runVerificationCommand 用它
    const projectCwd = fs.mkdtempSync(path.join(tmpDir, "verify-cwd-"));
    const project = createProject({ name: "p-retry", ownerId, cwd: projectCwd });
    // 第一次 exit 1, 第二次 echo success (用 sleep + 二次跑模拟太慢, 改成 task cwd 写一个 wrapper script)
    const cmd = `node -e "const m=require('fs').readFileSync('attempt.txt','utf8').trim(); if(m==='1'){process.exit(1)}else{console.log('ok')}"`;
    updateProject(project.id, {
      verification_command: cmd,
      verification_max_retries: 2,
      verification_timeout_seconds: 10,
    });

    const taskId = makeReviewingTask(project.id);
    // 在 task cwd 写 attempt.txt = '1', 让第一次 fail
    const taskCwd = getTaskById(taskId)!.cwd ?? projectCwd;
    fs.writeFileSync(path.join(taskCwd, "attempt.txt"), "1");

    const runtime = new AgentRuntime();
    runtime.approveTask(taskId, /* skipReviewGate */ true);

    // 第一次失败 → 应回退 running + 注入反馈
    const afterFirst = getTaskById(taskId)!;
    expect(afterFirst.status).toBe("running");
    const meta1 = JSON.parse(afterFirst.metadata ?? "{}");
    expect(meta1.verification_attempts).toBe(1);

    // 反馈已 queue (agent 看到的失败原因)
    const pending1 = drainPendingMessages(taskId);
    expect(pending1.some((m) => m.includes("[机械验收门]") && m.includes("exit=1"))).toBe(true);

    // 现在改 attempt.txt = '0', 让第二次跑过
    fs.writeFileSync(path.join(taskCwd, "attempt.txt"), "0");

    // 把 task 拉回 reviewing, 再 approveTask 一次 (模拟 agent 重跑完)
    updateTaskStatus(taskId, "reviewing");
    runtime.approveTask(taskId, /* skipReviewGate */ true);

    const afterSecond = getTaskById(taskId)!;
    expect(afterSecond.status).toBe("completed");
    const meta2 = JSON.parse(afterSecond.metadata ?? "{}");
    // 成功后 verification_attempts 不增, 仍是 1
    expect(meta2.verification_attempts).toBe(1);
    expect(meta2.verification_last_result?.succeeded).toBe(true);
  });

  it("L1+L2 都开 + 重试耗尽 → verifying → failed (B3 = 2 retries → 3 attempts 全 fail)", () => {
    setVerificationGloballyEnabled(true);
    const project = createProject({ name: "p-exhaust", ownerId });
    updateProject(project.id, {
      verification_command: "node -e \"process.exit(7)\"", // 永远 exit 7
      verification_max_retries: 2, // B3 默认值, 总尝试 = 3
    });

    const taskId = makeReviewingTask(project.id);
    const runtime = new AgentRuntime();

    // 第一次失败 → 回退 running
    runtime.approveTask(taskId, /* skipReviewGate */ true);
    expect(getTaskById(taskId)!.status).toBe("running");
    drainPendingMessages(taskId); // 清掉反馈, 不影响断言
    updateTaskStatus(taskId, "reviewing");

    // 第二次失败 → 回退 running
    runtime.approveTask(taskId, /* skipReviewGate */ true);
    expect(getTaskById(taskId)!.status).toBe("running");
    drainPendingMessages(taskId);
    updateTaskStatus(taskId, "reviewing");

    // 第三次失败 → 重试耗尽 → failed
    runtime.approveTask(taskId, /* skipReviewGate */ true);
    const final = getTaskById(taskId)!;
    expect(final.status).toBe("failed");
    expect(final.error).toContain("Verification failed after 3 attempts");
    expect(final.error).toContain("exit=7");

    const meta = JSON.parse(final.metadata ?? "{}");
    expect(meta.verification_attempts).toBe(3);
  });

  it("跨项目隔离: A 项目配 command / B 项目不配 → B 的 task 不进 verifying", () => {
    setVerificationGloballyEnabled(true);
    const projectA = createProject({ name: "p-cross-a", ownerId });
    const projectB = createProject({ name: "p-cross-b", ownerId });
    updateProject(projectA.id, { verification_command: "echo from-A" });
    // B 不配 (null 默认)

    const taskA = makeReviewingTask(projectA.id, "A-task");
    const taskB = makeReviewingTask(projectB.id, "B-task");

    const runtime = new AgentRuntime();
    runtime.approveTask(taskA, /* skipReviewGate */ true);
    runtime.approveTask(taskB, /* skipReviewGate */ true);

    // A: 走完 verifying → completed
    expect(getTaskById(taskA)!.status).toBe("completed");
    expect(statusChanges(taskA).map((e) => e.to)).toContain("verifying");

    // B: 直接 completed, 没有 verifying
    expect(getTaskById(taskB)!.status).toBe("completed");
    expect(statusChanges(taskB).map((e) => e.to)).toEqual(["completed"]);
  });
});
