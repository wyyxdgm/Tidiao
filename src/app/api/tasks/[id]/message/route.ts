// POST /api/tasks/[id]/message - Send a message to a running session

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { getAttachmentById, resolveTaskCwd } from "@/lib/db/attachments";
import { parseRunOpts } from "@/lib/runtime/active-session";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const body = await request.json();

  if (!body.message) {
    // R56-B4: 加 debug log 帮助现场定位 "发送失败: message is required" (R56-B4 E).
    // 已知兜底在前端 messageInputRef 已加, 但万一再撞到, 这里留 trace 现场排查.
    console.warn("[api/message] empty body received", {
      taskId: id,
      bodyKeys: body && typeof body === "object" ? Object.keys(body) : null,
      bodyType: typeof body,
    });
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // sender_type: who is sending this message. Defaults to "user" (damo via
  // chat box / ao-chat.sh / wecom 甲方). Scripts and platform events should
  // declare "script" or "system" so the transcript UI can render the right
  // icon (R55 B1 fix). Whitelist prevents typos from silently being treated as
  // a third category — fail loud, fail early.
  const VALID_SENDER_TYPES = ["user", "script", "system"] as const;
  type SenderType = (typeof VALID_SENDER_TYPES)[number];
  let senderType: SenderType = "user";
  if (body.sender_type !== undefined) {
    if (!VALID_SENDER_TYPES.includes(body.sender_type)) {
      return NextResponse.json(
        { error: `invalid sender_type, must be one of ${VALID_SENDER_TYPES.join("|")}` },
        { status: 400 },
      );
    }
    senderType = body.sender_type;
  }

  // If attachment ids are supplied, prepend a file listing (absolute paths
  // into the task cwd) so the agent sees what was uploaded before the user's
  // text. The runtime signature stays string-only; we fold it in here. Foreign
  // or stale ids (not owned by this user / not on this task) are skipped.
  let message: string = body.message;
  const attachmentIds: string[] = Array.isArray(body.attachments) ? body.attachments : [];
  if (attachmentIds.length > 0) {
    const cwd = resolveTaskCwd(task);
    const lines: string[] = [];
    for (const aid of attachmentIds) {
      const att = getAttachmentById(aid, userId);
      if (!att || att.task_id !== id) continue;
      const absPath = path.join(cwd, "attachments", att.filename);
      lines.push(`- ${absPath} (${formatSize(att.size_bytes)}, ${att.media_type})`);
    }
    if (lines.length > 0) {
      message = `用户上传了以下文件：\n${lines.join("\n")}\n\n用户说：${body.message}`;
    }
  }

  try {
    const opts = parseRunOpts(body);
    getRuntime().sendUserMessage(id, message, opts, undefined, senderType);
    // Return the current status so the frontend can update if the task was
    // auto-activated from a terminal state (completed/failed/cancelled/rejected).
    const updated = getTaskById(id, userId);
    return NextResponse.json({ ok: true, status: updated?.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
