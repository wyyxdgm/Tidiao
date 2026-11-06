// POST /api/assets/delete-batch - bulk-delete attachments.
//
// 复用 deleteAttachment(), 单条删除已含物理文件清理 + symlink 删除 + DB 行删除.
// 跨 owner 隔离守住: deleteAttachment 内部拿不到 row → 返回 false, 跳过.
//
// 关注点:
//   - 接受 ids: string[], 上限 200 (避免单请求拖太多 DB 行).
//   - 不存在的 id / 跨 owner 的 id 都返回 ok=false (逐条), 不报错中断.
//   - 返回形: { deleted: number, failed: Array<{id, error}> }.

import { NextRequest, NextResponse } from "next/server";
import { deleteAttachment } from "@/lib/db/attachments";

const MAX_BATCH = 200;

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!ids) {
    return NextResponse.json({ error: "ids must be an array" }, { status: 400 });
  }
  if (ids.length === 0) {
    return NextResponse.json({ deleted: 0, failed: [] });
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many ids (max ${MAX_BATCH})` },
      { status: 400 },
    );
  }

  // 严格校验: ids 全是 string, 否则 400. 不在白名单里 (非字符串) 的不让走.
  if (!ids.every((x): x is string => typeof x === "string")) {
    return NextResponse.json({ error: "ids must be strings" }, { status: 400 });
  }

  let deleted = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      const ok = deleteAttachment(id, userId);
      if (ok) deleted++;
      else failed.push({ id, error: "not_found" });
    } catch (e) {
      failed.push({
        id,
        error: e instanceof Error ? e.message : "delete_failed",
      });
    }
  }

  return NextResponse.json({ deleted, failed });
}