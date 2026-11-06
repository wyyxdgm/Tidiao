// R70: 项目级 LLM 配置 (multi-config CRUD) — 镜像 master
// src/app/api/projects/[id]/llm-config/* 与 src/lib/db/llm-configs.ts LlmConfigSafe.
//
// SPA 当前在 Settings.vue 已有 user-level LLM CRUD, 本文件走同款 pattern
// 但接口走 /api/projects/[id]/llm-config (per-project owner). 字段集对齐
// LlmConfigSafe (api_key 返回 masked + has_api_key flag, 不返明文).
// 创建/更新时 api_key 走请求体 (不入 GET 响应), update 时 clear_api_key=true
// 显式清空 (master LlmConfigError "clear_required" 兜底).
//
// 关注点:
// - owner_type 在 client 隐含 'project', 不暴露 selector.
// - 协议 type 当前固定 'anthropic' (master 暂不开放其它协议), UI 也不暴露.
// - default toggle 服务端事务: 同项目其它 default 自动清零, 跟 master 同款.
// - 默认 config 删也放行 (R215: 删光回落平台默认配置), 服务端不再回 default_in_use.

import { get, post, put, del } from './http';

export interface ProjectLlmConfig {
  id: string;
  name: string;
  type: string; // 协议类型, 当前固定 'anthropic'
  api_key_masked: string | null;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
}

export interface ProjectLlmConfigInput {
  name: string;
  base_url?: string | null;
  model?: string | null;
  /** 编辑时留空 = 保留现有 key; 勾选 clear_api_key=true 时才真清空. */
  api_key?: string;
  /** true 时后端清空 api_key (优先级高于 api_key 字段). */
  clear_api_key?: boolean;
}

/** GET /api/projects/[id]/llm-config — 列出该项目所有 LLM 配置. */
export async function listProjectLlmConfigs(
  projectId: string,
): Promise<ProjectLlmConfig[]> {
  const resp = await get<{ configs: ProjectLlmConfig[] }>(
    `/api/projects/${projectId}/llm-config`,
  );
  return Array.isArray(resp.configs) ? resp.configs : [];
}

/** POST /api/projects/[id]/llm-config — 新建一条 LLM 配置. */
export async function createProjectLlmConfig(
  projectId: string,
  body: ProjectLlmConfigInput,
): Promise<ProjectLlmConfig> {
  const resp = await post<ProjectLlmConfig>(
    `/api/projects/${projectId}/llm-config`,
    body,
  );
  return resp;
}

/** PUT /api/projects/[id]/llm-config/[configId] — 编辑现有配置. */
export async function updateProjectLlmConfig(
  projectId: string,
  configId: string,
  body: ProjectLlmConfigInput,
): Promise<ProjectLlmConfig> {
  const resp = await put<ProjectLlmConfig>(
    `/api/projects/${projectId}/llm-config/${configId}`,
    body,
  );
  return resp;
}

/** POST /api/projects/[id]/llm-config/[configId]/default — 设为项目默认配置.
    服务端事务: 同 owner 其它 default 自动清零. */
export async function setProjectLlmConfigDefault(
  projectId: string,
  configId: string,
): Promise<ProjectLlmConfig> {
  const resp = await post<ProjectLlmConfig>(
    `/api/projects/${projectId}/llm-config/${configId}/default`,
    {},
  );
  return resp;
}

/** DELETE /api/projects/[id]/llm-config/[configId] — 删一条. R215: 默认/最后一份
    也允许删 (删光回落平台默认配置), server 兜底. */
export async function deleteProjectLlmConfig(
  projectId: string,
  configId: string,
): Promise<void> {
  await del<void>(`/api/projects/${projectId}/llm-config/${configId}`);
}