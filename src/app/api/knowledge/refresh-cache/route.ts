// POST /api/knowledge/refresh-cache — 手动触发 requirement_cache 拉取.
//
// 入参 (JSON body, 可选):
//   - version_id (可选, 拉单个 version; 不传 = 拉当前 user 全部 feishu-enabled version)
//
// 鉴权:
//   - x-user-id header 必须有 (同 /api/notify 模式)
//   - admin 可指定 user_id 帮别人拉 (admin 跨 user 走 --user 模式, 同 notify)
//
// 出参:
//   - { results: [{version_id, row_count, errored, error?, duration_ms}], summary }
//   - summary = 'all_ok' (全成功) | 'partial' (有失败) | 'none' (全失败 + 可能参数错)
//
// 关注点:
//   - 同步等结果 (不后台). 飞书单 version 拉 100 行 < 10s, 全部 N versions ≤ 1 min; 同步等
//     让 admin UI 立刻看到结果, 比 fire-and-forget 易用.
//   - 任一 version 失败不阻断后续 version (与 notify 行为一致, 一律 partial).
//   - cron 入口走 scripts/cron.sh (15min), 不走此端点 (此端点是 manual / agent 调试用).

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  refreshRequirementCache,
  refreshAllCachesForUser,
  listFeishuEnabledVersions,
  getCacheStatus,
} from "@/lib/db/requirements-cache";

function isAdmin(userId: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(userId) as { role: string } | undefined;
    return row?.role === "admin";
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any = {};
  try {
    // 允许空 body
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // admin 可借 user_id 帮别人拉; 普通 user 不允许
  let targetUserId = userId;
  if (body?.user_id && body.user_id !== userId) {
    if (!isAdmin(userId)) {
      return NextResponse.json(
        { error: "admin only", code: "ADMIN_REQUIRED" },
        { status: 403 }
      );
    }
    targetUserId = body.user_id;
  }

  const versionId = typeof body?.version_id === "string" && body.version_id.trim().length > 0
    ? body.version_id.trim()
    : null;

  try {
    let results;
    if (versionId) {
      const r = await refreshRequirementCache(versionId, targetUserId);
      results = [r];
    } else {
      results = await refreshAllCachesForUser(targetUserId);
    }

    const errCount = results.filter((r) => r.errored).length;
    const okCount = results.length - errCount;
    let summary: "all_ok" | "partial" | "none";
    if (results.length === 0) summary = "none";
    else if (errCount === 0) summary = "all_ok";
    else if (okCount === 0) summary = "none";
    else summary = "partial";

    return NextResponse.json({ results, summary });
  } catch (e) {
    console.error("[api/knowledge/refresh-cache] unexpected error", e);
    return NextResponse.json(
      { error: "internal error", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

// GET — 只读健康检查: 列出当前 user 全部 feishu-enabled version 的 cache 状态
export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = isAdmin(userId);
  // admin 不传 user_id 查全部; 普通 user 查自己
  const targetUserId = admin && !request.nextUrl.searchParams.has("user_id_self") ? undefined : userId;

  try {
    const versions = listFeishuEnabledVersions(targetUserId);
    const statuses = versions
      .map((v) => {
        const s = getCacheStatus(v.version_id, targetUserId);
        if (!s) return null;
        return {
          version_id: v.version_id,
          version_name: v.version_name,
          project_id: v.project_id,
          sheet_url: v.feishu_url,
          sheet_name: v.sheet_name,
          row_count: s.row_count,
          error_count: s.error_count,
          latest_fetched_at: s.latest_fetched_at,
          latest_error: s.latest_error,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return NextResponse.json({ versions: statuses });
  } catch (e) {
    console.error("[api/knowledge/refresh-cache GET] error", e);
    return NextResponse.json(
      { error: "internal error", code: "INTERNAL" },
      { status: 500 }
    );
  }
}