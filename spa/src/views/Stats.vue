<script setup lang="ts">
/* 功能: Stats 统计视图容器 — 4 tab (用量 / 维度 / 需求 / 周期).
   数据源: GET /api/stats (主数据), 各 tab 视需要自取额外数据
           (dimensions/requirements 取 /api/tasks?limit=200, periodic 取 projects + wiki tree).
   URL: /stats?tab={usage|dimensions|requirements|periodic}, router/index.ts 挂载.

   关注点 (sheet R18 与现实分歧):
   - sheet R18 模块名 = "[新] spa/src/views/Stats.vue" (无 View 后缀, 与 sheet 字面对齐).
   - sheet 字面 "完整镜像 Next /stats/page.tsx" — 本轮把 4 个 tab 全部实装:
     * UsageTab.vue (4 卡片 + 7 天 bar + tag conic-gradient + model bar)
     * DimensionsTab.vue (dim:* 聚合 + 双层 bar, 1:1 复刻 master dimensions.tsx)
     * RequirementsTab.vue (req:* 聚合 + 过滤 + 表格, 1:1 复刻 master requirements.tsx)
     * PeriodicTab.vue (项目仓 docs/stats/aggregated/ 渲染, 1:1 复刻 master periodic.tsx)
     字段集对齐 master src/lib/stats/{dimensions,requirements}-aggregate.ts +
     src/lib/stats/periodic-paths.ts + src/lib/tasks/tags.ts, 5 个纯函数 helper
     也 1:1 移植到 spa/src/lib/stats/ + spa/src/lib/tasks/.
   - 与 Next 端口径一致: StatsData 类型对齐 master src/app/api/stats/route.ts
     返回 (tasks/scheduler/cost 含 by_tag/by_model/by_day).
   - R55.3 B382: tab 切换持久化到 URL ?tab=, 复制链接 / 书签 / 后退栈都能恢复.
     master src/app/stats/tabs/Tabs.tsx:57 走 router.push(?tab=), SPA 1:1 沿用:
     onMounted 读 URL 恢复, tab click 写 URL (router.replace 不入 history 避免污染).
   - 不动 backend (只走 GET /api/stats, 后端不动).
   - 不引新依赖.
   - 不重复实现 Layer 0 组件 (Loading / ErrorView / Button 全部 import).

   红线 (sheet R18 + 通用):
   - 不动 backend / 不动 Layer 0 / 不引新依赖.
   - sheet 字面要求 = 完整镜像 Next /stats/page.tsx — 本轮 4 tab 全部上线.

   与 R34 实施时的差异:
   - R34 (commit 14b0981a) 只交付了 usage tab, 后 3 tab 标"二期实施占位".
   - sheet R18 字面 "完整镜像" = 本轮 4 tab 全部上线.
   - 拆 4 个 tab 到子目录 (spa/src/views/stats/), Stats.vue 留容器 + tab 切换. */

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { getStats, type StatsData } from '@/api/stats';
import { isHttpError } from '@/api/http';
import Button from '@/components/Button.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import UsageTab from './stats/UsageTab.vue';
import DimensionsTab from './stats/DimensionsTab.vue';
import RequirementsTab from './stats/RequirementsTab.vue';
import PeriodicTab from './stats/PeriodicTab.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                                */
/* ------------------------------------------------------------------ */

type TabId = 'usage' | 'dimensions' | 'requirements' | 'periodic';

interface TabDef {
  id: TabId;
  labelKey: string;
}

// tab 元数据: label 走 i18n key (misc.stats.tab*), 渲染时经 t() 转换 —— 模块级
// 中文常量非响应式, 语言切换不会更新, 故这里只存 key 不存文案.
const TABS: TabDef[] = [
  { id: 'usage', labelKey: 'misc.stats.tabUsage' },
  { id: 'dimensions', labelKey: 'misc.stats.tabDimensions' },
  { id: 'requirements', labelKey: 'misc.stats.tabRequirements' },
  { id: 'periodic', labelKey: 'misc.stats.tabPeriodic' },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.id));

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const { t } = useI18n();

/** tab 列表带本地化 label — computed 保证语言切换即时生效. */
const tabs = computed(() => TABS.map((tab) => ({ id: tab.id, label: t(tab.labelKey) })));

const stats = ref<StatsData | null>(null);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

const route = useRoute();
const router = useRouter();

/** R55.3 B382: tab 状态来源 = URL ?tab= (master Tabs.tsx:57 同款).
    初始化从 URL 恢复; 切换时 router.replace 写入, 不入 history 避免污染浏览器后退栈. */
function initialTabFromUrl(): TabId {
  const q = String(route.query.tab || '');
  return VALID_TABS.has(q) ? (q as TabId) : 'usage';
}

const currentTab = ref<TabId>(initialTabFromUrl());

