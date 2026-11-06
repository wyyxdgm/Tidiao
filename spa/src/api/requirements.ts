// 🆕 R28: requirements API 封装 — 与 master src/lib/db/requirements.ts 的 Requirement
//   字段集对齐. 字段范围 = 列表渲染 + 表单编辑所需. 后端入参 (project_id, title,
//   description, priority, tags, version_id) 与 Next RequirementsListView 同款.

import { get, post, patch, del } from './http';

/** 需求状态 6 态 — 与 master REQUIREMENT_STATUSES 对齐 (R60 §4.1). */
export const REQUIREMENT_STATUSES = [
  'pending',
  'done',
  'awaiting_reply',
  'has_suggestion',
  'blocked',
  'closed',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** 单条 requirement — 与 master Requirement 行映射字段一致.
    description / priority / tags / version_id 可空 = 该条没填这些字段. */
export interface Requirement {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: RequirementStatus;
  priority: number | null;
  owner_id: string | null;
  tags: string | null;
  source: 'in_app';
  version_id: string | null;
  /** v517 (R196): 完成度 0-100, null = 未评估. 100 = done (部署+验证通过). */
  progress: number | null;
  progress_source: 'rule' | 'manual' | 'ai' | null;
  progress_note: string | null;
  progress_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/requirements 列表响应 — 后端返 {items, total, has_more, page, page_size}. */
export interface RequirementListResponse {
  items: Requirement[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
}

/** 列表筛选 — 与 Next RequirementsListView 的 searchParams 对齐, 所有字段均可选. */
export interface ListRequirementsParams {
  /** 单状态或逗号分隔多状态; undefined = 不过滤. */
  status?: RequirementStatus;
  project_id?: string;
  /** R64: string = 某 version; 显式 null = 不挂版本; undefined = 不过滤. */
  version_id?: string | null;
  page?: number;
  page_size?: number;
}

/** POST /api/requirements body — 与 master createRequirement 入参对齐. */
export interface CreateRequirementBody {
  project_id: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  tags?: string[] | null;
  version_id?: string | null;
}

/** PATCH /api/requirements/[id] body — 与 master REQUIREMENT_UPDATE_FIELDS 白名单
    对齐, 字段均可选 (不传 = 不覆盖). */
export interface UpdateRequirementBody {
  title?: string;
  description?: string | null;
  status?: RequirementStatus;
  priority?: number | null;
  tags?: string[] | null;
  version_id?: string | null;
  /** v517 (R196): 手动修正完成度. null = 清空回「未评估」. */
  progress?: number | null;
  progress_note?: string | null;
}

/** POST /api/requirements/[id]/progress — 规则重算 (R196). 返回更新后的 requirement. */
export async function recalcRequirementProgress(
  id: string,
): Promise<Requirement> {
  return post<Requirement>(`/api/requirements/${id}/progress`);
}

/** GET /api/requirements — 列表 + 状态筛选 + 分页. */
export async function listRequirements(
  params: ListRequirementsParams = {},
): Promise<RequirementListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.project_id) qs.set('project_id', params.project_id);
  if (params.version_id !== undefined && params.version_id !== null) {
    qs.set('version_id', params.version_id);
  } else if (params.version_id === null) {
    qs.set('version_id', 'null');
  }
  if (params.page) qs.set('page', String(params.page));
  if (params.page_size) qs.set('page_size', String(params.page_size));
  const suffix = qs.toString();
  const resp = await get<RequirementListResponse>(
    `/api/requirements${suffix ? `?${suffix}` : ''}`,
  );
  return {
    items: resp.items ?? [],
    total: resp.total ?? 0,
    has_more: resp.has_more ?? false,
    page: resp.page ?? 1,
    page_size: resp.page_size ?? 20,
  };
}

/** POST /api/requirements — 新建. 返回新建后的完整 requirement. */
export function createRequirement(body: CreateRequirementBody): Promise<Requirement> {
  return post<Requirement>('/api/requirements', body);
}

/** PATCH /api/requirements/[id] — 编辑 (白名单局部更新). 返回更新后的 requirement. */
export function updateRequirement(
  id: string,
  body: UpdateRequirementBody,
): Promise<Requirement> {
  return patch<Requirement>(`/api/requirements/${id}`, body);
}

/** DELETE /api/requirements/[id] — 软删 (status='closed'). 后端返 {id, status}. */
export function deleteRequirement(id: string): Promise<{ id: string; status: RequirementStatus }> {
  return del<{ id: string; status: RequirementStatus }>(`/api/requirements/${id}`);
}

/* ------------------------------------------------------------------ */
/*  R107 增量: revisions + version 名补齐                               */
/* ------------------------------------------------------------------ */

/** 变更执行者类型 — 与 master ActorType 对齐 (R63 时间胶囊 / R107 列表行). */
export type ActorType = 'user' | 'agent' | 'system';

/** 单条字段变更 — 与 master RequirementRevision 字段对齐. */
export interface RequirementRevision {
  id: string;
  requirement_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  task_id: string | null;
  created_at: string;
}

/** GET /api/requirements/[id]/revisions — 列出某需求点的字段变更时间线.
    limit 默认 100, 上限 500; SPA 列表行只要最近 1 条, 传 limit=1. */
export async function listRequirementRevisions(
  id: string,
  params: { limit?: number } = {},
): Promise<RequirementRevision[]> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString();
  const resp = await get<{ requirement_id: string; revisions: RequirementRevision[] }>(
    `/api/requirements/${id}/revisions${suffix ? `?${suffix}` : ''}`,
  );
  return resp.revisions ?? [];
}

