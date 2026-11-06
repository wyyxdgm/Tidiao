// GET /api/port-pool/available - 给前端「从池里自动选可用端口」按钮用.
// 返回 { pool: [[start,end],...], used: number[], available: number[] }
// 其中 available 是按池段升序扫到的前 N 个未占用 (N 默认 5, ?n= 可调).
//
// 关注点:
//  - 不限 admin: 普通用户建项目也要看到池 + 占用情况, 否则 UI 没法做「提示用户
//   池里还剩多少可分」. 权限在 PATCH /api/config (改池) 那里卡 admin, 这里只读.
//  - used 集合直接复用 listUsedPorts() —— 单源真理, 跨项目端口冲突判据一致.
//  - available 默认 5 个, 与项目 ports 字段上限对齐 (createProject 最多 5 个).

import { NextRequest, NextResponse } from "next/server";
import {
  listUsedPorts,
  pickAvailablePorts,
} from "@/lib/db/projects";
import { getPortPool, MAX_PORTS_PER_PROJECT } from "@/lib/db/settings";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // ?n= 调返回数量, 默认 MAX_PORTS_PER_PROJECT, 上限 32 (避免有人请求 1000
  // 一次性扫全池).
  const nParam = Number(request.nextUrl.searchParams.get("n") ?? MAX_PORTS_PER_PROJECT);
  const n = Number.isInteger(nParam) && nParam > 0 && nParam <= 32
    ? nParam
    : MAX_PORTS_PER_PROJECT;

  const pool = getPortPool();
  const used = listUsedPorts();
  const available = pickAvailablePorts(n, used);
  return NextResponse.json({
    pool: pool.map(([s, e]) => [s, e]),
    used: Array.from(used).sort((a, b) => a - b),
    available,
  });
}
