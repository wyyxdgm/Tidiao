// GET    /api/attachments/[id] - stream an attachment's bytes (owner-gated)
// DELETE /api/attachments/[id] - remove file + symlink + DB row (owner-gated)

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { getAttachmentById, deleteAttachment } from "@/lib/db/attachments";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Non-owner gets 404 (not 403) so cross-tenant existence never leaks.
  const att = getAttachmentById(id, userId);
  if (!att) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let size: number;
  try {
    size = fs.statSync(att.storage_path).size;
  } catch {
    return NextResponse.json({ error: "File missing on disk" }, { status: 410 });
  }

  // PR-1: image / video / audio 全部 inline (浏览器内联播放/预览), 其他走下载.
  //   仅前端 <img>/<video>/<audio> 用; 文本/zip 等仍 attachment 走下载弹窗.
  const isMediaForInline =
    att.media_type.startsWith("image/") ||
    att.media_type.startsWith("video/") ||
    att.media_type.startsWith("audio/");
  const disposition = isMediaForInline
    ? "inline"
    : `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`;

  const buf = fs.readFileSync(att.storage_path);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": att.media_type,
      "Content-Disposition": disposition,
      "Content-Length": String(size),
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ok = deleteAttachment(id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
