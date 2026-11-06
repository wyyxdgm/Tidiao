<script setup lang="ts">
/* 功能: 用量统计视图 — 对应 Next src/app/usage/page.tsx 的「用量统计」页.
   完整镜像 Next 端的: 积压概览面板 + 时间粒度切换 (hour/day/week/month/year) +
   admin 口径切换器 (全部用户/仅我的/仅某用户) + 总量三卡 + 分桶表格 (行展开
   by_model) + 各模型总量表 + admin scope=all 才出按用户汇总表. 数据源 =
   GET /api/stats/usage + GET /api/stats/backlog 两路. URL: /usage, 由
   router/index.ts 挂载.

   关注点 (与 Next 端 1:1 + SPA 适配):
   - sheet R8 字面 "折线图/柱状图" 不实 — Next 端是分桶表格 + 进度条占比 (没有
     折线/柱状图), sheet 描述是写错了. 本视图与 Next 端完全 1:1, 不引 chart 库.
   - 桶标签由后端按 **UTC+8** 生成 (见 master route.ts 时区说明), 前端直接
     显示, 不要再 new Date(bucket) 转一次 — 否则按浏览器时区二次偏移.
   - context_tokens 是「上下文规模」而不是「消耗的 token 总量」, 文案上不要写
     成「token 用量」误导人 (tasks 表没有 input/output 分列).
   - 口径 owner 参数 — 双口径设计:
       普通用户: 只能看自己 (无切换器, 数据永远 scope=mine);
       admin:     顶部一个 Select, 三档 — 全部用户 (scope=all) / 仅我的
                  (scope=mine) / 仅某用户 (scope=owner). 「具体用户」列表来
                  自上次响应的 total.by_owner (后端在 scope=all 时附带), 不
                  再发一个用户列表 API (与 Next 同款).
     scope 由后端自述; 前端把它显示成徽标, 不靠请求猜.
   - 积压面板**独立取数**: 它与粒度无关 (是「此刻的存量」不是时间序列), 不
     放进 fetchUsage 的依赖里, 免得每次切粒度都白拉一次.
   - 字段集对齐 master route.ts 全字段 (granularity/limit/timezone/scope/
     buckets[]/total/by_model[]/by_owner?[]). BacklogData 同 1:1.
   - 样式策略: 项目未引 Tailwind (与 plans §3 一致, 不引重型组件库), 全部
     走 <style scoped> + semantic class (与 Progress.vue / Stats.vue
     / Schedules.vue / GlobalBoard.vue 同款拍板). sheet 字面描述带 Tailwind
     味道 (bg-white / grid-cols / text-xxx) 仅做 Next 视觉参考, SPA 端
     翻译成本仓 CSS 变量 (--color-bg-elevated / display: grid / 等).
   - 与 Next 端 3 处主动分歧已披露:
     (1) sheet 字面 "折线图/柱状图" 不实, 按 Next 实际分桶表格 + 占比条;
     (2) sheet 字面提到颗粒度切换, 与 Next GRANULARITY_OPTIONS 五档一致;
     (3) 客户端 owner 切换器选完 → 即时 fetch, 无防抖 (切换粒度/用户是低
         频动作, R8 范围 R34 同款无防抖).

   红线 (sheet R8 + 通用):
   - 不动 backend / 不动 Layer 0 / 不引新依赖.
   - 不重复实现 Layer 0 组件 (Loading / Empty / ErrorView / Select 全部 import).
   - URL 即状态: 切粒度/切 owner 都即时拉取, 不持久化到 ?query (与 Next 同款).
*/

import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  getUsageStats,
  getBacklog,
  type UsageData,
  type UsageGranularity,
  type BacklogData,
  type BacklogStatus,
  type OwnerUsage,
} from '@/api/usage';
import { getMyProfile, type UserProfile } from '@/api/user';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Select from '@/components/Select.vue';
import type { SelectOption } from '@/components/Select.vue';
import ScopeBadge from './usage/ScopeBadge.vue';

/* ------------------------------------------------------------------ */
/*  Granularity + owner options                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  i18n                                                               */
/* ------------------------------------------------------------------ */

const { t } = useI18n();

