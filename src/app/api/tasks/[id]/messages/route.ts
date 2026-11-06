// GET /api/tasks/[id]/messages - Get session message history
//
// 2026-10-08 加条件拉取 (If-None-Match / ETag, 压测实证: 全量 282KB/次, 公网
// 隧道 0.8~3.3s, 是任务详情页最大 payload). 指纹三段:
//   updatedAt  — 任何 task 字段级变化都换指纹 (宁多拉不漏拉);
//   session_id — resume/fork 换会话时内容整体换;
//   MAX(events.id) — agent 流式追加消息的信号 (getMessagesFingerprintProbes).
// ETag 不带进程启动盐: 会话历史是 DB + jsonl 的确定函数, 服务重启不改变它,
// 跨重启 304 是对的 (与 listTasksPageFingerprint 的 boot 盐场景刻意不同).

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { getMessagesFingerprintProbes } from "@/lib/db/events";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId, { includeDeleted: true });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // ⚠️ ETag 必须无空白 (RFC 9110): SQLite datetime "2026-09-29 08:11:36" 带
  // 空格, 直接拼会被浏览器/代理回传时截断 → 304 永远命中不了 (R165 实测踩过).
  const probes = getMessagesFingerprintProbes(id);
  const sessionId = task.session_id || probes.lastSessionId || "nosession";
  const etag = `W/"msg-${String(task.updated_at).replace(/\s+/g, "T")}-${sessionId}-${probes.maxEventId}"`;
  const inm = request.headers.get("if-none-match");
  if (inm && inm.split(",").some((v) => v.trim() === etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "no-cache" },
    });
  }

  try {
    const messages = await getRuntime().getSessionHistory(id);
    return NextResponse.json(messages, {
      headers: { ETag: etag, "Cache-Control": "no-cache" },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
