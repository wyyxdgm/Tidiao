// GET /api/tasks/[id]/transcript - 导出 task 会话
//
// format=markdown (默认) | jsonl | json
//   markdown / jsonl 走 getSessionHistory() = SDK jsonl 权威 transcript + events 补漏,
//   这是"完整"的那份 (events 表本身只有约 10% 内容).
//   json 保持历史语义 = raw events 数组, 不动既有调用方.
// verbosity=summary (默认) | full —— 见 formatSessionMarkdown 的关注点.

import { NextRequest, NextResponse } from "next/server";
import os from "os";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { getEventsByTaskId } from "@/lib/db/events";
import {
  formatSessionMarkdown,
  formatSessionJsonl,
  type TranscriptTaskMeta,
  type TranscriptVerbosity,
} from "@/lib/transcript";

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
  const url = new URL(request.url);
  const format = url.searchParams.get("format") || "markdown";
  const verbosity = (url.searchParams.get("verbosity") === "full" ? "full" : "summary") as TranscriptVerbosity;

  // 历史语义: raw events 数组.
  if (format === "json") {
    return NextResponse.json(getEventsByTaskId(id));
  }

  const meta: TranscriptTaskMeta = {
    id: task.id,
    title: task.title,
    status: task.status,
    session_id: task.session_id,
    cwd: task.cwd,
    model: task.model,
    resolved_model: task.resolved_model,
    effort: task.effort,
    cost_usd: task.cost_usd,
    created_at: task.created_at,
    completed_at: task.completed_at,
    project_name: task.project_id ? getProjectById(task.project_id, userId)?.name ?? null : null,
    version_name: task.version_id ? getVersionById(task.version_id, userId)?.name ?? null : null,
    source: os.hostname(),
  };

  const messages = await getRuntime().getSessionHistory(id);

  if (format === "jsonl") {
    return new Response(formatSessionJsonl(meta, messages), {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  }

  return new Response(formatSessionMarkdown(meta, messages, { verbosity }), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
