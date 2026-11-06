// R88 quota 三件套单测 (damo 0825 飞书 R88, Sheet L 列 7 条验收点).
//
// 覆盖矩阵(每条对应 Sheet L 一条):
//   ① ≤0 / NULL = 不限                    (isUnlimited / capUnlimited)
//   ② 触发限额 / expire 拒绝             (checkUserQuota)
//   ③ 默认 party_a_enabled=false 老用户无感 (新 user 通过 getUserById 后 party_a_enabled=0,
//                                            checkUserQuota 直接放行)
//   ④ 变更留痕                            (applyQuotaChange 写 user_quota_change_log)
//   ⑤ granted_cap 仅展示不二次拦截        (set 后不影响 allowed; granted_cap 不传进
//                                            checkUserQuota)
//   ⑥ 模拟 quota 触发任务拒绝             (e2e: 写 task.cost_usd 累计超 cap, 触发)
//   ⑦ expire_at 已过期 → 拒绝             (Date.parse 比较)
// 另加突变测试 (mutation-style): ensure null/undefined/empty 不爆错.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb, closeDb } from "./index";
import {
  createUser,
  getUserById,
  toSafeUser,
  checkUserQuota,
  checkUserQuotaWithCurrent,
  setUserPartyAEnabled,
  setUserQuotaTotalSpentCap,
  setUserQuotaGrantedCap,
  setUserQuotaExpireAt,
  getQuotaChangeLog,
  getUserQuotaUsedTotal,
  recordQuotaExceededRuntime,
} from "./users";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-quota-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb(); // 跑 migrations (含 v55)
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("R88 quota migration v55", () => {
  it("新加用户默认 party_a_enabled=false (Sheet L 验收 ③)", async () => {
    const user = await createUser(`q-${Date.now()}@example.com`, "pw");
    expect(user.party_a_enabled).toBe(0);
    expect(user.quota_total_spent_cap).toBeNull();
    expect(user.quota_granted_cap).toBeNull();
    expect(user.quota_expire_at).toBeNull();
  });

  it("toSafeUser 暴露 4 个 quota 字段", async () => {
    const user = await createUser(`q-${Date.now()}@example.com`, "pw");
    const safe = toSafeUser(user);
    expect(safe.party_a_enabled).toBe(false);
    expect(safe.quota_total_spent_cap).toBeNull();
    expect(safe.quota_granted_cap).toBeNull();
    expect(safe.quota_expire_at).toBeNull();
  });
});

describe("R88 quota 三件套 - ≤0/NULL = 不限 (Sheet L 验收 ②)", () => {
  let adminId: string;
  let userId: string;

  beforeEach(async () => {
    adminId = "system"; // operator_id 走字符串
    const u = await createUser(`cap-${Date.now()}@example.com`, "pw");
    userId = u.id;
    setUserPartyAEnabled(userId, true, { operatorId: adminId, reason: "test" });
  });

  it("cap = NULL → allowed=true", () => {
    setUserQuotaTotalSpentCap(userId, null, { operatorId: adminId });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
    expect(r.cap).toBeNull();
  });

  it("cap = 0 → allowed=true (0 视为不限)", () => {
    setUserQuotaTotalSpentCap(userId, 0, { operatorId: adminId });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
  });

  it("cap = -1 → allowed=true (负数视为不限)", () => {
    setUserQuotaTotalSpentCap(userId, -1, { operatorId: adminId });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
  });

  it("cap = NaN (非法值) → 归 null → allowed=true", () => {
    setUserQuotaTotalSpentCap(userId, NaN as unknown as number, { operatorId: adminId });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
    expect(r.cap).toBeNull();
  });
});

