// GET /api/requirements/[id]/aggregates - 单条 requirement 聚合 (R142 G4)
//
// 数据源: src/lib/db/requirements.ts getRequirementAggregates(ids) 复用现有
//   SQL (LEFT JOIN tasks + GROUP BY + MAX(requirement_revisions.created_at)).
//   单条路径直接 reuse 批量入口, 拿 Map 第一个 entry.
//
// 关注点:
//   - 权限: owner-scoped (与 [id]/route.ts 一致). getRequirementById 内部
//     WHERE owner_id = ?, 跨 owner 一律 404 不暴露存在性.
//   - admin bypass 不在此处加 (跟 R78 W1 §4.3 existing_for_done 对齐 — 聚合
//     数据仅 owner 自己消费, admin 看需求列表走专门 admin route). 若日后需
//     admin 可看聚合, 在此加 isAdmin 分支即可, getRequirementById 已经支持
//     userId=undefined 返未过滤结果.
//   - completion_pct: getRequirementAggregates 返 completion_ratio (0..1),
//     这里翻成 0..100 (四舍五入取整, 跟 SPA 列表 UI 「📈X%」对齐).
//   - latest_feedback: latest_feedback_at (DB MAX) 转原样字符串 (DB 落的是
//     'YYYY-MM-DD HH:MM:SS' ISO 形态, SPA 按 ISO 解析).
//
// v2.0-spa 用途: Requirements / VersionRequirements / ProjectUnversionedRequirements
//   三视图行内接 3 chip.

import { NextRequest, NextResponse } from "next/server";
import { getRequirementById, getRequirementAggregates } from "@/lib/db/requirements";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const userId = _request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const req = getRequirementById(id, userId);
  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  const map = getRequirementAggregates([id]);
  const agg = map.get(id) ?? {
    task_count: 0,
    completed_count: 0,
    completion_ratio: 0,
    latest_feedback_at: null,
  };

  return NextResponse.json({
    task_count: agg.task_count,
    completion_pct: Math.round(agg.completion_ratio * 100),
    latest_feedback: agg.latest_feedback_at,
  });
}
