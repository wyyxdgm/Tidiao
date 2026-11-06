// GET/PUT/DELETE /api/projects/[id]/overview 集成测试.
//
// 关注点:
//  - 概览存 project_configs (加密), 不是明文落盘 —— 直接查 DB 验密文形态.
//  - owner 隔离: 别人的项目一律 404 (不暴露存在性). admin 也不豁免写.
//  - 超限 → 400 (不截断).
//  - GET 不存在 → exists:false (200), 不 404 —— 前端据此渲染「还没写」空态.
//
// 沿用 master 集成测试惯例: ORCHESTRATOR_DB_PATH 指向临时 db + closeDb() 重开,
// 见 src/app/api/projects/[id]/wiki/route.test.ts 同款骨架.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db";
import { createProject } from "@/lib/db/projects";
import {
  MAX_OVERVIEW_BYTES,
  OVERVIEW_CONFIG_KEY,
} from "@/lib/db/project-overview";
import { GET as overviewGet, PUT as overviewPut, DELETE as overviewDelete } from "./route";

let tmpDir: string;
let userId: string;
let otherUserId: string;
let projectId: string;

async function call(
  method: "GET" | "PUT" | "DELETE",
  asUserId: string | null,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (asUserId) headers["x-user-id"] = asUserId;
  const req = new NextRequest(
    `http://localhost/api/projects/${projectId}/overview`,
    {
      method,
      headers,
      body: method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
    }
  );
  const handler =
    method === "GET" ? overviewGet : method === "PUT" ? overviewPut : overviewDelete;
  const res = await handler(req as any, { params: Promise.resolve({ id: projectId }) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-overview-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();
  userId = uuidv4();
  otherUserId = uuidv4();
  const db = getDb();
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
  db.prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(otherUserId, `${otherUserId}@example.com`, "x", "user");
  const project = createProject({ name: "overview-proj", ownerId: userId, cwd: tmpDir });
  projectId = project.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/projects/[id]/overview", () => {
  it("未写过 → exists:false (200)", async () => {
    const r = await call("GET", userId);
    expect(r.status).toBe(200);
    expect(r.json.exists).toBe(false);
    expect(r.json.markdown).toBe(null);
  });

  it("写入后能读回原文", async () => {
    const md = "# 项目状态\n\n- 在跑: 3\n- [飞书](https://example.com/sheet)\n";
    const put = await call("PUT", userId, { markdown: md });
    expect(put.status).toBe(200);
    expect(put.json.markdown).toBe(md);

    const get = await call("GET", userId);
    expect(get.status).toBe(200);
    expect(get.json.exists).toBe(true);
    expect(get.json.markdown).toBe(md);
  });

  it("落库是密文 (DB 里不是明文)", async () => {
    const md = "密码是 hunter2";
    await call("PUT", userId, { markdown: md });
    const row = getDb()
      .prepare(
        "SELECT encrypted_value FROM project_configs WHERE project_id = ? AND key = ?"
      )
      .get(projectId, OVERVIEW_CONFIG_KEY) as { encrypted_value: string };
    expect(row.encrypted_value).toBeTruthy();
    expect(row.encrypted_value).not.toContain("hunter2");
  });

  it("无鉴权 → 401", async () => {
    const r = await call("GET", null);
    expect(r.status).toBe(401);
  });

  it("非 owner → 404 (不暴露存在性)", async () => {
    await call("PUT", userId, { markdown: "x" });
    const r = await call("GET", otherUserId);
    expect(r.status).toBe(404);
  });
});

describe("PUT /api/projects/[id]/overview", () => {
  it("markdown 非字符串 → 400", async () => {
    const r = await call("PUT", userId, { markdown: 123 });
    expect(r.status).toBe(400);
  });

  it("markdown 缺失 → 400", async () => {
    const r = await call("PUT", userId, {});
    expect(r.status).toBe(400);
  });

  it("超限 → 400 (不截断)", async () => {
    const huge = "a".repeat(MAX_OVERVIEW_BYTES + 1);
    const r = await call("PUT", userId, { markdown: huge });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("过大");

    // 没写进去 —— 读回来仍是未写过状态.
    const get = await call("GET", userId);
    expect(get.json.exists).toBe(false);
  });

  it("二次写是覆盖语义", async () => {
    await call("PUT", userId, { markdown: "v1" });
    await call("PUT", userId, { markdown: "v2" });
    const get = await call("GET", userId);
    expect(get.json.markdown).toBe("v2");
  });

  it("非 owner 写 → 404", async () => {
    const r = await call("PUT", otherUserId, { markdown: "hack" });
    expect(r.status).toBe(404);
  });
});

describe("DELETE /api/projects/[id]/overview", () => {
  it("删掉后 GET 回到 exists:false", async () => {
    await call("PUT", userId, { markdown: "x" });
    const del = await call("DELETE", userId);
    expect(del.status).toBe(200);

    const get = await call("GET", userId);
    expect(get.json.exists).toBe(false);
  });

  it("没写过就删 → 404", async () => {
    const r = await call("DELETE", userId);
    expect(r.status).toBe(404);
  });

  it("非 owner 删 → 404", async () => {
    await call("PUT", userId, { markdown: "x" });
    const r = await call("DELETE", otherUserId);
    expect(r.status).toBe(404);
  });
});
