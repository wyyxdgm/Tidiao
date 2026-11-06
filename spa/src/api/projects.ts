import { get, post, patch, del } from './http';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  // 后端 GET 直接 SELECT 出 DB 列 = JSON 字符串 ("[13001,13002]"), 不是
  // number[] —— master listProjects/getProjectById 都没解析. 接受 string 让
  // 调用方 (ProjectsView projectMetaText / ProjectDetailView formatPorts) 容错
  // 处理. 仅写入 (CreateProjectBody.ports) 是 number[].
  ports: number[] | string | null;
  // owner_id + current_version_id 是 R107 R 列跟进 R15 新建视图需要:
  // visibleProjects 按 owner_id 过滤 (与 NavigationTree.ownedProjects 同款规则),
  // version select 标记当前版本. master /api/projects?sort=manual 全量返回,
  // R28 Requirements.vue 不用这些字段, 类型上加 optional 保持兼容.
  owner_id?: string | null;
  current_version_id?: string | null;
  current_version_name?: string | null;
  // R49.5 (B012/B060): pinned 0/1, master src/lib/db/projects.ts:117 — listProjects
  // 总是 ORDER BY pinned DESC 优先. SPA 项目卡片右上角 toggle 用.
  pinned?: number;
  // sort_order: 侧栏拖拽重排的持久化字段, 镜像 master src/lib/db/projects.ts:
  // 117. 列表 API 不返 (前端不依赖), reorderProject 内部乐观写入 + PATCH.
  sort_order?: number | null;
  created_at: number;
  // R70 advanced-options 字段 (master src/lib/db/projects.ts:122-138):
  //   parallel_limit     同 cwd 并发上限 (1 = 串行; 默认服务端 1)
  //   timeout_minutes    任务壁钟超时 (null = 跟随全局默认)
  //   wiki_extra_extensions  Wiki 额外可读扩展名 (JSON 数组或 JSON 字符串)
  //   runners            远程执行白名单 entries (JSON 数组或字符串)
  // 后端 GET 直接 SELECT 出 DB 列, 不解析 — 与 ports 同款容错 string / array / null.
  parallel_limit?: number | null;
  timeout_minutes?: number | null;
  wiki_extra_extensions?: string[] | string | null;
  runners?: RunnerEntry[] | string | null;
  // 波3 P5: DAG 拓扑调度开关 (projects.dag_enforced, 1 = DAG 项目).
  // auto_complete 勾选框按此置灰 (AUTO_COMPLETE_REQUIRES_DAG).
  dag_enforced?: number | null;
  // v532 (侧栏右键操作): starred 1 = 收藏 (排序 pinned 之后第二优先段;
  // 不变量 pin ⇒ star). archived 1 = 归档 (主列表隐藏, 归档分组可见可恢复).
  starred?: number;
  archived?: number;
}

/** R70 advanced-options: 远程执行白名单条目. 与 master src/lib/db/projects.ts
    ProjectRunnerEntry 字段对齐 (purpose / cwd_mapping / command_patterns 数组 +
    可选 os_type 由面板从 runner select 自动取). 提交前由 ProjectAdvancedOptionsPanel
    内 parseStoredRunners 把后端 JSON 字符串 normalize 成数组. */
export interface RunnerEntry {
  runner_id: string;
  purpose: string;
  cwd_mapping: string;
  command_patterns: string[];
  os_type?: string;
}

export interface Version {
  id: string;
  project_id: string;
  name: string;
  /** v513 (飞书 R172): 版本描述（「版本干啥的」）. 老 DB 行可能缺字段. */
  description?: string | null;
  feishu_url: string | null;
  feishu_sheet: string | null;
  cwd: string | null;
  is_current: number;
  // R49.11 master versions.ts:23 — sqlite 无 native bool, 0|1, stable 标签用.
  is_released?: number;
  // v512: sheetwatch 开关. 1 = 自动派发扫此 version 的飞书表, 0 = 跳过.
  // 缺字段 = 老 DB 行, 一律按 1 (启用) 处理, 与 partner scripts/sheetwatch 一致.
  enable?: 0 | 1;
  created_at: number;
}

