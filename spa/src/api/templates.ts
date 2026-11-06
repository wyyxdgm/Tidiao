// 🆕 R24: templates API 封装 — 与 master src/lib/db/templates.ts 的 Template 字段集对齐.
//   字段范围是 UI 渲染 + 表单编辑所需; 后端 PascalCase 入参 (maxTurns/autoApprove)
//   在前端也按 PascalCase 表达 (与 Next 端 page.tsx 同款, 不强行 camelCase↔snake_case 转).

import { get, post, patch, del } from './http';

/** 单条 template — 与 master templates.ts listTemplates 返回结构对齐.
    可空字段 (description/model/llm_config_id/max_turns/effort/tags/owner_id)
    表示「这条 template 没用这个字段」, UI 渲染前要 ?? '—' 兜底.
    allowed_tools 在 master 里有, 但当前 UI 不展示 (Next 也没展示), 仅做字段占位. */
export interface Template {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  model: string | null;
  llm_config_id: string | null;
  allowed_tools: string | null;
  max_turns: number | null;
  effort: string | null;
  auto_approve: number;
  tags: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

/** v50 引入 — 当前用户可见的 LLM 配置 (自配 + 平台授权). 模板/任务创建时从这里选.
    与 Next AvailableLlmConfig 类型同结构, source = self/admin_grant 区分来源. */
export interface AvailableLlmConfig {
  id: string;
  source: 'self' | 'admin_grant';
  name: string;
  is_default: boolean;
}

/** GET /api/user/llm-config/available 响应信封 — 后端返 {configs: AvailableLlmConfig[]}. */
interface AvailableLlmConfigsResponse {
  configs: AvailableLlmConfig[];
}

/** 新建模板的 body — 与 master createTemplate 入参对齐 (PascalCase). */
export interface CreateTemplateBody {
  name: string;
  prompt: string;
  description?: string;
  model?: string;
  llm_config_id?: string | null;
  maxTurns?: number;
  effort?: string;
  autoApprove?: boolean;
  tags?: string[];
}

/** 编辑模板的 body — 与 master updateTemplate 入参对齐; 所有字段可选 (不传 = 不覆盖). */
export interface UpdateTemplateBody {
  name?: string;
  prompt?: string;
  description?: string;
  model?: string | null;
  llm_config_id?: string | null;
  maxTurns?: number | null;
  effort?: string | null;
  autoApprove?: boolean;
  tags?: string[];
}

/** GET /api/templates — 拉当前用户全部 template. 后端按 owner_id 过滤, 不需传参. */
export function listTemplates(): Promise<Template[]> {
  return get<Template[]>('/api/templates');
}

/** POST /api/templates — 新建. 返回新建后的完整 template. */
export function createTemplate(body: CreateTemplateBody): Promise<Template> {
  return post<Template>('/api/templates', body);
}

/** PATCH /api/templates/[id] — 编辑. 返回更新后的 template; 后端只覆盖 body 里出现的字段. */
export function updateTemplate(id: string, body: UpdateTemplateBody): Promise<Template> {
  return patch<Template>(`/api/templates/${id}`, body);
}

/** DELETE /api/templates/[id] — 硬删 (master templates.ts 无软删除通道, 与 schedules 不同). */
export function deleteTemplate(id: string): Promise<void> {
  return del<void>(`/api/templates/${id}`);
}

/** GET /api/user/llm-config/available — 拉当前用户可见的 LLM 配置. 响应是 {configs: [...]} 信封,
    这里拆开返回数组. 网络/解析失败时返回空数组 (UI 退化: 不显示 LLM 配置选择, 仅保留默认). */
export async function listAvailableLlmConfigs(): Promise<AvailableLlmConfig[]> {
  try {
    const resp = await get<AvailableLlmConfigsResponse>('/api/user/llm-config/available');
    return resp.configs ?? [];
  } catch {
    return [];
  }
}

/** 把后端的 tags (JSON 字符串或 null) 解析为字符串数组. 解析失败返回空数组. */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string');
    return [];
  } catch {
    return [];
  }
}

/** 把字符串数组序列化为后端 tags JSON 字符串. 空数组返回 null (后端期望 null = 没标签). */
export function serializeTags(tags: string[]): string | null {
  if (!tags.length) return null;
  return JSON.stringify(tags);
}