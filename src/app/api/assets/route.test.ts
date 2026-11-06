// /api/assets 集成测试 (PR-2)
//
// 覆盖:
//   1. 鉴权: 401 (无 x-user-id)
//   2. 跨 owner 隔离: 用户 B 看不到用户 A 的 attachment
//   3. 筛选: project_id / version_id / type 前缀 / q 搜索 / 时间窗
//   4. 排序: created_at asc / size_bytes desc / filename asc
//   5. 分页: limit + offset

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
let projectId: string;
let versionId: string;
let taskA: string;
let taskB: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-route-"));
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

  const proj = createProject({ ownerId: userA, name: "pA", cwd: null });
  projectId = proj.id;
  const ver = createVersion({ project_id: projectId, name: "v1", cwd: null, feishu_url: null, feishu_sheet: null });
  versionId = ver.id;

  // 用户 B 单独一个项目, 验证跨 owner 看不到
  const projB = createProject({ ownerId: userB, name: "pB", cwd: null });

  const t1 = createTask({
    title: "tA",
    prompt: "p",
    project_id: projectId,
    version_id: versionId,
  });
  taskA = t1.id;
  const t2 = createTask({
    title: "tB",
    prompt: "p",
    project_id: projB.id,
  });
  taskB = t2.id;

  // 用户 A 3 个 attachment
  createAttachment({
    task_id: taskA, owner_id: userA, filename: "hero.png",
    media_type: "image/png", size_bytes: 1024,
    storage_path: "/tmp/hero.png", source: "agent_generated",
  });
  createAttachment({
    task_id: taskA, owner_id: userA, filename: "big.mp4",
    media_type: "video/mp4", size_bytes: 5_000_000,
    storage_path: "/tmp/big.mp4", source: "upload",
  });
  createAttachment({
    task_id: taskA, owner_id: userA, filename: "tiny.txt",
    media_type: "text/plain", size_bytes: 10,
    storage_path: "/tmp/tiny.txt", source: "upload",
  });
  // 用户 B 1 个 attachment (跨 owner 验证)
  createAttachment({
    task_id: taskB, owner_id: userB, filename: "secret.pdf",
    media_type: "application/pdf", size_bytes: 999,
    storage_path: "/tmp/secret.pdf", source: "upload",
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
});

async function callAssets(query: string, asUserId: string = userA) {
  const req = new Request(`http://localhost/api/assets?${query}`, {
    method: "GET",
    headers: { "x-user-id": asUserId },
  });
  const res = await GET(req as any);
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
}

