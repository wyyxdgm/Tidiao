// POST /api/feishu/write-back/[taskId]
//
// 手动触发飞书写回 (UI 按钮). 实际写回逻辑在 src/lib/feishu/write-back.ts,
// 此 route 是薄壳 + auth + 错误处理.

import { NextRequest, NextResponse } from "next/server";
import { writeBackFeishu } from "@/lib/feishu/write-back";
import { getTaskById } from "@/lib/db/tasks";
import { getRoleById } from "@/lib/db/roles";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = _request.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { taskId } = await params;

  // 校验所有权 (write-back 内部不强制, 这里做)
  const task = getTaskById(taskId, userId);
  if (!task) return NextResponse.json({ error: `Task ${taskId} not found` }, { status: 404 });

  // Role 场景化 P4 (docs/plans/role-scoped-roles.md D4): role 关了飞书回写 →
  //   403 拦截. role 为 NULL / 查不到 → 放行 (行为不变).
  if (task.role_id) {
    const role = getRoleById(task.role_id);
    if (role && role.feishu_writeback === 0) {
      return NextResponse.json(
        {
          error: "ROLE_WRITEBACK_DISABLED",
          message: "该任务挂的角色已关闭飞书回写 (roles.feishu_writeback=0)",
        },
        { status: 403 },
      );
    }
  }

  const result = await writeBackFeishu(taskId, userId);

  if (result.reason === "not_feishu_task") {
    return NextResponse.json(
      { error: "Task has no R<row> tag — was it created via /api/feishu/sync?" },
      { status: 400 },
    );
  }
  if (result.reason === "no_sheet_config") {
    return NextResponse.json(
      { error: "No sheet URL: task has no version_id or version has no feishu_url" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: result.ok,
    row: result.row,
    task_id: taskId,
    wrote: result.wrote,
    total: result.total,
    results: result.results,
  });
}