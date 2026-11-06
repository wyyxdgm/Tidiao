// GET /api/webhooks - List webhooks (owner-scoped)
// POST /api/webhooks - Create webhook (owner = current user from session)

import { NextRequest, NextResponse } from "next/server";
import { createWebhook, listWebhooks } from "@/lib/db/webhooks";
import { createWebhookSchema } from "@/lib/webhooks/schema";
import { requireExistingUser } from "@/lib/auth-user-exists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(listWebhooks(userId));
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  const parsed = createWebhookSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid webhook" },
      { status: 400 }
    );
  }

  // ownerId comes from the session header, never from the request body.
  return NextResponse.json(createWebhook({ ...parsed.data, ownerId: userId }), { status: 201 });
}
