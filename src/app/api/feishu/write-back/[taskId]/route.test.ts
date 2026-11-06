// Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): UI 手动回写 API 的
// role 开关校验测试 —— feishu_writeback=0 → 403 ROLE_WRITEBACK_DISABLED;
// =1 / 无 role → 放行 (走 writeBackFeishu, mock 防真调飞书).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { NextRequest } from "next/server";

vi.mock("@/lib/feishu/write-back", () => ({
  writeBackFeishu: vi.fn(async () => ({
    ok: true,
    row: 2,
    wrote: 1,
    total: 1,
    results: [{ field: "M", ok: true, value: "x" }],
  })),
}));

import { getDb, closeDb } from "@/lib/db/index";
import { createProject } from "@/lib/db/projects";
import { createRole } from "@/lib/db/roles";
import { createTask } from "@/lib/db/tasks";
import { writeBackFeishu } from "@/lib/feishu/write-back";
import { POST } from "./route";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wb-route-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "user");
  projectId = createProject({ name: "wb-route-test", ownerId: userId }).id;
  vi.mocked(writeBackFeishu).mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.mocked(writeBackFeishu).mockClear();
});

function makeTaskWithRole(feishuWriteback?: 0 | 1): string {
  const roleId =
    feishuWriteback === undefined
      ? undefined
      : createRole({
          name: `wb-${feishuWriteback}-${uuidv4().slice(0, 8)}`,
          system_prompt: "x",
          ownerId: userId,
          feishuWriteback,
        }).id;
  const task = createTask({
    title: "wb-route-task",
    prompt: "work",
    project_id: projectId,
    role_id: roleId,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, task.id);
  return task.id;
}

function post(taskId: string) {
  return POST(
    new NextRequest(`http://localhost/api/feishu/write-back/${taskId}`, {
      method: "POST",
      headers: { "x-user-id": userId },
    }),
    { params: Promise.resolve({ taskId }) },
  );
}

describe("POST /api/feishu/write-back/[taskId]: role 开关 403 (P4 D4)", () => {
  it("role feishu_writeback=0 → 403 ROLE_WRITEBACK_DISABLED, 不触达 writeBackFeishu", async () => {
    const taskId = makeTaskWithRole(0);

    const res = await post(taskId);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("ROLE_WRITEBACK_DISABLED");
    expect(writeBackFeishu).not.toHaveBeenCalled();
  });

  it("role feishu_writeback=1 → 放行, 正常回写", async () => {
    const taskId = makeTaskWithRole(1);

    const res = await post(taskId);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(writeBackFeishu).toHaveBeenCalledTimes(1);
  });

  it("task 无 role (role_id NULL) → 放行, 行为不变", async () => {
    const taskId = makeTaskWithRole(undefined);

    const res = await post(taskId);

    expect(res.status).toBe(200);
    expect(writeBackFeishu).toHaveBeenCalledTimes(1);
  });
});
