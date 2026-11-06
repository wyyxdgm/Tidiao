// POST /api/tasks/[id]/refine - Reviewing → running, agent 接着干
//
// 🆕 R131 (damo 2026-09-15): 取代旧 /reject 端点. 用户投一条消息让 agent 接着改,
//   不进 rejected 终态, session 保留, agent 自己消费消息. body schema:
//   { message?: string }  — message 可选 (用户可点"refine"不带消息, 仅状态切回 running).
//
// 🆕 R后续 damo 2026-09-15: 弹窗不填 message 也合法. 后端 refineTask 默认 fallback
//   「继续」(跟 maintenance_exit 路径一致) —— 早期处理过: 底层 pushMessage 投空
//   user message 进 SDK 让 agent query() 行为不稳, fallback 给个具体引导词.

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  let body: { message?: string } = {};
  try {
    body = await request.json();
  } catch {
    // 空 body 也允许 (只切状态)
  }
  try {
    getRuntime().refineTask(id, body.message, "damo");
    return NextResponse.json({ ok: true, status: "running" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
