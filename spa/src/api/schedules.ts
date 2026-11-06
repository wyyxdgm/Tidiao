// Schedules API 封装 — 与 master src/lib/db/schedules.ts 字段集对齐.
// R23 字面只要求 list/toggle/update; R6 (本轮) 扩展为完整镜像 Next
// src/app/schedules/schedules-client.tsx —— 新增 create / listRuns / trigger
// + Project / Version / ScheduleRun / RunsResponse / CreateScheduleBody 类型.
// 字段范围是 UI 渲染所需最小集; 若需新增字段补这里 + 类型即可, 不必碰 view.

import { del, get, patch, post } from './http';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 单条 schedule — 与 master schedules.ts 的 listSchedules / getScheduleById 返回结构对齐.
    可空字段 (title/prompt/command/cwd/project_id/last_run/last_task_id/last_exit_code)
    表示「这条 schedule 没用这个字段」, UI 渲染前要 ?? '—' 兜底. */
export interface Schedule {
  id: string;
  name: string;
  exec_type: 'agent' | 'shell';
  title: string | null;
  description: string | null;
  prompt: string | null;
  command: string | null;
  cwd: string | null;
  project_id: string | null;
  schedule_type: 'cron' | 'once';
  schedule_expr: string;
  timezone: string;
  enabled: boolean;
  next_run: string;
  last_run: string | null;
  last_task_id: string | null;
  last_exit_code: number | null;
  skip_if_running: boolean;
  created_at: string;
  /** v68 软删除时间戳; 非空表示已软删除. UI 上要展示「已删除」徽章. */
  deleted_at: string | null;
}

/** 单条 schedule 的可编辑子集 — 与 master UPDATABLE_SCHEDULE_FIELDS 对齐.
    view 的「编辑 modal」 R86 用 ScheduleFormFields 12 字段覆盖更广.
    updateSchedule 也只认白名单字段, 多余字段后端 400. */
export interface ScheduleUpdate {
  name?: string;
  schedule_type?: 'cron' | 'once';
  schedule_expr?: string;
  timezone?: string;
  enabled?: boolean;
  description?: string;
  title?: string;
  prompt?: string;
  command?: string;
  cwd?: string;
}

/** 新建 schedule body — 与 master POST /api/schedules body 同款 (R68 v2 + R86 完整字段).
    exec_type 决定哪些字段必填; ScheduleFormFields 客户端 validate. */
export interface CreateScheduleBody {
  name: string;
  exec_type: 'agent' | 'shell';
  schedule_type: 'cron' | 'once';
  schedule_expr: string;
  timezone?: string;
  description?: string;
  // agent 侧
  project_id?: string;
  title?: string;
  prompt?: string;
  // shell 侧
  command?: string;
  cwd?: string;
}

/** 列表筛选 — 与 Next schedules-client 的 FilterState + showDeleted + R92 时间区间对齐.
    所有字段均可选; 空串 = 不过滤. 与后端 listSchedules 的可选参数对齐. */
export interface ListSchedulesParams {
  project?: string;
  version?: string;
  lastRunFrom?: string;
  lastRunTo?: string;
  nextRunFrom?: string;
  nextRunTo?: string;
  /** 启用状态筛选: true = 只看启用, false = 只看停用, undefined = 不过滤. */
  enabled?: boolean;
  includeDeleted?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Trigger history (R75)                                              */
/* ------------------------------------------------------------------ */

/** 单条 schedule run — 与 master src/lib/db/schedules.ts 的 ScheduleRun 对齐. */
export interface ScheduleRun {
  id: number;
  schedule_id: string;
  exec_type: 'agent' | 'shell';
  task_id: string | null;
  command: string | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

/** 触发历史列表响应 — 与 master GET /api/schedules/[id]/runs 返回结构对齐. */
export interface RunsResponse {
  runs: ScheduleRun[];
  total: number;
  limit: number;
  offset: number;
}

/* ------------------------------------------------------------------ */
/*  Schedule list                                                      */
/* ------------------------------------------------------------------ */

/** GET /api/schedules — 拉当前用户全部 schedule. params 都可选, 没传 = 不过滤. */
export function listSchedules(params: ListSchedulesParams = {}): Promise<Schedule[]> {
  const qs = new URLSearchParams();
  if (params.project) qs.set('project', params.project);
  if (params.version) qs.set('version', params.version);
  if (params.lastRunFrom) qs.set('lastRunFrom', params.lastRunFrom);
  if (params.lastRunTo) qs.set('lastRunTo', params.lastRunTo);
  if (params.nextRunFrom) qs.set('nextRunFrom', params.nextRunFrom);
  if (params.nextRunTo) qs.set('nextRunTo', params.nextRunTo);
  if (params.enabled !== undefined) qs.set('enabled', String(params.enabled));
  if (params.includeDeleted) qs.set('includeDeleted', 'true');
  const suffix = qs.toString();
  return get<Schedule[]>(`/api/schedules${suffix ? `?${suffix}` : ''}`);
}

/* ------------------------------------------------------------------ */
/*  Create / toggle / update / delete                                  */
/* ------------------------------------------------------------------ */

/** POST /api/schedules — R68 v2 新建定时任务. 返回后端生成的完整 Schedule. */
export function createSchedule(body: CreateScheduleBody): Promise<Schedule> {
  return post<Schedule>('/api/schedules', body);
}

/** PATCH /api/schedules/[id] { enabled } — R23 toggle 端点 (toggle wrapper 路由未实现,
    后端走 UPDATABLE_SCHEDULE_FIELDS 白名单, enabled 在内). 返回更新后完整对象. */
export function toggleSchedule(id: string, enabled: boolean): Promise<Schedule> {
  return patch<Schedule>(`/api/schedules/${id}`, { enabled });
}

/** PATCH /api/schedules/[id] — R86 编辑 modal 完整提交. 后端按 UPDATABLE_SCHEDULE_FIELDS
    校验, 未知字段返 400 + unknown_fields. 返回更新后完整 schedule. */
export function updateSchedule(id: string, body: ScheduleUpdate): Promise<Schedule> {
  return patch<Schedule>(`/api/schedules/${id}`, body);
}

/** DELETE /api/schedules/[id] — R68 v2 硬删 (不走软删除通道). */
export function deleteSchedule(id: string): Promise<void> {
  return del<void>(`/api/schedules/${id}`);
}

/* ------------------------------------------------------------------ */
/*  Trigger now + run history (R53 / R75)                              */
/* ------------------------------------------------------------------ */

/** GET /api/schedules/[id]/runs — R75 触发历史列表, 后端 limit 默认 20 / offset 默认 0. */
export function listRuns(
  scheduleId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<RunsResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const suffix = qs.toString();
  return get<RunsResponse>(
    `/api/schedules/${encodeURIComponent(scheduleId)}/runs${suffix ? `?${suffix}` : ''}`,
  );
}

/** POST /api/schedules/[id]/runs — R53 立即执行. 后端手动触发不依赖 enabled, 但
    skip_if_running 仍生效: 上一发在飞 → 409 + reason. 返回 {ok, task_id | null}. */
export interface TriggerResult {
  ok: boolean;
  task_id?: string | null;
}
export function triggerNow(scheduleId: string): Promise<TriggerResult> {
  return post<TriggerResult>(`/api/schedules/${encodeURIComponent(scheduleId)}/runs`);
}
