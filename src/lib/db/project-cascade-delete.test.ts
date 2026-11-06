// v33: 删项目/版本 = 级联软删.
//
// 修复的 bug: tasks.project_id / tasks.version_id 没有 ON DELETE 子句, 而
// getDb() 开了 PRAGMA foreign_keys=ON, 所以裸 DELETE FROM projects 对任何有
// task 的项目都 FK 约束失败 -> API 500 (且前端不检查 res.ok, 表现为「点了删除
// 没反应」).
//
// 本文件断言的是**行为**而不是实现: 删完之后项目从列表消失、task 行仍在库里
// (软删不是硬删)、软删的名字不占用 UNIQUE、活项目重名仍被拦.
// 把 deleteProject/deleteVersion 改回 `DELETE FROM ...` 时, 这些用例必须变红.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  ensureUncategorizedProject,
  UNCATEGORIZED_NAME,
} from "./projects";
import { createVersion, deleteVersion, getVersionById, listVersions } from "./versions";
import { createTask, deleteTask, getTaskById, listTasks, getTaskCountsByScope } from "./tasks";
import { DELETED_TAG } from "../constants";

let tmpDir: string;
let userId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cascade-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // run all migrations (incl. v33) against the fresh temp DB
  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Raw row count — bypasses every deleted_at filter, so it distinguishes 软删 from 硬删. */
function rawTaskCount(projectId: string): number {
  return (
    getDb().prepare(`SELECT count(*) c FROM tasks WHERE project_id = ?`).get(projectId) as {
      c: number;
    }
  ).c;
}

function rawProject(id: string): { id: string; deleted_at: string | null } | undefined {
  return getDb().prepare(`SELECT id, deleted_at FROM projects WHERE id = ?`).get(id) as
    | { id: string; deleted_at: string | null }
    | undefined;
}

function mkProject(name = "proj") {
  return createProject({ name, ownerId: userId });
}

function mkTask(projectId: string, versionId?: string, title = "t") {
  return createTask({
    title,
    prompt: "p",
    project_id: projectId,
    ...(versionId ? { version_id: versionId } : {}),
  });
}

