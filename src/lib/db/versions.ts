// Version CRUD — each Version belongs to a Project and binds a Feishu sheet config

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import { DELETED_TAG } from "../constants";
import { parseStrArray } from "../json-array";

export interface Version {
  id: string;
  project_id: string;
  name: string;
  // v513 (飞书 R172): 「版本干啥的」描述. AI 解析输入 (POST /api/versions/ai-parse)
  //  自动生成; 也可手动填. 老行 NULL.
  description: string | null;
  feishu_url: string | null;
  feishu_sheet: string | null;
  cwd: string | null;
  // v42: 列含义模板 (JSON 字符串, 结构兼容 ColumnMapping).
  // 不配置时 feishuRowToTaskPrompt 用 DEFAULT_COLUMN_MAPPING 兜底.
  feishu_column_mapping: string | null;
  // v45 强同步: 同步策略. 'weak'=当前手动 diff 行为, 'strong'=sheet 是需求
  // 列表物理存储 (CUD 自动派), 'manual'=无外部源 (version 没配 feishu_url).
  sync_strategy: "weak" | "strong" | "manual";
  // v512: sheetwatch 开关. 1 = sheetwatch 扫此 version 的 sheet 并派发,
  // 0 = 跳过. 与 feishu_url 同级, 老 version 默认 1 (兼容).
  // 类型用 0|1 跟同表的 is_released 一致 (sqlite 无 native bool).
  enable: 0 | 1;
  created_at: string;
  deleted_at: string | null; // v33 soft-delete; NULL = live
}

export interface CreateVersionInput {
  project_id: string;
  name: string;
  // v513: 版本描述（「版本干啥的」）.
  description?: string;
  feishu_url?: string;
  feishu_sheet?: string;
  cwd?: string;
  feishu_column_mapping?: string;
  // v45: 不传默认 'weak' (兼容老调用方). UI 层校验: 没配 feishu_url 只能是 manual.
  sync_strategy?: "weak" | "strong" | "manual";
  // v512: 不传默认 true (兼容老调用方 + 老 DB 行). sheetwatch 据此过滤.
  enable?: boolean;
}

export function createVersion(input: CreateVersionInput): Version {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO versions (id, project_id, name, description, feishu_url, feishu_sheet, cwd, feishu_column_mapping, sync_strategy, enable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.project_id,
    input.name,
    input.description ?? null,
    input.feishu_url || null,
    input.feishu_sheet || null,
    input.cwd || null,
    input.feishu_column_mapping || null,
    input.sync_strategy ?? "weak",
    input.enable === false ? 0 : 1,
  );
  // Auto-set as current version if project has none
  const project = db.prepare("SELECT current_version_id FROM projects WHERE id = ?").get(input.project_id) as { current_version_id: string | null } | undefined;
  if (project && !project.current_version_id) {
    db.prepare("UPDATE projects SET current_version_id = ? WHERE id = ?").run(id, input.project_id);
  }
  return getVersionById(id)!;
}

// userId is optional: API routes pass it to enforce ownership (the version's
// parent project must be owned by the user; non-owner gets null -> 404).
// Internal callers (validateTaskLocation, createTask, getSheetConfigFromVersion)
// omit it for an unfiltered read.
// v33: a soft-deleted version — or one whose parent project was soft-deleted —
// is invisible, so it can't take new tasks or resolve as a cwd/sheet source.
export function getVersionById(id: string, userId?: string): Version | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT v.* FROM versions v
    JOIN projects p ON p.id = v.project_id
    WHERE v.id = ? AND v.deleted_at IS NULL AND p.deleted_at IS NULL
      ${userId ? "AND p.owner_id = ?" : ""}
  `).get(...(userId ? [id, userId] : [id])) as Version | undefined;
  return row ?? null;
}

export function listVersions(projectId?: string, userId?: string): Version[] {
  const db = getDb();
  // v33: hide soft-deleted versions and versions under a soft-deleted project.
  const conditions: string[] = ["v.deleted_at IS NULL", "p.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (projectId) {
    conditions.push("v.project_id = ?");
    params.push(projectId);
  }
  if (userId) {
    conditions.push("p.owner_id = ?");
    params.push(userId);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  return db
    .prepare(`SELECT v.* FROM versions v JOIN projects p ON p.id = v.project_id ${where} ORDER BY v.name ASC`)
    .all(...params) as Version[];
}

export function updateVersion(id: string, patch: Partial<Omit<CreateVersionInput, "id">>): Version | null {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.project_id !== undefined) { fields.push("project_id = ?"); values.push(patch.project_id); }
  if (patch.name !== undefined) { fields.push("name = ?"); values.push(patch.name); }
  if (patch.description !== undefined) { fields.push("description = ?"); values.push(patch.description); }
  if (patch.feishu_url !== undefined) { fields.push("feishu_url = ?"); values.push(patch.feishu_url); }
  if (patch.feishu_sheet !== undefined) { fields.push("feishu_sheet = ?"); values.push(patch.feishu_sheet); }
  if (patch.cwd !== undefined) { fields.push("cwd = ?"); values.push(patch.cwd); }
  if (patch.feishu_column_mapping !== undefined) { fields.push("feishu_column_mapping = ?"); values.push(patch.feishu_column_mapping); }
  if (patch.sync_strategy !== undefined) { fields.push("sync_strategy = ?"); values.push(patch.sync_strategy); }
  // v512: enable 布尔 → INTEGER 0/1. 严格 undefined 跳过 (=不改), 显式 false → 0.
  if (patch.enable !== undefined) { fields.push("enable = ?"); values.push(patch.enable ? 1 : 0); }
  if (fields.length === 0) return getVersionById(id);
  values.push(id);
  db.prepare(`UPDATE versions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getVersionById(id);
}

