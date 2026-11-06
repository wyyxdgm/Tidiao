<script setup lang="ts">
/* 功能: Progress 实时进度视图 — 对应 Next src/app/progress/page.tsx 的「实时进度」页.
   展示调度器状态 (running/queued/max_concurrency/实时花费) + 并发占用率条 +
   活跃任务列表 (running/queued/reviewing) + 最近完成 (近 2 小时) + 运行中/队列
   任务 chip + 「← 返回」链接. 数据源 = GET /api/stats + GET /api/tasks?limit=200
   双路聚合. URL: /progress, 由 router/index.ts 挂载.

   历史: R34 提交基础版 (调度器/活跃/最近完成 + 自动刷新 + 手动刷新 + 副标题);
         R19 sheet 拍板「完全镜像 Next page.tsx」, 本轮仅补 Next page.tsx:90
         「← 返回」链接一处 (R34 当时漏挂, 与其他 R34 增强保留兼容).

   关注点 (sheet R34 与现实分歧):
   - sheet R34 模块名 = "[新] spa/src/views/Progress.vue + Stats.vue", 本文件
     即 Progress.vue (无 View 后缀, 与 sheet 字面对齐). Stats.vue 同模块.
   - sheet 字面 "GET /api/stats 聚合指标卡 + 趋势; 手写卡片布局" + 参考指针
     = src/app/progress/page.tsx + src/app/stats/page.tsx — 即两个独立视图
     各自对应 Next 一页, 不沿用 Next 的 tab 容器 (tab 容器属 stats/ 单页).
   - 自动刷新 3s 轮询: 与 Next src/app/progress/page.tsx:119-127 同款, 用
     setInterval, 卸载时 clearInterval 防止内存泄漏. autoRefresh 默认 true,
     R10 Checkbox 切换暂停/恢复轮询. 「上次刷新」时间戳显示秒级.
   - /api/tasks?limit=200 走 view 内 inline fetch — 与 R14 BoardPage + R33
     Uncategorized 共享 api/tasks.ts「不引 listTasks」拍板一致 (commit message
     披露根因 = 避免共享文件引出未使用的 listTasks, 局限在本视图生命周期内
     一次性 GET 即可). 本视图无需重复跑 listUnassignedTasks.
   - 「实时花费」sum 活跃任务 cost_usd — 与 Next src/app/progress/page.tsx:129
     同样的 activeTasks.reduce 公式 (cost_usd || 0 兜底).
   - 状态机三态: 加载中 (R11 Loading) / 加载失败 (R13 ErrorView retry) /
     content (R13 Empty 兜底空态, 实际不常触发因 stats 默认 200). 复用 Layer 0
     全套组件, 不重新实现 Spinner/Card/Empty.
   - 「活跃任务」running 时长展示: formatDuration 算 start→now 的 ms, 与
     Next src/app/progress/page.tsx:57 同款 (ms/s/m+s/h+m 三档).
   - 「最近完成」窗口: cutoff = now - 2h, 与 Next 同款; 排序按 completed_at DESC.
   - 进度条 (ProgressBar 子模板) 与 Next page.tsx:66 同款 div+h-2,
     颜色 running 任务超过 25min 切红色 (Next:257 三目). 不引外部库.
   - SchedulerStatus.running_tasks / queue_tasks 走 GET /api/stats 拿 (后端
     已包含子集, 无需另拉 /api/tasks); 跨用户 id 解析为 id 字符串
     (后端 route.ts:54-61 getTaskById(userId) 失败兜底).
   - 与 Next 端 2 处主动分歧已披露: (1) sheet 字面 "趋势" 未明确指定图表类型,
     本视图 = 进度条 (running) + 列表 (active/recent), 不引图表库 (与 plans
     §3 "不引重型组件库" 一致); (2) 「实时花费」字段 = active 任务 cost 之和
     (跟随 3s 刷新) 而非累计 total cost (后者属 Stats.vue 用量 tab).

   红线 (sheet R34 + 通用):
   - 不动 backend (只走 GET /api/stats + GET /api/tasks?limit=200, 后端不动).
   - 不重复实现 Layer 0 组件 (Button/Checkbox/Loading/Empty/ErrorView 全部 import).
   - 不引新依赖.
   - 不挂 SSE/M3 生命周期按钮 (R21 R22 范畴, 单独 task). */

