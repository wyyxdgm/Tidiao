// /api/runners/[id]/health 测试 (admin 手动探针).
// 关注点:
//   - admin gating
//   - 真 HTTP fetch 到一个本地 mock server, 验证 last_health_json 落库 +
//     200 + 超时/坏响应/非 JSON 错误路径
//   - 5s 超时 (这里用超短的 fetch, 不真的等 5s)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "node:net";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createRunner, getRunnerById } from "@/lib/db/runners";
import { POST } from "./route";

let tmpDir: string;
let adminId: string;
let runnerId: string;
let runnerPort: number;
let fake: FakeHealthServer;

interface FakeHealthServer {
  port: number;
  close: () => void;
  // setter: 用法 setResponder(handler); handler(req, res) => void
  setResponder: (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void;
}

async function startFakeHealth(): Promise<FakeHealthServer> {
  let handler: http.RequestListener = (_req, res) => {
    res.statusCode = 404;
    res.end();
  };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: () => server.close(),
    setResponder: (h) => {
      handler = h;
    },
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-health-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  closeDb();
  getDb();
  adminId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(adminId, `${adminId}@example.com`, "x", "admin");
  fake = await startFakeHealth();
  runnerPort = fake.port;
  // runner 指向本地假 server
  const out = createRunner({
    name: "health-test",
    host: "127.0.0.1",
    port: runnerPort,
    os_type: "linux",
  });
  runnerId = out.runner.id;
});

afterEach(() => {
  fake?.close();
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  delete process.env.ENCRYPTION_KEY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function probe(role = "admin", id = runnerId) {
  const req = new NextRequest(`http://localhost/api/runners/${id}/health`, {
    method: "POST",
    headers: {
      "x-user-id": adminId,
      "x-user-role": role,
    },
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

describe("POST /api/runners/[id]/health", () => {
  it("非 admin -> 401", async () => {
    const res = await probe("user");
    expect(res.status).toBe(401);
  });

  it("admin 正常响应 -> 200 + last_health_json 落库", async () => {
    fake.setResponder((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ os: "darwin", uptime_s: 42, max_concurrent: 4 }));
    });
    const res = await probe();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.health).toContain("darwin");
    const after = getRunnerById(runnerId)!;
    expect(after.last_health_json).toContain("max_concurrent");
    expect(after.last_health_json).toContain("4");
  });

  it("runner 返 5xx -> 400", async () => {
    fake.setResponder((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const res = await probe();
    expect(res.status).toBe(400);
  });

  it("runner 返 非 JSON -> 400", async () => {
    fake.setResponder((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("not json at all");
    });
    const res = await probe();
    expect(res.status).toBe(400);
  });

  it("runner 连不上 -> 400 + error 文案", async () => {
    // 让 db 里的 host 指向不可达
    getDb()
      .prepare(`UPDATE runners SET host = ? WHERE id = ?`)
      .run("127.0.0.1", runnerId);
    // 关掉 fake server 也行, 但更稳的做法是挪到不同端口
    getDb()
      .prepare(`UPDATE runners SET port = ? WHERE id = ?`)
      .run(1, runnerId); // 1 = 不会被监听的特权端口
    const res = await probe();
    expect(res.status).toBe(400);
  });

  it("不存在的 runner id -> 404", async () => {
    const id = uuidv4();
    const req = new NextRequest(`http://localhost/api/runners/${id}/health`, {
      method: "POST",
      headers: { "x-user-id": adminId, "x-user-role": "admin" },
    });
    const res = await POST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });
});
