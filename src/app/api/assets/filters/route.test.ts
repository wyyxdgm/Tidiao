// /api/assets/filters 集成测试 (PR-2)
//
// 覆盖:
//   1. 鉴权: 401
//   2. 返回当前用户的 project / version 下拉 (含 attachment count)
//   3. 跨 owner 隔离: B 的 project 不出现在 A 列表里
//   4. 只有真正有 attachment 的 project 才出现
//   5. version 仅在所属 project 下出现

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { GET } from "./route";
import { closeDb, getDb } from "@/lib/db";
import { createProject } from "@/lib/db/projects";
import { createVersion } from "@/lib/db/versions";
import { createTask } from "@/lib/db/tasks";
import { createAttachment } from "@/lib/db/attachments";

let tmpDir: string;
let userA: string;
let userB: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-filters-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();

  userA = uuidv4();
  userB = uuidv4();
  const db = getDb();
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userA, `${userA}@example.test`, "x", "user");
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userB, `${userB}@example.test`, "x", "user");

  const pA = createProject({ ownerId: userA, name: "pA", cwd: null });
  const pA2 = createProject({ ownerId: userA, name: "pA2-no-attach", cwd: null });
  const vA = createVersion({ project_id: pA.id, name: "v1", cwd: null });
  const vA2 = createVersion({ project_id: pA.id, name: "v2", cwd: null });
  const pB = createProject({ ownerId: userB, name: "pB", cwd: null });

  const tA1 = createTask({ title: "tA1", prompt: "p", project_id: pA.id, version_id: vA.id }).id;
  const tA2 = createTask({ title: "tA2", prompt: "p", project_id: pA.id, version_id: vA2.id }).id;
  const tB = createTask({ title: "tB", prompt: "p", project_id: pB.id }).id;

  // 用户 A: pA 下 3 个 attachment (v1=2, v2=1); pA2 一个都没有
  createAttachment({
    task_id: tA1, owner_id: userA, filename: "a1.png",
    media_type: "image/png", size_bytes: 1,
    storage_path: "/tmp/a1", source: "upload",
  });
  createAttachment({
    task_id: tA1, owner_id: userA, filename: "a2.png",
    media_type: "image/png", size_bytes: 1,
    storage_path: "/tmp/a2", source: "upload",
  });
  createAttachment({
    task_id: tA2, owner_id: userA, filename: "b.png",
    media_type: "image/png", size_bytes: 1,
    storage_path: "/tmp/b", source: "upload",
  });
  // 用户 B: 1 个
  createAttachment({
    task_id: tB, owner_id: userB, filename: "c.pdf",
    media_type: "application/pdf", size_bytes: 1,
    storage_path: "/tmp/c", source: "upload",
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
});

async function callFilters(asUserId: string = userA) {
  const req = new Request(`http://localhost/api/assets/filters`, {
    method: "GET",
    headers: { "x-user-id": asUserId },
  });
  const res = await GET(req as any);
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
}

describe("GET /api/assets/filters", () => {
  it("401 when no x-user-id", async () => {
    const req = new Request(`http://localhost/api/assets/filters`, { method: "GET" });
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });

  it("用户 A 只看到 pA (有 attachment), pA2 不出现", async () => {
    const r = await callFilters(userA);
    expect(r.status).toBe(200);
    expect(r.body.projects.length).toBe(1);
    expect(r.body.projects[0].name).toBe("pA");
    expect(r.body.projects[0].count).toBe(3);
  });

  it("pA 下两个 version 各自 count 正确", async () => {
    const r = await callFilters(userA);
    const p = r.body.projects[0];
    const v1 = p.versions.find((x: any) => x.name === "v1");
    const v2 = p.versions.find((x: any) => x.name === "v2");
    expect(v1.count).toBe(2);
    expect(v2.count).toBe(1);
  });

  it("用户 B 看不到 pA, 只看自己的 pB", async () => {
    const r = await callFilters(userB);
    expect(r.body.projects.length).toBe(1);
    expect(r.body.projects[0].name).toBe("pB");
    expect(r.body.projects[0].count).toBe(1);
  });

  it("orphan_count 计数 project_id=NULL 的 attachment", async () => {
    // 插入一条 task 没绑项目的 attachment
    const db = getDb();
    const orphanTask = uuidv4();
    db.prepare(`INSERT INTO tasks (id, title, prompt, owner_id) VALUES (?, ?, ?, ?)`)
      .run(orphanTask, "orphan", "p", userA);
    createAttachment({
      task_id: orphanTask, owner_id: userA, filename: "x.png",
      media_type: "image/png", size_bytes: 1,
      storage_path: "/tmp/x", source: "upload",
    });
    const r = await callFilters(userA);
    expect(r.body.orphan_count).toBe(1);
    // projects 还是只有 pA
    expect(r.body.projects.length).toBe(1);
  });
});