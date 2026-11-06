// POST /api/tasks/[id]/resolve-decision — R127 §3.3 方案 A
//   关键路径: 200 成功 + 200 全 resolved → unset awaiting_owner_review /
//   400 selected_label 不在 options / 404 decision_id 不在 pending_decisions /
//   409 already resolved / 409 task 非 reviewing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById, mutateTaskMetadata, updateTaskStatus } from "@/lib/db/tasks";
import { createUser } from "@/lib/db/users";

const unsetAwaitingOwnerReviewMock = vi.fn(() => ({
  ok: true as const,
  awaiting_owner_review: 0 as const,
  awaiting_markers: null,
}));

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    unsetAwaitingOwnerReview: unsetAwaitingOwnerReviewMock,
  }),
}));

let tmpDir: string;
let userId: string;
let otherUserId: string;
let taskId: string;
let otherTaskId: string;
let decisionId: string;

beforeEach(async () => {
  unsetAwaitingOwnerReviewMock.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-resolve-decision-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  delete process.env.ORCHESTRATOR_TASK_ID;
  closeDb();
  getDb();

  const owner = await createUser(`owner-${Date.now()}@example.com`, "pw");
  userId = owner.id;
  const other = await createUser(`other-${Date.now()}@example.com`, "pw");
  otherUserId = other.id;

  const proj = createProject({ name: "p", ownerId: userId });
  const otherProj = createProject({ name: "op", ownerId: otherUserId });
  taskId = createTask({ title: "T", prompt: "p", project_id: proj.id }).id;
  otherTaskId = createTask({ title: "TO", prompt: "p", project_id: otherProj.id }).id;

  // Seed reviewing task + awaiting_owner_review=1 + pending_decisions map.
  decisionId = uuidv4();
  updateTaskStatus(taskId, "reviewing", { awaiting_owner_review: 1 });
  mutateTaskMetadata(taskId, (meta) => {
    meta.pending_decisions = {
      [decisionId]: {
        question: "实现 A 还是 B?",
        options: [
          { label: "A", description: "最小修复" },
          { label: "B", description: "完整重构" },
        ],
        recommended: "B",
        recommended_reason: "B 兼容现有调用方",
        emitted_at: "2026-09-02T00:00:00.000Z",
        resolved_at: null,
        resolved_label: null,
      },
    };
    return true;
  });
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeReq(taskIdArg: string, userIdArg: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${taskIdArg}/resolve-decision`, {
    method: "POST",
    headers: { "x-user-id": userIdArg, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 动态 import 路由, 让 vi.mock("agent-runtime") 先生效
async function POST(req: NextRequest) {
  const mod = await import("./route");
  return mod.POST(req, { params: Promise.resolve({ id: (req as any)._id || "" }) });
}

describe("POST /api/tasks/[id]/resolve-decision: R127 §3.3", () => {
  it("200: 决策成功落库 + decision_resolved event 写入", async () => {
    const req = makeReq(taskId, userId, { decision_id: decisionId, selected_label: "A" });
    // 兼容 Next.js 动态路由参数
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.selected_label).toBe("A");
    expect(typeof json.resolved_at).toBe("string");

    // 校验 metadata 写入
    const t = getTaskById(taskId)!;
    const meta = JSON.parse(t.metadata!);
    const dec = meta.pending_decisions[decisionId];
    expect(dec.resolved_label).toBe("A");
    expect(dec.resolved_at).toBe(json.resolved_at);

    // 校验 event
    const { getEventsByTaskId } = await import("@/lib/db/events");
    const events = getEventsByTaskId(taskId);
    const decEv = events.find((e) => e.type === "decision_resolved");
    expect(decEv).toBeDefined();
    const decData = JSON.parse(decEv!.data);
    expect(decData.decision_id).toBe(decisionId);
    expect(decData.selected_label).toBe("A");
    expect(decData.by_user_id).toBe(userId);

    // 单 decision 全部 resolved → 应 unset awaiting_owner_review
    expect(json.all_resolved).toBe(true);
    expect(unsetAwaitingOwnerReviewMock).toHaveBeenCalledWith(taskId);
  });

  it("200 + all_resolved=true → unset awaiting_owner_review", async () => {
    // 只剩 1 个 decision, 这次 resolve 完应该触发 unset
    const req = makeReq(taskId, userId, { decision_id: decisionId, selected_label: "B" });
    (req as any)._id = taskId;
    const res = await POST(req);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.all_resolved).toBe(true);
    expect(unsetAwaitingOwnerReviewMock).toHaveBeenCalledWith(taskId);
  });

  it("200 + 多 decision 中只 resolved 一个 → all_resolved=false, 不 unset", async () => {
    // 加一个未 resolved 的 decision
    const secondId = uuidv4();
    mutateTaskMetadata(taskId, (meta) => {
      (meta.pending_decisions as Record<string, unknown>)[secondId] = {
        question: "选 C 还是 D?",
        options: [
          { label: "C", description: "x" },
          { label: "D", description: "y" },
        ],
        recommended: "D",
        recommended_reason: null,
        emitted_at: "2026-09-02T00:00:00.000Z",
        resolved_at: null,
        resolved_label: null,
      };
      return true;
    });

    const req = makeReq(taskId, userId, { decision_id: decisionId, selected_label: "A" });
    (req as any)._id = taskId;
    const res = await POST(req);
    const json = await res.json();
    expect(json.all_resolved).toBe(false);
    expect(unsetAwaitingOwnerReviewMock).not.toHaveBeenCalled();
  });

  it("400: selected_label 不在 options 中", async () => {
    const req = makeReq(taskId, userId, { decision_id: decisionId, selected_label: "Z" });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/selected_label/);
    expect(json.options).toEqual(["A", "B"]);
  });

  it("400: decision_id 不是 UUID", async () => {
    const req = makeReq(taskId, userId, { decision_id: "not-uuid", selected_label: "A" });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("400: body 缺字段", async () => {
    const req = makeReq(taskId, userId, { decision_id: decisionId });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("401: 无 x-user-id header", async () => {
    const req = new NextRequest(`http://localhost/api/tasks/${taskId}/resolve-decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision_id: decisionId, selected_label: "A" }),
    });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("404: decision_id 不在 pending_decisions", async () => {
    const req = makeReq(taskId, userId, { decision_id: uuidv4(), selected_label: "A" });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("404: task 跨 owner 不可见", async () => {
    // otherUser 试图操作 taskId → 应 404 (getTaskById 第二个参数过滤 owner)
    const req = makeReq(taskId, otherUserId, { decision_id: decisionId, selected_label: "A" });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("409: task 非 reviewing 状态", async () => {
    updateTaskStatus(taskId, "completed");
    const req = makeReq(taskId, userId, { decision_id: decisionId, selected_label: "A" });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/reviewing/);
  });

  it("409: decision 已被 resolve", async () => {
    // 先手动 resolved_at 一次
    mutateTaskMetadata(taskId, (meta) => {
      (meta.pending_decisions as Record<string, unknown>)[decisionId].resolved_at = "2026-09-01T00:00:00.000Z";
      (meta.pending_decisions as Record<string, unknown>)[decisionId].resolved_label = "A";
      return true;
    });
    const req = makeReq(taskId, userId, { decision_id: decisionId, selected_label: "B" });
    (req as any)._id = taskId;
    const res = await POST(req);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.resolved_label).toBe("A");
  });

  it("404: task 上无 pending_decisions (老数据兼容)", async () => {
    updateTaskStatus(otherTaskId, "reviewing");
    const req = makeReq(otherTaskId, otherUserId, { decision_id: uuidv4(), selected_label: "A" });
    (req as any)._id = otherTaskId;
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/No pending_decisions/);
  });
});
