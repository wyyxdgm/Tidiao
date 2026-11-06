// Scheduled task CRUD + trigger helpers.
//
// A "schedule" is a repeat rule that, when due, spawns a one-shot execution:
//   - exec_type='agent': creates a Task + starts it (reuses TaskScheduler)
//   - exec_type='shell': runs a shell command directly (no agent, no queue)
// The runner (src/lib/runtime/schedule-runner.ts) polls listDueSchedules()
// every 60s and fires whichever schedules have next_run <= now.

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import { getProjectById } from "./projects";
import { CronExpressionParser } from "cron-parser";
import type { EffortLevel } from "../runtime/types";
import { parseStrArray, stringifyStrArray } from "../json-array";

export type ExecType = "agent" | "shell";
export type ScheduleType = "cron" | "once";

interface ScheduleRow {
  id: string;
  name: string;
  exec_type: string;
  title: string | null;
  prompt: string | null;
  description: string | null;
  project_id: string | null;
  version_id: string | null;
  priority: number;
  auto_approve: number;
  model: string | null;
  allowed_tools: string | null;
  max_turns: number | null;
  effort: string | null;
  tags: string | null;
  command: string | null;
  cwd: string | null;
  schedule_type: string;
  schedule_expr: string;
  timezone: string;
  enabled: number;
  next_run: string;
  last_run: string | null;
  last_task_id: string | null;
  last_exit_code: number | null;
  skip_if_running: number;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  // 🆕 自适应频率模式（v60）—— agent schedule 自选下轮 expr 的区间（分钟）。
  // 两列要么都 NULL（关闭），要么都非 NULL（启用）。详见 migration 注释。
  freq_min_minutes: number | null;
  freq_max_minutes: number | null;
  // 🆕 飞书 R96 智能降频（v70）—— 三列要么都 NULL（关闭），要么都非 NULL（启用）。
  //   night_start_hour / night_end_hour: 0-23 的整数小时，定义 [start, end) 窗口（跨午夜时 start > end）。
  //   night_schedule_expr: 窗口内的低频 cron 表达式（如 "*/30 * * * *"）。
  night_start_hour: number | null;
  night_end_hour: number | null;
  night_schedule_expr: string | null;
  // 🆕 v68 软删除时间戳。NULL = 活跃; 非 NULL = 软删除时刻 (ISO 8601 UTC)。
  // listSchedules 默认过滤 deleted_at IS NULL, 调用方传 includeDeleted=true 才返回。
  // runner 走 listDueSchedules(enabled=1) 天然不触, 无须改 runner。
  deleted_at: string | null;
}

export interface Schedule {
  id: string;
  name: string;
  exec_type: ExecType;
  title: string | null;
  prompt: string | null;
  description: string | null;
  project_id: string | null;
  version_id: string | null;
  priority: number;
  auto_approve: boolean;
  model: string | null;
  allowed_tools: string[] | null;
  max_turns: number | null;
  effort: EffortLevel | null;
  tags: string[] | null;
  command: string | null;
  cwd: string | null;
  schedule_type: ScheduleType;
  schedule_expr: string;
  timezone: string;
  enabled: boolean;
  next_run: string;
  last_run: string | null;
  last_task_id: string | null;
  last_exit_code: number | null;
  skip_if_running: boolean;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  freq_min_minutes: number | null;
  freq_max_minutes: number | null;
  // 🆕 飞书 R96 智能降频（v70）字段。
  night_start_hour: number | null;
  night_end_hour: number | null;
  night_schedule_expr: string | null;
  // 🆕 v68 软删除时间戳; listSchedules 默认隐藏, includeDeleted=true 才返回。
  deleted_at: string | null;
}

export interface ScheduleDefinition {
  name: string;
  exec_type: ExecType;
  // agent fields
  title?: string;
  prompt?: string;
  description?: string;
  project_id?: string;
  version_id?: string | null;
  priority?: number;
  // 🔴 agent 类型不接受外部 auto_approve —— cron agent schedule 是无人值守,
  //   外部设 false 等于「半夜没人批 → SDK 子进程挂死」(2026-08-31 GDM 事故)。
  //   字段仍保留在接口里（shell 类型要用），但 createSchedule 对 agent 类型
  //   强制 true，外部值忽略。运行时再由 schedule-runner 的 fireAgent 写死 true,
  //   即便 DB 行被 SQL 改成 0 也不生效。
  auto_approve?: boolean;
  model?: string;
  allowed_tools?: string[];
  max_turns?: number;
  effort?: EffortLevel;
  tags?: string[];
  // 平台派发不再限制 max_turns（默认不限）。想保留低值时设 true。
  force_max_turns?: boolean;
  // shell fields
  command?: string;
  // shared
  cwd?: string;
  // schedule
  schedule_type: ScheduleType;
  schedule_expr: string;
  timezone?: string;
  skip_if_running?: boolean;
  enabled?: boolean;
  // 🆕 自适应频率（v60）：agent + cron 专用，shell/once 不接受。
  // 两字段要么都传要么都不传；service 层会校验 + 区间合法性。
  freq_min_minutes?: number | null;
  freq_max_minutes?: number | null;
  // 🆕 飞书 R96 智能降频（v70）：任意 exec_type + cron 专用，once 不接受。
  // 三字段要么都传要么都不传；service 层会校验 + 区间合法性 + cron 解析。
  night_start_hour?: number | null;
  night_end_hour?: number | null;
  night_schedule_expr?: string | null;
  ownerId?: string;
}

// 🔴 undefined 与 null 语义不同, 别混:
//   - 键不存在 / undefined = 不改这个字段
//   - 显式 null = 置空（对 max_turns 就是「不限轮次」, 运行时回落到默认 200）
// 把 null 当 undefined 处理 = 「放开限制」这个操作永远做不到（本文件曾经的 bug）。
export interface ScheduleUpdate {
  name?: string;
  enabled?: boolean;
  schedule_type?: ScheduleType;
  schedule_expr?: string;
  timezone?: string;
  skip_if_running?: boolean;
  title?: string | null;
  prompt?: string | null;
  command?: string | null;
  cwd?: string | null;
  // agent 执行参数（2026-08-13 前 update 静默丢弃这一批, 见 docs 报告）
  description?: string | null;
  project_id?: string | null;
  version_id?: string | null;
  priority?: number;
  // 🔴 auto_approve 已从 ScheduleUpdate 移除 —— 见 ScheduleDefinition 注释。
  //   PATCH 路由会用 UPDATABLE_SCHEDULE_FIELDS 把它判成 unknown_fields 返 400。
  model?: string | null;
  allowed_tools?: string[] | null;
  max_turns?: number | null;
  effort?: EffortLevel | null;
  tags?: string[] | null;
  // 平台派发不再限制 max_turns（默认行为 = 不限，落库默认 200）。
  // 真要保留低值就 force_max_turns:true。仅内部调用，不进 UPDATABLE 路由白名单。
  force_max_turns?: boolean;
  // 🆕 自适应频率（PATCH 允许清空 = null = 关闭）。
  freq_min_minutes?: number | null;
  freq_max_minutes?: number | null;
  // 🆕 飞书 R96 智能降频（v70，PATCH 允许清空 = null = 关闭）。
  night_start_hour?: number | null;
  night_end_hour?: number | null;
  night_schedule_expr?: string | null;
}

