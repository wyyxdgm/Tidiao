// GET /api/schedules/runs/[runId]/stream - SSE 流式推送 shell schedule run 日志
//
// 飞书 R86 第二轮实施:damo 拍方案 A=SSE。damo 原话:
//   "我说的是xxx.log文件里的内容查看。能像bt面板里的那种安装软件时的日志似的吗。
//    持续输出日志。如果在跑的话,要么就直接显示跑过的那些。"
//
// 关注点:
//   - runId 来自 URL path, parseInt 拿 number(SQLite schedule_runs.id INTEGER AUTOINCREMENT)。
//     非数字 = 404(防 throw),不泄露存在性。
//   - owner 校验走两步:先 getScheduleRunById(runId) → schedule_id → getScheduleById 验 owner。
//     admin 跳过 owner 校验(与现有 runs/route.ts ownerScope 同模式)。
//   - 数据源优先级:
//     ① fireShell 写进 liveRuns Map 的 in-memory snapshot(每个 stdout chunk 同步写入,
//        1s 轮询 1 次,前端看到「持续追加」的滚动效果);
//     ② liveRuns 没数据(=已经过去 5min cleanup / 老 run / 进程重启):
//        兜底读 DB schedule_runs.output/error 推一次完整 + completed:true + close,
//        前端展示走 R79 原 LogViewerDialog 静态视图,不会再追加。
//   - 完成条件:liveRuns.completed=true 推一次后 close;或 DB 兜底后 close;
//     没 completed 也不会永远跑(用户 abort / 关标签都走 request.signal.abort)。
//   - 心跳:每 25s 发 ": ping\n\n" (与 tasks/[id]/stream 同模式)。
//   - cleanup:enqueue 失败 / abort / close 触发,stop interval + 关 controller。

import { NextRequest } from "next/server";
import { getScheduleById, getScheduleRunById } from "@/lib/db/schedules";
import { getLiveRun } from "@/lib/runtime/schedule-runner";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { runId: runIdRaw } = await params;
  const runId = parseInt(runIdRaw, 10);
  if (!Number.isFinite(runId) || runId <= 0) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Ownership gate (两步): 拿到 run → schedule_id → schedule ownership。
  // admin (x-user-role === "admin") 跳过 owner 校验,与 runs/route.ts 同模式。
  const isAdmin = request.headers.get("x-user-role") === "admin";
  const run = getScheduleRunById(runId);
  if (!run) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const schedule = getScheduleById(run.schedule_id, isAdmin ? undefined : userId);
  if (!schedule) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let alive = true;
      let interval: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      // "推完最终帧后准备关闭" —— DB 兜底路径和 completed=true 后都用它。
      let pendingClose = false;
      // 把 run 拉到 closure (已 null-check 过), 避免 inner function 重新 narrowing。
      const runRow = run;

      function cleanup() {
        if (!alive) return;
        alive = false;
        if (interval) clearInterval(interval);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      function send(data: string) {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          cleanup();
        }
      }

      function pushFrame(payload: object): void {
        send(`data: ${JSON.stringify(payload)}\n\n`);
      }

      // DB 兜底路径:liveRuns 没了 (5min cleanup 过了 / 老 run / 重启后),推一次完整 + close。
      // 不需要 heartbeat,推完就关。
      function fallbackToDb(): void {
        pushFrame({
          stdout: runRow.output ?? "",
          stderr: runRow.error ?? "",
          completed: true,
          exitCode: runRow.exit_code,
          source: "db",
        });
        pendingClose = true;
        // 给客户端 50ms 收尾时间,再 close
        setTimeout(cleanup, 50);
      }

      // 检查初始状态:liveRuns 有 → 推 entry + 起 1s 轮询;没有 → DB 兜底。
      const initial = getLiveRun(runId);
      if (!initial) {
        fallbackToDb();
        request.signal.addEventListener("abort", cleanup);
        return;
      }

      // 推 entry snapshot
      pushFrame({
        stdout: initial.stdout,
        stderr: initial.stderr,
        completed: initial.completed,
        exitCode: initial.exitCode,
        source: "live",
        updatedAt: initial.updatedAt,
      });
      if (initial.completed) {
        // 打开瞬间已经完成 (5min cleanup 还在但 completed=true),推一次就够
        setTimeout(cleanup, 50);
        request.signal.addEventListener("abort", cleanup);
        return;
      }

      // 持续轮询 liveRuns
      interval = setInterval(() => {
        const entry = getLiveRun(runId);
        if (!entry) {
          // liveRuns 突然没了 (理论上不应该,但防御): 兜底 + close
          fallbackToDb();
          if (interval) {
            clearInterval(interval);
            interval = null;
          }
          return;
        }
        pushFrame({
          stdout: entry.stdout,
          stderr: entry.stderr,
          completed: entry.completed,
          exitCode: entry.exitCode,
          source: "live",
          updatedAt: entry.updatedAt,
        });
        if (entry.completed) {
          // 推最后一条 completed:true 后,5min 内清理掉;前端拿完这帧会切到静态视图。
          if (interval) {
            clearInterval(interval);
            interval = null;
          }
          setTimeout(cleanup, 50);
        }
      }, 1000);

      // 心跳 (与 tasks/[id]/stream 同模式):浏览器关标签时 TCP FIN 可能不及时传到 Node,
      //   abort 不触发,靠心跳写入失败兜底清理。
      heartbeat = setInterval(() => {
        send(": ping\n\n");
      }, 25000);

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