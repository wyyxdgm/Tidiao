// GET /api/tasks/[id]/events - 列出 task 的执行事件 (R142 G5)
//
// 数据源: src/lib/db/events.ts getEventsByTaskId(id, limit?), 复用 timeline/changes
//   路径同一个底层 helper, 不重复建 SQL. 按 events.id DESC 取最近 limit 条.
//
// 关注点:
//   - 权限: admin (x-user-role === 'admin') OR task owner. 跨 owner 一律 404
//     (跟 [id]/route.ts owner-scoped 对齐), 不暴露 task 存在性.
//   - 默认 limit=50. 可选 ?limit=, 上限 200 防滥用.
//   - 返回顺序 DESC (最近在前), 与 SPA RequirementDetail.vue feedback timeline
//     「task events 段」对齐.
//   - 暂不过滤事件类型: 全返 (tool_use / status_change / cost / error /
//     webhook_delivered 等). SPA 自己按 type filter 渲染. 这与现有
//     /api/tasks/[id]/timeline 把 status_change 过滤掉的特化形态不同 —
//     events 端是原貌 dump, timeline 端是加工过的子集.
//
// v2.0-spa 用途: RequirementDetail.vue 在 FeedbackTimeline / RevisionTimeline
//   段之外, 单独展示「TaskEventsTimeline」(master 后端用法).

import { NextRequest, NextResponse } from "next/server";
import { getEventsByTaskId } from "@/lib/db/events";
import { getTaskById } from "@/lib/db/tasks";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = request.headers.get("x-user-role") === "admin";
  const { id } = await params;

  // owner 校验; admin 可读任意 task 的事件. 跨 owner 一律 404.
  const task = getTaskById(id, isAdmin ? undefined : userId, { includeDeleted: true });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // 可选 ?limit= 限, 默认 50, 上限 200.
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = (() => {
    if (limitParam === null) return 50;
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > 200) return 50;
    return n;
  })();

  // getEventsByTaskId 在 limit 形参存在时按 id DESC 取最近 N 条, 与 SPA 期望顺序一致.
  const events = getEventsByTaskId(id, limit);

  return NextResponse.json({
    task_id: id,
    events: events.map((e) => ({
      id: e.id ?? null,
      type: e.type,
      session_id: e.session_id ?? null,
      data: (() => {
        // data 是 JSON 字符串; 尝试解析, 失败兜底返原文 (前端再尝试).
        try {
          return JSON.parse(e.data);
        } catch {
          return e.data;
        }
      })(),
      created_at: e.created_at ?? null,
    })),
  });
}