// 白名单 = updateSchedule 真正会写的键。路由用它把「传了后端不认识的键」
// 变成 400, 而不是一个长得像成功的 200（本 bug 最难查的部分就是它没声音）。
// 🔴 auto_approve 已从白名单移除 —— agent schedule 必须开, 不接受外部关;
//   PATCH body 带 auto_approve 直接 400 unknown_fields, 见 ScheduleUpdate 注释。
export const UPDATABLE_SCHEDULE_FIELDS = [
  "name", "enabled", "schedule_type", "schedule_expr", "timezone",
  "skip_if_running", "title", "prompt", "command", "cwd",
  "description", "project_id", "version_id", "priority",
  "model", "allowed_tools", "max_turns", "effort", "tags",
  // 🆕 v60 自适应频率
  "freq_min_minutes", "freq_max_minutes",
  // 🆕 飞书 R96 智能降频（v70）
  "night_start_hour", "night_end_hour", "night_schedule_expr",
] as const;

const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    exec_type: row.exec_type as ExecType,
    title: row.title,
    prompt: row.prompt,
    description: row.description,
    project_id: row.project_id,
    version_id: row.version_id,
    priority: row.priority,
    auto_approve: row.auto_approve === 1,
    model: row.model,
    allowed_tools: row.allowed_tools ? parseStrArray(row.allowed_tools) : null,
    max_turns: row.max_turns,
    effort: row.effort as EffortLevel | null,
    tags: row.tags ? parseStrArray(row.tags) : null,
    command: row.command,
    cwd: row.cwd,
    schedule_type: row.schedule_type as ScheduleType,
    schedule_expr: row.schedule_expr,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    next_run: row.next_run,
    last_run: row.last_run,
    last_task_id: row.last_task_id,
    last_exit_code: row.last_exit_code,
    skip_if_running: row.skip_if_running === 1,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    freq_min_minutes: row.freq_min_minutes,
    freq_max_minutes: row.freq_max_minutes,
    night_start_hour: row.night_start_hour,
    night_end_hour: row.night_end_hour,
    night_schedule_expr: row.night_schedule_expr,
    deleted_at: row.deleted_at,
  };
}

// Next fire time for a schedule. 'once' has no recurrence -> null (caller
// disables). 'cron' -> next future point per cron-parser.
export function computeNextRun(s: {
  schedule_type: string;
  schedule_expr: string;
  timezone?: string;
}): string | null {
  if (s.schedule_type === "once") return null;
  const next = CronExpressionParser.parse(s.schedule_expr, {
    tz: s.timezone || "Asia/Shanghai",
  }).next();
  return next.toISOString();
}

// 🆕 飞书 R96 智能降频（v70）—— 辅助：判断给定「schedule timezone 下的 hour」是否在夜间窗口。
//   窗口语义: [start, end)（end 不含），跨午夜场景 start > end 时反向判断。
//   start == end 返回 false（零长度窗口 = 未启用；上层不会传等值进这里）。
//   关注点: 用 Date#getHours 在 schedule tz 下取小时，避免 UTC 漂移导致凌晨错位。
export function isHourInNightWindow(
  hour: number,
  startHour: number,
  endHour: number
): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // wrap-around midnight: hour >= start OR hour < end
  return hour >= startHour || hour < endHour;
}

// 🆕 飞书 R96 智能降频（v70）—— 智能降频版 next_run 计算。
//   入参同 computeNextRun + 3 个 night_* 字段（全 NULL = 不启用）。
//   关注点:
//   - schedule_type=once 直接退回 computeNextRun（一次性没窗口意义）。
//   - 三个 night 字段全 NULL = 不启用，行为完全等同 computeNextRun（保留旧行为）。
//   - 三个 night 字段有任一非 NULL 但不齐全 = throw（service 层校验兜底，这里再兜一层防绕路）。
//   - 计算: 用 schedule_expr 算出 next1；若 next1 落地时刻（schedule tz 下）落在
//     夜间窗口，再用 night_schedule_expr 算 next2；取 max(next1, next2) 作为最终 next_run。
//     直观理解: 当 next1 是「即将跨入夜间」的时刻（比如 22:55 用 */5 算出 23:00），
//     而夜间 expr 比白天频次低，max 选较晚的避免「白天末班跑太密」。
//   - 边界: night_expr 不在夜间窗口内（配错）会一直 next2 == null → 抛错；
//     catch 后退回 next1（让 runner 至少能跑，但 description/CLI 应能识别）。
export function computeNextRunWithNight(s: {
  schedule_type: string;
  schedule_expr: string;
  timezone?: string;
  night_start_hour?: number | null;
  night_end_hour?: number | null;
  night_schedule_expr?: string | null;
}): string | null {
  if (s.schedule_type === "once") {
    return computeNextRun(s);
  }
  const startHour = s.night_start_hour;
  const endHour = s.night_end_hour;
  const nightExpr = s.night_schedule_expr;
  const nightEnabled =
    startHour != null && endHour != null && nightExpr != null && nightExpr !== "";
  if (!nightEnabled) {
    return computeNextRun(s);
  }
  if (startHour === endHour) {
    throw new Error("night_start_hour 与 night_end_hour 不能相等");
  }
  const tz = s.timezone || "Asia/Shanghai";

  // 第一步: schedule_expr 算出 next1
  const next1Str = computeNextRun(s);
  if (!next1Str) return null;
  const next1 = new Date(next1Str);

  // 第二步: 若 next1 落在夜间窗口，用 night_expr 算 next2
  // hourCycle: "h23" 强制 0-23（部分 Node ICU 默认会回 24），避免午夜错位。
  const next1HourInTz = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: tz,
    }).format(next1)
  );
  if (!isHourInNightWindow(next1HourInTz, startHour, endHour)) {
    return next1Str;
  }
  try {
    const next2Str = CronExpressionParser.parse(nightExpr, { tz }).next().toISOString();
    // next2 可能 null（cron-parser 在某些极端情况下 .next() 返回 undefined 经 toISOString 转 null）
    // 视为 night_expr 不可用, 退回 next1.
    if (!next2Str) return next1Str;
    // 跨天边界: next2 可能早于 next1（night_expr 用 */30 但 next1 落在 23:30 时 next2=00:00）
    // —— 这种情况取晚的那个, 让 schedule 自然推进, 不强行卡死夜间 expr。
    return next2Str > next1Str ? next2Str : next1Str;
  } catch (err) {
    // night_expr 解析失败 = 配置错, 退回 schedule_expr 的结果, 至少行为可用。
    console.warn(
      `[schedules.computeNextRunWithNight] night_schedule_expr 解析失败: ${(err as Error).message}`
    );
    return next1Str;
  }
}

