// Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): roles.feishu_writeback
// 开关的 CRUD 层测试 —— v527 additive 列存在 + 默认 1 向后兼容 + create/update
// 非 0 归 1 防脏值.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createRole, getRoleById, updateRole } from "./roles";

let tmpDir: string;
let ownerId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-roles-writeback-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // migrations (incl. v527)

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("v527 roles.feishu_writeback: CRUD + 默认值", () => {
  it("migration v527 落列: INTEGER NOT NULL DEFAULT 1", () => {
    const cols = getDb()
      .prepare(`PRAGMA table_info(roles)`)
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === "feishu_writeback");
    expect(col).toBeDefined();
    expect(col!.type).toBe("INTEGER");
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("1");
  });

  it("createRole 不传 feishuWriteback → 默认 1 (向后兼容)", () => {
    const role = createRole({ name: "plain", system_prompt: "x", ownerId });
    expect(role.feishu_writeback).toBe(1);
  });

  it("createRole feishuWriteback=0 → 0; 非 0 脏值归 1", () => {
    const off = createRole({ name: "off", system_prompt: "x", ownerId, feishuWriteback: 0 });
    expect(off.feishu_writeback).toBe(0);
    const dirty = createRole({ name: "dirty", system_prompt: "x", ownerId, feishuWriteback: 7 as unknown as 0 });
    expect(dirty.feishu_writeback).toBe(1);
  });

  it("updateRole 1→0 / 0→1 / 不传保留原值", () => {
    const role = createRole({ name: "toggle", system_prompt: "x", ownerId });

    const off = updateRole(role.id, { feishuWriteback: 0 }, ownerId);
    expect(off!.feishu_writeback).toBe(0);

    const keep = updateRole(role.id, { description: "touched" }, ownerId);
    expect(keep!.feishu_writeback).toBe(0);

    const on = updateRole(role.id, { feishuWriteback: 1 }, ownerId);
    expect(on!.feishu_writeback).toBe(1);
  });

  it("裸 SQL 插行 (模拟 migration 前老数据) → 读出 1 (DEFAULT 兜底)", () => {
    const id = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO roles (id, name, system_prompt, owner_id) VALUES (?, ?, ?, ?)`
      )
      .run(id, "legacy", "x", ownerId);
    expect(getRoleById(id)!.feishu_writeback).toBe(1);
  });
});
