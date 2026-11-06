// Schedule adaptive frequency: 平台级硬机制（damo 2026-09-01 拍板）。
//
// 背景: GDM gdm-monetization-research 软约束「自适应调频」写在 playbook,
//   prompt 里只是措辞, agent 可能忘调 / 调出区间 / 不显示新 expr。
//   平台机制兜底 = 区间硬约束 + 注入硬指令 + 完成时 A/B 校验 + 警告通知。
//
// 三层:
//   1. schedules 表加 freq_min/max（migration v60, db/schedules.ts）。
//   2. schedule-runner fireAgent 时按 schedule 是否带 freq_min/max 注入 prompt header。
//   3. 任务完成/reviewing 时跑 A/B 校验, 命中条件发飞书 webhook 警告（不强制改写,
//      不阻止 task 完成 —— 警告是兜底不是闸门）。
//
// 关注点:
//   - 校验 A: 把当前 schedule_expr 解析成下次触发时刻 → 算出间隔分钟 → 不在
//     [min, max] 内 → 警告（agent 调了 expr 但落在区间外）。
//   - 校验 B: 比对 task 创建时记录的 schedule_expr vs task 完成时 schedule_expr,
//     相同 = agent 这轮没动 → 警告。
//   - 「本轮 expr 快照」存在 tasks.metadata.adaptive_snapshots JSON 数组里
//     （key=schedule_id, value={at: ISO, expr: '...'}），避免加新表；
//     写快照时机: schedule-runner fireAgent 时写「快照 in」, watcher 校验后
//     写「快照 out」（覆盖 / 留痕）。
//   - 通知复用 sendFeishuWebhook 内部函数（不发邮件，damo 推荐 #6 默认 feishu）；
//     channel 由 owner.feishu_webhook_url 决定, 没配则降级 console.warn。

import type { Schedule } from "../db/schedules";
import { getScheduleById } from "../db/schedules";
import { getTaskById, mutateTaskMetadata } from "../db/tasks";
import { getUserById } from "../db/users";
import { CronExpressionParser } from "cron-parser";
import { sendFeishuWebhook } from "../notify/feishu";
import { sendNotifyToUser } from "../notify/mailer";

export const ADAPTIVE_HEADER_MARKER = "[SCHEDULE_ADAPTIVE_HEADER]";

// 本轮 expr 快照 metadata key。
export const ADAPTIVE_SNAPSHOT_KEY = "adaptive_snapshots";

export interface AdaptiveSnapshot {
  /** 快照时间 ISO。 */
  at: string;
  /** schedule_id（用于区分多 schedule 共享 metadata）。 */
  schedule_id: string;
  /** 创建 task 时 schedule.schedule_expr。watcher 用它判断本轮有没有调。 */
  expr_before: string;
  /** task 完成时 schedule.schedule_expr（watcher 写入）。 */
  expr_after?: string;
  /** 触发原因：fire = runner 起 task 时写; check = watcher 校验完成时写。 */
  trigger: "fire" | "check";
}

/**
 * 功能: 按 schedule 是否启用自适应频率, 返回要拼到 fireAgent prompt 头部的指令段。
 *   schedule 未启用 → null（保持旧行为, prompt 不变）。
 *
 * 关注点:
 *   - 文案钉死（damo 拍板原话）—— 改一处影响所有 agent schedule。
 *   - 区间读自 schedule.freq_min_minutes / freq_max_minutes。
 *   - 「本轮没调也允许完成」: 文案强调警告而非 fail, 跟 damo 拍板一致。
 */
export function buildAdaptivePromptHeader(schedule: Schedule): string | null {
  if (schedule.freq_min_minutes == null || schedule.freq_max_minutes == null) {
    return null;
  }
  return [
    ADAPTIVE_HEADER_MARKER,
    `本 schedule 启用了自适应频率模式：每次触发你必须在 [${schedule.freq_min_minutes}, ${schedule.freq_max_minutes}] 分钟区间内自选下次 cron 表达式。`,
    ``,
    `必须做的事：`,
    `1. 每次回复正文最后一段显式输出 "下次 cron: <expr>"（expr 必须落在 [${schedule.freq_min_minutes}, ${schedule.freq_max_minutes}] 分钟区间内）`,
    `2. 任务收尾前调 \`cron.sh update <schedule_id> --expr "<新 expr>"\` 把新表达式落库`,
    `3. expr 落到区间外不会拦截 task 完成, 但会发警告通知 damo, 连续 3 轮不调 → 警告升级`,
    ``,
    `退出前再次提醒：进入 reviewing 前会再校验一次, 没调就 warn。`,
    ``,
  ].join("\n");
}

