// POST /api/auth/login - verify credentials, set session cookie.

import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail, toSafeUser, verifyPassword } from "@/lib/db/users";
import {
  signSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";
import {
  checkRateLimit,
  recordAttempt,
  clearAttempts,
  getClientIp,
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

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 }
    );
  }

  // Brute-force gate: check BEFORE the bcrypt verify (~100ms) so a locked
  // account sheds load cheaply. Identifier is per-email so one account being
  // hammered doesn't lock out others.
  const ip = getClientIp(request);
  const identifier = `login:${email}`;
  const limit = checkRateLimit(identifier);
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
    // Record every attempt (incl. unknown email) so enumeration/brute-force
    // attempts count toward the lock. Failure message stays identical whether
    // or not the email exists.
    recordAttempt(identifier, ip, success);
  }

  if (!success) {
    return NextResponse.json(
      { error: "Invalid email or password" },
      { status: 401 }
    );
  }

  // Success: clear this account's failure history so the counter resets now.
  clearAttempts(identifier);

  const sessionToken = await signSession({ userId: user!.id, role: user!.role });
  const switchToken = await issueSwitchToken(user!.id);
  const res = NextResponse.json(
    { user: toSafeUser(user!), switchToken },
    { status: 200 }
  );
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
  return res;
}
