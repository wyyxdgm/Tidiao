// R122 / T2.3.2: 需求聚合 tab —— 按 req:* 重名聚类 + task 数 / commit 数双轨.
// 数据源: GET /api/tasks?limit=200 取本账号 task 列表, 客户端 parseTags 拆 req:*.
// 关注点:
//   - 聚合逻辑拆到 src/lib/stats/requirements-aggregate.ts 纯函数, 这里只渲染.
//   - 双轨: task 数 (打了该 req 的 task 数) + commit 数 (这些 task 里 base_commit/head_commit
//     非空的去重 commit 计数). 二期 commit 关联 (task 与飞书行 R{N} 一对一) 在总方案 §4 T2.2.
//   - 渲染: 表格按 task 数降序, 显示 task/完成/失败/commit 数 + 花费. 重名聚合:
//     req:用户登录 与 req:用户登录 重名合并 (parseTags 已去重, 这里再做一次保险).
//   - 限制: limit=200 防大用户爆; 不显示的 task 数有提示.

"use client";

import { useEffect, useMemo, useState } from "react";
import { aggregateRequirements } from "@/lib/stats/requirements-aggregate";

type TaskRow = {
  id: string;
  status: string;
  title: string;
  cost_usd: number | null;
  tags: string | null;
  base_commit: string | null;
  head_commit: string | null;
};

function formatCost(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}

export default function RequirementsTab() {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/tasks?limit=200")
      .then((r) => r.json())
      .then((t) => setTasks(Array.isArray(t) ? t : []))
      .catch((e) => setErr(String(e)));
  }, []);

  const aggs = useMemo(() => (tasks ? aggregateRequirements(tasks) : []), [tasks]);

  if (err) {
    return <div className="text-sm text-red-600">加载失败：{err}</div>;
  }
  if (!tasks) {
    return (
      <div className="min-h-[200px] flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  const filtered = filter
    ? aggs.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()))
    : aggs;
  const totalTasks = aggs.reduce((s, a) => s + a.taskCount, 0);
  const totalCommits = aggs.reduce((s, a) => s + a.commitCount, 0);
  const totalCost = aggs.reduce((s, a) => s + a.costUsd, 0);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-medium text-gray-900">需求聚合（req:*）</h2>
            <p className="text-xs text-gray-500 mt-1">
              按 <code>req:*</code> 命名空间聚合（重名合并）。双轨 = task 数（打过该 req 的 task）+ commit 数（这些 task 的 head/base commit 去重）。
            </p>
          </div>
          <input
            type="text"
            placeholder="过滤需求名..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-sm border border-gray-300 rounded px-3 py-1.5 w-48 focus:outline-none focus:border-blue-400"
          />
        </div>

        {aggs.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">
            暂无 req:* 标签数据。给 task 打 <code>--tags req:R122</code> 后将出现在这里。
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <StatCard label="唯一需求数" value={String(aggs.length)} />
              <StatCard label="带 req 标签的 task" value={String(totalTasks)} />
              <StatCard label="关联 commit 数（去重）" value={String(totalCommits)} />
              <StatCard label="总花费" value={formatCost(totalCost)} />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b">
                    <th className="py-2 pr-3">需求名</th>
                    <th className="py-2 pr-3 text-right">task 数</th>
                    <th className="py-2 pr-3 text-right">完成</th>
                    <th className="py-2 pr-3 text-right">失败</th>
                    <th className="py-2 pr-3 text-right">commit 数</th>
                    <th className="py-2 pr-3 text-right">花费</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.name} className="border-b last:border-b-0 hover:bg-gray-50">
                      <td className="py-2 pr-3">
                        <code className="text-xs">req:{a.name}</code>
                      </td>
                      <td className="py-2 pr-3 text-right font-variant-numeric-tabular-nums">
                        {a.taskCount}
                      </td>
                      <td className="py-2 pr-3 text-right text-green-700 font-variant-numeric-tabular-nums">
                        {a.completed}
                      </td>
                      <td className="py-2 pr-3 text-right text-red-700 font-variant-numeric-tabular-nums">
                        {a.failed}
                      </td>
                      <td className="py-2 pr-3 text-right text-gray-600 font-variant-numeric-tabular-nums">
                        {a.commitCount}
                      </td>
                      <td className="py-2 pr-3 text-right text-gray-700 font-variant-numeric-tabular-nums">
                        {formatCost(a.costUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {filtered.length === 0 && filter && (
              <p className="text-sm text-gray-400 py-4 text-center">
                无匹配 "{filter}" 的需求。
              </p>
            )}
          </>
        )}
      </div>

      <p className="text-xs text-gray-400">
        提示：采样 {tasks.length} task (limit=200)。commit 数 = 这些 task 的 base/head commit 去重计数，未与飞书行 R{"{N}"} 关联（总方案 §4 T2.2 二期接入）。
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