describe("v33 migration applied", () => {
  it("recorded v33 and added deleted_at to both tables", () => {
    const db = getDb();
    expect(db.prepare(`SELECT 1 FROM _migrations WHERE version = 33`).get()).toBeDefined();
    const pcols = (db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    const vcols = (db.prepare(`PRAGMA table_info(versions)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(pcols).toContain("deleted_at");
    expect(vcols).toContain("deleted_at");
  });

  it("kept idx_projects_pinned (DROP TABLE silently drops indexes)", () => {
    // The rebuild drops the old table; if the migration forgets to recreate this
    // index, listProjects' pinned ordering degrades to a full scan — silently.
    const idx = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_pinned'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("kept versions.project_id ON DELETE CASCADE through the rebuild", () => {
    const sql = (
      getDb()
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='versions'`)
        .get() as { sql: string }
    ).sql;
    expect(sql).toMatch(/ON\s+DELETE\s+CASCADE/i);
  });

  it("schema has no table-level UNIQUE left on projects/versions names", () => {
    // Table-level UNIQUE would re-break "delete then recreate same name".
    const psql = (
      getDb()
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`)
        .get() as { sql: string }
    ).sql;
    expect(psql).not.toMatch(/UNIQUE\s*\(\s*owner_id\s*,\s*name\s*\)/i);
  });
});

describe("deleteProject: 级联软删, 不是硬删", () => {
  it("returns 200-able (no FK throw) for a project that has tasks", () => {
    // This is the exact 500: FOREIGN KEY constraint failed on `DELETE FROM projects`.
    const p = mkProject();
    mkTask(p.id);
    expect(() => deleteProject(p.id)).not.toThrow();
  });

  it("soft-deletes and KEEPS the task rows (data recoverable)", () => {
    const p = mkProject();
    const live = mkTask(p.id, undefined, "live");
    const already = mkTask(p.id, undefined, "already-deleted");
    deleteTask(already.id); // pre-existing soft-deleted task

    deleteProject(p.id);

    // 🔴 the load-bearing assertion: rows still exist = soft delete, not hard.
    expect(rawTaskCount(p.id)).toBe(2);

    const rows = getDb()
      .prepare(`SELECT id, deleted_at FROM tasks WHERE project_id = ?`)
      .all(p.id) as Array<{ id: string; deleted_at: string | null }>;
    expect(rows.every((r) => r.deleted_at !== null)).toBe(true);

    // project itself is soft-deleted, its row also still present
    expect(rawProject(p.id)?.deleted_at).not.toBeNull();

    // and it's gone from the user-visible surfaces
    expect(getProjectById(p.id, userId)).toBeNull();
    expect(listProjects(userId).map((x) => x.id)).not.toContain(p.id);
    void live;
  });

  it("marks cascaded tasks with DELETED_TAG, same as deleteTask()", () => {
    // If deleteProject only wrote deleted_at, these rows would differ from the
    // ones deleteTask() produces — the UI's 「已删除」 badge and restore path
    // both key off the tag.
    const p = mkProject();
    const t = mkTask(p.id);
    deleteProject(p.id);
    const row = getDb().prepare(`SELECT tags FROM tasks WHERE id = ?`).get(t.id) as {
      tags: string | null;
    };
    expect(JSON.parse(row.tags ?? "[]")).toContain(DELETED_TAG);
  });

  it("cascades through versions to version-scoped tasks", () => {
    const p = mkProject();
    const v = createVersion({ project_id: p.id, name: "v1" });
    const t = mkTask(p.id, v.id);

    deleteProject(p.id);

    expect(getVersionById(v.id)).toBeNull();
    expect(listVersions(p.id, userId)).toHaveLength(0);
    expect(rawTaskCount(p.id)).toBe(1); // row kept
    expect(getTaskById(t.id)).toBeNull(); // but invisible
  });

  it("empty project still deletes (don't break the path that already worked)", () => {
    const p = mkProject("empty");
    expect(() => deleteProject(p.id)).not.toThrow();
    expect(getProjectById(p.id, userId)).toBeNull();
  });

  it("cascaded tasks disappear from global lists and scope counts", () => {
    const p = mkProject();
    mkTask(p.id);
    expect(listTasks({ ownerId: userId })).toHaveLength(1);

    deleteProject(p.id);

    expect(listTasks({ ownerId: userId })).toHaveLength(0);
    expect(listTasks({ ownerId: userId, project_id: p.id })).toHaveLength(0);
    const counts = getTaskCountsByScope(userId);
    expect(counts[`${p.id}:`]?.total ?? 0).toBe(0);
  });

  it("does not touch tasks of a sibling project", () => {
    const keep = mkProject("keep");
    const drop = mkProject("drop");
    const kept = mkTask(keep.id);
    mkTask(drop.id);

    deleteProject(drop.id);

    expect(getTaskById(kept.id)).not.toBeNull();
    expect(getProjectById(keep.id, userId)).not.toBeNull();
  });
});

describe("deleteVersion: 级联软删", () => {
  it("no FK throw for a version that has tasks, and rows are kept", () => {
    const p = mkProject();
    const v = createVersion({ project_id: p.id, name: "v1" });
    const t = mkTask(p.id, v.id);

    expect(() => deleteVersion(v.id)).not.toThrow();

    expect(getVersionById(v.id)).toBeNull();
    expect(
      (getDb().prepare(`SELECT count(*) c FROM versions WHERE id = ?`).get(v.id) as { c: number }).c
    ).toBe(1); // version row kept
    expect(rawTaskCount(p.id)).toBe(1); // task row kept
    expect(getTaskById(t.id)).toBeNull(); // invisible
    expect(getProjectById(p.id, userId)).not.toBeNull(); // parent untouched
  });

  it("clears the parent's dangling current_version_id", () => {
    // createVersion auto-sets the first version as current; soft-deleting it
    // without clearing leaves current_version_id pointing at an invisible row
    // (current_version_name resolves to NULL → 前端「有 current 但没名字」).
    const p = mkProject();
    const v = createVersion({ project_id: p.id, name: "v1" });
    expect(getProjectById(p.id)?.current_version_id).toBe(v.id);

    deleteVersion(v.id);

    expect(getProjectById(p.id)?.current_version_id).toBeNull();
  });

  it("falls back to another live version rather than NULL", () => {
    const p = mkProject();
    const v1 = createVersion({ project_id: p.id, name: "v1" });
    const v2 = createVersion({ project_id: p.id, name: "v2" });
    expect(getProjectById(p.id)?.current_version_id).toBe(v1.id);

    deleteVersion(v1.id);

    expect(getProjectById(p.id)?.current_version_id).toBe(v2.id);
  });
});

describe("partial unique index: 软删的名字不占用", () => {
  it("can recreate a same-named project after deleting one, as a NEW object", () => {
    const first = mkProject("官网");
    mkTask(first.id);
    deleteProject(first.id);

    const second = mkProject("官网");
    expect(second.id).not.toBe(first.id);
    // brand-new and empty; the old project's tasks stay with the old row
    expect(listTasks({ ownerId: userId, project_id: second.id })).toHaveLength(0);
    expect(rawProject(first.id)?.deleted_at).not.toBeNull();
    expect(rawTaskCount(first.id)).toBe(1);
  });

  it("still rejects two LIVE projects with the same name", () => {
    mkProject("dup");
    expect(() => mkProject("dup")).toThrow(/UNIQUE/i);
  });

  it("can recreate a same-named version after deleting one", () => {
    const p = mkProject();
    const v1 = createVersion({ project_id: p.id, name: "v1.6" });
    deleteVersion(v1.id);
    const v2 = createVersion({ project_id: p.id, name: "v1.6" });
    expect(v2.id).not.toBe(v1.id);
  });

  it("still rejects two LIVE versions with the same name in one project", () => {
    const p = mkProject();
    createVersion({ project_id: p.id, name: "v1" });
    expect(() => createVersion({ project_id: p.id, name: "v1" })).toThrow(/UNIQUE/i);
  });

  it("ensureUncategorizedProject works after 未分类 was deleted (the UNIQUE trap)", () => {
    // Under a table-level UNIQUE this INSERT would collide with the invisible
    // soft-deleted row and throw. The partial index is what makes it safe.
    const first = ensureUncategorizedProject(userId);
    expect(first.name).toBe(UNCATEGORIZED_NAME);
    deleteProject(first.id);

    let second!: ReturnType<typeof ensureUncategorizedProject>;
    expect(() => {
      second = ensureUncategorizedProject(userId);
    }).not.toThrow();
    expect(second.id).not.toBe(first.id);
    expect(second.deleted_at).toBeNull();
  });

  it("ensureUncategorizedProject stays idempotent for a live project", () => {
    const a = ensureUncategorizedProject(userId);
    const b = ensureUncategorizedProject(userId);
    expect(b.id).toBe(a.id);
  });
});

describe("soft-deleted project can't be used as a task target", () => {
  it("createTask rejects a soft-deleted project", () => {
    const p = mkProject();
    deleteProject(p.id);
    expect(() => mkTask(p.id)).toThrow(/not found/i);
  });

  it("createTask rejects a soft-deleted version", () => {
    const p = mkProject();
    const v = createVersion({ project_id: p.id, name: "v1" });
    deleteVersion(v.id);
    expect(() => mkTask(p.id, v.id)).toThrow(/not found/i);
  });
});
