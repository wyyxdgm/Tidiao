<script setup lang="ts">
/* 功能: 维度分析 tab —— 1:1 镜像 Next.js src/app/stats/tabs/dimensions.tsx.
   数据源: GET /api/stats (cost.by_tag) + GET /api/tasks?limit=200 (task 列表).
   渲染: 4 维统计卡 + 双层 bar (cost 深 + task 浅叠加) + 命名空间说明.

   关注点:
   - aggregateDimensions 纯函数已抽出到 lib/stats/dimensions-aggregate.ts,
     单测在 master 验证, 本视图只做 fetch + render.
   - tasks 列表只取本账号可见, limit=200 防大用户爆; 超出有视觉提示.
   - 4 canonical 维度 (backend/frontend/infra/沟通) 加粗显示 + canonical chip,
     其他归 "其他" chip (与 Next dimensions.tsx:121-131 一致).
   - 双层 bar: 深色 = 花费占比 · 浅色 = 任务数占比 (opacity:0.6), 与 Next 同款.
   - 入参 stats.cost.by_tag 用 prop 传入 (与 UsageTab 同款共享数据契约).
   - tasks 列表 view 内 inline fetch (R34 "不引 listTasks" 同款, 避免共享
     api/tasks.ts 引出未使用的 listTasks, 参 R33 commit message).

   状态机:
   - 加载: stats==null || tasks==null → 加载中
   - 错误: err ref 兜底红字 + 数据回零
   - 数据: 4 stat + 双层 bar + 提示.

   与 Next 端 1:1 复刻:
   - 4 卡 (总花费/带 dim task/唯一 dim 数/采样 task 数).
   - dim 行: canonical chip + name + task·cost + 双层 bar.
   - 底部提示: "深色 = 花费占比 · 浅色 = 任务数占比" + "采样 N 个 task". */

import { computed, onMounted, ref } from 'vue';
import { get } from '@/api/http';
import type { CostBreakdown } from '@/api/stats';
import { aggregateDimensions, type DimAgg } from '@/lib/stats/dimensions-aggregate';

interface Props {
  /** stats.cost 子集 — 父组件传入 (与 UsageTab 同款共享 GET /api/stats). */
  cost: CostBreakdown;
}

const props = defineProps<Props>();

/* ------------------------------------------------------------------ */
/*  state                                                                */
/* ------------------------------------------------------------------ */

const tasks = ref<Array<{ id: string; tags: string | null }> | null>(null);
const err = ref<string | null>(null);

/* ------------------------------------------------------------------ */
/*  fetch                                                                */
/* ------------------------------------------------------------------ */

async function fetchTasks(): Promise<void> {
  try {
    const r = await get<Array<{ id: string; tags: string | null }>>('/api/tasks?limit=200');
    tasks.value = Array.isArray(r) ? r : [];
  } catch (e: unknown) {
    err.value = e instanceof Error ? e.message : String(e);
    tasks.value = [];
  }
}

onMounted(() => {
  void fetchTasks();
});

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const dims = computed<DimAgg[]>(() => {
  return aggregateDimensions(props.cost.by_tag, tasks.value ?? []);
});

const maxCost = computed<number>(() => Math.max(...dims.value.map((d) => d.costUsd), 0.01));
const maxCount = computed<number>(() => Math.max(...dims.value.map((d) => d.taskCount), 1));
const totalCost = computed<number>(() => dims.value.reduce((s, d) => s + d.costUsd, 0));
const totalTaggedTasks = computed<number>(() => dims.value.reduce((s, d) => s + d.taskCount, 0));
const isLoading = computed<boolean>(() => tasks.value === null && err.value === null);
const hasData = computed<boolean>(() => dims.value.length > 0 && (totalCost.value > 0 || totalTaggedTasks.value > 0));

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

function formatCost(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}

function costPct(d: DimAgg): number {
  return (d.costUsd / maxCost.value) * 100;
}

function countPct(d: DimAgg): number {
  return (d.taskCount / maxCount.value) * 100;
}
</script>