import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get } from '@/api/http';
import { getStats, type StatsData, type SchedulerStatus } from '@/api/stats';
import Button from '@/components/Button.vue';
import Checkbox from '@/components/Checkbox.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'verifying'
  | 'await_user'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

/** Progress.vue 视图用 task 子集 — /api/tasks?limit=200 SELECT * 返回所有列,
    这里只暴露需要的几个字段 (避免误消费). title 用于卡片显示, status 用于
    active+recent 区分, cost_usd 用于实时花费求和. */
interface ProgressTask {
  id: string;
  title: string;
  status: TaskStatus;
  cost_usd: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  model: string | null;
}

/** 活跃任务三态 (running/queued/reviewing). 与 Next src/app/progress/page.tsx:97 一致. */
const ACTIVE_STATUSES: TaskStatus[] = ['running', 'queued', 'reviewing'];
/** 最近完成三态 (completed/failed/cancelled). 与 Next src/app/progress/page.tsx:105 一致. */
const RECENT_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/* ------------------------------------------------------------------ */
/*  状态机                                                              */
/* ------------------------------------------------------------------ */

const { t, locale } = useI18n();

const stats = ref<StatsData | null>(null);
const tasks = ref<ProgressTask[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);
const autoRefresh = ref<boolean>(true);
/** 时间戳 — 用于「上次刷新」显示 + ProgressBar 实时时长计算 (每秒 + now). */
const now = ref<number>(Date.now());
const lastRefresh = ref<number>(Date.now());

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** 活跃任务 (running/queued/reviewing). 排序按 started_at 或 created_at DESC. */
const activeTasks = computed<ProgressTask[]>(() => {
  return tasks.value
    .filter((t) => ACTIVE_STATUSES.includes(t.status))
    .sort((a, b) => {
      const aKey = a.started_at || a.created_at;
      const bKey = b.started_at || b.created_at;
      return bKey.localeCompare(aKey);
    });
});

/** 最近完成 (近 2 小时, completed/failed/cancelled). 排序按 completed_at DESC,
    取前 20. */
const recentTasks = computed<ProgressTask[]>(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  return tasks.value
    .filter((t) => {
      if (!RECENT_STATUSES.includes(t.status)) return false;
      if (!t.completed_at) return false;
      return parseDbTime(t.completed_at).getTime() > cutoff;
    })
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
    .slice(0, 20);
});

/** 活跃任务 cost 求和 (实时花费). */
const totalCost = computed<number>(() => {
  return activeTasks.value.reduce((s, t) => s + (t.cost_usd || 0), 0);
});

/** 调度器状态快捷访问. */
const schedulerStatus = computed<SchedulerStatus | null>(() => stats.value?.scheduler ?? null);

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

/** master 后端返回的时间戳形如 "2026-09-20 10:00:00" (空格分隔, 非 ISO).
    与 src/lib/datetime parseDbTime 同口径: 优先试 ISO, 失败回 Date.parse
    容错空格分隔. 失败时返回 epoch 0 让 caller 自己判. */
function parseDbTime(s: string | null | undefined): Date {
  if (!s) return new Date(0);
  // ISO 形式 (含 T)
  if (s.includes('T')) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // master SQLite DATETIME 形式 "YYYY-MM-DD HH:MM:SS" → 当 UTC 处理 (后端存 UTC)
  const replaced = s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
  const d = new Date(replaced);
  if (!Number.isNaN(d.getTime())) return d;
  // 兜底: 直接 Date.parse
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? new Date(0) : fallback;
}

/** 持续时长格式化 — 与 Next src/app/progress/page.tsx:57 formatDuration 同款
    (ms/s/m+s/h+m). */