function validateDefinition(def: ScheduleDefinition): void {
  if (def.exec_type === "agent") {
    if (!def.title || !def.prompt) {
      throw new Error("agent schedule requires title and prompt");
    }
    if (!def.project_id) {
      throw new Error("agent schedule requires project_id");
    }
  } else if (def.exec_type === "shell") {
    if (!def.command) {
      throw new Error("shell schedule requires command");
    }
  } else {
    throw new Error(`invalid exec_type: ${def.exec_type}`);
  }
  if (def.schedule_type !== "cron" && def.schedule_type !== "once") {
    throw new Error(`invalid schedule_type: ${def.schedule_type}`);
  }
  if (!def.schedule_expr) {
    throw new Error("schedule_expr is required");
  }

  // 🆕 Bug fix: schedule_expr 格式必须与 schedule_type 匹配。
  //   - once: 必须能 Date.parse 为有效 ISO 8601 时间
  //   - cron: 必须能 CronExpressionParser 解析（带 schedule 时区）
  // 历史事故 (2026-09-14): schedule b366fead-... 是 once + "3 0 * * *"（cron 表达式）。
  //   computeNextRun 对 once 直接 return null → next_run 落库为原字符串
  //   → listDueSchedules 永远不选中 → enabled=true 但 22h+ 没触发。本校验让
  //   create/update 阶段就报错（CLI 与 API 走同一条 service 层链路）。
  if (def.schedule_type === "once") {
    // 严格 ISO 8601 正则（YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]）。
    // 不直接用 Date.parse —— 实测 Node 22 的 Date.parse("0 9 * * *") = 967737600000
    //   （被解释成 2000-08-09 之类的有效时间），松校验会把这种 cron 形状的字符串
    //   当成 ISO 通过, 触发不了本闸门, 形同虚设。
    const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
    if (!ISO_RE.test(def.schedule_expr)) {
      throw new Error(
        `schedule_type=once requires ISO 8601 datetime (e.g. 2099-01-01T00:00:00Z), got: "${def.schedule_expr}" ` +
        `(hint: cron expression belongs to schedule_type=cron)`
      );
    }
  } else if (def.schedule_type === "cron") {
    try {
      CronExpressionParser.parse(def.schedule_expr, {
        tz: def.timezone || "Asia/Shanghai",
      });
    } catch (err) {
      throw new Error(
        `invalid cron schedule_expr "${def.schedule_expr}": ${(err as Error).message}`
      );
    }
  }

  // 🆕 v60 自适应频率校验：
  //   - agent + cron 才允许带 freq_min/max（shell/once 拒）。
  //   - 两字段要么都填要么都不填（一个填一个空 = 错）。
  //   - 必须是 >= 1 的整数（分钟）。
  //   - min <= max。
  // 注意：service 层校验防的是「混搭语义」（def 传参 1 字段 + ScheduleUpdate 改 1
  //   字段正好把另一边清空的情况，由 updateSchedule 内的等价校验兜底）。
  const hasMin = def.freq_min_minutes !== undefined && def.freq_min_minutes !== null;
  const hasMax = def.freq_max_minutes !== undefined && def.freq_max_minutes !== null;
  if (hasMin || hasMax) {
    if (def.exec_type !== "agent" || def.schedule_type !== "cron") {
      throw new Error(
        "freq_min/max 只允许 agent + cron schedule; shell/once 频率区间无意义"
      );
    }
    if (hasMin !== hasMax) {
      throw new Error("freq_min_minutes 与 freq_max_minutes 必须同时设置或同时为空");
    }
    for (const [name, v] of [
      ["freq_min_minutes", def.freq_min_minutes],
      ["freq_max_minutes", def.freq_max_minutes],
    ] as const) {
      if (!Number.isInteger(v!) || v! < 1) {
        throw new Error(`invalid ${name}: ${v} (need integer >= 1)`);
      }
    }
    if (def.freq_min_minutes! > def.freq_max_minutes!) {
      throw new Error(
        `freq_min_minutes (${def.freq_min_minutes}) 不能大于 freq_max_minutes (${def.freq_max_minutes})`
      );
    }
  }

  // 🆕 飞书 R96 智能降频校验（v70）：
  //   - 仅 cron 接受（once 无窗口意义，shell 实际上 cron 也可，但语义重复所以限定 cron）。
  //   - 三字段要么都填要么都不填（一个填一个空 = 错）。
  //   - start/end 必须是 0-23 的整数小时；start != end（零长度窗口无意义）。
  //   - night_schedule_expr 必须是合法 cron 表达式（让 cron-parser 抛错定位）。
  const hasStart = def.night_start_hour !== undefined && def.night_start_hour !== null;
  const hasEnd = def.night_end_hour !== undefined && def.night_end_hour !== null;
  const hasNightExpr = def.night_schedule_expr !== undefined && def.night_schedule_expr !== null;
  if (hasStart || hasEnd || hasNightExpr) {
    if (def.schedule_type !== "cron") {
      throw new Error("night_* 字段仅 cron schedule 支持；once 一次性无窗口意义");
    }
    if (hasStart !== hasEnd || hasStart !== hasNightExpr) {
      throw new Error(
        "night_start_hour / night_end_hour / night_schedule_expr 必须同时设置或同时为空"
      );
    }
    for (const [name, v] of [
      ["night_start_hour", def.night_start_hour],
      ["night_end_hour", def.night_end_hour],
    ] as const) {
      if (!Number.isInteger(v!) || v! < 0 || v! > 23) {
        throw new Error(`invalid ${name}: ${v} (need integer in [0, 23])`);
      }
    }
    if (def.night_start_hour === def.night_end_hour) {
      throw new Error(
        `night_start_hour 与 night_end_hour 不能相等（零长度窗口无意义）`
      );
    }
    try {
      CronExpressionParser.parse(def.night_schedule_expr!, {
        tz: def.timezone || "Asia/Shanghai",
      });
    } catch (err) {
      throw new Error(
        `invalid night_schedule_expr: ${def.night_schedule_expr} (${(err as Error).message})`
      );
    }
  }
}

