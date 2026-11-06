// Tests for POST/DELETE/GET /api/tasks/[id]/favorite (v57, R15 task 收藏).
//
// 覆盖 5 条:
//   1) POST 未登录 401
//   2) POST 成功 200 + body 含 favorite=true
//   3) POST 已收藏幂等 200 + already=true
//   4) DELETE 取消 204 + DB 行被删
//   5) GET 查询当前用户的 favorite 状态 (收藏前/后/取消后)
//
// 模式与 src/app/api/tasks/page/route.test.ts 同款: 真 SQLite 临时库 + 直接
// 调 handler (不起 server), 用 x-user-id header 模拟鉴权.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask } from "@/lib/db/tasks";
import { POST, DELETE, GET } from "@/app/api/tasks/[id]/favorite/route";
import { isFavoriteByUser } from "@/lib/db/user-favorites";

let tmpDir: string;
let aliceId: string;
let bobId: string;
let aliceTaskId: string;

function makeUser(prefix: string): string {
  const id = `${prefix}-${uuidv4()}`;
  getDb()
    .prepare(
      "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
    )
    .run(id, `${prefix}-${id}@example.com`, "test-hash", "user");
  return id;
}

async function reqAs(
  userId: string | null,
  taskId: string,
  method: "POST" | "DELETE" | "GET"
) {
  const headers: Record<string, string> = {};
  if (userId) headers["x-user-id"] = userId;
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/favorite`, {
    method,
    headers,
  });
  // Next.js route handler signature: (request, { params })
  const handler = method === "POST" ? POST : method === "DELETE" ? DELETE : GET;
  const res = await handler(req, { params: Promise.resolve({ id: taskId }) });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-fav-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();

  aliceId = makeUser("alice");
  bobId = makeUser("bob");
  // Alice owns a project + task; Bob is the "other user" for 401/404 isolation.
  const aliceProject = await createProject({ name: `p-${uuidv4().slice(0, 8)}`, description: "test", ownerId: aliceId });
  const task = await createTask({
    project_id: aliceProject.id,
    title: "alice task",
    prompt: "p",
    type: "test",
    owner_id: aliceId,
  } as any);
  aliceTaskId = task.id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
});

describe("POST /api/tasks/[id]/favorite", () => {
  it("未登录 → 401", async () => {
    const { status, json } = await reqAs(null, aliceTaskId, "POST");
    expect(status).toBe(401);
    expect(json.error).toBe("unauthorized");
  });

  it("登录 + task 存在 → 200 + favorite=true + DB 写入", async () => {
    const { status, json } = await reqAs(aliceId, aliceTaskId, "POST");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.favorite).toBe(true);
    // 第一次收藏, already 应为 false
    expect(json.already).toBe(false);
    expect(isFavoriteByUser(aliceId, aliceTaskId)).toBe(true);
  });

  it("重复 POST 已收藏 task → 200 + already=true (幂等)", async () => {
    await reqAs(aliceId, aliceTaskId, "POST");
    const { status, json } = await reqAs(aliceId, aliceTaskId, "POST");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.favorite).toBe(true);
    expect(json.already).toBe(true);
    // DB 仍只 1 行
    const rows = getDb()
      .prepare("SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ? AND task_id = ?")
      .get(aliceId, aliceTaskId) as { c: number };
    expect(rows.c).toBe(1);
  });

  it("其他用户对该 task POST 不影响 Alice 的收藏状态 (多用户隔离)", async () => {
    // Alice 收藏
    await reqAs(aliceId, aliceTaskId, "POST");
    // Bob 独立收藏 (合法, user_favorites 是 per-user)
    const { status, json } = await reqAs(bobId, aliceTaskId, "POST");
    // Bob 没 task, getTaskById(bobId) 返 null → 404 (符合鉴权隔离)
    expect(status).toBe(404);
    expect(json.error).toBe("Task not found");
    // Alice 仍收藏
    expect(isFavoriteByUser(aliceId, aliceTaskId)).toBe(true);
  });
});

describe("DELETE /api/tasks/[id]/favorite", () => {
  it("收藏后 DELETE → 204 + DB 行被删", async () => {
    await reqAs(aliceId, aliceTaskId, "POST");
    expect(isFavoriteByUser(aliceId, aliceTaskId)).toBe(true);
    const { status, json } = await reqAs(aliceId, aliceTaskId, "DELETE");
    expect(status).toBe(204);
    expect(json).toBe(null);
    expect(isFavoriteByUser(aliceId, aliceTaskId)).toBe(false);
  });

  it("未收藏的 task DELETE → 204 (幂等)", async () => {
    const { status, json } = await reqAs(aliceId, aliceTaskId, "DELETE");
    expect(status).toBe(204);
    expect(json).toBe(null);
  });
});

describe("GET /api/tasks/[id]/favorite", () => {
  it("收藏前 false → POST 后 true → DELETE 后 false", async () => {
    const before = await reqAs(aliceId, aliceTaskId, "GET");
    expect(before.status).toBe(200);
    expect(before.json.favorite).toBe(false);

    await reqAs(aliceId, aliceTaskId, "POST");
    const during = await reqAs(aliceId, aliceTaskId, "GET");
    expect(during.status).toBe(200);
    expect(during.json.favorite).toBe(true);

    await reqAs(aliceId, aliceTaskId, "DELETE");
    const after = await reqAs(aliceId, aliceTaskId, "GET");
    expect(after.status).toBe(200);
    expect(after.json.favorite).toBe(false);
  });
});