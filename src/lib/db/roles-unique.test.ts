// roles.name uniqueness evolution:
//   v10: GLOBAL UNIQUE(name) -> v19: UNIQUE(owner_id, name) (per-owner)
//        -> v525: per-(owner, scope) via expression index
//        idx_roles_owner_scope_name (owner_id, COALESCE(project_id,''), name),
//        so an owner can hold a global "dev" AND a project-scoped "dev".
// This file keeps asserting the v19 behavioural guarantees (per-owner, NULL
// owner rows never collide); the v525 scope semantics live in
// roles-scope.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createRole, listRoles } from "./roles";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-roles-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // run all migrations (incl. v19) against the fresh temp DB
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertUser(role: "admin" | "user" = "user"): string {
  const id = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(id, `${id}@example.com`, "x", role);
  return id;
}

function rolesSchema(): string {
  const row = getDb()
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='roles'`)
    .get() as { sql: string } | undefined;
  return row?.sql ?? "";
}

describe("v19 migration: roles.name UNIQUE(owner_id, name)", () => {
  it("applied v19", () => {
    const applied = getDb()
      .prepare(`SELECT version FROM _migrations WHERE version = 19`)
      .get();
    expect(applied).toBeDefined();
  });

  it("schema has no table-level name UNIQUE (v525 moved it to the expression index)", () => {
    const sql = rolesSchema();
    // v525 rebuilt the table without the v19 UNIQUE(owner_id, name) table
    // constraint; uniqueness is now enforced by idx_roles_owner_scope_name.
    expect(sql).not.toMatch(/UNIQUE\s*\(\s*owner_id\s*,\s*name\s*\)/i);
    expect(sql).not.toMatch(/name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  });

  it("v525 expression index (owner, COALESCE(project_id,''), name) exists", () => {
    const applied = getDb()
      .prepare(`SELECT version FROM _migrations WHERE version = 525`)
      .get();
    expect(applied).toBeDefined();
    const idx = getDb()
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_roles_owner_scope_name'`
      )
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/COALESCE\s*\(\s*project_id\s*,\s*''\s*\)/i);
    expect(idx?.sql).toMatch(/UNIQUE/i);
  });

  it("two users can create a same-named role (no global conflict)", () => {
    const a = insertUser("admin");
    const b = insertUser("user");

    const ra = createRole({ name: "dev", system_prompt: "p", ownerId: a });
    const rb = createRole({ name: "dev", system_prompt: "p", ownerId: b });

    expect(ra.name).toBe("dev");
    expect(rb.name).toBe("dev");
    expect(ra.id).not.toBe(rb.id);

    // each owner sees only their own
    expect(listRoles(a).length).toBe(1);
    expect(listRoles(b).length).toBe(1);
  });

  it("same owner + same name still conflicts", () => {
    const a = insertUser("admin");
    createRole({ name: "dev", system_prompt: "p", ownerId: a });
    expect(() =>
      createRole({ name: "dev", system_prompt: "p", ownerId: a })
    ).toThrow(/UNIQUE/i);
  });

  it("NULL owner_id rows don't collide (SQLite NULL distinctness)", () => {
    // legacy orphan (pre-auth) rows had NULL owner_id; two same-named orphans
    // must coexist under UNIQUE(owner_id, name).
    getDb()
      .prepare(
        `INSERT INTO roles (id, name, system_prompt, owner_id) VALUES (?, ?, ?, NULL)`
      )
      .run(uuidv4(), "orphan", "p");
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO roles (id, name, system_prompt, owner_id) VALUES (?, ?, ?, NULL)`
        )
        .run(uuidv4(), "orphan", "p")
    ).not.toThrow();
  });
});