export function listProjects(
  sort?: 'created_at' | 'recent_activity' | 'manual',
  /** v532: true = 拉归档项目列表 (?archived=1), 默认拉活跃项目. */
  archived?: boolean,
) {
  const params: string[] = [];
  if (sort) params.push(`sort=${sort}`);
  if (archived) params.push('archived=1');
  const q = params.length ? `?${params.join('&')}` : '';
  return get<{ projects: Project[] }>(`/api/projects${q}`);
}

/** R49.2: 单条 project template — 与 master src/lib/db/templates.ts ProjectTemplate 对齐. */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  icon?: string | null;
  estimated_minutes?: number | null;
  project?: {
    name?: string;
    description?: string | null;
    cwd?: string | null;
  } | null;
}

export function listVersions(projectId?: string) {
  return get<{ versions: Version[] }>(
    `/api/versions${projectId ? `?project=${projectId}` : ''}`,
  );
}

/* ------------------------------------------------------------------ */
/*  R16 增量: 详情页用单条 endpoint                                     */
/* ------------------------------------------------------------------ */

/** GET /api/projects/[id] — 单条项目元数据 (master route 返 {project: Project}). */
export async function getProjectById(id: string): Promise<Project | null> {
  try {
    const resp = await get<{ project: Project }>(`/api/projects/${id}`);
    return resp.project;
  } catch {
    // 404/401 等都按"无"处理, 详情页走"未分类"兜底.
    return null;
  }
}

