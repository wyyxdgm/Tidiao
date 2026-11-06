// v76 (R108) checkpoints 表加 by / status 列回归测试.
//
// 关注点:
//   - ORCHESTRATOR_DB_PATH 临时库 + 全 migrations 跑 → 含 v76 ADD COLUMN.
//   - 老 marker 形态 (无 by/status) → insert 后 by/status = NULL (向后兼容).
//   - 新 marker 形态 (带 by/status) → insert 后字段值回读正确.
//   - ON CONFLICT DO UPDATE 同步覆盖 by/status (replay 重写不留老 NULL).
//   - 旧 schema 形态 (不带 by/status) 写 DB 也兼容, 不会破坏 INSERT 9 列.
//
// v50 schema 初始 CREATE TABLE checkpoints 没 by/status 列; v76 ADD COLUMN
// 走 ALTER, 跑两次幂等 (第二次 IF NOT EXISTS 触发无 op — SQLite ADD COLUMN
// 本身幂等, 这条测试套件在 isolated tmp db 内运行, 不会撞 v76 已应用过的 DB).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";

let tmpDir: string;
let testUserId: string;
let testProjectId: string;
let testTaskId: string;
let testSessionId: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-checkpoints-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  closeDb();
  getDb(); // 跑全部 migrations (含 v76) 到临时库

  testUserId = uuidv4();
  testSessionId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(testUserId, "checkpoints-test@example.com", "x", "admin");

  // checkpoints.task_id FK → tasks(id), 必建一行 task 才能 insert.
  const { createProject } = await import("./projects");
  testProjectId = createProject({ name: "checkpoints-test", ownerId: testUserId }).id;

  const { createTask } = await import("./tasks");
  const task = createTask({
    title: "checkpoints-test-task",
    prompt: "test",
    project_id: testProjectId,
    cwd: tmpDir,
  });
  testTaskId = task.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoints by/status (v76, R108)", () => {
  it("新 marker: by/status 都写进 DB, 回读字段值正确", async () => {
    const { insertCheckpoint, getCheckpointById } = await import("./checkpoints");
    const row = insertCheckpoint({
      task_id: testTaskId,
      session_id: testSessionId,
      step: "1",
      summary: "调研完成",
      by: "ao-dev",
      status: "waiting_reply",
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: "msg-1",
    });
    expect(row.by).toBe("ao-dev");
    expect(row.status).toBe("waiting_reply");

    const fetched = getCheckpointById(row.id);
    expect(fetched?.by).toBe("ao-dev");
    expect(fetched?.status).toBe("waiting_reply");
  });

  it("老 marker 形态 (不带 by/status): insert 后字段 = NULL (向后兼容)", async () => {
    const { insertCheckpoint, getCheckpointById } = await import("./checkpoints");
    // 模拟老 agent / 老 task transcript 调 insertCheckpoint 但不传 by/status.
    // type 上 by/status 是 `string | null`, 显式传 null = 等价 "老形态".
    const row = insertCheckpoint({
      task_id: testTaskId,
      session_id: testSessionId,
      step: "2",
      summary: "老 marker",
      by: null,
      status: null,
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: "msg-2",
    });
    expect(row.by).toBeNull();
    expect(row.status).toBeNull();

    const fetched = getCheckpointById(row.id);
    expect(fetched?.by).toBeNull();
    expect(fetched?.status).toBeNull();
  });

  it("ON CONFLICT DO UPDATE: 同 step 同 message 重写时 by/status 也跟着覆盖", async () => {
    const { insertCheckpoint, getCheckpointById } = await import("./checkpoints");
    // 第一次 insert: 无 by/status
    insertCheckpoint({
      task_id: testTaskId,
      session_id: testSessionId,
      step: "3",
      summary: "first",
      by: null,
      status: null,
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: "msg-3",
    });
    // replay / 重试同一 (task, step, up_to_message_id): 应触发 DO UPDATE
    const replayed = insertCheckpoint({
      task_id: testTaskId,
      session_id: testSessionId,
      step: "3",
      summary: "second",
      by: "partner",
      status: "has_suggestion",
      commit_id: null,
      transcript_slice: null,
      up_to_message_id: "msg-3",
    });
    expect(replayed.by).toBe("partner");
    expect(replayed.status).toBe("has_suggestion");
    expect(replayed.summary).toBe("second"); // 老 ON CONFLICT 也覆盖 summary

    // 回读也一致 (没有遗留老 NULL)
    const fetched = getCheckpointById(replayed.id);
    expect(fetched?.by).toBe("partner");
    expect(fetched?.status).toBe("has_suggestion");
  });

  it("v76 migration 真正添加了 by/status 列 (sqlite_master 验证)", async () => {
    // 防止 v76 没跑 / 列名拼错. 直接读 PRAGMA table_info.
    const db = getDb();
    const cols = db.prepare(`PRAGMA table_info(checkpoints)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("by");
    expect(names).toContain("status");
  });
});
