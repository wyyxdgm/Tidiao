// R23: 配置快照 API 封装 — 完整镜像 Next.js /tasks/new 第三栏「模板配置」tab.
// 数据源:
//   - GET    /api/config-snapshots                       当前用户所有快照
//   - GET    /api/config-snapshots?project=&version=     该位置适用的快照 (global+project+version, 最具体优先)
//   - POST   /api/config-snapshots                       新建
//   - GET    /api/config-snapshots/[id]                  单条
//   - PUT    /api/config-snapshots/[id]                  全量更新
//   - DELETE /api/config-snapshots/[id]                  删除
//
// 关注点:
// - 类型 Snapshot 与 master src/lib/db/config-snapshots.ts row shape 对齐
//   (字段名 snake_case + 原始字符串 allowed_tools / tags; UI 解析走
//   predicates.ts parseJsonStringArray).
// - 入参 (Create/Update body) 与 master ConfigSnapshotDefinition 对齐, 走
//   PascalCase + snake (projectId / llm_config_id / maxTurns / autoApprove 等)
//   与 Next 页保持同口径; 后端白名单透传.
// - scope 仅 'global' | 'project' | 'version' 三态; 绑 version 时必须先选 project.
// - 不挂 SSE / 不引缓存 — 创建/删除即拉即更新, 视图数据量小 (用户快照通常 < 50 条).
// - 不动后端 (sheet 红线), 完全靠现有 5 个 REST 端点.

import { get, post, put, del } from './http';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SnapshotScope = 'global' | 'project' | 'version';

/** 单条快照 row — 与 master src/lib/db/config-snapshots.ts row shape 对齐.
    allowed_tools / tags 是 JSON 字符串 (UI 解析); null = 字段未设置. */
export interface Snapshot {
  id: string;
  name: string;
  description: string | null;
  scope: SnapshotScope;
  project_id: string | null;
  version_id: string | null;
  model: string | null;
  effort: string | null;
  max_turns: number | null;
  auto_approve: number | null;
  allowed_tools: string | null;
  tags: string | null;
  type: string | null;
  llm_config_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 新建/更新 body — PascalCase + snake 混合 (与 master route 入参对齐). */
export interface CreateSnapshotBody {
  name: string;
  description?: string;
  scope: SnapshotScope;
  projectId?: string;
  versionId?: string;
  model?: string;
  llm_config_id?: string | null;
  effort?: string;
  maxTurns?: number;
  autoApprove?: boolean;
  allowedTools?: string[];
  tags?: string[];
  type?: string;
}

/** 新建快照 (master POST body). */
export function createConfigSnapshot(body: CreateSnapshotBody): Promise<Snapshot> {
  return post<Snapshot>('/api/config-snapshots', body);
}

/** 拉全部快照 (当前用户). */
export function listConfigSnapshots(): Promise<Snapshot[]> {
  return get<Snapshot[]>('/api/config-snapshots');
}

/** 拉适用快照 (global + 指定 project + 指定 version, 最具体优先).
    project/version 任一为空时只按另一维过滤. */
export function listApplicableSnapshots(projectId: string, versionId: string): Promise<Snapshot[]> {
  const qs = new URLSearchParams();
  if (projectId) qs.set('project', projectId);
  if (versionId) qs.set('version', versionId);
  const q = qs.toString();
  return get<Snapshot[]>(`/api/config-snapshots${q ? `?${q}` : ''}`);
}

/** 拉单条快照. */
export function getConfigSnapshot(id: string): Promise<Snapshot> {
  return get<Snapshot>(`/api/config-snapshots/${id}`);
}

/** 全量更新 (PUT, 与 Next 端 PUT 同口径). */
export function updateConfigSnapshot(id: string, body: CreateSnapshotBody): Promise<Snapshot> {
  return put<Snapshot>(`/api/config-snapshots/${id}`, body);
}

/** 删除快照. */
export function deleteConfigSnapshot(id: string): Promise<void> {
  return del<void>(`/api/config-snapshots/${id}`);
}