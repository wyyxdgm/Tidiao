// /api/assets/delete-batch 集成测试 (PR-2)
//
// 覆盖:
//   1. 鉴权: 401
//   2. body 校验: 400 (非 JSON / ids 不是数组 / ids 含非字符串 / 超过 MAX_BATCH)
//   3. 删除: 跨 owner 隔离 (B 的 id 不会被 A 删) + 文件物理清理 + DB 行删除
//   4. 失败回执: {deleted, failed[]}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import { POST } from "./route";
import { closeDb, getDb } from "@/lib/db";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { createAttachment, listAttachmentsByTaskId } from "@/lib/db/attachments";

let tmpDir: string;
let userA: string;
let userB: string;
let taskA: string;
let taskB: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-del-batch-"));
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

  const projA = createProject({ ownerId: userA, name: "pA", cwd: null });
  const projB = createProject({ ownerId: userB, name: "pB", cwd: null });

  const cwdA = path.join(tmpDir, "tasks", "tA");
  const cwdB = path.join(tmpDir, "tasks", "tB");
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const t1 = createTask({ title: "tA", prompt: "p", project_id: projA.id, cwd: cwdA });
  const t2 = createTask({ title: "tB", prompt: "p", project_id: projB.id, cwd: cwdB });
  taskA = t1.id;
  taskB = t2.id;

  // 用户 A: 写 2 个文件 + 注册 attachment (跳过 size 限制, 直接 createAttachment)
  const f1 = path.join(tmpDir, "uploads", userA, taskA, "a.png");
  const f2 = path.join(tmpDir, "uploads", userA, taskA, "b.png");
  fs.mkdirSync(path.dirname(f1), { recursive: true });
  fs.writeFileSync(f1, "A");
  fs.writeFileSync(f2, "B");
  createAttachment({
    task_id: taskA, owner_id: userA, filename: "a.png",
    media_type: "image/png", size_bytes: 1,
    storage_path: f1, source: "upload",
  });
  createAttachment({
    task_id: taskA, owner_id: userA, filename: "b.png",
    media_type: "image/png", size_bytes: 1,
    storage_path: f2, source: "upload",
  });

  // 用户 B: 1 个 attachment (验证跨 owner 隔离)
  const f3 = path.join(tmpDir, "uploads", userB, taskB, "c.pdf");
  fs.mkdirSync(path.dirname(f3), { recursive: true });
  fs.writeFileSync(f3, "C");
  createAttachment({
    task_id: taskB, owner_id: userB, filename: "c.pdf",
    media_type: "application/pdf", size_bytes: 1,
    storage_path: f3, source: "upload",
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
});

async function callDel(body: unknown, asUserId: string = userA) {
  const req = new Request(`http://localhost/api/assets/delete-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-id": asUserId },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await POST(req as any);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("POST /api/assets/delete-batch", () => {
  it("401 when no x-user-id", async () => {
    const req = new Request(`http://localhost/api/assets/delete-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
  });

  it("400 when body invalid JSON", async () => {
    const r = await callDel("not-json");
    expect(r.status).toBe(400);
  });

  it("400 when ids not an array", async () => {
    const r = await callDel({ ids: "x" });
    expect(r.status).toBe(400);
  });

  it("400 when ids contain non-string", async () => {
    const r = await callDel({ ids: ["ok", 123] });
    expect(r.status).toBe(400);
  });

  it("400 when ids > MAX_BATCH (200)", async () => {
    const ids = Array.from({ length: 201 }, () => uuidv4());
    const r = await callDel({ ids });
    expect(r.status).toBe(400);
  });

  it("empty ids returns 0 deleted / 0 failed", async () => {
    const r = await callDel({ ids: [] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 0, failed: [] });
  });

  it("用户 A 删自己的 2 个 → 物理文件清 + DB 行删", async () => {
    const rows = listAttachmentsByTaskId(taskA, userA);
    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.id);
    const paths = rows.map((r) => r.storage_path);
    expect(paths.every((p) => fs.existsSync(p))).toBe(true);

    const r = await callDel({ ids });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(2);
    expect(r.body.failed).toEqual([]);

    // 文件物理删除
    expect(paths.every((p) => !fs.existsSync(p))).toBe(true);
    // DB 行清空
    expect(listAttachmentsByTaskId(taskA, userA).length).toBe(0);
  });

  it("跨 owner: A 拿不到 B 的 id, 删自己 1 个 + B 的 1 个 → 只删自己的", async () => {
    const aRows = listAttachmentsByTaskId(taskA, userA);
    const bRows = listAttachmentsByTaskId(taskB, userB);
    expect(aRows.length).toBe(2);
    expect(bRows.length).toBe(1);

    const r = await callDel({ ids: [aRows[0].id, bRows[0].id] });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(1); // 只删了 A 的 1 个
    expect(r.body.failed.length).toBe(1);
    expect(r.body.failed[0].id).toBe(bRows[0].id);
    expect(r.body.failed[0].error).toBe("not_found");

    // B 的文件 + DB 行都还在
    expect(fs.existsSync(bRows[0].storage_path)).toBe(true);
    expect(listAttachmentsByTaskId(taskB, userB).length).toBe(1);
  });

  it("不存在的 id 进 failed 列表", async () => {
    const r = await callDel({ ids: [uuidv4(), uuidv4()] });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(0);
    expect(r.body.failed.length).toBe(2);
  });
});