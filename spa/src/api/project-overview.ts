// 项目概览 (overview) API 封装 —— 对应 master src/app/api/projects/[id]/overview.
//
// 用途: 每个项目一份 markdown 看板 (状态 / 常用链接 / 凭据备注), 存 DB 加密,
// 真相源是这个页面而不是 cwd 里的文件 (凭据不进 git).
//
// 关注点:
//  - GET 返回 {exists, markdown, updated_at, updated_by}. exists=false = 还没写
//    (前端渲染空态引导, 不是错误).
//  - PUT body = {markdown: string}. 后端有大小上限, 超了 400.
//  - owner 隔离: 非 owner 一律 404 (不暴露项目存在性).

import { get, put, del } from './http';

export interface ProjectOverview {
  /** 是否已写过. false = 空态. */
  exists: boolean;
  /** markdown 正文 (exists=false 时为 null). */
  markdown: string | null;
  /** 最后更新时间 (ISO 串). */
  updated_at: string | null;
  /** 最后写入者 user_id. */
  updated_by: string | null;
}

export function getProjectOverview(projectId: string): Promise<ProjectOverview> {
  return get<ProjectOverview>(`/api/projects/${projectId}/overview`);
}

/** 写概览. 返回落库后的正文 + 元信息. */
export function saveProjectOverview(
  projectId: string,
  markdown: string,
): Promise<ProjectOverview> {
  return put<ProjectOverview>(`/api/projects/${projectId}/overview`, { markdown });
}

/** 删概览. 后端对「本来就没有」返 404. */
export function deleteProjectOverview(projectId: string): Promise<{ ok: true }> {
  return del<{ ok: true }>(`/api/projects/${projectId}/overview`);
}
