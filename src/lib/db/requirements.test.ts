// Tests for in_app requirements DB module (R60 P0 新 spec, v64 migration).
//
// 覆盖范围:
//   - createRequirement: happy path + 默认 status/source + tags JSON
//   - getRequirementById: 命中 + 不存在 + 跨 owner 隔离
//   - listRequirements: 分页 (has_more) + status 过滤 + 多租户隔离
//   - updateRequirement: 白名单字段生效 + 非白名单静默忽略 + status 越界忽略 +
//     priority 越界忽略 + 跨 owner 不写
//   - softDeleteRequirement: 软删成功 + 二次 no-op + 跨 owner 失败
//   - parseRequirementTags: 有效 JSON + 无效 JSON + 非数组 + null
//   - getRequirementTasks: 关联 task + 森林 edges

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  createRequirement,
  getRequirementById,
  listRequirements,
  updateRequirement,
  softDeleteRequirement,
  getRequirementTasks,
  hasCompletedImplementationTask,
  countActiveDesignTasks,
  computeRuleProgress,
  applyRuleProgress,
  parseRequirementTags,
  serializeRequirementTags,
  REQUIREMENT_STATUSES,
  type Requirement,
} from "./requirements";

let tmpDir: string;
let ownerA: string;
let ownerB: string;
let projectA: string;

function seedUser(email: string): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(id, email, "x");
  return id;
}

