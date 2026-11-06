// R122 / T2.3.2: 需求聚合 helper —— 纯函数, 不依赖 React, 方便单测.
// 关注点:
//   - 入参: TaskRow[] (来自 /api/tasks, 含 tags / status / cost_usd / base_commit / head_commit).
//   - 出参: ReqAgg[] 按"task 数降序 → name 字典序"排序.
//   - 双轨: task 数 (打过该 req 的 task 数) + commit 数 (这些 task 的 head_commit/base_commit 去重).
//   - 一个 task 可打多个 req:* → 该 task 在每个 req 桶里都 +1.
//   - 重名合并由 parseTags 已保证 (R122 / T1.1), 这里再做一次去重保险.

import { TAG_PREFIX } from "../tasks/tags";

export interface TaskWithCommit {
  tags: string | null | undefined;
  status: string;
  cost_usd: number | null;
  base_commit: string | null;
  head_commit: string | null;
}

export interface ReqAgg {
  name: string;
  taskCount: number;
  completed: number;
  failed: number;
  commitCount: number;
  costUsd: number;
}

// 功能: 从 tag JSON 字符串里挑出所有 req:* 条目, 去前缀, 去重 (顺序稳定).
function extractReqs(tagsRaw: string | null | undefined): string[] {
  if (!tagsRaw) return [];
  let arr: unknown[] = [];
  try {
    const v = JSON.parse(tagsRaw);
    if (Array.isArray(v)) arr = v;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t !== "string") continue;
    if (!t.startsWith(TAG_PREFIX.requirement)) continue;
    const name = t.slice(TAG_PREFIX.requirement.length);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// 功能: 聚合 task 列表, 按 req:* 名分组, 输出 ReqAgg[].
// 关注点: commit 数走 Set 去重 (一个 task 的 base/head 只算 1 个 commit 锚点);
//          head_commit 优先, 没 head 才退 base_commit; 两个都空 = 不计入 commit 数.
export function aggregateRequirements(tasks: TaskWithCommit[]): ReqAgg[] {
  const map = new Map<string, ReqAgg>();
  const commitSets = new Map<string, Set<string>>();

  for (const t of tasks) {
    const reqs = extractReqs(t.tags);
    if (reqs.length === 0) continue;
    for (const name of reqs) {
      let agg = map.get(name);
      if (!agg) {
        agg = {
          name,
          taskCount: 0,
          completed: 0,
          failed: 0,
          commitCount: 0,
          costUsd: 0,
        };
        map.set(name, agg);
      }
      agg.taskCount += 1;
      if (t.status === "completed") agg.completed += 1;
      if (t.status === "failed") agg.failed += 1;
      agg.costUsd += typeof t.cost_usd === "number" ? t.cost_usd : 0;

      const commit = t.head_commit || t.base_commit;
      if (commit) {
        let s = commitSets.get(name);
        if (!s) {
          s = new Set<string>();
          commitSets.set(name, s);
        }
        s.add(commit);
      }
    }
  }
  for (const [name, set] of commitSets) {
    const agg = map.get(name);
    if (agg) agg.commitCount = set.size;
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
    return a.name.localeCompare(b.name);
  });
}
