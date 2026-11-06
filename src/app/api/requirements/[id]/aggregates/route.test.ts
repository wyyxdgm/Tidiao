// GET /api/requirements/[id]/aggregates - 路由层测试 (R142 G4).
//
// 覆盖:
//   - 未登录 -> 401
//   - 跨 owner -> 404 (no existence leak)
//   - requirement 不存在 -> 404
//   - 0 task: task_count=0, completion_pct=0, latest_feedback=null
//   - 部分完成: task_count + completion_pct (0..100 整数, 四舍五入)
//   - 已有 status/description revision: latest_feedback = MAX(revisions.created_at)
//     priority / tags 字段变更不算「反馈」
//
// 关注点:
//   - 不拉 SDK (vi.mock 桩化, 与 requirements/[id]/tasks/route.test.ts 同模式).
//   - 直接 INSERT tasks + revision_revisions 灌数据, 复用 createRequirement.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createRequirement } from "@/lib/db/requirements";
import { GET } from "./route";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    createTask: () => {
      throw new Error("createTask not used in GET /api/requirements/[id]/aggregates");
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
  requirementIdLocal: string,
  status: string,
  type: string | null = "dev"
): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, status, owner_id, project_id, requirement_id, depends_on, prompt, type)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '', ?)`
    )
    .run(id, `t-${id.slice(0, 4)}`, status, ownerId, projectA, requirementIdLocal, type);
}

function insertRevision(
  requirementIdLocal: string,
  field: string,
  createdAt: string
): void {
  // actor_id 用 ownerA (测试不强校验), revision value 留默认占位.
  getDb()
    .prepare(
      `INSERT INTO requirement_revisions (requirement_id, field, old_value, new_value, actor_id, actor_type, created_at)
       VALUES (?, ?, NULL, 'old', ?, 'user', ?)`
    )
    .run(requirementIdLocal, field, ownerA, createdAt);
}

function makeReq(rid: string, headers: Record<string, string>) {
  return new NextRequest(
    `http://localhost/api/requirements/${rid}/aggregates`,
    { method: "GET", headers }
  );
}

async function callGET(req: NextRequest) {
  const { id } = { id: req.url.split("/").slice(-2, -1)[0] };
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-req-aggregates-"));
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

  projectA = uuidv4();
  getDb()
    .prepare(`INSERT INTO projects (id, name, owner_id) VALUES (?, ?, ?)`)
    .run(projectA, "agg-proj", ownerA);

  const r = createRequirement(projectA, { title: "agg-test" }, ownerA);
  requirementId = r.id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("R142 G4: GET /api/requirements/[id]/aggregates", () => {
  it("未登录 -> 401", async () => {
    const res = await callGET(makeReq(requirementId, {}));
    expect(res.status).toBe(401);
  });

  it("requirement 不存在 -> 404", async () => {
    const res = await callGET(makeReq(uuidv4(), { "x-user-id": ownerA }));
    expect(res.status).toBe(404);
  });

  it("跨 owner (ownerB 看 ownerA requirement) -> 404", async () => {
    const res = await callGET(makeReq(requirementId, { "x-user-id": ownerB }));
    expect(res.status).toBe(404);
  });

  it("0 task → task_count=0, completion_pct=0, latest_feedback=null", async () => {
    const res = await callGET(makeReq(requirementId, { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      task_count: 0,
      completion_pct: 0,
      latest_feedback: null,
    });
  });

  it("部分完成: 2/4 completed → task_count=4, completion_pct=50", async () => {
    insertTask(uuidv4(), ownerA, requirementId, "completed");
    insertTask(uuidv4(), ownerA, requirementId, "completed");
    insertTask(uuidv4(), ownerA, requirementId, "queued");
    insertTask(uuidv4(), ownerA, requirementId, "running");

    const res = await callGET(makeReq(requirementId, { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_count).toBe(4);
    expect(body.completion_pct).toBe(50);
    // 没 revision 时 latest_feedback=null
    expect(body.latest_feedback).toBeNull();
  });

  it("completion_pct 四舍五入: 1/3 = 33, 2/3 = 67", async () => {
    insertTask(uuidv4(), ownerA, requirementId, "completed");
    insertTask(uuidv4(), ownerA, requirementId, "queued");
    insertTask(uuidv4(), ownerA, requirementId, "queued");

    const res = await callGET(makeReq(requirementId, { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_count).toBe(3);
    expect(body.completion_pct).toBe(33); // 1/3 = 0.333... → 33

    // 补一个 completed → 2/3 = 0.666... → 67
    insertTask(uuidv4(), ownerA, requirementId, "completed");
    const res2 = await callGET(makeReq(requirementId, { "x-user-id": ownerA }));
    const body2 = await res2.json();
    expect(body2.task_count).toBe(4);
    expect(body2.completion_pct).toBe(50);
  });

  it("latest_feedback 只看 status/description 字段的 revision", async () => {
    insertTask(uuidv4(), ownerA, requirementId, "completed");

    insertRevision(requirementId, "status", "2026-09-20 10:00:00");
    insertRevision(requirementId, "description", "2026-09-22 10:00:00");
    insertRevision(requirementId, "priority", "2026-09-25 10:00:00"); // 不算「反馈」
    insertRevision(requirementId, "tags", "2026-09-26 10:00:00");       // 不算「反馈」

    const res = await callGET(makeReq(requirementId, { "x-user-id": ownerA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // MAX 应该取 description (2026-09-22), priority/tags 时间后但不算反馈
    expect(body.latest_feedback).toBe("2026-09-22 10:00:00");
  });

  it("全 completed: completion_pct=100", async () => {
    insertTask(uuidv4(), ownerA, requirementId, "completed");
    insertTask(uuidv4(), ownerA, requirementId, "completed");
    insertTask(uuidv4(), ownerA, requirementId, "completed");

    const res = await callGET(makeReq(requirementId, { "x-user-id": ownerA }));
    const body = await res.json();
    expect(body.task_count).toBe(3);
    expect(body.completion_pct).toBe(100);
  });
});
