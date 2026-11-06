// 维护模式状态（单行表 maintenance_state, id 恒为 'singleton'）
//
// 部署前有序关停 -> 部署 -> 恢复。为什么必须落库而不是内存标记:
//   1. pm2 restart 后是全新进程, 内存标记全丢 -> 新进程不知道自己该保持静默,
//      ScheduleRunner 启动 5s 后第一次 tick 就开始放任务。
//   2. suspended（关停时挂起的任务）同理: TaskScheduler.queue 只在内存里,
//      光 pause running 不够 —— queued 任务重启后被 recoverOrphanedTasks
//      扫成 pending, 之后再没人 enqueue 它们, 会永远躺着不动。
//
// prev_status 区分两类挂起任务, 恢复时走不同路径:
//   "running" -> 被 pauseTask 挂起, 恢复走 resumeTask（带 session_id 续上下文）
//   "queued"  -> 从内存队列摘下, 恢复走 startTask 重新入队

import { getDb } from "./index";

export interface SuspendedTask {
  task_id: string;
  prev_status: "running" | "queued";
}

export interface MaintenanceState {
  active: boolean;
  entered_at: string | null;
  entered_by: string | null;
  reason: string | null;
  suspended: SuspendedTask[];
}

interface MaintenanceRow {
  id: string;
  active: number;
  entered_at: string | null;
  entered_by: string | null;
  reason: string | null;
  suspended: string | null;
}

const DEFAULT_STATE: MaintenanceState = {
  active: false,
  entered_at: null,
  entered_by: null,
  reason: null,
  suspended: [],
};

// 功能: 读当前维护状态; 表内无行时返回「未维护」默认值.
// 关注点: suspended 是 JSON 列, 解析失败降级为空数组而非抛错 —— 恢复流程
//   不能因为一个坏 JSON 就卡死（宁可少恢复几个任务, 也要让平台能退出维护）.
export function getMaintenanceState(): MaintenanceState {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM maintenance_state WHERE id = 'singleton'")
    .get() as MaintenanceRow | undefined;
  if (!row) return { ...DEFAULT_STATE };

  let suspended: SuspendedTask[] = [];
  if (row.suspended) {
    try {
      const parsed = JSON.parse(row.suspended);
      if (Array.isArray(parsed)) suspended = parsed as SuspendedTask[];
    } catch {
      console.warn("[maintenance] suspended JSON 解析失败, 按空列表处理");
    }
  }

  return {
    active: row.active === 1,
    entered_at: row.entered_at,
    entered_by: row.entered_by,
    reason: row.reason,
    suspended,
  };
}

// 功能: 标记进入维护模式, 并记录本次关停挂起的任务列表.
// 关注点: 由调用方（AgentRuntime.enterMaintenance）在 pause 全部完成后才调,
//   中途崩溃不会留下「以为已关停」的假状态.
export function enterMaintenance(opts: {
  by: string | null;
  reason: string | null;
  suspended: SuspendedTask[];
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO maintenance_state (id, active, entered_at, entered_by, reason, suspended)
     VALUES ('singleton', 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       active = 1,
       entered_at = excluded.entered_at,
       entered_by = excluded.entered_by,
       reason = excluded.reason,
       suspended = excluded.suspended`
  ).run(
    new Date().toISOString(),
    opts.by,
    opts.reason,
    JSON.stringify(opts.suspended)
  );
}

// 功能: 清除维护标记 + 清空 suspended 列表.
// 关注点: 调用方应先读走 suspended 再调本函数 —— 清空后就拿不回来了.
export function exitMaintenance(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO maintenance_state (id, active, entered_at, entered_by, reason, suspended)
     VALUES ('singleton', 0, NULL, NULL, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       active = 0, entered_at = NULL, entered_by = NULL, reason = NULL, suspended = NULL`
  ).run();
}

// ---- maintenance_log (v53, 飞书 R10): 维护历史 ----
//
// append-only: enter 开一条, exit 更新同一行. 与 maintenance_state (当前态) 互补:
// state 关停后清空, log 永久留存, 让 damo 在升级部署时能查「上次维护时间/持续多久/
// 失败几个」, 与 docs/plans/maintenance-deploy-log.md 串联部署时间线.

export interface MaintenanceLogRow {
  id: number;
  started_at: string;
  started_by: string | null;
  reason: string | null;
  paused_count: number;
  dequeued_count: number;
  failed_count: number;
  ended_at: string | null;
  ended_by: string | null;
  duration_seconds: number | null;
  result: "completed" | "aborted" | "failed" | null;
}

// 功能: 在 maintenance_log 开一条 enter 行, 返回新 id. 调用方把 id 存进
//   maintenance_state.log_id, exit 时按 id 收尾.
// 关注点: 写 started_at = now (ISO), 不传参 (clock skew 不在本层处理).
export function startMaintenanceLog(opts: {
  started_by: string | null;
  reason: string | null;
  paused_count: number;
  dequeued_count: number;
  failed_count: number;
}): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO maintenance_log (started_at, started_by, reason, paused_count, dequeued_count, failed_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      opts.started_by,
      opts.reason,
      opts.paused_count,
      opts.dequeued_count,
      opts.failed_count,
    );
  return Number(result.lastInsertRowid);
}

