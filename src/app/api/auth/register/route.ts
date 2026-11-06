// POST /api/auth/register - create account, set session cookie.
// First registered user -> role=admin, the rest -> role=user.

import { NextRequest, NextResponse } from "next/server";
import {
  createUser,
  getUserByEmail,
  getUserCount,
  toSafeUser,
} from "@/lib/db/users";
import { ensureUncategorizedProject } from "@/lib/db/projects";
import {
  signSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";
import {
  checkRateLimit,
  recordAttempt,
  getClientIp,
  REGISTER_LIMIT,
} from "@/lib/auth-rate-limit";
import { issueSwitchToken } from "@/lib/auth-switch-token";

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }
  if (!password || password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  // Rate limit (per-email, looser than login). Repeated attempts on an
  // already-registered email (409) count as failures; a first-time successful
  // registration does not.
  const ip = getClientIp(request);
  const identifier = `register:${email}`;
  const limit = checkRateLimit(identifier, REGISTER_LIMIT);
  if (!limit.allowed) {
    const mins = Math.ceil((limit.retryAfter ?? 60) / 60);
    return NextResponse.json(
      { error: `尝试次数过多，请 ${mins} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter ?? 60) } }
    );
  }

  if (getUserByEmail(email)) {
    recordAttempt(identifier, ip, false);
    return NextResponse.json(
      { error: "Email already registered" },
      { status: 409 }
    );
  }

  // First user becomes admin (bt mode: trusted team boundary).
  const role = getUserCount() === 0 ? "admin" : "user";
  const user = await createUser(email, password, role);
  recordAttempt(identifier, ip, true);

  // Every user starts with a "未分类" project (Phase 1 T4). The first user
  // reclaims the pre-auth global "未分类" (owner_id NULL from v7); later users
  // get a fresh one. See ensureUncategorizedProject.
  ensureUncategorizedProject(user.id);

  const sessionToken = await signSession({ userId: user.id, role: user.role });
  const switchToken = await issueSwitchToken(user.id);
  const res = NextResponse.json(
    { user: toSafeUser(user), switchToken },
    { status: 201 }
  );
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
  return res;
}
