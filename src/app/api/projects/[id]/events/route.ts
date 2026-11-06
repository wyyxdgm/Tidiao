// GET /api/projects/[id]/events - SSE event stream for all tasks in a project
// Forwards status_change and cost events to board/chat views for real-time updates.

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getProjectById } from "@/lib/db/projects";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id: projectId } = await params;
  // Ownership gate: a non-owner (or non-existent) project returns 404 before
  // opening the SSE stream.
  if (!getProjectById(projectId, userId)) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
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
      send(`data: ${JSON.stringify({ type: "connected", project_id: projectId })}\n\n`);

      // Subscribe to project events
      unsubscribe = runtime.subscribeToProjectEvents(projectId, (event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });

      // 心跳: 每 25s 发 SSE 注释行(: 开头, 浏览器忽略). 本路由曾长期是全站唯一无心跳
      // 的 SSE —— pulu nginx 对 dao 系 vhost 设 proxy_read_timeout 300s, 项目页静默
      // 5 分钟即被掐流, 浏览器报 ERR_HTTP2_PROTOCOL_ERROR + EventSource 反复重连.
      // 对齐 /api/events 的保活 + 静默断开检测 (写失败兜底清理, 防订阅泄漏).
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