describe("GET /api/assets", () => {
  it("401 when no x-user-id", async () => {
    const req = new Request(`http://localhost/api/assets`, { method: "GET" });
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });

  it("用户 A 只看到自己的 3 个 attachment", async () => {
    const r = await callAssets("");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.assets.every((a: any) => a.owner_id === userA)).toBe(true);
  });

  it("用户 B 只看到自己的 1 个, 看不到 A 的", async () => {
    const r = await callAssets("", userB);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("secret.pdf");
  });

  it("type=image 只返 image/*", async () => {
    const r = await callAssets("type=image");
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("hero.png");
  });

  it("type=video 只返 video/*", async () => {
    const r = await callAssets("type=video");
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("big.mp4");
  });

  it("type=file 只返非 image/video/audio", async () => {
    const r = await callAssets("type=file");
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("tiny.txt");
  });

  it("q 搜索 filename 部分匹配", async () => {
    const r = await callAssets("q=hero");
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("hero.png");
  });

  it("q 不匹配时返回 0", async () => {
    const r = await callAssets("q=nomatch");
    expect(r.body.total).toBe(0);
  });

  it("project_id 筛选", async () => {
    const r = await callAssets(`project_id=${projectId}`);
    expect(r.body.total).toBe(3);
  });

  it("version_id 筛选", async () => {
    const r = await callAssets(`version_id=${versionId}`);
    expect(r.body.total).toBe(3);
  });

  it("version_id=null 只返未挂版本的 (R218 其他版本桶)", async () => {
    // 现造一条不挂版本的 task + attachment (不动 beforeEach, 避免扰动既有 total=3 断言)
    const tNone = createTask({ title: "tA-none", prompt: "p", project_id: projectId });
    createAttachment({
      task_id: tNone.id, owner_id: userA, filename: "none.png",
      media_type: "image/png", size_bytes: 5,
      storage_path: "/tmp/none.png", source: "upload",
    });
    const r = await callAssets("version_id=null");
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("none.png");
    // 与 project 组合: 只看该项目下未挂版本的
    const r2 = await callAssets(`project_id=${projectId}&version_id=null`);
    expect(r2.body.total).toBe(1);
    // 具体版本过滤不受影响 (回归)
    const r3 = await callAssets(`version_id=${versionId}`);
    expect(r3.body.total).toBe(3);
  });

  it("task_id 筛选", async () => {
    const r = await callAssets(`task_id=${taskA}`);
    expect(r.body.total).toBe(3);
  });

  it("sort=size_bytes:desc 按大小降序", async () => {
    const r = await callAssets("sort=size_bytes:desc");
    expect(r.body.assets[0].filename).toBe("big.mp4");
    expect(r.body.assets[2].filename).toBe("tiny.txt");
  });

  it("sort=size_bytes:asc 按大小升序", async () => {
    const r = await callAssets("sort=size_bytes:asc");
    expect(r.body.assets[0].filename).toBe("tiny.txt");
    expect(r.body.assets[2].filename).toBe("big.mp4");
  });

  it("sort=filename:asc 字母序", async () => {
    const r = await callAssets("sort=filename:asc");
    expect(r.body.assets[0].filename).toBe("big.mp4");
    expect(r.body.assets[2].filename).toBe("tiny.txt");
  });

  it("sort=created_at:asc 升序返回所有结果", async () => {
    const r = await callAssets("sort=created_at:asc");
    expect(r.body.total).toBe(3);
    expect(r.body.assets.length).toBe(3);
  });

  it("sort 无效时回退默认 (created_at desc), 仍返回 3 条", async () => {
    const r = await callAssets("sort=evil:desc");
    expect(r.body.total).toBe(3);
    expect(r.body.assets.length).toBe(3);
  });

  it("limit + offset 分页", async () => {
    const r1 = await callAssets("limit=2&offset=0&sort=filename:asc");
    expect(r1.body.assets.length).toBe(2);
    expect(r1.body.assets[0].filename).toBe("big.mp4");
    expect(r1.body.total).toBe(3);
    const r2 = await callAssets("limit=2&offset=2&sort=filename:asc");
    expect(r2.body.assets.length).toBe(1);
    expect(r2.body.assets[0].filename).toBe("tiny.txt");
  });

  it("limit 超 MAX_LIMIT 自动截到 200", async () => {
    const r = await callAssets("limit=9999");
    expect(r.status).toBe(200);
    expect(r.body.assets.length).toBeLessThanOrEqual(200);
  });

  it("时间窗 since/until", async () => {
    const future = "2099-01-01T00:00:00Z";
    const r1 = await callAssets(`since=${future}`);
    expect(r1.body.total).toBe(0);
    const past = "2000-01-01T00:00:00Z";
    const r2 = await callAssets(`since=${past}`);
    expect(r2.body.total).toBe(3);
  });

  it("返回字段含 project_id / version_id / task_title (JOIN 命中)", async () => {
    const r = await callAssets("");
    const att = r.body.assets[0];
    expect(att).toHaveProperty("project_id");
    expect(att).toHaveProperty("version_id");
    expect(att).toHaveProperty("task_title");
    expect(att.task_title).toBe("tA");
  });

  it("source=agent_generated 只返 AI 生成的", async () => {
    const r = await callAssets("source=agent_generated");
    expect(r.body.total).toBe(1);
    expect(r.body.assets[0].filename).toBe("hero.png");
    expect(r.body.assets[0].source).toBe("agent_generated");
  });

  it("source=upload 只返人工上传的", async () => {
    const r = await callAssets("source=upload");
    expect(r.body.total).toBe(2);
    expect(r.body.assets.every((a: any) => a.source === "upload")).toBe(true);
  });

  it("source 无效值时忽略, 返回全部 (兼容前端脏数据)", async () => {
    const r = await callAssets("source=evil");
    expect(r.body.total).toBe(3);
  });

  it("source + type 组合筛选", async () => {
    // 既有 agent_generated 又有 upload 的 image —— 这里只有 upload 的 image 不存在, 应 0
    const r = await callAssets("type=image&source=upload");
    expect(r.body.total).toBe(0);
    const r2 = await callAssets("type=image&source=agent_generated");
    expect(r2.body.total).toBe(1);
  });
});