export function createSchedule(def: ScheduleDefinition): Schedule {
  validateDefinition(def);

  // 平台规则: max_turns < 200 不抛错, 直接 console.warn 并 clamp 到 200。
  // 真要保留低值就 force_max_turns:true（仅供脚本/内部调用, 不进路由白名单）。
  // 非整数仍 throw（malformed, 不是「太低」）。
  if (def.max_turns !== undefined && def.max_turns !== null
      && !Number.isInteger(def.max_turns)) {
    throw new Error(`invalid max_turns: ${def.max_turns} (need integer or null)`);
  }
  if (def.max_turns !== undefined && def.max_turns !== null
      && def.max_turns < 200 && !def.force_max_turns) {
    console.warn(
      `[schedules.create] max_turns=${def.max_turns} < 200, clamping to 200 ` +
      `(pass force_max_turns:true to keep the original value)`
    );
    def.max_turns = 200;
  }

  // 🆕 飞书 R95: description 缺失软告警。description 是排查事故时的"这个 cron 是
  //   干嘛的"快速定位线索，damo 0825 拍板"新加的又没填就警告"。soft-warn 约定
  //   与 max_turns < 200 一致：console.warn + 继续写入，绝不 throw。
  //   4 个创建入口（API POST/PATCH + cron.sh + UI 新建/编辑）走同一条 service
  //   层链路，在这里加一次 = 全部覆盖。空串 / 纯空白 / null 都视为"没填"。
  if (def.description == null || String(def.description).trim() === "") {
    console.warn(
      `[schedules.create] schedule "${def.name}" 没填 description —— 排查事故时不利快速定位意图 (R95)`
    );
  }

  // Agent schedules: verify project ownership when ownerId is given.
  if (def.exec_type === "agent" && def.project_id && def.ownerId) {
    const project = getProjectById(def.project_id, def.ownerId);
    if (!project) {
      throw new Error(`Project ${def.project_id} not found`);
    }
  }

  // Compute initial next_run. 飞书 R96: 启用了智能降频就走带 night 的版本。
  const nextRun =
    def.schedule_type === "once"
      ? def.schedule_expr
      : computeNextRunWithNight({
          schedule_type: def.schedule_type,
          schedule_expr: def.schedule_expr,
          timezone: def.timezone || "Asia/Shanghai",
          night_start_hour: def.night_start_hour ?? null,
          night_end_hour: def.night_end_hour ?? null,
          night_schedule_expr: def.night_schedule_expr ?? null,
        })!;

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO schedules (
      id, name, exec_type, title, prompt, description, project_id, version_id,
      priority, auto_approve, model, allowed_tools, max_turns, effort, tags,
      command, cwd, schedule_type, schedule_expr, timezone,
      enabled, next_run, skip_if_running, owner_id, created_at, updated_at,
      freq_min_minutes, freq_max_minutes,
      night_start_hour, night_end_hour, night_schedule_expr
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    def.name,
    def.exec_type,
    def.exec_type === "agent" ? (def.title ?? null) : null,
    def.exec_type === "agent" ? (def.prompt ?? null) : null,
    def.description ?? null,
    def.project_id ?? null,
    def.version_id ?? null,
    def.priority ?? 0,
    // 🔴 agent schedule 强制 auto_approve=1 —— 无人值守, 半夜没人批 = SDK 子进程挂死
    //   (2026-08-31 GDM 事故)。shell schedule 不受影响（shell 本就要人审）,
    //   def.auto_approve 仍按用户输入落库, 未传则 0。
    def.exec_type === "agent" ? 1 : (def.auto_approve ? 1 : 0),
    def.model ?? null,
    def.allowed_tools ? stringifyStrArray(def.allowed_tools) : null,
    def.max_turns ?? null,
    def.effort ?? null,
    def.tags ? stringifyStrArray(def.tags) : null,
    def.exec_type === "shell" ? (def.command ?? null) : null,
    def.cwd ?? null,
    def.schedule_type,
    def.schedule_expr,
    def.timezone || "Asia/Shanghai",
    def.enabled === false ? 0 : 1,
    nextRun,
    def.skip_if_running === false ? 0 : 1,
    def.ownerId ?? null,
    now,
    now,
    // 🆕 v60: 自适应频率。两字段必须同步（validateDefinition 已校验），
    //   未传则 NULL = 关闭自适应。
    def.freq_min_minutes ?? null,
    def.freq_max_minutes ?? null,
    // 🆕 飞书 R96 智能降频（v70）。三字段已校验，未传则 NULL = 关闭。
    def.night_start_hour ?? null,
    def.night_end_hour ?? null,
    def.night_schedule_expr ?? null
  );

  return getScheduleById(id)!;
}

export function getScheduleById(id: string, userId?: string): Schedule | null {
  const sql = userId
    ? "SELECT * FROM schedules WHERE id = ? AND owner_id = ?"
    : "SELECT * FROM schedules WHERE id = ?";
  const row = getDb()
    .prepare(sql)
    .get(...(userId ? [id, userId] : [id])) as ScheduleRow | undefined;
  return row ? toSchedule(row) : null;
}

// 🆕 飞书 R92: 时间区间筛选参数。
//   - lastRunFrom/To: 筛 last_run（上次执行）落在区间内。
//   - nextRunFrom/To: 筛 next_run（下次执行）落在区间内。
//   - 每个区间参数要么都传要么都不传（半传 = 静默忽略半边，避免「只设了 from 没设 to = 全砍」误操作）。
//   - NULL 值不算在区间内 —— 即「未执行过」的 schedule 不会因为 from=0 而被显示出来。
//     这是 damo 在 R92 行 R 列拍板：未执行的不算。
export interface ListSchedulesTimeRange {
  lastRunFrom?: string;
  lastRunTo?: string;
  nextRunFrom?: string;
  nextRunTo?: string;
  // 🆕 R92 第二批: versionId 精确匹配 (空字符串/未传 = 不过滤)。
  //   跟前置 projectId 是叠加关系 —— 可单筛 version, 也可「先 project 后 version」组合。
  //   飞书 AO-DEV R218: null (显式) = 只看未挂版本的 schedule (version_id IS NULL)。
  versionId?: string | null;
  // 🆕 启用状态筛选: true = 只看启用, false = 只看停用, undefined = 不过滤。
  enabled?: boolean;
}

