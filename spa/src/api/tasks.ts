// R33: tasks API 封装 — 仅含 GET /api/tasks?unassigned=true 一条, 专为
//   Uncategorized.vue 服务. master 后端 src/app/api/tasks/route.ts:47-57
//   在 ?unassigned=true 时返回当前用户 project_id IS NULL 的任务列表 (含软
//   删除过滤 + 按 updated_at DESC).
//
// 关注点:
// - 与 Next /uncategorized/page.tsx (server-side redirect → /{未分类project}/unversioned)
//   行为不同: SPA 走 REST API 直接拿真正的「未挂项目」tasks. 这是 Next 端遗留 bookmark
//   重定向 vs SPA 显式独立视图的口径差异, commit message 已披露.
// - 不引 R15 TaskTrimmed 完整投影: 该端点 SELECT * 返回 row 字段多于 TaskTrimmed;
//   本文件独立窄类型 UnassignedTask 只暴露视图需要的字段 (含 owner_id / priority /
//   时间戳等 R15 TaskCard 需要的子集, 余下字段不消费也不读取).
// - 不引 listTasks (M3+ 范畴, BoardPage R14 已有自己的 inline fetch), 避免共享文件
//   引入未使用导出. 本 helper 仅承担 R33 字面要求.

import { get, post, patch } from './http';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 任务状态枚举 — 与 master src/lib/runtime/types.ts TaskStatus 对齐 (R131 加 await_user). */
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'verifying'
  | 'await_user'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

/** UnassignedTask — 单条「未挂项目」任务视图模型.
    只暴露视图需要的字段, 余字段 (description / prompt_preview / cost_usd 等)
    后端 SELECT * 会一并返, 但本视图不消费. 调用方拿到后可强转 TaskCardData
    (R15 已对齐字段子集). */
export interface UnassignedTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  project_id: null;
  version_id: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** v531: 排队原因 (后端 GET /api/tasks 返回全字段自动带; queued 卡片显示). */
  queued_reason?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** 状态中文标签 — 与 master STATUS_LABELS 对齐.
    rejected: 历史遗留终态（2026-09-15 决策废弃，读路径已映射 cancelled 返回）,
    标签同步显示「已取消」— 曾误标「等待中」造成幽灵计数 (damo 2026-11-01 反馈). */
export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待执行',
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  reviewing: '待审核',
  verifying: '验收中',
  await_user: '等用户介入',
  completed: '已完成',
  failed: '失败',
  rejected: '已取消',
  cancelled: '已取消',
};

/** 11 状态全集, 给 status 过滤 chip 用. 顺序与 BoardPage R14 ACTIVE/TERMINAL 划分一致. */
export const ALL_TASK_STATUSES: TaskStatus[] = [
  'pending',
  'queued',
  'running',
  'paused',
  'reviewing',
  'verifying',
  'await_user',
  'completed',
  'failed',
  'rejected',
  'cancelled',
];

/** 显示用状态列表 = 全集剔除 rejected. rejected 已废弃（2026-09-15 决策，服务端
    读路径映射 cancelled），UI 不再单列 chip / 看板列，避免「已取消」出现两根
    同名 chip / 一根永远为空的列. */
export const DISPLAY_TASK_STATUSES: TaskStatus[] =
  ALL_TASK_STATUSES.filter((s) => s !== 'rejected');

/* ------------------------------------------------------------------ */
/*  Functions                                                          */
/* ------------------------------------------------------------------ */

/** GET /api/tasks?unassigned=true — 返回当前用户的未挂项目任务.
    后端 src/app/api/tasks/route.ts:47-57 实现: SELECT * FROM tasks WHERE
    project_id IS NULL AND owner_id = ? AND deleted_at IS NULL ORDER BY
    updated_at DESC, created_at DESC.
    关注点: 该端点不带分页 (legacy code), 单次返回全量. 历史实践上未挂项目
    的任务量极小 (用户手动清理/调度器漏派等场景); 不引分页. */
export function listUnassignedTasks(): Promise<UnassignedTask[]> {
  return get<UnassignedTask[]>('/api/tasks?unassigned=true');
}

/* ------------------------------------------------------------------ */
/*  R23 TaskNew — create / start / append attachments / list 限定字段 */
/* ------------------------------------------------------------------ */