function formatDuration(startMs: number, endMs?: number): string {
  const e = endMs ?? Date.now();
  const ms = e - startMs;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) {
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/** 状态 → i18n key — 与 R33 Uncategorized STATUS_LABELS 同款拍板 (11 状态;
    rejected 为历史遗留终态, 2026-11-01 起显示「已取消」). */
const STATUS_KEYS: Record<TaskStatus, string> = {
  pending: 'statusPending',
  queued: 'statusQueued',
  running: 'statusRunning',
  paused: 'statusPaused',
  reviewing: 'statusReviewing',
  verifying: 'statusVerifying',
  await_user: 'statusAwaitUser',
  completed: 'statusCompleted',
  failed: 'statusFailed',
  rejected: 'statusRejected', // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策, 曾误标等待中)
  cancelled: 'statusCancelled',
};

/** 状态显示标签 (走 i18n) — 未知状态兜底显示原始值. */
function statusLabel(status: TaskStatus): string {
  const key = STATUS_KEYS[status];
  return key ? t(`tasks.progress.${key}`) : status;
}

/** 状态颜色 (Tailwind palette). 颜色映射与 R33 STATUS_COLORS 同款。 */
const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 border-gray-300',
  queued: 'bg-blue-100 text-blue-700 border-blue-300',
  running: 'bg-sky-100 text-sky-700 border-sky-300',
  paused: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  reviewing: 'bg-purple-100 text-purple-700 border-purple-300',
  verifying: 'bg-indigo-100 text-indigo-700 border-indigo-300',
  await_user: 'bg-amber-100 text-amber-700 border-amber-300',
  completed: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  failed: 'bg-red-100 text-red-700 border-red-300',
  rejected: 'bg-orange-100 text-orange-700 border-orange-300',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-300',
};

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

