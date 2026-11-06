// GET /api/webhooks/[id] - Webhook detail (owner-scoped, 404 on non-owner)
// PATCH /api/webhooks/[id] - Update webhook (owner-scoped)
// DELETE /api/webhooks/[id] - Delete webhook (owner-scoped)

import { NextRequest, NextResponse } from "next/server";
import { deleteWebhook, getWebhookById, updateWebhook } from "@/lib/db/webhooks";
import { updateWebhookSchema } from "@/lib/webhooks/schema";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const webhook = getWebhookById(id, userId);
  if (!webhook) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }
  return NextResponse.json(webhook);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json();
  if (body.secret === "") delete body.secret;

  const parsed = updateWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid webhook" },
      { status: 400 }
    );
  }

  const webhook = updateWebhook(id, parsed.data, userId);
  if (!webhook) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }
  return NextResponse.json(webhook);
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
  if (!deleteWebhook(id, userId)) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