describe("R88 quota - 触发限额 (Sheet L 验收 ⑥ 模拟)", () => {
  let userId: string;
  let projectId: string;

  beforeEach(async () => {
    const u = await createUser(`trigger-${Date.now()}@example.com`, "pw");
    userId = u.id;
    setUserPartyAEnabled(userId, true, { operatorId: "system", reason: "trigger test" });
    setUserQuotaTotalSpentCap(userId, 10, { operatorId: "system" });

    // 建一个 project 用来挂 task
    const { createProject } = await import("./projects");
    projectId = createProject({
      name: `p-${Date.now()}`,
      cwd: tmpDir,
      ownerId: userId,
    }).id;
  });

  it("累计 cost < cap → allowed=true", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cost_usd)
       VALUES (?, 't', 'p', 'completed', ?, ?, 5)`
    ).run("task-aaaa-1111-1111-111111111111", userId, projectId);
    expect(getUserQuotaUsedTotal(userId)).toBe(5);
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(5);
    expect(r.cap).toBe(10);
  });

  it("累计 cost >= cap → allowed=false + reason=total_spent_cap", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cost_usd)
       VALUES (?, 't', 'p', 'completed', ?, ?, 9)`
    ).run("task-bbbb-1111-1111-111111111111", userId, projectId);
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cost_usd)
       VALUES (?, 't', 'p', 'completed', ?, ?, 1)`
    ).run("task-cccc-1111-1111-111111111111", userId, projectId);
    expect(getUserQuotaUsedTotal(userId)).toBe(10);
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("total_spent_cap");
    expect(r.detail).toMatch(/触达上限 \$10/);
  });

  it("软删 task 不计入 used (deleted_at IS NOT NULL 排除)", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, cost_usd, deleted_at)
       VALUES (?, 't', 'p', 'completed', ?, ?, 100, datetime('now'))`
    ).run("task-dddd-1111-1111-111111111111", userId, projectId);
    expect(getUserQuotaUsedTotal(userId)).toBe(0);
    expect(checkUserQuota(userId).allowed).toBe(true);
  });
});

describe("R88 quota - expire_at 拦截 (Sheet L 验收 ②)", () => {
  let userId: string;

  beforeEach(async () => {
    const u = await createUser(`exp-${Date.now()}@example.com`, "pw");
    userId = u.id;
    setUserPartyAEnabled(userId, true, { operatorId: "system" });
  });

  it("expire_at 在过去 → allowed=false + reason=expired", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    setUserQuotaExpireAt(userId, past, { operatorId: "system" });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("expired");
    expect(r.remaining_days).toBe(0);
    expect(r.detail).toMatch(/已截止/);
  });

  it("expire_at 在未来 → allowed=true (剩余天数正数)", () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    setUserQuotaExpireAt(userId, future, { operatorId: "system" });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
    expect(r.remaining_days).toBe(7);
  });

  it("expire_at = NULL → allowed=true, remaining_days=null", () => {
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
    expect(r.remaining_days).toBeNull();
  });

  it("expire_at = 非法字符串 → 视为不限 (脏值降级, 跟 settings.ts 同款)", () => {
    setUserQuotaExpireAt(userId, "not-a-date", { operatorId: "system" });
    const r = checkUserQuota(userId);
    expect(r.allowed).toBe(true);
  });
});

