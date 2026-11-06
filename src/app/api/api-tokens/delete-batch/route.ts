// POST /api/api-tokens/delete-batch - bulk delete current user's API token rows.
// Body: { ids: string[] }
// 关注点: 单次最多 100 个；跨用户 id 静默忽略（DB 层 WHERE user_id 过滤），
//          返回 deleted/requested 让 UI 自己汇报「实际删了几个」；不返 404。
// 注意: JWT 本身不过期，删除元数据行只清管理 UI 可见性，不让 token 失效（见 settings 页文案）。

import { NextRequest, NextResponse } from "next/server";
import { deleteApiTokens } from "@/lib/db/api-tokens";

const MAX_BATCH_SIZE = 100;

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be object" }, { status: 400 });
  }

  const ids = (body as { ids?: unknown }).ids;

  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: "ids must be array" }, { status: 400 });
  }
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids must not be empty" }, { status: 400 });
  }
  if (ids.length > MAX_BATCH_SIZE) {
    return NextResponse.json(
      { error: `ids exceeds max batch size (${MAX_BATCH_SIZE})` },
      { status: 400 }
    );
  }
  if (!ids.every((x) => typeof x === "string" && x.length > 0)) {
    return NextResponse.json(
      { error: "ids must be non-empty strings" },
      { status: 400 }
    );
  }

  const deleted = deleteApiTokens(userId, ids);
  return NextResponse.json({ deleted, requested: ids.length });
}