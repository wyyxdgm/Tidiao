// Role 场景化 P1 (docs/plans/role-scoped-roles.md D1): roles.project_id scope
// semantics. Global role (project_id NULL) works in any project; a
// project-scoped role only applies to its own project - createTask throws
// TaskLocationError("ROLE_SCOPE_MISMATCH") on cross-project use. Uniqueness is
// per-(owner, scope): same owner may hold a global "dev" AND a scoped "dev".
// Note: tasks.project_id is NOT NULL, so "task without project" is not a case;
// the global-role-compat test covers the role side of the NULL (global role +
// any project).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import {
  createRole,
  deleteRole,
  getRolesForProject,
  updateRole,
  type Role,
} from "./roles";
import { createTask, getTaskById, TaskLocationError } from "./tasks";

let tmpDir: string;
let ownerId: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-roles-scope-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // migrations (incl. v525)

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectA = createProject({ name: "scope-a", ownerId }).id;
  projectB = createProject({ name: "scope-b", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createTaskIn(projectId: string, roleId?: string) {
  return createTask({
    title: "t",
    prompt: "work",
    project_id: projectId,
    role_id: roleId,
  });
}

function rolePromptMarker(taskId: string, marker: string): boolean {
  return (getTaskById(taskId)?.prompt ?? "").includes(marker);
}

describe("v525 roles.project_id: scope semantics", () => {
  it("global role (project_id NULL) is usable from any project", () => {
    const globalRole = createRole({
      name: "talker",
      system_prompt: "GLOBAL_ROLE_MARKER",
      ownerId,
    });
    expect(globalRole.project_id).toBeNull();

    for (const pid of [projectA, projectB]) {
      const task = createTaskIn(pid, globalRole.id);
      expect(rolePromptMarker(task.id, "GLOBAL_ROLE_MARKER")).toBe(true);
    }
  });

  it("project-scoped role works within its own project", () => {
    const scoped = createRole({
      name: "reviewer",
      system_prompt: "SCOPED_ROLE_MARKER",
      ownerId,
      projectId: projectA,
    });
    expect(scoped.project_id).toBe(projectA);

    const task = createTaskIn(projectA, scoped.id);
    expect(rolePromptMarker(task.id, "SCOPED_ROLE_MARKER")).toBe(true);
  });

  it("cross-project use of a scoped role throws ROLE_SCOPE_MISMATCH", () => {
    const scoped = createRole({
      name: "reviewer",
      system_prompt: "x",
      ownerId,
      projectId: projectA,
    });

    let err: unknown;
    try {
      createTaskIn(projectB, scoped.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskLocationError);
    expect((err as TaskLocationError).code).toBe("ROLE_SCOPE_MISMATCH");
  });

  it("foreign-owner role is still 'not found' (unchanged v1 semantics)", () => {
    const other = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(other, `${other}@example.com`, "x", "user");
    const foreignRole = createRole({
      name: "theirs",
      system_prompt: "x",
      ownerId: other,
    });

    expect(() => createTaskIn(projectA, foreignRole.id)).toThrow(/not found/);
  });

  it("default fallback role scoped to another project degrades to no role (no throw)", () => {
    createRole({
      name: "default",
      system_prompt: "DEFAULT_MARKER",
      ownerId,
      projectId: projectA,
    });

    // task in project B: default role is scoped to A -> skipped silently
    const task = createTaskIn(projectB);
    expect(rolePromptMarker(task.id, "DEFAULT_MARKER")).toBe(false);

    // task in project A: scoped default applies
    const taskA = createTaskIn(projectA);
    expect(rolePromptMarker(taskA.id, "DEFAULT_MARKER")).toBe(true);
  });
});

describe("v525 uniqueness: per-(owner, scope) name", () => {
  it("same owner can hold a global and a project-scoped role with the same name", () => {
    const g = createRole({ name: "dev", system_prompt: "x", ownerId });
    const s = createRole({ name: "dev", system_prompt: "x", ownerId, projectId: projectA });
    expect(g.project_id).toBeNull();
    expect(s.project_id).toBe(projectA);
  });

  it("same owner + same scope + same name still conflicts", () => {
    createRole({ name: "dev", system_prompt: "x", ownerId, projectId: projectA });
    expect(() =>
      createRole({ name: "dev", system_prompt: "x", ownerId, projectId: projectA })
    ).toThrow(/UNIQUE/i);
  });

  it("scoped roles of different projects with the same name coexist", () => {
    const a = createRole({ name: "dev", system_prompt: "x", ownerId, projectId: projectA });
    const b = createRole({ name: "dev", system_prompt: "x", ownerId, projectId: projectB });
    expect(a.id).not.toBe(b.id);
  });
});

describe("getRolesForProject", () => {
  it("returns global + own-project roles, excludes other-project roles", () => {
    const g = createRole({ name: "global-role", system_prompt: "x", ownerId });
    const a = createRole({ name: "a-only", system_prompt: "x", ownerId, projectId: projectA });
    createRole({ name: "b-only", system_prompt: "x", ownerId, projectId: projectB });

    const forA = getRolesForProject(projectA, ownerId).map((r: Role) => r.name);
    expect(forA).toContain("global-role");
    expect(forA).toContain("a-only");
    expect(forA).not.toContain("b-only");

    // names are unique per scope, so ids are stable handles
    const ids = getRolesForProject(projectA, ownerId).map((r: Role) => r.id);
    expect(ids).toEqual(expect.arrayContaining([g.id, a.id]));
  });

  it("never returns another owner's roles", () => {
    const other = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(other, `${other}@example.com`, "x", "user");
    createRole({ name: "mine", system_prompt: "x", ownerId });
    createRole({ name: "theirs", system_prompt: "x", ownerId: other });

    const names = getRolesForProject(projectA, ownerId).map((r: Role) => r.name);
    expect(names).toContain("mine");
    expect(names).not.toContain("theirs");
  });
});

describe("CRUD project binding", () => {
  it("updateRole can bind, move, and clear project_id", () => {
    const r = createRole({ name: "movable", system_prompt: "x", ownerId });
    expect(r.project_id).toBeNull();

    const bound = updateRole(r.id, { projectId: projectA }, ownerId);
    expect(bound?.project_id).toBe(projectA);

    const moved = updateRole(r.id, { projectId: projectB }, ownerId);
    expect(moved?.project_id).toBe(projectB);

    const cleared = updateRole(r.id, { projectId: null }, ownerId);
    expect(cleared?.project_id).toBeNull();

    // omitted projectId keeps current value
    const untouched = updateRole(r.id, { description: "d" }, ownerId);
    expect(untouched?.project_id).toBeNull();
    expect(untouched?.description).toBe("d");
  });
});

describe("deleteRole with referencing tasks (2026-10-13 e2e 回归: FK 500)", () => {
  it("deleteRole unbinds tasks.role_id + channel_configs.role_id instead of throwing FK 500", () => {
    const role = createRole({ name: "doomed", system_prompt: "x", ownerId });
    const task = createTaskIn(projectA, role.id);
    expect(getTaskById(task.id, ownerId)?.role_id).toBe(role.id);
    const db = getDb();
    db.prepare(
      "INSERT INTO channel_configs (id, channel, name, bound_project_id, bind_code, owner_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uuidv4(), "telegram", "cc-test", projectA, "bind-x", ownerId);
    const ccId = db.prepare("SELECT id FROM channel_configs WHERE name = 'cc-test'").get().id;
    db.prepare("UPDATE channel_configs SET role_id = ? WHERE id = ?").run(role.id, ccId);

    expect(deleteRole(role.id, ownerId)).toBe(true);
    // 历史任务解绑不抛 FK; prompt 里烘焙的角色内容不受影响
    expect(getTaskById(task.id, ownerId)?.role_id).toBeNull();
    expect(db.prepare("SELECT role_id FROM channel_configs WHERE id = ?").get(ccId).role_id).toBeNull();
  });
});
