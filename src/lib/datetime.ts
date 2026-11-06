/**
 * Date/time helpers.
 *
 * SQLite's `datetime('now')` returns UTC as `YYYY-MM-DD HH:MM:SS` with no
 * timezone marker. Passing that string directly to `new Date()` makes V8/Chrome
 * parse it as **local time**, which is wrong and silently shifts every
 * display by the browser's UTC offset (e.g. 8 hours in CST).
 *
 * `parseDbTime` normalizes both the SQLite form and already-ISO strings into
 * a proper `Date` anchored to UTC, so the caller's local-time accessors
 * (`getHours`, `toLocaleString`, …) render in the user's actual timezone.
 */

export function parseDbTime(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const normalized = iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