/**
 * 功能: 记录「fire 时 schedule_expr」到 task.metadata.adaptive_snapshots。
 *   供 watcher 校验 B（agent 本轮调了没）对照。
 *
 * 关注点:
 *   - fire 时 schedule-runner 调一次, 完成时 watcher 调一次（trigger=check）。
 *   - 同 schedule_id 多次 fire 时按数组追加, 不覆盖（观察 agent 反复跑同 schedule）。
 *   - mutateTaskMetadata 走 read-modify-write, 数组 push 在 mutator 内做。
 */
export function recordAdaptiveSnapshot(
  taskId: string,
  scheduleId: string,
  scheduleExprBefore: string,
  trigger: "fire" | "check"
): void {
  mutateTaskMetadata(taskId, (m) => {
    const arr: AdaptiveSnapshot[] = Array.isArray(m[ADAPTIVE_SNAPSHOT_KEY])
      ? m[ADAPTIVE_SNAPSHOT_KEY]
      : [];
    arr.push({
      at: new Date().toISOString(),
      schedule_id: scheduleId,
      expr_before: scheduleExprBefore,
      trigger,
    });
    m[ADAPTIVE_SNAPSHOT_KEY] = arr;
  });
}

export type AdaptiveWarningKind = "A_OUT_OF_RANGE" | "B_NO_ADJUSTMENT";

export interface AdaptiveWarning {
  scheduleId: string;
  scheduleName: string;
  taskId: string;
  kind: AdaptiveWarningKind;
  /** 当前 schedule_expr。 */
  currentExpr: string;
  /** 期望区间（分钟）。 */
  rangeMin: number;
  rangeMax: number;
  /** fire 时的 expr（B 校验时 = 未动）。 */
  fireExpr: string;
  /** 实测间隔分钟（A 校验 = 当前 schedule_expr 解析出的下次触发间隔）。 */
  actualIntervalMinutes?: number;
}

/**
 * 功能: A/B 校验 + 通知 —— 由 agent-runtime 在 task 转 completed/reviewing 时调用。
 *   schedule 没启用自适应 → no-op。
 *   schedule 启用但被软删 → no-op（race: schedule 被删后 task 仍收尾）。
 *
 * 关注点:
 *   - A 校验: schedule.schedule_expr (currentExpr) 解析成下次触发, 计算与 last_run
 *     (或 created_at 作为兜底) 的差 = 实际间隔分钟。不在区间 → warn。
 *   - B 校验: task.metadata.adaptive_snapshots 里 trigger=fire 的 expr_before ==
 *     currentExpr → 没动 → warn。A 和 B 可能同时命中（agent 调了 expr 但仍出区间），
 *     各发一条警告, 不合并。
 *   - 通知出口: sendFeishuWebhook, owner 配了 webhook 才发; 没配降级 console.warn
 *     （永不抛错, 校验失败不阻断 task 完成）。
 */
export async function checkAdaptiveFrequency(
  taskId: string,
  scheduleId: string
): Promise<{ warnings: AdaptiveWarning[] }> {
  const warnings: AdaptiveWarning[] = [];

  const schedule = getScheduleById(scheduleId);
  if (!schedule) return { warnings };
  if (schedule.freq_min_minutes == null || schedule.freq_max_minutes == null) {
    return { warnings };
  }

  const task = getTaskById(taskId);
  if (!task) return { warnings };

  const rangeMin = schedule.freq_min_minutes;
  const rangeMax = schedule.freq_max_minutes;
  const currentExpr = schedule.schedule_expr;

  // 找最近一次 fire 快照（trigger=fire, 同 schedule_id）。
  const meta = task.metadata ? JSON.parse(task.metadata) : {};
  const snaps: AdaptiveSnapshot[] = Array.isArray(meta[ADAPTIVE_SNAPSHOT_KEY])
    ? meta[ADAPTIVE_SNAPSHOT_KEY]
    : [];
  const fireSnap = [...snaps].reverse().find(
    (s) => s.trigger === "fire" && s.schedule_id === scheduleId
  );
  const fireExpr = fireSnap?.expr_before ?? currentExpr;

  // A 校验: 实际间隔分钟 = schedule.last_run ~ next_run 的差, last_run 缺失时
  //   用 task.created_at 兜底（首次 fire 后的 task, schedule.last_run 应当存在）。
  try {
    const interval = measureScheduleIntervalMinutes(schedule);
    if (interval != null && (interval < rangeMin || interval > rangeMax)) {
      warnings.push({
        scheduleId,
        scheduleName: schedule.name,
        taskId,
        kind: "A_OUT_OF_RANGE",
        currentExpr,
        rangeMin,
        rangeMax,
        fireExpr,
        actualIntervalMinutes: interval,
      });
    }
  } catch (err) {
    // expr 解析失败 = 用户/damo 改坏了, 不当 A 校验; B 校验照常。
    console.warn(
      `[adaptive-watcher] schedule ${scheduleId} expr parse failed: ${(err as Error).message}`
    );
  }

  // B 校验: agent 这轮没动 expr。
  if (currentExpr === fireExpr) {
    warnings.push({
      scheduleId,
      scheduleName: schedule.name,
      taskId,
      kind: "B_NO_ADJUSTMENT",
      currentExpr,
      rangeMin,
      rangeMax,
      fireExpr,
    });
  }

  // 写 check 快照（留痕）, 即使无 warning 也写, 便于日后审计。
  recordAdaptiveSnapshot(taskId, scheduleId, currentExpr, "check");

  // 通知
  for (const w of warnings) {
    await notifyAdaptiveWarning(schedule.owner_id ?? null, w);
  }

  return { warnings };
}

