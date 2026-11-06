"use client";

// R122 / T1.2: 用量统计 tab —— 沿用原 src/app/stats/page.tsx 的主体 (228 行), 数据源仍是
// GET /api/stats. 本期不动 schema, 不动 API, 只迁位置.

import { useState, useEffect } from "react";

// Categorical palette (dataviz skill, light mode)
const SERIES_COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];

export type StatsData = {
  tasks: Record<string, number>;
  scheduler: { queue_size: number; running_count: number; max_concurrency: number };
  cost: {
    total: number;
    by_tag: Record<string, number>;
    by_model: Record<string, number>;
    by_day: Array<{ day: string; cost: number }>;
  };
};

function formatCost(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}

function compactCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return formatCost(v);
}

export default function UsageTab() {
  const [data, setData] = useState<StatsData | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setData)
      .catch(console.error);
  }, []);

  if (!data) {
    return (
      <div className="min-h-[200px] flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  const totalTasks = Object.values(data.tasks).reduce((a, b) => a + b, 0);
  const avgCost = totalTasks > 0 ? data.cost.total / totalTasks : 0;

  const today = new Date().toISOString().slice(0, 10);
  const todayCost = data.cost.by_day.find((d) => d.day === today)?.cost || 0;

  const last7: Array<{ day: string; cost: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = data.cost.by_day.find((r) => r.day === key);
    last7.push({ day: key, cost: found?.cost || 0 });
  }
  const maxDayCost = Math.max(...last7.map((d) => d.cost), 0.01);

  const tagEntries = Object.entries(data.cost.by_tag).sort((a, b) => b[1] - a[1]);
  const tagTotal = tagEntries.reduce((s, e) => s + e[1], 0) || 1;

  const modelEntries = Object.entries(data.cost.by_model).sort((a, b) => b[1] - a[1]);
  const maxModelCost = Math.max(...modelEntries.map((e) => e[1]), 0.01);

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="总花费" value={compactCost(data.cost.total)} />
        <StatCard label="总任务数" value={String(totalTasks)} />
        <StatCard label="平均每任务" value={formatCost(avgCost)} />
        <StatCard label="今日花费" value={formatCost(todayCost)} />
      </div>

      {/* Daily cost bar chart */}
      <div className="bg-white rounded-lg border p-5">
        <h2 className="font-medium text-gray-900 mb-4">近 7 天花费</h2>
        <div className="flex items-end gap-2 h-48">
          {last7.map((d) => {
            const pct = (d.cost / maxDayCost) * 100;
            const label = d.day.slice(5);
            return (
              <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full">
                {d.cost > 0 && (
                  <span className="text-xs text-gray-500 mb-1 font-variant-numeric-tabular-nums">
                    {formatCost(d.cost)}
                  </span>
                )}
                <div
                  className="w-full max-w-[24px] rounded-t min-h-[2px] transition-all"
                  style={{
                    height: `${Math.max(pct, 1)}%`,
                    backgroundColor: SERIES_COLORS[0],
                  }}
                />
                <span className="text-xs text-gray-400 mt-2">{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Two-column: tag pie + model bars */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg border p-5">
          <h2 className="font-medium text-gray-900 mb-4">按标签花费</h2>
          {tagEntries.length === 0 ? (
            <p className="text-sm text-gray-400">暂无数据</p>
          ) : (
            <div className="flex items-center gap-6">
              <div
                className="w-36 h-36 rounded-full shrink-0"
                style={{ background: buildConicGradient(tagEntries, tagTotal) }}
              />
              <div className="flex-1 space-y-2 min-w-0">
                {tagEntries.map(([tag, cost], i) => {
                  const pct = ((cost / tagTotal) * 100).toFixed(1);
                  return (
                    <div key={tag} className="flex items-center gap-2 text-sm">
                      <span
                        className="inline-block w-3 h-3 rounded-sm shrink-0"
                        style={{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }}
                      />
                      <span className="text-gray-700 truncate">{tag}</span>
                      <span className="text-gray-400 ml-auto shrink-0">
                        {formatCost(cost)} · {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border p-5">
          <h2 className="font-medium text-gray-900 mb-4">按模型花费</h2>
          {modelEntries.length === 0 ? (
            <p className="text-sm text-gray-400">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {modelEntries.map(([model, cost], i) => {
                const pct = (cost / maxModelCost) * 100;
                return (
                  <div key={model}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700">{model}</span>
                      <span className="text-gray-500">{formatCost(cost)}</span>
                    </div>
                    <div className="h-5 bg-gray-100 rounded">
                      <div
                        className="h-full rounded min-w-[2px]"
                        style={{
                          width: `${Math.max(pct, 1)}%`,
                          backgroundColor: SERIES_COLORS[(i + 1) % SERIES_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
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

function buildConicGradient(
  entries: Array<[string, number]>,
  total: number
): string {
  if (entries.length === 0) return "#e5e7eb";
  let cumPct = 0;
  const stops: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const pct = (entries[i][1] / total) * 100;
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    stops.push(`${color} ${cumPct}% ${cumPct + pct}%`);
    cumPct += pct;
  }
  return `conic-gradient(${stops.join(", ")})`;
}