/** tab 切换 → URL ?tab= (router.replace 不入 history). */
function setTab(tab: TabId): void {
  if (currentTab.value === tab) return;
  currentTab.value = tab;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (typeof v === 'string') next[k] = v;
  }
  if (tab === 'usage') delete next.tab; // 默认值不写 URL, 保持干净
  else next.tab = tab;
  void router.replace({ query: next });
}

/** URL 外部变化 (e.g. 后退按钮) 同步到 currentTab. */
watch(
  () => route.query.tab,
  (q) => {
    const tab = VALID_TABS.has(String(q || '')) ? (String(q) as TabId) : 'usage';
    if (tab !== currentTab.value) currentTab.value = tab;
  },
);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** UsageTab + DimensionsTab 共享 props — 只取 cost 子集传给 DimensionsTab. */
const costProps = computed(() => stats.value?.cost ?? { total: 0, by_tag: {}, by_model: {}, by_day: [] });

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function fetchData(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    stats.value = await getStats();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('misc.stats.loadFailedHttp', { status: e.status });
    } else if (e instanceof Error) {
      error.value = t('misc.stats.errNetwork', { msg: e.message });
    } else {
      error.value = t('misc.stats.loadFailed');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function onRetry(): void {
  retrying.value = true;
  void fetchData();
}

function onManualRefresh(): void {
  loading.value = true;
  void fetchData();
}

onMounted(() => {
  void fetchData();
});
</script>

<template>
  <div class="stats-page">
    <!-- R50.2 B381: 顶部返回链接 — 对应 master src/app/stats/page.tsx:19-21.
         注意 master 用 Link href="/" (平台首页); SPA 路由里平台首页 = /global
         (root 路径 / 是带子路由的 LayoutContainer, 没有可用落地页). -->
    <div class="back-link-row">
      <router-link to="/global" class="back-link">{{ t('misc.stats.back') }}</router-link>
    </div>

    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('misc.stats.title') }}</h1>
        <p class="page-subtitle">
          {{ t('misc.stats.subtitle') }}
        </p>
      </div>
      <div class="header-actions">
        <Button
          variant="secondary"
          size="sm"
          :loading="loading && stats !== null"
          :disabled="loading"
          @click="onManualRefresh"
        >
          ↻ {{ t('misc.stats.refresh') }}
        </Button>
      </div>
    </header>

    <!-- Tab bar -->
    <nav class="tab-bar" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="currentTab === tab.id"
        :class="['tab-btn', currentTab === tab.id ? 'tab-btn-active' : 'tab-btn-default']"
        @click="setTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- Body -->
    <main class="page-body">
      <!-- 加载态 (顶层) — 后 3 tab 自己有内层 loading, usage 共享本态. -->
      <div v-if="loading && !stats && currentTab === 'usage'" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">{{ t('misc.stats.loading') }}</p>
      </div>

      <!-- 顶层错误态 — 仅 usage tab 依赖顶层 stats; 后 3 tab 各自 fetch 不共用. -->
      <ErrorView
        v-else-if="error && currentTab === 'usage'"
        :title="t('misc.stats.loadFailed')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <!-- Usage tab -->
      <template v-else-if="currentTab === 'usage' && stats">
        <UsageTab :stats="stats" />
      </template>

      <!-- Dimensions tab — 自带 fetch + 加载/错误态 -->
      <DimensionsTab v-else-if="currentTab === 'dimensions'" :cost="costProps" />

      <!-- Requirements tab — 自带 fetch + 加载/错误态 -->
      <RequirementsTab v-else-if="currentTab === 'requirements'" />

      <!-- Periodic tab — 自带 fetch + 加载/错误态 -->
      <PeriodicTab v-else-if="currentTab === 'periodic'" />
    </main>
  </div>
</template>

<style scoped>
.stats-page {
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
.header-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.page-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--tw-gray-900);
}
.page-subtitle {
  font-size: 13px;
  color: var(--tw-gray-500);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.tab-bar {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.tab-btn {
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: transparent;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.tab-btn-default {
  color: var(--tw-gray-500);
}
.tab-btn-default:hover {
  color: var(--tw-gray-900);
}
.tab-btn-active {
  color: var(--tw-blue-700);
  border-bottom-color: var(--tw-blue-500);
}

.page-body {
  flex: 1;
  min-height: 0;
  padding: 20px 24px 24px;
  max-width: 1024px;
  width: 100%;
  margin: 0 auto;
  overflow-y: auto;
}

.loading-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 0;
}
.loading-text {
  font-size: 13px;
  color: var(--tw-gray-400);
}

.back-link-row {
  padding: 8px 24px 0;
  background: var(--color-bg-elevated);
}
.back-link {
  color: var(--tw-gray-500);
  font-size: 13px;
  text-decoration: none;
}
.back-link:hover { color: var(--tw-gray-900); }
</style>