/** i18n (W3b): 选项 label 走 t() → computed. */
const granularityOptions = computed<SelectOption[]>(() => [
  { value: 'hour', label: t('projects.usage.granHour') },
  { value: 'day', label: t('projects.usage.granDay') },
  { value: 'week', label: t('projects.usage.granWeek') },
  { value: 'month', label: t('projects.usage.granMonth') },
  { value: 'year', label: t('projects.usage.granYear') },
]);

const staticOwnerOptions = computed<SelectOption[]>(() => [
  { value: 'all', label: t('projects.usage.ownerAll') },
  { value: 'self', label: t('projects.usage.ownerSelf') },
]);

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const granularity = ref<UsageGranularity>('day');
const data = ref<UsageData | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
/** 展开的 bucket 行集合 (bucket 字符串作为 key). */
const expanded = ref<Set<string>>(new Set());

/** 积压面板 — 与粒度独立, 不放进 fetchUsage 的依赖. */
const backlog = ref<BacklogData | null>(null);
const backlogError = ref<string | null>(null);

/** 当前用户身份 + admin 判定. */
const me = ref<UserProfile | null>(null);
/** admin 的口径切换器: "all" | "self" | "<user_id>". */
const ownerPick = ref<string>('self');
/** 上次 scope=all 响应里携带的「按用户汇总」, 用于组装 owner Select 的「仅某用户」档. */
const knownOwners = ref<OwnerUsage[]>([]);

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

onMounted(async () => {
  // 积压面板 — 与粒度无关, 只拉一次.
  try {
    backlog.value = await getBacklog();
  } catch (e) {
    backlogError.value = e instanceof Error ? e.message : t('projects.usage.errLoadTitle');
  }
});

onMounted(async () => {
  try {
    const profile = await getMyProfile();
    me.value = profile;
    // 普通用户永远只能 self, 不暴露切换器; admin 缺省切到「全部用户」.
    ownerPick.value = profile.role === 'admin' ? 'all' : 'self';
  } catch {
    /* 拉 profile 失败: 兜底 self, owner Select 不渲染 (admin 字段缺失时不渲染). */
    me.value = null;
    ownerPick.value = 'self';
  }
});

/* ------------------------------------------------------------------ */
/*  Fetch                                                              */
/* ------------------------------------------------------------------ */

/**
 * 拉用量: owner 跟着 me/ownerPick/granularity 三个变量走.
 * 非 admin 时 owner 强制 "self", 即便有人动了 state 也兜底.
 */