/** 任务类型 — 与 master TASK_TYPES 对齐 (R78 §4.3 invariant). 空串 = 未分类. */
export type TaskType = '' | 'design' | 'dev' | 'test' | 'deploy';

/** 新建任务 body — 与 master POST /api/tasks 入参对齐 (PascalCase + snake 混合
    与 Next 端 page.tsx 一致). 所有字段都 optional, 但 project_id 后端校验必填
    (返 400 PROJECT_REQUIRED). prompt 由视图走 buildGoalPrompt 拼回 goal loop
    (R143). */
export interface CreateTaskBody {
  title: string;
  prompt: string;
  description?: string;
  cwd?: string;
  model?: string;
  llm_config_id?: string;
  effort?: string;
  maxTurns?: number;
  autoApprove?: boolean;
  priority?: number;
  allowedTools?: string[];
  tags?: string[];
  dependsOn?: string[];
  project_id: string;
  version_id?: string;
  type?: TaskType;
  /** R143 二轮: per-task max_goal_rounds 覆盖. undefined = 不传, 走 settings 默认 20. */
  goalRounds?: number;  idea_id?: string | null;
  node_id?: string | null;
  work_class?: string | null;
  // 波3 P5 (docs/plans/role-scoped-roles.md D5): 派发选角色 → prompt 头部
  // [role: Name] + model/effort/max_turns 继承 role 默认 (task 级字段优先).
  role_id?: string;
  // 波2.5 (v528): 任务级自动验收 — reviewing 瞬间自动翻 completed.
  // 仅 DAG 项目可用 (否则 400 AUTO_COMPLETE_REQUIRES_DAG).
  autoComplete?: boolean;
}

/** 新建任务 — POST /api/tasks. 响应返完整 task row (后端 createTask return). */
export function createTask(body: CreateTaskBody): Promise<UnassignedTask & Record<string, unknown>> {
  return post<UnassignedTask & Record<string, unknown>>('/api/tasks', body);
}

/** 启动任务 — POST /api/tasks/[id]/start. fire-and-forget (后端立刻返回 202). */
export function startTask(taskId: string): Promise<void> {
  return post<void>(`/api/tasks/${taskId}/start`);
}

/** PATCH /api/tasks/[id] — append_attachments 字段 (两阶段上传第二步). */
export function appendTaskAttachments(taskId: string, attachmentIds: string[]): Promise<void> {
  return patch<void>(`/api/tasks/${taskId}`, { append_attachments: attachmentIds });
}

/** R52.3 (B219): 解开等拍板标记 (awaiting_owner_review=1 → 0). POST /api/tasks/[id]/unset-awaiting-review
    用于 approve 被后端 409 gate 拦下时: 先调这个, 再 approve. 后端返 { status: string }. */
export function unsetAwaitingReview(taskId: string): Promise<{ status: string }> {
  return post<{ status: string }>(`/api/tasks/${taskId}/unset-awaiting-review`);
}

/** R52.6 (B230): 从指定 message uuid 处 fork 新 task. POST /api/tasks/[id]/fork.
    有附件时走 multipart (meta=JSON + file*) — R55.6 (B249) 镜像 master
    task-detail-client.tsx:3614-3651 文件 staging; 无附件走 JSON 保持原行为.
    R56-A4.1: session-head 模式 (R52 ForkModal setSessionHead) 不传 upToMessageId
    — 后端 forkSession 会从 session 末尾 fork, 此时字段省略. */
export interface ForkFromMessageBody {
  upToMessageId?: string;
  title?: string;
  prompt?: string;
  newCwd?: string;
  maxTurns?: number;
  autoApprove?: boolean;
  compactFirst?: boolean;
}

export interface ForkFromMessageResponse {
  ok: boolean;
  new_task_id: string;
  new_session_id: string;
  forked_from_session_id: string;
  attachments?: Array<{ id: string; filename: string; media_type: string; size_bytes: number }>;
}

export async function forkFromMessage(
  taskId: string,
  body: ForkFromMessageBody,
  files: File[] = [],
): Promise<ForkFromMessageResponse> {
  if (files.length === 0) {
    return post<ForkFromMessageResponse>(`/api/tasks/${taskId}/fork`, body);
  }
  const { postMultipart } = await import('@/api/http');
  return postMultipart<ForkFromMessageResponse>(`/api/tasks/${taskId}/fork`, body, files);
}

