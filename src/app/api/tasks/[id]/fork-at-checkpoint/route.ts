// POST /api/tasks/[id]/fork-at-checkpoint
//
// Body — JSON (no files) or multipart/form-data (with files):
//   JSON:              { checkpoint_id: number, prompt?, title?, newCwd?, maxTurns?, autoApprove?, compactFirst? }
//   multipart (files): checkpoint_id: number; meta = JSON string; file* = files
//
// Looks up the checkpoint, derives (source task, upToMessageId) and
// delegates to runtime.forkSession() which calls standalone SDK
// forkSession() under the hood. Files (if any) are saved as attachments on
// the new task and their paths appended to the prompt (same flow as
// /api/tasks/[id]/fork).

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById, updateTask } from "@/lib/db/tasks";
import { getCheckpointById } from "@/lib/db/checkpoints";
import {
  resolveAttachmentMediaType,
  isAllowedAttachmentMediaType,
  saveAttachmentFromFile,
  resolveTaskCwd,
} from "@/lib/db/attachments";
import { checkGoalMarkerAutoApprove } from "@/lib/runtime/goal-marker";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB per file

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
  // Ownership gate before any work.
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: `Task ${id} not found` }, { status: 404 });
  }

  type ForkBody = {
    checkpoint_id?: number;
    prompt?: string;
    title?: string;
    newCwd?: string;
    maxTurns?: number;
    autoApprove?: boolean;
    compactFirst?: boolean;
  };
  let body: ForkBody = {};
  let checkpointId: number | undefined;
  const uploadedFiles: File[] = [];
  const contentType = request.headers.get("content-type") || "";

  if (contentType.startsWith("multipart/form-data")) {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_SIZE * 5 + 1024 * 1024) {
      return NextResponse.json({ error: "Total upload too large" }, { status: 413 });
    }
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
    }
    // checkpoint_id 在 multipart 路径下作为独立 form field, 也允许塞 meta 里.
    const cpRaw = formData.get("checkpoint_id");
    if (typeof cpRaw === "string" && cpRaw.length > 0) {
      const n = Number(cpRaw);
      if (Number.isFinite(n)) checkpointId = n;
    }
    const metaRaw = formData.get("meta");
    if (typeof metaRaw === "string" && metaRaw.length > 0) {
      try {
        body = JSON.parse(metaRaw);
      } catch {
        return NextResponse.json({ error: "Invalid meta JSON" }, { status: 400 });
      }
    }
    for (const [key, value] of formData.entries()) {
      if (key === "meta" || key === "checkpoint_id") continue;
      if (value instanceof File) uploadedFiles.push(value);
    }
  } else {
    try {
      const text = await request.text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  if (typeof body.checkpoint_id === "number") checkpointId = body.checkpoint_id;

  if (typeof checkpointId !== "number") {
    return NextResponse.json(
      { error: "checkpoint_id (number) is required" },
      { status: 400 },
    );
  }

  const cp = getCheckpointById(checkpointId);
  if (!cp) {
    return NextResponse.json({ error: `Checkpoint ${checkpointId} not found` }, { status: 404 });
  }
  if (cp.task_id !== id) {
    return NextResponse.json(
      { error: `Checkpoint ${checkpointId} does not belong to task ${id}` },
      { status: 400 },
    );
  }
  if (!cp.up_to_message_id) {
    return NextResponse.json(
      {
        error:
          "Checkpoint has no up_to_message_id (likely seeded as a fork anchor); use /api/tasks/{id}/fork directly",
      },
      { status: 400 },
    );
  }

  // 预校验文件 (白名单 + 大小), fork 之前拒掉.
  for (const file of uploadedFiles) {
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: `File too large: ${file.name} (max 10MB)` }, { status: 413 });
    }
    const mt = resolveAttachmentMediaType(file.type, file.name);
    if (!isAllowedAttachmentMediaType(mt)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.name} (${mt || "unknown"})` },
        { status: 415 },
      );
    }
  }

  // Goal-driven loop 阶段 3 (D20, 漏洞 #5): 新 prompt 含 <goal>...</goal> marker
  //   → 必须 autoApprove=true. 仅校验 body.prompt (用户显式传入的新 prompt),
  //   不校验 fork 默认 prompt. 漏洞 #8 (P0) 阶段 4 解决: fork 分支构造
  //   opts.prompt 必须强制拼接 goal marker.
  const goalCheck = checkGoalMarkerAutoApprove(body.prompt, body.autoApprove);
  if (!goalCheck.ok) {
    return NextResponse.json(
      { error: goalCheck.reason, code: goalCheck.code },
      { status: 400 },
    );
  }

  let result: { newTaskId: string; newSessionId: string; forkedFromSessionId: string };
  try {
    result = await getRuntime().forkSession(id, {
      upToMessageId: cp.up_to_message_id,
      prompt: body.prompt,
      title: body.title || `Fork from checkpoint step=${cp.step}: ${cp.summary || ""}`.trim(),
      newCwd: body.newCwd,
      maxTurns: body.maxTurns,
      autoApprove: body.autoApprove,
      compactFirst: body.compactFirst,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  // 把上传文件挂到新任务下 + 追加到 prompt.
  const newTask = getTaskById(result.newTaskId, userId);
  const savedAttachments: Array<{ id: string; filename: string; media_type: string; size_bytes: number }> = [];
  if (newTask && uploadedFiles.length > 0) {
    for (const file of uploadedFiles) {
      try {
        const att = await saveAttachmentFromFile(
          { kind: "task", id: newTask.id, owner_id: newTask.owner_id, cwd: newTask.cwd, project_id: newTask.project_id },
          userId,
          file,
          { source: "upload" },
        );
        savedAttachments.push({
          id: att.id,
          filename: att.filename,
          media_type: att.media_type,
          size_bytes: att.size_bytes,
        });
        getRuntime().emitAttachment(result.newTaskId, {
          id: att.id,
          filename: att.filename,
          media_type: att.media_type,
          size_bytes: att.size_bytes,
        });
      } catch (err: any) {
        console.warn(`[fork-at-checkpoint] saveAttachmentFromFile failed for ${file.name}:`, err?.message);
      }
    }

    if (savedAttachments.length > 0) {
      const cwd = resolveTaskCwd(newTask);
      const lines = savedAttachments.map(
        (a) => `- ${path.join(cwd, "attachments", a.filename)} (${formatSize(a.size_bytes)}, ${a.media_type})`,
      );
      const block = `用户上传了以下文件：\n${lines.join("\n")}\n\n`;
      const currentPrompt = newTask.prompt || "";
      const nextPrompt = currentPrompt.includes("用户上传了以下文件")
        ? currentPrompt
        : block + currentPrompt;
      if (nextPrompt !== currentPrompt) {
        updateTask(result.newTaskId, { prompt: nextPrompt });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    new_task_id: result.newTaskId,
    new_session_id: result.newSessionId,
    forked_from_session_id: result.forkedFromSessionId,
    checkpoint_id: cp.id,
    checkpoint_step: cp.step,
    attachments: savedAttachments,
  });
}