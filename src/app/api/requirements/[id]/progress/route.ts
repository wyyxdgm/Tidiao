// POST /api/requirements/[id]/progress - 规则重算完成度 (v517 / 飞书 R196)
//
// 口径: 0-90% 由关联 task 聚合 (task 自报 progress 优先, 无自报按状态折算),
//       100% = status done (部署+验证通过). 详见 src/lib/db/requirements.ts
//       computeRuleProgress 注释.
//
// 与 PATCH /api/requirements/[id] 的分工:
//   - PATCH {progress, progress_note} = 手动修正 (progress_source='manual')
//   - POST 本路由 = 规则重算 (progress_source='rule', note 自动生成)
//   - 无 body / body.action === 'recalc' 都走重算; 其它 action 拒收.

import { NextRequest, NextResponse } from "next/server";
import { applyRuleProgress, getRequirementById } from "@/lib/db/requirements";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // body 可选: 空body = recalc. 非空时只认 action === 'recalc'.
  if (request.headers.get("content-length") !== "0") {
    let body: any = {};
    try {
      const text = await request.text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (body.action !== undefined && body.action !== "recalc") {
      return NextResponse.json(
        { error: `unknown action: ${body.action}`, code: "ACTION_INVALID", allowed: ["recalc"] },
        { status: 400 }
      );
    }
  }

  // 存在性 + owner 校验 (404 = 不存在或跨 owner, no existence leak)
  const existing = getRequirementById(id, userId);
  if (!existing) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  const updated = applyRuleProgress(id, userId);
  if (!updated) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}