// 功能: 收尾一条 enter 行 (exit 时调). result='completed' = 正常恢复;
//   'aborted' = 进程被重启打断 (exited_at 非空但 exit 流程没跑完, 只能靠对比
//   duration_seconds 是否合理 + 后续修复任务来兜底); 'failed' = exit 中途有
//   任务 resume 失败.
// 关注点: 写 duration_seconds 依赖 ended_at - started_at (秒). started_at 是
//   startMaintenanceLog 写入的 ISO, 这里直接 (Date.parse - Date.parse) / 1000,
//   不必绕 julianday (本表存的是 ISO, 不是 SQLite 自带日期格式).
export function finishMaintenanceLog(opts: {
  id: number;
  ended_by: string | null;
  result: "completed" | "aborted" | "failed";
}): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT started_at FROM maintenance_log WHERE id = ?`)
    .get(opts.id) as { started_at: string } | undefined;
  const endedAt = new Date().toISOString();
  let duration: number | null = null;
  if (row) {
    const ms = Date.parse(endedAt) - Date.parse(row.started_at);
    duration = Math.max(0, Math.round(ms / 1000));
  }
  db.prepare(
    `UPDATE maintenance_log
     SET ended_at = ?, ended_by = ?, duration_seconds = ?, result = ?
     WHERE id = ?`,
  ).run(endedAt, opts.ended_by, duration, opts.result, opts.id);
}

// 功能: 读最近 N 条 maintenance_log (按 started_at DESC). limit 默认 10.
export function getRecentMaintenanceLog(limit = 10): MaintenanceLogRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM maintenance_log ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as MaintenanceLogRow[];
}

// 功能: 读最近一条已完成的 (ended_at 非空) 记录 —— 给 UI "上次维护" 那行用.
//   当前进行中 (active=1) 的不算 —— 那是当前会话, 不算"上次".
export function getLastCompletedMaintenanceLog(): MaintenanceLogRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM maintenance_log
       WHERE ended_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as MaintenanceLogRow | undefined;
  return row ?? null;
}

// 功能: 读最近一条「进行中」(ended_at IS NULL) 的 log —— 给 exit 跨重启兜底用.
//   initialize() 与 exitMaintenance() 都会调, 拿到 id 后 finishMaintenanceLog 收尾.
//   异常组合 (state.active=false 但有 open log, 或反过来) 视为上次进程未跑完.
// 关注点: 多实例并发时可能短暂返回 >1 行的边界, caller 应按 id 单点 UPDATE 兜底.
export function getOpenMaintenanceLog(): MaintenanceLogRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM maintenance_log
       WHERE ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as MaintenanceLogRow | undefined;
  return row ?? null;
}
