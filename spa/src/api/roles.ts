// Roles API — 波3 P5 (docs/plans/role-scoped-roles.md D5).
// 与 master /api/roles 对齐: GET(list, 可选 projectId 过滤)/POST/PATCH/DELETE.
// Role 行 = workflow.md §9 配置包 (system_prompt + defaults), 建任务时继承.

import { get, post, patch, del } from './http';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model: string | null;
  /** 后端 SELECT 直出 JSON 字符串 (["a","b"]), 前端 parse — 与 ports 同款容错. */
  allowed_tools: string | null;
  effort: string | null;
  max_turns: number | null;
  memory_doc: string | null;
  /** v525: null = 全局角色 (任何项目可用); string = 仅绑定项目可用. */
  project_id: string | null;
  /** v527: 1 = 允许飞书回写 (默认), 0 = 禁止 (行为开关, 非安全边界). */
  feishu_writeback: number;
  created_at: string;
  updated_at: string;
}

/** CreateTaskBody 透传字段: 建任务带角色 → prompt 头部 [role: Name] + 默认继承. */
export function listRoles(projectId?: string): Promise<Role[]> {
  return get<Role[]>('/api/roles' + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''));
}

export interface CreateRoleBody {
  name: string;
  system_prompt: string;
  description?: string;
  model?: string;
  allowed_tools?: string[];
  effort?: string;
  max_turns?: number;
  memory_doc?: string;
  /** 空/不传 = 全局. */
  project_id?: string | null;
  /** 缺省 = 1 (允许). */
  feishu_writeback?: number;
}

export function createRole(body: CreateRoleBody): Promise<Role> {
  return post<Role>('/api/roles', body);
}

/** PATCH 允许部分更新; project_id 传 null = 清成全局, feishu_writeback 传 0/1. */
export interface UpdateRoleBody extends Partial<CreateRoleBody> {
  project_id?: string | null;
}

export function updateRole(id: string, body: UpdateRoleBody): Promise<Role> {
  return patch<Role>(`/api/roles/${id}`, body);
}

export function deleteRole(id: string): Promise<void> {
  return del<void>(`/api/roles/${id}`);
}

/** 后端 allowed_tools 是 JSON 字符串 → 数组 (脏值容错返回 []). */
export function parseAllowedTools(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