/** 把后端的 tags (JSON 字符串或 null) 解析为字符串数组. 解析失败返回空数组.
    与 master parseRequirementTags 行为对齐. */
export function parseRequirementTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}

/** 把字符串数组序列化为后端 tags JSON 字符串. 空数组返回 null (后端期望 null = 没标签). */
export function serializeRequirementTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}

/* ------------------------------------------------------------------ */
/*  R16 增量: 详情页 API (detail + tasks + attachments)                */
/* ------------------------------------------------------------------ */

/** 详情页 GET /api/requirements/[id] 返回的 task 行 — 与 master
    getRequirementTasks() SELECT 字段对齐 (src/lib/db/requirements.ts:530).
    depends_on 是后端 JSON 字符串, 客户端 parseRequirementDependencies 拆出来. */
export interface RequirementTask {
  id: string;
  title: string;
  status: string;
  /** JSON 字符串数组, 客户端解析; null = 无依赖. */
  depends_on: string[] | null;
  created_at: string;
  /** 派发自哪个 task (森林图父子边). null = 根 task. */
  dispatched_by_task_id: string | null;
  /** R109: 最新 checkpoint status — 与 board / kanban / global-board 同款 sub-status chip. */
  latest_checkpoint_status: string | null;
}

/** GET /api/requirements/[id] — 单条 + 关联 task 列表 + invariant 提示字段.
    后端返 {...req, tasks: [...], eligible_for_done: bool}. */
export interface RequirementDetail extends Requirement {
  tasks: RequirementTask[];
  eligible_for_done: boolean;
}

/** 把后端 depends_on 字符串安全拆成 id 列表. 失败回空数组. */
export function parseRequirementDependencies(
  raw: string[] | null | undefined,
): string[] {
  // 后端已经解析过; 这里做类型收紧, 防御 null/undefined.
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string');
}

/** GET /api/requirements/[id] — 拉详情 (含 task 列表 + eligible_for_done). */
export function getRequirementDetail(id: string): Promise<RequirementDetail> {
  return get<RequirementDetail>(`/api/requirements/${id}`);
}

/** 详情页附件 — 与 master src/lib/runtime/types.ts Attachment 行映射一致. */
export interface RequirementAttachment {
  id: string;
  task_id: string | null;
  requirement_id: string | null;
  owner_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  storage_path: string;
  source: string;
  /** R121 metadata JSON 字符串, agent_generated 才有; 老 attachment = null. */
  metadata: string | null;
  created_at: string;
}

/** GET /api/requirements/[id]/attachments — 需求点附件列表.
    后端返 {attachments: RequirementAttachment[]}. */
export async function listRequirementAttachments(
  requirementId: string,
): Promise<RequirementAttachment[]> {
  const resp = await get<{ attachments: RequirementAttachment[] }>(
    `/api/requirements/${requirementId}/attachments`,
  );
  return resp.attachments ?? [];
}

/** DELETE /api/attachments/[id] — 通用附件删除端点 (polymorphic, 不区分 task / requirement).
    后端返 {ok: true} 或 {ok: false, error}. */
export function deleteAttachment(
  attachmentId: string,
): Promise<{ ok: boolean; error?: string }> {
  return del<{ ok: boolean; error?: string }>(`/api/attachments/${attachmentId}`);
}

/** 详情页用 — 把 size_bytes 格式化成 KB/MB. 与 master formatSize 同款. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  R142 G4: aggregates 聚合指标 (列表行内 chip 数据源)                */
/* ------------------------------------------------------------------ */

/** 需求点聚合指标 — 与 master aggregates route 字段对齐 (R142 G4).
    task_count = 关联 task 数 (含已完成的);
    completion_pct = 0..100 完成百分比 (后端已 *100, 四舍五入);
    latest_feedback = 最近一次 status/description 字段变更时间 (ISO 字符串)
      或 null (从没变更过). */
export interface RequirementAggregates {
  task_count: number;
  completion_pct: number;
  latest_feedback: string | null;
}

/** GET /api/requirements/[id]/aggregates — 单条聚合指标.
    后端走 getRequirementAggregates([id]) 复用批量 SQL, 拿 Map 第一个 entry.
    返回 {task_count, completion_pct, latest_feedback} — completion_pct 已 *100.
    失败抛 HttpError; 列表行用批量 + 静默 fallback 与 R14-vault revision 同款. */
export function getRequirementAggregates(
  id: string,
): Promise<RequirementAggregates> {
  return get<RequirementAggregates>(`/api/requirements/${id}/aggregates`);
}