// POST /api/auth/switch - exchange a stored switch-token for a fresh session
// cookie. Lets the front-end "switch account" UI hop between recently-used
// users in one click without re-asking for the password.
//
// Trust model: the request body carries {email, token}. The token is the
// "ao_<jwt>" form stored in localStorage by the login response. We strip the
// prefix, verify the JWT, confirm the token's tid is still registered in
// api_tokens under the "switch-account" name (so deleting that row
// invalidates the switch capability even though the JWT itself is
// stateless), and check the email matches the user the token was issued
// for. The combination prevents token reuse after a name change or DB
// cleanup.

import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail, toSafeUser } from "@/lib/db/users";
import { getApiTokenByName } from "@/lib/db/api-tokens";
import {
  signSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifyApiToken,
  API_TOKEN_PREFIX,
} from "@/lib/auth";

export async function POST(request: NextRequest) {
  let body: { email?: string; token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const rawToken = body.token?.trim();

  if (!email || !rawToken) {
    return NextResponse.json(
      { error: "email and token are required" },
      { status: 400 }
    );
  }

  // The localStorage form is "ao_<jwt>"; verifyApiToken wants the bare JWT.
  const bareToken = rawToken.startsWith(API_TOKEN_PREFIX)
    ? rawToken.slice(API_TOKEN_PREFIX.length)
    : rawToken;

  const decoded = await verifyApiToken(bareToken);
  if (!decoded) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 }
    );
  }

  // The token's tid must still exist as a "switch-account" row for this user.
  // This binds JWT validity to the api_tokens table so wiping that row
  // (e.g. on password change) immediately revokes switch capability.
  const row = getApiTokenByName(decoded.userId, "switch-account");
  if (!row || row.id !== decoded.tid) {
    return NextResponse.json(
      { error: "Token no longer valid" },
      { status: 401 }
    );
  }

  const user = getUserByEmail(email);
  if (!user || user.id !== decoded.userId) {
    return NextResponse.json(
      { error: "Email does not match token" },
      { status: 401 }
    );
  }

  const session = await signSession({ userId: user.id, role: user.role });
  const res = NextResponse.json({ user: toSafeUser(user) });
  res.cookies.set(SESSION_COOKIE, session, sessionCookieOptions());
  return res;
}
