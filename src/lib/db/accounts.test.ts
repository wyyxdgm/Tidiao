// R48「卖工作流账号版」三 entity 单测 (飞书 R48, damo 2026-08-20).
//
// 覆盖矩阵:
//   accounts CRUD (create / get / list / setPartyA / close)        — 5 条
//   workflows CRUD + 多租户隔离 + UNIQUE 冲突                       — 5 条
//   account_tokens CRUD + SHA-256 hash 验证 + last_used touch      — 5 条
//   v75 party_a user→default account 迁移 (幂等)                   — 2 条
//   v74 schema 幂等 (再跑一次迁移 = 0 effect)                      — 1 条
//   toSafeAccount / toSafeAccountToken / hasAnyScope / scopeToAccount 边界 — 3 条
//   合计 ≥ 21 条 (超出最低 10 条要求).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb, closeDb } from "./index";
import {
  createAccount,
  getAccountById,
  listAccountsByOwner,
  setAccountPartyAEnabled,
  closeAccount,
  toSafeAccount,
  createWorkflow,
  getWorkflowById,
  listWorkflowsByAccount,
  listPublicWorkflows,
  updateWorkflow,
  deleteWorkflow,
  createAccountToken,
  getAccountTokenByPlaintext,
  listAccountTokensByAccount,
  deleteAccountToken,
  touchAccountTokenLastUsed,
  toSafeAccountToken,
  hasAnyScope,
  ensureDefaultAccount,
  ACCOUNT_TOKEN_PREFIX_LEN,
} from "./accounts";
import {
  resolveAccountContext,
  requireAccountContext,
  requireAccountContextById,
  AccountContextError,
  scopeToAccount,
} from "../auth/account-context";
import { v4 as uuidv4 } from "uuid";

let tmpDir: string;
let userId: string;
let otherUserId: string;

