// GET /api/stats/backlog 的回归测试（board-R24）。
//
// 这条需求的起因是一个**静默错误的数字**: /api/stats 按 owner 过滤, 于是 admin
// 看到 failed=1 / pending=0, 而 DB 全局是 failed=13 / pending=6 —— 面板显示
// 「零积压」，实际积压 200+。所以下面的断言重点不是「端点能返回 JSON」，而是:
//   ① admin 拿到的是**跨 owner 的全局数**（这是整条需求的全部意义，反测: 换成
//      非 admin 必须只看到自己的，且两者数字不同）;
//   ② 0 条的状态也要出现（补零）—— 少了它「pending 0」会显示成「没这栏」;
//   ③ 口径要自述（scope 字段），否则数字含谁的没人说得清;
//   ④ all_statuses 与 `group by status` 逐个相等（验收标准 1 的自动化版本）。
//
// 真 SQLite 临时库，路由 handler 直接调，不起 server。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET } from "@/app/api/stats/backlog/route";

let tmpDir: string;
let adminId: string;
let otherId: string;

// 直接插 tasks —— 走 createTask 会带上调度器/preflight 等无关副作用。
// created_at 用相对 now 的偏移，让「最老年龄」可预期。
function insertTask(status: string, ownerId: string, ageDays = 0) {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?), datetime('now'))`
    )
    .run(uuidv4(), `t-${status}`, "p", status, ownerId, `-${ageDays} days`);
}

async function get(userId: string, role: string) {
  const req = new NextRequest("http://localhost/api/stats/backlog", {
    headers: { "x-user-id": userId, "x-user-role": role },
  });
  const res = await GET(req);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-backlog-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  adminId = uuidv4();
  otherId = uuidv4();
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );
  ins.run(adminId, "admin@example.com", "x", "admin");
  ins.run(otherId, "hfl@example.com", "x", "user");

  // admin 自己: 1 failed。别人: 3 failed + 5 reviewing + 2 pending。
  // 这个分布正是事故的最小复现 —— per-owner 口径会把 failed 报成 1。
  insertTask("failed", adminId, 1);
  for (let i = 0; i < 3; i++) insertTask("failed", otherId, 12);
  for (let i = 0; i < 5; i++) insertTask("reviewing", otherId, 14);
  for (let i = 0; i < 2; i++) insertTask("pending", otherId, 3);
  // 终态: 不该计入 backlog_total
  insertTask("completed", otherId, 20);
  insertTask("cancelled", otherId, 20);
  // 软删的 failed: 一条都不该出现在任何数字里
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, created_at, updated_at, deleted_at)
       VALUES (?, 'deleted', 'p', 'failed', ?, datetime('now','-30 days'), datetime('now'), datetime('now'))`
    )
    .run(uuidv4(), otherId);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

describe("GET /api/stats/backlog", () => {
  it("admin 看到的是跨 owner 的全局数字（需求核心）", async () => {
    const { status, json } = await get(adminId, "admin");
    expect(status).toBe(200);
    expect(json.scope).toBe("all");

    const byStatus = Object.fromEntries(
      json.backlog.map((b: any) => [b.status, b.count])
    );
    // 4 = admin 的 1 + 别人的 3。per-owner 口径会给 1 —— 那就是事故本身。
    expect(byStatus.failed).toBe(4);
    expect(byStatus.reviewing).toBe(5);
    expect(byStatus.pending).toBe(2);
    // 终态与软删不计入
    expect(json.backlog_total).toBe(4 + 5 + 2);
  });

  it("非 admin 只看到自己的（反测: 与全局数字不同）", async () => {
    const { json: mine } = await get(adminId, "user");
    expect(mine.scope).toBe("mine");
    const byStatus = Object.fromEntries(
      mine.backlog.map((b: any) => [b.status, b.count])
    );
    expect(byStatus.failed).toBe(1);
    expect(byStatus.reviewing).toBe(0);
    expect(mine.backlog_total).toBe(1);

    const { json: all } = await get(adminId, "admin");
    expect(all.backlog_total).not.toBe(mine.backlog_total);
  });

  it("0 条的状态也要返回（补零，不能整栏消失）", async () => {
    const { json } = await get(adminId, "admin");
    const statuses = json.backlog.map((b: any) => b.status);
    for (const s of ["pending", "queued", "running", "paused", "reviewing", "rejected", "failed"]) {
      expect(statuses).toContain(s);
    }
    const queued = json.backlog.find((b: any) => b.status === "queued");
    expect(queued.count).toBe(0);
    expect(queued.oldest_age_days).toBeNull();
  });

  it("all_statuses 与 `group by status` 逐个相等（验收标准 1）", async () => {
    const { json } = await get(adminId, "admin");
    const fromDb = getDb()
      .prepare(
        "SELECT status, COUNT(*) as count FROM tasks WHERE deleted_at IS NULL GROUP BY status"
      )
      .all() as Array<{ status: string; count: number }>;
    const expected = Object.fromEntries(fromDb.map((r) => [r.status, r.count]));
    const actual = Object.fromEntries(
      json.all_statuses.map((r: any) => [r.status, r.count])
    );
    expect(actual).toEqual(expected);
  });

  it("reviewing 按 owner 分组，能指出该谁去验收", async () => {
    const { json } = await get(adminId, "admin");
    const top = json.reviewing_by_owner.top;
    expect(top[0].email).toBe("hfl@example.com");
    expect(top[0].count).toBe(5);
    expect(json.reviewing_by_owner.distinct_owners).toBe(1);
    expect(json.reviewing_by_owner.other_count).toBe(0);
  });

  it("最老年龄按天算，取各积压状态里最大的", async () => {
    const { json } = await get(adminId, "admin");
    // reviewing 那批是 14 天前建的，是全场最老
    expect(json.oldest_age_days).toBeGreaterThanOrEqual(14);
    expect(json.oldest_age_days).toBeLessThan(15);
    const reviewing = json.backlog.find((b: any) => b.status === "reviewing");
    expect(reviewing.oldest_age_days).toBeGreaterThanOrEqual(14);
    expect(reviewing.oldest_created_at).toBeTruthy();
  });

  it("未登录 401", async () => {
    const req = new NextRequest("http://localhost/api/stats/backlog");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
