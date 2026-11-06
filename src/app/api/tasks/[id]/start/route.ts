// POST /api/tasks/[id]/start - Start a task

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { parseRunOpts } from "@/lib/runtime/active-session";
import { checkUserQuota } from "@/lib/db/users";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate before starting.
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  // R88 quota 拦截 (Sheet L 验收 ⑥). 与 createTask 入口同套判据, 保证 start (含
  //   resume) 走完后, 累计费用不会冲破 cap. agent schedule + intake/wecom +
  //   feishu/sync 三个调 runtime.startTask 的入口都过这里, 写一次覆盖所有.
  const quota = checkUserQuota(userId);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: quota.detail ?? "quota blocked",
        code: "QUOTA_BLOCKED",
        reason: quota.reason,
        quota,
      },
      { status: 403 },
    );
  }
  let body: unknown = undefined;
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  try {
    const opts = parseRunOpts(body);
    getRuntime().startTask(id, opts, "manual_start");
    // Read the real status from DB instead of hardcoding "queued".
    // startTask() -> enqueue() -> schedule() runs synchronously, so by the
    // time we get here the task is already "running" (if a slot was free) or
    // "queued" (if the concurrency limit is reached). Returning the real
    // status avoids racing the SSE status_change event - the HTTP response
    // used to clobber a correct "running" with a stale "queued", leaving the
    // UI stuck on 排队中 until the task finished.
    const task = getTaskById(id, userId);
    return NextResponse.json({ ok: true, status: task?.status || "queued" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