function seedProject(name: string, ownerId?: string): string {
  const id = uuidv4();
  getDb()
    .prepare("INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)")
    .run(id, name, ownerId ?? null);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-req-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // runs all migrations, including v63 + v64
  ownerA = seedUser(`a-${uuidv4()}@example.com`);
  ownerB = seedUser(`b-${uuidv4()}@example.com`);
  projectA = seedProject(`proj-${uuidv4()}`, ownerA);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- parseRequirementTags / serializeRequirementTags ----

describe("parseRequirementTags", () => {
  it("parses valid JSON array of strings", () => {
    expect(parseRequirementTags('["a","b","c"]')).toEqual(["a", "b", "c"]);
  });
  it("returns [] for null/undefined/empty", () => {
    expect(parseRequirementTags(null)).toEqual([]);
    expect(parseRequirementTags(undefined)).toEqual([]);
    expect(parseRequirementTags("")).toEqual([]);
  });
  it("returns [] for invalid JSON", () => {
    expect(parseRequirementTags("not json")).toEqual([]);
    expect(parseRequirementTags("{not array}")).toEqual([]);
  });
  it("returns [] for non-array JSON", () => {
    expect(parseRequirementTags('{"a":1}')).toEqual([]);
    expect(parseRequirementTags("123")).toEqual([]);
  });
  it("filters non-string elements", () => {
    expect(parseRequirementTags('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });
});

describe("serializeRequirementTags", () => {
  it("serializes array to JSON", () => {
    expect(serializeRequirementTags(["a", "b"])).toBe('["a","b"]');
  });
  it("returns null for empty/null/undefined", () => {
    expect(serializeRequirementTags([])).toBeNull();
    expect(serializeRequirementTags(null)).toBeNull();
    expect(serializeRequirementTags(undefined)).toBeNull();
  });
});

// ---- createRequirement ----

describe("createRequirement", () => {
  it("creates with defaults: status=pending, source=in_app, owner_id", () => {
    const r = createRequirement(projectA, { title: "Need X" }, ownerA);
    expect(r.title).toBe("Need X");
    expect(r.status).toBe("pending");
    expect(r.source).toBe("in_app");
    expect(r.owner_id).toBe(ownerA);
    expect(r.project_id).toBe(projectA);
    expect(r.priority).toBeNull();
    expect(r.description).toBeNull();
    expect(r.tags).toBeNull();
  });

  it("persists description / priority / tags", () => {
    const r = createRequirement(
      projectA,
      { title: "Need Y", description: "Desc", priority: 3, tags: ["ui", "p1"] },
      ownerA
    );
    expect(r.description).toBe("Desc");
    expect(r.priority).toBe(3);
    expect(parseRequirementTags(r.tags)).toEqual(["ui", "p1"]);
  });

  it("REQUIRES title (schema NOT NULL)", () => {
    expect(() => {
      getDb()
        .prepare(
          "INSERT INTO requirements (id, project_id, title, owner_id) VALUES (?, ?, NULL, ?)"
        )
        .run(uuidv4(), projectA, ownerA);
    }).toThrow(/NOT NULL/i);
  });

  // R64: version_id 可选. 默认 = project.current_version_id; null = 显式不挂; 字符串 = 用入参.
  it("R64: defaults version_id to projects.current_version_id when not provided", () => {
    const versionId = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(versionId, projectA, "v1");
    getDb()
      .prepare("UPDATE projects SET current_version_id = ? WHERE id = ?")
      .run(versionId, projectA);
    const r = createRequirement(projectA, { title: "With Default Version" }, ownerA);
    expect(r.version_id).toBe(versionId);
  });

  it("R64: explicit null version_id means 'do not attach to any version'", () => {
    const versionId = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(versionId, projectA, "v1");
    getDb()
      .prepare("UPDATE projects SET current_version_id = ? WHERE id = ?")
      .run(versionId, projectA);
    const r = createRequirement(projectA, { title: "No Version", version_id: null }, ownerA);
    expect(r.version_id).toBeNull();
  });

  it("R64: explicit version_id override (v1 -> v2 migration use case)", () => {
    const v1 = uuidv4();
    const v2 = uuidv4();
    // 必须先 INSERT versions, 再 UPDATE current_version_id (FK 约束).
    for (const vid of [v1, v2]) {
      getDb()
        .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
        .run(vid, projectA, `ver-${vid.slice(0, 4)}`);
    }
    getDb()
      .prepare("UPDATE projects SET current_version_id = ? WHERE id = ?")
      .run(v1, projectA);
    const r = createRequirement(
      projectA,
      { title: "Migrate to v2", version_id: v2 },
      ownerA
    );
    expect(r.version_id).toBe(v2);
  });

  it("R64: rejects version_id that belongs to a different project (trigger)", () => {
    const otherProject = seedProject(`other-${uuidv4()}`);
    const otherVersion = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(otherVersion, otherProject, "other-ver");
    expect(() => {
      createRequirement(
        projectA,
        { title: "Cross-Project", version_id: otherVersion },
        ownerA
      );
    }).toThrow(/must belong to same project/i);
  });
});

// ---- getRequirementById ----

describe("getRequirementById", () => {
  it("returns the row when owner matches", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const got = getRequirementById(r.id, ownerA);
    expect(got?.id).toBe(r.id);
  });

  it("returns null when owner does not match (multi-tenant isolation)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const got = getRequirementById(r.id, ownerB);
    expect(got).toBeNull();
  });

  it("returns null when id does not exist", () => {
    expect(getRequirementById("non-existent", ownerA)).toBeNull();
  });
});

// ---- listRequirements ----

describe("listRequirements", () => {
  it("returns empty list when no rows", () => {
    const out = listRequirements({}, ownerA);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.has_more).toBe(false);
  });

  it("lists only owner's rows (multi-tenant isolation)", () => {
    createRequirement(projectA, { title: "A1" }, ownerA);
    createRequirement(projectA, { title: "A2" }, ownerA);
    createRequirement(projectA, { title: "B1" }, ownerB);
    const out = listRequirements({}, ownerA);
    expect(out.items).toHaveLength(2);
    expect(out.total).toBe(2);
    expect(out.items.every((r) => r.owner_id === ownerA)).toBe(true);
  });

  it("paginates with has_more + page metadata", () => {
    for (let i = 0; i < 25; i++) {
      createRequirement(projectA, { title: `r-${i}` }, ownerA);
    }
    const p1 = listRequirements({ page: 1, page_size: 10 }, ownerA);
    expect(p1.items).toHaveLength(10);
    expect(p1.total).toBe(25);
    expect(p1.has_more).toBe(true);
    expect(p1.page).toBe(1);
    expect(p1.page_size).toBe(10);

    const p3 = listRequirements({ page: 3, page_size: 10 }, ownerA);
    expect(p3.items).toHaveLength(5);
    expect(p3.has_more).toBe(false);
  });

  it("filters by status (single)", () => {
    const r1 = createRequirement(projectA, { title: "t1" }, ownerA);
    createRequirement(projectA, { title: "t2" }, ownerA);
    updateRequirement(r1.id, { status: "done" }, ownerA);
    const out = listRequirements({ status: "done" }, ownerA);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe(r1.id);
  });

  it("filters by status (array)", () => {
    const r1 = createRequirement(projectA, { title: "t1" }, ownerA);
    const r2 = createRequirement(projectA, { title: "t2" }, ownerA);
    updateRequirement(r1.id, { status: "done" }, ownerA);
    updateRequirement(r2.id, { status: "blocked" }, ownerA);
    const out = listRequirements({ status: ["done", "blocked"] }, ownerA);
    expect(out.items).toHaveLength(2);
  });

  it("filters by project_id", () => {
    const projectB = seedProject(`proj-b-${uuidv4()}`);
    createRequirement(projectA, { title: "A" }, ownerA);
    createRequirement(projectB, { title: "B" }, ownerA);
    const out = listRequirements({ project_id: projectA }, ownerA);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].project_id).toBe(projectA);
  });

  // R64: version_id 过滤 (string = 该 version; null = 无 version; 不传 = 不过滤).
  it("R64: filters by version_id (string match)", () => {
    const v1 = uuidv4();
    const v2 = uuidv4();
    for (const vid of [v1, v2]) {
      getDb()
        .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
        .run(vid, projectA, `v-${vid.slice(0, 4)}`);
    }
    createRequirement(projectA, { title: "in v1", version_id: v1 }, ownerA);
    createRequirement(projectA, { title: "in v2", version_id: v2 }, ownerA);
    createRequirement(projectA, { title: "no version", version_id: null }, ownerA);
    const out = listRequirements({ version_id: v1 }, ownerA);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("in v1");
  });

  it("R64: filters by version_id=null means 'no version attached'", () => {
    const v1 = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(v1, projectA, "v1");
    createRequirement(projectA, { title: "in v1", version_id: v1 }, ownerA);
    createRequirement(projectA, { title: "no version", version_id: null }, ownerA);
    const out = listRequirements({ version_id: null }, ownerA);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("no version");
  });
});

