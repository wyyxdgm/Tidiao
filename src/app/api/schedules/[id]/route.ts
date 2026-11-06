// GET/PATCH/DELETE /api/schedules/[id]
//
// admin 可以跨 owner 管别人的 schedule（ownerScope 返回 undefined = 不按 owner 过滤）。
// 这是事故逼出来的能力: 别人的定时任务失控时, admin 以前除了直接改 DB 没有任何入口
// （v2-p0-loop 就是这么关掉的）。普通用户仍然硬隔离。

import { NextRequest, NextResponse } from "next/server";
import { getScheduleById, updateSchedule, deleteSchedule, UPDATABLE_SCHEDULE_FIELDS } from "@/lib/db/schedules";
import type { ScheduleUpdate } from "@/lib/db/schedules";

// 功能: 算出这次请求该用哪个 owner 作用域。admin -> undefined（全库）, 其他 -> 自己。
// 关注点: 返回 undefined 是「不过滤」的约定, 别把它当成「未登录」—— 调用前已校验 x-user-id。
function ownerScope(request: NextRequest, userId: string): string | undefined {
  return request.headers.get("x-user-role") === "admin" ? undefined : userId;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const schedule = getScheduleById(id, ownerScope(request, userId));
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(schedule);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const scope = ownerScope(request, userId);
  if (!getScheduleById(id, scope)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // 🔴 未知键一律 400, 不许静默丢弃。
  // 历史 bug: `updateSchedule` 只认 9 个字段, 其余（max_turns/effort/model/tags...）
  // 既不写库也不报错, 而 `fields.length === 0` 时它原样返回旧对象 -> HTTP 200 +
  // 完整 JSON, 调用方分不清「改成功了」和「整个请求被忽略了」。cron.sh 的
  // --max-turns 因此空转还每次打 ✅。所以校验放在写之前, 按白名单拒。
  const body = await request.json().catch(() => ({}));
  const unknown = Object.keys(body as Record<string, unknown>).filter(
    (k) => !(UPDATABLE_SCHEDULE_FIELDS as readonly string[]).includes(k)
  );
  if (unknown.length) {
    return NextResponse.json(
      {
        error: `unknown field(s): ${unknown.join(", ")}`,
        unknown_fields: unknown,
        updatable_fields: UPDATABLE_SCHEDULE_FIELDS,
      },
      { status: 400 }
    );
  }
  let schedule: Awaited<ReturnType<typeof getScheduleById>>;
  try {
    schedule = updateSchedule(id, body as ScheduleUpdate, scope);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update schedule" },
      { status: 400 }
    );
  }
  if (!schedule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(schedule);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const scope = ownerScope(request, userId);
  if (!getScheduleById(id, scope)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  deleteSchedule(id, scope);
  return NextResponse.json({ ok: true });
}
