// Session auth: stateless JWT in a cookie. jose is edge-runtime compatible,
// so this module is safe to import from src/middleware.ts (Edge Runtime) as
// well as Node API routes. Do NOT import anything that pulls in better-sqlite3
// here - middleware can't use native modules.

import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  role: string;
}

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw) {
    // Phase 1 bt-mode fallback: trusted single-machine deploy. Set JWT_SECRET
    // in production. Warn loudly so it isn't forgotten.
    console.warn(
      "[auth] JWT_SECRET not set - using insecure dev default. Set JWT_SECRET in production."
    );
    return new TextEncoder().encode("insecure-dev-secret-change-me");
  }
  return new TextEncoder().encode(raw);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ userId: payload.userId, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySession(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const userId = payload.userId;
    const role = payload.role;
    if (typeof userId !== "string" || typeof role !== "string") return null;
    return { userId, role };
  } catch {
    return null;
  }
}

// --- API tokens (non-expiring, stateless JWT) ---
// Distinct from session cookies via type:"api". Carries a tid (api_tokens.id)
// so the management UI can map a token back to its metadata row. No exp ->
// never expires; revocation is by rotating JWT_SECRET (invalidates all tokens
// + sessions). Verified in Edge middleware alongside session cookies.

export interface ApiTokenPayload {
  userId: string;
  role: string;
  tid: string;
}

export const API_TOKEN_PREFIX = "ao_";

export async function signApiToken(
  payload: ApiTokenPayload
): Promise<string> {
  return new SignJWT({
    userId: payload.userId,
    role: payload.role,
    tid: payload.tid,
    type: "api",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(getSecret());
}

/** Verify a raw API token (WITHOUT the `ao_` prefix). Returns null on any
 *  failure or if the JWT isn't an api-type token. */
export async function verifyApiToken(
  token: string
): Promise<ApiTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.type !== "api") return null;
    const userId = payload.userId;
    const role = payload.role;
    const tid = payload.tid;
    if (
      typeof userId !== "string" ||
      typeof role !== "string" ||
      typeof tid !== "string"
    ) {
      return null;
    }
    return { userId, role, tid };
  } catch {
    return null;
  }
}

/** Cookie options for Set-Cookie.
 *  `secure` 默认跟 NODE_ENV=production，但可通过 COOKIE_SECURE=0 显式关闭
 *  （bt 模式 HTTP 内网部署时需要，否则浏览器不会在 http:// 下发送 cookie）。 */
function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "0") return false;
  if (process.env.COOKIE_SECURE === "1") return true;
  return process.env.NODE_ENV === "production";
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: cookieSecure(),
  };
}

/** Cookie options that clear the session cookie (maxAge 0). */
export function clearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
    secure: cookieSecure(),
  };
}
