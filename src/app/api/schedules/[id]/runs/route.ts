// GET  /api/schedules/[id]/runs - trigger history for a schedule
// POST /api/schedules/[id]/runs - manually fire the schedule now
//
// admin 可以跨 owner 操作（见 [id]/route.ts 的 ownerScope 逻辑）。

import { NextRequest, NextResponse } from "next/server";
import { getScheduleById, listRuns } from "@/lib/db/schedules";
import { triggerSchedule } from "@/lib/runtime/schedule-runner";

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
  // Ownership gate before listing runs (no existence leak).
  if (!getScheduleById(id, ownerScope(request, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!) : 20;
  // 🆕 飞书 R75: UI 分页 -- offset 默认 0；非法值兜底回 0（与 limit 同口径）。
  const offsetRaw = parseInt(searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const { runs, total } = listRuns(id, { limit, offset });
  return NextResponse.json({ runs, total, limit, offset });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const schedule = getScheduleById(id, ownerScope(request, userId));
  if (!schedule) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Manual trigger fires immediately without advancing next_run or disabling
  // a once schedule. Works regardless of `enabled`. skip_if_running still
  // applies -> 409 when the previous run is still in flight.
  const result = triggerSchedule(schedule);
  if (!result.fired) {
    return NextResponse.json({ error: result.reason }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    task_id: result.task_id ?? null,
  });
}
