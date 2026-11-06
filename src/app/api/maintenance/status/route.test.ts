// GET /api/maintenance/status 测试（全员可读 + 最小响应 + 防 admin 字段泄露）。
//
// 真 SQLite 临时库, 直接调 handler。脚手架照搬
// src/app/api/projects/route.test.ts:41-80。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { closeDb, getDb } from "@/lib/db/index";
import { enterMaintenance, exitMaintenance } from "@/lib/db/maintenance";

let tmpDir: string;
let adminId: string;
let userId: string;

function getReq(userIdHeader: string | null, role: string | null = "user") {
  const headers: Record<string, string> = {};
  if (userIdHeader) headers["x-user-id"] = userIdHeader;
  if (role) headers["x-user-role"] = role;
  return new NextRequest("http://localhost/api/maintenance/status", { headers });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-maint-status-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  adminId = uuidv4();
  userId = uuidv4();
  const ins = getDb().prepare(
    `INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );
  ins.run(adminId, "admin@example.com", "x", "admin");
  ins.run(userId, "alice@example.com", "x", "user");
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
});

describe("GET /api/maintenance/status", () => {
  it("未进入维护时返回 active:false", async () => {
    const res = await GET(getReq(userId));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ active: false, reason: null, entered_at: null });
  });

  it("进入维护后返回 active:true + reason + entered_at(ISO 字符串)", async () => {
    enterMaintenance({ by: adminId, reason: "deploy v40", suspended: [] });
    const res = await GET(getReq(userId));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.active).toBe(true);
    expect(json.reason).toBe("deploy v40");
    expect(typeof json.entered_at).toBe("string");
    // ISO 字符串能 parse
    expect(Number.isFinite(Date.parse(json.entered_at))).toBe(true);
  });

  it("响应 keys 严格等于 [active, entered_at, reason]，防止 admin 字段泄露", async () => {
    enterMaintenance({ by: adminId, reason: "x", suspended: [] });
    const res = await GET(getReq(userId));
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["active", "entered_at", "reason"]);
    // 显式断言不存在的关键字段
    expect(json).not.toHaveProperty("entered_by");
    expect(json).not.toHaveProperty("suspended");
    expect(json).not.toHaveProperty("suspended_count");
    expect(json).not.toHaveProperty("scheduler_paused");
    expect(json).not.toHaveProperty("running_count");
    expect(json).not.toHaveProperty("queue_size");
  });

  it("缺 x-user-id 返回 401", async () => {
    const res = await GET(getReq(null));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("非 admin 普通用户也能读（全员可读的核心断言）", async () => {
    enterMaintenance({ by: adminId, reason: "deploy", suspended: [] });
    const res = await GET(getReq(userId, "user"));
    expect(res.status).toBe(200);
    expect((await res.json()).active).toBe(true);
  });

  it("admin 也能读（对称性）", async () => {
    const res = await GET(getReq(adminId, "admin"));
    expect(res.status).toBe(200);
    expect((await res.json()).active).toBe(false);
  });

  it("完整 enter → get → exit → get 端到端走通 DB 原语", async () => {
    enterMaintenance({ by: adminId, reason: "deploy", suspended: [] });
    expect((await (await GET(getReq(userId))).json()).active).toBe(true);
    exitMaintenance();
    expect((await (await GET(getReq(userId))).json()).active).toBe(false);
  });
});
