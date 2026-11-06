// GET /api/user/used-models 集成测试.
// 覆盖:
//   1. 鉴权: 401
//   2. 无 task → models=[]
//   3. 用户 task.model DISTINCT 去重 + 排序
//   4. 排除 NULL 与空字符串
//   5. 只返回当前用户的, 不串台 (看板上别人同模型不会被列进来)
//   6. 排除软删 (deleted_at IS NOT NULL) -- 否则幽灵选项, 选择会触发 404
//
// 关注点:
//   - 直接 INSERT tasks 行, 不走 createTask (那会触发一堆副作用).
//   - ORCHESTRATOR_DB_PATH / ENCRYPTION_KEY 走临时库.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db";
import { GET } from "./route";

let tmpDir: string;
let userId: string;
let otherUserId: string;

async function callUsed(opts: { userId?: string | null } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.userId !== null) {
    headers["x-user-id"] = opts.userId ?? userId;
  }
  const req = new Request("http://localhost/api/user/used-models", {
    method: "GET",
    headers,
  });
  const res = await GET(req as any);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-used-models-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  closeDb();
  getDb();
  userId = uuidv4();
  otherUserId = uuidv4();
  const db = getDb();
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "user");
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(otherUserId, `${otherUserId}@example.com`, "x", "user");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertTask(opts: {
  ownerId: string;
  model: string | null;
  deleted?: boolean;
}) {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO tasks
        (id, owner_id, title, prompt, status, model, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      opts.ownerId,
      "t",
      "p",
      "completed",
      opts.model,
      opts.deleted ? new Date().toISOString() : null
    );
  return id;
}

describe("GET /api/user/used-models 鉴权", () => {
  it("无 x-user-id → 401", async () => {
    const { status, body } = await callUsed({ userId: null });
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });
});

describe("GET /api/user/used-models 内容", () => {
  it("无 task → models=[]", async () => {
    const { status, body } = await callUsed();
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
  });

  it("DISTINCT 去重 + 排序", async () => {
    insertTask({ ownerId: userId, model: "claude-3" });
    insertTask({ ownerId: userId, model: "claude-3" }); // 重复
    insertTask({ ownerId: userId, model: "gpt-4o" });
    const { status, body } = await callUsed();
    expect(status).toBe(200);
    expect(body.models).toEqual(["claude-3", "gpt-4o"]);
  });

  it("排除 NULL 与空字符串", async () => {
    insertTask({ ownerId: userId, model: null });
    insertTask({ ownerId: userId, model: "" });
    insertTask({ ownerId: userId, model: "   " });
    insertTask({ ownerId: userId, model: "claude-3" });
    const { body } = await callUsed();
    expect(body.models).toEqual(["claude-3"]);
  });

  it("只返回当前用户的, 不串台", async () => {
    insertTask({ ownerId: userId, model: "claude-3" });
    insertTask({ ownerId: otherUserId, model: "shared-model" });
    const { body } = await callUsed();
    expect(body.models).toEqual(["claude-3"]);
  });

  it("排除软删 task", async () => {
    insertTask({ ownerId: userId, model: "live" });
    insertTask({ ownerId: userId, model: "ghost", deleted: true });
    const { body } = await callUsed();
    expect(body.models).toEqual(["live"]);
  });
});
