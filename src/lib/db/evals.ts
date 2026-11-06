// agent_evals CRUD — workflow.md §9 v1 (lightweight evaluation):
// score a completed/rejected task 1-5 with optional note. Aggregate by role
// for future A/B prompt iteration (decoupled from prompt mutation — human-in-loop).

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import { getTaskById } from "./tasks";

export type EvalEvent = "approved" | "rejected";

export interface EvalRow {
  id: number;
  task_id: string;
  role_id: string | null;
  event: EvalEvent;
  score: number; // 1-5
  note: string | null;
  created_at: string;
}

export interface EvalInput {
  task_id: string;
  event: EvalEvent; // matches the status_change that prompted the eval
  score: number;
  note?: string;
}

function row(r: any): EvalRow {
  return {
    id: r.id,
    task_id: r.task_id,
    role_id: r.role_id,
    event: r.event,
    score: r.score,
    note: r.note,
    created_at: r.created_at,
  };
}

export function createEval(input: EvalInput): EvalRow {
  const db = getDb();
  const task = getTaskById(input.task_id);
  if (!task) throw new Error(`Task ${input.task_id} not found`);
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new Error("score must be integer 1-5");
  }
  const r = db
    .prepare(
      `INSERT INTO agent_evals (task_id, role_id, event, score, note) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.task_id,
      task.role_id ?? null,
      input.event,
      input.score,
      input.note ?? null
    );
  return getEvalById(Number(r.lastInsertRowid))!;
}

export function getEvalById(id: number): EvalRow | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM agent_evals WHERE id = ?").get(id);
  return r ? row(r) : null;
}

export function listEvalsByTask(taskId: string): EvalRow[] {
  const db = getDb();
  return (db
    .prepare("SELECT * FROM agent_evals WHERE task_id = ? ORDER BY created_at DESC")
    .all(taskId) as any[]).map(row);
}

export function listEvalsByRole(roleId: string): EvalRow[] {
  const db = getDb();
  return (db
    .prepare("SELECT * FROM agent_evals WHERE role_id = ? ORDER BY created_at DESC")
    .all(roleId) as any[]).map(row);
}

export interface RoleAggregate {
  role_id: string;
  count: number;
  avg_score: number;
  approved_count: number;
  rejected_count: number;
}

export function aggregateByRole(): RoleAggregate[] {
  const db = getDb();
  return (db
    .prepare(
      `SELECT role_id, COUNT(*) AS count, AVG(score) AS avg_score,
              SUM(CASE WHEN event='approved' THEN 1 ELSE 0 END) AS approved_count,
              SUM(CASE WHEN event='rejected' THEN 1 ELSE 0 END) AS rejected_count
       FROM agent_evals
       WHERE role_id IS NOT NULL
       GROUP BY role_id`
    )
    .all() as any[]).map((r) => ({
    role_id: r.role_id,
    count: r.count,
    avg_score: r.avg_score,
    approved_count: r.approved_count,
    rejected_count: r.rejected_count,
  }));
}