// ---- updateRequirement ----

describe("updateRequirement", () => {
  it("updates whitelisted fields and bumps updated_at", () => {
    const r = createRequirement(projectA, { title: "Old" }, ownerA);
    // sqlite datetime('now') is second-precision — same-second updates may collide.
    // We assert: (a) all whitelisted fields land correctly, (b) updated_at is a valid
    // YYYY-MM-DD HH:MM:SS string ≥ old value (lexicographic compare works for ISO-ish).
    const updated = updateRequirement(
      r.id,
      { title: "New", description: "d", priority: 5, status: "blocked" },
      ownerA
    );
    expect(updated?.title).toBe("New");
    expect(updated?.description).toBe("d");
    expect(updated?.priority).toBe(5);
    expect(updated?.status).toBe("blocked");
    expect(updated?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(updated!.updated_at >= r.updated_at).toBe(true);
  });

  it("ignores non-whitelisted fields silently (id, project_id, source, created_at)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const updated = updateRequirement(
      r.id,
      {
        id: "hacked",
        project_id: "hacked-proj",
        source: "feishu" as any,
        created_at: "1970-01-01",
        title: "ok",
      } as any,
      ownerA
    );
    expect(updated?.title).toBe("ok");
    expect(updated?.id).toBe(r.id); // id unchanged
    expect(updated?.project_id).toBe(r.project_id); // project_id unchanged
    expect(updated?.source).toBe("in_app"); // source unchanged
    expect(updated?.created_at).toBe(r.created_at); // created_at unchanged
  });

  it("ignores invalid status values", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const updated = updateRequirement(r.id, { status: "invalid_status" as any }, ownerA);
    expect(updated?.status).toBe("pending"); // unchanged
  });

  it("ignores out-of-range priority (must be 1-5)", () => {
    const r = createRequirement(projectA, { title: "T", priority: 3 }, ownerA);
    const updated1 = updateRequirement(r.id, { priority: 99 }, ownerA);
    expect(updated1?.priority).toBe(3); // unchanged
    const updated2 = updateRequirement(r.id, { priority: 0 }, ownerA);
    expect(updated2?.priority).toBe(3); // unchanged
  });

  it("does NOT update rows owned by other user (cross-owner no-op)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const result = updateRequirement(r.id, { title: "Hacked" }, ownerB);
    expect(result).toBeNull();
    const stillThere = getRequirementById(r.id, ownerA);
    expect(stillThere?.title).toBe("T"); // unchanged
  });

  it("returns current row when patch is empty / all fields ignored", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const updated = updateRequirement(r.id, { id: "x" } as any, ownerA);
    expect(updated?.id).toBe(r.id);
  });

  it("REQUIREMENT_STATUSES contains all 6 expected values", () => {
    expect(REQUIREMENT_STATUSES).toEqual([
      "pending",
      "done",
      "awaiting_reply",
      "has_suggestion",
      "blocked",
      "closed",
    ]);
  });

  // R64: version_id 在白名单里, 可写; 跨 project / 不存在 = 静默忽略.
  it("R64: update version_id to a valid version of the same project (v1 -> v2 migration)", () => {
    const v1 = uuidv4();
    const v2 = uuidv4();
    for (const vid of [v1, v2]) {
      getDb()
        .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
        .run(vid, projectA, `v-${vid.slice(0, 4)}`);
    }
    const r = createRequirement(projectA, { title: "T", version_id: v1 }, ownerA);
    expect(r.version_id).toBe(v1);
    const updated = updateRequirement(r.id, { version_id: v2 }, ownerA);
    expect(updated?.version_id).toBe(v2);
  });

  it("R64: update version_id to null (un-attach from any version)", () => {
    const v1 = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(v1, projectA, "v1");
    const r = createRequirement(projectA, { title: "T", version_id: v1 }, ownerA);
    const updated = updateRequirement(r.id, { version_id: null }, ownerA);
    expect(updated?.version_id).toBeNull();
  });

  it("R64: ignores version_id from a different project (no exception, value unchanged)", () => {
    const v1 = uuidv4();
    const otherProject = seedProject(`other-${uuidv4()}`);
    const otherVersion = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(v1, projectA, "v1");
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(otherVersion, otherProject, "other-v");
    const r = createRequirement(projectA, { title: "T", version_id: v1 }, ownerA);
    const updated = updateRequirement(r.id, { version_id: otherVersion }, ownerA);
    expect(updated?.version_id).toBe(v1); // unchanged, cross-project ignored
  });

  it("R64: ignores nonexistent version_id (no exception, value unchanged)", () => {
    const v1 = uuidv4();
    getDb()
      .prepare("INSERT INTO versions (id, project_id, name) VALUES (?, ?, ?)")
      .run(v1, projectA, "v1");
    const r = createRequirement(projectA, { title: "T", version_id: v1 }, ownerA);
    const updated = updateRequirement(r.id, { version_id: "does-not-exist" }, ownerA);
    expect(updated?.version_id).toBe(v1); // unchanged
  });
});

