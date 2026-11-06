<script setup lang="ts">
/* 功能: 需求聚合 tab —— 1:1 镜像 Next.js src/app/stats/tabs/requirements.tsx.
   数据源: GET /api/tasks?limit=200 (本账号 task 列表, 含 tags/status/cost_usd/
   base_commit/head_commit).
   渲染: 过滤 input + 4 stat 卡 + 表格 (name/task/完成/失败/commit/花费).

   关注点:
   - aggregateRequirements 纯函数已抽出到 lib/stats/requirements-aggregate.ts,
     单测在 master 验证, 本视图只做 fetch + render.
   - 双轨: task 数 (打过该 req 的 task 数) + commit 数 (这些 task 的
     head_commit/base_commit 去重).
   - 重名合并由 aggregate 内 extractReqs 已保证 (去重保险).
   - 限制: limit=200 防大用户爆; 不显示的 task 数有提示.
   - 渲染: 表格按 task 数降序, 显示 task/完成/失败/commit 数 + 花费.
   - 过滤 input: 客户端即时 filter (与 Next 同款, 无防抖).

   状态机:
   - 加载: tasks==null → 加载中
   - 错误: err 红字
   - 空: aggs.length===0 → "暂无 req:* 标签数据" 提示.

   与 Next 端 1:1 复刻:
   - 4 stat 卡 (唯一需求数 / 带 req task 数 / commit 数 / 总花费).
   - 表格 6 列: 需求名 / task 数 / 完成 / 失败 / commit 数 / 花费.
   - 底部提示: 采样 N task + commit 数说明. */

import { computed, onMounted, ref } from 'vue';
import { get } from '@/api/http';
import { aggregateRequirements, type ReqAgg } from '@/lib/stats/requirements-aggregate';
import Input from '@/components/Input.vue';

/* ------------------------------------------------------------------ */
/*  types                                                                */
/* ------------------------------------------------------------------ */

interface TaskRow {
  id: string;
  status: string;
  title: string;
  cost_usd: number | null;
  tags: string | null;
  base_commit: string | null;
  head_commit: string | null;
}

/* ------------------------------------------------------------------ */
/*  state                                                                */
/* ------------------------------------------------------------------ */

const tasks = ref<TaskRow[] | null>(null);
const err = ref<string | null>(null);
const filter = ref<string>('');

/* ------------------------------------------------------------------ */
/*  fetch                                                                */
/* ------------------------------------------------------------------ */

