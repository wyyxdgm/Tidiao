// GET /api/tasks/[id] 响应含 is_favorite 的回归测试.
//
// 2026-09-29 实证 bug: 详情接口不返回 is_favorite, SPA 详情页
// (spa/src/views/TaskDetailView.vue:124/863) 读 task.is_favorite -> 恒 undefined
// -> `?? false` -> 刷新后收藏状态丢失. 写入侧 (POST/DELETE /favorite) 一直正常,
// 观测到的现象是「点星变黄、刷新就灰」. 列表页筛选不受影响, 因为它走服务端
// ?favorite=true -> EXISTS 子查询, 不依赖该字段.
//
// 关注点:
//  - 收藏是 per-user 偏好 (user_favorites 表), 不在 tasks 行上, 必须按
//    x-user-id 现算 -> 这里验跨用户隔离, 防止有人图省事改成全局标量.
//  - 短 ID 分支 (isShortId) 也要用 resolvedId 而非原始入参算收藏, 否则
//    短 ID 进详情页同样丢状态.
//  - 与 depends-on-ids.test.ts 一样用 vi.mock 桩化 runtime, 不拉 SDK.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { addFavorite } from "@/lib/db/user-favorites";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask,
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let otherId: string;
let projectId: string;
let taskId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-detail-fav-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  for (const id of [uuidv4(), uuidv4()]) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", "user");
  }
  ownerId = (getDb().prepare(`SELECT id FROM users ORDER BY id LIMIT 1 OFFSET 0`).get() as { id: string }).id;
  otherId = (getDb().prepare(`SELECT id FROM users ORDER BY id LIMIT 1 OFFSET 1`).get() as { id: string }).id;
  projectId = createProject({ name: "detail-fav-proj", ownerId }).id;
  taskId = createTask({ title: "fav task", prompt: "p", project_id: projectId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function getDetail(id: string, uid: string) {
  const { GET } = await import("@/app/api/tasks/[id]/route");
  const req = new NextRequest(`http://localhost/api/tasks/${id}`, {
    headers: { "x-user-id": uid },
  });
  const res = await GET(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/tasks/[id] is_favorite", () => {
  it("未收藏时返回 false", async () => {
    const { status, body } = await getDetail(taskId, ownerId);
    expect(status).toBe(200);
    expect(body.is_favorite).toBe(false);
  });

  it("收藏后返回 true (刷新不丢状态的关键)", async () => {
    addFavorite(ownerId, taskId);
    const { status, body } = await getDetail(taskId, ownerId);
    expect(status).toBe(200);
    expect(body.is_favorite).toBe(true);
  });

  it("非 owner 读详情 404, 不泄露他人收藏状态", async () => {
    // 收藏按 x-user-id 现算, 但 task 本身 owner-scoped: 别人连详情都读不到,
    // 更拿不到 is_favorite. 收藏表的跨用户隔离在 user-favorites.test.ts 里单测.
    addFavorite(ownerId, taskId);
    const { status, body } = await getDetail(taskId, otherId);
    expect(status).toBe(404);
    expect(body.is_favorite).toBeUndefined();
  });

  it("短 ID 进详情同样带 is_favorite (按 resolvedId 算)", async () => {
    addFavorite(ownerId, taskId);
    const short = taskId.slice(0, 8);
    const { status, body } = await getDetail(short, ownerId);
    expect(status).toBe(200);
    expect(body.id).toBe(taskId);
    expect(body.is_favorite).toBe(true);
  });
});
