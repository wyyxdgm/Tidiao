// Helper: issue (or reuse) a per-user "switch-account" API token.
//
// Login and register both call this so the response body can hand a long-lived
// token to the client. The client stashes it in localStorage so the
// "切换账号" dropdown can hop back to this user without re-asking for the
// password. Reusing the same row keeps api_tokens from accumulating one entry
// per login; the row's id matches the JWT's `tid` so revoking the row (delete
// from api_tokens) also revokes the switch capability at the verify step.

import { getApiTokenByName, createApiToken } from "@/lib/db/api-tokens";
import { signApiToken, API_TOKEN_PREFIX } from "@/lib/auth";

export async function issueSwitchToken(userId: string): Promise<string> {
  const existing = getApiTokenByName(userId, "switch-account");
  if (existing) {
    return (
      API_TOKEN_PREFIX +
      (await signApiToken({
        userId,
        role: "", // unused by switch verifier
        tid: existing.id,
      }))
    );
  }
  // The token's `tid` claim MUST equal the api_tokens row id, otherwise the
  // switch verifier's `getApiTokenByName + row.id === decoded.tid` check
  // will reject even freshly-issued tokens. createApiToken generates its own
  // uuid internally, so we need to round-trip: insert first, then sign.
  const row = createApiToken(userId, "switch-account", API_TOKEN_PREFIX);
  const fullToken =
    API_TOKEN_PREFIX +
    (await signApiToken({
      userId,
      role: "",
      tid: row.id,
    }));
  return fullToken;
}
