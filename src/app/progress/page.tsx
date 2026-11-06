"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { parseDbTime } from "@/lib/datetime";

type Task = {
  id: string;
  title: string;
  status: string;
  cost_usd: number | null;
  started_at: string | null;
  completed_at: string | null;
  model: string | null;
  created_at: string;
};

type Scheduler = {
  queue_size: number;
  running_count: number;
  max_concurrency: number;
  running_tasks?: Array<{ id: string; title: string }>;
  queue_tasks?: Array<{ id: string; title: string }>;
};

type Stats = {
  tasks?: Record<string, number>;
  scheduler?: Scheduler;
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  reviewing: "待审核",
  completed: "已完成",
  failed: "失败",
  // ⚠️ 历史兼容 (单人系统前遗留). 🆕 2026-09-15 R后续 damo: UI 改「等待中」.
  rejected: "等待中",
  cancelled: "已取消",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-300",
  queued: "bg-blue-100 text-blue-700 border-blue-300",
  running: "bg-sky-100 text-sky-700 border-sky-300",
  paused: "bg-yellow-100 text-yellow-700 border-yellow-300",
  reviewing: "bg-purple-100 text-purple-700 border-purple-300",
  completed: "bg-emerald-100 text-emerald-700 border-emerald-300",
  failed: "bg-red-100 text-red-700 border-red-300",
  // ⚠️ 历史兼容 (单人系统前遗留). 保持橙色系, 视觉上跟「等待中」语义呼应.
  rejected: "bg-orange-100 text-orange-700 border-orange-300",
  cancelled: "bg-gray-100 text-gray-500 border-gray-300",
};