function insertUser(id: string, email: string) {
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(id, email, "x", "user");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-accounts-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑全部 migrations (含 v74 + v75)
  userId = uuidv4();
  otherUserId = uuidv4();
  insertUser(userId, "u1@example.com");
  insertUser(otherUserId, "u2@example.com");
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

// ============================================================
// accounts CRUD
// ============================================================

describe("R48 accounts CRUD (v74)", () => {
  it("createAccount 正常 + 默认 tier=standard + party_a_enabled=0", () => {
    const acc = createAccount({ ownerUserId: userId, name: "yu 老板" });
    expect(acc.tier).toBe("standard");
    expect(acc.party_a_enabled).toBe(0);
    expect(acc.status).toBe("active");
    expect(acc.owner_user_id).toBe(userId);
    expect(acc.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("createAccount 显式 partyAEnabled=true → tier=party_a", () => {
    const acc = createAccount({
      ownerUserId: userId,
      name: "damo 主账号",
      partyAEnabled: true,
    });
    expect(acc.tier).toBe("party_a");
    expect(acc.party_a_enabled).toBe(1);
  });

  it("listAccountsByOwner 过滤 + created_at DESC", async () => {
    createAccount({ ownerUserId: userId, name: "first" });
    // 强制时间差 1s 让 ORDER BY 稳定
    await new Promise((r) => setTimeout(r, 1100));
    createAccount({ ownerUserId: userId, name: "second" });
    const list = listAccountsByOwner(userId);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("second"); // 新的在前
  });

  it("listAccountsByOwner 跨用户隔离 (otherUserId 不见 userId 的 account)", () => {
    createAccount({ ownerUserId: userId, name: "mine" });
    createAccount({ ownerUserId: otherUserId, name: "theirs" });
    expect(listAccountsByOwner(userId)).toHaveLength(1);
    expect(listAccountsByOwner(userId)[0].name).toBe("mine");
    expect(listAccountsByOwner(otherUserId)[0].name).toBe("theirs");
  });

  it("setAccountPartyAEnabled 双向 + tier 同步", () => {
    const acc = createAccount({ ownerUserId: userId, name: "x" });
    const up = setAccountPartyAEnabled(acc.id, true);
    expect(up.party_a_enabled).toBe(1);
    expect(up.tier).toBe("party_a");
    const down = setAccountPartyAEnabled(acc.id, false);
    expect(down.party_a_enabled).toBe(0);
    expect(down.tier).toBe("standard");
  });

  it("setAccountPartyAEnabled 不存在的 account → throw", () => {
    expect(() => setAccountPartyAEnabled("nope", true)).toThrow(/account_not_found/);
  });

  it("closeAccount 不物理删, 仅切 status; children 仍在但被 account-context 拒 (suspended/closed)", () => {
    const acc = createAccount({ ownerUserId: userId, name: "x" });
    const wf = createWorkflow({ accountId: acc.id, slug: "s1", name: "wf" });
    const tk = createAccountToken({ accountId: acc.id, name: "tk" });
    closeAccount(acc.id);
    expect(getAccountById(acc.id)?.status).toBe("closed");
    // close 不触发 CASCADE (CASCADE 只在 DELETE 触发, 这里只 UPDATE status). children 仍在
    expect(getWorkflowById(acc.id, wf.id)).not.toBeNull();
    expect(listAccountTokensByAccount(acc.id).length).toBeGreaterThanOrEqual(1);
    // 关键: 关闭后任何 API 请求都被 account-context 拒 (下一条 test 验证)
    expect(tk.plaintext).toBeTruthy();
  });

  it("toSafeAccount 把 party_a_enabled 转 boolean", () => {
    const acc = createAccount({ ownerUserId: userId, name: "x", partyAEnabled: true });
    const safe = toSafeAccount(acc);
    expect(safe.party_a_enabled).toBe(true);
    expect(typeof safe.party_a_enabled).toBe("boolean");
  });
});

// ============================================================
// workflows CRUD + 多租户隔离
// ============================================================

describe("R48 workflows CRUD (v74)", () => {
  it("createWorkflow + getWorkflowById 同 account 命中", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const wf = createWorkflow({
      accountId: acc.id,
      slug: "intro",
      name: "介绍工作流",
      description: "test",
      configJson: { steps: ["a", "b"] },
    });
    expect(wf.slug).toBe("intro");
    expect(wf.visibility).toBe("private");
    expect(JSON.parse(wf.config_json!)).toEqual({ steps: ["a", "b"] });
    const got = getWorkflowById(acc.id, wf.id);
    expect(got?.id).toBe(wf.id);
  });

  it("createWorkflow UNIQUE(account_id, slug) 冲突 → throw 带 slug_conflict 标签", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    createWorkflow({ accountId: acc.id, slug: "dup", name: "first" });
    expect(() =>
      createWorkflow({ accountId: acc.id, slug: "dup", name: "second" })
    ).toThrow(/workflow_slug_conflict/);
  });

  it("createWorkflow 同 slug 跨 account 不冲突 (UNIQUE 是复合 key)", () => {
    const acc1 = createAccount({ ownerUserId: userId, name: "a1" });
    const acc2 = createAccount({ ownerUserId: otherUserId, name: "a2" });
    const w1 = createWorkflow({ accountId: acc1.id, slug: "shared", name: "w1" });
    const w2 = createWorkflow({ accountId: acc2.id, slug: "shared", name: "w2" });
    expect(w1.id).not.toBe(w2.id);
  });

  it("getWorkflowById 跨 account → null (防 ID enumeration)", () => {
    const acc1 = createAccount({ ownerUserId: userId, name: "a1" });
    const acc2 = createAccount({ ownerUserId: otherUserId, name: "a2" });
    const wf = createWorkflow({ accountId: acc1.id, slug: "s", name: "w" });
    // 用 acc2 的 id 去查 acc1 的 wf → null (不是抛错)
    expect(getWorkflowById(acc2.id, wf.id)).toBeNull();
  });

  it("listPublicWorkflows 只返 visibility='public'", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    createWorkflow({ accountId: acc.id, slug: "priv", name: "p" });
    createWorkflow({
      accountId: acc.id,
      slug: "pub",
      name: "pub",
      visibility: "public",
    });
    const pub = listPublicWorkflows();
    expect(pub).toHaveLength(1);
    expect(pub[0].slug).toBe("pub");
  });

  it("updateWorkflow 部分 patch + updated_at 推进", async () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const wf = createWorkflow({ accountId: acc.id, slug: "s", name: "orig" });
    await new Promise((r) => setTimeout(r, 1100));
    const updated = updateWorkflow(acc.id, wf.id, { name: "new", visibility: "public" });
    expect(updated.name).toBe("new");
    expect(updated.visibility).toBe("public");
    expect(updated.updated_at > wf.updated_at).toBe(true);
  });

  it("deleteWorkflow 跨 account 返 false (不动)", () => {
    const acc1 = createAccount({ ownerUserId: userId, name: "a1" });
    const acc2 = createAccount({ ownerUserId: otherUserId, name: "a2" });
    const wf = createWorkflow({ accountId: acc1.id, slug: "s", name: "w" });
    expect(deleteWorkflow(acc2.id, wf.id)).toBe(false);
    expect(getWorkflowById(acc1.id, wf.id)).not.toBeNull(); // 还在
    expect(deleteWorkflow(acc1.id, wf.id)).toBe(true);
    expect(getWorkflowById(acc1.id, wf.id)).toBeNull();
  });
});

