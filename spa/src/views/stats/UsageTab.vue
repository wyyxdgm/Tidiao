<script setup lang="ts">
/* 功能: 用量统计 tab —— 1:1 镜像 Next.js src/app/stats/tabs/usage.tsx.
   数据源: GET /api/stats (单一 endpoint, StatsData 由父组件传下来).
   渲染: 4 卡片 + 7 天 bar + tag conic-gradient + model bar 全手写.

   关注点:
   - props.stats 由父 Stats.vue 一次性拉, 不在本 tab 内重复 fetch (与 R34 同款
     数据契约 — 4 tab 共享一份 stats 数据; dimensions 还需要 tasks, 走 inline fetch).
   - SERIES_COLORS 8 色 (dataviz skill palette) + formatCost/compactCost 与 Next
     usage.tsx 1:1 一致 — 单一常量两端共用, 后续配色/格式化变更同步两处.
   - 不引图表库 (与 plans §3 "不引重型组件库" 一致); 全部 div+style.
   - 状态机: 数据由父组件管理, 本 tab 无独立 loading/error — 父组件已做.

   与 Next 端 1:1 复刻:
   - 4 stat cards (总花费/总任务数/平均每任务/今日花费).
   - 近 7 天 bar (UTC today 起倒序 7 天, 缺失补 0, max 防 0 除 0 兜底 0.01).
   - tag conic-gradient + 图例 + 占比%.
   - model 横向 bar (降序, 颜色 i+1 错开 tag).
   - 异常态: tagEntries/modelEntries 空 → "暂无数据".
   - i18n (W4b): 用户可见文案走 t('misc.stats.usageTab.*'). */

import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CostByDay } from '@/api/stats';

interface Props {
  stats: {
    cost: {
      total: number;
      by_tag: Record<string, number>;
      by_model: Record<string, number>;
      by_day: CostByDay[];
    };
    tasks: Record<string, number>;
  };
}

const props = defineProps<Props>();

const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  配色                                                                */
/* ------------------------------------------------------------------ */

/** 8 色 categorical palette (dataviz skill, light mode). 与 Next usage.tsx:8-18
    完全一致 — 单一常量两端共用. */
const SERIES_COLORS = [
  'var(--t-series-1)', // blue
  'var(--t-series-2)', // orange
  'var(--t-series-3)', // aqua
  'var(--t-series-4)', // yellow
  'var(--t-series-5)', // magenta
  'var(--t-series-6)', // green
  'var(--t-series-7)', // violet
  'var(--t-series-8)', // red
];

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

/** cost 格式化 — 与 Next usage.tsx:31 formatCost 同款. */
function formatCost(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}

/** 紧凑 cost (≥1000 走 K 缩写) — 与 Next usage.tsx:37 compactCost 同款. */
function compactCost(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return formatCost(v);
}

/** tag conic-gradient — 与 Next usage.tsx:196 buildConicGradient 同款. */
function buildTagGradient(entries: Array<[string, number]>, total: number): string {
  if (entries.length === 0) return 'var(--tw-gray-200)';
  let cumPct = 0;
  const stops: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const pct = (entries[i][1] / total) * 100;
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    stops.push(`${color} ${cumPct}% ${cumPct + pct}%`);
    cumPct += pct;
  }
  return `conic-gradient(${stops.join(', ')})`;
}

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const totalTasks = computed<number>(() => {
  return Object.values(props.stats.tasks).reduce((a, b) => a + b, 0);
});

const avgCost = computed<number>(() => {
  return totalTasks.value > 0 ? props.stats.cost.total / totalTasks.value : 0;
});

const todayCost = computed<number>(() => {
  const today = new Date().toISOString().slice(0, 10);
  return props.stats.cost.by_day.find((d) => d.day === today)?.cost ?? 0;
});

const last7 = computed<CostByDay[]>(() => {
  const arr: CostByDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = props.stats.cost.by_day.find((r) => r.day === key);
    arr.push({ day: key, cost: found?.cost ?? 0 });
  }
  return arr;
});

const maxDayCost = computed<number>(() => Math.max(...last7.value.map((d) => d.cost), 0.01));

const tagEntries = computed<Array<[string, number]>>(() => {
  return Object.entries(props.stats.cost.by_tag).sort((a, b) => b[1] - a[1]);
});

const tagTotal = computed<number>(() => {
  return tagEntries.value.reduce((s, e) => s + e[1], 0) || 1;
});

const modelEntries = computed<Array<[string, number]>>(() => {
  return Object.entries(props.stats.cost.by_model).sort((a, b) => b[1] - a[1]);
});

const maxModelCost = computed<number>(() => Math.max(...modelEntries.value.map((e) => e[1]), 0.01));

function dayBarPct(cost: number): number {
  return (cost / maxDayCost.value) * 100;
}

