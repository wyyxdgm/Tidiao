// 🆕 R32: runners API 封装 — 与 master src/app/api/runners/* routes 对齐.
//
// 字段范围 (Runner) 对齐 master src/lib/db/runners.ts 的列集; auth 列 (token_hash 等)
// 后端 GET 路由主动屏蔽, 前端永远不会拿到的 "secret"; UI 上不暴露明文 token, 只有注册
// 响应里一次性返回 (createRunner 的第二返回值).
//
// admin gating: 全部 GET/POST/DELETE 路由后端都走 x-user-role header 判断, 非 admin
// 全部回 401 "admin only". 前端不做权限拦截 (admin 状态由 auth store 拿, 但路由
// 层不强 redirect — 与 Next 端 server-component redirect("/") 对齐, 在 SPA 改
// 为 client-side 401 → 友好错误页 + "需要 admin 权限" 提示, 让非 admin 用户
// 看到自己的角色, 不至于跳转后看不到原因).

import { get, post, del } from './http';

/** 单条 runner — 与 master GET /api/runners 返回结构对齐.
    token 列后端不返 (注册响应里一次性给); capabilities / last_health_json 自由文本. */
export interface Runner {
  id: string;
  name: string;
  host: string;
  port: number;
  os_type: OsType;
  capabilities: string | null;
  status: RunnerStatus;
  last_heartbeat_at: string | null;
  last_health_json: string | null;
  created_at: string;
}

/** OS 三态 — 与 master src/lib/db/runners.ts 的 OS_TYPES 完全对齐.
    后端 zod 校验仍是权威; 这里只作为 Select 组件 options 来源. */
export type OsType = 'macos' | 'windows' | 'linux';

export const OS_OPTIONS: { value: OsType; label: string }[] = [
  { value: 'macos', label: 'macOS' },
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
];

/** Runner 心跳三态 — 与 master src/lib/db/runners.ts 同款语义:
    online = 最近心跳过 / offline = 超过阈值未心跳 / dead = 多次未响应 (admin 手动标记). */
export type RunnerStatus = 'online' | 'offline' | 'dead';

/** GET /api/runners — admin: 列出全部 runners. 后端返 { runners: Runner[] }. */
export interface ListRunnersResponse {
  runners: Runner[];
}

export function listRunners(): Promise<ListRunnersResponse> {
  return get<ListRunnersResponse>('/api/runners');
}

/** POST /api/runners — admin: 注册新 runner. body { name, host, port, os_type }.
    response = 201 + { runner, token }; token 仅此一次 (后端后续 GET 不返).
    前端不缓存 token 到 state 之外的任何地方 (关 modal 就看不到 — 与 Next 同款). */
export interface CreateRunnerBody {
  name: string;
  host: string;
  port: number;
  os_type: OsType;
}

export interface CreateRunnerResponse {
  runner: Runner;
  token: string;
}

export function createRunner(body: CreateRunnerBody): Promise<CreateRunnerResponse> {
  return post<CreateRunnerResponse>('/api/runners', body);
}

/** DELETE /api/runners/[id] — admin: 硬删 + 撤销 token. 返 { ok: true }. */
export function deleteRunner(id: string): Promise<{ ok: true }> {
  return del<{ ok: true }>(`/api/runners/${id}`);
}

/** POST /api/runners/[id]/health — admin: 手动触发一次 runner /v1/health 探针.
    5s 超时, 任何网络/超时/非 JSON 都回 400 + 具体原因. 后端 updateRunnerHealth
    写库 + 返 { ok: true, health: <JSON text> }. 失败由调用方 catch 后 toast.error. */
export interface HealthCheckResponse {
  ok: true;
  health: string;
}

export function healthCheckRunner(id: string): Promise<HealthCheckResponse> {
  return post<HealthCheckResponse>(`/api/runners/${id}/health`);
}