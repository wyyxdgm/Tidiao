// GET /api/tasks/who-touched?file=<path>&project_id=<uuid>[&lookback=<days>][&limit=<n>]
//
// whoTouchedThis V2: 反查「哪些历史 task 改过这个文件」.
//
// 数据来源: tasks.base_commit + tasks.head_commit (active-session.ts:1925,1938 在
// 任务起止时记录), 用 git diff base..head --name-only -- <file> 派生. 不依赖
// agent 任何 opt-in / marker 写入 (R113 marker adoption = 0%, 详见
// scripts/simulate-who-touched.sh).
//
// 关注点:
//   - 验证 10 维 (scripts/validate-who-touched-v2.sh): 中文 0/2665 / 空格 0 / [id] 4%
//     (用 -- 分隔传给 git, git 自带 shell escape); 软删 task 必过滤 (FAIL 项);
//     failed/reviewing 必过滤 (WARN 项); merge 噪声 ~8% 接受不挡; dangling head
//     graceful fallback (cwd 不可达 → taskTouchedFile 返 false 不抛).
//   - 看历史决策完整内容 (prompt + result) 走 GET /api/tasks/[id]; 本接口只看
//     「谁碰过」, 两边职责不重叠.
//   - LRU 缓存在 lib 里 (task-history.ts), 跨请求复用, 进程级. key 含 cwd + base+head.

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/index";
import { getProjectById } from "@/lib/db/projects";
import { taskTouchedFile } from "@/lib/git/task-history";

const DEFAULT_LOOKBACK_DAYS = 90;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const CANDIDATE_LIMIT = 200; // 验证 F: 200 候选 ≈ 22s, 硬上限防失控

interface CandidateRow {
  id: string;
  title: string;
  status: string;
  completed_at: string | null;
  cwd: string;
  base_commit: string;
  head_commit: string;
}

interface TaskHistoryEntry {
  task_id: string;
  title: string;
  status: string;
  completed_at: string | null;
  cwd: string;
  base_commit: string;
  head_commit: string;
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Admin bypass: x-user-role === 'admin' 时跳过 owner_id 隔离 (operator 看全部,
  // 镜像 src/app/api/projects/route.ts:29-30). 普通用户 SQL 仍强制 owner_id = ?.
  const role = request.headers.get("x-user-role");
  const isAdmin = role === "admin";

  const params = request.nextUrl.searchParams;
  const file = params.get("file");
  const projectId = params.get("project_id");
  if (!file || !projectId) {
    return NextResponse.json(
      { error: "file and project_id are required" },
      { status: 400 },
    );
  }

  // lookback: 整数 1..365, 默认 90. 验证 E: 90d = 天然天花板 (候选数 421 vs
  // 365d = 421), 默认够用. 非整数/超界 → 400 而不是静默修, 调用方错就明显.
  const lookbackRaw = params.get("lookback");
  let lookbackDays = DEFAULT_LOOKBACK_DAYS;
  if (lookbackRaw !== null) {
    const n = Number(lookbackRaw);
    if (!Number.isInteger(n) || n < MIN_LOOKBACK_DAYS || n > MAX_LOOKBACK_DAYS) {
      return NextResponse.json(
        { error: `lookback must be an integer in [${MIN_LOOKBACK_DAYS}, ${MAX_LOOKBACK_DAYS}]` },
        { status: 400 },
      );
    }
    lookbackDays = n;
  }

  // limit: 1..50, 默认 5. 一次返回太多意义不大, UI 也只展示前几条.
  const limitRaw = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return NextResponse.json(
        { error: `limit must be an integer in [1, ${MAX_LIMIT}]` },
        { status: 400 },
      );
    }
    limit = n;
  }

  // Project 校验 + owner 隔离. getProjectById(id, userId) 在 userId 存在时
  // 自动加 WHERE p.owner_id = ? AND p.deleted_at IS NULL; 非 admin 看别人的
  // project 直接 404 (跟其它 API 一致, 不暴露存在性).
  const project = getProjectById(projectId, isAdmin ? undefined : userId);
  if (!project) {
    return NextResponse.json({ error: `Project ${projectId} not found` }, { status: 404 });
  }

  const startedAt = Date.now();

  // SQL 候选拉取. 验证 C: status='completed' + deleted_at IS NULL 是硬约束
  // (2 个软删 task 有 diff → 必过滤否则泄漏; 1 个 failed + 8 个 reviewing 有
  // diff → 必过滤否则返半成品误导). 验证 D: project_id 锁定候选范围.
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT id, title, status, completed_at, cwd, base_commit, head_commit
         FROM tasks
        WHERE project_id = ?
          ${isAdmin ? "" : "AND owner_id = ?"}
          AND status = 'completed'
          AND deleted_at IS NULL
          AND base_commit IS NOT NULL
          AND head_commit IS NOT NULL
          AND base_commit != head_commit
          AND completed_at > datetime('now', ?)
        ORDER BY datetime(completed_at) DESC
        LIMIT ${CANDIDATE_LIMIT}`,
    )
    .all(
      ...(isAdmin
        ? [projectId, `-${lookbackDays} days`]
        : [projectId, userId, `-${lookbackDays} days`]),
    ) as CandidateRow[];

  // 逐候选 git diff (lib 自带 LRU 缓存 + graceful fallback). cwd 不可达 / head
  // 不可达 / 非 git 仓 → taskTouchedFile 返 false, 这里只是不进结果, 不抛.
  const results: TaskHistoryEntry[] = [];
  for (const c of candidates) {
    let touched = false;
    try {
      touched = taskTouchedFile(
        { id: c.id, cwd: c.cwd, base_commit: c.base_commit, head_commit: c.head_commit },
        file,
      );
    } catch {
      // lib 内部已经 try/catch, 这里 catch 是双保险. 真到这 = lib 改了行为.
      continue;
    }
    if (!touched) continue;
    results.push({
      task_id: c.id,
      title: c.title,
      status: c.status,
      completed_at: c.completed_at,
      cwd: c.cwd,
      base_commit: c.base_commit,
      head_commit: c.head_commit,
    });
    if (results.length >= limit) break;
  }

  const elapsedMs = Date.now() - startedAt;

  // Instrumentation: stdout 一行 JSON, pm2 收集, 不进 events 表 (events.task_id
  // 是 FK 到 tasks(id), 本接口是 project 级没有「那个 task」). console.info 而
  // 不是 console.log 走 pm2 的 INFO 通道, 默认会被持久化; 出错不抛 (route 主响应
  // 不被拖垮). 数据字段同 plan v2 §"instrumentation".
  console.info(
    JSON.stringify({
      evt: "task_history_query",
      file,
      project_id: projectId,
      lookback_days: lookbackDays,
      limit,
      candidate_count: candidates.length,
      result_count: results.length,
      elapsed_ms: elapsedMs,
      caller_role: isAdmin ? "admin" : "user",
    }),
  );

  return NextResponse.json({
    file,
    project_id: projectId,
    lookback_days: lookbackDays,
    candidate_count: candidates.length,
    results,
    elapsed_ms: elapsedMs,
  });
}