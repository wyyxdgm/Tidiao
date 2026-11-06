// Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): runtime 软约束注入测试.
// task 挂的 role feishu_writeback=0 → roleWritebackReminder 返回「本角色不回写」
// system-reminder (拼 head, 每 task 会话注入一次); =1 / 无 role / role 查不到
// → null (不注入, 行为不变).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { ActiveSession } from "./active-session";
import { getDb, closeDb } from "../db";
import { createProject } from "../db/projects";
import { createRole } from "../db/roles";
import { createTask, getTaskById } from "../db/tasks";
import { upsertLlmConfig } from "../db/llm-configs";
import type { Task } from "./types";

let tmpDir: string;
let userId: string;
let projectId: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-role-wb-reminder-"));
  process.env.ORCHESTRATOR_DB_PATH = path.join(tmpDir, "test.db");
  process.env.ORCHESTRATOR_HOME = tmpDir;
  closeDb();
  getDb();

  userId = uuidv4();
  getDb()
    .prepare(`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(userId, `${userId}@example.com`, "x", "admin");
  // 构造 ActiveSession 会调 resolveLlmConfig, 没 key 会抛 — stub 一个.
  upsertLlmConfig("user", userId, { api_key: "sk-test-key" });
  projectId = createProject({ name: "wb-reminder-test", ownerId: userId }).id;
});

afterEach(() => {
  closeDb();
  delete process.env.ORCHESTRATOR_DB_PATH;
  delete process.env.ORCHESTRATOR_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(feishuWriteback?: 0 | 1): { task: Task; roleId: string | null } {
  const roleId =
    feishuWriteback === undefined
      ? null
      : createRole({
          name: `wb-${feishuWriteback}-${uuidv4().slice(0, 8)}`,
          system_prompt: "x",
          ownerId: userId,
          feishuWriteback,
        }).id;
  const created = createTask({
    title: "reminder-task",
    prompt: "work",
    project_id: projectId,
    role_id: roleId ?? undefined,
  });
  getDb().prepare(`UPDATE tasks SET owner_id = ? WHERE id = ?`).run(userId, created.id);
  return { task: getTaskById(created.id)!, roleId };
}

// 私有方法, 测试需要触达 (同 canUseTool 先例)
function reminderFor(task: Task): string | null {
  const session = new ActiveSession(task);
  // @ts-expect-error private, 测试需要触达
  return session.roleWritebackReminder(task);
}

describe("roleWritebackReminder: feishu_writeback=0 软约束注入 (P4 D4)", () => {
  it("role feishu_writeback=0 → 返回 system-reminder, 含「不回写飞书」明示", () => {
    const { task } = makeTask(0);
    const reminder = reminderFor(task);
    expect(reminder).not.toBeNull();
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("本角色已关闭飞书回写");
    expect(reminder).toContain("feishu_writeback=0");
  });

  it("role feishu_writeback=1 → null (不注入)", () => {
    const { task } = makeTask(1);
    expect(reminderFor(task)).toBeNull();
  });

  it("task 无 role (role_id NULL) → null (行为不变)", () => {
    const { task } = makeTask(undefined);
    expect(reminderFor(task)).toBeNull();
  });

  it("role_id 指向查不到的 role → null (防御放行)", () => {
    const { task } = makeTask(0);
    const db = getDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE tasks SET role_id = ? WHERE id = ?`).run(uuidv4(), task.id);
    db.pragma("foreign_keys = ON");
    expect(reminderFor(getTaskById(task.id)!)).toBeNull();
  });
});
