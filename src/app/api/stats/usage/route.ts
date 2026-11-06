// GET /api/stats/usage —— 按时间粒度聚合的用量统计（cost / 任务数 / 各模型用量）。
//
// 为什么另开端点而不改 /api/stats: 那个是 dashboard 的固定视图(7 天 cost + 调度器
// 队列), 巡检脚本在消费它的结构。这里是可选粒度的时间序列, 两者的形状和调用方
// 都不一样, 混在一起会让任一侧的改动都变成破坏性改动。
//
// 🔴 **口径（owner 参数）** —— admin 全局收口前的设计（D1-D8 已定案, 见
//   `docs/plans/usage-dual-scope.md`）。
//   owner 取值:
//     - 缺省 / 空字符串 = self(本账号, 任何人都能调, 等价于 mine);
//     - "all"            = 全平台(仅 admin);
//     - 其它字符串       = 视为 user_id(仅 admin; 用户不存在返 404)。
//   scope 自述字段会回给消费方("mine" | "all" | "owner"), 不让前端靠请求猜。
//   非 admin 传 owner=all 或 owner=<别人 id> 一律 403 "admin required" ——
//   错误文案保持不变, 前端按它分支。
//   当 owner=all 时, total.by_owner 多一张「按用户汇总」表(LEFT JOIN users 拿 email),
//   非 all 时该字段省略(单用户汇总没意义)。
//
// 时区 / COALESCE / 模型口径 等与 admin only 阶段完全一致 —— 收紧再放开口径,
// 与双口径改动无关, 不动。
//
// 参数:
//   granularity = hour | day | week | month | year   (缺省 day)
//   limit       = 桶数上限, 1..500                    (缺省按粒度给合理值)
//   owner       = self | all | <user_id>             (缺省 self)
//
// 🔴 时区: DB 里的 created_at 是 **UTC** 字符串(SQLite datetime('now') 无时区标记),
//   而人看的是 CST。所以分桶前一律 `datetime(created_at, '+8 hours')` —— 不换算的话
//   「今天」的边界会整体偏 8 小时, 早上 8 点前的任务全被算进前一天。这是本项目
//   踩过的坑, 别在这里图省事直接 DATE(created_at)。
//
// 关注点:
//  - 只统计 deleted_at IS NULL(软删的任务不该出现在账单里)。
//  - cost_usd 为 NULL 一律当 0 —— DB 里确实有大量 NULL(pulu 8-08 那天 144 个任务
//    cost 全 0, 是**真实数据**不是 bug), 用 COALESCE 而不是 WHERE 过滤掉, 否则
//    任务数会跟着 cost 一起消失。
//  - 模型口径 = COALESCE(resolved_model, model, '(unknown)'): resolved_model 是
//    实际跑的模型(继承链解析后), model 只是任务上写的意图, 后者可能为 NULL。
//  - ⚠️ **没有 input/output token 分列** —— tasks 表只有 context_tokens 一列。
//    所以「各模型用量」= 任务数 + cost 之和 + context_tokens 之和, 不提供 token
//    进出明细(要提供得先加采集, 见交付报告)。
//  - SQL owner 条件**三处必须同步**: scoped CTE(分桶) / totalRow(全量合计) /
//    totalByModel(全量按模型); 漏一处 = 桶和总量口径对不上。by_owner 是 owner=all
//    专属, 不参与 SQL owner 过滤(它本身就是按 owner 分组的, 多加一层过滤会变 0)。

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getUserById } from "@/lib/db/users";

const GRANULARITIES = ["hour", "day", "week", "month", "year"] as const;
type Granularity = (typeof GRANULARITIES)[number];

// 每种粒度的桶标签 SQL。基准表达式统一是 LOCAL = created_at + 8h（见文件头时区说明）。
// week: SQLite 的 %W 是「周一为周首」的周序号, 配合 %Y 足够唯一；用 strftime 而不是
//   自己算日期偏移, 免得跨年时算错。
const BUCKET_SQL: Record<Granularity, string> = {
  hour: "strftime('%Y-%m-%d %H:00', datetime(created_at, '+8 hours'))",
  day: "strftime('%Y-%m-%d', datetime(created_at, '+8 hours'))",
  week: "strftime('%Y-W%W', datetime(created_at, '+8 hours'))",
  month: "strftime('%Y-%m', datetime(created_at, '+8 hours'))",
  year: "strftime('%Y', datetime(created_at, '+8 hours'))",
};

// 缺省桶数: 大致覆盖「一屏能看完的近期区间」。hour 给 24(一天), day 给 30(一个月),
// week 12(一季), month 12(一年), year 5。
const DEFAULT_LIMIT: Record<Granularity, number> = {
  hour: 24,
  day: 30,
  week: 12,
  month: 12,
  year: 5,
};

