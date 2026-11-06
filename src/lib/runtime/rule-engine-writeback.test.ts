// Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): rule-engine 真拦截点测试.
// task 挂的 role feishu_writeback=0 → tryWriteBackFeishu 不被调, events 留痕
// skipped:feishu_writeback_skipped_by_role; role=1 / task 无 role / role 已删
// (查不到) → 放行, 行为与 P4 之前完全一致.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";

vi.mock("../feishu/write-back", () => ({
  tryWriteBackFeishu: vi.fn(async () => true),
}));

import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createRole } from "../db/roles";
import { createTask, getTaskById } from "../db/tasks";
import { createRule } from "../db/rules";
import { runRules } from "./rule-engine";
import { tryWriteBackFeishu } from "../feishu/write-back";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-rule-engine-wb-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "wb-test", ownerId }).id;

  vi.mocked(tryWriteBackFeishu).mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.mocked(tryWriteBackFeishu).mockClear();
});

function makeTaskWithRole(feishuWriteback?: 0 | 1, roleOpts?: { ghostPointer?: boolean }) {
  const roleId = feishuWriteback === undefined
    ? null
    : createRole({
        name: `wb-${feishuWriteback}-${uuidv4().slice(0, 8)}`,
        system_prompt: "x",
        ownerId,
        feishuWriteback,
      }).id;
  const task = createTask({
    title: "wb-task",
    prompt: "work",
    project_id: projectId,
    role_id: roleId ?? undefined,
  });
  // createTask 校验 role 存在, tasks.role_id 又有 FK (v10) 挡删 role —— 真实数据里
  // 「查不到」只会以孤儿指针形态出现 (FK 未开的库 / migration 重建丢失). 用短暂
  // 关 FK 改写指针构造同一防御分支, 不动 roles 行.
  if (roleOpts?.ghostPointer) {
    const db = getDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE tasks SET role_id = ? WHERE id = ?`).run(uuidv4(), task.id);
    db.pragma("foreign_keys = ON");
  }
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(ownerId, task.id);
  return task;
}

function makeWriteBackRule() {
  return createRule({
    name: "wb-on-complete",
    from_status: "running",
    to_status: "completed",
    action_type: "write_back_feishu",
  });
}

function eventsFor(taskId: string) {
  return getDb().prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY id`).all(taskId) as Array<{
    type: string;
    data: string;
  }>;
}

describe("rule-engine write_back_feishu: role 开关拦截 (P4 D4)", () => {
  it("role feishu_writeback=0 → 不调 tryWriteBackFeishu, events 留痕 skipped", async () => {
    const task = makeTaskWithRole(0);
    makeWriteBackRule();

    await runRules({ taskId: task.id, from: "running", to: "completed" });

    expect(tryWriteBackFeishu).not.toHaveBeenCalled();
    const ev = eventsFor(task.id).find((e) => e.data.includes("feishu_writeback_skipped_by_role"));
    expect(ev).toBeDefined();
    expect(ev!.type).toBe("rule_fired");
    const data = JSON.parse(ev!.data);
    expect(data.result).toBe("skipped:feishu_writeback_skipped_by_role");
    expect(data.action_type).toBe("write_back_feishu");
  });

  it("role feishu_writeback=1 → 放行, 正常调 tryWriteBackFeishu", async () => {
    const task = makeTaskWithRole(1);
    makeWriteBackRule();

    await runRules({ taskId: task.id, from: "running", to: "completed" });

    expect(tryWriteBackFeishu).toHaveBeenCalledTimes(1);
    expect(tryWriteBackFeishu).toHaveBeenCalledWith(task.id, ownerId);
    expect(eventsFor(task.id).some((e) => e.data.includes("feishu_writeback_skipped_by_role"))).toBe(false);
  });

  it("task 无 role (role_id NULL) → 放行, 行为不变", async () => {
    const task = makeTaskWithRole(undefined);
    makeWriteBackRule();

    await runRules({ taskId: task.id, from: "running", to: "completed" });

    expect(tryWriteBackFeishu).toHaveBeenCalledTimes(1);
  });

  it("role_id 指向已删 role (查不到) → 放行, 行为不变", async () => {
    const task = makeTaskWithRole(0, { ghostPointer: true });
    expect(getTaskById(task.id)!.role_id).not.toBeNull();
    makeWriteBackRule();

    await runRules({ taskId: task.id, from: "running", to: "completed" });

    expect(tryWriteBackFeishu).toHaveBeenCalledTimes(1);
  });
});
