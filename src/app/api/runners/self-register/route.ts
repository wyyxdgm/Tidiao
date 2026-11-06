// POST /api/runners/self-register —— daemon 自助注册入口, 让 `runner --register`
// 不依赖平台 admin 凭证. 解决: daemon bootstrap 阶段没有 token, 但 POST /api/runners
// 是 admin-only 的鸡生蛋.
//
// Auth: 预共享 secret (env RUNNER_BOOTSTRAP_SECRET). 仅此一处用于首次注册,
// 注册成功返回 64-hex token (同 admin POST), daemon 落 config.json, 后续
// heartbeat / cancel / health 全走这个 token.
//
// 如果 RUNNER_BOOTSTRAP_SECRET 未设置 → 整个 self-register 路由返回 404
// (feature flag off, 安全默认). 上线时: 在每个实例的 env 写好 secret, 文档
// 见 docs/deploy-secrets.md.
//
// 注意: secret 必须在 platform 进程 env, **不能**放 .env.tokens (那是
// damo 测试用的 admin token). daemon 端 bootstrap 时硬编码在 config.json
// 的 "bootstrap_secret" 字段.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createRunner, OS_TYPES, OsType } from "@/lib/db/runners";

function isAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

function checkBootstrapSecret(request: NextRequest): boolean {
  const expected = process.env.RUNNER_BOOTSTRAP_SECRET;
  if (!expected) return false; // feature flag off → reject (returns 404 below)
  const presented =
    request.headers.get("x-runner-bootstrap-secret") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!presented) return false;
  // constant-time compare (防 timing 侧信道)
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Feature flag: 未配置 secret → 404 (装作路由不存在)
  if (!process.env.RUNNER_BOOTSTRAP_SECRET) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 鉴权: 二选一通过
  // 1. x-user-role === "admin" (admin 调走这条路由方便, 跟原 POST 一致)
  // 2. bootstrap secret 正确
  const adminOk = request.headers.get("x-user-id") && isAdmin(request);
  const secretOk = checkBootstrapSecret(request);
  if (!adminOk && !secretOk) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 复用 admin POST 的 body 校验 + createRunner
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
    return NextResponse.json({ error: "port 必须是 1-65535 的整数" }, { status: 400 });
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