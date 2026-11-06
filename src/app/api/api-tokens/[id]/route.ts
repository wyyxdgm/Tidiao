// DELETE /api/api-tokens/[id] - remove a token's metadata row.

import { NextRequest, NextResponse } from "next/server";
import { deleteApiToken } from "@/lib/db/api-tokens";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const deleted = deleteApiToken(userId, id);
  if (!deleted) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