describe("R88 quota - granted_cap 仅展示不二次拦截 (Sheet L 验收 ② + H 列明文)", () => {
  it("设 granted_cap 不影响 allowed (不入 checkUserQuota)", async () => {
    const u = await createUser(`g-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(u.id, true, { operatorId: "system" });
    setUserQuotaGrantedCap(u.id, 100, { operatorId: "system" });
    const r = checkUserQuota(u.id);
    expect(r.allowed).toBe(true);
    // granted_cap 不在 QuotaCheckResult 返回里 (只展示, 不入拦截判据)
    const safe = toSafeUser(getUserById(u.id)!);
    expect(safe.quota_granted_cap).toBe(100);
  });
});

describe("R88 quota - 变更留痕 (Sheet H ② + L 验收)", () => {
  it("每次 setter 都写一行 user_quota_change_log", async () => {
    const u = await createUser(`log-${Date.now()}@example.com`, "pw");
    const operator = "admin-uuid-001";
    setUserPartyAEnabled(u.id, true, { operatorId: operator, reason: "open quota" });
    setUserQuotaTotalSpentCap(u.id, 50, { operatorId: operator, reason: "set cap" });
    setUserQuotaGrantedCap(u.id, 100, { operatorId: operator });
    setUserQuotaExpireAt(u.id, "2027-12-31T00:00:00Z", { operatorId: operator });
    const logs = getQuotaChangeLog(u.id);
    expect(logs).toHaveLength(4);
    // 按 created_at DESC, id DESC — 最新一次 expire_at 在最前
    expect(logs[0].field).toBe("quota_expire_at");
    expect(logs[0].new_value).toBe("2027-12-31T00:00:00Z");
    expect(logs[0].operator_id).toBe(operator);
    expect(logs[0].reason).toBeNull();
    expect(logs[1].field).toBe("quota_granted_cap");
    expect(logs[1].new_value).toBe("100");
    expect(logs[2].field).toBe("quota_total_spent_cap");
    expect(logs[2].old_value).toBeNull();
    expect(logs[2].new_value).toBe("50");
    expect(logs[2].reason).toBe("set cap");
    expect(logs[3].field).toBe("party_a_enabled");
    expect(logs[3].old_value).toBe("0");
    expect(logs[3].new_value).toBe("1");
  });

  it("log 写 + users 写在同一事务: 失败时不会孤行", async () => {
    const u = await createUser(`tx-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(u.id, true, { operatorId: "system" });
    setUserQuotaTotalSpentCap(u.id, 10, { operatorId: "system" });
    // 重复设同值 — 也应写一行 (变更留痕, 不去重)
    setUserQuotaTotalSpentCap(u.id, 10, { operatorId: "system", reason: "idempotent" });
    const logs = getQuotaChangeLog(u.id);
    expect(logs).toHaveLength(3); // 1 party_a + 2 cap
    expect(logs.filter((l) => l.field === "quota_total_spent_cap")).toHaveLength(2);
  });
});

describe("R88 quota - party_a_enabled=false 老用户无感 (Sheet L 验收 ③)", () => {
  it("party_a=0 + cap=10 + expire=过去 → checkUserQuota 直接放行", async () => {
    const u = await createUser(`silent-${Date.now()}@example.com`, "pw");
    // 直接 SQL 写, 模拟管理员没开开关但库里有值
    getDb()
      .prepare(
        `UPDATE users SET quota_total_spent_cap = 10, quota_expire_at = ? WHERE id = ?`
      )
      .run("2020-01-01T00:00:00Z", u.id);
    const r = checkUserQuota(u.id);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("no_party_a");
    expect(r.detail).toBeNull();
  });
});

describe("R88 quota - 突变测试 (空值/异常输入不爆)", () => {
  it("setUserQuotaTotalSpentCap 收 undefined / '' / NaN 归 null", async () => {
    const u = await createUser(`mut-${Date.now()}@example.com`, "pw");
    setUserQuotaTotalSpentCap(u.id, undefined, { operatorId: "system" });
    expect(getUserById(u.id)!.quota_total_spent_cap).toBeNull();
    // 实测 API 路由 (未来 PATCH /api/admin/users/[id]) 会传字符串, normalizeCap 兜底.
    setUserQuotaTotalSpentCap(u.id, "" as unknown as number, { operatorId: "system" });
    expect(getUserById(u.id)!.quota_total_spent_cap).toBeNull();
    setUserQuotaTotalSpentCap(u.id, NaN as unknown as number, { operatorId: "system" });
    expect(getUserById(u.id)!.quota_total_spent_cap).toBeNull();
  });

  it("setUserQuotaExpireAt 收非字符串归 null", async () => {
    const u = await createUser(`m2-${Date.now()}@example.com`, "pw");
    setUserQuotaExpireAt(u.id, 12345 as unknown as string, { operatorId: "system" });
    expect(getUserById(u.id)!.quota_expire_at).toBeNull();
  });

  it("checkUserQuota 对不存在的 user 返回 allowed=false", () => {
    const r = checkUserQuota("00000000-0000-0000-0000-000000000000");
    expect(r.allowed).toBe(false);
  });

  it("getQuotaChangeLog limit 默认 50", async () => {
    const u = await createUser(`lim-${Date.now()}@example.com`, "pw");
    for (let i = 0; i < 60; i++) {
      setUserPartyAEnabled(u.id, i % 2 === 0, { operatorId: "system" });
    }
    expect(getQuotaChangeLog(u.id)).toHaveLength(50);
    expect(getQuotaChangeLog(u.id, 10)).toHaveLength(10);
  });
});

// =====================================================================
// R88 Phase 2-B 双保险: checkUserQuotaWithCurrent + recordQuotaExceededRuntime
// 覆盖:
//   - currentCost 加进 used 临时算, 不写库 (复用 checkUserQuota 但叠加 currentCost)
//   - party_a=0 → base 直接放行, currentCost 叠加也放行
//   - 超 cap → 触 total_spent_cap, detail 文案含 currentCost
//   - cap=NULL → currentCost 不参与判定
//   - recordQuotaExceededRuntime 写 user_quota_change_log 一行 field=quota_exceeded_runtime
// =====================================================================

describe("R88 quota 双保险: checkUserQuotaWithCurrent (Phase 2-B)", () => {
  it("party_a=1 + 当前 cost 加进 used 后超 cap → total_spent_cap", async () => {
    const u = await createUser(`pa-cur-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(u.id, true, { operatorId: u.id });
    setUserQuotaTotalSpentCap(u.id, 10, { operatorId: u.id });
    // 历史用 = 5, 当前 cost = 6, 5+6=11 >= 10 → 触发
    const { createProject } = await import("./projects");
    const seedProj = createProject({ name: "seed-c", ownerId: u.id });
    const { createTask } = await import("./tasks");
    createTask({ title: "s", prompt: "x", project_id: seedProj.id });
    getDb().prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`).run(5, u.id);

    const r = checkUserQuotaWithCurrent(u.id, 6);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("total_spent_cap");
    expect(r.detail).toContain("11.00"); // 5+6
    expect(r.detail).toContain("10.00");
    expect(r.detail).toContain("6.00"); // currentCost 显式标出
  });

  it("party_a=1 + currentCost 加进 used 后仍 < cap → 放行", async () => {
    const u = await createUser(`pa-cur2-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(u.id, true, { operatorId: u.id });
    setUserQuotaTotalSpentCap(u.id, 10, { operatorId: u.id });
    // 历史用 = 5, currentCost = 4 → 9 < 10 放行
    const { createProject } = await import("./projects");
    const { createTask } = await import("./tasks");
    const seedProj = createProject({ name: "seed-c2", ownerId: u.id });
    createTask({ title: "s", prompt: "x", project_id: seedProj.id });
    getDb().prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`).run(5, u.id);

    const r = checkUserQuotaWithCurrent(u.id, 4);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("party_a=0 → 不管 currentCost 多大, 走 base 直接放行", async () => {
    const u = await createUser(`n-cur-${Date.now()}@example.com`, "pw");
    setUserQuotaTotalSpentCap(u.id, 1, { operatorId: u.id });
    const { createProject } = await import("./projects");
    const { createTask } = await import("./tasks");
    const seedProj = createProject({ name: "seed-nc", ownerId: u.id });
    createTask({ title: "s", prompt: "x", project_id: seedProj.id });
    getDb().prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`).run(100, u.id);

    const r = checkUserQuotaWithCurrent(u.id, 9999);
    // party_a=0 时 checkUserQuota 直接返 allowed=true (no_party_a), currentCost 叠加不参与
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("no_party_a");
  });

  it("cap=NULL → 不管 currentCost 多大, 放行", async () => {
    const u = await createUser(`cur-null-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(u.id, true, { operatorId: u.id });
    // cap 不设 (NULL)
    const r = checkUserQuotaWithCurrent(u.id, 99999);
    expect(r.allowed).toBe(true);
  });

  it("currentCost=0 → 直接返 base, 不重新算", async () => {
    const u = await createUser(`cur0-${Date.now()}@example.com`, "pw");
    setUserPartyAEnabled(u.id, true, { operatorId: u.id });
    setUserQuotaTotalSpentCap(u.id, 5, { operatorId: u.id });
    const { createProject } = await import("./projects");
    const { createTask } = await import("./tasks");
    const seedProj = createProject({ name: "seed-cur0", ownerId: u.id });
    createTask({ title: "s", prompt: "x", project_id: seedProj.id });
    getDb().prepare(`UPDATE tasks SET cost_usd = ? WHERE owner_id = ?`).run(3, u.id);

    const r = checkUserQuotaWithCurrent(u.id, 0);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(3); // base.used, 没叠
  });
});

describe("R88 quota 双保险: recordQuotaExceededRuntime (Phase 2-B)", () => {
  it("写一条 user_quota_change_log, field=quota_exceeded_runtime, operator_id=system", async () => {
    const u = await createUser(`rec-${Date.now()}@example.com`, "pw");
    recordQuotaExceededRuntime(u.id, 12.5, "test detail message");
    const log = getQuotaChangeLog(u.id);
    expect(log.length).toBe(1);
    expect(log[0].field).toBe("quota_exceeded_runtime");
    expect(log[0].operator_id).toBe("system");
    expect(log[0].new_value).toBe("12.5");
    expect(log[0].reason).toBe("test detail message");
  });

  it("多次触发累加多条 log", async () => {
    const u = await createUser(`rec2-${Date.now()}@example.com`, "pw");
    recordQuotaExceededRuntime(u.id, 10, "first");
    recordQuotaExceededRuntime(u.id, 20, "second");
    const log = getQuotaChangeLog(u.id);
    expect(log.length).toBe(2);
    // ORDER BY created_at DESC → 后写的先; 所以 [0] = second
    expect(log[0].new_value).toBe("20");
  });
});
