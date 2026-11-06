// server-actor: 从 request header 解析 actor 上下文 (R63 时间线用).
//
// 关注点:
//   - x-actor-type: 缺省 'user' (浏览器手动). 显式 'agent' 或 'system' 由调用方 (CLI /
//     agent SDK / 平台内部) 设. 非法值回退 'user', 不 400, 保证主流程不受影响.
//   - x-actor-id: agent 名 / user id. user 走 x-user-id, 不读 header, 避免重复.
//   - x-ao-task-id: 可选. agent 改动时填来源 task_id, 时间线胶囊点过去能跳 /tasks/<id>.

import { NextRequest } from "next/server";
import type { RevisionActor } from "@/lib/db/requirement-revisions";

export function parseActorFromRequest(
  request: NextRequest,
  userId: string
): RevisionActor {
  const rawType = request.headers.get("x-actor-type")?.trim().toLowerCase();
  const type =
    rawType === "agent" || rawType === "system" ? rawType : "user";
  const id = request.headers.get("x-actor-id")?.trim() || userId;
  const taskId = request.headers.get("x-ao-task-id")?.trim() || null;
  return { type, id, task_id: taskId };
}