// PATCH /api/admin/users/[id] — 改单个 user 的 R88 配额 4 字段. Admin only.
//
// 关注点:
//   - 4 个 setter 各自独立接受: party_a_enabled / quota_total_spent_cap /
//     quota_granted_cap / quota_expire_at. body schema 跟 llm-grants 同款
//     (至少 1 个字段, undefined = 不改, null = 清空).
//   - operator_id 拿请求头里的 x-user-id (admin 自己), 写进 user_quota_change_log
//     让审计能追到谁改的. 不传 operatorId = 路由层 400.
//   - 复用 Phase 1 commit 431d4c1 的 4 个 setter (setUserPartyAEnabled /
//     setUserQuotaTotalSpentCap / setUserQuotaGrantedCap / setUserQuotaExpireAt),
//     每个都是单事务 (UPDATE users + INSERT log).
//   - 至少要传 1 个字段, 否则 400 (避免空 body 200 + 空更新 = 静默 no-op).

import { NextRequest, NextResponse } from "next/server";
import {
  setUserPartyAEnabled,
  setUserQuotaTotalSpentCap,
  setUserQuotaGrantedCap,
  setUserQuotaExpireAt,
} from "@/lib/db/users";

function requireAdmin(request: NextRequest): boolean {
  return request.headers.get("x-user-role") === "admin";
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ error: "admin required" }, { status: 403 });
  }
  const operatorId = request.headers.get("x-user-id");
  if (!operatorId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { party_a_enabled, quota_total_spent_cap, quota_granted_cap, quota_expire_at, reason } = body;

  if (
    party_a_enabled === undefined &&
    quota_total_spent_cap === undefined &&
    quota_granted_cap === undefined &&
    quota_expire_at === undefined
  ) {
    return NextResponse.json(
      { error: "at least one of party_a_enabled / quota_total_spent_cap / quota_granted_cap / quota_expire_at is required" },
      { status: 400 }
    );
  }

  const opts = { operatorId, reason: typeof reason === "string" ? reason : null };

  if (party_a_enabled !== undefined) {
    if (typeof party_a_enabled !== "boolean") {
      return NextResponse.json(
        { error: "party_a_enabled must be boolean" },
        { status: 400 }
      );
    }
    const updated = setUserPartyAEnabled(id, party_a_enabled, opts);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
  }

  if (quota_total_spent_cap !== undefined) {
    // null = 清空(不限); 数字 = 设上限; 字符串数字 = 兼容
    if (quota_total_spent_cap !== null) {
      const n = Number(quota_total_spent_cap);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json(
          { error: "quota_total_spent_cap must be a non-negative number or null" },
          { status: 400 }
        );
      }
    }
    const updated = setUserQuotaTotalSpentCap(id, quota_total_spent_cap, opts);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
  }

  if (quota_granted_cap !== undefined) {
    if (quota_granted_cap !== null) {
      const n = Number(quota_granted_cap);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json(
          { error: "quota_granted_cap must be a non-negative number or null" },
          { status: 400 }
        );
      }
    }
    const updated = setUserQuotaGrantedCap(id, quota_granted_cap, opts);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
  }

  if (quota_expire_at !== undefined) {
    if (quota_expire_at !== null && typeof quota_expire_at !== "string") {
      return NextResponse.json(
        { error: "quota_expire_at must be ISO8601 string or null" },
        { status: 400 }
      );
    }
    // 校验 ISO8601 是否合法; setter 内部也有 fallback 但路由层先报 400 更友好
    if (typeof quota_expire_at === "string" && !Number.isFinite(Date.parse(quota_expire_at))) {
      return NextResponse.json(
        { error: "quota_expire_at must be valid ISO8601" },
        { status: 400 }
      );
    }
    const updated = setUserQuotaExpireAt(id, quota_expire_at, opts);
    if (!updated) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
  }

  return NextResponse.json({ ok: true });
}