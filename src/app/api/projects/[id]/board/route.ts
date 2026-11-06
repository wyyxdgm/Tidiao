// /api/projects/[id]/board
//   GET  ?path=boards/x.md  -> { exists, config, body, error? }
//   POST ?path=...         -> { data: { [sourceName]: value | { error } }, meta }
//   GET  ?history=1&path=  -> { commits: [{sha, author, time, message}] }  (P5 时间线)
//
// 功能: board 文件读写 + 数据源执行 + git 历史. 三件事放在一个 route 是因为它们都
//       需要相同的 cwd 解析 + owner 鉴权, 共享一份代码比拆三个 route 更易维护.
// 关注点:
//  - 前端用一次性 POST 拉所有 source 的 data, 不让前端直连每个 source (省 CORS / 鉴权穿透).
//  - source 失败时返回 sources[name].error, 不让单条错阻断整个 board.
//  - P5 git 历史走 child_process.execFile('git', ['log', ...]) —— cwd 已锁, 无注入面.
//  - R91: 文件解析统一走 resolveBoardFile (项目 cwd 优先 → 平台内置 boards/ 回落),
//    git 历史的 cwd 用解析结果的 root, 否则回落看板会在项目仓里查不到 commit.

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { parseBoardFile, executeBoardSql, resolveBoardFile, applyApiSourceCtx, appendQueryString, type Source, type BoardSourceCtx } from "@/lib/board";
import { getServerUserId } from "@/lib/server-auth";
import { getUserById } from "@/lib/db/users";

// 功能: 判断当前 userId 是否 admin —— 跨 owner 看 SQL 时放宽 owner 过滤用.
// 关注点: 走 DB 拿 role, 缓存交给 DB 层. 不在前端组件调 (会发 DB 请求).
async function isAdminUser(userId: string): Promise<boolean> {
  const u = getUserById(userId);
  return u?.role === "admin";
}

interface SourceResult {
  name: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  ms?: number;
}

