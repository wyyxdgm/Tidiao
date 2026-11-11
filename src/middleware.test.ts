// middleware 公开路径白名单契约 (R153 Docker 化实测修)。
//
// 关注点:
//   - /api/health 必须公开 —— 容器 healthcheck / k8s probe / 外部监控都拿不到 session
//     cookie。原实现里 healthcheck 打 /api/auth/login 期望「非 200 即挂」, 但 login
//     校验失败本来就返 401, wget 视 HTTP 错误为失败退出 1 → 容器永远 unhealthy。
//     正解是让 /api/health 走公开白名单, healthcheck 打它。
//   - 公开 ≠ 全开: /api/tasks 等业务 API 仍必须 401。
//   - 既有放行行为不能被改坏 (SPA 路由 / auth 路由 / 静态资源 matcher)。

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "./middleware";

function req(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { headers: {} });
}

describe("middleware 公开路径", () => {
  it("/api/health 匿名访问放行 (不 401 / 不重定向)", async () => {
    const res = await middleware(req("/api/health"));
    // 放行 = next() → 响应头带 x-middleware-next
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).not.toBe(401);
  });

  it("业务 API 匿名访问仍 401", async () => {
    const res = await middleware(req("/api/tasks"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("非公开页面路径匿名访问重定向 /login", async () => {
    // 注意: /settings /projects/* /tasks/* 等 SPA 路由在 isPublic 里 —— 匿名可看。
    // 挑一个不在白名单的页面路径验「页面 → 302 /login」这条分支。
    const res = await middleware(req("/not-a-public-page"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("SPA 路由 /settings 匿名放行 (既有行为不变)", async () => {
    const res = await middleware(req("/settings"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("根路径 / 放行 (SPA 入口, 匿名可访问)", async () => {
    const res = await middleware(req("/"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("/api/auth/* 放行 (register/login 必须在白名单里)", async () => {
    const res = await middleware(req("/api/auth/login"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("matcher 排除 /assets/* —— SPA 静态资源根本不进 middleware", () => {
    // matcher 里 assets 被排除, 所以 /assets/* 不会被重定向成 307 /login
    // (R59 修过一次: 漏排除 → SPA 拿不到 JS 直接挂)。
    expect(config.matcher[0]).toContain("assets");
  });
});