const MAX_LIMIT = 500;

interface ModelRow {
  bucket: string;
  model: string;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
}

interface OwnerBucketRow {
  owner_id: string | null;
  email: string | null;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
}

type Scope = "mine" | "all" | "owner";

// 解析 owner 参数, 返回 (scope, owner_id 过滤值, ownerArgs) 三元组。
// - 非 admin + owner=all / owner=<别人 id>     → 抛 "admin required" (403)
// - 非 admin + 缺省 / "self" / owner=<自己 id> → scope=mine, 过滤本账号
// - admin + owner=all                          → scope=all, 无过滤
// - admin + owner=空 / 缺省                    → scope=mine, 过滤本账号(不该多按用户切)
// - admin + owner=<user_id>(用户不存在)        → 抛 "user not found" (404)
// - admin + owner=<user_id>(存在)              → scope=owner, 过滤该用户
//
// 「owner=<自己 id>」这条等价缺省, 是 D2 显式允许的(免得前端在「显式 self」与
// 「传自己 id」之间写两套分支); 别的 id 不享受这个待遇 —— 「我知道 admin 的
// user_id」不能绕开 admin role 检查。
//
// ownerFilter / ownerArgs 拼进 SQL 的只有这两个固定片段, 参数值仍走占位符（不
// 做字符串插值拼用户输入）。两个片段是因为 by_owner 用 owner_id AS owner_id,
// 其它查询都是裸的 owner_id —— 显式两份比字符串替换安全(避免加别名时静默失配)。
function resolveOwner(
  callerId: string,
  isAdmin: boolean,
  ownerParam: string | null
): { scope: Scope; ownerFilter: string; ownerArgs: string[] } {
  const raw = (ownerParam ?? "").trim();

  // 缺省 / "self" → 永远按本账号(mine), 任何人都能调
  if (raw === "" || raw === "self") {
    return { scope: "mine", ownerFilter: " AND owner_id = ?", ownerArgs: [callerId] };
  }

  // 「owner=<自己 id>」也对非 admin 放行 —— 等价缺省, 避免前端写两套分支。
  // 别的人 id 一律走下面的 admin 闸门。
  if (raw === callerId) {
    return { scope: "mine", ownerFilter: " AND owner_id = ?", ownerArgs: [callerId] };
  }

  // "all" → 全平台, 仅 admin
  if (raw === "all") {
    if (!isAdmin) throw new HttpError(403, "admin required");
    return { scope: "all", ownerFilter: "", ownerArgs: [] };
  }

  // 其它 → 视为 user_id, 仅 admin
  if (!isAdmin) throw new HttpError(403, "admin required");
  const target = getUserById(raw);
  if (!target) throw new HttpError(404, "user not found");
  return { scope: "owner", ownerFilter: " AND owner_id = ?", ownerArgs: [target.id] };
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export async function GET(request: NextRequest) {
  const callerId = request.headers.get("x-user-id");
  if (!callerId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = request.headers.get("x-user-role") === "admin";

  const sp = request.nextUrl.searchParams;
  const gRaw = (sp.get("granularity") || "day").toLowerCase();
  if (!GRANULARITIES.includes(gRaw as Granularity)) {
    return NextResponse.json(
      { error: `granularity 必须是 ${GRANULARITIES.join(" | ")}` },
      { status: 400 }
    );
  }
  const granularity = gRaw as Granularity;

  const limitRaw = sp.get("limit");
  let limit = DEFAULT_LIMIT[granularity];
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return NextResponse.json(
        { error: `limit 必须是 1-${MAX_LIMIT} 的整数` },
        { status: 400 }
      );
    }
    limit = n;
  }

  let owner;
  try {
    owner = resolveOwner(callerId, isAdmin, sp.get("owner"));
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const db = getDb();
  const bucket = BUCKET_SQL[granularity];

  // 一次查出「桶 × 模型」的明细, 桶级汇总在 JS 里累加 —— 比跑两条 SQL 再对齐
  // 更不容易出现「两个查询的过滤条件不一致导致总数对不上」。
  // 桶的选取: 先按桶排序取最近 limit 个桶(子查询), 再取这些桶里的模型明细,
  // 否则 LIMIT 会截在「桶×模型」的行数上, 最后一个桶的模型会被切掉一半。
  // ownerArgs 顺序: 1) scoped CTE 的 owner_id 占位符(可能没有), 2) LIMIT 占位符。
  const rows = db
    .prepare(
      `
      WITH scoped AS (
        SELECT
          ${bucket} AS bucket,
          COALESCE(resolved_model, model, '(unknown)') AS model,
          COALESCE(cost_usd, 0) AS cost_usd,
          COALESCE(context_tokens, 0) AS context_tokens
        FROM tasks
        WHERE deleted_at IS NULL${owner.ownerFilter} AND created_at IS NOT NULL
      ),
      recent AS (
        SELECT DISTINCT bucket FROM scoped ORDER BY bucket DESC LIMIT ?
      )
      SELECT
        s.bucket        AS bucket,
        s.model         AS model,
        COUNT(*)        AS task_count,
        SUM(s.cost_usd) AS cost_usd,
        SUM(s.context_tokens) AS context_tokens
      FROM scoped s
      JOIN recent r ON r.bucket = s.bucket
      GROUP BY s.bucket, s.model
      ORDER BY s.bucket DESC, cost_usd DESC
    `
    )
    .all(...owner.ownerArgs, limit) as ModelRow[];

  // 按桶归组（rows 已按 bucket DESC 排好, 直接顺序聚合即可）
  const buckets: Array<{
    bucket: string;
    task_count: number;
    cost_usd: number;
    context_tokens: number;
    by_model: Array<{ model: string; task_count: number; cost_usd: number; context_tokens: number }>;
  }> = [];
  const byBucket = new Map<string, (typeof buckets)[number]>();
  for (const r of rows) {
    let b = byBucket.get(r.bucket);
    if (!b) {
      b = { bucket: r.bucket, task_count: 0, cost_usd: 0, context_tokens: 0, by_model: [] };
      byBucket.set(b.bucket, b);
      buckets.push(b);
    }
    b.task_count += r.task_count;
    b.cost_usd += r.cost_usd;
    b.context_tokens += r.context_tokens;
    b.by_model.push({
      model: r.model,
      task_count: r.task_count,
      cost_usd: r.cost_usd,
      context_tokens: r.context_tokens,
    });
  }

  // total = **全量**(不受 limit 截断影响)的总计 + 各模型总量。
  // 关注点: 故意不用上面 buckets 累加 —— 那只是最近 limit 个桶, 当成「总量」
  //   会让人以为平台一共只花了这么多钱。
  const totalRow = db
    .prepare(
      `
      SELECT
        COUNT(*) AS task_count,
        COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
        COALESCE(SUM(COALESCE(context_tokens, 0)), 0) AS context_tokens
      FROM tasks WHERE deleted_at IS NULL${owner.ownerFilter}
    `
    )
    .get(...owner.ownerArgs) as { task_count: number; cost_usd: number; context_tokens: number };

  const totalByModel = db
    .prepare(
      `
      SELECT
        COALESCE(resolved_model, model, '(unknown)') AS model,
        COUNT(*) AS task_count,
        COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
        COALESCE(SUM(COALESCE(context_tokens, 0)), 0) AS context_tokens
      FROM tasks WHERE deleted_at IS NULL${owner.ownerFilter}
      GROUP BY model
      ORDER BY cost_usd DESC
    `
    )
    .all(...owner.ownerArgs) as Array<{ model: string; task_count: number; cost_usd: number; context_tokens: number }>;

  const total: {
    task_count: number;
    cost_usd: number;
    context_tokens: number;
    by_model: typeof totalByModel;
    by_owner?: OwnerBucketRow[];
  } = { ...totalRow, by_model: totalByModel };

  // owner=all 时多一张按用户汇总表(LEFT JOIN users 拿 email, owner_id 可能为 NULL
  // —— 历史脏数据或被删用户的任务)。其它口径省略该字段, 单用户汇总没价值。
  if (owner.scope === "all") {
    const byOwnerRows = db
      .prepare(
        `
        SELECT
          owner_id AS owner_id,
          u.email  AS email,
          COUNT(*) AS task_count,
          COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
          COALESCE(SUM(COALESCE(context_tokens, 0)), 0) AS context_tokens
        FROM tasks t
        LEFT JOIN users u ON u.id = t.owner_id
        WHERE t.deleted_at IS NULL
        GROUP BY t.owner_id
        ORDER BY cost_usd DESC
      `
      )
      .all() as OwnerBucketRow[];
    total.by_owner = byOwnerRows;
  }

  return NextResponse.json({
    granularity,
    limit,
    // 分桶基准时区, 让消费方(和排查的人)不用去猜标签是 UTC 还是本地时间
    timezone: "UTC+8",
    // 口径自述: 跟 owner= 参数一一对应 —— 让消费方不必去猜这些数字含不含别人的任务
    scope: owner.scope,
    buckets,
    total,
  });
}
