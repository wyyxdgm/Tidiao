// GET /api/events - SSE event stream for all tasks across all projects
// Used by the global board view at /global. Forwards status_change and cost
// events so the board can show cross-project activity in real time.

import { NextRequest } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
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
      send(`data: ${JSON.stringify({ type: "connected", scope: "global" })}\n\n`);

      // Subscribe to all task events. emitEvent already filters to
      // status_change + cost, and forwards to globalSubscribers.
      unsubscribe = runtime.subscribeToAllEvents((event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

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
