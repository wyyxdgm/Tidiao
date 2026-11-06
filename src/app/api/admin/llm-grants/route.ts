// GET/PUT /api/admin/llm-grants
// Admin user management: authorize/revoke use of the admin LLM config, and set
// per-user concurrency caps (v30, users.max_concurrency). Admin-only access.

import { NextRequest, NextResponse } from "next/server";
import { listAdminLlmGrants, setAdminLlmGrant } from "@/lib/db/llm-configs";
import { setUserMaxConcurrency } from "@/lib/db/users";
import { getRuntime } from "@/lib/runtime/agent-runtime";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

/** GET: list all users with their grant status + concurrency cap. */
export async function GET(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const users = listAdminLlmGrants();
  return NextResponse.json({ users });
}

/** PUT: update a user's grant and/or concurrency cap.
 *  Body: { user_id, enabled?, max_concurrency? }
 *  - enabled: boolean -> toggle admin LLM grant
 *  - max_concurrency: integer 1-10, or null to clear (unlimited)
 *  At least one of enabled / max_concurrency must be provided. */
export async function PUT(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const { user_id, enabled, max_concurrency } = body;
  if (!user_id) {
    return NextResponse.json({ error: "user_id is required" }, { status: 400 });
  }
  if (enabled === undefined && max_concurrency === undefined) {
    return NextResponse.json(
      { error: "enabled or max_concurrency is required" },
      { status: 400 }
    );
  }

  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      );
    }
    setAdminLlmGrant(user_id, enabled);
  }

  if (max_concurrency !== undefined) {
    // null clears the cap (unlimited); otherwise an integer 1-10.
    if (max_concurrency !== null) {
      const n = Number(max_concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return NextResponse.json(
          { error: "max_concurrency must be an integer 1-10 or null" },
          { status: 400 }
        );
      }
      setUserMaxConcurrency(user_id, n);
    } else {
      setUserMaxConcurrency(user_id, null);
    }
    // Drop the scheduler's cached cap so queued tasks see the new limit.
    getRuntime().getScheduler().invalidateOwnerLimit(user_id);
  }

  const users = listAdminLlmGrants();
  return NextResponse.json({ users });
}
