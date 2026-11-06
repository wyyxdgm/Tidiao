// GET /api/tasks/[id]/events - 路由层测试 (R142 G5).
//
// 覆盖:
//   - 未登录 -> 401
//   - 跨 owner -> 404
//   - task 不存在 -> 404
//   - owner 看到自己的 task events (按 id DESC, 最新在前面)
//   - admin (x-user-role=admin) 可读任意 task 的 events (bypass owner)
//   - 默认 limit=50
//   - 显式 ?limit=5 只返最近 5 条
//   - data JSON 解析失败 → 兜底原字符串, 不 5xx
//   - 软删 task (deleted_at IS NOT NULL) 仍可读 (includeDeleted=true)
//
// 关注点:
//   - 不拉 SDK (vi.mock 桩化, 与 [id] 同模块其他 route.test.ts 一致模式).
//   - 直接 INSERT events 行灌数据.

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
      throw new Error("createTask not used in GET /api/tasks/[id]/events");
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
let taskId: string;

function insertTask(
  id: string,
  ownerId: string,
  deletedAt: string | null = null
): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, prompt, status, owner_id, project_id, deleted_at)
       VALUES (?, 't', 'p', 'completed', ?, ?, ?)`
    )
    .run(id, ownerId, projectA, deletedAt);
}

function insertEvent(
  id: number,
  taskIdLocal: string,
  type: string,
  data: string,
  sessionId: string | null = null,
  createdAt: string
): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, task_id, session_id, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, taskIdLocal, sessionId, type, data, createdAt);
}

function makeReq(tid: string, qs: string, headers: Record<string, string>) {
  return new NextRequest(
    `http://localhost/api/tasks/${tid}/events${qs}`,
    { method: "GET", headers }
  );
}

async function callGET(req: NextRequest) {
  const { id } = { id: req.url.split("/").slice(-2, -1)[0] };
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-task-events-"));
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

  projectA = uuidv4();
  getDb()
    .prepare(`INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)`)
    .run(projectA, "events-proj", ownerA);

  taskId = uuidv4();
  insertTask(taskId, ownerA);
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("R142 G5: GET /api/tasks/[id]/events", () => {
  it("未登录 -> 401", async () => {
    const res = await callGET(makeReq(taskId, "", {}));
    expect(res.status).toBe(401);
  });

  it("task 不存在 -> 404", async () => {
    const res = await callGET(makeReq(uuidv4(), "", { "x-user-id": ownerA }));
    expect(res.status).toBe(404);
  });

  it("跨 owner (ownerB 看 ownerA task) -> 404, 不暴露存在性", async () => {
    const res = await callGET(makeReq(taskId, "", { "x-user-id": ownerB }));
    expect(res.status).toBe(404);
  });

  it("owner 看到 events, 按 id DESC, data 解析为对象", async () => {
    insertEvent(1, taskId, "status_change", JSON.stringify({ from: "queued", to: "running" }), null, "2026-09-24 10:00:00");
    insertEvent(2, taskId, "tool_use", JSON.stringify({ name: "Read", input: { file_path: "/x" } }), "sess-1", "2026-09-24 10:00:01");
    insertEvent(3, taskId, "status_change", JSON.stringify({ from: "running", to: "completed" }), "sess-1", "2026-09-24 10:00:05");

    const res = await callGET(makeReq(taskId, "", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_id).toBe(taskId);
    expect(body.events).toHaveLength(3);
    // DESC: event 3 在前 (最近)
    expect(body.events[0].type).toBe("status_change");
    expect(body.events[0].data).toEqual({ from: "running", to: "completed" });
    expect(body.events[0].created_at).toBe("2026-09-24 10:00:05");
    expect(body.events[1].session_id).toBe("sess-1");
    expect(body.events[2].data).toEqual({ from: "queued", to: "running" });
  });

  it("admin bypass owner 隔离, 可读任意 task 的 events", async () => {
    insertEvent(10, taskId, "status_change", JSON.stringify({ from: "queued", to: "running" }), null, "2026-09-24 10:00:00");

    const res = await callGET(
      makeReq(taskId, "", { "x-user-id": adminId, "x-user-role": "admin" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });

  it("data 解析失败 → 兜底返原字符串, 不 5xx", async () => {
    getDb()
      .prepare(
        `INSERT INTO events (id, task_id, session_id, type, data, created_at)
         VALUES (?, ?, NULL, 'status_change', 'not-json', '2026-09-24 10:00:00')`
      )
      .run(20, taskId);

    const res = await callGET(makeReq(taskId, "", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].data).toBe("not-json");
  });

  it("显式 ?limit=5 只返最近 5 条 (DESC 取 id 大)", async () => {
    for (let i = 0; i < 8; i++) {
      insertEvent(
        100 + i,
        taskId,
        "status_change",
        JSON.stringify({ idx: i }),
        null,
        `2026-09-24 10:00:0${i}`,
      );
    }
    const res = await callGET(makeReq(taskId, "?limit=5", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(5);
    // 最近 5 条 = idx 7..3 (DESC by id)
    expect(body.events[0].data).toEqual({ idx: 7 });
    expect(body.events[4].data).toEqual({ idx: 3 });
  });

  it("无 events 时 events=[]", async () => {
    const res = await callGET(makeReq(taskId, "", { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it("软删 task (deleted_at 非 NULL) 仍可读 events (与 timeline 一致)", async () => {
    const deletedTaskId = uuidv4();
    insertTask(deletedTaskId, ownerA, "2026-09-24 09:00:00");
    insertEvent(30, deletedTaskId, "status_change", JSON.stringify({ from: "queued", to: "running" }), null, "2026-09-24 09:30:00");

    const res = await callGET(
      makeReq(deletedTaskId, "", { "x-user-id": ownerA })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
  });
});