function isIsoString(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && !Number.isNaN(Date.parse(s));
}

export function listSchedules(
  userId?: string,
  projectId?: string,
  opts: { includeDeleted?: boolean } & ListSchedulesTimeRange = {}
): Schedule[] {
  const db = getDb();
  let sql = "SELECT * FROM schedules";
  const params: unknown[] = [];
  const conds: string[] = [];
  // 🆕 v68 软删除过滤: 默认隐藏, includeDeleted=true 才返回软删除行。
  if (!opts.includeDeleted) {
    conds.push("deleted_at IS NULL");
  }
  if (userId) {
    conds.push("owner_id = ?");
    params.push(userId);
  }
  if (projectId) {
    conds.push("project_id = ?");
    params.push(projectId);
  }
  // 🆕 R92 第二批反馈: 版本筛选（精确匹配）。空字符串 / undefined 一律不推 WHERE，
  //   与 projectId 保持一致语义 (空 = 不过滤)。damo 0830 R 列明确要求过。
  //   飞书 AO-DEV R218: 显式 null = 只看未挂版本 (version_id IS NULL)。
  if (opts.versionId === null) {
    conds.push("version_id IS NULL");
  } else if (opts.versionId) {
    conds.push("version_id = ?");
    params.push(opts.versionId);
  }
  // 🆕 启用状态筛选。布尔入 SQLite 是 1/0, 与 listDueSchedules 的 enabled = 1 同语义。
  if (opts.enabled !== undefined) {
    conds.push("enabled = ?");
    params.push(opts.enabled ? 1 : 0);
  }
  // 🆕 飞书 R92: 时间区间筛选。两组都按「NULL 不算在区间内」处理（damo 拍板）。
  //   半传 = 忽略半边, 由 isIsoString 把无效值兜成 undefined。
  if (isIsoString(opts.lastRunFrom) && isIsoString(opts.lastRunTo)) {
    conds.push("last_run IS NOT NULL AND last_run BETWEEN ? AND ?");
    params.push(opts.lastRunFrom, opts.lastRunTo);
  }
  if (isIsoString(opts.nextRunFrom) && isIsoString(opts.nextRunTo)) {
    conds.push("next_run IS NOT NULL AND next_run BETWEEN ? AND ?");
    params.push(opts.nextRunFrom, opts.nextRunTo);
  }
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(...params) as ScheduleRow[];
  return rows.map(toSchedule);
}

// Schedules whose next_run is due. Used by the runner tick.
export function listDueSchedules(nowIso: string): Schedule[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run <= ? ORDER BY next_run ASC"
    )
    .all(nowIso) as ScheduleRow[];
  return rows.map(toSchedule);
}

// Atomically claim a due schedule by advancing its next_run past now. Returns
// true if this caller won the claim (defends against a future multi-process
// deploy; in single-process today it's always won, but the UPDATE...WHERE
// next_run=? guard makes it safe regardless).
export function claimSchedule(id: string, currentNextRun: string, newNextRun: string): boolean {
  const db = getDb();
  const res = db
    .prepare("UPDATE schedules SET next_run = ? WHERE id = ? AND next_run = ?")
    .run(newNextRun, id, currentNextRun);
  return res.changes > 0;
}

