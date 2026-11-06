// Config snapshot ("模板配置") CRUD operations.
// A snapshot stores reusable execution-config knobs (no prompt). scope decides
// where it applies: global (any project) | project | version. On /tasks/new
// the best match for the current location auto-applies; quick mode offers a
// switcher. Distinct from prompt-centric templates.

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import type { EffortLevel } from "../runtime/types";

export type SnapshotScope = "global" | "project" | "version";

export interface ConfigSnapshot {
  id: string;
  name: string;
  description: string | null;
  scope: SnapshotScope;
  project_id: string | null;
  version_id: string | null;
  model: string | null;
  effort: EffortLevel | null;
  max_turns: number | null;
  auto_approve: number | null;
  allowed_tools: string | null;
  tags: string | null;
  type: string | null;
  llm_config_id: string | null; // v52: 绑定到具体 LLM 配置 (与 tasks.llm_config_id 同义)
  owner_id: string | null; // FK users.id (T3); NULL = pre-auth legacy row
  created_at: string;
  updated_at: string;
}

export interface ConfigSnapshotDefinition {
  name: string;
  description?: string;
  scope: SnapshotScope;
  projectId?: string;
  versionId?: string;
  model?: string;
  effort?: EffortLevel;
  maxTurns?: number;
  autoApprove?: boolean;
  allowedTools?: string[];
  tags?: string[];
  type?: string;
  llmConfigId?: string; // v52: 绑定到具体 LLM 配置
  ownerId?: string; // from session (x-user-id); API routes always set this
}

function validateScope(def: ConfigSnapshotDefinition): void {
  if (def.scope === "global") {
    if (def.projectId) throw new Error("global 快照不能绑定 project");
  } else if (def.scope === "project") {
    if (!def.projectId) throw new Error("project 快照必须绑定 projectId");
    if (def.versionId) throw new Error("project 快照不能绑定 version");
  } else if (def.scope === "version") {
    if (!def.projectId) throw new Error("version 快照必须绑定 projectId");
    if (!def.versionId) throw new Error("version 快照必须绑定 versionId");
  } else {
    throw new Error(`未知 scope: ${def.scope}`);
  }
}

export function createConfigSnapshot(def: ConfigSnapshotDefinition): ConfigSnapshot {
  validateScope(def);
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO config_snapshots
      (id, name, description, scope, project_id, version_id, model, effort,
       max_turns, auto_approve, allowed_tools, tags, type, llm_config_id, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    def.name,
    def.description || null,
    def.scope,
    def.scope === "global" ? null : def.projectId || null,
    def.scope === "version" ? def.versionId! : null,
    def.model || null,
    def.effort || null,
    def.maxTurns || null,
    def.autoApprove === undefined ? null : (def.autoApprove ? 1 : 0),
    def.allowedTools ? JSON.stringify(def.allowedTools) : null,
    def.tags ? JSON.stringify(def.tags) : null,
    def.type || null,
    def.llmConfigId || null,
    def.ownerId ?? null
  );

  return getConfigSnapshotById(id)!;
}

// userId is optional: API routes pass it to enforce ownership (non-owner gets
// null -> 404); internal callers omit it for an unfiltered read.
export function getConfigSnapshotById(id: string, userId?: string): ConfigSnapshot | null {
  const db = getDb();
  const sql = userId
    ? "SELECT * FROM config_snapshots WHERE id = ? AND owner_id = ?"
    : "SELECT * FROM config_snapshots WHERE id = ?";
  return (db.prepare(sql).get(...(userId ? [id, userId] : [id])) as ConfigSnapshot) || null;
}

export function listConfigSnapshots(userId?: string): ConfigSnapshot[] {
  const db = getDb();
  const sql = userId
    ? "SELECT * FROM config_snapshots WHERE owner_id = ? ORDER BY updated_at DESC"
    : "SELECT * FROM config_snapshots ORDER BY updated_at DESC";
  return db.prepare(sql).all(...(userId ? [userId] : [])) as ConfigSnapshot[];
}

// Snapshots applicable to a location: global + this project's + this version's.
// Ordered most-specific first (version > project > global) then by recency.
// userId scopes all results to that owner (so a user only sees their own
// snapshots, even when querying another user's project/version id).
export function listApplicableSnapshots(
  projectId: string | null,
  versionId: string | null,
  userId?: string
): ConfigSnapshot[] {
  const db = getDb();
  const ownerClause = userId ? "AND owner_id = ?" : "";
  if (!projectId && !versionId) {
    return db.prepare(
      `SELECT * FROM config_snapshots WHERE scope = 'global' ${ownerClause} ORDER BY updated_at DESC`
    ).all(...(userId ? [userId] : [])) as ConfigSnapshot[];
  }
  return db.prepare(`
    SELECT * FROM config_snapshots
    WHERE (scope = 'global' ${userId ? "AND owner_id = ?" : ""})
       OR (scope = 'project' AND project_id = ? ${userId ? "AND owner_id = ?" : ""})
       OR (scope = 'version' AND version_id = ? ${userId ? "AND owner_id = ?" : ""})
    ORDER BY CASE scope WHEN 'version' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
             updated_at DESC
  `).all(
    ...(userId
      ? [userId, projectId || null, userId, versionId || null, userId]
      : [projectId || null, versionId || null])
  ) as ConfigSnapshot[];
}

// Single best match for auto-apply: version > project > global > null.
export function bestMatchSnapshot(
  projectId: string | null,
  versionId: string | null,
  userId?: string
): ConfigSnapshot | null {
  const applicable = listApplicableSnapshots(projectId, versionId, userId);
  return applicable.length > 0 ? applicable[0] : null;
}

export function updateConfigSnapshot(id: string, def: ConfigSnapshotDefinition, userId?: string): ConfigSnapshot | null {
  validateScope(def);
  const db = getDb();
  // Ownership gate: only the owner can update. Re-read with userId first.
  if (userId && !getConfigSnapshotById(id, userId)) return null;
  db.prepare(`
    UPDATE config_snapshots SET
      name = ?, description = ?, scope = ?, project_id = ?, version_id = ?,
      model = ?, effort = ?, max_turns = ?, auto_approve = ?,
      allowed_tools = ?, tags = ?, type = ?, llm_config_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    def.name,
    def.description || null,
    def.scope,
    def.scope === "global" ? null : def.projectId || null,
    def.scope === "version" ? def.versionId! : null,
    def.model || null,
    def.effort || null,
    def.maxTurns || null,
    def.autoApprove === undefined ? null : (def.autoApprove ? 1 : 0),
    def.allowedTools ? JSON.stringify(def.allowedTools) : null,
    def.tags ? JSON.stringify(def.tags) : null,
    def.type || null,
    def.llmConfigId || null,
    id
  );
  return getConfigSnapshotById(id);
}

export function deleteConfigSnapshot(id: string, userId?: string): boolean {
  const db = getDb();
  const sql = userId
    ? "DELETE FROM config_snapshots WHERE id = ? AND owner_id = ?"
    : "DELETE FROM config_snapshots WHERE id = ?";
  return db.prepare(sql).run(...(userId ? [id, userId] : [id])).changes > 0;
}