async function fetchTasks(): Promise<void> {
  try {
    const r = await get<TaskRow[]>('/api/tasks?limit=200');
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

const aggs = computed<ReqAgg[]>(() => {
  return tasks.value ? aggregateRequirements(tasks.value) : [];
});

const filtered = computed<ReqAgg[]>(() => {
  if (!filter.value) return aggs.value;
  const q = filter.value.toLowerCase();
  return aggs.value.filter((a) => a.name.toLowerCase().includes(q));
});

const totalTasks = computed<number>(() => aggs.value.reduce((s, a) => s + a.taskCount, 0));
const totalCommits = computed<number>(() => aggs.value.reduce((s, a) => s + a.commitCount, 0));
const totalCost = computed<number>(() => aggs.value.reduce((s, a) => s + a.costUsd, 0));
const isLoading = computed<boolean>(() => tasks.value === null && err.value === null);

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

function formatCost(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(3)}`;
}
</script>

<template>
  <div class="requirements-tab">
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
        <div class="card-header">
          <div>
            <h2 class="card-title">需求聚合（req:*）</h2>
            <p class="card-desc">
              按 <code>req:*</code> 命名空间聚合（重名合并）。双轨 = task 数（打过该 req 的 task）+ commit 数（这些 task 的 head/base commit 去重）。
            </p>
          </div>
          <Input
            type="search"
            placeholder="过滤需求名..."
            v-model="filter"
          />
        </div>

        <template v-if="aggs.length === 0">
          <p class="empty-state">
            暂无 req:* 标签数据。给 task 打 <code>--tags req:R122</code> 后将出现在这里。
          </p>
        </template>

        <template v-else>
          <div class="stat-grid">
            <div class="stat-card-soft">
              <div class="stat-card-label">唯一需求数</div>
              <div class="stat-card-value">{{ aggs.length }}</div>
            </div>
            <div class="stat-card-soft">
              <div class="stat-card-label">带 req 标签的 task</div>
              <div class="stat-card-value">{{ totalTasks }}</div>
            </div>
            <div class="stat-card-soft">
              <div class="stat-card-label">关联 commit 数（去重）</div>
              <div class="stat-card-value">{{ totalCommits }}</div>
            </div>
            <div class="stat-card-soft">
              <div class="stat-card-label">总花费</div>
              <div class="stat-card-value">{{ formatCost(totalCost) }}</div>
            </div>
          </div>

          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th class="text-left">需求名</th>
                  <th class="text-right">task 数</th>
                  <th class="text-right">完成</th>
                  <th class="text-right">失败</th>
                  <th class="text-right">commit 数</th>
                  <th class="text-right">花费</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in filtered" :key="a.name">
                  <td><code class="cell-code">req:{{ a.name }}</code></td>
                  <td class="text-right tabular-nums">{{ a.taskCount }}</td>
                  <td class="text-right tabular-nums cell-completed">{{ a.completed }}</td>
                  <td class="text-right tabular-nums cell-failed">{{ a.failed }}</td>
                  <td class="text-right tabular-nums cell-muted">{{ a.commitCount }}</td>
                  <td class="text-right tabular-nums">{{ formatCost(a.costUsd) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p v-if="filtered.length === 0 && filter" class="empty-state">
            无匹配 "{{ filter }}" 的需求。
          </p>
        </template>
      </div>

      <p class="muted-tiny">
        提示：采样 {{ tasks?.length ?? 0 }} task (limit=200)。commit 数 = 这些 task 的 base/head commit 去重计数，未与飞书行 R{"{N}"} 关联（总方案 §4 T2.2 二期接入）。
      </p>
    </template>
  </div>
</template>

<style scoped>
.requirements-tab {
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
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.card-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--tw-gray-900);
}
.card-desc {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-top: 4px;
}

.text-sm { font-size: 13px; }
.text-red-600 { color: var(--tw-red-600); }
.text-gray-400 { color: var(--tw-gray-400); }
.text-left { text-align: left; }
.text-right { text-align: right; }
.min-h-\[200px\] { min-height: 200px; }
.flex { display: flex; }
.items-center { align-items: center; }
.justify-center { justify-content: center; }

.filter-input {
  font-size: 13px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 4px;
  padding: 6px 12px;
  width: 192px;
  outline: none;
}
.filter-input:focus {
  border-color: var(--tw-blue-400);
}

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

.muted-tiny {
  font-size: 12px;
  color: var(--tw-gray-400);
}

.empty-state {
  font-size: 13px;
  color: var(--tw-gray-400);
  text-align: center;
  padding: 32px 0;
}

.table-wrap {
  overflow-x: auto;
}
.data-table {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
}
.data-table thead tr {
  text-align: left;
  font-size: 12px;
  color: var(--tw-gray-500);
  border-bottom: 1px solid var(--color-border);
}
.data-table th {
  padding: 8px 12px 8px 0;
  font-weight: 500;
}
.data-table td {
  padding: 8px 12px 8px 0;
}
.data-table tbody tr {
  border-bottom: 1px solid var(--color-border);
}
.data-table tbody tr:last-child {
  border-bottom: none;
}
.data-table tbody tr:hover {
  background: var(--tw-gray-50);
}
.cell-code {
  font-size: 12px;
}
.cell-completed {
  color: var(--tw-green-700);
}
.cell-failed {
  color: var(--tw-red-700);
}
.cell-muted {
  color: var(--tw-gray-600);
}
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
