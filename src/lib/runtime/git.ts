// Small helper: read the current git HEAD commit id from a directory.
// Returns null if cwd is not a git repo, or git is unavailable, or HEAD
// is unborn (fresh repo with no commits). Safe to call repeatedly —
// captures process errors and returns null.

import { execFileSync } from "child_process";

export function getCurrentGitHead(cwd: string, timeoutMs = 2000): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}