// 功能: 执行单个 source. 失败不抛, 返回 {ok:false, error} 让前端能区分.
// 关注点:
//   - api kind 走同进程 fetch (免去鉴权穿透) —— 用绝对 URL 走 localhost.
//   - R98 fix: 内部 fetch 必须转发 cookie —— middleware 看到 x-user-id 也会拒 (只信 cookie/JWT),
//     不带 cookie 时 /api/* 一律 401 → board 的 projects 数据源全空 → iframe JS 算 totals 时
//     projects.forEach 不跑 → 所有徽章=0. 转发 cookie 让 middleware 再验一次 session 注入 x-user-id.
//   - R91 第二步: ctx (projectId / ownerId) 在执行前注入 source —— SQL 走 sql-executor
//     的 injectOwnerFilter + injectProjectFilter; API 走 applyApiSourceCtx 替换占位符
//     和自动追加 query. 两条路都用同一个 ctx, 来源 = 路由层拿到的 {id, userId}.
async function executeSource(source: Source, userId: string, isAdmin: boolean, ctx: BoardSourceCtx, cookieHeader: string): Promise<SourceResult> {
  const t0 = Date.now();
  // Hoist source.name before kind narrowing — inside the if blocks TS will narrow
  // source.kind to 'sql' | 'api' and on the unreachable fallback line to `never`,
  // so `source.name` itself becomes invalid. Bind once to avoid redeclaring in
  // every branch and to keep the type checker happy on the unknown-kind fallback.
  const sourceName = source.name;
  try {
    if (source.kind === "sql") {
      const result = executeBoardSql(source.query, {
        ownerId: userId,
        crossOwner: isAdmin,
        projectId: ctx.projectId,
        timeoutMs: 2000,
        rowLimit: 5000,
      });
      return { name: sourceName, ok: true, data: result, ms: Date.now() - t0 };
    }
    if (source.kind === "api") {
      // ctx 注入: 占位符替换 + 自动 query. 没传 ctx.projectId 时也能跑 (做 query 不追加).
      const { path, query } = applyApiSourceCtx(source, ctx);
      const base = process.env.ORCHESTRATOR_PUBLIC_BASE_URL || "http://127.0.0.1:13000";
      const url = base + appendQueryString(path, query);
      const resp = await fetch(url, {
        headers: {
          "x-user-id": userId,
          "x-user-role": isAdmin ? "admin" : "",
          accept: "application/json",
          // R98 fix: 转发 cookie 让 middleware 重验 session, 注入正确 x-user-id/x-user-role.
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) {
        return { name: sourceName, ok: false, error: `api ${path} returned ${resp.status}`, ms: Date.now() - t0 };
      }
      const data = await resp.json();
      return { name: sourceName, ok: true, data, ms: Date.now() - t0 };
    }
    return { name: sourceName, ok: false, error: `unknown source kind`, ms: Date.now() - t0 };
  } catch (err) {
    return { name: sourceName, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getServerUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = getProjectById(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const versionParam = request.nextUrl.searchParams.get("version");
  const version = versionParam ? getVersionById(versionParam, userId) : null;
  const cwd = version && version.project_id === id ? (version.cwd || project.cwd) : project.cwd;
  if (!cwd) {
    return NextResponse.json({ exists: false, reason: "no-cwd" });
  }

  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(cwd);
  } catch {
    return NextResponse.json({ exists: false, reason: "no-cwd" });
  }

  const boardPath = request.nextUrl.searchParams.get("path")?.trim() || "boards/my-project.md";
  const resolved = resolveBoardFile(cwdReal, boardPath);

  // P5: ?history=1 返回 git log (前 20 条). cwd 用解析出的 root —— 平台内置看板的
  // commit 在平台仓里, 拿项目 cwd 查会空.
  if (request.nextUrl.searchParams.get("history") === "1") {
    try {
      const out = execFileSync(
        "git",
        ["log", "-20", "--pretty=format:%H%x00%an%x00%ae%x00%aI%x00%s", "--", boardPath],
        { cwd: resolved?.root || cwdReal, encoding: "utf8", timeout: 2000 }
      );
      const commits = out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, author, email, time, ...msgParts] = line.split("\x00");
          const message = msgParts.join("\x00");
          const authorRole = /agent|bot|noreply/i.test(email) ? "agent" : "user";
          return { sha, author, email, time, message, authorRole };
        });
      return NextResponse.json({ commits });
    } catch (err) {
      return NextResponse.json({ commits: [], error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!resolved) return NextResponse.json({ exists: false, path: boardPath, reason: "not-found" });

  const parsed = parseBoardFile(resolved.content);
  return NextResponse.json({
    exists: true,
    path: boardPath,
    origin: resolved.origin,
    config: parsed.config,
    body: parsed.body,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getServerUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = getProjectById(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const versionParam = request.nextUrl.searchParams.get("version");
  const version = versionParam ? getVersionById(versionParam, userId) : null;
  const cwd = version && version.project_id === id ? (version.cwd || project.cwd) : project.cwd;
  if (!cwd) return NextResponse.json({ error: "no-cwd" }, { status: 400 });

  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(cwd);
  } catch {
    return NextResponse.json({ error: "no-cwd" }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as { path?: string; sourceNames?: string[] } | null;
  const boardPath = (body?.path || "boards/my-project.md").trim();
  const file = resolveBoardFile(cwdReal, boardPath);
  if (!file) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const parsed = parseBoardFile(file.content);

  const isAdmin = await isAdminUser(userId);
  // R91 第二步: 构造 ctx (projectId = 当前项目 id, ownerId = 当前用户).
  // SQL source 走 sql-executor 的 owner/project 注入; API source 走 applyApiSourceCtx 占位符替换.
  const ctx: BoardSourceCtx = { projectId: id, ownerId: userId };
  // 并行执行所有 source (P0 不带增量优化, 后续 P2 SSE 时再分批)
  const targets = body?.sourceNames
    ? parsed.config.sources.filter((s) => body.sourceNames!.includes(s.name))
    : parsed.config.sources;

  const results = await Promise.all(targets.map((s) => executeSource(s, userId, isAdmin, ctx, request.headers.get("cookie") ?? "")));
  const byName: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const r of results) {
    if (r.ok) byName[r.name] = r.data;
    else errors[r.name] = r.error || "unknown error";
  }

  return NextResponse.json({
    path: boardPath,
    data: byName,
    errors,
    meta: {
      fetchedAt: new Date().toISOString(),
      sources: results.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms })),
    },
  });
}