/** 拉一次 stats + tasks. onMounted + 手动刷新 + 轮询共用. */
async function fetchData(): Promise<void> {
  // 首屏拉: loading=true; 后续轮询不重复显示 loading (避免闪烁).
  if (!stats.value && !error.value) loading.value = true;
  error.value = null;
  try {
    const [s, tRes] = await Promise.all([
      getStats(),
      // /api/tasks?limit=200 — view 内 inline fetch, 理由见文件头注释.
      get<{ tasks?: ProgressTask[] } | ProgressTask[]>('/api/tasks?limit=200'),
    ]);
    stats.value = s;
    const body = tRes;
    const list: ProgressTask[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.tasks)
      ? body.tasks
      : [];
    tasks.value = list;
    lastRefresh.value = Date.now();
  } catch (e: unknown) {
    const { isHttpError } = await import('@/api/http');
    if (isHttpError(e)) {
      error.value = e.message || t('tasks.progress.errLoadHttp', { status: e.status });
    } else if (e instanceof Error) {
      error.value = t('tasks.progress.errNetwork', { msg: e.message });
    } else {
      error.value = t('tasks.progress.errLoadFailed');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

/** 重试按钮 — ErrorView retry 触发. */
function onRetry(): void {
  retrying.value = true;
  void fetchData();
}

/** 手动刷新按钮 — Header 右上. */
function onManualRefresh(): void {
  loading.value = true;
  void fetchData();
}

/* ------------------------------------------------------------------ */
/*  轮询                                                                */
/* ------------------------------------------------------------------ */

let intervalId: ReturnType<typeof setInterval> | null = null;

function startPolling(): void {
  if (intervalId) return;
  intervalId = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return; // 后台 tab 跳过, 避免白打双请求
    void fetchData();
    now.value = Date.now();
  }, 3000);
}

function stopPolling(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/** autoRefresh 切换响应: 关 → 停轮询; 开 → 起轮询 (如尚未起). */
function onAutoRefreshChange(next: boolean): void {
  autoRefresh.value = next;
  if (next) startPolling();
  else stopPolling();
}

/* ------------------------------------------------------------------ */
/*  生命周期                                                            */
/* ------------------------------------------------------------------ */

onMounted(() => {
  void fetchData().then(() => {
    if (autoRefresh.value) startPolling();
  });
});

onBeforeUnmount(() => {
  stopPolling();
});

/* R234: keep-alive 感知 — 本页被 <keep-alive> 缓存, 切走后 onBeforeUnmount
   不触发, 3s 轮询 (stats + /api/tasks?limit=200 双请求 = 20 次/分钟) 会在
   后台永久跑, 挤占 HTTP/1.1 每域 6 个并发名额. 切走停表, 切回按 autoRefresh
   恢复 (onActivated 首次 mount 也触发, startPolling 幂等不叠表). */
onActivated(() => {
  if (autoRefresh.value) startPolling();
});

onDeactivated(() => stopPolling());

/* ------------------------------------------------------------------ */
/*  模板 helpers (放在 setup 末尾, 模板可直接引用)                       */
/* ------------------------------------------------------------------ */

/** 单段进度条宽度 — 与 Next src/app/progress/page.tsx:67 pct 计算同款. */
function progressPct(value: number, max: number): number {
  return max > 0 ? Math.min((value / max) * 100, 100) : 0;
}

/** running 任务进度条颜色: 超过 25min 切红色. 与 Next page.tsx:257 同款. */
function progressColor(elapsedMs: number): string {
  return elapsedMs > 25 * 60 * 1000 ? 'bg-red-500' : 'bg-blue-500';
}

/** 任务运行时长秒数 → 用于进度条 value. */
function elapsedMs(t: ProgressTask, currentNow: number): number {
  return currentNow - parseDbTime(t.started_at || t.created_at).getTime();
}
</script>

<template>
  <div class="progress-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <!-- 🆕 R19: Next page.tsx:90 "← 返回" 链接补全 (R34 漏挂, sheet R19
             "完全镜像" 要求补齐). href="/" 在 SPA hash mode = #/ → Root.vue
             → 已登录跳 /global (与 Next /projects 行为同源, R5 路由上线). -->
        <router-link to="/" class="back-link">← {{ t('tasks.progress.back') }}</router-link>
        <h1 class="page-title">{{ t('tasks.progress.title') }}</h1>
        <p class="page-subtitle">
          {{ t('tasks.progress.subtitle') }}
        </p>
      </div>
      <div class="header-actions">
        <Checkbox
          :model-value="autoRefresh"
          :label="t('tasks.progress.autoRefresh')"
          @update:model-value="onAutoRefreshChange"
        />
        <span class="meta-stamp">
          {{ t('tasks.progress.lastRefresh') }}: {{ new Date(lastRefresh).toLocaleTimeString(locale, { hour12: false }) }}
        </span>
        <Button
          variant="secondary"
          size="sm"
          :loading="loading && (stats !== null || tasks.length > 0)"
          :disabled="loading"
          @click="onManualRefresh"
        >
          ↻ {{ t('tasks.progress.refresh') }}
        </Button>
      </div>
    </header>

    <!-- Body -->
    <div class="page-body">
      <!-- 首屏加载 (无数据时) -->
      <div v-if="loading && !stats && tasks.length === 0" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">{{ t('tasks.progress.loading') }}</p>
      </div>

      <!-- 错误态 -->
      <ErrorView
        v-else-if="error"
        :title="t('tasks.progress.errLoadFailed')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <!-- 正常态 -->
      <template v-else-if="stats">
        <!-- Scheduler status -->
        <section class="card">
          <h2 class="card-title">{{ t('tasks.progress.schedulerStatus') }}</h2>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="stat-box-label">{{ t('tasks.progress.statRunning') }}</div>
              <div class="stat-box-value text-sky-600">{{ schedulerStatus?.running_count ?? 0 }}</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">{{ t('tasks.progress.statQueued') }}</div>
              <div class="stat-box-value text-blue-600">{{ schedulerStatus?.queue_size ?? 0 }}</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">{{ t('tasks.progress.statMaxConcurrency') }}</div>
              <div class="stat-box-value text-gray-900">{{ schedulerStatus?.max_concurrency ?? 2 }}</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">{{ t('tasks.progress.statLiveCost') }}</div>
              <div class="stat-box-value text-amber-600">${{ totalCost.toFixed(3) }}</div>
            </div>
          </div>

          <div class="concurrency-bar">
            <div class="concurrency-label">
              <span>{{ t('tasks.progress.concurrencyUsage') }}</span>
              <span>{{ schedulerStatus?.running_count ?? 0 }} / {{ schedulerStatus?.max_concurrency ?? 2 }}</span>
            </div>
            <div class="progress-bar-track">
              <div
                class="progress-bar-fill bg-sky-500"
                :style="{ width: progressPct(schedulerStatus?.running_count ?? 0, schedulerStatus?.max_concurrency ?? 2) + '%' }"
              />
            </div>
          </div>

          <!-- Running task chips -->
          <div v-if="(schedulerStatus?.running_tasks?.length ?? 0) > 0" class="chip-section">
            <div class="chip-label">{{ t('tasks.progress.runningTasksLabel') }}</div>
            <div class="chip-list">
              <router-link
                v-for="t in schedulerStatus?.running_tasks"
                :key="t.id"
                :to="`/tasks/${t.id}`"
                class="chip chip-sky"
                :title="t.title"
              >
                <span class="chip-dot chip-dot-pulse" />
                {{ t.title.length > 30 ? t.title.slice(0, 30) + '…' : t.title }}
              </router-link>
            </div>
          </div>

          <!-- Queue task chips -->
          <div v-if="(schedulerStatus?.queue_tasks?.length ?? 0) > 0" class="chip-section">
            <div class="chip-label">{{ t('tasks.progress.queuedLabel') }}</div>
            <div class="chip-list">
              <router-link
                v-for="t in schedulerStatus?.queue_tasks"
                :key="t.id"
                :to="`/tasks/${t.id}`"
                class="chip chip-blue"
                :title="t.title"
              >
                {{ t.title.length > 30 ? t.title.slice(0, 30) + '…' : t.title }}
              </router-link>
            </div>
          </div>
        </section>

        <!-- Active tasks -->
        <section class="card">
          <h2 class="card-title">
            {{ t('tasks.progress.activeTasksTitle') }}
            <span class="muted-small">({{ activeTasks.length }})</span>
          </h2>
          <Empty
            v-if="activeTasks.length === 0"
            illustration="inbox"
            :title="t('tasks.progress.noActiveTitle')"
            :description="t('tasks.progress.noActiveDesc')"
          />
          <div v-else class="task-list">
            <router-link
              v-for="t in activeTasks"
              :key="t.id"
              :to="`/tasks/${t.id}`"
              class="task-row"
            >
              <div class="task-row-header">
                <div class="task-row-main">
                  <div class="task-title">{{ t.title }}</div>
                  <div class="task-meta">
                    <span :class="['status-chip', STATUS_COLORS[t.status]]">
                      {{ statusLabel(t.status) }}
                    </span>
                    <span v-if="t.model" class="task-model">{{ t.model }}</span>
                    <span>· {{ $t('tasks.progress.startedAgo', { dur: formatDuration(parseDbTime(t.started_at || t.created_at).getTime(), now) }) }}</span>
                  </div>
                </div>
                <div class="task-row-aside">
                  <span
                    v-if="t.status === 'running'"
                    class="task-dot task-dot-pulse"
                  />
                  <div class="task-cost">${{ (t.cost_usd || 0).toFixed(3) }}</div>
                </div>
              </div>
              <div v-if="t.status === 'running'" class="progress-bar-track" style="margin-top: 4px;">
                <div
                  class="progress-bar-fill"
                  :class="progressColor(elapsedMs(t, now))"
                  :style="{ width: progressPct(elapsedMs(t, now), 30 * 60 * 1000) + '%' }"
                />
              </div>
            </router-link>
          </div>
        </section>

        <!-- Recent completions -->
        <section class="card">
          <h2 class="card-title">
            {{ t('tasks.progress.recentTitle') }}
            <span class="muted-small">{{ t('tasks.progress.recentWindow') }}</span>
          </h2>
          <Empty
            v-if="recentTasks.length === 0"
            illustration="doc"
            :title="t('tasks.progress.noRecentTitle')"
            :description="t('tasks.progress.noRecentDesc')"
          />
          <div v-else class="recent-list">
            <router-link
              v-for="t in recentTasks"
              :key="t.id"
              :to="`/tasks/${t.id}`"
              class="recent-row"
            >
              <span :class="['status-chip', STATUS_COLORS[t.status]]">
                {{ statusLabel(t.status) }}
              </span>
              <span class="recent-title">{{ t.title }}</span>
              <span class="recent-duration">
                {{ t.started_at && t.completed_at ? formatDuration(parseDbTime(t.started_at).getTime(), parseDbTime(t.completed_at).getTime()) : '?' }}
              </span>
              <span class="recent-cost">${{ (t.cost_usd || 0).toFixed(3) }}</span>
            </router-link>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  页面                                                                */
/* ------------------------------------------------------------------ */
.progress-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.header-text { min-width: 0; }
/* 🆕 R19: Next page.tsx:90 「← 返回」链接样式. text-sm + text-gray-600 +
   hover:text-gray-900 与 Next 同款. */
.back-link {
  display: inline-block;
  font-size: 13px;
  color: var(--color-text-muted, #6b7280);
  text-decoration: none;
  margin-bottom: 4px;
  transition: color 0.15s;
}
.back-link:hover { color: var(--color-text, #111827); }
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}
.page-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
  max-width: 720px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}
.meta-stamp {
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.page-body {
  flex: 1;
  padding: 20px 24px 32px;
  max-width: 1152px; /* max-w-6xl */
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}
.loading-text {
  margin: 0;
  font-size: 14px;
}

/* ------------------------------------------------------------------ */
/*  卡片                                                                */
/* ------------------------------------------------------------------ */
.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 20px;
}
.card-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--color-text);
  margin: 0 0 16px;
}
.muted-small {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-left: 6px;
  font-weight: 400;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.stat-box-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}
