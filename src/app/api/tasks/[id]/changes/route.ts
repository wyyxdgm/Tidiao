// GET /api/tasks/[id]/changes - List files changed during a task
// Optional ?file=<path> returns diff for that single file
//
// Strategy: prefer the SDK's rewindFiles(dryRun) on a live session (accurate
// and includes contents written via git checkpointing). When the session is no
// longer in memory (paused/completed/failed/cancelled), fall back to the DB's
// tool_use events for Write/Edit/NotebookEdit. Use git status in cwd to label
// each file as added/modified/deleted when possible.

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getTaskById } from "@/lib/db/tasks";
import { getEventsByTaskId } from "@/lib/db/events";
import { safeJsonParse } from "@/lib/constants";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const FILE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

type ChangeEntry = {
  filePath: string;             // relative to cwd if possible
  operation: "added" | "modified" | "deleted" | "unknown";
  count: number;                // number of write-class tool calls
  lastToolName: string;         // Write | Edit | NotebookEdit
  lastEventId: number;
};

type OperationMap = Record<string, ChangeEntry["operation"]>;

function extractFilePath(name: string, input: Record<string, unknown>): string | null {
  if (name === "Write" || name === "Edit") {
    const fp = input.file_path ?? input.filePath;
    return typeof fp === "string" ? fp : null;
  }
  if (name === "NotebookEdit") {
    const fp = input.notebook_path ?? input.notebookPath;
    return typeof fp === "string" ? fp : null;
  }
  return null;
}

// Run `git -C <cwd> status --porcelain` and return a map of relative file path → operation.
function gitStatusMap(cwd: string): OperationMap {
  const map: OperationMap = {};
  let output: string;
  try {
    output = execFileSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return map;
  }

  for (const line of output.split("\n")) {
    if (!line) continue;
    // `XY <path>` where X = index status, Y = worktree status
    // Common forms: " M src/foo.ts", "M  src/foo.ts", "?? new.ts", "A  new.ts",
    // "D  deleted.ts", " R old -> new"
    const m = line.match(/^(.)(.) (.*)$/);
    if (!m) continue;
    const [, x, y, rawPath] = m;
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath;
    let op: ChangeEntry["operation"] = "unknown";
    if (x === "A" || (x === "?" && y === "?")) op = "added";
    else if (x === "D" || y === "D") op = "deleted";
    else if (x === "M" || y === "M" || x === "R" || y === "R" || x === "U" || y === "U") op = "modified";
    map[filePath] = op;
  }
  return map;
}