function modelBarPct(cost: number): number {
  return (cost / maxModelCost.value) * 100;
}

function tagPct(cost: number): string {
  return ((cost / tagTotal.value) * 100).toFixed(1);
}
</script>

<template>
  <div class="usage-tab">
    <!-- 4 卡片 -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-card-label">{{ t('misc.stats.usageTab.statTotalCost') }}</div>
        <div class="stat-card-value">{{ compactCost(stats.cost.total) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">{{ t('misc.stats.usageTab.statTotalTasks') }}</div>
        <div class="stat-card-value">{{ totalTasks }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">{{ t('misc.stats.usageTab.statAvgCost') }}</div>
        <div class="stat-card-value">{{ formatCost(avgCost) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">{{ t('misc.stats.usageTab.statTodayCost') }}</div>
        <div class="stat-card-value">{{ formatCost(todayCost) }}</div>
      </div>
    </div>

    <!-- 7 天 bar -->
    <section class="card">
      <h2 class="card-title">{{ t('misc.stats.usageTab.last7Title') }}</h2>
      <div class="day-chart">
        <div
          v-for="d in last7"
          :key="d.day"
          class="day-bar-col"
        >
          <span v-if="d.cost > 0" class="day-bar-label">{{ formatCost(d.cost) }}</span>
          <div
            class="day-bar"
            :style="{ height: Math.max(dayBarPct(d.cost), 1) + '%', backgroundColor: SERIES_COLORS[0] }"
          />
          <span class="day-bar-date">{{ d.day.slice(5) }}</span>
        </div>
      </div>
    </section>

    <!-- Tag pie + Model bars (两列) -->
    <div class="two-col">
      <section class="card">
        <h2 class="card-title">{{ t('misc.stats.usageTab.byTagTitle') }}</h2>
        <p v-if="tagEntries.length === 0" class="muted-small">{{ t('misc.stats.usageTab.noData') }}</p>
        <div v-else class="tag-pie-row">
          <div
            class="tag-pie"
            :style="{ background: buildTagGradient(tagEntries, tagTotal) }"
          />
          <div class="tag-list">
            <div
              v-for="([tag, cost], i) in tagEntries"
              :key="tag"
              class="tag-list-row"
            >
              <span
                class="tag-color"
                :style="{ backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] }"
              />
              <span class="tag-name">{{ tag }}</span>
              <span class="tag-cost">{{ formatCost(cost) }} · {{ tagPct(cost) }}%</span>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">{{ t('misc.stats.usageTab.byModelTitle') }}</h2>
        <p v-if="modelEntries.length === 0" class="muted-small">{{ t('misc.stats.usageTab.noData') }}</p>
        <div v-else class="model-list">
          <div
            v-for="([model, cost], i) in modelEntries"
            :key="model"
            class="model-row"
          >
            <div class="model-row-label">
              <span>{{ model }}</span>
              <span class="muted-small">{{ formatCost(cost) }}</span>
            </div>
            <div class="model-bar-track">
              <div
                class="model-bar-fill"
                :style="{
                  width: Math.max(modelBarPct(cost), 1) + '%',
                  backgroundColor: SERIES_COLORS[(i + 1) % SERIES_COLORS.length],
                }"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.usage-tab {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (min-width: 768px) {
  .stat-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.stat-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
}
.stat-card-label {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-bottom: 4px;
}
.stat-card-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--tw-gray-900);
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
  margin-bottom: 16px;
}
.muted-small {
  font-size: 13px;
  color: var(--tw-gray-400);
}

.day-chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 192px;
}
.day-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}
.day-bar-label {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-bottom: 4px;
  font-variant-numeric: tabular-nums;
}
.day-bar {
  width: 100%;
  max-width: 24px;
  border-top-left-radius: 2px;
  border-top-right-radius: 2px;
  min-height: 2px;
  transition: all 0.2s;
}
.day-bar-date {
  font-size: 12px;
  color: var(--tw-gray-400);
  margin-top: 8px;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
}
@media (min-width: 768px) {
  .two-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.tag-pie-row {
  display: flex;
  align-items: center;
  gap: 24px;
}
.tag-pie {
  width: 144px;
  height: 144px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tag-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.tag-list-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.tag-color {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
}
.tag-name {
  color: var(--tw-gray-700);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-cost {
  color: var(--tw-gray-400);
  margin-left: auto;
  flex-shrink: 0;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.model-row-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.model-row-label > span:first-child {
  color: var(--tw-gray-700);
}
.model-bar-track {
  height: 20px;
  background: var(--tw-gray-100);
  border-radius: 4px;
  overflow: hidden;
}
.model-bar-fill {
  height: 100%;
  border-radius: 4px;
  min-width: 2px;
}
</style>
