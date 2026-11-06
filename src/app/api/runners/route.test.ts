// /api/runners 列表 + 创建的路由层测试.
// 关注点:
//   - admin gating: 非 admin 任何动作都 401 (不 403 不 404)
//   - token **仅在 POST 响应里出现**, 之后的 GET 再不能返回
//   - UNIQUE (host, port) -> 409 带 code: "DUPLICATE_HOST_PORT"
//   - 入参校验: name / host 必填, port 1-65535 整数, os_type 在白名单

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET, POST } from "./route";
import { _readRunnerAuthColumns } from "@/lib/db/runners";

let tmpDir: string;
let adminId: string;
let userId: string;

function makeReq(
  url: string,
  init: { method?: string; body?: unknown; userId?: string; role?: string } = {}
) {
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-user-id": init.userId ?? adminId,
      "x-user-role": init.role ?? "admin",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runners-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  adminId = uuidv4();
  userId = uuidv4();
  for (const [id, role] of [
    [adminId, "admin"],
    [userId, "user"],
  ]) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", role);
  }
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCHESTRATION_KEY;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/runners", () => {
  it("未登录 -> 401", async () => {
    const req = new NextRequest("http://localhost/api/runners", {
      headers: {}, // 缺 x-user-id
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("非 admin -> 401 (不 403 不 404)", async () => {
    const req = makeReq("http://localhost/api/runners", { role: "user" });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("admin -> 200 + 列表", async () => {
    const req = makeReq("http://localhost/api/runners");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.runners)).toBe(true);
  });
});

describe("POST /api/runners", () => {
  it("未登录 -> 401", async () => {
    const req = new NextRequest("http://localhost/api/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", host: "h", port: 1, os_type: "linux" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("非 admin -> 401", async () => {
    const req = makeReq("http://localhost/api/runners", {
      method: "POST",
      role: "user",
      body: { name: "a", host: "h", port: 1, os_type: "linux" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("admin 正常注册 -> 201 + (runner, token)", async () => {
    const req = makeReq("http://localhost/api/runners", {
      method: "POST",
      body: { name: "mac-build", host: "192.168.3.243", port: 8081, os_type: "macos" },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.runner.name).toBe("mac-build");
    expect(json.runner.host).toBe("192.168.3.243");
    expect(json.runner.port).toBe(8081);
    expect(json.runner.os_type).toBe("macos");
    expect(json.token).toMatch(/^[0-9a-f]{64}$/);
    // 关键: auth 列被加密, **不**等于明文 token
    const stored = _readRunnerAuthColumns(json.runner.id)!;
    expect(stored.encrypted).not.toBe(json.token);
    expect(stored.iv).toMatch(/^[0-9a-f]+$/);
    expect(stored.tag).toMatch(/^[0-9a-f]+$/);
  });

  it("🔴 token 仅在 POST 响应里出现, 之后的 GET 拿不到", async () => {
    const create = await POST(
      makeReq("http://localhost/api/runners", {
        method: "POST",
        body: { name: "tok", host: "h1", port: 8082, os_type: "linux" },
      })
    );
    const { runner, token } = await create.json();
    const list = await GET(makeReq("http://localhost/api/runners"));
    const { runners } = await list.json();
    const found = runners.find((r: { id: string }) => r.id === runner.id);
    expect(found).toBeTruthy();
    expect(JSON.stringify(found)).not.toContain(token);
    // 而且 response body 整体也不该含 token (再确认)
    expect(JSON.stringify(runners)).not.toContain(token);
  });

  it("缺 name -> 400", async () => {
    const req = makeReq("http://localhost/api/runners", {
      method: "POST",
      body: { host: "h", port: 1, os_type: "linux" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("缺 host -> 400", async () => {
    const req = makeReq("http://localhost/api/runners", {
      method: "POST",
      body: { name: "a", port: 1, os_type: "linux" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("port 非整数 -> 400", async () => {
    const req = makeReq("http://localhost/api/runners", {
      method: "POST",
      body: { name: "a", host: "h", port: 70000, os_type: "linux" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("os_type 不在白名单 -> 400", async () => {
    const req = makeReq("http://localhost/api/runners", {
      method: "POST",
      body: { name: "a", host: "h", port: 1, os_type: "freebsd" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("重复 host:port -> 409 + DUPLICATE_HOST_PORT code", async () => {
    await POST(
      makeReq("http://localhost/api/runners", {
        method: "POST",
        body: { name: "a", host: "dup-host", port: 9090, os_type: "linux" },
      })
    );
    const res = await POST(
      makeReq("http://localhost/api/runners", {
        method: "POST",
        body: { name: "b", host: "dup-host", port: 9090, os_type: "linux" },
      })
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("DUPLICATE_HOST_PORT");
  });
});
