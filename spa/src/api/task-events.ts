// 🆕 R40 (G5 收口): task events API 封装 — 与 master
//   src/app/api/tasks/[id]/events/route.ts 的 DTO 对齐.
//
// DTO 形状 (后端 GET /api/tasks/[id]/events?limit=N):
//   {
//     task_id: string,
//     events: [
//       {
//         id: number | null,
//         type: string,           // status_change / tool_use / cost / error / message 等
//         session_id: string | null,
//         data: object | string,  // JSON 已解析; 解析失败后端兜底返原文
//         created_at: string | null,
//       },
//     ],
//   }
//
// 关注点:
//   - 后端默认 limit=50, 上限 200. SPA 默认 50 (与 master feedback-timeline
//     max=10 的视觉节奏对齐, 多了也只显示 10).
//   - data 是 JSON 已解析; 但极端情况后端兜底会返原文字符串, 类型用 unknown 兜底.
//   - 单 task 拉失败 = Promise.allSettled 在调用方处理, 失败静默不阻断 (与
//     R14-vault revisions / R14 附件 同款「失败静默」, 见 RequirementDetail.vue).

import { get } from './http';

/** 单条 task event — 与 master events 表 TaskEvent (src/lib/runtime/types.ts:238)
    + G5 REST DTO (route.ts:54-67) 字段集 1:1 对齐. */
export interface TaskEvent {
  id: number | null;
  type: string;
  session_id: string | null;
  /** JSON 已解析 (首选) / 解析失败原文 (兜底). SPA 渲染层一律走 textContent,
      不当 string 信任也安全. */
  data: unknown;
  created_at: string | null;
}

/** GET /api/tasks/[id]/events 响应包络. */
export interface TaskEventsResponse {
  task_id: string;
  events: TaskEvent[];
}

/** GET /api/tasks/[id]/events — 拉某 task 的事件列表.
    limit 默认 50, 上限 200 (后端兜底). 失败 throw HttpError, 调用方走
    Promise.allSettled 兜底. */
export async function getTaskEvents(
  taskId: string,
  params: { limit?: number } = {},
): Promise<TaskEvent[]> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString();
  const resp = await get<TaskEventsResponse>(
    `/api/tasks/${taskId}/events${suffix ? `?${suffix}` : ''}`,
  );
  return resp.events ?? [];
}