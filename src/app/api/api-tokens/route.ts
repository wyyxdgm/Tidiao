// GET  /api/api-tokens - list current user's API tokens (metadata only).
// POST /api/api-tokens - create a new API token (returns plaintext once).

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { signApiToken, API_TOKEN_PREFIX } from "@/lib/auth";
import { listApiTokens, createApiToken, toSafeApiToken } from "@/lib/db/api-tokens";
import { requireExistingUser } from "@/lib/auth-user-exists";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const tokens = listApiTokens(userId).map(toSafeApiToken);
  return NextResponse.json({ tokens });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;
  const role = request.headers.get("x-user-role") ?? "user";

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const name =
    body.name?.trim() ||
    `CLI-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

  const tid = uuidv4();
  const token =
    API_TOKEN_PREFIX +
    (await signApiToken({ userId, role, tid }));

  try {
    const row = createApiToken(userId, name, token.slice(0, 12));
    return NextResponse.json(
      {
        token, // plaintext - shown once
        ...toSafeApiToken(row),
      },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "已存在同名 token，请换一个名字" },
      { status: 409 }
    );
  }
}