// ---- softDeleteRequirement ----

describe("softDeleteRequirement", () => {
  it("sets status='closed' (visible to GET but marked closed)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const ok = softDeleteRequirement(r.id, ownerA);
    expect(ok).toBe(true);
    const after = getRequirementById(r.id, ownerA);
    expect(after?.status).toBe("closed");
  });

  it("second softDelete is no-op (returns false)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    softDeleteRequirement(r.id, ownerA);
    const ok2 = softDeleteRequirement(r.id, ownerA);
    expect(ok2).toBe(false);
  });

  it("does NOT soft-delete cross-owner (returns false)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const ok = softDeleteRequirement(r.id, ownerB);
    expect(ok).toBe(false);
    const after = getRequirementById(r.id, ownerA);
    expect(after?.status).toBe("pending");
  });
});

// ---- getRequirementTasks (forest API) ----

describe("getRequirementTasks", () => {
  function insertTask(
    requirementId: string | null,
    title: string,
    status: string,
    dependsOn: string[] = []
  ): string {
    const id = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, '')`
      )
      .run(id, title, status, ownerA, projectA, requirementId, JSON.stringify(dependsOn));
    return id;
  }

  it("returns empty tasks list when no association", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const out = getRequirementTasks(r.id);
    expect(out.tasks).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it("returns linked tasks with status", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    insertTask(r.id, "t1", "running");
    insertTask(r.id, "t2", "completed");
    insertTask(null, "other", "queued"); // not linked
    const out = getRequirementTasks(r.id);
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks.map((t) => t.title).sort()).toEqual(["t1", "t2"]);
  });

  it("withDeps=true returns dependency edges", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const t1 = insertTask(r.id, "t1", "running");
    const t2 = insertTask(r.id, "t2", "queued", [t1]);
    const out = getRequirementTasks(r.id, true);
    expect(out.tasks).toHaveLength(2);
    expect(out.edges).toEqual([{ from: t2, to: t1 }]);
  });

  it("withDeps=false omits edges", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const t1 = insertTask(r.id, "t1", "running");
    insertTask(r.id, "t2", "queued", [t1]);
    const out = getRequirementTasks(r.id, false);
    expect(out.edges).toEqual([]);
  });

  it("handles corrupted depends_on JSON gracefully (no edges)", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const id = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt)
         VALUES (?, 't', 'queued', ?, ?, ?, 'not-json', '')`
      )
      .run(id, ownerA, projectA, r.id);
    const out = getRequirementTasks(r.id, true);
    expect(out.tasks).toHaveLength(1);
    expect(out.edges).toEqual([]);
  });
});

