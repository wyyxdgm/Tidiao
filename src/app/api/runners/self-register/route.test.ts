// POST /api/runners/self-register 路由测试.
//
// 关注点:
//   - RUNNER_BOOTSTRAP_SECRET 未设 → 整个路由 404 (feature off)
//   - 错 secret → 401
//   - 缺 secret → 401
//   - 错 secret 格式 (port 非整数) → 400
//   - 重复 host:port → 409
//   - 正确 secret + 合法 body → 201, 返回 {runner, token}
//   - admin 也可走这条路由 (绕过 secret)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { closeDb, getDb } from "@/lib/db/index";
import { POST } from "./route";

let tmpDir: string;
const TEST_SECRET = "test-bootstrap-secret-32chars-long!!!";
let originalSecret: string | undefined;

function makeRequest(body: any, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/runners/self-register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-sr-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  originalSecret = process.env.RUNNER_BOOTSTRAP_SECRET;
  process.env.RUNNER_BOOTSTRAP_SECRET = TEST_SECRET;
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  if (originalSecret === undefined) {
    delete process.env.RUNNER_BOOTSTRAP_SECRET;
  } else {
    process.env.RUNNER_BOOTSTRAP_SECRET = originalSecret;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/runners/self-register (bootstrap secret)", () => {
  it("🔴 RUNNER_BOOTSTRAP_SECRET 未设置 → 404 (feature flag off, 装作路由不存在)", async () => {
    delete process.env.RUNNER_BOOTSTRAP_SECRET;
    const req = makeRequest(
      { name: "x", host: "127.0.0.1", port: 8081, os_type: "macos" },
      { "x-runner-bootstrap-secret": TEST_SECRET },
    );
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("错 secret → 401 (含 constant-time 防 timing 侧信道)", async () => {
    const req = makeRequest(
      { name: "x", host: "127.0.0.1", port: 8081, os_type: "macos" },
      { "x-runner-bootstrap-secret": "wrong-secret-but-same-length-padding" },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("长度不等的 secret → 401 (避免抛异常)", async () => {
    const req = makeRequest(
      { name: "x", host: "127.0.0.1", port: 8081, os_type: "macos" },
      { "x-runner-bootstrap-secret": "short" },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("缺 secret header → 401", async () => {
    const req = makeRequest(
      { name: "x", host: "127.0.0.1", port: 8081, os_type: "macos" },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("happy path: 正确 secret + 合法 body → 201 + {runner, token}, token 64 hex", async () => {
    const req = makeRequest(
      { name: "real-runner", host: "192.168.3.243", port: 8081, os_type: "macos" },
      { "x-runner-bootstrap-secret": TEST_SECRET },
    );
    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.runner).toMatchObject({
      name: "real-runner",
      host: "192.168.3.243",
      port: 8081,
      os_type: "macos",
      status: "offline",
    });
    expect(json.token).toMatch(/^[0-9a-f]{64}$/);
    expect(json.runner.id).toBeTruthy();
  });

  it("Bearer header 也接受 (兼容 daemon --register 老调用方式)", async () => {
    const req = makeRequest(
      { name: "bearer-style", host: "127.0.0.1", port: 19999, os_type: "linux" },
      { authorization: `Bearer ${TEST_SECRET}` },
    );
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it("port 非整数 → 400", async () => {
    const req = makeRequest(
      { name: "x", host: "127.0.0.1", port: "not-a-port", os_type: "macos" },
      { "x-runner-bootstrap-secret": TEST_SECRET },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("重复 host:port → 409 DUPLICATE_HOST_PORT", async () => {
    // 先注册一个
    const r1 = await POST(
      makeRequest(
        { name: "first", host: "h", port: 8081, os_type: "macos" },
        { "x-runner-bootstrap-secret": TEST_SECRET },
      ),
    );
    expect(r1.status).toBe(201);
    // 再注册同 host:port
    const r2 = await POST(
      makeRequest(
        { name: "second", host: "h", port: 8081, os_type: "macos" },
        { "x-runner-bootstrap-secret": TEST_SECRET },
      ),
    );
    expect(r2.status).toBe(409);
    const j = await r2.json();
    expect(j.code).toBe("DUPLICATE_HOST_PORT");
  });

  it("admin (x-user-role=admin) 也可走 (不需 secret)", async () => {
    const req = makeRequest(
      { name: "admin-via-self", host: "127.0.0.1", port: 18080, os_type: "linux" },
      { "x-user-id": "u-admin", "x-user-role": "admin" },
    );
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it("admin + 错 secret 同时 → secret 路径拒绝 (admin 检查不覆盖 secret, 两者独立)", async () => {
    // 设计: adminOk || secretOk, 只要一个 true 就放行. 所以 admin + 错 secret 仍 OK.
    const req = makeRequest(
      { name: "admin-with-bad-secret", host: "127.0.0.1", port: 18081, os_type: "linux" },
      { "x-user-id": "u-admin", "x-user-role": "admin", "x-runner-bootstrap-secret": "wrong" },
    );
    const res = await POST(req);
    expect(res.status).toBe(201);
  });
});