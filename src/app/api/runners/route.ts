// GET  /api/runners        - admin: 列出所有 runners; 其他身份: 401
// POST /api/runners        - admin: 注册新 runner, body {name, host, port, os_type},
//                            response 里同一次返回 plaintext token (R1 关键约束:
//                            token 仅此一次, 后面 GET 路由不再返回).
//
// 参考 src/app/api/projects/route.ts 的 401/404/400/409 风格;
// admin 判定一律走 x-user-role header (middleware 已注入), 不再 verify JWT.

import { NextRequest, NextResponse } from "next/server";
import { listRunners, createRunner, OS_TYPES, OsType } from "@/lib/db/runners";

function isAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin(request)) {
    // 没沿用 404 而是 401: list 全表属于 admin 的隐含权限, 非 admin 连试都不该试.
    // 但保持响应体简洁不泄露内部细节.
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }
  const runners = listRunners(); // admin 看全部
  return NextResponse.json({ runners });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "admin only" }, { status: 401 });
  }

  let body: { name?: string; host?: string; port?: unknown; os_type?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  const host = (body.host ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!host) return NextResponse.json({ error: "host is required" }, { status: 400 });

  const portNum = Number(body.port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return NextResponse.json(
      { error: "port 必须是 1-65535 的整数" },
      { status: 400 }
    );
  }

  const osRaw = body.os_type ?? "";
  if (!(OS_TYPES as readonly string[]).includes(osRaw)) {
    return NextResponse.json(
      { error: `os_type 必须是 ${OS_TYPES.join("/")} 之一` },
      { status: 400 }
    );
  }

  try {
    const { runner, token } = createRunner({
      name,
      host,
      port: portNum,
      os_type: osRaw as OsType,
      // admin 注册的 runner 不绑 owner (跨用户共用); runner 表里 owner_id 走 NULL.
      // CreateRunnerInput.ownerId 是可选的, 不传就 OK.
    });
    return NextResponse.json({ runner, token }, { status: 201 });
  } catch (err) {
    const msg = (err as Error).message;
    if (/UNIQUE/i.test(msg)) {
      return NextResponse.json(
        { error: `已注册同 host:port (${host}:${portNum}) 的 runner`, code: "DUPLICATE_HOST_PORT" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: `创建 runner 失败: ${msg}` }, { status: 500 });
  }
}
