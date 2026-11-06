// GET /api/tasks/[id]/card-summary - 画布卡片「面向用户」摘要 (R177 迭代7 / R200)
//
// R200 批次 (damo 1007): 缓存/生成逻辑收口到 card-summary-store.ensureCardSummary
// (与 result-layers-store 同构), 供 active-session 完成后 fire-and-forget 预热共享
// —— 正常任务卡片打开即显, 不再进画布的 3 并发慢队列. 迭代 9 闸门保留在 store:
// result 为空 (running/queued 等非终态) → source='pending', 不调 LLM 不写缓存.
// ?refresh=true 只强制绕缓存, 不豁免本闸.

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import { ensureCardSummary } from "@/lib/runtime/card-summary-store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "true";

  const { summary, source } = await ensureCardSummary(task, { refresh });
  if (!summary) {
    // pending (result 空, 前端机械提取兜底) / failed (没配 key / 429 / 超时,
    // 不写缓存下次还能重试, 不重试加压) — 对外都回空两行 + source.
    return NextResponse.json({ what: "", why: "", source });
  }
  return NextResponse.json({ what: summary.what, why: summary.why, source });
}