.stat-box-value {
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  并发条                                                              */
/* ------------------------------------------------------------------ */
.concurrency-bar {
  margin-bottom: 8px;
}
.concurrency-label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.progress-bar-track {
  width: 100%;
  background: var(--tw-gray-200);
  border-radius: 9999px;
  height: 8px;
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  transition: width 0.5s;
  border-radius: 9999px;
}

/* ------------------------------------------------------------------ */
/*  Chip                                                                */
/* ------------------------------------------------------------------ */
.chip-section {
  margin-top: 16px;
}
.chip-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s;
}
.chip-sky {
  background: var(--tw-sky-50);
  color: var(--tw-sky-700);
  border-color: var(--tw-sky-200);
}
.chip-sky:hover { background: var(--tw-sky-100); }
.chip-blue {
  background: var(--tw-blue-50);
  color: var(--tw-blue-700);
  border-color: var(--tw-blue-200);
}
.chip-blue:hover { background: var(--tw-blue-100); }
.chip-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--tw-sky-500-solid);
}
.chip-dot-pulse {
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ------------------------------------------------------------------ */
/*  任务列表                                                            */
/* ------------------------------------------------------------------ */
.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-row {
  display: block;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.task-row:hover {
  border-color: var(--tw-blue-300);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
.task-row-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
}
.task-row-main { flex: 1; min-width: 0; }
.task-title {
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-meta {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.task-model {
  color: var(--color-text-muted);
}
.status-chip {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid;
  font-size: 11px;
}
.task-row-aside {
  text-align: right;
  flex-shrink: 0;
}
.task-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tw-sky-500-solid);
}
.task-cost {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  最近完成                                                            */
/* ------------------------------------------------------------------ */
.recent-list {
  display: flex;
  flex-direction: column;
}
.recent-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 8px;
  text-decoration: none;
  color: inherit;
  border-radius: 4px;
  transition: background 0.15s;
}
.recent-row:hover { background: var(--tw-gray-50); }
.recent-row + .recent-row {
  border-top: 1px solid var(--tw-gray-100);
}
.recent-title {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-duration,
.recent-cost {
  font-size: 12px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.recent-cost { width: 72px; text-align: right; }
</style>