// ============================================================
// account_tokens CRUD + SHA-256
// ============================================================

describe("R48 account_tokens CRUD (v74)", () => {
  it("createAccountToken 返 plaintext 一次 + prefix 8 字符 + hash 是 hex 64", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { row, plaintext } = createAccountToken({
      accountId: acc.id,
      name: "主 token",
      scopes: ["workflow:run"],
    });
    expect(plaintext.length).toBeGreaterThanOrEqual(43);
    expect(row.token_prefix.length).toBe(ACCOUNT_TOKEN_PREFIX_LEN);
    expect(plaintext.startsWith(row.token_prefix)).toBe(true);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.scopes).toBe('["workflow:run"]');
  });

  it("getAccountTokenByPlaintext O(1) hash lookup 命中 + miss 返 null", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { plaintext, row } = createAccountToken({ accountId: acc.id, name: "t" });
    const got = getAccountTokenByPlaintext(plaintext);
    expect(got?.id).toBe(row.id);
    expect(getAccountTokenByPlaintext("wrong-token-" + "x".repeat(40))).toBeNull();
  });

  it("token_hash UNIQUE 约束: 同 plaintext (碰撞概率极低但理论上) 第二次 INSERT 抛错", () => {
    // 这个测试模拟 DB 层 UNIQUE 兜底 (SHA-256 碰撞概率 2^-128, 不可能真撞; 但 UNIQUE 兜底
    // 必须存在, 防人为构造碰撞绕过)
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { row } = createAccountToken({ accountId: acc.id, name: "t1" });
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO account_tokens (id, account_id, token_hash, token_prefix, name, scopes)
           VALUES (?, ?, ?, ?, ?, '[]')`
        )
        .run(uuidv4(), acc.id, row.token_hash, "manual", "dup")
    ).toThrow(/UNIQUE/);
  });

  it("touchAccountTokenLastUsed 写入时间戳", async () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { row, plaintext } = createAccountToken({ accountId: acc.id, name: "t" });
    expect(getAccountTokenByPlaintext(plaintext)!.last_used_at).toBeNull();
    await new Promise((r) => setTimeout(r, 1100));
    touchAccountTokenLastUsed(row.id);
    const after = getAccountTokenByPlaintext(plaintext)!;
    expect(after.last_used_at).not.toBeNull();
    expect(after.last_used_at! > row.created_at).toBe(true);
  });

  it("deleteAccountToken 跨 account 返 false", () => {
    const acc1 = createAccount({ ownerUserId: userId, name: "a1" });
    const acc2 = createAccount({ ownerUserId: otherUserId, name: "a2" });
    const { row } = createAccountToken({ accountId: acc1.id, name: "t" });
    expect(deleteAccountToken(acc2.id, row.id)).toBe(false);
    expect(deleteAccountToken(acc1.id, row.id)).toBe(true);
  });

  it("hasAnyScope 任一命中即放行", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { row } = createAccountToken({
      accountId: acc.id,
      name: "t",
      scopes: ["workflow:run", "workflow:read"],
    });
    expect(hasAnyScope(row, ["admin"])).toBe(false);
    expect(hasAnyScope(row, ["workflow:run"])).toBe(true);
    expect(hasAnyScope(row, ["workflow:read", "admin"])).toBe(true); // 任一命中
    expect(hasAnyScope(row, [])).toBe(true); // 空 required = 放行
  });

  it("toSafeAccountToken 解析 scopes + 不暴露 hash", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { row } = createAccountToken({
      accountId: acc.id,
      name: "t",
      scopes: ["workflow:run", "admin"],
    });
    const safe = toSafeAccountToken(row);
    expect(safe.scopes).toEqual(["workflow:run", "admin"]);
    expect((safe as unknown as { token_hash?: string }).token_hash).toBeUndefined();
  });
});

// ============================================================
// account-context middleware
// ============================================================

describe("R48 account-context resolve (v74)", () => {
  it("resolveAccountContext 缺 Authorization → 401 missing_token", async () => {
    await expect(
      resolveAccountContext(new Request("http://x/", { headers: {} }))
    ).rejects.toThrow(AccountContextError);
    try {
      await resolveAccountContext(new Request("http://x/", { headers: {} }));
    } catch (e) {
      expect((e as AccountContextError).status).toBe(401);
      expect((e as AccountContextError).code).toBe("missing_token");
    }
  });

  it("resolveAccountContext token 不存在 → 401 invalid_token", async () => {
    const req = new Request("http://x/", {
      headers: { authorization: "Bearer wrong-" + "x".repeat(40) },
    });
    try {
      await resolveAccountContext(req);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AccountContextError).code).toBe("invalid_token");
    }
  });

  it("resolveAccountContext 命中 → 注入 account + token + scopes + touch last_used", async () => {
    const acc = createAccount({ ownerUserId: userId, name: "a", partyAEnabled: true });
    const { plaintext } = createAccountToken({
      accountId: acc.id,
      name: "t",
      scopes: ["workflow:run"],
    });
    const req = new Request("http://x/", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    const ctx = await resolveAccountContext(req);
    expect(ctx.account.id).toBe(acc.id);
    expect(ctx.account.party_a_enabled).toBe(1);
    expect(ctx.scopes).toContain("workflow:run");
    // touch 已触发
    const refreshed = getAccountTokenByPlaintext(plaintext)!;
    expect(refreshed.last_used_at).not.toBeNull();
  });

  it("resolveAccountContext account closed → 403 account_closed", async () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { plaintext } = createAccountToken({ accountId: acc.id, name: "t" });
    closeAccount(acc.id);
    const req = new Request("http://x/", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    try {
      await resolveAccountContext(req);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AccountContextError).status).toBe(403);
      expect((e as AccountContextError).code).toBe("account_closed");
    }
  });

  it("resolveAccountContext expired token → 401 token_expired", async () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { plaintext } = createAccountToken({
      accountId: acc.id,
      name: "t",
      expiresAt: "2020-01-01T00:00:00Z", // 已过期
    });
    const req = new Request("http://x/", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    try {
      await resolveAccountContext(req);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AccountContextError).code).toBe("token_expired");
    }
  });

  it("requireAccountContext scope 不足 → 403 insufficient_scope", async () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    const { plaintext } = createAccountToken({
      accountId: acc.id,
      name: "t",
      scopes: ["workflow:read"],
    });
    const req = new Request("http://x/", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    try {
      await requireAccountContext(req, "admin");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AccountContextError).code).toBe("insufficient_scope");
    }
  });

  it("requireAccountContextById 跨用户 → 403 account_not_owned (admin 跳过)", () => {
    const acc = createAccount({ ownerUserId: userId, name: "a" });
    expect(() => requireAccountContextById(acc.id, otherUserId)).toThrow(
      /account_not_owned/
    );
    // admin 跳过 ownership 校验
    const adminCtx = requireAccountContextById(acc.id, otherUserId, true);
    expect(adminCtx.account.id).toBe(acc.id);
  });

  it("scopeToAccount 跨 account row 被过滤", () => {
    const acc1 = createAccount({ ownerUserId: userId, name: "a1" });
    const acc2 = createAccount({ ownerUserId: userId, name: "a2" });
    const wf1 = createWorkflow({ accountId: acc1.id, slug: "s", name: "w1" });
    const wf2 = createWorkflow({ accountId: acc2.id, slug: "s", name: "w2" });
    const ctx = requireAccountContextById(acc1.id, userId);
    expect(ctx.account.id).toBe(acc1.id);
    // 模拟 SQL 失误: 把所有 wf 都返出来了, scopeToAccount 兜底
    const allRows = [wf1, wf2];
    const scoped = scopeToAccount(allRows, ctx);
    expect(scoped.map((r) => r.account_id)).toEqual([acc1.id]);
    // 防 ID enumeration: 即便给 wf2.id, scopeToAccount 也不让穿
    expect(scopeToAccount([wf1, wf2] as unknown as Array<{ account_id: string }>, ctx))
      .toHaveLength(1);
  });
});

// ============================================================
// v75 party_a 数据迁移 (幂等)
// ============================================================

describe("R48 v75 party_a user→default account 迁移 (幂等)", () => {
  it("ensureDefaultAccount 给新建 user 懒建 default account (party_a=0 → standard)", () => {
    // beforeEach 在 migration 之后才插 user, v75 已经跑过; 调用 ensureDefaultAccount 触发懒迁移
    const def = ensureDefaultAccount(userId);
    expect(def).not.toBeNull();
    expect(def!.tier).toBe("standard");
    expect(def!.party_a_enabled).toBe(0);
    // 二次调用幂等
    const def2 = ensureDefaultAccount(userId);
    expect(def2!.id).toBe(def!.id);
  });

  it("ensureDefaultAccount party_a=1 user → default account.tier=party_a", () => {
    const partyAUserId = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO users (id, email, password_hash, role, party_a_enabled) VALUES (?, ?, ?, ?, 1)`
      )
      .run(partyAUserId, "party-a@example.com", "x", "user");
    const def = ensureDefaultAccount(partyAUserId);
    expect(def).not.toBeNull();
    expect(def!.tier).toBe("party_a");
    expect(def!.party_a_enabled).toBe(1);
  });

  it("ensureDefaultAccount 不存在的 user → 返 null", () => {
    expect(ensureDefaultAccount("nonexistent-id")).toBeNull();
  });

  it("v75 SQL 幂等: 重复 exec 同一 INSERT OR IGNORE = 0 新增行", () => {
    // 先手动跑 v75 一次 (beforeEach 跑时 user 还没插)
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO accounts (id, owner_user_id, name, tier, party_a_enabled, status, created_at, updated_at)
         SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
                substr(lower(hex(randomblob(2))),2) || '-' ||
                substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' ||
                lower(hex(randomblob(6))),
                u.id, 'default',
                CASE WHEN u.party_a_enabled = 1 THEN 'party_a' ELSE 'standard' END,
                COALESCE(u.party_a_enabled, 0), 'active',
                datetime('now'), datetime('now')
         FROM users u WHERE NOT EXISTS (
           SELECT 1 FROM accounts a WHERE a.owner_user_id = u.id AND a.name = 'default')`
      )
      .run();
    const afterFirst = (
      getDb()
        .prepare(`SELECT COUNT(*) as c FROM accounts WHERE name = 'default'`)
        .get() as { c: number }
    ).c;
    // 第二次跑同一 SQL = 应该 0 新增 (UNIQUE 兜底)
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO accounts (id, owner_user_id, name, tier, party_a_enabled, status, created_at, updated_at)
         SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
                substr(lower(hex(randomblob(2))),2) || '-' ||
                substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' ||
                lower(hex(randomblob(6))),
                u.id, 'default',
                CASE WHEN u.party_a_enabled = 1 THEN 'party_a' ELSE 'standard' END,
                COALESCE(u.party_a_enabled, 0), 'active',
                datetime('now'), datetime('now')
         FROM users u WHERE NOT EXISTS (
           SELECT 1 FROM accounts a WHERE a.owner_user_id = u.id AND a.name = 'default')`
      )
      .run();
    const afterSecond = (
      getDb()
        .prepare(`SELECT COUNT(*) as c FROM accounts WHERE name = 'default'`)
        .get() as { c: number }
    ).c;
    expect(afterSecond).toBe(afterFirst);
  });
});

// ============================================================
// v74 schema 幂等 (再跑一次迁移 = 0 effect)
// ============================================================

describe("R48 v74 schema 幂等", () => {
  it("重跑 v74 CREATE TABLE IF NOT EXISTS = 0 effect, 不抛错", () => {
    // beforeEach 已经跑过; 再 exec 一次相同 SQL
    expect(() =>
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL, slug TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_tokens (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT NOT NULL
        );
      `)
    ).not.toThrow();
    // 原有数据仍在
    expect(getAccountById("anything")?.id ?? null).toBeNull(); // 没这 account, 但表存在
  });
});
