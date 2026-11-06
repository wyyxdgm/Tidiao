// GET /api/tasks/[id]/stream - SSE event stream

import { NextRequest, NextResponse } from "next/server";
import { getRuntime, resolveTaskTimeoutMs } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate: a non-owner (or non-existent) task returns 404 before
  // opening the SSE stream.
  if (!getTaskById(id, userId, { includeDeleted: true })) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const runtime = getRuntime();

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let alive = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | null = null;

      // 幂等清理: 取消订阅 + 停心跳 + 关流. abort 与 enqueue 失败都走这里.
      function cleanup() {
        if (!alive) return;
        alive = false;
        if (unsubscribe) unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }

      // send 封装 enqueue: 写入失败(连接已断)立即清理, 不等 abort.
      function send(data: string) {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          cleanup();
        }
      }

      // Send initial connection event
      send(`data: ${JSON.stringify({ type: "connected", task_id: id })}\n\n`);

      // Subscribe to task events
      unsubscribe = runtime.subscribeToEvents(id, (event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Also send existing events from DB
      const existingEvents = runtime.getEvents(id);
      for (const event of existingEvents) {
        send(
          `data: ${JSON.stringify({ type: "history", event_type: event.type, data: event.data, task_id: event.task_id, session_id: event.session_id })}\n\n`
        );
        if (!alive) break;
      }

      // 兜底补 anchor: 历史 events 表里的 status_change 只持久化了 {from, to},
      //   不带 started_at / timeout_ms. 这俩字段是 emitEvent 在 transition 那一刻
      //   实时塞进 SSE 流的, 客户端只识别 type==="status_change" 来设 timeoutAnchor,
      //   type==="history" 被忽略. 所以「running 中刷新页面」/「断线重连」场景
      //   拿不到 anchor → 倒计时不渲染. 在历史回放结束后, 若当前 task.status ===
      //   "running", 追加一条合成 status_change (from==to), 用 emitEvent 同套字段.
      //   安全: matchingRules 不匹配 from==to 规则; STATUS_TO_WEBHOOK 不含 running;
      //   客户端只读 started_at / timeout_ms, 不更新 liveStatus (to===from 但取最近
      //   的 liveStatus 初值不影响显示).
      const currentTask = getTaskById(id);
      if (currentTask && currentTask.status === "running" && currentTask.started_at) {
        send(
          `data: ${JSON.stringify({
            type: "status_change",
            task_id: id,
            from: "running",
            to: "running",
            started_at: currentTask.started_at,
            timeout_ms: resolveTaskTimeoutMs(currentTask),
            source: "auto",
          })}\n\n`
        );
      }

      // 心跳: 每 25s 发 SSE 注释行(: 开头, 浏览器忽略), 保活连接 + 检测静默断开.
      // WSL portproxy 下浏览器关标签时 TCP FIN 可能不及时传到 Node, abort 不触发,
      // 靠心跳写入失败兜底清理, 避免订阅泄漏.
      heartbeat = setInterval(() => {
        send(": ping\n\n");
      }, 25000);

      // Clean up on client disconnect
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // R256: 关闭 nginx proxy_buffering (默认 on) — 否则 HTTP/1.1 上游分支把
      //   SSE 攒到 proxy_buffers 满才发 (每 25s 8 字节永远填不满 = 零字节交付,
      //   45s 505 行全在末尾一次性吐出实测). HTTP/2 分支不受此影响, 但浏览器
      //   之外的所有 h1 客户端 (curl/代理链) 全卡死. 响应头级开关比逐 vhost
      //   配置稳 (ao.example.com / mac.example.com 同样受益).
      "X-Accel-Buffering": "no",
    },
  });
}
