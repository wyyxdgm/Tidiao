// POST /api/tasks/[id]/fork - Fork a session into a new task + new SDK session.
//
// Body — supports both JSON (no files) and multipart/form-data (with files):
//   JSON:               { upToMessageId?, title?, prompt?, newCwd?, maxTurns?, autoApprove?, compactFirst? }
//   multipart (files):  meta = JSON string with the same fields; files = one or more file fields.
//
// File flow: the new task is created first (forkSession), then each uploaded
// file is saved as an attachment on the new task via saveAttachmentFromFile.
// Their absolute paths (symlinked into the new task's cwd) are appended to
// the fork's prompt so the agent sees them on first run, mirroring the
// /api/tasks/[id]/attachments + PATCH append_attachments flow used by the
// create-task page.
//
// Returns { new_task_id, new_session_id, forked_from_session_id, attachments? }.

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById, updateTask } from "@/lib/db/tasks";
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

// 关注点: 仅以 method+content-type 区分两种 body 形式 —— JSON 客户端发
// `application/json`，multipart 客户端发 `multipart/form-data; boundary=...`.
// 选了 formData() 就走 multipart 路径；否则按 JSON 解析（保持向后兼容）。
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate before forking.
  const parentTask = getTaskById(id, userId);
  if (!parentTask) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  type ForkBody = {
    upToMessageId?: string;
    title?: string;
    prompt?: string;
    newCwd?: string;
    maxTurns?: number;
    autoApprove?: boolean;
    compactFirst?: boolean;
  };
  let body: ForkBody = {};
  const uploadedFiles: File[] = [];
  const contentType = request.headers.get("content-type") || "";

  if (contentType.startsWith("multipart/form-data")) {
    // Multipart 路径: meta 字段是 JSON 字符串, files 字段是文件列表.
    // 预检 Content-Length 上限 —— Next 16 在超 ~12MB 时截断 body,
    // formData() 会拿到不完整内容并报模糊的 400.
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
    const metaRaw = formData.get("meta");
    if (typeof metaRaw === "string" && metaRaw.length > 0) {
      try {
        body = JSON.parse(metaRaw);
      } catch {
        return NextResponse.json({ error: "Invalid meta JSON" }, { status: 400 });
      }
    }
    // 收集所有名为 file* 的字段 (file / files / file_1 / ...).
    for (const [key, value] of formData.entries()) {
      if (key === "meta") continue;
      if (value instanceof File) uploadedFiles.push(value);
    }
  } else {
    // JSON 路径 —— 保持原行为, 向后兼容.
    try {
      const text = await request.text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  // 预校验文件 (白名单 + 大小), fork 之前拒掉, 避免 fork 出空任务再回滚.
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
  //   不校验 fork 默认 prompt (默认 prompt 不含 marker). 漏洞 #8 (P0) 阶段 4
  //   解决: fork 分支构造 opts.prompt 必须强制拼接 goal marker.
  const goalCheck = checkGoalMarkerAutoApprove(body.prompt, body.autoApprove);
  if (!goalCheck.ok) {
    return NextResponse.json(
      { error: goalCheck.reason, code: goalCheck.code },
      { status: 400 },
    );
  }

  let result: { newTaskId: string; newSessionId: string; forkedFromSessionId: string };
  try {
    result = await getRuntime().forkSession(id, body);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  // 把上传文件挂到新任务下, 并把绝对路径追加到 prompt (与 /api/tasks/[id]/message
  // 的 attachments 行为一致: agent 第一条消息就能看到文件列表).
  const newTask = getTaskById(result.newTaskId, userId);
  if (!newTask) {
    return NextResponse.json({ ok: true, new_task_id: result.newTaskId, new_session_id: result.newSessionId, forked_from_session_id: result.forkedFromSessionId });
  }

  const savedAttachments: Array<{ id: string; filename: string; media_type: string; size_bytes: number }> = [];
  if (uploadedFiles.length > 0) {
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
        console.warn(`[fork] saveAttachmentFromFile failed for ${file.name}:`, err?.message);
      }
    }

    // 拼 "用户上传了以下文件" 段并落库 (避免 PATCH 二次 round-trip).
    const cwd = resolveTaskCwd(newTask);
    const lines = savedAttachments.map(
      (a) => `- ${path.join(cwd, "attachments", a.filename)} (${formatSize(a.size_bytes)}, ${a.media_type})`,
    );
    const block = `用户上传了以下文件：\n${lines.join("\n")}\n\n`;
    const currentPrompt = newTask.prompt || "";
    // 防御性: 若 fork 默认 prompt 已经被 PATCH 改写过, 不重复拼.
    const nextPrompt = currentPrompt.includes("用户上传了以下文件")
      ? currentPrompt
      : block + currentPrompt;
    if (nextPrompt !== currentPrompt) {
      updateTask(result.newTaskId, { prompt: nextPrompt });
    }
  }

  return NextResponse.json({
    ok: true,
    new_task_id: result.newTaskId,
    new_session_id: result.newSessionId,
    forked_from_session_id: result.forkedFromSessionId,
    attachments: savedAttachments,
  });
}