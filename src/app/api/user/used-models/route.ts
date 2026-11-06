// GET /api/user/used-models — 当前用户历史 task.model 列表 (DISTINCT, 非空).
// 给前端 useAvailableModels 喂「用户曾经用过」的模型, 跟 llm_configs + MODEL_OPTIONS 并集去重.
// 只读 owner = 当前用户的 task; 不暴露他人选择. 不分页, DISTINCT 后量极小 (一般 < 20).

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  // 排除软删 (deleted_at IS NOT NULL) -- 否则幽灵选项, 选择会触发 404.
  const rows = db
    .prepare(
      `SELECT DISTINCT model FROM tasks
       WHERE owner_id = ? AND model IS NOT NULL AND TRIM(model) != ''
         AND deleted_at IS NULL
       ORDER BY model ASC`
    )
    .all(userId) as { model: string }[];
  return NextResponse.json({ models: rows.map((r) => r.model) });
}