// 功能: 级联软删一个版本 —— 版本自己 + 其下所有 task 打上 deleted_at, 从列表
// 消失但数据全留. 返回软删掉的 task 数.
// 关注点:
//  - 与 deleteProject 同因: tasks.version_id 没有 ON DELETE 子句 + foreign_keys
//    =ON, 裸 DELETE 对任何有 task 的版本都 FK 失败(本次修的 500 之一).
//  - task 软删语义与 deleteTask() 保持一致(deleted_at + tags 加 DELETED_TAG),
//    否则 UI 的「已删除」标记和 restore 行为会和正常删除的 task 不一致.
//  - 🔴 必须顺手清掉 projects.current_version_id 的悬空指向: createVersion 会把
//    首个版本设为项目的 current(类比 HEAD), 软删后若不清, 项目会一直指着一个
//    看不见的版本 —— getProjectById 的 LEFT JOIN 已带 deleted_at 过滤, 于是
//    current_version_name 变 NULL 而 current_version_id 非 NULL, 前端出现
//    「有 current 但没名字」的诡异状态. 这里回退成同项目下最早的另一个活版本,
//    没有则置 NULL.
//  - 整个操作包在一个事务里.
export function deleteVersion(id: string): { tasks: number } {
  const db = getDb();
  const now = "datetime('now')";

  const run = db.transaction(() => {
    const row = db
      .prepare(`SELECT project_id FROM versions WHERE id = ?`)
      .get(id) as { project_id: string } | undefined;

    const liveTasks = db
      .prepare(
        `SELECT id, tags FROM tasks WHERE version_id = ? AND deleted_at IS NULL`
      )
      .all(id) as Array<{ id: string; tags: string | null }>;
    const tagTask = db.prepare(
      `UPDATE tasks SET deleted_at = ${now}, tags = ?, updated_at = ${now} WHERE id = ?`
    );
    for (const t of liveTasks) {
      const tags = parseStrArray(t.tags);
      if (!tags.includes(DELETED_TAG)) tags.push(DELETED_TAG);
      tagTask.run(JSON.stringify(tags), t.id);
    }

    db.prepare(
      `UPDATE versions SET deleted_at = ${now} WHERE id = ? AND deleted_at IS NULL`
    ).run(id);

    if (row) {
      const fallback = db
        .prepare(
          `SELECT id FROM versions
           WHERE project_id = ? AND id != ? AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`
        )
        .get(row.project_id, id) as { id: string } | undefined;
      db.prepare(
        `UPDATE projects SET current_version_id = ?
         WHERE id = ? AND current_version_id = ?`
      ).run(fallback?.id ?? null, row.project_id, id);
    }

    return { tasks: liveTasks.length };
  });

  return run();
}

export interface SheetConfig {
  sheetUrl: string;
  sheetName: string;
  cwd: string | null;
}

export function getSheetConfigFromVersion(versionId: string): SheetConfig | null {
  const v = getVersionById(versionId);
  if (!v) return null;
  return {
    sheetUrl: v.feishu_url || "",
    sheetName: v.feishu_sheet || "Sheet2",
    cwd: v.cwd,
  };
}
