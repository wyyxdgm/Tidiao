// R113 (2026-09-07) task_commits 表 CRUD 测试.
//
// 关注点:
//   - ORCHESTRATOR_DB_PATH 临时库 + 全 migrations 跑 → 含 v130 CREATE TABLE.
//   - upsertTaskCommit: 新增 + 重复写 (PK conflict → 覆盖 desc/files + bump created_at).
//   - getTaskCommitsByTaskId: 按 created_at DESC 排序 + 派生 files 数组.
//   - files_json 解析失败 → 空数组 (不阻塞 commit 记录).
//   - 空 files 数组 → files_json 存 null (节省存储, 读时一致空数组).

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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-task-commits-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  closeDb();
  getDb(); // 跑全部 migrations (含 v130 CREATE TABLE task_commits) 到临时库

  testUserId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(testUserId, "task-commits-test@example.com", "x", "admin");

  // task_commits.task_id FK → tasks(id), 必建一行 task 才能 upsert.
  const { createProject } = await import("./projects");
  testProjectId = createProject({ name: "task-commits-test", ownerId: testUserId }).id;

  const { createTask } = await import("./tasks");
  const task = createTask({
    title: "task-commits-test-task",
    prompt: "test",
    project_id: testProjectId,
    cwd: tmpDir,
  });
  testTaskId = task.id;
});

afterEach(() => {
  closeDb();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("upsertTaskCommit", () => {
  it("writes a new row with desc + files, returns it back", async () => {
    const { upsertTaskCommit } = await import("./task-commits");
    const row = upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "abc1234567",
      desc: "fix: 修复 foo",
      files: ["src/foo.ts", "src/bar.ts"],
    });
    expect(row.task_id).toBe(testTaskId);
    expect(row.commit_id).toBe("abc1234567");
    expect(row.desc).toBe("fix: 修复 foo");
    expect(row.files_json).toBe(JSON.stringify(["src/foo.ts", "src/bar.ts"]));
  });

  it("upsert on PK conflict overwrites desc/files + bumps created_at", async () => {
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    const before = upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "deadbeef",
      desc: "first",
      files: ["a.ts"],
    });
    // Sleep > 1s so created_at (datetime() = 1s granularity) actually bumps.
    // SQLite datetime('now') = YYYY-MM-DD HH:MM:SS — sub-second identical.
    await new Promise((r) => setTimeout(r, 1100));
    const after = upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "deadbeef",
      desc: "second (overwrite)",
      files: ["a.ts", "b.ts", "c.ts"],
    });
    expect(after.task_id).toBe(testTaskId);
    expect(after.desc).toBe("second (overwrite)");
    expect(after.files_json).toBe(JSON.stringify(["a.ts", "b.ts", "c.ts"]));
    expect(after.created_at > before.created_at).toBe(true);
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows.length).toBe(1); // PK dedup
    expect(rows[0].desc).toBe("second (overwrite)");
  });

  it("empty files list stores NULL (not '[]') and reads back as []", async () => {
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "cafebabe",
      desc: "no files",
    });
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows[0].files_json).toBeNull();
    expect(rows[0].files).toEqual([]); // helper parses null → []
  });

  it("null desc is allowed (commit_id-only marker)", async () => {
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "1234567",
    });
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows[0].desc).toBeNull();
    expect(rows[0].files).toEqual([]);
  });
});

describe("getTaskCommitsByTaskId", () => {
  it("orders by created_at DESC, commit_id ASC tiebreak", async () => {
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    // Insert in non-chronological order to verify DESC ordering.
    upsertTaskCommit({ task_id: testTaskId, commit_id: "aaaa111", desc: "oldest" });
    await new Promise((r) => setTimeout(r, 1100));
    upsertTaskCommit({ task_id: testTaskId, commit_id: "bbbb222", desc: "middle" });
    await new Promise((r) => setTimeout(r, 1100));
    upsertTaskCommit({ task_id: testTaskId, commit_id: "cccc333", desc: "newest" });
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.commit_id)).toEqual(["cccc333", "bbbb222", "aaaa111"]);
  });

  it("returns empty array for task with no commits", async () => {
    const { getTaskCommitsByTaskId } = await import("./task-commits");
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows).toEqual([]);
  });

  it("does not leak commits across tasks", async () => {
    const { createTask } = await import("./tasks");
    const otherTask = createTask({
      title: "other-task",
      prompt: "test",
      project_id: testProjectId,
      cwd: tmpDir,
    });
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    upsertTaskCommit({ task_id: testTaskId, commit_id: "1111111", desc: "mine" });
    upsertTaskCommit({ task_id: otherTask.id, commit_id: "2222222", desc: "other" });
    const mine = getTaskCommitsByTaskId(testTaskId);
    const other = getTaskCommitsByTaskId(otherTask.id);
    expect(mine.map((r) => r.commit_id)).toEqual(["1111111"]);
    expect(other.map((r) => r.commit_id)).toEqual(["2222222"]);
  });
});

describe("files_json parse robustness", () => {
  it("malformed JSON in files_json → empty array, row still readable", async () => {
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    // Insert a valid row first, then corrupt files_json directly via raw SQL
    // (simulating a future migration that might write bad data).
    upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "abcdef0",
      desc: "ok",
      files: ["a.ts"],
    });
    getDb()
      .prepare("UPDATE task_commits SET files_json = ? WHERE task_id = ? AND commit_id = ?")
      .run("not-valid-json{[", testTaskId, "abcdef0");
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows.length).toBe(1);
    expect(rows[0].desc).toBe("ok"); // desc still readable
    expect(rows[0].files).toEqual([]); // parse failure → safe empty array
  });

  it("JSON array containing non-strings → filter to strings only", async () => {
    const { upsertTaskCommit, getTaskCommitsByTaskId } = await import("./task-commits");
    upsertTaskCommit({
      task_id: testTaskId,
      commit_id: "feedface",
      desc: "mixed",
      files: ["a.ts", "b.ts"],
    });
    // Inject a non-string into the array.
    getDb()
      .prepare("UPDATE task_commits SET files_json = ? WHERE task_id = ? AND commit_id = ?")
      .run(JSON.stringify(["a.ts", 42, null, "b.ts"]), testTaskId, "feedface");
    const rows = getTaskCommitsByTaskId(testTaskId);
    expect(rows[0].files).toEqual(["a.ts", "b.ts"]);
  });
});
