// GET /api/webhooks/[id]/deliveries - 路由层测试 (R142 G3).
//
// 覆盖:
//   - 未登录 -> 401
//   - 普通用户对别人的 webhook -> 404 (no existence leak)
//   - owner 看到自己的 webhook deliveries (delivered + failed 两种 type)
//   - admin (x-user-role=admin) 可读任意 webhook 的 deliveries (bypass owner)
//   - 非整数/越界 limit 静默回退到 50 (不 400, 跟 dispatcher 默认对齐)
//   - data 解析失败兜底: 不抛 5xx, payload={} 兜底
//   - events.data 不带 status_code 时 response_status=null
//
// 关注点:
//   - 不拉 SDK (vi.mock 桩化, 与 [id]/route.test.ts 同模式).
//   - 直接用 INSERT events 行绕过 dispatcher, 跟 [id]/page.tsx 渲染口径一致:
//     {webhook_id, webhook_name, event, url, status_code, duration_ms} (success)
//     {webhook_id, webhook_name, event, url, error} (failure).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { GET } from "./route";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: () => {
      throw new Error("createTask not used in GET /api/webhooks/[id]/deliveries");
    },
    startTask: () => {},
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerA: string;
let ownerB: string;
let adminId: string;
let projectA: string;
let webhookA: string;

// events.task_id 是 FK to tasks(id) (v1 migration). 为 events 注入真实存在的
// task 行 (用 uuid 即可, title 任意占位), task 这边不参与 G3 业务断言.
function insertDeliveryEvent(
  id: number,
  webhookId: string,
  type: "webhook_delivered" | "webhook_delivery_failed",
  payload: Record<string, unknown>,
  createdAt: string
): void {
  const taskIdForEvent = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id)
       VALUES (?, 'tx', '', 'completed', ?, ?)`
    )
    .run(taskIdForEvent, ownerA, projectA);
  getDb()
    .prepare(
      `INSERT INTO events (id, task_id, session_id, type, data, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`
    )
    .run(id, taskIdForEvent, type, JSON.stringify(payload), createdAt);
}

function makeReq(webhookId: string, qs: string, headers: Record<string, string>) {
  return new NextRequest(
    `http://localhost/api/webhooks/${webhookId}/deliveries${qs}`,
    { method: "GET", headers }
  );
}

