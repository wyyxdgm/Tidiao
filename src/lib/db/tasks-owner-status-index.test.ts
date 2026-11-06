// v49 复合索引 (owner_id, status, updated_at, created_at) 的回归保护.
//   - 索引存在: PRAGMA index_list('tasks') 含 idx_tasks_owner_status_updated
//   - 索引列序正确: PRAGMA index_info(...) 列依次为 owner_id, status, updated_at, created_at
//
// 这条不变量是 listTasksPage 性能收益的根基 — 没有它, 300+ terminal 行就是全表
// 扫 + 内存 sort, 这次改造立刻归零。如果有人删了这条索引或挪动列序, 这个测试
// 应该立刻红.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-index-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs all migrations, including v49

  // also seed a user so the test setup matches real-world state
  const ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("v49: idx_tasks_owner_status_updated composite index", () => {
  it("is created after migrations run", () => {
    const db = getDb();
    const indexes = db.prepare("PRAGMA index_list('tasks')").all() as Array<{
      name: string;
      unique: number;
    }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_tasks_owner_status_updated");
  });

  it("has columns in the right order: owner_id, status, updated_at, created_at", () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA index_info('idx_tasks_owner_status_updated')")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      "owner_id",
      "status",
      "updated_at",
      "created_at",
    ]);
  });

  it("is non-unique (lets the same owner have many tasks in any status)", () => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT [unique] FROM pragma_index_list('tasks') WHERE name = 'idx_tasks_owner_status_updated'"
      )
      .get() as { unique: number } | undefined;
    expect(row).toBeDefined();
    // 0 = non-unique, 1 = unique. 必须 0, 因为同一 (owner, status) 可以有多条.
    expect(row!.unique).toBe(0);
  });
});