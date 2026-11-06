// api_tokens CRUD + 批量删除 + 跨用户隔离.
// 覆盖:
//   1. createApiToken 正常 + UNIQUE(user_id, name) 约束触发
//   2. listApiTokens 按 created_at DESC
//   3. getApiTokenById / getApiTokenByName 命中 + miss 返 null
//   4. deleteApiToken 单删（命中返 true，跨用户删返 false，不存在返 false）
//   5. deleteApiTokens 批量：命中数、跨用户 id 静默、空数组返 0
//   6. switch-account 行复用：getApiTokenByName(user, "switch-account") 在 issueSwitchToken 后命中

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import {
  createApiToken,
  listApiTokens,
  getApiTokenById,
  getApiTokenByName,
  deleteApiToken,
  deleteApiTokens,
} from "./api-tokens";

let tmpDir: string;
let userId: string;
let otherUserId: string;

function insertUser(id: string, email: string) {
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(id, email, "x", "user");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-api-tokens-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // run all migrations (incl. v25 api_tokens) against fresh temp DB
  userId = uuidv4();
  otherUserId = uuidv4();
  insertUser(userId, `${userId}@example.com`);
  insertUser(otherUserId, `${otherUserId}@example.com`);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("api-tokens CRUD", () => {
  it("createApiToken inserts a row and returns it via getApiTokenById", () => {
    const row = createApiToken(userId, "CLI-local", "ao_abc12345");
    expect(row.name).toBe("CLI-local");
    expect(row.prefix).toBe("ao_abc12345");
    expect(row.user_id).toBe(userId);

    const fetched = getApiTokenById(userId, row.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(row.id);
  });

  it("createApiToken: UNIQUE(user_id, name) — same name throws", () => {
    createApiToken(userId, "dup", "ao_p1");
    expect(() => createApiToken(userId, "dup", "ao_p2")).toThrow();
  });

  it("UNIQUE is scoped per user — same name across users is fine", () => {
    const a = createApiToken(userId, "shared-name", "ao_a1");
    const b = createApiToken(otherUserId, "shared-name", "ao_b1");
    expect(a.id).not.toBe(b.id);
    expect(() => createApiToken(userId, "shared-name", "ao_a2")).toThrow();
  });

  it("listApiTokens returns current user's rows ordered by created_at DESC", async () => {
    createApiToken(userId, "older", "ao_old");
    // ensure created_at ordering: force older timestamp via direct update
    const older = listApiTokens(userId).find((t) => t.name === "older")!;
    getDb()
      .prepare(`UPDATE api_tokens SET created_at = ? WHERE id = ?`)
      .run("2024-01-01 00:00:00", older.id);

    createApiToken(userId, "newer", "ao_new");

    const list = listApiTokens(userId);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("newer");
    expect(list[1].name).toBe("older");

    // otherUser's tokens not leaked
    createApiToken(otherUserId, "other", "ao_o1");
    const mineOnly = listApiTokens(userId);
    expect(mineOnly.every((t) => t.user_id === userId)).toBe(true);
    expect(mineOnly).toHaveLength(2);
  });

  it("getApiTokenByName: hit and miss", () => {
    createApiToken(userId, "switch-account", "ao_sw");
    const hit = getApiTokenByName(userId, "switch-account");
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe("switch-account");

    expect(getApiTokenByName(userId, "nope")).toBeNull();
    expect(getApiTokenByName(otherUserId, "switch-account")).toBeNull();
  });
});

describe("deleteApiToken (single)", () => {
  it("returns true on hit, false on miss / cross-user", () => {
    const a = createApiToken(userId, "a", "ao_a");
    const b = createApiToken(otherUserId, "b", "ao_b");

    expect(deleteApiToken(userId, a.id)).toBe(true);
    expect(deleteApiToken(userId, a.id)).toBe(false); // already gone
    expect(deleteApiToken(userId, b.id)).toBe(false); // other user's
    expect(deleteApiToken(userId, "no-such-id")).toBe(false);
  });
});

describe("deleteApiTokens (batch)", () => {
  it("empty array returns 0 without hitting DB", () => {
    expect(deleteApiTokens(userId, [])).toBe(0);
    createApiToken(userId, "x", "ao_x"); // sanity: row exists
    expect(deleteApiTokens(userId, [])).toBe(0);
    expect(listApiTokens(userId)).toHaveLength(1);
  });

  it("deletes multiple rows, returns actual count", () => {
    const ids = [
      createApiToken(userId, "a", "ao_a").id,
      createApiToken(userId, "b", "ao_b").id,
      createApiToken(userId, "c", "ao_c").id,
    ];

    expect(deleteApiTokens(userId, ids)).toBe(3);
    expect(listApiTokens(userId)).toHaveLength(0);
  });

  it("cross-user ids silently ignored (count only own deletions)", () => {
    const mine = [
      createApiToken(userId, "m1", "ao_m1").id,
      createApiToken(userId, "m2", "ao_m2").id,
    ];
    const others = [
      createApiToken(otherUserId, "o1", "ao_o1").id,
      createApiToken(otherUserId, "o2", "ao_o2").id,
    ];
    const phantom = ["does-not-exist"];

    // request 5, actually delete 2
    expect(deleteApiTokens(userId, [...mine, ...others, ...phantom])).toBe(2);

    expect(listApiTokens(userId)).toHaveLength(0);
    expect(listApiTokens(otherUserId)).toHaveLength(2); // unaffected
  });

  it("duplicates in input are deduped by SQLite IN", () => {
    const id = createApiToken(userId, "once", "ao_o").id;
    expect(deleteApiTokens(userId, [id, id, id])).toBe(1);
    expect(listApiTokens(userId)).toHaveLength(0);
  });
});