// ---- type check: Requirement interface ----

describe("Requirement interface shape", () => {
  it("has all spec §4.1 fields + R64 version_id, and NO v42 remnants", () => {
    const r = createRequirement(projectA, { title: "T" }, ownerA);
    const keys = Object.keys(r).sort();
    expect(keys).toEqual([
      "created_at",
      "description",
      "id",
      "owner_id",
      "priority",
      "progress", // v517 (R196): 完成度
      "progress_note", // v517: 评估依据
      "progress_source", // v517: rule/manual/ai
      "progress_updated_at", // v517: 最近更新
      "project_id",
      "source",
      "status",
      "tags",
      "title",
      "updated_at",
      "version_id", // R64: 可选挂 version
    ]);
    // v42 fields absent
    expect(keys).not.toContain("module_hint");
    expect(keys).not.toContain("iteration_count");
    expect(keys).not.toContain("current_task_id");
    expect(keys).not.toContain("column_values");
    expect(keys).not.toContain("deleted_at");
    expect(keys).not.toContain("drop_reason");
    expect(keys).not.toContain("source_ref");
  });
});

// ---- R78 W1 §4.3 invariant helpers ----
//
// 覆盖:
//   - hasCompletedImplementationTask: 至少一个 type ∈ {dev,test,deploy} + status='completed'
//   - countActiveDesignTasks: type='design' 且未终态的 task 计数
//   - 跨 owner 隔离 (其他 owner 的 task 不算)
//   - design-only 完成后 invariant = false (核心, 防设计态被误标 done)