/** R52.9 (B251/B252): 恢复任务执行. POST /api/tasks/[id]/resume.
    前置: 已经 PATCH /api/tasks/[id] 更新了 auto_approve/max_turns (R52 master 同款). 后端返 { status: string }. */
export function resumeTask(taskId: string): Promise<{ status: string }> {
  return post<{ status: string }>(`/api/tasks/${taskId}/resume`);
}

/** R56-A4.11: 恢复已软删任务. POST /api/tasks/[id]/restore.
    master task-detail-client.tsx:1588 handleRestoreTask 同款. 后端返 200 OK, 不带 body. */
export function restoreTask(taskId: string): Promise<void> {
  return post<void>(`/api/tasks/${taskId}/restore`);
}

/** GET /api/tasks?limit=100 — 给依赖任务下拉用, 只取 status in (pending|completed|queued|paused) 的简表.
    后端 src/app/api/tasks/route.ts:62+ listTasks 已支持 limit + status filter. */
export interface DepTaskItem {
  id: string;
  title: string;
  status: TaskStatus;
}

export async function listDepTasks(): Promise<DepTaskItem[]> {
  const tasks = await get<Array<Record<string, unknown>>>('/api/tasks?limit=100');
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => ['pending', 'completed', 'queued', 'paused'].includes(t.status as string))
    .map((t) => ({
      id: String(t.id),
      title: String(t.title ?? ''),
      status: (t.status as TaskStatus) ?? 'pending',
    }));
}

/* ------------------------------------------------------------------ */
/*  R41-A3: task commits — GET /api/tasks/[id]/commits                  */
/* ------------------------------------------------------------------ */

/** 单条 commit entry — 与 master src/app/api/tasks/[id]/commits/route.ts 1:1.
    后端返 { task_id, task_title, commit_id, desc, files_json, created_at }. */
export interface TaskCommit {
  task_id: string;
  task_title: string;
  commit_id: string;
  desc: string | null;
  files_json: string | null;
  created_at: string;
}

/** 派生 task 摘要 — UI 用作 "派生 task" 折叠提示. */
export interface CommitDescendantTask {
  task_id: string;
  task_title: string;
}

export interface TaskCommitsResponse {
  root_task_id: string;
  depth: number;
  entries: TaskCommit[];
  descendant_tasks: CommitDescendantTask[];
}

/** 拉取 task 自身的 commit 列表 + 派生 task 的 commit 列表 (master R113 合并后端).
    失败抛 HttpError; UI 走 R13 ErrorView retry. */
export function getTaskCommits(taskId: string): Promise<TaskCommitsResponse> {
  return get<TaskCommitsResponse>(`/api/tasks/${taskId}/commits`);
}

/** 解析 files_json 字符串为文件列表. 后端文件存储为 JSON 数组字符串;
    解析失败或空返空数组 (兜底, UI 显示 "0 文件"). */
export function parseCommitFiles(filesJson: string | null): string[] {
  if (!filesJson) return [];
  try {
    const parsed = JSON.parse(filesJson) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* fall through */
  }
  return [];
}
/* ------------------------------------------------------------------ */
/*  顶栏全局任务搜索 (飞书 R180)                                        */
/* ------------------------------------------------------------------ */

/** 搜索结果条目 — GET /api/tasks?search= 返回全字段, 这里只声明 UI 消费的子集.
    R209: search 场景后端 LEFT JOIN projects/versions, 额外带 project_name /
    version_name (项目/版本被软删或未归属时为 null). */
export interface TaskSearchHit {
  id: string;
  title: string;
  status: TaskStatus;
  project_id: string | null;
  project_name?: string | null;
  version_name?: string | null;
  updated_at: string;
}

/** 顶栏搜索: 后端 LIKE 匹配 id / title / status / tags, updated_at DESC.
    失败抛 HttpError — TaskSearchBox catch 后静默保旧结果 (下拉不打扰用户). */
export function searchTasks(keyword: string, limit = 20): Promise<TaskSearchHit[]> {
  return get<TaskSearchHit[]>(
    `/api/tasks?search=${encodeURIComponent(keyword)}&limit=${limit}`
  );
}
