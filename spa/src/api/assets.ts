// R30: assets 资源池 API 封装.
//
// 数据源:
//   - 列表:     GET /api/assets (跨 owner 隔离由后端 owner_id 过滤, 前端不传).
//   - 筛选下拉: GET /api/assets/filters (返回用户下有 attachment 的 project/version).
//   - 批量删除: POST /api/assets/delete-batch { ids: string[] }.
//   - 上传:     后端没有 "upload to asset pool" 端点; 走现有 POST /api/tasks/[id]/attachments
//               (multipart/form-data, 10MB 上限). 前端让用户挑一个 task 作为 parent.
//
// 关注点:
//   - 与 Next src/app/assets/assets-client.tsx 字段集对齐 (AssetItem / FilterData / TypeFilter / SourceFilter).
//   - 排序 / 分页 / 筛选参数全走 URLSearchParams, 切页不丢状态 (后续若要 URL 持久化, 上层包一层即可).
//   - uploadAttachment 走原生 fetch + FormData: 不能复用 http.ts 的 api(), 因为它会强制
//     Content-Type: application/json (会覆盖 multipart boundary 让后端 formData() 解析失败).

import { get, post, HttpError } from './http';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 单条 attachment 资源池行 — 与 master src/app/api/assets/route.ts 的 AssetListItem 对齐.
    task_title 可空 = 关联 task 已被删; project_id/version_id 可空 = task 没绑 project/version. */
export interface AssetItem {
  id: string;
  task_id: string;
  task_title: string | null;
  project_id: string | null;
  version_id: string | null;
  owner_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  source: string;
  created_at: string;
}

/** GET /api/assets 响应. */
export interface AssetListResponse {
  assets: AssetItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 列表筛选下拉 — 与 Next FilterData 对齐. */
export interface FilterVersion {
  id: string;
  name: string;
  count: number;
}

export interface FilterProject {
  id: string;
  name: string;
  count: number;
  versions: FilterVersion[];
}

export interface AssetFiltersResponse {
  projects: FilterProject[];
  orphan_count: number;
}

/** 资源类型筛选 — 与 Next TypeFilter 对齐 (空串 = 全部). */
export type AssetTypeFilter = '' | 'image' | 'video' | 'audio' | 'file';

/** 来源筛选 — 与 Next SourceFilter 对齐. */
export type AssetSourceFilter = '' | 'upload' | 'agent_generated' | 'fork';

/** 列表查询参数. */
export interface ListAssetsParams {
  q?: string;
  type?: AssetTypeFilter;
  source?: AssetSourceFilter;
  project_id?: string;
  version_id?: string;
  /** "created_at:desc" / "size_bytes:asc" 等. 默认 created_at:desc. */
  sort?: string;
  limit?: number;
  offset?: number;
}

/** 批量删除响应 — 与 Next doDelete 一致. */
export interface DeleteBatchResponse {
  deleted: number;
  failed: Array<{ id: string; error: string }>;
}

/** 上传响应 — 与 /api/tasks/[id]/attachments POST 响应一致. */
export interface UploadResponse {
  attachment: AssetItem;
}

/** 上传 task picker 用的最近 task 简表 — 与 master tasks/page 端点的 TaskTrimmed
    字段子集对齐, 只取 picker 渲染需要的 4 项. */
export interface RecentTaskItem {
  id: string;
  title: string;
  project_id: string | null;
  status: string;
}

/** tasks/page 信封 (我们只取 items 数组). */
interface TasksPageResponse {
  items: RecentTaskItem[];
  total: number;
  has_more: boolean;
}

/* ------------------------------------------------------------------ */
/*  列表 + 筛选                                                         */
/* ------------------------------------------------------------------ */

/** GET /api/assets — 列表 + 筛选 + 排序 + 分页. */
export function listAssets(params: ListAssetsParams = {}): Promise<AssetListResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type) qs.set('type', params.type);
  if (params.source) qs.set('source', params.source);
  if (params.project_id) qs.set('project_id', params.project_id);
  if (params.version_id) qs.set('version_id', params.version_id);
  qs.set('sort', params.sort ?? 'created_at:desc');
  qs.set('limit', String(params.limit ?? 50));
  qs.set('offset', String(params.offset ?? 0));
  return get<AssetListResponse>(`/api/assets?${qs.toString()}`);
}

/** GET /api/assets/filters — project/version 下拉选项 (含 attachment count). */
export function listAssetFilters(): Promise<AssetFiltersResponse> {
  return get<AssetFiltersResponse>('/api/assets/filters');
}

/* ------------------------------------------------------------------ */
/*  删除                                                                */
/* ------------------------------------------------------------------ */

/** POST /api/assets/delete-batch — 批量删除. ids 上限 200 (后端硬限). */
export function deleteAssetsBatch(ids: string[]): Promise<DeleteBatchResponse> {
  return post<DeleteBatchResponse>('/api/assets/delete-batch', { ids });
}

/* ------------------------------------------------------------------ */
/*  上传 — 走 task attachment 端点 (multipart)                            */
/* ------------------------------------------------------------------ */

/** POST /api/tasks/[id]/attachments — multipart/form-data 上传一个文件到指定 task.
    后端 10MB 上限 + 415 (不支持的 mime) + 413 (文件过大) — 错误走 HttpError 兼容上层. */
export async function uploadAttachmentToTask(
  taskId: string,
  file: File,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`/api/tasks/${taskId}/attachments`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
    // 故意不设 Content-Type —— 浏览器会用 boundary 自动补, 后端 request.formData() 才能解析.
  });
  if (!res.ok) {
    // 解析后端错误体; 后端返 { error, code, fieldErrors? } 形态.
    let body: { error?: string; code?: string; fieldErrors?: Record<string, string> } = {};
    try {
      const text = await res.text();
      if (text) body = JSON.parse(text);
    } catch {
      // 非 JSON body — 忽略, 用 HTTP 状态构造.
    }
    throw new HttpError({
      status: res.status,
      code: body.code,
      message: body.error || `HTTP ${res.status}`,
      fieldErrors: body.fieldErrors,
    });
  }
  return (await res.json()) as UploadResponse;
}

/* ------------------------------------------------------------------ */
/*  Upload modal 用的 task picker                                       */
/* ------------------------------------------------------------------ */

/** GET /api/tasks/page?statusGroup=all&limit=N — 拉最近 N 个 task (按 created_at 倒序).
    上传 modal 给用户挑一个 task 作为 parent. limit 默认 20 — 多了 modal 下拉看不过来. */
export async function listRecentTasks(limit: number = 20): Promise<RecentTaskItem[]> {
  const qs = new URLSearchParams();
  qs.set('statusGroup', 'all');
  qs.set('limit', String(Math.min(Math.max(1, limit), 200)));
  qs.set('offset', '0');
  const resp = await get<TasksPageResponse>(`/api/tasks/page?${qs.toString()}`);
  return Array.isArray(resp.items) ? resp.items : [];
}
