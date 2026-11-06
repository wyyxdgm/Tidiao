// tasks.awaiting_reason (v129 / R112 续) 回归测试.
//
// 关注点:
//   - 列存在且默认 NULL: 新建 task 不显式传 awaiting_reason → DB 字段 NULL.
//   - updateTaskStatus 接受 awaiting_reason: null = 显式清空, undefined = 跳过不动.
//     与 awaiting_markers 同口径 (R112 续同款语义契约, 防回归).
//   - listTasksPage SELECT 派生字段: 4 视图基础数据源带回 awaiting_reason,
//     NULL 也能正确带回 (向后兼容老 task).
//   - 自由字符串: 不锁枚举. design_pending / deploy_pending / 自定义字符串都允许写入.
//   - updateTask 接受 awaiting_reason: PATCH /api/tasks/[id] 透传路径.
//   - COUNT 不受影响 (awaiting_reason 不在 WHERE 子句, 同 R94 / R109 口径).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getDb, closeDb } from "./index";
import { createProject } from "./projects";
import { createTask, updateTaskStatus, updateTask, listTasksPage } from "./tasks";

let tmpDir: string;
let ownerId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-awaiting-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  closeDb();
  getDb();

  ownerId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(ownerId, `${ownerId}@example.com`, "x", "user");
  projectId = createProject({ name: "awaiting-reason-proj", ownerId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tasks.awaiting_reason (v129, R112 续)", () => {
  it("新建 task 不传 awaiting_reason → DB 字段 = NULL (向后兼容)", () => {
    const t = createTask({ title: "no-reason", prompt: "x", project_id: projectId });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.awaiting_reason).toBeNull();
  });

  it("updateTaskStatus 接受 awaiting_reason: 写入 + 回读正确", () => {
    const t = createTask({ title: "with-reason", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { awaiting_reason: "design_pending" });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.awaiting_reason).toBe("design_pending");
    expect(row?.status).toBe("reviewing");
  });

  it("updateTaskStatus awaiting_reason=null = 显式清空 (覆盖旧值)", () => {
    const t = createTask({ title: "clear-reason", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { awaiting_reason: "deploy_pending" });
    updateTaskStatus(t.id, "reviewing", { awaiting_reason: null });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.awaiting_reason).toBeNull();
  });

  it("updateTaskStatus 不传 awaiting_reason = 跳过不动", () => {
    const t = createTask({ title: "no-touch", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { awaiting_reason: "design_pending" });
    // 后续 updateTaskStatus 不带 awaiting_reason → 旧值保留
    updateTaskStatus(t.id, "reviewing", { awaiting_owner_review: 1 });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.awaiting_reason).toBe("design_pending");
    expect(row?.awaiting_owner_review).toBe(1);
  });

  it("自由字符串写入 (damo 第 3 tag 自定义) — 不锁枚举", () => {
    const t = createTask({ title: "custom-tag", prompt: "x", project_id: projectId });
    updateTaskStatus(t.id, "reviewing", { awaiting_reason: "待测试_abc123" });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.awaiting_reason).toBe("待测试_abc123");
  });

  it("updateTask (PATCH API 透传路径) 接受 awaiting_reason", () => {
    const t = createTask({ title: "patch-path", prompt: "x", project_id: projectId });
    const updated = updateTask(t.id, { awaiting_reason: "deploy_pending" });
    expect(updated?.awaiting_reason).toBe("deploy_pending");
    // 二次 PATCH 清空
    updateTask(t.id, { awaiting_reason: null });
    const { items } = listTasksPage({ statusGroup: "all", ownerId });
    const row = items.find((x) => x.id === t.id);
    expect(row?.awaiting_reason).toBeNull();
  });

  it("COUNT 不受 awaiting_reason 影响 (不在 WHERE 子句)", () => {
    const t1 = createTask({ title: "a", prompt: "x", project_id: projectId });
    const t2 = createTask({ title: "b", prompt: "x", project_id: projectId });
    const t3 = createTask({ title: "c", prompt: "x", project_id: projectId });
    updateTaskStatus(t1.id, "reviewing", { awaiting_reason: "design_pending" });
    updateTaskStatus(t2.id, "reviewing", { awaiting_reason: "deploy_pending" });
    updateTaskStatus(t3.id, "reviewing", { awaiting_reason: "待测试" });
    const { total } = listTasksPage({ statusGroup: "all", ownerId });
    expect(total).toBe(3);
  });
});