function formatDuration(startMs: number, endMs?: number): string {
  const end = endMs ?? Date.now();
  const ms = end - startMs;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function ProgressBar({ value, max, color = "bg-blue-500" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
      <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function ProgressPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [activeTasks, setActiveTasks] = useState<Task[]>([]);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);
  const [now, setNow] = useState(Date.now());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const fetchData = useCallback(async () => {
    try {
      // Get stats
      const statsRes = await fetch("/api/stats");
      if (statsRes.ok) setStats(await statsRes.json());

      // Get all tasks
      const tasksRes = await fetch("/api/tasks?limit=200");
      if (tasksRes.ok) {
        const data = await tasksRes.json();
        const tasks: Task[] = data.tasks ?? data;
        // Active: running, queued, reviewing
        setActiveTasks(
          tasks
            .filter((t) => ["running", "queued", "reviewing"].includes(t.status))
            .sort((a, b) => (b.started_at || b.created_at).localeCompare(a.started_at || a.created_at))
        );
        // Recent: completed/failed/cancelled in last 2 hours
        const cutoff = Date.now() - 2 * 60 * 60 * 1000;
        setRecentTasks(
          tasks
            .filter((t) =>
              ["completed", "failed", "cancelled"].includes(t.status) &&
              (parseDbTime(t.completed_at)?.getTime() ?? 0) > cutoff
            )
            .sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""))
            .slice(0, 20)
        );
      }
      setLastRefresh(Date.now());
    } catch (err) {
      console.error("Failed to fetch progress:", err);
    }
  }, []);

  // Auto-refresh every 3s
  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchData();
      setNow(Date.now());
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const totalCost = activeTasks.reduce((s, t) => s + (t.cost_usd || 0), 0);
  const queueSize = stats?.scheduler?.queue_size ?? 0;
  const runningCount = stats?.scheduler?.running_count ?? 0;
  const maxConcurrency = stats?.scheduler?.max_concurrency ?? 2;

  return (
    // 🆕 飞书 R139 第三批: 右滚修复 — 同 schedules 套路.
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-gray-600 hover:text-gray-900 text-sm">← 返回</Link>
            <h1 className="text-xl font-semibold mt-2">实时进度</h1>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            自动刷新
            <span className="text-xs text-gray-400 ml-2">
              上次: {new Date(lastRefresh).toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
          </label>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-6xl w-full mx-auto px-6 py-6 space-y-6">
        {/* Scheduler status */}
        <section className="bg-white rounded-lg border p-5">
          <h2 className="font-medium text-gray-900 mb-4">调度器状态</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <StatBox label="运行中" value={runningCount} color="text-sky-600" />
            <StatBox label="排队中" value={queueSize} color="text-blue-600" />
            <StatBox label="并发上限" value={maxConcurrency} color="text-gray-900" />
            <StatBox label="实时花费" value={`$${totalCost.toFixed(3)}`} color="text-amber-600" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span>并发占用</span>
              <span>{runningCount} / {maxConcurrency}</span>
            </div>
            <ProgressBar value={runningCount} max={maxConcurrency} color="bg-sky-500" />
          </div>
          {/* Running task chips */}
          {stats?.scheduler?.running_tasks && stats.scheduler.running_tasks.length > 0 && (
            <div className="mt-4">
              <div className="text-xs text-gray-500 mb-2">运行中任务:</div>
              <div className="flex flex-wrap gap-2">
                {stats.scheduler.running_tasks.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    className="text-xs bg-sky-50 text-sky-700 border border-sky-200 px-2 py-1 rounded hover:bg-sky-100"
                    title={t.title}
                  >
                    <span className="inline-block w-1.5 h-1.5 bg-sky-500 rounded-full animate-pulse mr-1.5" />
                    {t.title.length > 30 ? t.title.slice(0, 30) + "…" : t.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {stats?.scheduler?.queue_tasks && stats.scheduler.queue_tasks.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-gray-500 mb-2">队列中:</div>
              <div className="flex flex-wrap gap-2">
                {stats.scheduler.queue_tasks.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-1 rounded hover:bg-blue-100"
                    title={t.title}
                  >
                    {t.title.length > 30 ? t.title.slice(0, 30) + "…" : t.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Active tasks */}
        <section className="bg-white rounded-lg border p-5">
          <h2 className="font-medium text-gray-900 mb-4">
            活跃任务
            <span className="text-xs text-gray-400 ml-2">({activeTasks.length})</span>
          </h2>
          {activeTasks.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">无活跃任务</p>
          ) : (
            <div className="space-y-2">
              {activeTasks.map((t) => {
                const startMs = parseDbTime(t.started_at)?.getTime() ?? parseDbTime(t.created_at)?.getTime() ?? 0;
                const elapsed = formatDuration(startMs, now);
                const isRunning = t.status === "running";
                return (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    className="block border border-gray-200 rounded-lg p-3 hover:border-blue-300 hover:shadow-sm transition"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">{t.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                          <span className={`inline-block px-1.5 py-0.5 rounded border ${STATUS_COLORS[t.status]}`}>
                            {STATUS_LABELS[t.status]}
                          </span>
                          {t.model && <span>{t.model}</span>}
                          <span>· {elapsed}前开始</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        {isRunning && (
                          <span className="inline-block w-2 h-2 bg-sky-500 rounded-full animate-pulse" />
                        )}
                        <div className="text-xs text-gray-500 mt-1">
                          ${(t.cost_usd || 0).toFixed(3)}
                        </div>
                      </div>
                    </div>
                    {isRunning && (
                      <ProgressBar
                        value={now - startMs}
                        max={30 * 60 * 1000}
                        color={now - startMs > 25 * 60 * 1000 ? "bg-red-500" : "bg-blue-500"}
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* Recent completed */}
        <section className="bg-white rounded-lg border p-5">
          <h2 className="font-medium text-gray-900 mb-4">
            最近完成
            <span className="text-xs text-gray-400 ml-2">(近2小时)</span>
          </h2>
          {recentTasks.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">无最近任务</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {recentTasks.map((t) => {
                const dur = t.started_at && t.completed_at
                  ? formatDuration(parseDbTime(t.started_at)?.getTime() ?? 0, parseDbTime(t.completed_at)?.getTime() ?? 0)
                  : "?";
                return (
                  <Link
                    key={t.id}
                    href={`/tasks/${t.id}`}
                    className="flex items-center gap-3 py-2 hover:bg-gray-50 -mx-2 px-2 rounded"
                  >
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs border ${STATUS_COLORS[t.status]}`}>
                      {STATUS_LABELS[t.status]}
                    </span>
                    <span className="flex-1 truncate text-sm">{t.title}</span>
                    <span className="text-xs text-gray-400 shrink-0">{dur}</span>
                    <span className="text-xs text-gray-500 shrink-0 w-16 text-right">
                      ${(t.cost_usd || 0).toFixed(3)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}