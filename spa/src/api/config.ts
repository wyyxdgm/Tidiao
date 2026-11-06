// 🆕 R26: app-level general settings API 封装 — 对应 Next src/app/api/config/route.ts.
//   sheet R26 字面要求 = GET /api/app-settings 通用设置展示 + 保存, 但 master 后端
//   实际端点 = GET/PATCH /api/config (concurrency + task_timeout + port_pool), 没有
//   /api/app-settings. 走真实后端端点 + commit 披露差异.
//
// 用户级 (preflight_enabled / notify_email / feishu_webhook_url) 走 /api/user/me,
// 见 api/user.ts; Settings.vue 同时拉两路 = "通用设置" 涵盖应用 + 用户两层.

import { get, patch } from './http';

/** AppConfig = GET /api/config 响应. 与 master route.ts snapshot() 字段对齐.
    边界字段 (concurrency_min/max, task_timeout_min/max, port_pool_*) 用于 UI
    给 input 加 min/max 校验, 不写到后端. */
export interface AppConfig {
  concurrency: number;
  concurrency_min: number;
  concurrency_max: number;
  queue_size: number;
  running_count: number;
  api_key_configured: boolean;
  base_url: string;
  model: string | null;
  task_timeout_minutes: number;
  task_timeout_min: number;
  task_timeout_max: number;
  port_pool: number[][];
  port_pool_min: number;
  port_pool_max: number;
  port_pool_max_segments: number;
}

/** PATCH /api/config 入参 — 全部可选, 不传的字段后端不动.
    concurrency / task_timeout_minutes 后端校验边界 (返回 400 + error 字段).
    port_pool = [[start, end], ...] 端口段数组, 段数 ≤ port_pool_max_segments. */
export interface AppConfigUpdate {
  concurrency?: number;
  task_timeout_minutes?: number;
  port_pool?: number[][];
}

/** GET /api/config — 拉当前运行时配置. 任意登录用户可读. */
export function getAppConfig(): Promise<AppConfig> {
  return get<AppConfig>('/api/config');
}

/** PATCH /api/config — admin only. 后端改完落库 + 同步改运行时内存值;
    改完返回的 body 仍是同一份 AppConfig 形状 (master 内部用同一个 snapshot()). */
export function updateAppConfig(body: AppConfigUpdate): Promise<AppConfig> {
  return patch<AppConfig>('/api/config', body);
}