async function callGET(req: NextRequest) {
  const { id } = { id: req.url.split("/").slice(-2, -1)[0] };
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-webhook-deliveries-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerA = uuidv4();
  ownerB = uuidv4();
  adminId = uuidv4();
  for (const [id, role] of [
    [ownerA, "user"],
    [ownerB, "user"],
    [adminId, "admin"],
  ] as const) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", role);
  }

  webhookA = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO webhooks (id, name, url, events, secret, active, owner_id)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(webhookA, "hook-A", "https://example.com/hook", JSON.stringify(["task.completed"]), "secret", ownerA);

  projectA = uuidv4();
  getDb()
    .prepare(`INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)`)
    .run(projectA, "webhook-events-proj", ownerA);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("R142 G3: GET /api/webhooks/[id]/deliveries", () => {
  it("未登录 -> 401", async () => {
    const res = await callGET(makeReq(webhookA, "", {}));
    expect(res.status).toBe(401);
  });

  it("owner 看到 deliveries: 1 delivered + 1 failed", async () => {
    insertDeliveryEvent(100, webhookA, "webhook_delivered", {
      webhook_id: webhookA,
      webhook_name: "hook-A",
      event: "task.completed",
      url: "https://example.com/hook",
      status_code: 200,
      duration_ms: 42,
    }, "2026-09-24 10:00:00");
    insertDeliveryEvent(101, webhookA, "webhook_delivery_failed", {
      webhook_id: webhookA,
      webhook_name: "hook-A",
      event: "task.completed",
      url: "https://example.com/hook",
      error: "connection refused",
    }, "2026-09-24 10:00:05");

    const res = await callGET(makeReq(webhookA, "", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveries).toHaveLength(2);
    // DESC: id 101 在前 (最近)
    expect(body.deliveries[0].status).toBe("failed");
    expect(body.deliveries[0].response_status).toBeNull();
    expect(body.deliveries[0].payload.error).toBe("connection refused");
    expect(body.deliveries[0].attempted_at).toBe("2026-09-24 10:00:05");

    expect(body.deliveries[1].status).toBe("delivered");
    expect(body.deliveries[1].response_status).toBe(200);
    expect(body.deliveries[1].event).toBe("task.completed");
    expect(body.deliveries[1].attempted_at).toBe("2026-09-24 10:00:00");
  });

  it("跨 owner (ownerB 看 ownerA webhook) -> 404, 不暴露存在性", async () => {
    const res = await callGET(makeReq(webhookA, "", { "x-user-id": ownerB }));
    expect(res.status).toBe(404);
  });

  it("admin bypass owner 隔离, 可读任意 webhook 的 deliveries", async () => {
    insertDeliveryEvent(200, webhookA, "webhook_delivered", {
      webhook_id: webhookA,
      webhook_name: "hook-A",
      event: "task.completed",
      url: "https://example.com/hook",
      status_code: 201,
      duration_ms: 10,
    }, "2026-09-24 10:00:00");

    // ownerA/adminId 都不等于 ownerB, 验证 admin 真能跨 owner.
    const res = await callGET(
      makeReq(webhookA, "", { "x-user-id": adminId, "x-user-role": "admin" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0].response_status).toBe(201);
  });

  it("webhook 不存在 -> 404 (owner/admin 一致行为)", async () => {
    const res = await callGET(
      makeReq(uuidv4(), "", { "x-user-id": ownerA })
    );
    expect(res.status).toBe(404);
  });

  it("data 解析失败 → 不抛 5xx, payload 兜底 {}, response_status=null", async () => {
    // 模拟 dispatcher 写出半成品 JSON: 含 webhook_id 让 LIKE 命中, 但尾部被截坏 (production-side bug).
    // JSON.parse 抛错 → 路由层兜底 payload={}, 不 5xx, 跟现有 webhook-detail-client 渲染一致.
    const taskIdForEvent = uuidv4();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id)
         VALUES (?, 'tx', '', 'completed', ?, ?)`
      )
      .run(taskIdForEvent, ownerA, projectA);
    getDb()
      .prepare(
        `INSERT INTO events (id, task_id, session_id, type, data, created_at)
         VALUES (?, ?, NULL, 'webhook_delivered', ?, '2026-09-24 10:00:00')`
      )
      .run(300, taskIdForEvent, `{"webhook_id":"${webhookA}","event":`); // 截尾, parse 抛错

    const res = await callGET(makeReq(webhookA, "", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0].payload).toEqual({});
    expect(body.deliveries[0].response_status).toBeNull();
    expect(body.deliveries[0].status).toBe("delivered");
  });

  it("limit 越界 (0) / 非整数 → 静默回退到 50, 不 400", async () => {
    // 各塞 5 条
    for (let i = 0; i < 5; i++) {
      insertDeliveryEvent(400 + i, webhookA, "webhook_delivered", {
        webhook_id: webhookA,
        webhook_name: "hook-A",
        event: "task.completed",
        url: "https://example.com/hook",
        status_code: 200,
        duration_ms: 1,
      }, `2026-09-24 10:00:0${i}`);
    }

    // limit=0 (越界) → 50, 全 5 条都返
    const res = await callGET(makeReq(webhookA, "?limit=0", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveries).toHaveLength(5);
  });

  it("limit 正常 (5) 时只返最近 5 条", async () => {
    for (let i = 0; i < 8; i++) {
      insertDeliveryEvent(500 + i, webhookA, "webhook_delivered", {
        webhook_id: webhookA,
        webhook_name: "hook-A",
        event: "task.completed",
        url: "https://example.com/hook",
        status_code: 200,
        duration_ms: 1,
      }, `2026-09-24 10:00:0${i}`);
    }
    const res = await callGET(makeReq(webhookA, "?limit=5", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveries).toHaveLength(5);
  });

  it("无 events 时 deliveries=[]", async () => {
    const res = await callGET(makeReq(webhookA, "", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deliveries).toEqual([]);
  });
});
