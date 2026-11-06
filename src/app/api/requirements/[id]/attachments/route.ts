// POST /api/requirements/[id]/attachments - 上传一个文件到需求点 (multipart/form-data)
// GET  /api/requirements/[id]/attachments - 列该需求点的附件
//
// 飞书 R71: 「新建需求点 需要支持多附件上传」 — 新建表单前端走两步法
//   (POST /api/requirements 拿到 id → 逐文件 POST /api/requirements/[id]/attachments).
//   通用删除走现成 DELETE /api/attachments/[id] (按 id 删, 不区分 task/requirement).

import { NextRequest, NextResponse } from "next/server";
import {
  getRequirementById,
} from "@/lib/db/requirements";
import {
  listAttachmentsByRequirementId,
  saveAttachmentFromFile,
  resolveAttachmentMediaType,
  isAllowedAttachmentMediaType,
} from "@/lib/db/attachments";

// 与 task attachment 同口径 (10MB). 通用规则见 docs/attachments.md.
const MAX_SIZE = 10 * 1024 * 1024;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const req = getRequirementById(id, userId);
  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }
  const attachments = listAttachmentsByRequirementId(id, userId);
  return NextResponse.json({ attachments });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const req = getRequirementById(id, userId);
  if (!req) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  // 大小预检 — 与 task attachment 同样的两道闸 (Content-Length + file.size),
  // 防止 Next.js 16 experimental.proxyClientMaxBodySize 截断 multipart 后报 400 假象.
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

  // Polymorphic saveAttachmentFromFile 内部按 parent.kind 决定存哪 + 建不建 symlink.
  const attachment = await saveAttachmentFromFile(
    { kind: "requirement", id, owner_id: req.owner_id },
    userId,
    file,
    { source: "upload", mediaType },
  );

  return NextResponse.json({ attachment }, { status: 201 });
}
