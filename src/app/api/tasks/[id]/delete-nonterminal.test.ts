// DELETE /api/tasks/[id] 对非终态 (pending/queued) 任务的回归测试.
//
// 2026-09-29 R164 追加需求 (damo): 派发洪水 (crazygames 一次 tick 喷 20+ 任务)
// 止血场景下, SPA 任务列表给 pending/queued 加了「删除」按钮. 前提是后端
// DELETE 对非终态本来就放行 (handler 只查 ownership + 重复删 409, 无状态
// 白名单), 且 queued 软删后调度器 schedule() 出队 `!task -> continue` 自然
// 跳过 (task-scheduler.ts:425) — 不会把已删任务跑起来.
//
// 本文件钉住三条不变量:
//  1. queued / pending 状态 DELETE 均成功 (软删, 不翻 status)
//  2. 已删任务重复 DELETE 409 (includeDeleted 查询防存在性泄露)
//  3. cancel 端点对 queued 成功 (SPA「先 cancel 再删」链路的后端侧)
//
// 脚手架与 depends-on-ids.test.ts / detail-favorite.test.ts 同款:
// 真 tmp SQLite + vi.mock 桩化 runtime, 不拉 SDK.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createTask, getTaskById } from "@/lib/db/tasks";

vi.mock("@/lib/runtime/agent-runtime", () => ({
  getRuntime: () => ({
    cancelTask: vi.fn().mockResolvedValue(undefined),
    emitEvent: () => {},
  }),
}));

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-delete-nonterminal-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "delete-nonterminal-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function delTask(id: string) {
  const { DELETE } = await import("@/app/api/tasks/[id]/route");
  const req = new NextRequest(`http://localhost/api/tasks/${id}`, {
    method: "DELETE",
    headers: { "x-user-id": ownerId },
  });
  const res = await DELETE(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

async function cancelTask(id: string) {
  const { POST } = await import("@/app/api/tasks/[id]/cancel/route");
  const req = new NextRequest(`http://localhost/api/tasks/${id}/cancel`, {
    method: "POST",
    headers: { "x-user-id": ownerId },
  });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

function makeTask(): string {
  return createTask({ title: "t", prompt: "p", project_id: projectId }).id;
}

function setStatus(id: string, status: string): void {
  getDb().prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id);
}

describe("DELETE /api/tasks/[id] 对非终态任务", () => {
  it("queued 状态 DELETE 成功: 软删, status 不翻", async () => {
    const id = makeTask();
    setStatus(id, "queued");
    const res = await delTask(id);
    expect(res.status).toBe(200);
    const row = getTaskById(id, ownerId, { includeDeleted: true });
    expect(row?.deleted_at).not.toBeNull();
    // 软删不翻 status — schedule() 出队靠 getTaskById 默认过滤 deleted_at 跳过,
    // 前端「先 cancel 再删」负责把 status 归到 cancelled (见 SPA confirmDeleteTask).
    expect(row?.status).toBe("queued");
  });

  it("pending 状态 DELETE 成功", async () => {
    const id = makeTask();
    expect(getTaskById(id, ownerId)?.status).toBe("pending");
    const res = await delTask(id);
    expect(res.status).toBe(200);
    expect(getTaskById(id, ownerId, { includeDeleted: true })?.deleted_at).not.toBeNull();
  });

  it("已删任务重复 DELETE 409 (防存在性泄露: 非本人也 404)", async () => {
    const id = makeTask();
    expect((await delTask(id)).status).toBe(200);
    expect((await delTask(id)).status).toBe(409);
  });

  it("cancel 端点对 queued 任务成功 (先 cancel 再删链路的后端侧)", async () => {
    const id = makeTask();
    setStatus(id, "queued");
    const res = await cancelTask(id);
    // route 层契约: ownership 过了就 200 + status:'cancelled'. 真实状态翻转在
    // runtime cancelTask 内 (这里已 mock 桩化), 由 agent-runtime 自身测试覆盖.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });
});