// 功能: 按 ScheduleUpdate 里「显式出现的键」增量更新一条 schedule, 返回更新后的行
//   （不存在 / 不属于 userId -> null）。
// 关注点:
//   - `undefined` = 不改; `null` = 置空。所有判断一律用 `!== undefined`, 不许用
//     truthy（否则 0 / "" / null 会被当成「没传」——这就是 max_turns 放不开的原因）。
//   - 新增字段必须同时加进 UPDATABLE_SCHEDULE_FIELDS, 否则路由会把它当未知键拒掉。
//   - schedule_type/expr/timezone 变了要重算 next_run。
export function updateSchedule(
  id: string,
  updates: ScheduleUpdate,
  userId?: string
): Schedule | null {
  const db = getDb();
  const existing = getScheduleById(id, userId);
  if (!existing) return null;

  if (updates.effort !== undefined && updates.effort !== null
      && !EFFORT_LEVELS.includes(updates.effort)) {
    throw new Error(`invalid effort: ${updates.effort}`);
  }
  // 平台规则: max_turns < 200 不抛错, 直接 console.warn 并 clamp 到 200。
  // 真要保留低值就 force_max_turns:true（仅供脚本/内部调用, 不进 UPDATABLE 路由白名单）。
  // 非整数仍 throw（malformed, 不是「太低」）。
  if (updates.max_turns !== undefined && updates.max_turns !== null
      && !Number.isInteger(updates.max_turns)) {
    throw new Error(`invalid max_turns: ${updates.max_turns} (need integer or null)`);
  }
  if (updates.max_turns !== undefined && updates.max_turns !== null
      && updates.max_turns < 200 && !updates.force_max_turns) {
    console.warn(
      `[schedules.update] max_turns=${updates.max_turns} < 200, clamping to 200 ` +
      `(pass force_max_turns:true to keep the original value)`
    );
    updates.max_turns = 200;
  }

  // 🆕 飞书 R95: description 显式清空软告警。语义与 create 对称：
  //   - updates.description 是 undefined = "没传这个键"，不动原值 → 不警告
  //     （用户只想改别的字段，顺便警告就成噪声）；
  //   - updates.description 是 null / "" / 纯空白 = "主动清空" → warn。
  //   避免 PATCH 只改 name 顺手吃警告的副作用。
  if (updates.description !== undefined
      && (updates.description == null || String(updates.description).trim() === "")) {
    console.warn(
      `[schedules.update] schedule ${existing.id} (${existing.name}) 把 description 清空 —— 排查事故时不利快速定位意图 (R95)`
    );
  }

  // 🆕 v60 自适应频率：PATCH 也要校验。
  // 语义同 createSchedule: 都填或都不填 + 区间合法 + 仅 agent + cron。
  // 边界：PATCH 只传一个字段 + 库里另一边已存在 → 校验合成后的「现态」——
  //   这样 PATCH 单边清空时另一边的同步校验会失败, 避免「min=10, max=null」半态落库。
  const updMinProvided = updates.freq_min_minutes !== undefined;
  const updMaxProvided = updates.freq_max_minutes !== undefined;
  if (updMinProvided || updMaxProvided) {
    if (existing.exec_type !== "agent" || existing.schedule_type !== "cron") {
      throw new Error(
        "freq_min/max 只允许 agent + cron schedule; shell/once 频率区间无意义"
      );
    }
    const effMin = updMinProvided ? updates.freq_min_minutes : existing.freq_min_minutes;
    const effMax = updMaxProvided ? updates.freq_max_minutes : existing.freq_max_minutes;
    // 两边都未提供（被清成 null）= 关闭自适应, 不做校验。
    if (effMin !== null || effMax !== null) {
      if (effMin === null || effMax === null) {
        throw new Error("freq_min_minutes 与 freq_max_minutes 必须同时设置或同时为空");
      }
      // ts: 上面分支配对检查过, 这里再 non-null 收一遍让后面 ts 推断干净.
      const minVal = effMin as number;
      const maxVal = effMax as number;
      for (const [name, v] of [
        ["freq_min_minutes", minVal],
        ["freq_max_minutes", maxVal],
      ] as const) {
        if (!Number.isInteger(v) || v < 1) {
          throw new Error(`invalid ${name}: ${v} (need integer >= 1)`);
        }
      }
      if (minVal > maxVal) {
        throw new Error(
          `freq_min_minutes (${minVal}) 不能大于 freq_max_minutes (${maxVal})`
        );
      }
    }
  }

  // 🆕 飞书 R96 智能降频（v70）PATCH 校验：与 createSchedule 等价，按「显式提供的字段 + 现态」合成。
  const updStartProvided = updates.night_start_hour !== undefined;
  const updEndProvided = updates.night_end_hour !== undefined;
  const updExprProvided = updates.night_schedule_expr !== undefined;
  if (updStartProvided || updEndProvided || updExprProvided) {
    if (existing.schedule_type !== "cron") {
      throw new Error("night_* 字段仅 cron schedule 支持；once 一次性无窗口意义");
    }
    const effStart = updStartProvided ? updates.night_start_hour : existing.night_start_hour;
    const effEnd = updEndProvided ? updates.night_end_hour : existing.night_end_hour;
    const effExpr = updExprProvided ? updates.night_schedule_expr : existing.night_schedule_expr;
    // 三边都未提供（都显式清空）= 关闭智能降频, 不做校验。
    if (effStart !== null || effEnd !== null || effExpr !== null) {
      // ts: 上面的 OR 已经保证至少一个非 null
      const providedCount =
        (updStartProvided ? 1 : 0) + (updEndProvided ? 1 : 0) + (updExprProvided ? 1 : 0);
      const fullProvidedCount =
        (effStart !== null ? 1 : 0) + (effEnd !== null ? 1 : 0) + (effExpr !== null ? 1 : 0);
      if (providedCount > 0 && providedCount < 3) {
        throw new Error(
          "night_start_hour / night_end_hour / night_schedule_expr 必须同时设置或同时清空"
        );
      }
      if (fullProvidedCount !== 3) {
        throw new Error(
          "night_* 三个字段合成后必须同时设置（PATCH 一次提交 3 字段，或库里已有 + 本次补齐）"
        );
      }
      const startVal = effStart as number;
      const endVal = effEnd as number;
      for (const [name, v] of [
        ["night_start_hour", startVal],
        ["night_end_hour", endVal],
      ] as const) {
        if (!Number.isInteger(v) || v < 0 || v > 23) {
          throw new Error(`invalid ${name}: ${v} (need integer in [0, 23])`);
        }
      }
      if (startVal === endVal) {
        throw new Error("night_start_hour 与 night_end_hour 不能相等");
      }
      try {
        CronExpressionParser.parse(effExpr!, {
          tz: existing.timezone || "Asia/Shanghai",
        });
      } catch (err) {
        throw new Error(
          `invalid night_schedule_expr: ${effExpr} (${(err as Error).message})`
        );
      }
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.enabled !== undefined) { fields.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
  if (updates.skip_if_running !== undefined) { fields.push("skip_if_running = ?"); values.push(updates.skip_if_running ? 1 : 0); }
  if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
  if (updates.prompt !== undefined) { fields.push("prompt = ?"); values.push(updates.prompt); }
  if (updates.command !== undefined) { fields.push("command = ?"); values.push(updates.command); }
  if (updates.cwd !== undefined) { fields.push("cwd = ?"); values.push(updates.cwd); }
  if (updates.timezone !== undefined) { fields.push("timezone = ?"); values.push(updates.timezone); }

  // agent 执行参数。null 一律写 NULL（= 清掉该限制/覆盖, 运行时回落默认值）。
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (updates.project_id !== undefined) { fields.push("project_id = ?"); values.push(updates.project_id); }
  if (updates.version_id !== undefined) { fields.push("version_id = ?"); values.push(updates.version_id); }
  if (updates.priority !== undefined) { fields.push("priority = ?"); values.push(updates.priority); }
  // 🔴 auto_approve 不再走 updateSchedule —— ScheduleUpdate 已移除该字段,
  //   UPDATABLE_SCHEDULE_FIELDS 也不接受, PATCH 路由会返 400 unknown_fields。
  //   即便有旧脚本绕过路由直接调到这里, 也不会再改写 DB。
  if (updates.model !== undefined) { fields.push("model = ?"); values.push(updates.model); }
  if (updates.max_turns !== undefined) { fields.push("max_turns = ?"); values.push(updates.max_turns); }
  if (updates.effort !== undefined) { fields.push("effort = ?"); values.push(updates.effort); }
  // 数组字段: null 或空数组 -> NULL（toSchedule 对 NULL 回 null, 语义一致）。
  if (updates.allowed_tools !== undefined) {
    fields.push("allowed_tools = ?");
    values.push(updates.allowed_tools?.length ? stringifyStrArray(updates.allowed_tools) : null);
  }
  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(updates.tags?.length ? stringifyStrArray(updates.tags) : null);
  }
  // 🆕 v60 自适应频率。null 显式 = 关闭自适应; undefined 不动。
  if (updates.freq_min_minutes !== undefined) {
    fields.push("freq_min_minutes = ?");
    values.push(updates.freq_min_minutes);
  }
  if (updates.freq_max_minutes !== undefined) {
    fields.push("freq_max_minutes = ?");
    values.push(updates.freq_max_minutes);
  }
  // 🆕 飞书 R96 智能降频（v70）。null 显式 = 关闭; undefined 不动。
  if (updates.night_start_hour !== undefined) {
    fields.push("night_start_hour = ?");
    values.push(updates.night_start_hour);
  }
  if (updates.night_end_hour !== undefined) {
    fields.push("night_end_hour = ?");
    values.push(updates.night_end_hour);
  }
  if (updates.night_schedule_expr !== undefined) {
    fields.push("night_schedule_expr = ?");
    values.push(updates.night_schedule_expr);
  }

  // If schedule_type/schedule_expr/timezone/night_* changed, recompute next_run.
  // R96: night_* 变化也要重算（窗口换了 / expr 换了都会影响 next_run 选哪个分支）。
  let recompute = false;
  let newType = existing.schedule_type;
  let newExpr = existing.schedule_expr;
  let newTz = existing.timezone;
  let newNightStart: number | null = existing.night_start_hour;
  let newNightEnd: number | null = existing.night_end_hour;
  let newNightExpr: string | null = existing.night_schedule_expr;
  if (updates.schedule_type !== undefined) {
    fields.push("schedule_type = ?");
    values.push(updates.schedule_type);
    newType = updates.schedule_type;
    recompute = true;
  }
  if (updates.schedule_expr !== undefined) {
    fields.push("schedule_expr = ?");
    values.push(updates.schedule_expr);
    newExpr = updates.schedule_expr;
    recompute = true;
  }
  if (updates.timezone !== undefined) {
    newTz = updates.timezone;
    recompute = true;
  }
  if (updStartProvided) {
    // ?? null 把 undefined 兜成 null (updStartProvided 已排除 undefined, 这里只防 null)
    newNightStart = updates.night_start_hour ?? null;
    recompute = true;
  }
  if (updEndProvided) {
    newNightEnd = updates.night_end_hour ?? null;
    recompute = true;
  }
  if (updExprProvided) {
    newNightExpr = updates.night_schedule_expr ?? null;
    recompute = true;
  }
  // 🆕 Bug fix: PATCH 后 schedule_type/schedule_expr/timezone 变了要校验 effective 状态。
  //   - 与 createSchedule 的 schedule_type/expr 校验对称（见函数顶）。
  //   - 只在 recompute 触发时跑（其它字段 PATCH 不影响调度语义）。
  // 边界: 库里现有行若是历史脏数据（如 once + cron expr），单纯 PATCH 一个无关字段
  //   也不会被这层校验挡住（recompute=false → 不进 if）。先 PATCH expr 修好即
  //   可走通后续 PATCH。这是故意的："能修"比"必须修"更可逆。
  if (recompute) {
    const effTz = newTz || "Asia/Shanghai";
    if (newType === "once") {
      // 见 createSchedule 的同类校验: Date.parse 太松, 用严格 ISO 8601 正则兜底
      const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
      if (!ISO_RE.test(newExpr)) {
        throw new Error(
          `schedule_type=once requires ISO 8601 datetime (e.g. 2099-01-01T00:00:00Z), got: "${newExpr}" ` +
          `(hint: cron expression belongs to schedule_type=cron)`
        );
      }
    } else if (newType === "cron") {
      try {
        CronExpressionParser.parse(newExpr, { tz: effTz });
      } catch (err) {
        throw new Error(
          `invalid cron schedule_expr "${newExpr}": ${(err as Error).message}`
        );
      }
    }
  }

  if (recompute) {
    const next = computeNextRunWithNight({
      schedule_type: newType,
      schedule_expr: newExpr,
      timezone: newTz,
      night_start_hour: newNightStart,
      night_end_hour: newNightEnd,
      night_schedule_expr: newNightExpr,
    });
    fields.push("next_run = ?");
    values.push(next ?? "9999-12-31T23:59:59Z");
    // once with no future run: leave enabled as-is (caller controls). If it was
    // a re-arm of a once schedule, set a fresh run_at via schedule_expr.
  }

  if (fields.length === 0) return existing;
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getScheduleById(id)!;
}

export function deleteSchedule(id: string, userId?: string): boolean {
  const sql = userId
    ? "DELETE FROM schedules WHERE id = ? AND owner_id = ?"
    : "DELETE FROM schedules WHERE id = ?";
  return getDb().prepare(sql).run(...(userId ? [id, userId] : [id])).changes > 0;
}

// Record that a schedule fired (runner-internal; not part of the user-facing
// update API). Sets last_run and optionally last_task_id / last_exit_code.
export function markFired(
  id: string,
  input: { last_run: string; last_task_id?: string | null; last_exit_code?: number | null }
): void {
  const db = getDb();
  const fields: string[] = ["last_run = ?", "updated_at = ?"];
  const values: unknown[] = [input.last_run, new Date().toISOString()];
  if (input.last_task_id !== undefined) { fields.push("last_task_id = ?"); values.push(input.last_task_id); }
  if (input.last_exit_code !== undefined) { fields.push("last_exit_code = ?"); values.push(input.last_exit_code); }
  values.push(id);
  db.prepare(`UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

// 功能: 无条件推 schedule 的 next_run 到指定时间(覆盖原值), 用于 timeout 冷却。
// 关注点:
//   - 与 claimSchedule 不同: 这里不要求「当前 next_run == X」(因为 fireShell 拿不到
//     claim 之前的原值了), 直接无条件 UPDATE。
//   - 不进 UPDATABLE_SCHEDULE_FIELDS / ScheduleUpdate: PATCH 路由不接受 next_run,
//     仅 fireShell 内部调用。
//   - 冷却语义: tick 下一轮 listDueSchedules 不会选中(next_run > now),
//     等价于「cooldown 期间 schedule 完全不 fire」。
export function pushScheduleNextRun(id: string, nextRun: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE schedules SET next_run = ?, updated_at = ? WHERE id = ?"
  ).run(nextRun, new Date().toISOString(), id);
}

// ---- Run history ----

interface ScheduleRunRow {
  id: number;
  schedule_id: string;
  exec_type: string;
  task_id: string | null;
  command: string | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface ScheduleRun {
  id: number;
  schedule_id: string;
  exec_type: ExecType;
  task_id: string | null;
  command: string | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

function toRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    schedule_id: row.schedule_id,
    exec_type: row.exec_type as ExecType,
    task_id: row.task_id,
    command: row.command,
    exit_code: row.exit_code,
    output: row.output,
    error: row.error,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

export function recordRun(input: {
  schedule_id: string;
  exec_type: ExecType;
  task_id?: string | null;
  command?: string | null;
  started_at: string;
}): number {
  const db = getDb();
  const res = db
    .prepare(
      "INSERT INTO schedule_runs (schedule_id, exec_type, task_id, command, started_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(input.schedule_id, input.exec_type, input.task_id ?? null, input.command ?? null, input.started_at);
  return Number(res.lastInsertRowid);
}

export function finishRun(
  runId: number,
  input: {
    exit_code?: number | null;
    output?: string | null;
    error?: string | null;
    completed_at: string;
  }
): void {
  const db = getDb();
  db.prepare(
    "UPDATE schedule_runs SET exit_code = ?, output = ?, error = ?, completed_at = ? WHERE id = ?"
  ).run(input.exit_code ?? null, input.output ?? null, input.error ?? null, input.completed_at, runId);
}

// 🆕 飞书 R75: 加分页支持 —— UI 触发历史面板需要 total + offset。
//   opts.limit 默认 20, opts.offset 默认 0。返回 { runs, total } 让前端能算页数。
//   调用方只此一处（API 路由），改返回值安全。
export interface ListRunsOptions {
  limit?: number;
  offset?: number;
}
export interface ListRunsResult {
  runs: ScheduleRun[];
  total: number;
}
export function listRuns(scheduleId: string, opts: ListRunsOptions = {}): ListRunsResult {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?"
    )
    .all(scheduleId, limit, offset) as ScheduleRunRow[];
  const total = (
    db.prepare("SELECT COUNT(*) as cnt FROM schedule_runs WHERE schedule_id = ?").get(scheduleId) as
      | { cnt: number }
      | undefined
  )?.cnt ?? 0;
  return { runs: rows.map(toRun), total };
}

// 🆕 飞书 R86: 按 runId 取单条 —— SSE 路由做 owner 校验的反查入口。
//   不能像 getScheduleById 那样 JOIN, 因为 schedule_runs 没有 owner_id;
//   拿到 row 后再调 getScheduleById(schedule_id, userId) 验 owner (admin 不传 = 跨 owner)。
//   两步走, 任何一步失败 = null (= 404), 避免 leak run 存在性。
export function getScheduleRunById(runId: number): ScheduleRun | null {
  const row = getDb()
    .prepare("SELECT * FROM schedule_runs WHERE id = ?")
    .get(runId) as ScheduleRunRow | undefined;
  return row ? toRun(row) : null;
}

// 🆕 飞书 R79: schedule_runs 清理 helper.
//   设计: 两个参数可单独传也可一起传; 都传 = 取「并集」 (要么超龄、要么每 schedule
//   超过 keepLastN 都要删)。
//   - olderThanDays: 删 started_at < now - olderThanDays 的所有行 (按 schedule 切分无关,
//     整表扫)。null/undefined = 跳过这层。
//   - keepLastN: 每 schedule 保留最新 N 条, 多的删。null/undefined = 跳过这层。
//   返回 { byAge: number; byCount: number } 两条路径各删了多少 (合计 = byAge + byCount).
//   关注点: 用 schedule_id IN (...) 而不是 schedule 维度的循环, 一次 DELETE 完成
//   keepLastN 的剪枝; SQLite 单条 SQL 比 JS 循环快得多。purge 是运维行为,
//   失败可抛错, 调用方决定吞还是 warn。
export interface PurgeOldRunsOptions {
  olderThanDays?: number | null;
  keepLastN?: number | null;
  // 注入给测试用; 默认取 now = new Date().toISOString()
  nowIso?: string;
}
export interface PurgeOldRunsResult {
  byAge: number;
  byCount: number;
  total: number;
  // 实际生效的阈值, 让调用方 / 测试可以确认边界 (而不是只信黑盒).
  applied: {
    olderThanDays: number | null;
    keepLastN: number | null;
  };
}
export function purgeOldRuns(opts: PurgeOldRunsOptions = {}): PurgeOldRunsResult {
  const olderThanDays = opts.olderThanDays ?? null;
  const keepLastN = opts.keepLastN ?? null;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  // 校验: 两个参数要么都不传 (noop, 返 0), 要么至少一个有效整数 (>=1)。
  // olderThanDays < 1 / keepLastN < 1 视为「无意义阈值」= 跳过该层 (与 null 等价)。
  // 故意不抛: 调用方 (runner tick) 容错边界, 坏值降级为「这一轮什么都不删」。
  const effOlder =
    typeof olderThanDays === "number" && Number.isInteger(olderThanDays) && olderThanDays >= 1
      ? olderThanDays
      : null;
  const effKeepN =
    typeof keepLastN === "number" && Number.isInteger(keepLastN) && keepLastN >= 1
      ? keepLastN
      : null;

  if (effOlder === null && effKeepN === null) {
    return { byAge: 0, byCount: 0, total: 0, applied: { olderThanDays: null, keepLastN: null } };
  }

  const db = getDb();
  let byAge = 0;
  let byCount = 0;

  // 第一层: 整表按年龄删 (跨 schedule, 单 SQL 完成)。
  // 用 datetime('now', '-N days') 而非 JS 算 cutoff, 避免时区/字符串解析坑;
  // schedule_runs.started_at 是 ISO 8601 UTC 字符串, 与 SQLite 的 'YYYY-MM-DD...' 字面量直接可比。
  if (effOlder !== null) {
    const res = db
      .prepare(
        `DELETE FROM schedule_runs
          WHERE started_at < datetime(?, '-' || ? || ' days')`,
      )
      .run(nowIso, effOlder);
    byAge = res.changes;
  }

  // 第二层: 每个 schedule 保留最新 N 条, 删剩下的。
  // SQL: 找到「每个 schedule 排第 (N+1) 及之后」的行 (按 started_at DESC 排序) 删掉。
  // 用 ROW_NUMBER() 窗口函数 + 子查询, SQLite >= 3.25 支持, better-sqlite3 默认 >= 3.40。
  if (effKeepN !== null) {
    const res = db
      .prepare(
        `DELETE FROM schedule_runs
          WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY schedule_id ORDER BY started_at DESC
              ) AS rn FROM schedule_runs
            ) WHERE rn > ?
          )`,
      )
      .run(effKeepN);
    byCount = res.changes;
  }

  return {
    byAge,
    byCount,
    total: byAge + byCount,
    applied: { olderThanDays: effOlder, keepLastN: effKeepN },
  };
}
