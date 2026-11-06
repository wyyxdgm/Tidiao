// GET /api/stats/counts - Per-scope task counts (running / reviewing / total)
// Key format: "projectId:versionId" or "projectId:" for unversioned tasks

import { NextRequest, NextResponse } from "next/server";
import { getTaskCountsByScope } from "@/lib/db/tasks";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const counts = getTaskCountsByScope(userId);
  return NextResponse.json(counts);
}
