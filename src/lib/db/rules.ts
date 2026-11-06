// task_rules CRUD — event-triggered orchestration rules (workflow.md §8).

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import type { TaskStatus } from "../runtime/types";

export type ActionType =
  | "notify_dependents"
  | "write_back_feishu"
  | "auto_rename_title"
  | "summarize_completion_attachments"
  // R127 §3.5: 规则引擎 v2 加 2 个 action_type. 注意两者都不适合纯 event-triggered —
  //   nudge_on_decision_stale 需要 cron 周期性扫 (task 进 reviewing 后 3 天还没拍板),
  //   auto_resume_on_child_completed 需要子 completed 事件 + 父 waiting_child_id 命中.
  //   此处只扩 ActionType 联合 + 占位实现, 真正触发器 T2 跟进.
  | "nudge_on_decision_stale"
  | "auto_resume_on_child_completed";

export interface Rule {
  id: string;
  name: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  condition_json: string | null;
  action_type: ActionType;
  action_params_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface RuleInput {
  name: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  condition?: Record<string, unknown>;
  action_type: ActionType;
  action_params?: Record<string, unknown>;
  enabled?: boolean;
}

function rowToRule(r: any): Rule {
  return {
    id: r.id,
    name: r.name,
    from_status: r.from_status,
    to_status: r.to_status,
    condition_json: r.condition_json,
    action_type: r.action_type,
    action_params_json: r.action_params_json,
    enabled: r.enabled,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createRule(input: RuleInput): Rule {
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    `INSERT INTO task_rules (id, name, from_status, to_status, condition_json, action_type, action_params_json, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.from_status,
    input.to_status,
    input.condition ? JSON.stringify(input.condition) : null,
    input.action_type,
    input.action_params ? JSON.stringify(input.action_params) : null,
    input.enabled === false ? 0 : 1
  );
  return getRuleById(id)!;
}

export function getRuleById(id: string): Rule | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM task_rules WHERE id = ?").get(id);
  return r ? rowToRule(r) : null;
}

export function listRules(): Rule[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM task_rules ORDER BY created_at").all();
  return rows.map(rowToRule);
}

export function setRuleEnabled(id: string, enabled: boolean): Rule | null {
  const db = getDb();
  db.prepare("UPDATE task_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
  return getRuleById(id);
}

export function deleteRule(id: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM task_rules WHERE id = ?").run(id);
  return res.changes > 0;
}

// Match rules for a status transition. Returns enabled rules in insertion order.
// `task` is supplied so condition_json can inspect task fields (currently: type).
export function matchingRules(
  from: TaskStatus,
  to: TaskStatus,
  task: { type: string | null }
): Rule[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM task_rules WHERE from_status = ? AND to_status = ? AND enabled = 1 ORDER BY created_at"
    )
    .all(from, to) as any[];
  return rows
    .map(rowToRule)
    .filter((r) => ruleConditionMatches(r, task));
}

function ruleConditionMatches(rule: Rule, task: { type: string | null }): boolean {
  if (!rule.condition_json) return true;
  let cond: any;
  try {
    cond = JSON.parse(rule.condition_json);
  } catch {
    return false;
  }
  // supported conditions: { task_type: "deploy" } → task.type equals value
  if (typeof cond.task_type === "string") {
    return task.type === cond.task_type;
  }
  return true;
}

// Built-in rules seeded on first run. Idempotent via name uniqueness check.
// Keep this list small — each rule is global, applies to every matching transition.
export function seedBuiltinRules(): void {
  const db = getDb();
  // 🔴 idempotent via name uniqueness. 检查每条 builtin rule 是否已存在.
  //   🆕 R131 (damo 2026-09-15): reject-deploy-notify-dependents 移除. rejected
  //   状态从 in-flight 流转中删除, 这条规则不会再被触发, 保留会变孤儿.
  //   已有 row 由 DELETE 兜底 (见末尾), 不留历史脏数据.
  const builtinNames = [
    "feishu-auto-writeback-on-reviewing",
    "feishu-auto-writeback-on-completed",
    "auto-rename-on-reviewing",
    "completion-auto-send-images",
  ];
  const placeholders = builtinNames.map(() => "?").join(",");
  const existingRows = db
    .prepare(`SELECT name FROM task_rules WHERE name IN (${placeholders})`)
    .all(...builtinNames) as Array<{ name: string }>;
  const existing = new Set(existingRows.map((r) => r.name));

  // 兜底: 删历史 reject-deploy-notify-dependents rule (R131). idempotent — 不存在也不报错.
  db.prepare(`DELETE FROM task_rules WHERE name = ?`).run("reject-deploy-notify-dependents");

  if (!existing.has("feishu-auto-writeback-on-reviewing")) {
    // Task 自然完成 (reviewing 态): 写回飞书 + 更新 Requirement.status.
    // write_back_feishu 内部会检查 task.tags 是否含 feishu reqId,
    // 非飞书 task 自动 no-op, 所以 rule 全局安全.
    createRule({
      name: "feishu-auto-writeback-on-reviewing",
      from_status: "running",
      to_status: "reviewing",
      action_type: "write_back_feishu",
    });
  }

  if (!existing.has("feishu-auto-writeback-on-completed")) {
    // 验收 approve 后 (completed): 再写一次飞书让 T 列变 completed.
    createRule({
      name: "feishu-auto-writeback-on-completed",
      from_status: "reviewing",
      to_status: "completed",
      action_type: "write_back_feishu",
    });
  }

  if (!existing.has("auto-rename-on-reviewing")) {
    // R15 sub-2: task 进入 reviewing 状态时, 若标题未被人手动改过 (metadata.title_lock
    // !== 'manual'), 用 task.prompt 提炼一个有意义的标题替换. sub-3 优先:
    // metadata.title_lock='manual' (用户 PATCH 过) → 直接跳过, 保留用户起的名字.
    // 仅一次 (auto_rename_title 落 title_lock='auto'), 后续重复 running→reviewing
    // 也不会再覆盖.
    createRule({
      name: "auto-rename-on-reviewing",
      from_status: "running",
      to_status: "reviewing",
      action_type: "auto_rename_title",
    });
  }

  if (!existing.has("completion-auto-send-images")) {
    // R121 P2: completion auto-send images. task 进 reviewing 状态时, 查最近 30 分钟
    //   内 agent_generated 图片 attachment, 拼飞书 post 富文本主动通知 damo.
    //   opt-in: 默认 enabled=0, 由 admin 通过 PATCH /api/task-rules/[id] 启用
    //   (damo 推荐 #1: 防 spam). task.metadata.completion_notified_at 标记防重复发.
    //   完成路径见 completion-notify.ts.
    createRule({
      name: "completion-auto-send-images",
      from_status: "running",
      to_status: "reviewing",
      action_type: "summarize_completion_attachments",
      action_params: {
        window_minutes: 30,
        max_images: 9,
        channel: "feishu",
        skip_if_empty: true,
      },
      enabled: false, // opt-in: 管理员主动启
    });
  }
}
