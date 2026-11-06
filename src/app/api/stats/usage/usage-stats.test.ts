// GET /api/stats/usage 的回归测试 —— 双口径（owner= 参数）放开的回归校验。
//
// 这次放开的全部价值: 普通用户能看自己的用量, admin 还能切到全平台或任意单个用户,
// 包括:
//   ① 普通用户缺省 / owner=self —— 必须 200, 只看到自己的任务;
//   ② 普通用户 owner=all / owner=<别人 id> —— 必须 403 (admin required);
//   ③ admin 缺省 —— 仍走 self (不放默认切到 all, admin 也得显式切);
//   ④ admin owner=all —— 200, scope=all, 多一张 by_owner;
//   ⑤ admin owner=<存在的 user id> —— 200, scope=owner, 只看该用户;
//   ⑥ admin owner=<不存在的 user id> —— 404 (user not found);
//   ⑦ 未登录 401 先于 role 检查 —— 顺序不能错;
//   ⑧ SQL owner 条件三处同步: scope=owner / scope=all 的桶和总量口径一致。
//
// 真 SQLite 临时库, 路由 handler 直接调, 不起 server。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET } from "@/app/api/stats/usage/route";

let tmpDir: string;
let adminId: string;
let adminEmail: string;
let userId: string;
let userEmail: string;
let ghostId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-usage-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  adminId = uuidv4();
  userId = uuidv4();
  // ghostId 只用于「用户不存在」的 404 验证 —— tasks 表有 owner_id FK 约束,
  // 所以不实际插入「孤儿 owner_id 的任务」。by_owner 的 LEFT JOIN NULL 行为
  // 不在测试覆盖里(生产 DB 同样做不到, FK 不允许)。
  ghostId = uuidv4();
  adminEmail = "admin@example.com";
  userEmail = "hfl@example.com";
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );
  ins.run(adminId, adminEmail, "x", "admin");
  ins.run(userId, userEmail, "x", "user");

  // 两组任务 —— admin 的 (cost 5.79, 2 条) / 普通用户的 (cost 9.99, 1 条)。
  // 放一起是 scope=all 验证的根基。
  const ins2 = getDb().prepare(
    `INSERT INTO tasks (id, title, prompt, status, owner_id, cost_usd, context_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  ins2.run(uuidv4(), "a1", "p", "completed", adminId, 1.23, 100);
  ins2.run(uuidv4(), "a2", "p", "completed", adminId, 4.56, 200);
  ins2.run(uuidv4(), "u1", "p", "completed", userId, 9.99, 300);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

function req(
  userId: string | null,
  role: string | null,
  qs: string = ""
): NextRequest {
  const headers: Record<string, string> = {};
  if (userId !== null) headers["x-user-id"] = userId;
  if (role !== null) headers["x-user-role"] = role;
  return new NextRequest(`http://localhost/api/stats/usage${qs}`, { headers });
}

describe("GET /api/stats/usage —— 双口径（owner 参数）", () => {
  it("普通用户缺省 owner —— scope=mine, 只看自己的任务", async () => {
    const res = await GET(req(userId, "user"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.scope).toBe("mine");
    expect(j.total.task_count).toBe(1);
    expect(j.total.cost_usd).toBeCloseTo(9.99);
    // 单用户口径不带 by_owner —— 那是 owner=all 的字段
    expect(j.total.by_owner).toBeUndefined();
    expect(j.timezone).toBe("UTC+8");
  });

  it("admin 缺省 owner —— 也走 mine（不放默认切到 all）", async () => {
    // 边界: 防止「admin 一进来就看到全平台」导致误读; 仍按本账号过滤。
    const res = await GET(req(adminId, "admin"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.scope).toBe("mine");
    expect(j.total.task_count).toBe(2);
    expect(j.total.cost_usd).toBeCloseTo(5.79);
  });

  it("admin owner=all —— scope=all, 跨用户 + 带 by_owner", async () => {
    const res = await GET(req(adminId, "admin", "?owner=all"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.scope).toBe("all");
    // 全量 3 条 (admin 2 + user 1)
    expect(j.total.task_count).toBe(3);
    expect(j.total.cost_usd).toBeCloseTo(1.23 + 4.56 + 9.99);
    // by_owner 至少包含 adminEmail + userEmail
    expect(Array.isArray(j.total.by_owner)).toBe(true);
    const emails = j.total.by_owner.map((o: { email: string | null }) => o.email);
    expect(emails).toContain(adminEmail);
    expect(emails).toContain(userEmail);
    // SQL 三处 owner 条件同步 —— 不允许桶/总量口径错位: 任意桶的总和应该等于 total。
    const bucketsSum = j.buckets.reduce(
      (s: number, b: { task_count: number }) => s + b.task_count,
      0
    );
    expect(bucketsSum).toBe(j.total.task_count);
  });

  it("admin owner=<存在的 user id> —— scope=owner, 只看该用户", async () => {
    const res = await GET(
      req(adminId, "admin", `?owner=${encodeURIComponent(userId)}`)
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.scope).toBe("owner");
    expect(j.total.task_count).toBe(1);
    expect(j.total.cost_usd).toBeCloseTo(9.99);
    // SQL 三处 owner 条件同步 —— 不允许桶/总量口径错位: 任意桶的总和应该等于 total。
    const bucketsSum = j.buckets.reduce(
      (s: number, b: { task_count: number }) => s + b.task_count,
      0
    );
    expect(bucketsSum).toBe(j.total.task_count);
  });

  it("admin owner=<不存在的 user id> —— 404 user not found", async () => {
    const res = await GET(
      req(adminId, "admin", `?owner=${encodeURIComponent(ghostId)}`)
    );
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toBe("user not found");
  });

  it("普通用户 owner=all —— 403 admin required（错误文案保持不变）", async () => {
    const res = await GET(req(userId, "user", "?owner=all"));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toBe("admin required");
  });

  it("普通用户 owner=<别人 id> —— 403 admin required", async () => {
    // 边界: 哪怕传的是「admin 的 id」, 非 admin 也无权指定具体别人 —— admin role
    // 不能被「我知道某个 user id」绕开。这条守住 admin only 收紧阶段留下的核心防线。
    const res = await GET(
      req(userId, "user", `?owner=${encodeURIComponent(adminId)}`)
    );
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toBe("admin required");
  });

  it("普通用户 owner=<自己 id> —— 200 scope=mine（显式 self 与缺省等价）", async () => {
    // 边界: 即便显式传自己的 id, 非 admin 也不该被拦 —— self 是人人可调的合法口径。
    const res = await GET(
      req(userId, "user", `?owner=${encodeURIComponent(userId)}`)
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.scope).toBe("mine");
    expect(j.total.task_count).toBe(1);
    expect(j.total.cost_usd).toBeCloseTo(9.99);
  });

  it("未登录 401 先于 role 检查 —— 顺序: auth 先于 admin", async () => {
    // 收紧阶段就立下的契约: 不能让 admin 检查吃掉 401, 哪怕两个都拒,
    // 未登录必须返 401(让人知道要先去登录)。
    const res = await GET(req(null, null));
    expect(res.status).toBe(401);
  });
});