// /api/tasks/[id]/messages 条件拉取 (ETag) 的指纹契约 — 2026-10-08 压测批次.
//
// 压测实证: messages 全量 282KB/次 (公网隧道 0.8~3.3s), 是任务详情页最大
// payload. 指纹 = task.updated_at + session_id + MAX(events.id):
//   (1) 无写入时稳定 —— "没更新就不拉全量"的前提, 抖动会让 304 永远命中不了;
//   (2) agent 流式追加 events 时必变 —— 不变就是静默脏数据 (用户看不到新消息);
//   (3) task 字段更新 (含 resume 换 session_id) 时必变;
//   (4) ETag 无空白 —— SQLite datetime 带空格, 直接拼进 entity-tag 会被
//       浏览器/代理回传时截断 (R165 实测踩过), 304 永远命中不了.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createTask, getTaskById, updateTask } from "./tasks";
import { insertEvent, getMessagesFingerprintProbes } from "./events";

let tmpDir: string;
let ownerId: string;
let projectId: string;
let taskId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-msg-etag-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs migrations

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "msg-etag-proj", ownerId }).id;
  taskId = createTask({
    title: "msg-etag-task",
    prompt: "p",
    project_id: projectId,
  }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 与 messages route 同一份拼装逻辑 (route 内联, 这里镜像契约).
function fingerprintFor(taskId: string): string {
  const task = getTaskById(taskId)!;
  const probes = getMessagesFingerprintProbes(taskId);
  const sessionId = task.session_id || probes.lastSessionId || "nosession";
  return `msg-${String(task.updated_at).replace(/\s+/g, "T")}-${sessionId}-${probes.maxEventId}`;
}

describe("getMessagesFingerprintProbes / messages ETag 指纹", () => {
  it("(1) 无写入时稳定", () => {
    const a = fingerprintFor(taskId);
    const b = fingerprintFor(taskId);
    expect(b).toBe(a);
  });

  it("(2) 流式追加 events 时必变 (agent 输出新消息)", () => {
    const before = fingerprintFor(taskId);
    insertEvent({
      task_id: taskId,
      session_id: "sess-1",
      type: "message",
      data: JSON.stringify({ role: "assistant", text: "hello" }),
    });
    const after = fingerprintFor(taskId);
    expect(after).not.toBe(before);
    // 稳定方向也要守住: 不写入时两次相同
    expect(fingerprintFor(taskId)).toBe(after);
  });

  it("(3) task 更新 (含 resume 换 session_id) 时必变", () => {
    insertEvent({
      task_id: taskId,
      session_id: "sess-1",
      type: "message",
      data: JSON.stringify({ role: "user", text: "hi" }),
    });
    const before = fingerprintFor(taskId);
    updateTask(taskId, { session_id: "sess-2" });
    const after = fingerprintFor(taskId);
    expect(after).not.toBe(before);
    expect(after).toContain("sess-2");
  });

  it("(4) 指纹无空白 (RFC 9110 entity-tag 约束)", () => {
    insertEvent({
      task_id: taskId,
      session_id: "sess-1",
      type: "message",
      data: JSON.stringify({ role: "user", text: "hi" }),
    });
    expect(fingerprintFor(taskId)).not.toMatch(/\s/);
  });

  it("探针: 空 task 返回 maxEventId=0 + lastSessionId=null", () => {
    const probes = getMessagesFingerprintProbes(taskId);
    expect(probes.maxEventId).toBe(0);
    expect(probes.lastSessionId).toBeNull();
  });
});
