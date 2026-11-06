// POST /api/auth/logout - clear session cookie.

import { NextResponse } from "next/server";
import { SESSION_COOKIE, clearCookieOptions } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", clearCookieOptions());
  return res;
}
