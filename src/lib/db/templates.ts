// Template CRUD operations

import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import type { EffortLevel } from "../runtime/types";

export interface Template {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  model: string | null;
  llm_config_id: string | null; // v50: 模板绑定的 LLM 配置 FK
  allowed_tools: string | null;
  max_turns: number | null;
  effort: EffortLevel | null;
  auto_approve: number;
  tags: string | null;
  owner_id: string | null; // FK users.id (T3); NULL = pre-auth legacy row
  created_at: string;
  updated_at: string;
}

export interface TemplateDefinition {
  name: string;
  prompt: string;
  description?: string;
  model?: string;
  llm_config_id?: string | null; // v50: 选定的 LLM 配置; 任务从此模板继承时透传
  allowedTools?: string[];
  maxTurns?: number;
  effort?: EffortLevel;
  autoApprove?: boolean;
  tags?: string[];
  ownerId?: string; // from session (x-user-id); API routes always set this
}

export function createTemplate(def: TemplateDefinition): Template {
  const db = getDb();
  const id = uuidv4();

  const stmt = db.prepare(`
    INSERT INTO templates (id, name, description, prompt, model, llm_config_id, allowed_tools, max_turns, effort, auto_approve, tags, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    def.name,
    def.description || null,
    def.prompt,
    def.model || null,
    def.llm_config_id ?? null,
    def.allowedTools ? JSON.stringify(def.allowedTools) : null,
    def.maxTurns || null,
    def.effort || null,
    def.autoApprove ? 1 : 0,
    def.tags ? JSON.stringify(def.tags) : null,
    def.ownerId ?? null
  );

  return getTemplateById(id)!;
}

// userId is optional: API routes pass it to enforce ownership (non-owner gets
// null -> 404); internal callers omit it for an unfiltered read.
export function getTemplateById(id: string, userId?: string): Template | null {
  const db = getDb();
  const stmt = userId
    ? db.prepare("SELECT * FROM templates WHERE id = ? AND owner_id = ?")
    : db.prepare("SELECT * FROM templates WHERE id = ?");
  return (stmt.get(...(userId ? [id, userId] : [id])) as Template) || null;
}

export function listTemplates(userId?: string): Template[] {
  const db = getDb();
  const sql = userId
    ? "SELECT * FROM templates WHERE owner_id = ? ORDER BY updated_at DESC"
    : "SELECT * FROM templates ORDER BY updated_at DESC";
  return db.prepare(sql).all(...(userId ? [userId] : [])) as Template[];
}

export function deleteTemplate(id: string, userId?: string): boolean {
  const db = getDb();
  const stmt = userId
    ? db.prepare("DELETE FROM templates WHERE id = ? AND owner_id = ?")
    : db.prepare("DELETE FROM templates WHERE id = ?");
  return stmt.run(...(userId ? [id, userId] : [id])).changes > 0;
}

export function updateTemplate(
  id: string,
  userId: string | undefined,
  patch: Partial<TemplateDefinition>
): Template | null {
  const db = getDb();
  const existing = getTemplateById(id, userId);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];
  const fields: Array<keyof TemplateDefinition> = [
    "name",
    "description",
    "prompt",
    "model",
    "llm_config_id",
    "allowedTools",
    "maxTurns",
    "effort",
    "autoApprove",
    "tags",
  ];
  for (const f of fields) {
    if (!(f in patch)) continue;
    const v = patch[f];
    switch (f) {
      case "name":
        sets.push("name = ?"); params.push(v); break;
      case "description":
        sets.push("description = ?"); params.push(v ?? null); break;
      case "prompt":
        sets.push("prompt = ?"); params.push(v); break;
      case "model":
        sets.push("model = ?"); params.push(v ?? null); break;
      case "llm_config_id":
        sets.push("llm_config_id = ?"); params.push(v ?? null); break;
      case "allowedTools":
        sets.push("allowed_tools = ?"); params.push(v ? JSON.stringify(v) : null); break;
      case "maxTurns":
        sets.push("max_turns = ?"); params.push(v ?? null); break;
      case "effort":
        sets.push("effort = ?"); params.push(v ?? null); break;
      case "autoApprove":
        sets.push("auto_approve = ?"); params.push(v ? 1 : 0); break;
      case "tags":
        sets.push("tags = ?"); params.push(v ? JSON.stringify(v) : null); break;
    }
  }
  if (sets.length === 1) return existing; // nothing to update

  params.push(id);
  db.prepare(`UPDATE templates SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getTemplateById(id, userId);
}
