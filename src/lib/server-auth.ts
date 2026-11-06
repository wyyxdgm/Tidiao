// Server-only helpers: read the authenticated user id / role that middleware
// injects into request headers (x-user-id, x-user-role, see src/middleware.ts).
// Server components and route handlers share these headers via next/headers,
// so the same identity the API routes trust is available here without
// re-verifying the JWT.
//
// Middleware guarantees x-user-id / x-user-role on every protected route; if
// either is somehow absent we return "" so DB calls with ownerId="" match
// nothing and the page fails closed (notFound / empty list) rather than
// leaking cross-user data.

import { headers } from "next/headers";

export async function getServerUserId(): Promise<string> {
  const h = await headers();
  return h.get("x-user-id") ?? "";
}

export async function getServerRole(): Promise<string> {
  const h = await headers();
  return h.get("x-user-role") ?? "";
}
