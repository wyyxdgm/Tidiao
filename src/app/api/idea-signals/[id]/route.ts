// DELETE /api/idea-signals/[id] - 删一条反馈信号（录错时清）

import { NextRequest, NextResponse } from "next/server";
import { deleteIdeaSignal } from "@/lib/db/ideas";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ok = deleteIdeaSignal(id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Signal not found", code: "SIGNAL_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
