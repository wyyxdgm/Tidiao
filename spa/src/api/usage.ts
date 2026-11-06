// R8: 用量统计 + 积压概览 API 封装 — 对应 master src/app/api/stats/usage/route.ts
//   + src/app/api/stats/backlog/route.ts.
//
// 与 R34 stats.ts 的分工: stats.ts 走 /api/stats (dashboard 聚合); 本文件
// 封装 /api/stats/usage (时间粒度 + owner 双口径) + /api/stats/backlog (跨
// owner 全局积压). 三个端点结构 + 调用方都不重叠, 拆独立文件避免 stats.ts
// 膨胀.
//
// 关注点:
// - 后端 timezone/COALESCE/resolved_model 口径都在 route.ts 注释里, 本类型层
//   只暴露给 view 消费的字段, 不暴露 raw 字符串.
// - OwnerUsage / Bucket / ModelUsage 类型与 master route.ts:142-186 SelectBucket
//   一一对应. Scope = "mine" | "all" | "owner" 自述字段.
// - BacklogPanel 的 BacklogRow.status 是 BACKLOG_STATUSES 子集 (pending/queued/
//   running/paused/reviewing/rejected/failed), 后端**补零**返回 7 条; view
//   遍历渲染即可, 不在客户端再补零.

import { get } from './http';

/* ------------------------------------------------------------------ */
/*  Types — /api/stats/usage                                            */
/* ------------------------------------------------------------------ */

export type UsageScope = 'mine' | 'all' | 'owner';
export type UsageGranularity = 'hour' | 'day' | 'week' | 'month' | 'year';

export interface ModelUsage {
  model: string;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
}

export interface OwnerUsage {
  owner_id: string | null;
  email: string | null;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
}

export interface UsageBucket {
  bucket: string;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
  by_model: ModelUsage[];
}

export interface UsageData {
  granularity: UsageGranularity;
  limit: number;
  timezone: string;
  scope: UsageScope;
  buckets: UsageBucket[];
  total: {
    task_count: number;
    cost_usd: number;
    context_tokens: number;
    by_model: ModelUsage[];
    by_owner?: OwnerUsage[];
  };
}

/* ------------------------------------------------------------------ */
/*  Types — /api/stats/backlog                                          */
/* ------------------------------------------------------------------ */

export type BacklogStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'rejected'
  | 'failed';

export interface BacklogRow {
  status: string;
  count: number;
  oldest_created_at: string | null;
  oldest_age_days: number | null;
}

export interface BacklogReviewingTopRow {
  owner_id: string | null;
  email: string | null;
  count: number;
}

export interface BacklogData {
  scope: 'all' | 'mine';
  instance: string | null;
  generated_at: string;
  backlog_total: number;
  oldest_age_days: number | null;
  backlog: BacklogRow[];
  all_statuses: Array<{ status: string; count: number }>;
  reviewing_by_owner: {
    top: BacklogReviewingTopRow[];
    other_count: number;
    distinct_owners: number;
  };
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

export interface GetUsageParams {
  granularity: UsageGranularity;
  /** "self" | "all" | <user_id>. 非 admin 时强制 self, 兜底同 Next. */
  owner: string;
}

/** GET /api/stats/usage?granularity=&owner= — 用量聚合. */
export function getUsageStats(params: GetUsageParams): Promise<UsageData> {
  const q = new URLSearchParams({
    granularity: params.granularity,
    owner: params.owner,
  });
  return get<UsageData>(`/api/stats/usage?${q.toString()}`);
}

/** GET /api/stats/backlog — 全局积压概览 (admin 全局 / 普通用户自己). */
export function getBacklog(): Promise<BacklogData> {
  return get<BacklogData>('/api/stats/backlog');
}
