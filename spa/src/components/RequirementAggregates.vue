<script setup lang="ts">
/* 功能: 需求点聚合 chip 三件套 (📋 tasks / 📈 % / 💬 feedback) — R74 W3 量化 3 列
   在 SPA 列表行内的 1:1 渲染组件, 给 Requirements / VersionRequirements /
   ProjectUnversionedRequirements 三视图共享.

   关注点:
   - 与 master RequirementsListView.tsx:313-343 同款 icon+value 结构, 但格式
     走任务描述字面拍板 (紧凑): `📋 N / 📈 X% / 💬 value`. master 是 `📋 N tasks /
     📈 X% 完成 / 💬 X天前 反馈` (带 label + 相对时间). 主动分歧已在任务描述披露.
   - 颜色阈值 (任务描述拍板): completion_pct = 100 → 绿, ≥50 → 橙, <50 → 红;
     task_count 灰底; feedback 灰底 (空 = '无反馈').
   - 失败/未加载 = 父级不渲染本组件 (与 R14-vault rev-chip 同款: 父级按
     aggregatesById[id] 判定 v-if). 组件本身不接 partial state. */

import type { RequirementAggregates } from '@/api/requirements';

defineProps<{ aggregates: RequirementAggregates }>();

/** completion_pct 阈值染色 — 与 master §R74 拍板一致 (绿/橙/红三段). */
function completionStyle(pct: number): Record<string, string> {
  if (pct >= 100) return { backgroundColor: 'var(--tw-green-100)', color: 'var(--tw-green-700)' };
  if (pct >= 50) return { backgroundColor: 'var(--tw-orange-200)', color: 'var(--tw-orange-800)' };
  return { backgroundColor: 'var(--tw-red-100)', color: 'var(--tw-red-700)' };
}
</script>

<template>
  <span class="agg-chip agg-chip-task" title="关联任务数">
    📋 {{ aggregates.task_count }}
  </span>
  <span
    class="agg-chip agg-chip-pct"
    :title="`完成 ${aggregates.completion_pct}%`"
    :style="completionStyle(aggregates.completion_pct)"
  >
    📈 {{ aggregates.completion_pct }}%
  </span>
  <span class="agg-chip agg-chip-feedback" title="最近反馈时间">
    💬 {{ aggregates.latest_feedback ?? '无反馈' }}
  </span>
</template>

<style scoped>
/* chip 基础样式 + 灰底 (task + feedback). pct chip 颜色走 inline style. */
.agg-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  line-height: 1.5;
}
.agg-chip-task,
.agg-chip-feedback {
  background: var(--tw-gray-100);
  color: var(--tw-gray-700);
}
</style>