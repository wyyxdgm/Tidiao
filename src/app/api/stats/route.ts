// GET /api/stats - Task statistics, scoped to the current user's tasks

import { NextRequest, NextResponse } from "next/server";
import { getTaskStats, getTaskById } from "@/lib/db/tasks";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // All aggregations are scoped to the current user's tasks (owner_id filter)
  // so one user never sees another's cost/status counts.
  const stats = getTaskStats(userId);
  const scheduler = getRuntime().getScheduler();
  const db = getDb();

  // Cost aggregation
  const totalCost = (db.prepare("SELECT SUM(cost_usd) as total FROM tasks WHERE cost_usd IS NOT NULL AND deleted_at IS NULL AND owner_id = ?").get(userId) as any)?.total || 0;

  // Cost by tag
  const costByTag: Record<string, number> = {};
  const taggedTasks = db.prepare("SELECT tags, cost_usd FROM tasks WHERE tags IS NOT NULL AND cost_usd IS NOT NULL AND deleted_at IS NULL AND owner_id = ?").all(userId) as Array<{ tags: string; cost_usd: number }>;
  for (const task of taggedTasks) {
    try {
      const tags: string[] = JSON.parse(task.tags);
      for (const tag of tags) {
        costByTag[tag] = (costByTag[tag] || 0) + task.cost_usd;
      }
    } catch {}
  }

  // Cost by model
  const costByModel: Record<string, number> = {};
  const modelTasks = db.prepare("SELECT model, cost_usd FROM tasks WHERE model IS NOT NULL AND cost_usd IS NOT NULL AND deleted_at IS NULL AND owner_id = ?").all(userId) as Array<{ model: string; cost_usd: number }>;
  for (const task of modelTasks) {
    costByModel[task.model] = (costByModel[task.model] || 0) + task.cost_usd;
  }

  // Cost by day (last 7 days)
  const costByDay = db.prepare(`
    SELECT DATE(completed_at) as day, SUM(cost_usd) as cost
    FROM tasks
    WHERE cost_usd IS NOT NULL AND completed_at >= datetime('now', '-7 days') AND deleted_at IS NULL AND owner_id = ?
    GROUP BY DATE(completed_at)
    ORDER BY day DESC
  `).all(userId) as Array<{ day: string; cost: number }>;

  // Scheduler queues hold task ids across all users (shared single-machine
  // scheduler); resolve titles but only for tasks the caller owns. A foreign
  // id resolves to null via getTaskById(userId) and is surfaced as the bare id.
  const runningTasks = scheduler.getRunning().map((id) => ({
    id,
    title: getTaskById(id, userId)?.title || id,
  }));
  const queueTasks = scheduler.getQueue().map((id) => ({
    id,
    title: getTaskById(id, userId)?.title || id,
  }));

  return NextResponse.json({
    tasks: stats,
    scheduler: {
      queue_size: scheduler.getQueueSize(),
      running_count: scheduler.getRunningCount(),
      max_concurrency: scheduler.getConcurrency(),
      running_tasks: runningTasks,
      queue_tasks: queueTasks,
    },
    cost: {
      total: totalCost,
      by_tag: costByTag,
      by_model: costByModel,
      by_day: costByDay,
    },
  });
}
