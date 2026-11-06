// R34: stats API 封装 — 仅含 GET /api/stats 一条, 专为 Progress.vue + Stats.vue 服务.
//   字段集对齐 master src/app/api/stats/route.ts 返回的 JSON, 与 Next 端
//   src/app/stats/tabs/usage.tsx 的 StatsData 类型一一对应.
//
// 关注点:
// - 与 Next 端 Tab.tsx 不同: SPA 同一个 stats 既给实时进度页 (scheduler 子集)
//   又给用量统计页 (cost 子集), 用单一 StatsData 类型承载两路消费, view 自己
//   按需取子集. 避免拆 stats-scheduler.ts + stats-cost.ts 两个薄文件 (覆盖低).
// - Progress.vue 还需要拉 /api/tasks?limit=200 拿活跃任务/最近完成 — 那个 endpoint
//   不在本文件暴露, view 内 inline fetch (与 R14 BoardPage 同款: 避免共享
//   api/tasks.ts 引出未使用的 listTasks, 参 R33 commit message 「不引 listTasks」).
// - SchedulerRunningTask / QueueTask 仅暴露 {id, title} 子集, 完整 task row
//   后端会一并 SELECT 但本类型不暴露 (避免下游误消费).

import { get } from './http';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SchedulerRunningTask {
  id: string;
  title: string;
}

export interface SchedulerStatus {
  queue_size: number;
  running_count: number;
  max_concurrency: number;
  running_tasks: SchedulerRunningTask[];
  queue_tasks: SchedulerRunningTask[];
}

export interface CostByDay {
  day: string;
  cost: number;
}

export interface CostBreakdown {
  total: number;
  by_tag: Record<string, number>;
  by_model: Record<string, number>;
  by_day: CostByDay[];
}

export interface StatsData {
  /** 任务状态计数: key = status (pending/running/...), value = 该状态任务数. */
  tasks: Record<string, number>;
  scheduler: SchedulerStatus;
  cost: CostBreakdown;
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

/** GET /api/stats — 当前用户聚合统计. R34 模块专用. */
export function getStats(): Promise<StatsData> {
  return get<StatsData>('/api/stats');
}

/* ------------------------------------------------------------------ */
/*  R38: scope counts — 镜像 master src/app/api/stats/counts/route.ts.
     字段: key 形如 "projectId:versionId" 或 "projectId:" (unversioned).
     value 含 running / reviewing / paused / total 计数, 供侧栏徽章用.
     2026-10-11: 加 queued (可选) —— 侧栏「全局看板」徽章区分显示
     {运行+排队}(纯运行); running 保持 = running+queued 合并口径. */
/* ------------------------------------------------------------------ */

export interface ScopeCounts {
  running: number;
  /** 纯排队计数 (后端 2026-10-11 起返回; 可选 = 容错旧响应/缓存). */
  queued?: number;
  reviewing: number;
  paused: number;
  total: number;
}

/** GET /api/stats/counts — 每个 scope 的任务状态计数, 侧栏 badge 数据源. */
export function getScopeCounts(): Promise<Record<string, ScopeCounts>> {
  return get<Record<string, ScopeCounts>>('/api/stats/counts');
}