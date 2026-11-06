// GET/PATCH/DELETE /api/projects/[id] 的 owner 隔离口径回归测试。
//
// 背景 (2026-09-29 damo 实测 bug):
//   GET /api/projects (列表) 对 admin 放行 —— route.ts:30 传 `undefined` 跳过
//   owner_id 过滤 (board 2026-08-19 "operator sees every project"),
//   但 GET /api/projects/[id] (详情) 没同步放行 → admin 在列表里看得到项目,
//   点进去永远 404 "Not found"。真实现场: 项目 playcanvas-micraft
//   (fa4949a5-…, owner = 测试账号 damo-1789354950@example.com)。
//
// 本测试把「读放行 / 写不放行」钉死:
//   - admin GET 别人项目 -> 200 (与列表口径一致)
//   - 普通 user GET 别人项目 -> 404 (隔离不破)
//   - admin PATCH/DELETE 别人项目 -> 404 (**故意不放行写**, 防误改误删)
//
// 真 SQLite 临时库, 直接调 handler (不起 server), 模式与同目录 route.test.ts 一致。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db/index";
import { GET, PATCH, DELETE } from "./route";

let tmpDir: string;
let adminId: string;
let otherId: string;
let projectId: string;

function insertProject(name: string, ownerId: string) {
  const id = uuidv4();
  getDb()
    .prepare(`INSERT INTO projects (id, name, description, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, name, null, ownerId);
  return id;
}

function getAs(userId: string, role: string, id: string) {
  const req = new NextRequest(`http://localhost/api/projects/${id}`, {
    headers: { "x-user-id": userId, "x-user-role": role },
  });
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-proj-id-admin-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  adminId = uuidv4();
  otherId = uuidv4();
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
  );
  ins.run(adminId, "admin@example.com", "x", "admin");
  ins.run(otherId, "other@example.com", "x", "user");
  projectId = insertProject("foreign-project", otherId);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/projects/[id] — admin 读放行 (与列表口径对齐)", () => {
  it("admin 读别人项目 -> 200 (列表可见 = 详情可开)", async () => {
    const res = await getAs(adminId, "admin", projectId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe(projectId);
    expect(body.project.name).toBe("foreign-project");
  });

  it("普通 user 读别人项目 -> 404 (隔离不破)", async () => {
    const thirdId = uuidv4();
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(thirdId, "third@example.com", "x", "user");
    const res = await getAs(thirdId, "user", projectId);
    expect(res.status).toBe(404);
  });

  it("owner 自己读 -> 200 (老行为不变)", async () => {
    const res = await getAs(otherId, "user", projectId);
    expect(res.status).toBe(200);
  });

  it("admin 读不存在的 id -> 404 (admin 放行不等于放行一切)", async () => {
    const res = await getAs(adminId, "admin", uuidv4());
    expect(res.status).toBe(404);
  });
});

describe("PATCH/DELETE /api/projects/[id] — admin 写不放行 (防误改误删)", () => {
  it("admin PATCH 别人项目 -> 404", async () => {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-user-id": adminId,
        "x-user-role": "admin",
      },
      body: JSON.stringify({ name: "hijacked" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: projectId }) });
    expect(res.status).toBe(404);
    const row = getDb()
      .prepare(`SELECT name FROM projects WHERE id = ?`)
      .get(projectId) as { name: string };
    expect(row.name).toBe("foreign-project");
  });

  it("admin DELETE 别人项目 -> 404 (未软删)", async () => {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { "x-user-id": adminId, "x-user-role": "admin" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: projectId }) });
    expect(res.status).toBe(404);
    const row = getDb()
      .prepare(`SELECT deleted_at FROM projects WHERE id = ?`)
      .get(projectId) as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });
});
