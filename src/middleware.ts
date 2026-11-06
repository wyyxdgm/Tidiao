// Auth middleware: protect all routes except explicit public ones.
// Runs in the Edge Runtime, so it imports only src/lib/auth.ts (jose) and
// never touches better-sqlite3. Authenticated requests get x-user-id /
// x-user-role headers injected for API routes to read (consumed in T3).
//
// Public: /api/auth/* (register/login/logout), /login, /register, /_next/*,
// static assets. Unauthenticated /api/* -> 401 JSON; unauthenticated pages
// -> redirect to /login. Authenticated -> passthrough with injected headers.
//
// 关注点: 公开路径仍会尝试解析 session cookie (R70 fix). 若带有效 session,
// 注入 x-user-id 让详情页 (`/requirements/[id]`, `/tasks/[id]`) 能拿到
// ownerId 走 DB 查询 —— 避免「列表页公开 + 详情页要求 owner」导致的
// 假 404. 无 session 仍按公开路径处理 (不重定向到 /login).

import { NextRequest, NextResponse } from "next/server";
import { verifySession, verifyApiToken, SESSION_COOKIE, API_TOKEN_PREFIX } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/register"];

function isPublic(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return true;
  // 静态资源挂载点 (public/monster-math symlink → 本机媒体库): 外部直链, 不走 auth.
  // matcher 侧同步排除 (见下方 matcher 注释).
  if (pathname.startsWith("/monster-math/")) return true;
  // Intake webhooks (wecom 企微回调 / telegram bot): 外部渠道回调 + 出站 webhook 自调用,
  // 验签在各自 route handler 内处理, 不走 session.
  // 🔴 517a9fef 重写 isPublic 时误删过此行 (commit msg 未提 middleware) —— 企微回调
  // 在 master 上会被 401 拦, 线上因旧构建未暴露. R184 Telegram 接入时一并修复.
  if (pathname.startsWith("/api/intake")) return true;
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname === "/" || pathname.startsWith("/projects/") || pathname.startsWith("/tasks/") || pathname.startsWith("/messages/") || pathname.startsWith("/schedules/") || pathname.startsWith("/requirements/") || pathname.startsWith("/global") || pathname.startsWith("/import") || pathname.startsWith("/settings") || pathname.startsWith("/usage") || pathname.startsWith("/runners") || pathname.startsWith("/wiki")) return true;
  if (pathname.startsWith("/api/integration/openclaw")) return true;
  if (pathname.match(/^\/api\/runners\/self-register$/)) return true;
  if (pathname.match(/^\/api\/runners\/[^/]+\/heartbeat$/)) return true;
  if (pathname.startsWith("/_next")) return true;
  if (
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/manifest.json"
  ) {
    return true;
  }
  return false;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // R70 fix: 公开路径仍尝试解析 session, 带有效 cookie 时注入 x-user-id.
  // 原因: 详情页 (`/requirements/[id]`, `/tasks/[id]`) 走 owner_id 隔离,
  //   没有 x-user-id = getServerUserId() 返回 "" = getById 返 null = 假 404.
  //   公开路径不重定向 (匿名仍可访问), 但已登录用户应能正常渲染.
  const session = await resolveSession(request);

  if (isPublic(pathname)) {
    if (!session) return NextResponse.next();
    return withUserHeaders(request, session);
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  return withUserHeaders(request, session);
}

// 功能: 从 cookie + Authorization header 解析 session. 失败返 null.
// 关注点: Edge Runtime 跑, 只能引 jose; 不读 DB.
async function resolveSession(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const s = await verifySession(token);
    if (s) return s;
  }
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const raw = bearer.slice(7).trim();
    if (raw.startsWith(API_TOKEN_PREFIX)) {
      const s = await verifyApiToken(raw.slice(API_TOKEN_PREFIX.length));
      if (s) return s;
    }
  }
  return null;
}

// 功能: 复制 request headers + 注入 x-user-id / x-user-role, 走 next().
function withUserHeaders(request: NextRequest, session: { userId: string; role: string }) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-id", session.userId);
  requestHeaders.set("x-user-role", session.role);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // R59+ SPA integration: /assets/* 是 SPA 静态资源 (vite build 输出到 public/assets/),
  // 必须从 matcher 里排除 —— 否则 middleware 把它们当非公开路径重定向到 /login (实测
  // /assets/index-XXX.js → 307 → /login, SPA 拿不到 JS 挂掉)。其它 public/ 静态
  // (favicon.svg, robots.txt 等) 也加进 isPublic + matcher, 跟老 public/ 文件路径同步。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|assets|favicon.svg|monster-math).*)"],
};
