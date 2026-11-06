// GET /api/stats/backlog —— 积压概览：各状态任务条数 + 最老一条的年龄 + reviewing 按 owner 分组。
//
// 为什么另开端点而不用 /api/stats: 那个是 **按 owner 过滤**的（多租户口径，一个用户
// 看不到别人的账单/状态）。而「积压」这件事的价值恰恰在跨 owner 的全局数字 ——
// 本实例实测: /api/stats 给 admin 报 failed=1 / pending=0，DB 全局却是 failed=13 /
// pending=6，光看 per-owner 的数字会得出「零积压」的错误结论。这就是 board-R24
// 这条需求存在的原因，所以这里必须是全局口径。
//
// 口径由 scope 字段自我声明，不许含糊:
//   scope="all"  —— admin，跨所有 owner 的全局数字
//   scope="mine" —— 普通用户，只有自己的任务（无权看别人的）
// 前端必须把 scope 显示出来，否则「6 条 pending」到底是谁的没人说得清。
//
// 🔴 时区: created_at 是 **UTC** 字符串（SQLite `datetime('now')` 无时区标记），
//   这里的年龄 = julianday('now') - julianday(created_at)，两侧同为 UTC，**不要**
//   照抄 /api/stats/usage 的 `+8 hours` —— 那个偏移是为了让「分桶标签」落在 CST
//   的自然日边界上，对「两个时刻求差」而言加 8 小时纯属多余，两边都加还会互相抵消。
//
// 关注点:
//  - 只读。这个端点不改任何 task 状态、不删任何东西（需求全部内容就是「看得见」）。
//  - 只统计 deleted_at IS NULL —— 软删的任务不算积压。
//  - BACKLOG_STATUSES 里 0 条的状态**也要返回**（补零），否则前端会把「这个状态
//    不存在」显示成「没这一栏」，而积压面板恰恰需要「pending 0」这种确认信息。
//  - all_statuses 是 **全部**状态的 group by（含 completed/cancelled），故意与
//    `select status,count(*) from tasks where deleted_at is null group by status`
//    逐个可比 —— 验收/排查时能直接跟 sqlite3 的输出对齐。
//  - created_at 为 NULL 的行（历史脏数据）不参与年龄计算，但**照样计入条数**:
//    用 MIN 忽略 NULL 的天然行为，别用 WHERE created_at IS NOT NULL 过滤，
//    那会让条数与 all_statuses 对不上。

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// 「积压」= 还没走到终态、需要人或调度器再动一次的状态。
// 终态只有 completed / cancelled；rejected 是打回后等重做，也算在飞（与
// task-scheduler 的「非终态」判据保持一致，见 CLAUDE.md 定时任务段）。
const BACKLOG_STATUSES = [
  "pending",
  "queued",
  "running",
  "paused",
  "reviewing",
  "rejected",
  "failed",
] as const;

// reviewing 按 owner 分组只取前 N —— 「谁该去验收」是这个数字唯一的行动价值，
// 长尾对行动没有帮助。剩下的合并成 other_count，免得前端以为分组之和 = 总数。
const TOP_OWNERS = 3;

interface StatusRow {
  status: string;
  count: number;
  oldest_created_at: string | null;
  oldest_age_days: number | null;
}

interface OwnerRow {
  owner_id: string | null;
  email: string | null;
  count: number;
}

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // admin 看全局，普通用户只看自己。scope 随响应返回，让口径不可误读。
  const isAdmin = request.headers.get("x-user-role") === "admin";
  const scope = isAdmin ? "all" : "mine";
  // 拼进 SQL 的只有这两个固定片段，参数值仍走占位符（不做字符串插值拼用户输入）。
  // 两份是因为下面第二条查询 join 了 users，列名必须带表别名 —— 别改成对单一
  // 片段做字符串替换，那种写法会在加别名时静默失配。
  const ownerFilter = isAdmin ? "" : " AND owner_id = ?";
  const ownerFilterT = isAdmin ? "" : " AND t.owner_id = ?";
  const ownerArgs = isAdmin ? [] : [userId];

  const db = getDb();

  // 各状态: 条数 + 最老一条的创建时间 + 年龄（天，保留 1 位小数）。
  const rows = db
    .prepare(
      `
      SELECT
        status,
        COUNT(*) AS count,
        MIN(created_at) AS oldest_created_at,
        ROUND(julianday('now') - julianday(MIN(created_at)), 1) AS oldest_age_days
      FROM tasks
      WHERE deleted_at IS NULL${ownerFilter}
      GROUP BY status
    `
    )
    .all(...ownerArgs) as StatusRow[];

  const byStatus = new Map(rows.map((r) => [r.status, r]));

  // 积压部分: 按 BACKLOG_STATUSES 的顺序输出并对缺失状态补零。
  const backlog = BACKLOG_STATUSES.map((status) => {
    const r = byStatus.get(status);
    return {
      status,
      count: r?.count ?? 0,
      oldest_created_at: r?.oldest_created_at ?? null,
      oldest_age_days: r?.oldest_age_days ?? null,
    };
  });

  const backlogTotal = backlog.reduce((sum, b) => sum + b.count, 0);
  const oldestAgeDays = backlog.reduce<number | null>(
    (max, b) =>
      b.oldest_age_days === null ? max : max === null ? b.oldest_age_days : Math.max(max, b.oldest_age_days),
    null
  );

  // 全部状态（含终态）的原始 group by —— 与 sqlite3 的同名查询逐个可比。
  const allStatuses = rows
    .map((r) => ({ status: r.status, count: r.count }))
    .sort((a, b) => b.count - a.count);

  // reviewing 按 owner 分组: 「谁该去验收」。email 可能为 NULL（owner 已被删除
  // 或历史数据 owner_id 为空），保留 owner_id 让人还能追。
  const reviewingOwners = db
    .prepare(
      `
      SELECT t.owner_id AS owner_id, u.email AS email, COUNT(*) AS count
      FROM tasks t
      LEFT JOIN users u ON u.id = t.owner_id
      WHERE t.deleted_at IS NULL AND t.status = 'reviewing'${ownerFilterT}
      GROUP BY t.owner_id
      ORDER BY count DESC
    `
    )
    .all(...ownerArgs) as OwnerRow[];

  const reviewingTop = reviewingOwners.slice(0, TOP_OWNERS);
  const reviewingOther = reviewingOwners
    .slice(TOP_OWNERS)
    .reduce((sum, o) => sum + o.count, 0);

  return NextResponse.json({
    // 口径自述: 消费方（人或脚本）不必去猜这些数字含不含别人的任务
    scope,
    // 本响应只覆盖**本实例本库**。pulu 是另一个实例、另一个 DB，这里读不到。
    instance: process.env.ORCHESTRATOR_INSTANCE || null,
    generated_at: new Date().toISOString(),
    backlog_total: backlogTotal,
    oldest_age_days: oldestAgeDays,
    backlog,
    all_statuses: allStatuses,
    reviewing_by_owner: {
      top: reviewingTop,
      other_count: reviewingOther,
      distinct_owners: reviewingOwners.length,
    },
  });
}
