// GET  /api/cli-import - 读本机 CLI 会话导入 sync 的运行状态 (state.json + pid 探活)
// POST /api/cli-import - 启动一次 sync (scan→summarize→ingest), detached 子进程跑
//   scripts/import-cli-history.ts sync --owner-email <当前用户>; 已在跑返回 409.
//
// 关注点:
// - 状态是单机全局的 (state.json), 不分用户; POST 的任务 owner = 当前会话用户.
// - 依赖同机文件系统: ~/.claude/projects 会话 + transcript 硬链接, 跨机调用无意义
//   (调用方必须打本机实例, 与 docs/usage/08-import-sync.md 跨机器口径一致).
// - spawn 用 node_modules/.bin/jiti, 进程与 next-server 脱离 (detached+unref),
//   stdout/stderr 追加到 $ORCHESTRATOR_HOME/cli-import/sync.log 供排障.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { ORCHESTRATOR_HOME } from "@/lib/constants";
import { getUserById } from "@/lib/db/users";

const STATE_FILE = path.join(ORCHESTRATOR_HOME, "cli-import", "state.json");
const LOG_FILE = path.join(ORCHESTRATOR_HOME, "cli-import", "sync.log");

// 功能: 读 state.json + pid 探活, 归一成 {running, ...state}; 没跑过返回 running:false.
// 关注点: pid 探活与脚本 syncRunning() 同判据 (phase 未完结 + kill 0), stale pid 视为空闲.
function readState(): Record<string, unknown> {
  let st: Record<string, unknown> = {};
  try {
    st = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { running: false, phase: null, message: "从未运行" };
  }
  const phase = st.phase as string | undefined;
  const pid = st.pid as number | undefined;
  let running = false;
  if (phase && phase !== "done" && phase !== "error" && pid) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      /* stale pid */
    }
  }
  return { ...st, running };
}

export async function GET(request: NextRequest) {
  if (!request.headers.get("x-user-id")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(readState());
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "user not found" }, { status: 401 });
  }

  const cur = readState();
  if (cur.running) {
    return NextResponse.json({ error: "sync already running", state: cur }, { status: 409 });
  }

  const repoRoot = process.cwd();
  const jitiBin = path.join(repoRoot, "node_modules", ".bin", "jiti");
  const script = path.join(repoRoot, "scripts", "import-cli-history.ts");
  if (!fs.existsSync(jitiBin) || !fs.existsSync(script)) {
    return NextResponse.json({ error: `import 脚本或 jiti 不存在 (repoRoot=${repoRoot})` }, { status: 500 });
  }

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const fd = fs.openSync(LOG_FILE, "a");
  try {
    const child = spawn(jitiBin, [script, "sync", "--owner-email", user.email], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref();
    child.on("error", (e) => console.error("[cli-import] spawn error:", e));
  } finally {
    fs.closeSync(fd);
  }
  return NextResponse.json({ ok: true, state: { phase: "scan", message: "已启动" } }, { status: 202 });
}
