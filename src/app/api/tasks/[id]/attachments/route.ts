// POST /api/tasks/[id]/attachments - upload a file to a task (multipart/form-data)
// GET  /api/tasks/[id]/attachments - list a task's attachments

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/db/tasks";
import {
  listAttachmentsByTaskId,
  saveAttachmentFromFile,
  resolveAttachmentMediaType,
  isAllowedAttachmentMediaType,
} from "@/lib/db/attachments";
import { getRuntime } from "@/lib/runtime/agent-runtime";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!getTaskById(id, userId, { includeDeleted: true })) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const attachments = listAttachmentsByTaskId(id, userId);
  return NextResponse.json({ attachments });
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

  // Reject oversized uploads by Content-Length BEFORE parsing the multipart
  // body. Next 16 truncates request bodies past experimental.proxyClientMaxBodySize
  // (configured to 12MB in next.config.ts), which would corrupt formData() and
  // surface as a generic 400 instead of the contract's 413. The 1MB slack over
  // MAX_SIZE covers multipart framing so a legit 10MB file is never pre-rejected;
  // files between 10MB and 11MB still hit the precise file.size check below.
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_SIZE + 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 413 });
  }

  const filename = file.name || "upload";
  const mediaType = resolveAttachmentMediaType(file.type, filename);
  if (!isAllowedAttachmentMediaType(mediaType)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${mediaType || "unknown"}` },
      { status: 415 },
    );
  }

  // Store + symlink + DB row all in one helper (shared with /api/tasks/[id]/fork
  // for files staged at fork time, and with /api/requirements/[id]/attachments
  // for requirement uploads — polymorphic since v69 / 飞书 R71).
  const attachment = await saveAttachmentFromFile(
    { kind: "task", id: task.id, owner_id: task.owner_id, cwd: task.cwd, project_id: task.project_id },
    userId,
    file,
    {
      source: "upload",
      mediaType,
    },
  );

  // Surface the upload on the SSE stream (no-op if no subscriber is attached).
  getRuntime().emitAttachment(id, {
    id: attachment.id,
    filename: attachment.filename,
    media_type: attachment.media_type,
    size_bytes: attachment.size_bytes,
  });

  return NextResponse.json({ attachment }, { status: 201 });
}
