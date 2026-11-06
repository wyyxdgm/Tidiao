// POST /api/auth/token - exchange email+password for a non-expiring API token.
// Like login but returns a bearer token instead of setting a session cookie.
// Lets CLI / scripting clients authenticate once and use the token indefinitely
// (no 7-day refresh). Rate-limited identically to login (per-email).

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getUserByEmail, verifyPassword } from "@/lib/db/users";
import { signApiToken, API_TOKEN_PREFIX } from "@/lib/auth";
import { createApiToken } from "@/lib/db/api-tokens";
import {
  checkRateLimit,
  recordAttempt,
  clearAttempts,
  getClientIp,
  LOGIN_LIMIT,
} from "@/lib/auth-rate-limit";

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 }
    );
  }

  // Same brute-force gate as login (identifier namespaced per action so the
  // counters stay independent).
  const ip = getClientIp(request);
  const identifier = `api-token:${email}`;
  const limit = checkRateLimit(identifier, LOGIN_LIMIT);
  if (!limit.allowed) {
    const mins = Math.ceil((limit.retryAfter ?? 60) / 60);
    return NextResponse.json(
      { error: `尝试次数过多，请 ${mins} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 60) } }
    );
  }

  const user = getUserByEmail(email);
  let success = false;
  try {
    if (user) {
      success = await verifyPassword(password, user.password_hash);
    }
  } finally {
    recordAttempt(identifier, ip, success);
  }

  if (!success || !user) {
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 401 }
    );
  }

  clearAttempts(identifier);

  const name =
    body.name?.trim() ||
    `CLI-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

  const tid = uuidv4();
  const token =
    API_TOKEN_PREFIX +
    (await signApiToken({ userId: user.id, role: user.role, tid }));

  try {
    const row = createApiToken(user.id, name, token.slice(0, 12));
    return NextResponse.json(
      {
        token, // plaintext - only returned this once
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        created_at: row.created_at,
      },
      { status: 201 }
    );
  } catch {
    // UNIQUE(user_id, name) collision.
    return NextResponse.json(
      { error: "已存在同名 token，请换一个名字" },
      { status: 409 }
    );
  }
}
