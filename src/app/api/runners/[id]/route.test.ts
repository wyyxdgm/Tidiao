// /api/runners/[id] GET + DELETE 测试.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import {
  createRunner,
  getRunnerById,
} from "@/lib/db/runners";
import { GET, DELETE } from "./route";

let tmpDir: string;
let adminId: string;
let runnerId: string;

function makeReq(url: string, role = "admin") {
  return new NextRequest(url, {
    method: "GET",
    headers: {
      "x-user-id": adminId,
      "x-user-role": role,
    },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-id-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  adminId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(adminId, `${adminId}@example.com`, "x", "admin");
  // 提前造一个 runner 让 DELETE / GET 有目标
  const out = createRunner({
    name: "fixture",
    host: "fixture-host",
    port: 7777,
    os_type: "linux",
  });
  runnerId = out.runner.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/runners/[id]", () => {
  it("未登录 -> 401", async () => {
    const req = new NextRequest(`http://localhost/api/runners/${runnerId}`, {
      headers: {},
    });
    const res = await GET(req, { params: Promise.resolve({ id: runnerId }) });
    expect(res.status).toBe(401);
  });

  it("非 admin -> 401", async () => {
    const req = makeReq(`http://localhost/api/runners/${runnerId}`, "user");
    const res = await GET(req, { params: Promise.resolve({ id: runnerId }) });
    expect(res.status).toBe(401);
  });

  it("admin 不存在的 id -> 404", async () => {
    const req = makeReq(`http://localhost/api/runners/${uuidv4()}`);
    const res = await GET(req, { params: Promise.resolve({ id: uuidv4() }) });
    expect(res.status).toBe(404);
  });

  it("admin 存在的 id -> 200 + runner (不返回 token)", async () => {
    const req = makeReq(`http://localhost/api/runners/${runnerId}`);
    const res = await GET(req, { params: Promise.resolve({ id: runnerId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runner.id).toBe(runnerId);
    // 任何形式都不能含 auth 列
    expect(JSON.stringify(json)).not.toContain("auth_token");
    expect(JSON.stringify(json)).not.toContain("token");
  });
});

describe("DELETE /api/runners/[id]", () => {
  it("非 admin -> 401", async () => {
    const req = makeReq(`http://localhost/api/runners/${runnerId}`, "user");
    const res = await DELETE(req, { params: Promise.resolve({ id: runnerId }) });
    expect(res.status).toBe(401);
  });

  it("admin 不存在的 id -> 404", async () => {
    const id = uuidv4();
    const req = makeReq(`http://localhost/api/runners/${id}`);
    const res = await DELETE(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it("admin 存在 -> 200 + 真删了", async () => {
    const req = makeReq(`http://localhost/api/runners/${runnerId}`);
    const res = await DELETE(req, { params: Promise.resolve({ id: runnerId }) });
    expect(res.status).toBe(200);
    expect(getRunnerById(runnerId)).toBeNull();
  });
});
