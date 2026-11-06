// GET /api/projects - list projects owned by the current user
// POST /api/projects - create a project (owner = current user from session)

import { NextRequest, NextResponse } from "next/server";
import { listProjects, createProject, type ProjectSort, normalizePorts } from "@/lib/db/projects";
import { PortPoolConflictError } from "@/lib/db/port-pool-error";
import { requireExistingUser } from "@/lib/auth-user-exists";
import { validateCwdFromBody } from "@/lib/cwd-validate";

const VALID_SORTS: ProjectSort[] = ["created_at", "recent_activity", "manual"];

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // sort: created_at (default) | recent_activity. Unknown values fall back
  // silently — the UI sends a known value, so this is just a guard against
  // direct curl/typo'd query strings.
  const raw = request.nextUrl.searchParams.get("sort") ?? "created_at";
  const sort: ProjectSort = (VALID_SORTS as string[]).includes(raw)
    ? (raw as ProjectSort)
    : "created_at";
  // Per-owner project isolation: listProjects(userId, ...) injects
  // WHERE p.owner_id = ?. Admin role intentionally bypasses this so the
  // operator sees every project (board 2026-08-19). User JWT carries role in
  // x-user-role (middleware.ts). Matches schedules GET (?all= requires both
  // flag + admin role); here we use implicit admin because the requirement
  // is "admin token always sees all", not "admin opts in via ?all= true".
  const role = request.headers.get("x-user-role");
  // v532: ?archived=1 查归档项目列表 (侧栏「已归档」分组 / 项目列表归档区块用).
  // 默认不带 = 活跃项目, 行为与此前 byte-identical.
  const wantArchived = request.nextUrl.searchParams.get("archived") === "1";
  const projects = listProjects(role === "admin" ? undefined : userId, sort, {
    archived: wantArchived,
  });
  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Session JWT is stateless — a deleted user's token still passes middleware.
  // Verify the user actually exists before attempting the FK-bound INSERT.
  const notFound = requireExistingUser(userId);
  if (notFound) return notFound;

  let body: { name: string; description?: string; cwd?: string; ports?: number[] | string; create_if_missing?: boolean; git_remote?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  // v54 (R18): ports 字段校验。接受 number[] 或逗号分隔 string ("13001, 13002"),
  // normalizePorts 负责解析 + 校验 (1024-65535 整数, 最多 5 个, 去重)。非法值抛
  // 错, 这里 catch 成 400。admin 端口白名单池 + 已占用检查是 follow-up (R18 P2),
  // 完整链路见 partner docs/ports/PORT-INTAKE.md。
  let ports: number[] | undefined;
  if (body.ports !== undefined && body.ports !== null) {
    try {
      const normalized = normalizePorts(body.ports);
      ports = normalized ?? undefined;
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 400 }
      );
    }
  }
  // cwd 本机校验 (damo 2026-10-31): 路径必须是本机存在的目录; 不存在默认拒绝
  // 并返回核查提示(前缀映射/家目录同名/新建指引), 显式 git_remote(clone) 或
  // create_if_missing=true(新建) 才放行. 防跨机路径形态互串(如 /Users/... 传到 WSL)
  // 造成 agent 启动 mkdir EACCES 秒挂. 通过时 body 里的放行参数已被剥掉.
  const cwdFailure = validateCwdFromBody(body);
  if (cwdFailure) {
    return NextResponse.json(cwdFailure, { status: 400 });
  }
  // ownerId comes from the session header, never from the request body.
  // 重名走 409 而不是裸 500: projects 上有 partial unique index
  // (uq_projects_live ... WHERE deleted_at IS NULL), 同名活项目会抛 UNIQUE.
  // 软删掉的同名项目不占名字, 所以这里能撞上的一定是「另一个活项目同名」.
  try {
    const project = createProject({
      name: body.name.trim(),
      description: body.description,
      cwd: body.cwd,
      ownerId: userId,
      ports,
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    // R18 P2: 端口池冲突 = 结构化 409 (code=PORT_POOL_CONFLICT + conflict 明细).
    // 用 code === 判别 (damo 0823 红线: 字符串子串匹配不可靠, 改 message 静默放过).
    if (err instanceof PortPoolConflictError || (err as { code?: string }).code === "PORT_POOL_CONFLICT") {
      const e = err as PortPoolConflictError;
      return NextResponse.json(
        { error: e.message, code: e.code, conflict: e.conflict },
        { status: e.status }
      );
    }
    const msg = (err as Error).message;
    if (/UNIQUE/i.test(msg)) {
      return NextResponse.json(
        { error: `已存在同名项目「${body.name.trim()}」`, code: "DUPLICATE_NAME" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: `创建项目失败: ${msg}` }, { status: 500 });
  }
}
