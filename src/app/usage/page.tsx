"use client";

// 用量统计页 —— 按 小时/天/周/月/年 看 cost + 任务数 + 各模型用量。
//
// 与 /stats(花费统计)的分工: /stats 是固定视图(近 7 天 + 饼图), 这里是可选粒度的
// 时间序列表格, 数据来自 GET /api/stats/usage(与 /api/stats 各自独立)。
//
// 关注点:
//  - 桶标签由后端按 **UTC+8** 生成(见 route.ts 时区说明), 前端直接显示,
//    **不要再 new Date(bucket) 转一次** —— 那会按浏览器时区二次偏移。
//  - context_tokens 是「上下文规模」而不是「消耗的 token 总量」, 文案上不要写成
//    「token 用量」误导人(tasks 表没有 input/output 分列)。
//  - 口径（owner 参数）—— 双口径设计:
//      普通用户: 只能看自己(无切换器, 数据永远 scope=mine);
//      admin:     顶部一个 Select, 三档 —— 全部用户(scope=all) / 仅我的(scope=mine)
//                 / 仅某个用户(scope=owner)。选项的「具体用户」列表来自上次响应里
//                 total.by_owner(由后端在 scope=all 时附带给出), 避免再发一个用户
//                 列表 API。
//    scope 字段由后端自述; 前端把它的语义显示成徽标, 不靠请求猜。

import { useState, useEffect, Fragment } from "react";
import Link from "next/link";
import Select from "@/components/Select";

type ModelUsage = {
  model: string;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
};

type OwnerUsage = {
  owner_id: string | null;
  email: string | null;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
};

type Bucket = {
  bucket: string;
  task_count: number;
  cost_usd: number;
  context_tokens: number;
  by_model: ModelUsage[];
};

type UsageData = {
  granularity: string;
  limit: number;
  timezone: string;
  scope: "mine" | "all" | "owner";
  buckets: Bucket[];
  total: {
    task_count: number;
    cost_usd: number;
    context_tokens: number;
    by_model: ModelUsage[];
    by_owner?: OwnerUsage[];
  };
};

type BacklogRow = {
  status: string;
  count: number;
  oldest_created_at: string | null;
  oldest_age_days: number | null;
};

type BacklogData = {
  scope: "all" | "mine";
  instance: string | null;
  generated_at: string;
  backlog_total: number;
  oldest_age_days: number | null;
  backlog: BacklogRow[];
  all_statuses: Array<{ status: string; count: number }>;
  reviewing_by_owner: {
    top: Array<{ owner_id: string | null; email: string | null; count: number }>;
    other_count: number;
    distinct_owners: number;
  };
};

type Me = { id: string; email: string; role: string };

const GRANULARITY_OPTIONS = [
  { value: "hour", label: "按小时" },
  { value: "day", label: "按天" },
  { value: "week", label: "按周" },
  { value: "month", label: "按月" },
  { value: "year", label: "按年" },
];

// owner Select 选项: 缺省项「全部用户」/「仅我的」是固定的, 「仅某用户」从
// total.by_owner 里动态组装(admin 切到 scope=all 拿一次就够, 不再额外发请求)。
//
// 选项 value 与传给 API 的 owner 参数一一对应:
//   "all"  → 后端 scope=all
//   "self" → 后端 scope=mine
//   "<id>" → 后端 scope=owner
type OwnerOption = { value: string; label: string };

