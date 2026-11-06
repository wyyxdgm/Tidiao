// Event-triggered orchestration: run matching rules for a status transition.
// Workflow.md §8 v1 -- pure rules table, no Agent SDK / LLM invocation.

import {
  matchingRules,
  type Rule,
  type ActionType,
} from "../db/rules";
import {
  getTaskById,
  getDependentTaskIds,
} from "../db/tasks";
import { getRoleById } from "../db/roles";
import { dispatchDependencyChangeWebhook } from "../webhooks/dispatcher";
import type { TaskStatus } from "./types";
import { insertEvent } from "../db/events";

interface RunRulesInput {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
}

// Side-effect handler per action_type. Throwing here is caught by runRules so
// one rule's failure doesn't break the rest.
async function runAction(rule: Rule, taskId: string): Promise<void> {
  if (rule.action_type === "notify_dependents") {
    const task = getTaskById(taskId);
    if (!task) return;
    const dependentIds = getDependentTaskIds(taskId);
    const dependents = dependentIds
      .map((id) => getTaskById(id))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (dependents.length === 0) return;
    const params = rule.action_params_json ? safeParse<Record<string, unknown>>(rule.action_params_json, {}) : {};
    const message = typeof params.message === "string" ? params.message : undefined;
    dispatchDependencyChangeWebhook(task, dependents, message);
    insertEvent({
      task_id: taskId,
      type: "rule_fired",
      data: JSON.stringify({ rule_id: rule.id, rule_name: rule.name, action_type: rule.action_type, dependent_count: dependents.length }),
    });
    return;
  }

  if (rule.action_type === "write_back_feishu") {
    // 动态 import 避免循环依赖 (write-back.ts 引了 db/tasks 等, 与 agent-runtime 同链)
    const { tryWriteBackFeishu } = await import("../feishu/write-back");
    const task = getTaskById(taskId);
    if (!task) return;
    // Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): 真拦截点. task 挂的
    //   role feishu_writeback=0 → 不调 tryWriteBackFeishu, skip 留痕后 return.
    //   role 为 NULL 或查不到 → 放行 (行为不变). 留痕口径沿用 auto_rename 先例:
    //   type=rule_fired + result=skipped:*, 运维从 timeline 直接判断「为什么没写」.
    if (task.role_id) {
      const role = getRoleById(task.role_id);
      if (role && role.feishu_writeback === 0) {
        insertEvent({
          task_id: taskId,
          type: "rule_fired",
          data: JSON.stringify({
            rule_id: rule.id,
            rule_name: rule.name,
            action_type: rule.action_type,
            result: "skipped:feishu_writeback_skipped_by_role",
          }),
        });
        return;
      }
    }
    const ok = await tryWriteBackFeishu(taskId, task.owner_id ?? undefined);
    insertEvent({
      task_id: taskId,
      type: ok ? "rule_fired" : "rule_failed",
      data: JSON.stringify({
        rule_id: rule.id,
        rule_name: rule.name,
        action_type: rule.action_type,
        result: ok ? "wrote" : "failed_or_skipped",
      }),
    });
    return;
  }

  if (rule.action_type === "auto_rename_title") {
    // R15 sub-2 + sub-3: reviewing 进入时按规则自动改名, 但 sub-3 优先 (用户手动
    // 改过的永远不覆盖, 详见 auto-rename.ts 的 metadata.title_lock 语义).
    // 跳过也是正常行为 (manual_lock / auto_lock / no_prompt), 统一记 rule_fired
    // + result=skipped:*, 让运维能从 timeline 直接判断「为什么没改」.
    //
    // R122 T5-A: applyAutoRename 已 async (内部可能调 LLM 走单次 SDK session).
    const { applyAutoRename } = await import("./auto-rename");
    const outcome = await applyAutoRename(taskId);
    const resultStr = outcome.ok
      ? outcome.source === "unchanged"
        ? "already_good"
        : `renamed:${outcome.from.slice(0, 30)}→${outcome.to.slice(0, 30)}(via_${outcome.source})`
      : `skipped:${outcome.reason}`;
    insertEvent({
      task_id: taskId,
      type: "rule_fired",
      data: JSON.stringify({
        rule_id: rule.id,
        rule_name: rule.name,
        action_type: rule.action_type,
        result: resultStr,
      }),
    });
    return;
  }

  if (rule.action_type === "summarize_completion_attachments") {
    // R121 P2: completion auto-send. 查 task 最近 N 分钟内 agent_generated 图,
    //   拼飞书 post 富文本发通知. 详细逻辑见 completion-notify.ts.
    const { summarizeCompletionAttachments } = await import("./completion-notify");
    const params = rule.action_params_json ? safeParse<Record<string, unknown>>(rule.action_params_json, {}) : {};
    const outcome = await summarizeCompletionAttachments(taskId, params);
    insertEvent({
      task_id: taskId,
      type: outcome.sent ? "rule_fired" : "rule_fired", // 失败也记 rule_fired (内含 reason), 不让 timeline 出现红色
      data: JSON.stringify({
        rule_id: rule.id,
        rule_name: rule.name,
        action_type: rule.action_type,
        result: outcome.sent ? `sent:${outcome.imageCount}_images` : outcome.reason,
      }),
    });
    return;
  }

  // R127 §3.5: nudge_on_decision_stale. 计划语义: reviewing task + awaiting_markers
  //   解析出 type='decision' 且未 resolved + emitted_at < NOW - 3 天 → POST /api/notify.
  //   真正触发器需要 cron 周期性扫 (event-triggered 跑不出 3 天 stale), 此处只占位.
  //   T2 follow-up: 把 rule-engine 升级成「event + cron 双触发」, 加 scheduleRunner 入口.
  //   本批只保证 ActionType 注册 + 不抛 (fail-soft), 业务看到 rule_skipped:nudge_no_cron
  //   即可识别「规则挂上但未触发」.
  if (rule.action_type === "nudge_on_decision_stale") {
    insertEvent({
      task_id: taskId,
      type: "rule_fired",
      data: JSON.stringify({
        rule_id: rule.id,
        rule_name: rule.name,
        action_type: rule.action_type,
        result: "skipped:nudge_no_cron_yet", // T2 跟 cron 联动前都返这串
      }),
    });
    return;
  }

  // R127 §3.5: auto_resume_on_child_completed. 计划语义: 子 completed → 父
  //   waiting_child_id === child.id 命中 → startTask / approveTask(skipReviewGate=true).
  //   当前实际触发由 parent-notify.ts 血缘判据直接调 autoResumeParentAfterChildComplete,
  //   不走 rule-engine (避免双触发). 此处只占位, 让规则可注册但说明「实际走另一条路」.
  if (rule.action_type === "auto_resume_on_child_completed") {
    insertEvent({
      task_id: taskId,
      type: "rule_fired",
      data: JSON.stringify({
        rule_id: rule.id,
        rule_name: rule.name,
        action_type: rule.action_type,
        result: "skipped:handled_by_parent_notify",
      }),
    });
    return;
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export async function runRules({ taskId, from, to }: RunRulesInput): Promise<void> {
  const task = getTaskById(taskId);
  if (!task) return;
  const rules = matchingRules(from, to, { type: task.type });
  if (rules.length === 0) return;
  for (const rule of rules) {
    try {
      await runAction(rule, taskId);
    } catch (err) {
      console.error(`[RuleEngine] rule ${rule.name} (${rule.id}) failed:`, err);
      insertEvent({
        task_id: taskId,
        type: "rule_failed",
        data: JSON.stringify({ rule_id: rule.id, rule_name: rule.name, error: err instanceof Error ? err.message : String(err) }),
      });
    }
  }
}