/** GET /api/versions/[id] — 单条 version (master route 返 {version: Version}). */
export async function getVersionById(id: string): Promise<Version | null> {
  try {
    const resp = await get<{ version: Version }>(`/api/versions/${id}`);
    return resp.version;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  R41-C1: 项目创建 — POST /api/projects                                 */
/* ------------------------------------------------------------------ */

/** POST /api/projects body — 与 master src/app/api/projects/route.ts POST 1:1.
    字段全部可选, 但 name 必填 (后端 400 校验). ports 后端接受 number[] 或逗号分隔 string. */
export interface CreateProjectBody {
  name: string;
  description?: string;
  cwd?: string;
  ports?: number[];
}

/** POST /api/projects — 创建新项目. 后端返 {project: Project}, 201. */
export async function createProject(body: CreateProjectBody): Promise<Project> {
  const resp = await post<{ project: Project }>('/api/projects', body);
  return resp.project;
}

/** R49.17 POST /api/versions body — 与 master createVersion 入参对齐. */
export interface CreateVersionBody {
  project_id: string;
  name: string;
  /** v513 (飞书 R172): 版本描述（「版本干啥的」）. */
  description?: string | null;
  feishu_url?: string | null;
  feishu_sheet?: string | null;
  /** v512: sheetwatch 开关. 不传 = 后端默认 true. */
  enable?: boolean;
}

/** POST /api/versions — 后端返 {version: Version}, 201. R49.17 submitNewVersion 用. */
export async function createVersion(body: CreateVersionBody): Promise<Version> {
  const resp = await post<{ version: Version }>('/api/versions', body);
  return resp.version;
}

/** v513 (飞书 R172): AI 解析输入的建议值. source 标注字段来源, UI 显示徽标. */
export interface VersionSuggestion {
  name: string | null;
  description: string | null;
  feishu_url: string | null;
  feishu_sheet: string | null;
  sources: {
    name: 'ai' | 'none';
    description: 'ai' | 'none';
    feishu_url: 'text' | 'none';
    feishu_sheet: 'id-mapped' | 'ai' | 'none';
  };
}

/** POST /api/versions/ai-parse — 解析自由文本 → 新版本表单建议值 (不落库). */
export async function aiParseVersion(
  projectId: string,
  text: string,
): Promise<{ suggestion: VersionSuggestion; llmFailed: boolean }> {
  const resp = await post<{ suggestion: VersionSuggestion; llm_failed: boolean }>(
    '/api/versions/ai-parse',
    { project_id: projectId, text },
  );
  return { suggestion: resp.suggestion, llmFailed: resp.llm_failed };
}

/** GET /api/project-templates — 拉取平台出厂模板列表 (无鉴权, 失败降级 []).
    R49.2 与 master projects-client.tsx:283-300 useEffect 拉模板同口径.
    模板加载失败不阻断主流程 — 空数组 = 不显示模板按钮. */
export async function listProjectTemplates(): Promise<ProjectTemplate[]> {
  try {
    const resp = await get<{ templates: ProjectTemplate[] }>(
      '/api/project-templates',
    );
    return Array.isArray(resp.templates) ? resp.templates : [];
  } catch {
    return [];
  }
}

/** GET /api/port-pool/available?n=5 — 拉取端口池内可用端口.
    R49.4 与 master projects-client.tsx:388 autoPickPorts 同口径.
    失败降级 [] — UI 弹 toast. */
export async function listAvailablePorts(n = 5): Promise<number[]> {
  try {
    const resp = await get<{ available: number[] }>(
      `/api/port-pool/available?n=${n}`,
    );
    return Array.isArray(resp.available) ? resp.available : [];
  } catch {
    return [];
  }
}

/** R49.5 (B012/B060) PATCH /api/projects/[id] body — 与 master updateProject 入参对齐.
    字段全部 optional. R56-B6: 加 sort_order — 侧栏拖拽重排持久化 (mirror master
    NavigationTree.tsx:184-211 reorderProjects, 后端 src/lib/db/projects.ts:602-615
    已接受 sort_order). R70: 加 5 个 advanced-options 字段 (wiki_extra_extensions /
    parallel_limit / timeout_minutes / ports / runners) — 一次性 PATCH 提交, 与
    master AdvancedOptionsPanel saveAdvancedConfig 同款. null = 清空, undefined =
    不动 (后端语义). */
export interface UpdateProjectBody {
  pinned?: number;
  current_version_id?: string | null;
  sort_order?: number;
  // v532 (侧栏右键操作): 重命名 / 收藏 / 归档. archived:1 = 归档, 0 = 恢复.
  // 不变量 pin ⇒ star 由 store 层维护 (置顶时同时传 starred:1).
  name?: string;
  starred?: number;
  archived?: number;
  // R70 advanced-options:
  wiki_extra_extensions?: string[] | null;
  parallel_limit?: number | null;
  timeout_minutes?: number | null;
  ports?: number[] | null;
  runners?: RunnerEntry[] | null;
}

/** PATCH /api/projects/[id] — 后端返 {project: Project}. R49.5/6 togglePin 用. */
export async function updateProject(
  id: string,
  body: UpdateProjectBody,
): Promise<Project> {
  const resp = await patch<{ project: Project }>(`/api/projects/${id}`, body);
  return resp.project;
}

/** DELETE /api/projects/[id] — 软删 (master 级联隐藏所有 version + task).
    R49.7 接 UI, R49.8 接 ConfirmDialog 二次确认. */
export async function deleteProject(id: string): Promise<void> {
  await del<void>(`/api/projects/${id}`);
}

/** PATCH /api/versions/[id] body — 与 master updateVersion 入参对齐 (含 feishu_url/sheet 清空). */
export interface UpdateVersionBody {
  /** R176: 版本名. 后端 db updateVersion 支持 name (PATCH 路由无白名单拦截). */
  name?: string;
  /** v513 (飞书 R172): 版本描述. 传 null = 清空. */
  description?: string | null;
  feishu_url?: string | null;
  feishu_sheet?: string | null;
  /** v512: sheetwatch 开关. 不传 = 不动该列 (后端 undefined 即不改). */
  enable?: boolean;
}

/** PATCH /api/versions/[id] — 后端返 {version: Version}. R49.13 saveEditVersion 用. */
export async function updateVersion(
  id: string,
  body: UpdateVersionBody,
): Promise<Version> {
  const resp = await patch<{ version: Version }>(`/api/versions/${id}`, body);
  return resp.version;
}

/** DELETE /api/versions/[id] — 软删 (master 级联隐藏 task). R49.14 接 UI + handler. */
export async function deleteVersion(id: string): Promise<void> {
  await del<void>(`/api/versions/${id}`);
}