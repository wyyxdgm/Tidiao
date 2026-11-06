// R158 (damo 2026-09-26): 手动回填 task_commits 的端点 —— agent 退出时
// 自动跑过一次, 这里给 damo / 平台扫尾用, 让已完成但 task_commits 为空的旧
// 任务也能拿到 commit. 等同 active-session.ts:2288 autoCollectCommits 的
// 离线版本, 但暴露成 HTTP 接口 + 鉴权.
//
// 关注点:
//   - 复用 collectTaskCommitsBackfill, 不重复实现 (单一来源: 改一处两边生效).
//   - 鉴权走标准平台 auth (requireUserFromRequest), 不是公开端点.
//   - 任务必须存在 + cwd 可读 + 是 git repo, 否则 200 + 0 inserted + 说明原因
//     (避免 404 把"任务存在但不能收集"和"任务不存在"混淆).

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import { backfillTaskCommits } from "@/lib/git/collect-task-commits";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const cwd = task.cwd;
  const base = task.base_commit;
  const head = task.head_commit;

  if (!cwd || !base || !head) {
    return NextResponse.json({
      inserted: 0,
      skipped: "missing cwd/base_commit/head_commit",
    });
  }
  if (base === head) {
    return NextResponse.json({ inserted: 0, skipped: "base == head (no new commits)" });
  }

  const inserted = backfillTaskCommits(task.id, cwd, base, head);
  return NextResponse.json({ inserted });
}