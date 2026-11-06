// R122 / T2.3.1: 维度聚合 helper —— 纯函数, 不依赖 React, 方便单测.
// 关注点:
//   - 入参: costByTag (来自 /api/stats 的 cost.by_tag, key=完整标签, value=USD)
//           + tasks 列表 (来自 /api/tasks, 含 tags JSON 字符串列).
//   - 出参: DimAgg[] 按"canonical 置顶 → task 数降序 → name 字典序"排序.
//   - 不读 DB, 不发请求. 与 dim:* 命名空间约定一致 (src/lib/tasks/tags.ts).

import { TAG_PREFIX } from "../tasks/tags";

export interface TaskLike {
  tags: string | null;
}

export interface DimAgg {
  name: string;
  costUsd: number;
  taskCount: number;
  isCanonical: boolean;
}

// 4 个拍板的 canonical 维度名 —— 与 §5.3 调研档 + 总方案 §2 一致.
export const CANONICAL_DIMS = ["backend", "frontend", "infra", "沟通"] as const;
const CANONICAL_SET = new Set<string>(CANONICAL_DIMS);

// 功能: 从 tag JSON 字符串里挑出所有 dim:* 条目, 去前缀, 去重.
function extractDims(tagsRaw: string | null | undefined): string[] {
  let arr: unknown[] = [];
  if (!tagsRaw) return [];
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
    if (!t.startsWith(TAG_PREFIX.dimension)) continue;
    const name = t.slice(TAG_PREFIX.dimension.length);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// 功能: 聚合 cost.by_tag 和 task 列表, 输出渲染用的 DimAgg[].
// 关注点: 即使 cost=0 task=0 的"已知 canonical"也会以零值出现, 便于 UI 始终列出
//          4 个固定维度位 (排版稳定). 其它 dim:* 仅在 cost 或 task 至少一项 > 0 时出现.
export function aggregateDimensions(
  costByTag: Record<string, number> | undefined,
  tasks: TaskLike[]
): DimAgg[] {
  const costByDim: Record<string, number> = {};
  if (costByTag) {
    for (const [tag, cost] of Object.entries(costByTag)) {
      if (typeof tag !== "string" || typeof cost !== "number") continue;
      if (!tag.startsWith(TAG_PREFIX.dimension)) continue;
      const name = tag.slice(TAG_PREFIX.dimension.length);
      if (!name) continue;
      costByDim[name] = (costByDim[name] || 0) + cost;
    }
  }

  const countByDim: Record<string, number> = {};
  for (const t of tasks) {
    for (const name of extractDims(t.tags)) {
      countByDim[name] = (countByDim[name] || 0) + 1;
    }
  }

  const allNames = new Set<string>([...Object.keys(costByDim), ...Object.keys(countByDim)]);
  // canonical 即使无数据也占位 (UI 一致性, 排版稳定)
  for (const c of CANONICAL_DIMS) allNames.add(c);

  const out: DimAgg[] = [];
  for (const name of allNames) {
    out.push({
      name,
      costUsd: costByDim[name] || 0,
      taskCount: countByDim[name] || 0,
      isCanonical: CANONICAL_SET.has(name),
    });
  }

  out.sort((a, b) => {
    if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
    if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
    return a.name.localeCompare(b.name);
  });
  return out;
}
