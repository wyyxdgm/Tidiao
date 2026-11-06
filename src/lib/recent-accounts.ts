// localStorage-backed "recently logged in accounts" list, used by the
// AccountSwitcher dropdown. Each entry pairs an email with a long-lived API
// token issued by /api/auth/login (or /register). The token lets the user
// hop back to a previous account in one click without re-typing a password.
//
// Failure modes are intentionally silent: localStorage can throw (private
// mode in some browsers, quota issues, disabled). We never want a missing
// "switch account" list to break login or the auth flow itself.

const STORAGE_KEY = "ao_recent_accounts";
const MAX_ENTRIES = 8;

export interface RecentAccount {
  email: string;
  /** Full token including the "ao_" prefix. */
  token: string;
  /** Epoch ms — used to order the list newest-first. */
  addedAt: number;
}

function readAll(): RecentAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentAccount =>
        e &&
        typeof e.email === "string" &&
        typeof e.token === "string" &&
        typeof e.addedAt === "number"
    );
  } catch {
    return [];
  }
}

function writeAll(list: RecentAccount[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore — see header
  }
}

export function getRecentAccounts(): RecentAccount[] {
  return readAll().sort((a, b) => b.addedAt - a.addedAt);
}

/** Add or refresh an entry. Existing entry for the same email is moved to
 *  the top and its token is replaced with the new one. */
export function addRecentAccount(email: string, token: string): void {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !token) return;
  const others = readAll().filter((e) => e.email !== normalized);
  const next: RecentAccount[] = [
    { email: normalized, token, addedAt: Date.now() },
    ...others,
  ].slice(0, MAX_ENTRIES);
  writeAll(next);
}

/** Remove the entry for `email` if present. Called on explicit logout so
 *  the user no longer sees that account in the switch list. */
export function removeRecentAccount(email: string): void {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  const next = readAll().filter((e) => e.email !== normalized);
  writeAll(next);
}
