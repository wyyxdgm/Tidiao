// POST /api/requirements/[id]/auto-dispatch 回归测试 — R78 W1 §4.5 + Bug 2 fix.
//
// 覆盖 (M reject feedback):
//   - Bug 2 关键回归: body.type 非法值 (拼错/错字) 不再静默回落 dev,
//     400 + code=TYPE_INVALID 与 POST /api/tasks 同口径.
//   - auth: 未登录 → 401
//   - 404: 不存在 / 跨 owner → 404
//   - closed: requirement.status=closed → 400 REQUIREMENT_CLOSED
//   - type valid design / dev: 落库 task.type 与入参一致
//   - 不传 type → 走默认 dev
//   - linked: 成功后 task.requirement_id === req.id
//   - start: body.start=true → started=true 且 status=running/queued
//   - start=false: body.start=false → started=false
//
// 关注点:
//   - runtime 用 DB 层替身 (createTask 走真 DB, startTask 桩化为改 status=running).
//   - PATCH 顺序: 先校验 owner, 再 quota, 再 type — 跨 owner 不能 leak 422 vs 404.
//   - quota 默认放行 (新建 user 没设 party_a_enabled, R88 路径不触发).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createRequirement, updateRequirement } from "@/lib/db/requirements";
import { getTaskById } from "@/lib/db/tasks";

// runtime 用真 DB 层 createTask, startTask 桩化为改 status='running' (模拟 startTask 副作用).
import * as realTasks from "@/lib/db/tasks";
vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: (def: any) => realTasks.createTask(def),
    startTask: (taskId: string) => {
      // 桩化: 改 status='running' 模拟入队. SDK 真实路径不会改 status 但 integration
      // test 用 status 字段做断言最直观, 真 SDK 测在 e2e 层做.
      getDb()
        .prepare("UPDATE tasks SET status = 'running' WHERE id = ?")
        .run(taskId);
    },
    sendUserMessage: () => {},
    setAutoApprove: () => {},
    setTaskTimeout: () => true,
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerA: string;
let ownerB: string;
let projectA: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-auto-dispatch-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerA = uuidv4();
  ownerB = uuidv4();
  for (const id of [ownerA, ownerB]) {
    getDb()
      .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, "x", "user");
  }
  projectA = createProject({ name: "auto-dispatch-proj", ownerId: ownerA }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function autoReq(reqId: string, body: unknown, uid: string | null = ownerA) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (uid) headers["x-user-id"] = uid;
  return new NextRequest(
    `http://localhost/api/requirements/${reqId}/auto-dispatch`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    }
  );
}

async function loadPost() {
  return (await import("./route")).POST;
}

// ---- auth ----

describe("POST /api/requirements/[id]/auto-dispatch: auth", () => {
  it("未登录 (无 x-user-id header) → 401", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, {}, null), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(401);
  });
});

// ---- 404 / closed ----

describe("POST /api/requirements/[id]/auto-dispatch: 404 / closed", () => {
  it("不存在 requirement → 404", async () => {
    const POST = await loadPost();
    const res = await POST(autoReq(uuidv4(), {}), {
      params: Promise.resolve({ id: uuidv4() }),
    });
    expect(res.status).toBe(404);
  });

  it("跨 owner requirement → 404 (no existence leak)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, {}, ownerB), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(404);
  });

  it("requirement.status=closed → 400 REQUIREMENT_CLOSED", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    // 走 updateRequirement 软删 (同 owner 才有权限).
    updateRequirement(r.id, { status: "closed" as any }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, {}), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("REQUIREMENT_CLOSED");
  });
});

// ---- Bug 2: type 校验 ----

describe("Bug 2: body.type 非法值不再静默回落", () => {
  it("type='desin' (拼错) → 400 TYPE_INVALID (关键回归)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { type: "desin" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("TYPE_INVALID");
    expect(body.error).toContain("design,dev,test,deploy");
    // 不应有 task 被创建 (type 校验在 createTask 之前).
    const tasks = getDb()
      .prepare("SELECT id FROM tasks WHERE requirement_id = ?")
      .all(r.id) as { id: string }[];
    expect(tasks).toHaveLength(0);
  });

  it("type='test1' (错字) → 400 TYPE_INVALID", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { type: "test1" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TYPE_INVALID");
  });

  it("type=123 (非 string) → 400 TYPE_INVALID", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { type: 123 }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TYPE_INVALID");
  });

  it("type=null → 走默认 dev (兼容现有行为)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { type: null }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.type).toBe("dev");
  });

  it("不传 type → 走默认 dev", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, {}), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.type).toBe("dev");
  });

  it("type='design' → 200 task.type === 'design'", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { type: "design" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.type).toBe("design");
  });

  it("type='deploy' → 200 task.type === 'deploy'", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { type: "deploy" }), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).task.type).toBe("deploy");
  });
});

// ---- linked / start 行为 ----

describe("POST /api/requirements/[id]/auto-dispatch: linked + start", () => {
  it("成功后 task.requirement_id === req.id (linked 关系)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, {}), {
      params: Promise.resolve({ id: r.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requirement_id).toBe(r.id);
    const fresh = getTaskById(body.task.id, ownerA) as (ReturnType<typeof getTaskById> & { requirement_id: string | null }) | null;
    expect(fresh?.requirement_id).toBe(r.id);
  });

  it("start 默认 true → started=true + task.status='running'", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, {}), {
      params: Promise.resolve({ id: r.id }),
    });
    const body = await res.json();
    expect(body.started).toBe(true);
    const fresh = getTaskById(body.task.id, ownerA);
    expect(fresh?.status).toBe("running");
  });

  it("body.start=false → started=false + task 仍创建 (status=pending)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { start: false }), {
      params: Promise.resolve({ id: r.id }),
    });
    const body = await res.json();
    expect(body.started).toBe(false);
    const fresh = getTaskById(body.task.id, ownerA);
    expect(fresh?.status).toBe("pending");
  });

  it("body.start=true 显式 → 同默认行为 (started=true)", async () => {
    const r = createRequirement(projectA, { title: "t" }, ownerA);
    const POST = await loadPost();
    const res = await POST(autoReq(r.id, { start: true }), {
      params: Promise.resolve({ id: r.id }),
    });
    const body = await res.json();
    expect(body.started).toBe(true);
  });
});