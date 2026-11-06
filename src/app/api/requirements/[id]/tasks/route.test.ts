// GET /api/requirements/[id]/tasks - 森林 API 路由层测试 (R78 W4 §4.1 场景 8).
//
// 覆盖:
//   - with_deps=true 返回正确 edges (1 层直接依赖, from depends on to).
//   - with_deps=false 不返回 edges.
//   - 跨 owner GET requirement → 404 (no existence leak, 与 route.test.ts 一致).
//   - 跨 owner 但 requirement 是别人的: 走到 DB 层 getRequirementById 兜底 → 404.
//
// 关注点:
//   - 不拉 SDK (vi.mock 桩化, 与 [id]/route.test.ts 同模式).
//   - 直接用 INSERT tasks 跳过 createTask 避免拉 SDK (森林 API 只需要 task 行存在).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createRequirement } from "@/lib/db/requirements";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: () => {
      throw new Error("createTask not used in GET /api/requirements/[id]/tasks");
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
let projectA: string;
let requirementId: string;

function insertTask(
  id: string,
  ownerId: string,
  projectId: string,
  requirementIdLocal: string,
  deps: string[],
  type: string | null = "dev",
  status: string = "completed",
  createdAtOffset = 0
) {
  // 写一个明确的时间戳, 让 created_at 排序可控 (森林测试需要 root 区分).
  const baseTs = new Date("2026-09-04T00:00:00Z").getTime();
  const ts = new Date(baseTs + createdAtOffset * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, `t-${id.slice(0, 4)}`, status, ownerId, projectId, requirementIdLocal, JSON.stringify(deps), "", type, ts);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-req-forest-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerA = uuidv4();
  ownerB = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerA, `${ownerA}@example.com`, "x", "user");
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerB, `${ownerB}@example.com`, "x", "user");

  projectA = uuidv4();
  getDb()
    .prepare(`INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)`)
    .run(projectA, "forest-proj", ownerA);

  const r = createRequirement(projectA, { title: "forest" }, ownerA);
  requirementId = r.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeReq(qs: string, uid = ownerA) {
  return new NextRequest(`http://localhost/api/requirements/${requirementId}/tasks${qs}`, {
    method: "GET",
    headers: { "x-user-id": uid },
  });
}

async function loadGET() {
  return (await import("./route")).GET;
}

// Next.js 路由签名: handler(request, { params: Promise<{id}> }).
// 所有调用统一通过这个 helper 注入.
async function callGET(req: NextRequest) {
  const GET = await loadGET();
  return GET(req, { params: Promise.resolve({ id: requirementId }) });
}

// ---- 森林 API edges 正确性 ----

describe("R78 W4: GET /api/requirements/[id]/tasks 森林 edges 正确性", () => {
  it("with_deps=true 返回 edges: from depends on to (1 层直接依赖)", async () => {
    // 构造: root A → B → C (B 依赖 A, C 依赖 B).
    const A = uuidv4();
    const B = uuidv4();
    const C = uuidv4();
    insertTask(A, ownerA, projectA, requirementId, [], "dev", "completed", 0);
    insertTask(B, ownerA, projectA, requirementId, [A], "dev", "completed", 1);
    insertTask(C, ownerA, projectA, requirementId, [B], "dev", "completed", 2);

    const res = await callGET(makeReq("?with_deps=true"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.requirement_id).toBe(requirementId);
    expect(body.tasks.map((t: any) => t.id)).toEqual([A, B, C]);
    expect(body.tasks[0].dispatched_by_task_id).toBeNull(); // root
    // edges: B→A, C→B (from depends on to)
    expect(body.edges).toEqual(
      expect.arrayContaining([
        { from: B, to: A },
        { from: C, to: B },
      ])
    );
    expect(body.edges).toHaveLength(2);
  });

  it("with_deps=false 不返回 edges (默认行为)", async () => {
    const A = uuidv4();
    const B = uuidv4();
    insertTask(A, ownerA, projectA, requirementId, [], "dev", "completed", 0);
    insertTask(B, ownerA, projectA, requirementId, [A], "dev", "completed", 1);

    const res = await callGET(makeReq(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(2);
    expect(body.edges).toEqual([]);
  });

  it("无 task 时返回空 tasks + 空 edges (requirement 本身存在)", async () => {
    const res = await callGET(makeReq("?with_deps=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toEqual([]);
    expect(body.edges).toEqual([]);
  });

  it("depends_on 含非法 JSON → 当成空 deps, 不抛错", async () => {
    const A = uuidv4();
    // 直接塞坏 JSON 进 depends_on.
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
         VALUES (?, 'broken', 'completed', ?, ?, ?, 'not-json', '', 'dev')`
      )
      .run(A, ownerA, projectA, requirementId);

    const res = await callGET(makeReq("?with_deps=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks[0].depends_on).toEqual([]);
    expect(body.edges).toEqual([]);
  });
});

// ---- 跨 owner 404 ----

describe("R78 W4: 森林 API 跨 owner 404", () => {
  it("ownerB GET ownerA 的 forest → 404", async () => {
    const res = await callGET(makeReq("?with_deps=true", ownerB));
    expect(res.status).toBe(404);
  });
});