async function fetchUsage() {
  loading.value = true;
  error.value = null;
  const ownerQ = me.value?.role === 'admin' ? ownerPick.value : 'self';
  try {
    const j = await getUsageStats({ granularity: granularity.value, owner: ownerQ });
    data.value = j;
    // 把这次拿到的 by_owner 缓存成下次 owner Select 的「具体用户」列表,
    // 但只在确实拿到了有效数据时更新 —— 避免空响应把已知的清空.
    if (Array.isArray(j.total?.by_owner)) {
      knownOwners.value = j.total.by_owner;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('projects.usage.errLoadTitle');
    if (msg === 'admin required') {
      error.value = 'admin_required';
    } else {
      error.value = msg;
    }
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Watchers (替代 Next useEffect 依赖)                                 */
/* ------------------------------------------------------------------ */

let initialized = false;

watch(
  me,
  () => {
    if (me.value && !initialized) {
      initialized = true;
      fetchUsage();
    }
  },
  { immediate: true },
);

watch([granularity, ownerPick], () => {
  if (initialized) fetchUsage();
});

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function toggle(bucket: string) {
  const next = new Set(expanded.value);
  if (next.has(bucket)) next.delete(bucket);
  else next.add(bucket);
  expanded.value = next;
}

/** 用于桶表格「占比」条的 max 分母; 至少 0.0001 避免除零. */
const maxCost = computed(() => {
  const v = Math.max(...(data.value?.buckets.map((b) => b.cost_usd) ?? [0]), 0.0001);
  return v;
});

/** admin 的 Select 选项组装. knownOwners 是上次 scope=all 拿到的, 是用户「曾经有过
    任务」的子集 —— 缺任务的用户即便存在也不会出现. */
const ownerOptions = computed<SelectOption[]>(() => {
  if (me.value?.role !== 'admin') return [];
  return [
    ...staticOwnerOptions.value,
    ...knownOwners.value.map((o) => ({
      value: o.owner_id ?? '',
      label: o.email ?? t('projects.usage.deletedUser', { id: o.owner_id ?? 'unknown' }),
    })),
  ];
});

function pickOwnerEmail(): string | null {
  if (ownerPick.value === 'all' || ownerPick.value === 'self') return null;
  const row = knownOwners.value.find((o) => o.owner_id === ownerPick.value);
  return row?.email ?? null;
}

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

function formatCost(v: number): string {
  if (v === 0) return '$0';
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

/* ------------------------------------------------------------------ */
/*  Stat cards (computed)                                              */
/* ------------------------------------------------------------------ */

interface StatCard {
  label: string;
  value: string;
}

const totalCards = computed<StatCard[]>(() => {
  if (!data.value) return [];
  const total = data.value.total;
  return [
    { label: t('projects.usage.cardCost'), value: formatCost(total.cost_usd) },
    { label: t('projects.usage.cardTasks'), value: String(total.task_count) },
    { label: t('projects.usage.cardTokens'), value: formatTokens(total.context_tokens) },
  ];
});

/** 桶表格行占比条 width (百分比). */
function barWidth(cost: number): string {
  const max = maxCost.value;
  return `${Math.max((cost / max) * 100, 1)}%`;
}

/* ------------------------------------------------------------------ */
/*  Backlog status meta                                                */
/* ------------------------------------------------------------------ */

interface StatusMeta {
  label: string;
  cls: string;
}

/** 状态配色 (i18n 后 label 走 t(), 本表只留 class). key 与后端 BACKLOG_STATUSES 一一对应. */
const STATUS_META: Record<BacklogStatus, StatusMeta> = {
  pending: { label: '', cls: 'pending' },
  queued: { label: '', cls: 'queued' },
  running: { label: '', cls: 'running' },
  paused: { label: '', cls: 'paused' },
  reviewing: { label: '', cls: 'reviewing' },
  // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策; 曾误标「等待中」).
  rejected: { label: '', cls: 'rejected' },
  failed: { label: '', cls: 'failed' },
};

/** 状态中文名/英文名 — 走 t() (i18n W3b). */
function statusMetaLabel(s: BacklogStatus): string {
  const key: Record<BacklogStatus, string> = {
    pending: 'projects.usage.statusPending',
    queued: 'projects.usage.statusQueued',
    running: 'projects.usage.statusRunning',
    paused: 'projects.usage.statusPaused',
    reviewing: 'projects.usage.statusReviewing',
    rejected: 'projects.usage.statusRejected',
    failed: 'projects.usage.statusFailed',
  };
  return t(key[s] ?? 'projects.usage.statusPending');
}

/* ------------------------------------------------------------------ */
/*  Backlog panel                                                       */
/* ------------------------------------------------------------------ */

const isAllBacklog = computed(() => backlog.value?.scope === 'all');
</script>

<template>
  <div class="usage-page">
    <header class="page-header">
      <div class="header-nav">
        <a href="#/global" class="header-link">{{ t('projects.usage.backLink') }}</a>
        <a href="#/stats" class="header-link">{{ t('projects.usage.statsLink') }}</a>
      </div>
      <h1 class="page-title">{{ t('projects.usage.title') }}</h1>
    </header>

    <main class="page-body">
      <!-- 积压概览 (与粒度无关, 单独拉) -->
      <div v-if="backlogError" class="error-strip">
        {{ t('projects.usage.backlogLoadFailed', { msg: backlogError }) }}
      </div>
      <div v-else-if="!backlog" class="muted-line">{{ t('projects.usage.backlogLoading') }}</div>
      <section v-else class="card backlog-card">
        <div class="backlog-header">
          <div class="backlog-header-text">
            <h2 class="card-title">
              {{ t('projects.usage.backlogTitle') }}
              <span
                class="scope-badge"
                :class="isAllBacklog ? 'scope-all' : 'scope-mine'"
              >
                {{ isAllBacklog ? t('projects.usage.scopeAll') : t('projects.usage.scopeMine') }}
              </span>
            </h2>
            <p class="card-subtitle">
              {{ t('projects.usage.backlogSubtitle') }}
              <span v-if="!isAllBacklog">{{ t('projects.usage.notAdminSuffix') }}</span>
            </p>
          </div>
          <div class="backlog-total">
            <div class="backlog-total-num">{{ backlog.backlog_total }}</div>
            <div class="backlog-total-meta">
              {{ backlog.oldest_age_days === null ? t('projects.usage.noBacklog') : t('projects.usage.oldestDays', { n: backlog.oldest_age_days }) }}
            </div>
          </div>
        </div>

        <div class="backlog-grid">
          <div v-for="b in backlog.backlog" :key="b.status" class="backlog-cell">
            <div class="backlog-cell-label">
              {{ statusMetaLabel(b.status as BacklogStatus) }}
            </div>
            <div
              class="backlog-cell-value"
              :class="b.count > 0 ? STATUS_META[b.status as BacklogStatus]?.cls : 'backlog-cell-zero'"
            >
              {{ b.count }}
            </div>
            <div class="backlog-cell-meta">
              {{ b.oldest_age_days === null ? '' : t('projects.usage.oldestDaysShort', { n: b.oldest_age_days }) }}
            </div>
          </div>
        </div>

        <div v-if="backlog.reviewing_by_owner.top.length > 0" class="backlog-reviewing">
          <div class="backlog-reviewing-title">
            {{ t('projects.usage.reviewingByTitle', { n: backlog.reviewing_by_owner.distinct_owners }) }}
          </div>
          <div class="backlog-reviewing-list">
            <div
              v-for="o in backlog.reviewing_by_owner.top"
              :key="o.owner_id ?? 'unknown'"
              class="backlog-reviewing-row"
            >
              <span class="backlog-reviewing-email">
                {{ o.email ?? t('projects.usage.deletedUser', { id: o.owner_id ?? 'unknown' }) }}
              </span>
              <span class="backlog-reviewing-count">{{ o.count }}</span>
            </div>
            <div v-if="backlog.reviewing_by_owner.other_count > 0" class="backlog-reviewing-other">
              {{ t('projects.usage.othersCount', { n: backlog.reviewing_by_owner.other_count }) }}
            </div>
          </div>
        </div>

        <div class="backlog-footer">
          {{ backlog.instance ? t('projects.usage.backlogFooterInstance', { instance: backlog.instance }) : t('projects.usage.backlogFooter') }}
        </div>
      </section>

      <!-- 粒度 + (admin 限定) owner 切换器 -->
      <div class="controls-row">
        <span class="control-label">{{ t('projects.usage.labelGranularity') }}</span>
        <div class="control-select">
          <Select
            :model-value="granularity"
            :options="granularityOptions"
            class-name="w-32"
            @update:model-value="(v: string | null) => v && (granularity = v as UsageGranularity)"
          />
        </div>
        <template v-if="me?.role === 'admin' && ownerOptions.length > 0">
          <span class="control-label">{{ t('projects.usage.labelOwner') }}</span>
          <div class="control-select-wide">
            <Select
              :model-value="ownerPick"
              :options="ownerOptions"
              class-name="w-56"
              @update:model-value="(v: string | null) => v && (ownerPick = v)"
            />
          </div>
        </template>
        <span v-if="data" class="control-meta">
          {{ t('projects.usage.metaTimezone', { tz: data.timezone, n: data.limit }) }}
        </span>
      </div>

      <!-- Error / loading / content -->
      <ErrorView
        v-if="error && !data"
        :title="error === 'admin_required' ? t('projects.usage.errPermTitle') : t('projects.usage.errLoadTitle')"
        :description="
          error === 'admin_required'
            ? t('projects.usage.errPermDesc')
            : error
        "
        :show-retry="error !== 'admin_required'"
        :retrying="loading"
        @retry="fetchUsage"
      />
      <Loading v-else-if="loading && !data" :text="t('projects.usage.loading')" />

      <template v-if="data">
        <!-- 总量卡 -->
        <div class="stat-grid stat-grid-3">
          <div v-for="card in totalCards" :key="card.label" class="stat-box">
            <div class="stat-box-label">{{ card.label }}</div>
            <div class="stat-box-value">{{ card.value }}</div>
          </div>
        </div>

        <!-- 分桶表格 -->
        <section class="card">
          <div class="card-header">
            <h2 class="card-title">
              {{ t('projects.usage.bucketsTitle') }}
              <ScopeBadge :scope="data.scope" :owner-email="pickOwnerEmail()" />
            </h2>
            <p class="card-subtitle">{{ t('projects.usage.bucketsSubtitle') }}</p>
          </div>
          <div v-if="data.buckets.length === 0" class="empty-line">
            {{ t('projects.usage.bucketsEmpty') }}
          </div>
          <table v-else class="usage-table">
            <thead>
              <tr>
                <th class="th-left">{{ t('projects.usage.thBucket') }}</th>
                <th class="th-right">{{ t('projects.usage.thTasks') }}</th>
                <th class="th-right">{{ t('projects.usage.thCost') }}</th>
                <th class="th-right">{{ t('projects.usage.thTokens') }}</th>
                <th class="th-left th-bar">{{ t('projects.usage.thRatio') }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="b in data.buckets" :key="b.bucket">
                <tr class="bucket-row" @click="toggle(b.bucket)">
                  <td class="td-left">
                    <span class="caret">{{ expanded.has(b.bucket) ? '▾' : '▸' }}</span>
                    {{ b.bucket }}
                  </td>
                  <td class="td-right">{{ b.task_count }}</td>
                  <td class="td-right td-strong">{{ formatCost(b.cost_usd) }}</td>
                  <td class="td-right td-muted">{{ formatTokens(b.context_tokens) }}</td>
                  <td class="td-left td-bar">
                    <div class="bar-track">
                      <div class="bar-fill" :style="{ width: barWidth(b.cost_usd) }" />
                    </div>
                  </td>
                </tr>
                <template v-if="expanded.has(b.bucket)">
                  <tr
                    v-for="m in b.by_model"
                    :key="`${b.bucket}-${m.model}`"
                    class="model-row"
                  >
                    <td class="td-left td-model">{{ m.model }}</td>
                    <td class="td-right td-xs">{{ m.task_count }}</td>
                    <td class="td-right td-xs td-strong">{{ formatCost(m.cost_usd) }}</td>
                    <td class="td-right td-xs td-muted">{{ formatTokens(m.context_tokens) }}</td>
                    <td />
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
        </section>

        <!-- 各模型总量 (全量) -->
        <section class="card">
          <div class="card-header">
            <h2 class="card-title">
              {{ t('projects.usage.modelsTitle') }}
              <ScopeBadge :scope="data.scope" :owner-email="pickOwnerEmail()" />
            </h2>
            <p class="card-subtitle">
              {{ t('projects.usage.modelsSubtitle') }}
            </p>
          </div>
          <div v-if="data.total.by_model.length === 0" class="empty-line">{{ t('projects.usage.noData') }}</div>
          <table v-else class="usage-table">
            <thead>
              <tr>
                <th class="th-left">{{ t('projects.usage.thModel') }}</th>
                <th class="th-right">{{ t('projects.usage.thTasks') }}</th>
                <th class="th-right">{{ t('projects.usage.thCost') }}</th>
                <th class="th-right">{{ t('projects.usage.thTokens') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.total.by_model" :key="m.model">
                <td class="td-left">{{ m.model }}</td>
                <td class="td-right">{{ m.task_count }}</td>
                <td class="td-right td-strong">{{ formatCost(m.cost_usd) }}</td>
                <td class="td-right td-muted">{{ formatTokens(m.context_tokens) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 按用户汇总 (admin + scope=all 才出) -->
        <section
          v-if="me?.role === 'admin' && ownerPick === 'all' && Array.isArray(data.total.by_owner)"
          class="card"
        >
          <div class="card-header">
            <h2 class="card-title">
              {{ t('projects.usage.ownersTitle') }}
              <ScopeBadge :scope="data.scope" :owner-email="null" />
            </h2>
            <p class="card-subtitle">
              {{ t('projects.usage.ownersSubtitle') }}
            </p>
          </div>
          <div
            v-if="!data.total.by_owner || data.total.by_owner.length === 0"
            class="empty-line"
          >
            {{ t('projects.usage.noData') }}
          </div>
          <table v-else class="usage-table">
            <thead>
              <tr>
                <th class="th-left">{{ t('projects.usage.thUser') }}</th>
                <th class="th-right">{{ t('projects.usage.thTasks') }}</th>
                <th class="th-right">{{ t('projects.usage.thCost') }}</th>
                <th class="th-right">{{ t('projects.usage.thTokens') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in data.total.by_owner" :key="o.owner_id ?? 'unknown'">
                <td class="td-left">
                  {{ o.email ?? t('projects.usage.deletedUser', { id: o.owner_id ?? 'unknown' }) }}
                </td>
                <td class="td-right">{{ o.task_count }}</td>
                <td class="td-right td-strong">{{ formatCost(o.cost_usd) }}</td>
                <td class="td-right td-muted">{{ formatTokens(o.context_tokens) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Page shell                                                          */
/* ------------------------------------------------------------------ */
.usage-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

.page-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px 24px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.header-nav {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-link {
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: 13px;
}

.header-link:hover {
  color: var(--color-text);
}

.page-title {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
}

.page-body {
  flex: 1;
  max-width: 1024px;
  width: 100%;
  margin: 0 auto;
  padding: 20px 24px 32px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ------------------------------------------------------------------ */
/*  Card                                                                */
/* ------------------------------------------------------------------ */
.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  /* 在 .page-body 这个 flex column 容器里, 卡片默认 flex-shrink:1,
     子项总高度超过容器就被压扁. 关掉 shrink 让卡片按内容自然撑开. */
  flex-shrink: 0;
}

.card-header {
  padding: 14px 20px;
  border-bottom: 1px solid var(--color-border);
}

.card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--color-text);
}

.card-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

/* ------------------------------------------------------------------ */
/*  Backlog card                                                        */
/* ------------------------------------------------------------------ */
.backlog-card {
  /* 自身就是 card, 这里只补充头部布局. */
}

.backlog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--color-border);
}

.backlog-header-text {
  min-width: 0;
  flex: 1;
}

.backlog-total {
  text-align: right;
  flex-shrink: 0;
}

.backlog-total-num {
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.2;
}

.backlog-total-meta {
  font-size: 12px;
  color: var(--color-text-muted);
}

.backlog-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}

@media (min-width: 640px) {
  .backlog-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

@media (min-width: 1024px) {
  .backlog-grid {
    grid-template-columns: repeat(7, 1fr);
  }
}

.backlog-cell {
  padding: 12px;
  border-top: 1px solid var(--color-border);
  border-left: 1px solid var(--color-border);
}

.backlog-cell:first-child {
  border-left: 0;
}

@media (min-width: 1024px) {
  .backlog-cell {
    border-top: 0;
  }
  .backlog-cell:first-child {
    border-left: 0;
  }
  .backlog-cell + .backlog-cell {
    border-left: 1px solid var(--color-border);
  }
}

.backlog-cell-label {
  font-size: 11px;
  color: var(--color-text-muted);
}

.backlog-cell-value {
  font-size: 20px;
  font-weight: 600;
  margin-top: 2px;
}

.backlog-cell-meta {
  font-size: 11px;
  color: var(--color-text-muted);
  height: 14px;
  margin-top: 2px;
}

.backlog-cell-zero {
  color: var(--tw-gray-300);
}

/* status 颜色 (Next inline 配色 1:1) */
.pending {
  color: var(--tw-gray-700);
}
.queued {
  color: var(--tw-blue-700);
}
.running {
  color: var(--tw-sky-700);
}
.paused {
  color: var(--tw-amber-700);
}
.reviewing {
  color: var(--tw-purple-800);
}
.rejected {
  color: var(--tw-orange-600);
}
.failed {
  color: var(--tw-red-700);
}

.backlog-reviewing {
  padding: 14px 20px;
  border-top: 1px solid var(--color-border);
}

.backlog-reviewing-title {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}

.backlog-reviewing-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.backlog-reviewing-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.backlog-reviewing-email {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.backlog-reviewing-count {
  font-weight: 500;
  color: var(--tw-purple-800);
}

.backlog-reviewing-other {
  font-size: 12px;
  color: var(--color-text-muted);
}

.backlog-footer {
  padding: 8px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
  font-size: 11px;
  color: var(--color-text-muted);
}

/* ------------------------------------------------------------------ */
/*  Scope badge (页内 inline 徽标, 与 ScopeBadge.vue 组件的样式同步)   */
/* ------------------------------------------------------------------ */
.scope-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  vertical-align: middle;
  /* 🆕 R44: 加边框基线 (透明兜底), 三档各自的 border-color 让徽标在卡片标题
     里更立体, 与 master backlog panel 的 inline 徽标视觉权重对齐. */
  border: 1px solid transparent;
}

.scope-all {
  background: var(--tw-purple-100);
  color: var(--tw-purple-800);
  border-color: var(--tw-purple-300);
}

/* 🆕 R44: 补 .scope-owner 蓝色样式 — 当前 backlog panel 不会用到 (BacklogData
   只有 all/mine), 但保持与 ScopeBadge.vue 组件的样式基线一致, 防 inline 化
   场景漏色. */
.scope-owner {
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
  border-color: var(--tw-blue-300);
}

.scope-mine {
  background: var(--tw-gray-100);
  color: var(--tw-gray-600);
  border-color: var(--tw-gray-200);
}

/* ------------------------------------------------------------------ */
/*  Controls row (粒度 + 口径 Select)                                   */
/* ------------------------------------------------------------------ */
.controls-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.control-label {
  font-size: 13px;
  color: var(--color-text-muted);
}

.control-select {
  width: 128px;
}

.control-select-wide {
  width: 240px;
}

.control-meta {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* ------------------------------------------------------------------ */
/*  Stat cards (总量三卡)                                               */
/* ------------------------------------------------------------------ */
.stat-grid {
  display: grid;
  gap: 16px;
}

.stat-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.stat-box {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
}

.stat-box-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.stat-box-value {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  Tables (分桶表格 / 模型表 / 用户表)                                 */
/* ------------------------------------------------------------------ */
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.usage-table thead {
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: 11px;
}

.usage-table th {
  padding: 8px 12px;
  font-weight: 500;
  text-align: left;
}

.usage-table th.th-right {
  text-align: right;
}

.usage-table th.th-bar {
  width: 25%;
}

.usage-table td {
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  vertical-align: middle;
}

.usage-table td.td-left {
  text-align: left;
  color: var(--color-text);
}

.usage-table td.td-right {
  text-align: right;
  color: var(--tw-gray-700);
}

.usage-table td.td-strong {
  font-weight: 500;
  color: var(--color-text);
}

.usage-table td.td-muted {
  color: var(--color-text-muted);
}

.usage-table td.td-xs {
  font-size: 12px;
}

.usage-table td.td-bar {
  width: 25%;
}

.bucket-row {
  cursor: pointer;
  transition: background 0.1s;
}

.bucket-row:hover {
  background: var(--tw-gray-50);
}

.caret {
  display: inline-block;
  width: 12px;
  color: var(--color-text-muted);
  margin-right: 4px;
}

.model-row {
  background: rgba(243, 244, 246, 0.6);
}

.td-model {
  padding-left: 40px !important;
  font-size: 12px !important;
  color: var(--color-text-muted) !important;
}

.bar-track {
  width: 100%;
  height: 8px;
  background: var(--tw-gray-100);
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  min-width: 2px;
  background: var(--tw-blue-500-solid);
  border-radius: 4px;
}

/* ------------------------------------------------------------------ */
/*  Misc                                                                */
/* ------------------------------------------------------------------ */
.empty-line {
  padding: 32px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}

.muted-line {
  font-size: 13px;
  color: var(--color-text-muted);
}

.error-strip {
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  color: var(--tw-red-700);
  border-radius: 8px;
  padding: 14px 16px;
  font-size: 13px;
}
</style>
