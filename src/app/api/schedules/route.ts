// GET /api/schedules - List schedules (scoped to current user)
// POST /api/schedules - Create schedule

import { NextRequest, NextResponse } from "next/server";
import { listSchedules, createSchedule } from "@/lib/db/schedules";
import type { ScheduleDefinition } from "@/lib/db/schedules";
import { requireExistingUser } from "@/lib/auth-user-exists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  const role = request.headers.get("x-user-role");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "true";
  const projectId = searchParams.get("project") || undefined;
  // 🆕 v68 软删除筛选: ?includeDeleted=true 才返回 deleted_at 非 NULL 的行。
  // 默认 = 只看活跃 schedule (与 damo 0823 R49 拍板一致: 「默认隐藏, 可筛选」)。
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  // 🆕 飞书 R92: 时间区间筛选 — lastRunFrom/To 筛上次执行, nextRunFrom/To 筛下次执行。
  //   半传或非法值由 listSchedules 内 isIsoString 兜成 undefined（前端传空字符串也安全）。
  const lastRunFrom = searchParams.get("lastRunFrom") || undefined;
  const lastRunTo = searchParams.get("lastRunTo") || undefined;
  const nextRunFrom = searchParams.get("nextRunFrom") || undefined;
  const nextRunTo = searchParams.get("nextRunTo") || undefined;
  // 🆕 R92 第二批反馈: 版本精确筛选 (damo 0830 R 列要求「版本也支持筛选」)。
  //   空字符串由 || undefined 兜成不参与 WHERE，与 project 风格相同。
  //   飞书 AO-DEV R218: version=null (字面量) = 只看未挂版本的 schedule (IS NULL),
  //   与 GET /api/requirements 的 ?version_id=null 约定同款。
  const versionRaw = searchParams.get("version");
  const versionId: string | null | undefined =
    versionRaw === "null" ? null : versionRaw || undefined;
  // 🆕 启用状态筛选: ?enabled=true / ?enabled=false; 未传或非法值 = 不过滤。
  const enabledRaw = searchParams.get("enabled");
  const enabled: boolean | undefined =
    enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined;
  // ?all=true 是 admin only 的参数: 列出所有用户的 schedule（不限 owner）。
  // 普通用户传了也忽略（只返回自己的），避免混淆。
  const schedules = listSchedules(
    all && role === "admin" ? undefined : userId,
    projectId,
    { includeDeleted, lastRunFrom, lastRunTo, nextRunFrom, nextRunTo, versionId, enabled }
  );
  return NextResponse.json(schedules);
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;
  const body = await request.json();
  // 🔴 auto_approve 仍接受外部输入 —— 但仅对 shell 类型生效（shell 本就要人审,
  //   旧行为不变）。agent 类型 createSchedule 内部强制 true, 外部值忽略。
  //   PATCH 走 UPDATABLE_SCHEDULE_FIELDS 白名单, body 带 auto_approve 会 400。
  const def: ScheduleDefinition = {
    name: body.name,
    exec_type: body.exec_type,
    title: body.title,
    prompt: body.prompt,
    description: body.description,
    project_id: body.project_id,
    version_id: body.version_id,
    priority: body.priority,
    auto_approve: body.auto_approve,
    model: body.model,
    allowed_tools: body.allowed_tools,
    max_turns: body.max_turns,
    effort: body.effort,
    tags: body.tags,
    command: body.command,
    cwd: body.cwd,
    schedule_type: body.schedule_type,
    schedule_expr: body.schedule_expr,
    timezone: body.timezone,
    skip_if_running: body.skip_if_running,
    enabled: body.enabled,
    // 🆕 v60 自适应频率。validateDefinition 校验「agent + cron 才允许」
    //   + 两字段同填/同空 + 区间合法, 错就 throw -> 400。
    freq_min_minutes: body.freq_min_minutes,
    freq_max_minutes: body.freq_max_minutes,
    // 🆕 飞书 R96 智能降频（v70）。三字段同填/同空 + cron 校验,
    //   错就 throw -> 400。
    night_start_hour: body.night_start_hour,
    night_end_hour: body.night_end_hour,
    night_schedule_expr: body.night_schedule_expr,
    ownerId: userId,
  };
  if (!def.name || !def.exec_type || !def.schedule_type || !def.schedule_expr) {
    return NextResponse.json(
      { error: "name, exec_type, schedule_type, schedule_expr are required" },
      { status: 400 }
    );
  }
  try {
    const schedule = createSchedule(def);
    return NextResponse.json(schedule, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create schedule" },
      { status: 400 }
    );
  }
}
