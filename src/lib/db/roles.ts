// Roles CRUD — workflow.md §9 v1 (lightweight):
// reusable config bundle (system_prompt + defaults). Inherits into task on creation.

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";

export interface Role {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model: string | null;
  allowed_tools: string | null;
  effort: string | null;
  max_turns: number | null;
  memory_doc: string | null;
  owner_id: string | null; // FK users.id (T3); NULL = pre-auth legacy row
  project_id: string | null; // FK projects.id (v525); NULL = global role
  feishu_writeback: number; // v527 (P4 D4): 1=允许回写 (默认), 0=禁止 (行为开关, 非安全边界)
  created_at: string;
  updated_at: string;
}

export interface RoleInput {
  name: string;
  description?: string;
  system_prompt: string;
  model?: string;
  allowed_tools?: string[];
  effort?: string;
  max_turns?: number;
  memory_doc?: string;
  ownerId?: string; // from session (x-user-id); API routes always set this
  projectId?: string | null; // v525: omit/null = global; string = project-scoped
  feishuWriteback?: number; // v527: omit = 1 (allow); 0 = disable
}

function row(r: any): Role {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    system_prompt: r.system_prompt,
    model: r.model,
    allowed_tools: r.allowed_tools,
    effort: r.effort,
    max_turns: r.max_turns,
    memory_doc: r.memory_doc,
    owner_id: r.owner_id,
    project_id: r.project_id ?? null,
    // 防御: 理论上 NOT NULL DEFAULT 1 不会回 null, 老快照/手工库兜底视为 1
    feishu_writeback: r.feishu_writeback ?? 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createRole(input: RoleInput): Role {
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    `INSERT INTO roles (id, name, description, system_prompt, model, allowed_tools, effort, max_turns, memory_doc, owner_id, project_id, feishu_writeback)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.description ?? null,
    input.system_prompt,
    input.model ?? null,
    input.allowed_tools ? JSON.stringify(input.allowed_tools) : null,
    input.effort ?? null,
    input.max_turns ?? null,
    input.memory_doc ?? null,
    input.ownerId ?? null,
    input.projectId || null, // '' normalizes to NULL (global)
    input.feishuWriteback === 0 ? 0 : 1 // 非 0 一律归 1, 防脏值
  );
  return getRoleById(id)!;
}

// userId is optional: API routes pass it to enforce ownership (non-owner gets
// null -> 404); internal callers (createTask role inheritance) may pass the
// project owner so a task can't reference another user's role.
export function getRoleById(id: string, userId?: string): Role | null {
  const db = getDb();
  const r = userId
    ? db.prepare("SELECT * FROM roles WHERE id = ? AND owner_id = ?").get(id, userId)
    : db.prepare("SELECT * FROM roles WHERE id = ?").get(id);
  return r ? row(r) : null;
}

export function getRoleByName(name: string, userId?: string): Role | null {
  const db = getDb();
  const r = userId
    ? db.prepare("SELECT * FROM roles WHERE name = ? AND owner_id = ?").get(name, userId)
    : db.prepare("SELECT * FROM roles WHERE name = ?").get(name);
  return r ? row(r) : null;
}

export function listRoles(userId?: string): Role[] {
  const db = getDb();
  const sql = userId
    ? "SELECT * FROM roles WHERE owner_id = ? ORDER BY name"
    : "SELECT * FROM roles ORDER BY name";
  return (db.prepare(sql).all(...(userId ? [userId] : [])) as any[]).map(row);
}

// 功能: 返回某 owner 在指定 project 可用的 role 集合 = 全局 role (project_id
// IS NULL) + 该 project 专属 role, 按 name 排序。 Role 场景化 P1
// (docs/plans/role-scoped-roles.md D1); 波 2 的 API/CLI 查询走这里。
export function getRolesForProject(projectId: string, ownerId: string): Role[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM roles
       WHERE owner_id = ? AND (project_id IS NULL OR project_id = ?)
       ORDER BY name`
    )
    .all(ownerId, projectId);
  return (rows as any[]).map(row);
}

export function updateRole(id: string, patch: Partial<RoleInput>, userId?: string): Role | null {
  const db = getDb();
  const current = getRoleById(id, userId);
  if (!current) return null;
  const next = {
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    system_prompt: patch.system_prompt ?? current.system_prompt,
    model: patch.model ?? current.model,
    allowed_tools: patch.allowed_tools ? JSON.stringify(patch.allowed_tools) : current.allowed_tools,
    effort: patch.effort ?? current.effort,
    max_turns: patch.max_turns ?? current.max_turns,
    memory_doc: patch.memory_doc ?? current.memory_doc,
    // undefined = keep current; null/'' = clear to global. (Regular `??`
    // couldn't distinguish "not sent" from "explicitly cleared".)
    project_id:
      patch.projectId === undefined ? current.project_id : patch.projectId || null,
    // v527: undefined = keep current; 非 0 值归 1 (与 create 同款防脏值)
    feishu_writeback:
      patch.feishuWriteback === undefined
        ? current.feishu_writeback
        : patch.feishuWriteback === 0
          ? 0
          : 1,
  };
  db.prepare(
    `UPDATE roles SET name=?, description=?, system_prompt=?, model=?, allowed_tools=?, effort=?, max_turns=?, memory_doc=?, project_id=?, feishu_writeback=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    next.name,
    next.description,
    next.system_prompt,
    next.model,
    next.allowed_tools,
    next.effort,
    next.max_turns,
    next.memory_doc,
    next.project_id,
    next.feishu_writeback,
    id
  );
  return getRoleById(id);
}

export function deleteRole(id: string, userId?: string): boolean {
  const db = getDb();
  // 关注点: tasks.role_id 有 FK (v10 REFERENCES roles(id)) —— 不先解绑, 被引用的
  //   role DELETE 会 SQLITE_CONSTRAINT → route 500 (2026-10-13 总验收 e2e 实证).
  //   先置 NULL 再删: 任务 prompt 里角色内容在 createTask 时已烘焙, 解绑不影响历史任务;
  //   channel_configs.role_id (v526) 虽无 FK, 悬挂引用会让 intake 建 task 撞 ROLE_NOT_FOUND, 一并清.
  db.prepare("UPDATE tasks SET role_id = NULL WHERE role_id = ?").run(id);
  db.prepare("UPDATE channel_configs SET role_id = NULL WHERE role_id = ?").run(id);
  const stmt = userId
    ? db.prepare("DELETE FROM roles WHERE id = ? AND owner_id = ?")
    : db.prepare("DELETE FROM roles WHERE id = ?");
  return stmt.run(...(userId ? [id, userId] : [id])).changes > 0;
}
