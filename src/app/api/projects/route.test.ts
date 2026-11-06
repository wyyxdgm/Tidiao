// GET /api/projects 的 per-owner 隔离回归测试（board 2026-08-19）。
//
// 需求: 普通 user 只看到 owner_id == 自己 的项目; admin 仍然看到全部。
// 现有 task GET 已按此口径收紧, 此测试把 project 端点拉到同一基线.
//
// 真 SQLite 临时库, 直接调 GET handler (不起 server). 模式与
// src/app/api/stats/backlog/backlog-stats.test.ts 一致.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db/index";
import { GET, POST } from "@/app/api/projects/route";

let tmpDir: string;
let adminId: string;
let user1Id: string;
let user2Id: string;

// 直接插 projects —— 走 createProject 会触发 FK/UNIQUE 等无关副作用,
// 这里要精确控制 owner_id 分布, 走裸 SQL 更稳.
function insertProject(name: string, ownerId: string | null) {
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, description, owner_id) VALUES (?, ?, ?, ?)`
    )
    .run(uuidv4(), name, null, ownerId);
}

async function listAs(userId: string, role: string) {
  const req = new NextRequest("http://localhost/api/projects", {
    headers: { "x-user-id": userId, "x-user-role": role },
  });
  const res = await GET(req);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-proj-iso-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  adminId = uuidv4();
  user1Id = uuidv4();
  user2Id = uuidv4();
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );
  ins.run(adminId, "admin@example.com", "x", "admin");
  ins.run(user1Id, "alice@example.com", "x", "user");
  ins.run(user2Id, "bob@example.com", "x", "user");

  // 6 个项目, 每个 owner 2 个. 1 个孤儿 (owner_id NULL, 模拟历史上 migration v7
  // 留下的预授权行).
  //
  // 注意: migration v7 在 fresh DB 上自动插入一条「未分类」项目, owner_id NULL
  // (v17 reclaim 把 NULL → admin, 但 fresh DB 时 admin 还不存在, 故仍保持 NULL).
  // 所以 listProjects 的全集是: 6 个有主 + 2 个 NULL-owner (「未分类」 + orphan-legacy) = 8.
  // 普通 user 的 per-owner 视图不返回 NULL-owner 行 (SQL `WHERE owner_id = ?` 严格相等),
  // admin 视图返回全部.
  insertProject("admin-A", adminId);
  insertProject("admin-B", adminId);
  insertProject("alice-A", user1Id);
  insertProject("alice-B", user1Id);
  insertProject("bob-A", user2Id);
  insertProject("bob-B", user2Id);
  insertProject("orphan-legacy", null);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

describe("GET /api/projects per-owner 隔离", () => {
  it("admin 看到全部 (含其他 user 的) + 孤儿 (历史遗留 owner_id NULL)", async () => {
    const { status, json } = await listAs(adminId, "admin");
    expect(status).toBe(200);
    const owners = new Set(json.projects.map((p: any) => p.owner_id));
    expect(owners.has(adminId)).toBe(true);
    expect(owners.has(user1Id)).toBe(true);
    expect(owners.has(user2Id)).toBe(true);
    // 6 个有 owner + 2 个 NULL-owner (「未分类」 from v7 + orphan-legacy) = 8.
    expect(json.projects.length).toBe(8);
    // 「未分类」与 orphan-legacy 都应可见 (admin 不被过滤)
    const names = json.projects.map((p: any) => p.name).sort();
    expect(names).toContain("未分类");
    expect(names).toContain("orphan-legacy");
  });

  it("user1 只看到自己的 2 个, 看不到 user2/admin/孤儿", async () => {
    const { status, json } = await listAs(user1Id, "user");
    expect(status).toBe(200);
    expect(json.projects.length).toBe(2);
    for (const p of json.projects) {
      expect(p.owner_id).toBe(user1Id);
    }
    const owners = new Set(json.projects.map((p: any) => p.owner_id));
    expect(owners.has(adminId)).toBe(false);
    expect(owners.has(user2Id)).toBe(false);
    expect(owners.has(null)).toBe(false);
  });

  it("user2 只看到自己的 2 个, 看不到 user1/admin/孤儿", async () => {
    const { status, json } = await listAs(user2Id, "user");
    expect(status).toBe(200);
    expect(json.projects.length).toBe(2);
    for (const p of json.projects) {
      expect(p.owner_id).toBe(user2Id);
    }
    const owners = new Set(json.projects.map((p: any) => p.owner_id));
    expect(owners.has(adminId)).toBe(false);
    expect(owners.has(user1Id)).toBe(false);
    expect(owners.has(null)).toBe(false);
  });

  it("admin user 用 user 身份调 (role=user), 也被按 owner 过滤 —— role 是唯一开关", async () => {
    // 防止 'header role 没读对' 这类 bug: 同一 userId, role=admin → 8 条,
    // role=user → 2 条 (admin 自己的, NULL-owner 不算).
    const { json: asAdmin } = await listAs(adminId, "admin");
    const { json: asUser } = await listAs(adminId, "user");
    expect(asAdmin.projects.length).toBe(8);
    expect(asUser.projects.length).toBe(2);
    for (const p of asUser.projects) {
      expect(p.owner_id).toBe(adminId);
    }
  });

  it("缺 x-user-id → 401 (鉴权回路没被绕过)", async () => {
    const req = new NextRequest("http://localhost/api/projects");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("返回 schema 不破坏: 关键字段 (id/name/owner_id/deleted_at/current_version_name/cwd/pinned) 全在", async () => {
    // 验收 #6: 已存在的返回 schema 不能突然少了字段, 让现有 client 崩.
    const { json } = await listAs(user1Id, "user");
    expect(json.projects.length).toBe(2);
    const p = json.projects[0];
    for (const k of [
      "id",
      "name",
      "description",
      "created_at",
      "current_version_id",
      "current_version_name",
      "cwd",
      "owner_id",
      "pinned",
      "deleted_at",
      "wiki_extra_extensions",
      "parallel_limit",
      "timeout_minutes",
    ]) {
      expect(k in p).toBe(true);
    }
  });

  it("POST 创建的项目 owner 强制为调用者 (与本特性无关, 防回归)", async () => {
    // 顺带验证 POST 路径仍正确: 防止有谁顺手把 POST 的 ownerId 也改成
    // 'admin 跳过' 之类的逻辑 (本特性 scope 里没要求, 守住).
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers: { "x-user-id": user1Id, "content-type": "application/json" },
      body: JSON.stringify({ name: "alice-fresh" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.owner_id).toBe(user1Id);

    // user1 再 list, 看到自己新增的 + 原来的 2 个 = 3
    const { json } = await listAs(user1Id, "user");
    expect(json.projects.length).toBe(3);
    const names = json.projects.map((p: any) => p.name).sort();
    expect(names).toEqual(["alice-A", "alice-B", "alice-fresh"]);
  });
});
