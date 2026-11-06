// GET /api/tasks/[id]/result-layers - 任务详情弹窗正文分层总结 (R190 / R200)
//
// R200 改造: 两级来源统一收口到 result-layers-store.ensureResultLayers —
//   1. metadata 缓存 (result_layers_v2) 命中 → 秒回
//   2. LLM 生成 (统一 summary 链, 50s 竞速超时) → 慢路径
//   (R200 turn2: 原「checkpoints 组装」中间层撤除 — damo 反馈质量不好、不可控)
// 后台预热由 active-session (result → reviewing 落库后) fire-and-forget 调
// warmResultLayersForTask 完成 — 正常任务打开弹窗时缓存已在, 不再转圈.
// ?refresh=true 强制重算; result 变了 (任务重跑) 按 result_len 自动重算.
// 短路: result 为空或 <200 字 → source:skip (分层没意义, 前端直接单层显示原文).

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import { ensureResultLayers } from "@/lib/runtime/result-layers-store";

const SKIP_THRESHOLD_CHARS = 200;

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

  const resultLen = (task.result || "").trim().length;

  // 短路: 没跑完 / 结果太短, 分层没意义 — 前端直接单层显示原文
  if (resultLen < SKIP_THRESHOLD_CHARS) {
    return NextResponse.json({ brief: "", details: [], source: "skip" });
  }

  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "true";

  const { layers, source } = await ensureResultLayers(task, { refresh });
  if (!layers) {
    // LLM 失败 (没配 key / 429 / 超时 / 解析不出) → 200 + source:failed,
    // 前端回退单层原文, 不写缓存 (下次打开还能重试), 不重试加压.
    return NextResponse.json({ brief: "", details: [], next: "", source: "failed" });
  }
  return NextResponse.json({
    brief: layers.brief,
    details: layers.details,
    next: layers.next,
    source,
  });
}