function formatCost(v: number): string {
  if (v === 0) return "$0";
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export default function UsagePage() {
  const [granularity, setGranularity] = useState("day");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 积压概览独立取数: 它与粒度无关（是「此刻的存量」不是时间序列），所以不放进
  // 上面那个 useEffect 的依赖里, 免得每次切粒度都白拉一次。
  const [backlog, setBacklog] = useState<BacklogData | null>(null);
  const [backlogError, setBacklogError] = useState<string | null>(null);

  // 当前用户身份 + admin 判定
  const [me, setMe] = useState<Me | null>(null);
  // admin 的口径切换器: "all" | "self" | "<user_id>"
  const [ownerPick, setOwnerPick] = useState<string>("all");
  // 上次 scope=all 响应里携带的「按用户汇总」, 用于组装 owner Select 的「仅某用户」档
  const [knownOwners, setKnownOwners] = useState<OwnerUsage[]>([]);

  useEffect(() => {
    fetch("/api/stats/backlog")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j) => setBacklog(j))
      .catch((e) => setBacklogError(e.message));
  }, []);

  useEffect(() => {
    fetch("/api/user/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        if (d) {
          setMe(d);
          // 普通用户永远只能 self, 不暴露切换器; admin 缺省切到「全部用户」
          setOwnerPick(d.role === "admin" ? "all" : "self");
        }
      })
      .catch(() => {});
  }, []);

  // 拉用量: owner 跟着 me/ownerPick/granularity 三个变量走。
  // 非 admin 时 owner 强制 "self", 即便有人动了 state 也兜底。
  useEffect(() => {
    setLoading(true);
    setError(null);
    const ownerQ = me?.role === "admin" ? `&owner=${encodeURIComponent(ownerPick)}` : "&owner=self";
    fetch(`/api/stats/usage?granularity=${granularity}${ownerQ}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j: UsageData) => {
        setData(j);
        // 把这次拿到的 by_owner 缓存成下次 owner Select 的「具体用户」列表,
        // 但只在确实拿到了有效数据时更新 —— 避免空响应把已知的清空。
        if (Array.isArray(j.total?.by_owner)) {
          setKnownOwners(j.total.by_owner);
        }
      })
      .catch((e) => {
        if (e.message === "admin required") {
          setError("admin_required");
        } else {
          setError(e.message);
        }
      })
      .finally(() => setLoading(false));
  }, [granularity, ownerPick, me]);

  const toggle = (bucket: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  };

  const maxCost = Math.max(...(data?.buckets.map((b) => b.cost_usd) ?? [0]), 0.0001);

  // admin 的 Select 选项组装。knownOwners 是上次 scope=all 拿到的, 是用户「曾经有过
  // 任务」的子集 —— 缺任务的用户即便存在也不会出现, 这是为了「避免诱导切到一个零
  // 数据的空视图」。需要完整名单再单独发请求, 当前不需要。
  const ownerOptions: OwnerOption[] =
    me?.role === "admin"
      ? [
          { value: "all", label: "全部用户" },
          { value: "self", label: "仅我的" },
          ...knownOwners.map((o) => ({
            value: o.owner_id ?? "",
            label: o.email ?? `(已删除用户 ${o.owner_id ?? "unknown"})`,
          })),
        ]
      : [];

  return (
    // 🆕 飞书 R139 第二批: 右滚修复 — 同 schedules/runners 套路.
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-gray-600 hover:text-gray-900 text-sm">
            ← 返回
          </Link>
          <Link href="/stats" className="text-gray-600 hover:text-gray-900 text-sm">
            花费统计
          </Link>
        </div>
        <h1 className="text-xl font-semibold mt-2">用量统计</h1>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-5xl w-full mx-auto px-6 py-6 space-y-6">
        <BacklogPanel data={backlog} error={backlogError} />

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-gray-600">时间粒度</span>
          <Select
            value={granularity}
            onChange={setGranularity}
            options={GRANULARITY_OPTIONS}
            className="w-32"
          />
          {data && (
            <span className="text-xs text-gray-400">
              分桶时区 {data.timezone} · 最近 {data.limit} 个区间
            </span>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
            {error === "admin_required"
              ? "权限不足：用量统计仅管理员可见。请联系管理员或返回首页。"
              : `加载失败：${error}`}
          </div>
        )}

        {loading && !data && <div className="text-gray-400 text-sm">加载中...</div>}

        {data && (
          <>
            {/* 总量卡片（全量，不受粒度/limit 影响） */}
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="总花费（全部任务）" value={formatCost(data.total.cost_usd)} />
              <StatCard label="总任务数" value={String(data.total.task_count)} />
              <StatCard label="上下文 token 合计" value={formatTokens(data.total.context_tokens)} />
            </div>

            {/* 分桶表格 */}
            <div className="bg-white rounded-lg border overflow-hidden">
              <div className="px-5 py-3 border-b">
                <h2 className="font-medium text-gray-900">
                  分区间用量
                  <ScopeBadge scope={data.scope} ownerEmail={pickOwnerEmail(ownerPick, knownOwners)} />
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  点某一行展开该区间的各模型明细
                </p>
              </div>
              {data.buckets.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-400">
                  这个粒度下还没有任务数据
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium">区间</th>
                      <th className="text-right px-3 py-2 font-medium">任务数</th>
                      <th className="text-right px-3 py-2 font-medium">花费</th>
                      <th className="text-right px-3 py-2 font-medium">上下文 token</th>
                      <th className="text-left px-3 py-2 font-medium w-1/4">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((b) => {
                      const isOpen = expanded.has(b.bucket);
                      return (
                        // 一行展开成「汇总行 + N 条模型明细行」, 用 Fragment 包起来
                        // 才能保持 <tbody> 的直接子元素都是 <tr>。key 挂在 Fragment 上。
                        <Fragment key={b.bucket}>
                          <tr
                            onClick={() => toggle(b.bucket)}
                            className="border-t hover:bg-gray-50 cursor-pointer"
                          >
                            <td className="px-5 py-2 text-gray-800">
                              <span className="text-gray-400 mr-1 inline-block w-3">
                                {isOpen ? "▾" : "▸"}
                              </span>
                              {b.bucket}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-700">{b.task_count}</td>
                            <td className="px-3 py-2 text-right text-gray-900 font-medium">
                              {formatCost(b.cost_usd)}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-500">
                              {formatTokens(b.context_tokens)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="h-2 bg-gray-100 rounded">
                                <div
                                  className="h-full rounded min-w-[2px] bg-blue-500"
                                  style={{ width: `${Math.max((b.cost_usd / maxCost) * 100, 1)}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                          {isOpen &&
                            b.by_model.map((m) => (
                              <tr key={`${b.bucket}-${m.model}`} className="border-t bg-gray-50/60">
                                <td className="px-5 py-1.5 pl-12 text-xs text-gray-600">
                                  {m.model}
                                </td>
                                <td className="px-3 py-1.5 text-right text-xs text-gray-600">
                                  {m.task_count}
                                </td>
                                <td className="px-3 py-1.5 text-right text-xs text-gray-700">
                                  {formatCost(m.cost_usd)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-xs text-gray-500">
                                  {formatTokens(m.context_tokens)}
                                </td>
                                <td />
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* 各模型总量（全量） */}
            <div className="bg-white rounded-lg border overflow-hidden">
              <div className="px-5 py-3 border-b">
                <h2 className="font-medium text-gray-900">
                  各模型总量（全部任务）
                  <ScopeBadge scope={data.scope} ownerEmail={pickOwnerEmail(ownerPick, knownOwners)} />
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  模型口径 = resolved_model（实际跑的）回落 model。
                  ⚠️ 平台目前只记录 cost 与上下文规模，没有 input/output token 分列。
                </p>
              </div>
              {data.total.by_model.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-400">暂无数据</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium">模型</th>
                      <th className="text-right px-3 py-2 font-medium">任务数</th>
                      <th className="text-right px-3 py-2 font-medium">花费</th>
                      <th className="text-right px-5 py-2 font-medium">上下文 token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.total.by_model.map((m) => (
                      <tr key={m.model} className="border-t">
                        <td className="px-5 py-2 text-gray-800">{m.model}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{m.task_count}</td>
                        <td className="px-3 py-2 text-right text-gray-900 font-medium">
                          {formatCost(m.cost_usd)}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-500">
                          {formatTokens(m.context_tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* admin + scope=all 才出「按用户汇总」; 其它口径省去该区块 */}
            {me?.role === "admin" && ownerPick === "all" && Array.isArray(data.total.by_owner) && (
              <div className="bg-white rounded-lg border overflow-hidden">
                <div className="px-5 py-3 border-b">
                  <h2 className="font-medium text-gray-900">
                    按用户汇总
                    <ScopeBadge scope={data.scope} ownerEmail={null} />
                  </h2>
                  <p className="text-xs text-gray-500 mt-1">
                    全平台所有用户的累计花费；点击「仅该用户」可在上方切换器收窄到单个账号。
                  </p>
                </div>
                {data.total.by_owner.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-gray-400">暂无数据</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-500 text-xs">
                      <tr>
                        <th className="text-left px-5 py-2 font-medium">用户</th>
                        <th className="text-right px-3 py-2 font-medium">任务数</th>
                        <th className="text-right px-3 py-2 font-medium">花费</th>
                        <th className="text-right px-5 py-2 font-medium">上下文 token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.total.by_owner.map((o) => (
                        <tr key={o.owner_id ?? "unknown"} className="border-t">
                          <td className="px-5 py-2 text-gray-800">
                            {o.email ?? `(已删除用户 ${o.owner_id ?? "unknown"})`}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-700">{o.task_count}</td>
                          <td className="px-3 py-2 text-right text-gray-900 font-medium">
                            {formatCost(o.cost_usd)}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-500">
                            {formatTokens(o.context_tokens)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

// 口径徽标 —— 与积压面板的同款样式保持视觉一致。
//
// 关注点: 这是**自述**字段的可视化, 不是装饰; 跟 backlog 那块同源 ——
//   缺少这块徽标, 切到「仅某用户」时人可能误以为显示的还是全平台数据。
function ScopeBadge({ scope, ownerEmail }: { scope: "mine" | "all" | "owner"; ownerEmail: string | null }) {
  let label: string;
  let cls: string;
  if (scope === "all") {
    label = "全部用户";
    cls = "bg-purple-100 text-purple-700";
  } else if (scope === "owner") {
    label = ownerEmail ? `仅 ${ownerEmail}` : "仅该用户";
    cls = "bg-blue-100 text-blue-700";
  } else {
    label = "仅我的";
    cls = "bg-gray-100 text-gray-600";
  }
  return (
    <span className={`ml-2 text-xs px-1.5 py-0.5 rounded align-middle ${cls}`}>{label}</span>
  );
}

// 从 knownOwners 里反查当前 ownerPick 对应的 email, 给徽标显示用。
// ownerPick 不是 user_id 时返回 null, 徽标降级到「仅我的 / 全部用户」。
function pickOwnerEmail(ownerPick: string, known: OwnerUsage[]): string | null {
  if (ownerPick === "all" || ownerPick === "self") return null;
  const row = known.find((o) => o.owner_id === ownerPick);
  return row?.email ?? null;
}

// 状态中文名 + 配色。key 与后端 BACKLOG_STATUSES 一一对应。
const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "待启动", cls: "text-gray-700" },
  queued: { label: "排队中", cls: "text-blue-700" },
  running: { label: "运行中", cls: "text-sky-700" },
  paused: { label: "已暂停", cls: "text-amber-700" },
  reviewing: { label: "待验收", cls: "text-purple-700" },
  // ⚠️ 历史兼容. 🆕 2026-09-15 R后续 damo: UI 改「等待中」.
  rejected: { label: "等待中", cls: "text-orange-600" },
  failed: { label: "失败", cls: "text-red-700" },
};

// 积压概览面板。
//
// 🔴 口径必须显式标注: scope="all" 是跨所有 owner 的全局数字, "mine" 只有自己的。
//   这条需求（board-R24）的起因就是 per-owner 的 /api/stats 把 failed 报成 1（实际
//   13）、pending 报成 0（实际 6），让人误以为零积压。所以「全部/我的」这个标签
//   不是装饰, 去掉它这个面板就重新变得会骗人。
// 关注点: 只显示本实例本库的数字。pulu 是另一个库, 读不到 —— 面板底部明写这点,
//   免得有人拿这里的数字当「全平台」汇总。
function BacklogPanel({ data, error }: { data: BacklogData | null; error: string | null }) {
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
        积压概览加载失败：{error}
      </div>
    );
  }
  if (!data) {
    return <div className="text-gray-400 text-sm">积压概览加载中...</div>;
  }

  const isAll = data.scope === "all";
  const reviewing = data.reviewing_by_owner;

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <div className="px-5 py-3 border-b flex items-baseline justify-between gap-3">
        <div>
          <h2 className="font-medium text-gray-900">
            积压概览
            <span
              className={`ml-2 text-xs px-1.5 py-0.5 rounded align-middle font-medium border ${
                isAll
                  ? "bg-purple-100 text-purple-700 border-purple-300"
                  : "bg-gray-100 text-gray-600 border-gray-200"
              }`}
            >
              {isAll ? "全部用户" : "仅我的"}
            </span>
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            未走到终态的任务条数（终态 = 完成 / 已取消，不计入）
            {!isAll && " · 你不是管理员，看不到其他用户的任务"}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-semibold text-gray-900">{data.backlog_total}</div>
          <div className="text-xs text-gray-500">
            {data.oldest_age_days === null ? "无积压" : `最老 ${data.oldest_age_days} 天`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 divide-x divide-y lg:divide-y-0">
        {data.backlog.map((b) => {
          const meta = STATUS_META[b.status] ?? { label: b.status, cls: "text-gray-700" };
          return (
            <div key={b.status} className="px-3 py-3">
              <div className="text-xs text-gray-500">{meta.label}</div>
              <div className={`text-xl font-semibold ${b.count > 0 ? meta.cls : "text-gray-300"}`}>
                {b.count}
              </div>
              <div className="text-[11px] text-gray-400 mt-0.5 h-4">
                {b.oldest_age_days === null ? "" : `最老 ${b.oldest_age_days}d`}
              </div>
            </div>
          );
        })}
      </div>

      {reviewing.top.length > 0 && (
        <div className="px-5 py-3 border-t">
          <div className="text-xs text-gray-500 mb-2">
            待验收 按用户（谁该去验收）· 共 {reviewing.distinct_owners} 个用户
          </div>
          <div className="space-y-1">
            {reviewing.top.map((o) => (
              <div key={o.owner_id ?? "unknown"} className="flex items-center gap-3 text-sm">
                <span className="text-gray-700 truncate">
                  {o.email ?? `(已删除用户 ${o.owner_id ?? "unknown"})`}
                </span>
                <span className="font-medium text-purple-700">{o.count}</span>
              </div>
            ))}
            {reviewing.other_count > 0 && (
              <div className="text-xs text-gray-400">其余用户合计 {reviewing.other_count}</div>
            )}
          </div>
        </div>
      )}

      <div className="px-5 py-2 border-t bg-gray-50 text-[11px] text-gray-500">
        仅本实例本库的数字{data.instance ? `（${data.instance}）` : ""}；
        其他实例（如 pulu）是独立数据库，此处读不到。
      </div>
    </div>
  );
}