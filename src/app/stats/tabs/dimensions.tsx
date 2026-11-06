// R122 / T2.3.1: 维度分布 tab —— 按 dim:* 标签聚合, 渲染成本/任务分布.
// 数据源: GET /api/stats 返回 cost.by_tag (key=完整标签, value=USD),
//         + GET /api/tasks?limit=200 取本账号 task 列表做"任务数 / 维度"分布.
// 关注点:
//   - 聚合逻辑拆到 src/lib/stats/dimensions-aggregate.ts 纯函数, 这里只渲染.
//   - 任务列表只取本账号可见, limit=200 防大用户爆; 超出有视觉提示.
//   - 已知 4 个 canonical 维度 (backend/frontend/infra/沟通) 加粗显示, 其他归 "其他".

"use client";

import { useEffect, useState } from "react";
import { aggregateDimensions } from "@/lib/stats/dimensions-aggregate";
import type { StatsData } from "./usage";

type TaskRow = {
  id: string;
  status: string;
  cost_usd: number | null;
  tags: string | null;
};

function formatCost(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}

export default function DimensionsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/tasks?limit=200").then((r) => r.json()),
    ])
      .then(([s, t]) => {
        setStats(s);
        setTasks(Array.isArray(t) ? t : []);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return <div className="text-sm text-red-600">加载失败：{err}</div>;
  }
  if (!stats || !tasks) {
    return (
      <div className="min-h-[200px] flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  const dims = aggregateDimensions(stats.cost.by_tag, tasks);
  const maxCost = Math.max(...dims.map((d) => d.costUsd), 0.01);
  const maxCount = Math.max(...dims.map((d) => d.taskCount), 1);
  const totalCost = dims.reduce((s, d) => s + d.costUsd, 0);
  const totalTaggedTasks = dims.reduce((s, d) => s + d.taskCount, 0);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border p-5">
        <h2 className="font-medium text-gray-900 mb-2">维度分布（dim:*）</h2>
        <p className="text-xs text-gray-500 mb-4">
          按 <code>dim:*</code> 命名空间聚合（backend / frontend / infra / 沟通）。一个 task 可同时打多个维度，按出现次数累加。
        </p>

        {dims.length === 0 || (totalCost === 0 && totalTaggedTasks === 0) ? (
          <p className="text-sm text-gray-400">
            暂无 dim:* 标签数据。给 task 打 <code>--tags dim:backend</code> 后将出现在这里。
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <StatCard label="总花费 (dim:*)" value={formatCost(totalCost)} />
              <StatCard label="带 dim 标签的 task" value={String(totalTaggedTasks)} />
              <StatCard label="唯一 dim 维度数" value={String(dims.filter((d) => d.taskCount > 0).length)} />
              <StatCard label="采样 task 数" value={`${tasks.length} (limit=200)`} />
            </div>

            <div className="space-y-3">
              {dims.map((d) => {
                const costPct = (d.costUsd / maxCost) * 100;
                const countPct = (d.taskCount / maxCount) * 100;
                return (
                  <div key={d.name} className="">
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-xs mr-2 ${
                            d.isCanonical
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {d.isCanonical ? "canonical" : "其他"}
                        </span>
                        <code>dim:{d.name}</code>
                      </span>
                      <span className="text-gray-500 text-xs">
                        {d.taskCount} task · {formatCost(d.costUsd)}
                      </span>
                    </div>
                    <div className="relative h-5 bg-gray-100 rounded">
                      <div
                        className="absolute inset-y-0 left-0 rounded min-w-[2px] bg-blue-500"
                        style={{ width: `${Math.max(costPct, 1)}%` }}
                        title={`花费 ${formatCost(d.costUsd)}`}
                      />
                      <div
                        className="absolute inset-y-0 left-0 rounded min-w-[2px] bg-blue-300 opacity-60"
                        style={{ width: `${Math.max(countPct, 1)}%` }}
                        title={`任务数 ${d.taskCount}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-gray-400 mt-4">
              深色 = 花费占比 · 浅色 = 任务数占比。任务数可能因 limit=200 截断，超过部分未计入。
            </p>
          </>
        )}
      </div>

      <p className="text-xs text-gray-400">
        提示：本账号共 {tasks.length} 个采样 task，其中至少 {totalTaggedTasks} 个打了 dim:* 标签。
      </p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded border p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value}</div>
    </div>
  );
}
