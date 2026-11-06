// GET /api/requirements/revisions - 跨 requirement 的字段级变更增量端点 (R63 N 列).
//
// 用途: 外部 webhook / 看板拉近期全量变更流; 与 /api/requirements/[id]/revisions
//   (单条时间线) 互补, 后者是详情页用.
//
// Query 参数:
//   since      ISO timestamp 字符串 (例: 2026-09-03T00:00:00Z, 服务端统一 normalize
//              成 'YYYY-MM-DD HH:MM:SS' 与 sqlite datetime('now') 对齐).
//   until      同上, 半开区间 [since, until).
//   actor_type user|agent|system, 不传 = 全收.
//   requirement_id 限定单条 (等同 per-id 端点的简化使用, 留口子给看板).
//   limit      1-500, 默认 100.
//   cursor     上一次响应的 next_cursor, 透传做下一页.
//
// 关注点:
//   - owner_id 硬隔离: 走 x-user-id header + DB 层 JOIN requirements, 防越权.
//   - 时间格式容错: 客户端传 ISO 8601 含 T/Z 也接 (统一 .replace('T',' ').slice(0,19)).
//   - cursor 容错: 解码失败 = 忽略 cursor 从头拉 (与 listRevisions 行为一致).

import { NextRequest, NextResponse } from "next/server";
import {
  listRevisionsByTimeRange,
  type ActorType,
} from "@/lib/db/requirement-revisions";

const ACTOR_TYPES: ActorType[] = ["user", "agent", "system"];

// 把 ISO 8601 / sqlite datetime 都 normalize 成 'YYYY-MM-DD HH:MM:SS'.
// 失败返 null (调用方决定 400 vs 兜底空串).
function normalizeTs(s: string): string | null {
  // 已经像 sqlite 默认格式 (无 T 无时区) 直接返.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  // ISO 8601: 'YYYY-MM-DDTHH:MM:SSZ' / '.sssZ' / 无 Z. toISOString 走 UTC.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sinceRaw = searchParams.get("since");
  const untilRaw = searchParams.get("until");
  const actorRaw = searchParams.get("actor_type");
  const reqId = searchParams.get("requirement_id") ?? undefined;
  const limitRaw = searchParams.get("limit");
  const cursorRaw = searchParams.get("cursor");

  // since / until 校验.
  const since = sinceRaw ? normalizeTs(sinceRaw) : undefined;
  if (sinceRaw && since === null) {
    return NextResponse.json(
      { error: "since must be ISO 8601 timestamp", code: "SINCE_INVALID" },
      { status: 400 }
    );
  }
  const until = untilRaw ? normalizeTs(untilRaw) : undefined;
  if (untilRaw && until === null) {
    return NextResponse.json(
      { error: "until must be ISO 8601 timestamp", code: "UNTIL_INVALID" },
      { status: 400 }
    );
  }

  let actor_type: ActorType | undefined;
  if (actorRaw) {
    if (!ACTOR_TYPES.includes(actorRaw as ActorType)) {
      return NextResponse.json(
        {
          error: `actor_type must be one of ${ACTOR_TYPES.join(",")}`,
          code: "ACTOR_TYPE_INVALID",
        },
        { status: 400 }
      );
    }
    actor_type = actorRaw as ActorType;
  }

  let limit = 100;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      return NextResponse.json(
        { error: "limit must be 1-500", code: "LIMIT_INVALID" },
        { status: 400 }
      );
    }
    limit = n;
  }

  // requirement_id 仅做存在性校验 (owner 过滤由 DB 层 JOIN 兜底).
  // 不存在 = 直接返空信封, 不 404 (增量端点语义: "在 since 之后有没有这个 id 的变更",
  // 没找到 = 空 items + has_more=false, 客户端据此决定是否断流).
  const result = listRevisionsByTimeRange(
    {
      // since / until 在 normalizeTs 失败路径上是 string|null, 下游期望
      // string|undefined —— R66 收紧 TS 检查后 build 暴露, 加 ?? undefined 兜底.
      // 上面的 `sinceRaw && since === null` 校验不动, 仍然按 null 判 400.
      since: since ?? undefined,
      until: until ?? undefined,
      actor_type,
      requirement_id: reqId,
      limit,
      cursor: cursorRaw ?? undefined,
    },
    userId
  );

  return NextResponse.json(result);
}
