// GET /api/admin/users — 列出所有 user + 配额 4 字段 + 累计费用. Admin only.
//
// 跟 /api/admin/llm-grants 平行, 但关注点是 R88 配额 (飞书 R88, damo 0825).
// sheet L 验收点 ④ "切管理员账号看开关 + 三件套表单可见" 的后端.
//
// 关注点:
//   - admin only (x-user-role === "admin"), 跟 llm-grants 一致
//   - 返 listUsersWithQuota() 聚合结果; 前端 settings/page.tsx 直接渲染
//   - 累计费用 (used_total_usd) 是 SUM(tasks.cost_usd) WHERE owner_id & !deleted,
//     走 v49 索引, 单 user 量级不会爆
//   - AO-DEV R208 分页: 带 ?page=&pageSize= 走 listUsersWithQuotaPaged 返
//     {users, total, page, pageSize}; 不带参数保持旧形状 {users} 全量 (向后兼容,
//     历史壳 settings/page.tsx 等旧调用方不传分页参数)

import { NextRequest, NextResponse } from "next/server";
import { listUsersWithQuota, listUsersWithQuotaPaged } from "@/lib/db/users";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function GET(request: NextRequest) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const sp = request.nextUrl.searchParams;
  const hasPaging = sp.has("page") || sp.has("pageSize");
  if (!hasPaging) {
    return NextResponse.json({ users: listUsersWithQuota() });
  }

  // 分页参数校验: 非法整数 → 400 (不静默兜底, 防前端传错还以为分页生效).
  // pageSize 超上限 clamp 到 200 (防一次拉全表打爆 N+1 SUM).
  const pageRaw = sp.get("page") ?? "1";
  const sizeRaw = sp.get("pageSize") ?? String(DEFAULT_PAGE_SIZE);
  const page = Number.parseInt(pageRaw, 10);
  let pageSize = Number.parseInt(sizeRaw, 10);
  if (!Number.isFinite(page) || page < 1 || !Number.isFinite(pageSize) || pageSize < 1) {
    return NextResponse.json(
      { error: "page/pageSize must be positive integers" },
      { status: 400 }
    );
  }
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  const { users, total } = listUsersWithQuotaPaged(page, pageSize);
  return NextResponse.json({ users, total, page, pageSize });
}
