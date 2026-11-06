// GET /api/user/llm-config/available 集成测试.
// 覆盖:
//   1. 无 x-user-id -> 401
//   2. 有 x-user-id + 用户无 config -> 200, configs=[]
//   3. 用户有 self config -> 返回含 self/source/model 字段
//   4. 用户非 admin 且无 grant -> 看不到 admin 行
//   5. user role=admin -> 自动看得到 admin 行 (admin_grant 来源)
//   6. admin grant enabled -> 非 admin 用户也能看到 admin_grant 行
//   7. model 字段直传 (前端下拉数据源 = llm_configs.model)
//
// 关注点:
//   - middleware 注入 x-user-id/x-user-role; 这里手设 header 直传.
//   - 不动真实 DB, 用 ORCHESTRATOR_DB_PATH + ENCRYPTION_KEY 走临时库.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "@/lib/db";
import { GET } from "./route";

let tmpDir: string;
let testUserId: string;
let adminUserId: string;

async function callAvailable(opts: {
  userId?: string | null;
  userRole?: string | null;
} = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.userId !== null) {
    headers["x-user-id"] = opts.userId ?? testUserId;
    headers["x-user-role"] = opts.userRole ?? "user";
  }
  const req = new Request("http://localhost/api/user/llm-config/available", {
    method: "GET",
    headers,
  });
  const res = await GET(req as any);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-llmcfg-avail-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  closeDb();
  getDb();

  testUserId = uuidv4();
  adminUserId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(testUserId, `${testUserId}@example.com`, "x", "user");
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(adminUserId, `${adminUserId}@example.com`, "x", "admin");
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/user/llm-config/available 鉴权", () => {
  it("无 x-user-id → 401", async () => {
    const { status, body } = await callAvailable({ userId: null });
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });
});

describe("GET /api/user/llm-config/available 数据源 = llm_configs.model", () => {
  it("用户无 config → 200, configs=[]", async () => {
    const { status, body } = await callAvailable();
    expect(status).toBe(200);
    expect(body.configs).toEqual([]);
  });

  it("用户 1 份 self config → 透传 name/model/is_default/source", async () => {
    const { createLlmConfig } = await import("@/lib/db/llm-configs");
    createLlmConfig("user", testUserId, {
      name: "first",
      api_key: "sk-test-1",
      base_url: "https://a.example",
      model: "claude-3-5-sonnet",
    });
    const { status, body } = await callAvailable();
    expect(status).toBe(200);
    expect(body.configs).toHaveLength(1);
    const c = body.configs[0];
    expect(c.name).toBe("first");
    expect(c.model).toBe("claude-3-5-sonnet");
    expect(c.source).toBe("self");
    expect(c.is_default).toBe(true);
  });

  it("非 admin 无 grant → 看不到 admin 行", async () => {
    const { createLlmConfig } = await import("@/lib/db/llm-configs");
    createLlmConfig("admin", "system", {
      name: "platform-default",
      api_key: "sk-admin",
      base_url: "https://b.example",
      model: "admin-model",
    });
    const { status, body } = await callAvailable();
    expect(status).toBe(200);
    expect(body.configs).toEqual([]);
  });

  it("role=admin → 自动看得到 admin_grant 行 (admins = admin owners)", async () => {
    const { createLlmConfig } = await import("@/lib/db/llm-configs");
    createLlmConfig("user", adminUserId, {
      name: "my-config",
      api_key: "sk-x",
      model: "claude-x",
    });
    createLlmConfig("admin", "system", {
      name: "platform",
      api_key: "sk-admin",
      model: "platform-model",
    });
    const { status, body } = await callAvailable({ userId: adminUserId, userRole: "admin" });
    expect(status).toBe(200);
    const names = body.configs.map((c: any) => c.name).sort();
    expect(names).toEqual(["my-config", "platform"]);
    const platform = body.configs.find((c: any) => c.name === "platform");
    expect(platform.source).toBe("admin_grant");
    expect(platform.model).toBe("platform-model");
  });

  it("非 admin + admin grant enabled → 能看到 admin_grant 行", async () => {
    const { createLlmConfig, setAdminLlmGrant } = await import("@/lib/db/llm-configs");
    createLlmConfig("admin", "system", {
      name: "platform",
      api_key: "sk-admin",
      model: "platform-model",
    });
    setAdminLlmGrant(testUserId, true);
    const { status, body } = await callAvailable();
    expect(status).toBe(200);
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0].source).toBe("admin_grant");
    expect(body.configs[0].model).toBe("platform-model");
  });
});