// Translate a (possibly absolute) file path reported by the SDK into the form
// git status uses (relative to cwd, no leading "./").
function relativize(p: string, cwd: string): string {
  if (path.isAbsolute(p)) {
    const rel = path.relative(cwd, p);
    if (!rel.startsWith("..")) return rel;
  }
  // Already relative — strip leading "./"
  return p.replace(/^\.\//, "");
}

function buildChangeList(taskId: string, cwd: string): ChangeEntry[] {
  const events = getEventsByTaskId(taskId);
  const opMap = gitStatusMap(cwd);
  const byPath = new Map<string, ChangeEntry>();

  for (const ev of events) {
    if (ev.type !== "tool_use") continue;
    const data = safeJsonParse<{ name?: string; input?: Record<string, unknown> }>(ev.data, {});
    const name = data.name || "";
    if (!FILE_TOOLS.has(name)) continue;
    const input = data.input || {};
    const rawPath = extractFilePath(name, input);
    if (!rawPath) continue;

    const relPath = relativize(rawPath, cwd);
    const existing = byPath.get(relPath);
    if (existing) {
      existing.count += 1;
      if (ev.id !== undefined && ev.id > existing.lastEventId) {
        existing.lastEventId = ev.id;
        existing.lastToolName = name;
      }
      // If git status resolved this file later, upgrade the operation label
      if (existing.operation === "unknown" && opMap[relPath]) {
        existing.operation = opMap[relPath];
      }
    } else {
      byPath.set(relPath, {
        filePath: relPath,
        operation: opMap[relPath] ?? "unknown",
        count: 1,
        lastToolName: name,
        lastEventId: ev.id ?? 0,
      });
    }
  }

  return Array.from(byPath.values()).sort((a, b) => b.lastEventId - a.lastEventId);
}

// Produce a unified diff for the requested file. Prefers `git diff HEAD` so
// the diff matches what the agent actually changed vs the committed state.
function buildFileDiff(cwd: string, filePath: string): { diff: string | null; content: string | null; notFound: boolean } {
  // First try git diff (handles added/modified/deleted in one shot)
  try {
    const out = execFileSync("git", ["-C", cwd, "diff", "HEAD", "--", "--", filePath], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.trim()) return { diff: out, content: null, notFound: false };
  } catch {
    // not a git repo or no HEAD — fall through to filesystem fallback
  }

  // Try diff against /dev/null (catches untracked files)
  try {
    const out = execFileSync("git", ["-C", cwd, "diff", "--no-index", "--", "/dev/null", filePath], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.trim()) return { diff: out, content: null, notFound: false };
  } catch {
    // ignore
  }

  // Filesystem fallback: read current content (or report notFound for deletions)
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(abs)) {
    return { diff: null, content: null, notFound: true };
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { diff: null, content: null, notFound: true };
  }
  if (!stat.isFile()) {
    return { diff: null, content: null, notFound: true };
  }
  if (stat.size > 256 * 1024) {
    return { diff: null, content: "(文件过大，> 256KB，无法预览)", notFound: false };
  }
  try {
    const content = fs.readFileSync(abs, "utf8");
    return { diff: null, content, notFound: false };
  } catch {
    return { diff: null, content: null, notFound: true };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const task = getTaskById(id, userId, { includeDeleted: true });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const runtime = getRuntime();
  const session = runtime.getActiveSession(id);
  const active = Boolean(session);

  // Determine cwd: prefer the active session's cwd (always authoritative)
  const cwd = session?.getCwd() || task.cwd || "";
  if (!cwd) {
    return NextResponse.json({
      active,
      source: active ? "live" : "history",
      cwd: "",
      changes: [],
      note: "task has no cwd; cannot enumerate file changes",
    });
  }

  const url = new URL(request.url);
  const fileParam = url.searchParams.get("file");

  // When the session is still running we additionally surface the SDK's
  // checkpointed files (via rewindFiles with the latest user message). The
  // SDK's RewindFilesResult shape is { canRewind, filesChanged?, ... } — if
  // filesChanged is missing we silently fall back to the events-based list
  // built below, which is always complete.
  let liveFiles: string[] | null = null;
  if (active && session && fileParam === null) {
    try {
      const messages = await runtime.getSessionHistory(id);
      const lastUser = [...messages].reverse().find((m: any) => m.type === "user");
      const userMessageId = lastUser?.uuid;
      if (userMessageId && (session as any).rewindFiles) {
        const result = await (session as any).rewindFiles(userMessageId, { dryRun: true });
        const changed = result?.filesChanged;
        if (Array.isArray(changed)) {
          liveFiles = changed as string[];
        }
      }
    } catch {
      // best-effort; events below remain the source of truth
    }
  }

  const changes = buildChangeList(id, cwd);

  if (fileParam !== null) {
    const { diff, content, notFound } = buildFileDiff(cwd, fileParam);
    return NextResponse.json({
      active,
      source: active ? "live" : "history",
      cwd,
      file: fileParam,
      diff,
      content,
      notFound,
    });
  }

  // Merge liveFiles (from rewindFiles) into the events-based list. Lives wins
  // for ordering of new writes that haven't been logged to DB yet.
  if (liveFiles && liveFiles.length > 0) {
    const seen = new Set(changes.map((c) => c.filePath));
    for (const raw of liveFiles) {
      const rel = relativize(raw, cwd);
      if (seen.has(rel)) continue;
      changes.unshift({
        filePath: rel,
        operation: "unknown",
        count: 1,
        lastToolName: "Write",
        lastEventId: -Math.abs(rel.length), // sort before DB entries
      });
      seen.add(rel);
    }
  }

  return NextResponse.json({
    active,
    source: active ? "live" : "history",
    cwd,
    changes,
  });
}
