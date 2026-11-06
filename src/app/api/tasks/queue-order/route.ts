// POST /api/tasks/queue-order
// 看板拖拽手动排序 — 一次性把目标列可见 task 全部写连续 queued_order, 调度器
//   即时按新顺序派发. body = { orders: [{id, order}, ...] }.
// 与已有 PATCH /api/tasks/[id] (单 task) 不冲突: 那条改 priority / title 等, 不
//   涉及排序元数据; 本路径专门改 queued_order, 且是 batch (一条请求 N 个 task,
//   否则拖一次 N 次 PATCH = N 次 SSE patch 风暴).
//
// 关注点:
//   - 鉴权: 所有 task 必须属当前 user (getTaskById(id, userId) 兜底, null → 404
//     含存在性泄漏防御).
//   - 校验: 至少 1 条; order 是有限整数 (含负数: API 不限制方向, 前端选连续
//     10/20/30… 留空位); id 是合法 task UUID. 不存在的 id 立刻 404.
//   - 写库走 reorderQueuedTasks (transaction, 半成品回滚).
//   - 通知调度器: getRuntime().scheduler.reorderQueue(orders) — 替换 cache
//     + 重排 this.queue. 不调 schedule(): reorder 只改顺序, 不影响可调度
//     性 (cwd lock / running 槽位 / owner cap 都没动), 现有 schedule() 已在
//     飞, 改顺序等下次 dispatch 自然生效.
//   - 触发 SSE: 不写 status_change, 但每条 task 的 queued_order 是 DB 字段,
//     看板前端 SSE patch 只覆盖 status/updated_at, 不覆盖排序元数据 (后者由
//     本次 PATCH 走自身 fetch 拿到, 不需要服务端推).

import { NextRequest, NextResponse } from "next/server";
import { getTaskById, reorderQueuedTasks } from "@/lib/db/tasks";
import { getRuntime } from "@/lib/runtime/agent-runtime";

interface ReorderRequest {
  orders: Array<{ id: string; order: number | null }>;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ReorderRequest;
  try {
    body = (await request.json()) as ReorderRequest;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  if (!body || !Array.isArray(body.orders) || body.orders.length === 0) {
    return NextResponse.json(
      { error: "orders must be a non-empty array" },
      { status: 400 },
    );
  }

  // 校验每条记录 + ownership
  for (const item of body.orders) {
    if (!item || typeof item.id !== "string" || !item.id) {
      return NextResponse.json(
        { error: "each order entry needs a string id" },
        { status: 400 },
      );
    }
    if (item.order !== null && !isFiniteInt(item.order)) {
      return NextResponse.json(
        { error: `order must be integer or null, got ${String(item.order)} for ${item.id}` },
        { status: 400 },
      );
    }
    if (!getTaskById(item.id, userId)) {
      return NextResponse.json(
        { error: `task ${item.id} not found` },
        { status: 404 },
      );
    }
  }

  const { updated } = reorderQueuedTasks(body.orders);

  // 通知调度器重排内存队列. 顺序要紧: 写库先, 调度器后 — 万一写库失败
  //   (transaction 抛错), 调度器不应拿到「新顺序」按错序派发; 反之调度器
  //   抛错不阻断 200, DB 已是真值, 下次 schedule() 兜底按 DB 真值排序.
  try {
    getRuntime().getScheduler().reorderQueue(body.orders);
  } catch (err) {
    console.error("[queue-order] scheduler reorder failed (DB 已写, 下次 schedule 兜底)", err);
  }

  return NextResponse.json({ ok: true, updated });
}