describe("R78 W1 invariant helpers", () => {
  // 最小 task 写入 helper — 不走 createTask (避免引整个 runtime).
  // 只塞 R78 W1 关心的字段 (type/status/requirement_id/owner_id).
  function seedTask(opts: {
    type: string | null;
    status: string;
    requirementId: string;
    ownerId: string;
  }): string {
    const id = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'seed-task', ?, ?, ?, ?, '[]', '', ?)`
      )
      .run(id, opts.status, opts.ownerId, projectA, opts.requirementId, opts.type);
    return id;
  }

  it("hasCompletedImplementationTask: 没有 task = false", () => {
    const r = createRequirement(projectA, { title: "empty req" }, ownerA);
    expect(hasCompletedImplementationTask(r.id, ownerA)).toBe(false);
  });

  it("hasCompletedImplementationTask: 只有 design 完成任务 = false (核心 invariant)", () => {
    const r = createRequirement(projectA, { title: "design-only req" }, ownerA);
    seedTask({ type: "design", status: "completed", requirementId: r.id, ownerId: ownerA });
    seedTask({ type: "design", status: "reviewing", requirementId: r.id, ownerId: ownerA });
    expect(hasCompletedImplementationTask(r.id, ownerA)).toBe(false);
  });

  it("hasCompletedImplementationTask: dev task 完成 = true", () => {
    const r = createRequirement(projectA, { title: "dev req" }, ownerA);
    seedTask({ type: "dev", status: "completed", requirementId: r.id, ownerId: ownerA });
    expect(hasCompletedImplementationTask(r.id, ownerA)).toBe(true);
  });

  it("hasCompletedImplementationTask: test/deploy 完成同样算 true", () => {
    const r1 = createRequirement(projectA, { title: "test req" }, ownerA);
    seedTask({ type: "test", status: "completed", requirementId: r1.id, ownerId: ownerA });
    expect(hasCompletedImplementationTask(r1.id, ownerA)).toBe(true);

    const r2 = createRequirement(projectA, { title: "deploy req" }, ownerA);
    seedTask({ type: "deploy", status: "completed", requirementId: r2.id, ownerId: ownerA });
    expect(hasCompletedImplementationTask(r2.id, ownerA)).toBe(true);
  });

  it("hasCompletedImplementationTask: dev task 在 reviewing/queued/failed 都不算", () => {
    const r = createRequirement(projectA, { title: "in-flight dev" }, ownerA);
    seedTask({ type: "dev", status: "reviewing", requirementId: r.id, ownerId: ownerA });
    seedTask({ type: "dev", status: "queued", requirementId: r.id, ownerId: ownerA });
    seedTask({ type: "dev", status: "failed", requirementId: r.id, ownerId: ownerA });
    expect(hasCompletedImplementationTask(r.id, ownerA)).toBe(false);
  });

  it("hasCompletedImplementationTask: type=null 的 task 不算 (关键: 防止 uncategorized 误入)", () => {
    const r = createRequirement(projectA, { title: "uncategorized req" }, ownerA);
    seedTask({ type: null, status: "completed", requirementId: r.id, ownerId: ownerA });
    expect(hasCompletedImplementationTask(r.id, ownerA)).toBe(false);
  });

  it("hasCompletedImplementationTask: 跨 owner task 不算 (多租户)", () => {
    const r = createRequirement(projectA, { title: "owner-isolated" }, ownerA);
    // ownerB 的 dev task 完成 — 不应被 ownerA 看到
    seedTask({ type: "dev", status: "completed", requirementId: r.id, ownerId: ownerB });
    expect(hasCompletedImplementationTask(r.id, ownerA)).toBe(false);
    // 但 ownerB 查自己的 task 时能看到 (if 跨 owner 查询 — 但 ownerB 不属于这个 requirement,
    //   这里只验证 owner 过滤生效)
  });

  it("countActiveDesignTasks: design 任务 active 计数 = 当前 task 数", () => {
    const r = createRequirement(projectA, { title: "design-mix" }, ownerA);
    seedTask({ type: "design", status: "completed", requirementId: r.id, ownerId: ownerA });
    seedTask({ type: "design", status: "reviewing", requirementId: r.id, ownerId: ownerA });
    seedTask({ type: "design", status: "running", requirementId: r.id, ownerId: ownerA });
    seedTask({ type: "design", status: "cancelled", requirementId: r.id, ownerId: ownerA });
    // 只有 completed/cancelled 不计 — running + reviewing = 2 active
    expect(countActiveDesignTasks(r.id, ownerA)).toBe(2);
  });
});

// ---- 完成度量化 (v517 / 飞书 R196) ----

describe("requirement progress (R196)", () => {
  function insertTask(
    requirementId: string,
    status: string,
    progress: number | null = null
  ): string {
    const id = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, prompt, progress)
         VALUES (?, ?, ?, ?, ?, ?, '', ?)`
      )
      .run(id, `t-${id.slice(0, 6)}`, status, ownerA, projectA, requirementId, progress);
    return id;
  }

  it("updateRequirement 写入 progress 0-100 + progress_source='manual'", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    const updated = updateRequirement(
      r.id,
      { progress: 60, progress_note: "半成", progress_source: "manual" },
      ownerA
    );
    expect(updated?.progress).toBe(60);
    expect(updated?.progress_source).toBe("manual");
    expect(updated?.progress_note).toBe("半成");
    expect(updated?.progress_updated_at).not.toBeNull();
  });

  it("updateRequirement progress 越界/非整数 = 忽略 (与 priority 同口径)", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    const updated = updateRequirement(
      r.id,
      { progress: 101 as unknown as number, progress_source: "manual" },
      ownerA
    );
    expect(updated?.progress).toBeNull();
    const updated2 = updateRequirement(
      r.id,
      { progress: 50.5 as unknown as number, progress_source: "manual" },
      ownerA
    );
    expect(updated2?.progress).toBeNull();
  });

  it("updateRequirement progress=null 清空 (progress_source 一并清)", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    updateRequirement(r.id, { progress: 30, progress_source: "manual" }, ownerA);
    const cleared = updateRequirement(r.id, { progress: null }, ownerA);
    expect(cleared?.progress).toBeNull();
    expect(cleared?.progress_source).toBeNull();
  });

  it("computeRuleProgress: 无 task = 0; status done = 100", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    expect(computeRuleProgress(r.id)).toBe(0);
    updateRequirement(r.id, { status: "done" }, ownerA);
    expect(computeRuleProgress(r.id)).toBe(100);
  });

  it("computeRuleProgress: task 自报 progress 优先, 聚合封顶 90 (未 done)", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    insertTask(r.id, "running", 40);
    insertTask(r.id, "running", 80);
    // avg = 60 → round(0.6 * 90) = 54
    expect(computeRuleProgress(r.id)).toBe(54);
  });

  it("computeRuleProgress: 无自报时按状态折算 (completed=100%, running=30%)", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    insertTask(r.id, "completed");
    insertTask(r.id, "running");
    // (100 + 30) / 200 = 0.65 → round(0.65 * 90) = 59 (59 用例: 58.5 四舍五入 59)
    expect([58, 59]).toContain(computeRuleProgress(r.id));
  });

  it("applyRuleProgress: 落库 source='rule' + 自动 note", () => {
    const r = createRequirement(projectA, { title: "P" }, ownerA);
    insertTask(r.id, "running", 50);
    const updated = applyRuleProgress(r.id, ownerA);
    expect(updated?.progress).toBe(45); // 0.5 * 90 = 45
    expect(updated?.progress_source).toBe("rule");
    expect(updated?.progress_note).toContain("task 完成");
  });
});