<template>
  <div class="dimensions-tab">
    <!-- 错误态 -->
    <div v-if="err" class="text-sm text-red-600">加载失败：{{ err }}</div>

    <!-- 加载态 -->
    <div
      v-else-if="isLoading"
      class="min-h-[200px] flex items-center justify-center text-gray-400"
    >
      加载中…
    </div>

    <template v-else>
      <div class="card">
        <h2 class="card-title">维度分布（dim:*）</h2>
        <p class="card-desc">
          按 <code>dim:*</code> 命名空间聚合（backend / frontend / infra / 沟通）。一个 task 可同时打多个维度，按出现次数累加。
        </p>

        <template v-if="!hasData">
          <p class="muted-small">
            暂无 dim:* 标签数据。给 task 打 <code>--tags dim:backend</code> 后将出现在这里。
          </p>
        </template>

        <template v-else>
          <div class="stat-grid">
            <div class="stat-card-soft">
              <div class="stat-card-label">总花费 (dim:*)</div>
              <div class="stat-card-value">{{ formatCost(totalCost) }}</div>
            </div>
            <div class="stat-card-soft">
              <div class="stat-card-label">带 dim 标签的 task</div>
              <div class="stat-card-value">{{ totalTaggedTasks }}</div>
            </div>
            <div class="stat-card-soft">
              <div class="stat-card-label">唯一 dim 维度数</div>
              <div class="stat-card-value">{{ dims.filter((d) => d.taskCount > 0).length }}</div>
            </div>
            <div class="stat-card-soft">
              <div class="stat-card-label">采样 task 数</div>
              <div class="stat-card-value">{{ tasks?.length ?? 0 }} (limit=200)</div>
            </div>
          </div>

          <div class="dim-list">
            <div v-for="d in dims" :key="d.name" class="dim-row">
              <div class="dim-row-label">
                <span class="dim-row-name">
                  <span :class="d.isCanonical ? 'chip-canonical' : 'chip-other'">
                    {{ d.isCanonical ? 'canonical' : '其他' }}
                  </span>
                  <code>dim:{{ d.name }}</code>
                </span>
                <span class="muted-tiny">{{ d.taskCount }} task · {{ formatCost(d.costUsd) }}</span>
              </div>
              <div class="dim-bar-track">
                <div
                  class="dim-bar-cost"
                  :style="{ width: Math.max(costPct(d), 1) + '%' }"
                  :title="`花费 ${formatCost(d.costUsd)}`"
                />
                <div
                  class="dim-bar-count"
                  :style="{ width: Math.max(countPct(d), 1) + '%' }"
                  :title="`任务数 ${d.taskCount}`"
                />
              </div>
            </div>
          </div>

          <p class="muted-tiny mt-4">
            深色 = 花费占比 · 浅色 = 任务数占比。任务数可能因 limit=200 截断，超过部分未计入。
          </p>
        </template>
      </div>

      <p class="muted-tiny">
        提示：本账号共 {{ tasks?.length ?? 0 }} 个采样 task，其中至少 {{ totalTaggedTasks }} 个打了 dim:* 标签。
      </p>
    </template>
  </div>
</template>

<style scoped>
.dimensions-tab {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 20px;
}
.card-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--tw-gray-900);
  margin-bottom: 8px;
}
.card-desc {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-bottom: 16px;
}

.text-sm { font-size: 13px; }
.text-red-600 { color: var(--tw-red-600); }
.text-gray-400 { color: var(--tw-gray-400); }
.min-h-\[200px\] { min-height: 200px; }
.flex { display: flex; }
.items-center { align-items: center; }
.justify-center { justify-content: center; }
.mt-4 { margin-top: 16px; }

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
@media (min-width: 768px) {
  .stat-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.stat-card-soft {
  background: var(--tw-gray-50);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px;
}
.stat-card-label {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-bottom: 4px;
}
.stat-card-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--tw-gray-900);
}

.muted-small {
  font-size: 13px;
  color: var(--tw-gray-400);
}
.muted-tiny {
  font-size: 12px;
  color: var(--tw-gray-400);
}

.dim-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dim-row-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.dim-row-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--tw-gray-700);
}
.dim-row-name code {
  font-size: 12px;
}
.chip-canonical {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
}
.chip-other {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--tw-gray-100);
  color: var(--tw-gray-600);
}
.dim-bar-track {
  position: relative;
  height: 20px;
  background: var(--tw-gray-100);
  border-radius: 4px;
  overflow: hidden;
}
.dim-bar-cost {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--tw-blue-500-solid);
  border-radius: 4px;
  min-width: 2px;
}
.dim-bar-count {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--tw-blue-300);
  opacity: 0.6;
  border-radius: 4px;
  min-width: 2px;
}
</style>