/**
 * 功能: 测量「当前 schedule_expr 落到下次的间隔分钟」。
 *   用 schedule.last_run 当锚点（如果存在）, 否则退回 schedule.next_run -
 *   schedule_expr 解析的前一次触发 = 期望的「上一轮」时刻。
 *
 * 关注点:
 *   - last_run 缺失时退到 created_at（注册时间, 但 created_at 比 next_run 早可能
 *     算出很大值, 这种情况应该当「区间未知」返 null 而非发错警告）。
 *   - 解析失败（cron 表达式被改坏）返 null, 不当区间违规。
 */
function measureScheduleIntervalMinutes(schedule: Schedule): number | null {
  if (schedule.schedule_type !== "cron") return null;

  const interval = CronExpressionParser.parse(schedule.schedule_expr, {
    tz: schedule.timezone || "Asia/Shanghai",
  });
  // 取下一个触发时刻。
  const next = interval.next().toDate();

  // 锚点: last_run（已知）> created_at（兜底但有可能比 next 早太多, 那就返 null）。
  let anchor: Date | null = null;
  if (schedule.last_run) {
    anchor = new Date(schedule.last_run);
  } else if (schedule.created_at) {
    anchor = new Date(schedule.created_at);
  }
  if (!anchor) return null;
  if (anchor.getTime() >= next.getTime()) return null;

  const diffMs = next.getTime() - anchor.getTime();
  return Math.round(diffMs / 60_000);
}

/**
 * 功能: 发警告 —— 飞书 webhook + email 双渠道（与 notify skill 一致）。
 *   owner 未配 webhook/notify_email 时各渠道降级 console.warn, 永不抛错。
 *   通知类型语义标识 = "schedule_adaptive_warning" (前缀 [adaptive] 拼在 subject)。
 */
async function notifyAdaptiveWarning(
  ownerId: string | null,
  w: AdaptiveWarning
): Promise<void> {
  const subject =
    w.kind === "A_OUT_OF_RANGE"
      ? `[adaptive] "${w.scheduleName}" expr 出区间`
      : `[adaptive] "${w.scheduleName}" 本轮未调 expr`;

  const lines: string[] = [
    `task_id: ${w.taskId}`,
    `schedule: ${w.scheduleName} (${w.scheduleId})`,
    `kind: ${w.kind}`,
    `current expr: ${w.currentExpr}`,
    `fire expr: ${w.fireExpr}`,
    `expected range: [${w.rangeMin}, ${w.rangeMax}] 分钟`,
  ];
  if (w.kind === "A_OUT_OF_RANGE") {
    lines.push(`actual interval: ${w.actualIntervalMinutes} 分钟`);
  }
  if (w.kind === "B_NO_ADJUSTMENT") {
    lines.push(`hint: 任务收尾前调 cron.sh update ${w.scheduleId} --expr "<新 expr>"`);
  }
  const message = `⚠️ ${subject}\n` + lines.join("\n");

  // 飞书渠道: 仅当 owner 配了 webhook 才发, 没配降级 console.warn。
  const owner = ownerId ? getUserById(ownerId) : null;
  const webhookUrl = owner?.feishu_webhook_url;
  if (webhookUrl) {
    const result = await sendFeishuWebhook({ webhookUrl, message, msgType: "markdown" });
    if (!result.sent) {
      console.warn(
        `[adaptive-watcher] feishu send failed for schedule ${w.scheduleId}: ${result.reason ?? "?"}`
      );
    }
  } else {
    console.warn(
      `[adaptive-watcher] no feishu webhook for owner ${ownerId ?? "?"}, msg:\n${message}`
    );
  }

  // 邮件渠道: sendNotifyToUser 内部走 NOTIFY_FALLBACK_TO + user.notify_email,
  //   无收件人 / SMTP 未配时静默不抛错(永远 sent:false, warn 一条)。
  const mailRes = await sendNotifyToUser(ownerId, {
    subject,
    text: message,
  });
  if (!mailRes.sent && mailRes.reason && mailRes.reason !== "no recipient configured") {
    console.warn(
      `[adaptive-watcher] email send failed for schedule ${w.scheduleId}: ${mailRes.reason}`
    );
  }
}