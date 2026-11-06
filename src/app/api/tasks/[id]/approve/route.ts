// POST /api/tasks/[id]/approve - Approve a reviewing or rejected task → completed
// POST /api/tasks/[id]/reject - Reject with feedback

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  try {
    getRuntime().approveTask(id);
    return NextResponse.json({ ok: true, status: "completed" });
  } catch (err: any) {
    // v56: 区分 awaiting_owner_review 拦截 (409 让 UI 知道可解) vs 其他 400.
    // 前端拿到 409 后可以弹「先 unset flag」的提示, 然后调 POST /unset-awaiting-review.
    if (err?.message?.startsWith("AWAITING_OWNER_REVIEW:")) {
      return NextResponse.json(
        { error: err.message, code: "AWAITING_OWNER_REVIEW" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
