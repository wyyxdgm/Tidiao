<script setup lang="ts">
/* 功能: 周期统计 tab —— 1:1 镜像 Next.js src/app/stats/tabs/periodic.tsx.
   数据源:
     - GET /api/projects 拿本账号可见的所有项目 (list.id + list.name + list.cwd)
     - 每个项目调 GET /api/projects/[id]/wiki/tree, 客户端过滤 docs/stats/aggregated/
   渲染: 4 stat 卡 + 项目卡片列表 (内含 daily/weekly/monthly/yearly/other 桶).

   关注点:
   - 不跑 SQL, 不 AI 总结: 走 C4 拍板的"项目仓自带汇总最准"路线, 主 partner 仅
     渲染路径列表 (与 Next periodic.tsx:11 拍板一致).
   - 单文件渲染走 wiki API (?path=docs/stats/aggregated/<file>.md), 这里只列出 link.
   - 链接形如 `/{projectId}/wiki?path=<encoded>`, 跳 SPA 内 wiki 页 (master 路径形态
     1:1 沿用; SPA router 已有 wiki 路由 R31, 当前点击走 router.push 同 SPA 内跳转
     — G2 收口硬跳转, R18 原走整页跳 Next 已不必要).
   - 项目没 aggregated 目录 (或 cwd 不存在) 静默跳过, 不污染页面.
   - 周期桶: 日 / 周 / 月 / 年 / 其他 (helper 在 src/lib/stats/periodic-paths.ts).

   状态机:
   - 加载: projects==null || aggregates==null → 加载中
   - 错误: err 红字
   - 数据: 4 stat + 项目卡片列表 + 底部提示.

   与 Next 端 1:1 复刻:
   - 4 stat 卡 (项目数 / 有聚合报告 / 聚合文件总数 / 无 aggregated/ 目录).
   - 每个项目卡片: 标题 + "N 个文件" + 桶 label + chip 链接 (跳 wiki).
   - 底部: projectsNoData 提示.
   - i18n (W4b): 用户可见文案走 t('misc.stats.periodicTab.*'); BUCKET_LABEL
     中文 label 改走 bucketLabel() 动态翻译 (语言切换即时生效). */

import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get } from '@/api/http';
import { listProjects, type Project } from '@/api/projects';
import {
  collectUnderPrefix,
  groupByBucket,
  type WikiTreeNode,
  type PeriodicFile,
  type PeriodicBucket,
} from '@/lib/stats/periodic-paths';

/* ------------------------------------------------------------------ */
/*  types                                                                */
/* ------------------------------------------------------------------ */

interface ProjectAggregate {
  project: Project;
  files: PeriodicFile[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  const                                                                */
/* ------------------------------------------------------------------ */

const PREFIX = 'docs/stats/aggregated';

const { t } = useI18n();

const BUCKETS: PeriodicBucket[] = ['daily', 'weekly', 'monthly', 'yearly', 'other'];

/** 桶 label 走 t() 动态翻译 (语言切换即时生效) — 原 BUCKET_LABEL 常量表. */
function bucketLabel(b: PeriodicBucket): string {
  return t(`misc.stats.periodicTab.bucket${b.charAt(0).toUpperCase()}${b.slice(1)}`);
}

/* ------------------------------------------------------------------ */
/*  state                                                                */
/* ------------------------------------------------------------------ */

const projects = ref<Project[] | null>(null);
const aggregates = ref<ProjectAggregate[] | null>(null);
const err = ref<string | null>(null);

/* ------------------------------------------------------------------ */
/*  fetch                                                                */
/* ------------------------------------------------------------------ */

async function fetchData(): Promise<void> {
  try {
    const resp = await listProjects();
    const list: Project[] = Array.isArray(resp.projects) ? resp.projects : [];
    projects.value = list;

    // 并行拉每个项目的 wiki/tree
    const results = await Promise.all(
      list.map(async (p: Project) => {
        if (!p.cwd) {
          return { project: p, files: [], error: 'no-cwd' };
        }
        try {
          const r = await get<{ tree: WikiTreeNode[] }>(`/api/projects/${p.id}/wiki/tree`);
          const tree: WikiTreeNode[] = Array.isArray(r.tree) ? r.tree : [];
          const files = collectUnderPrefix(tree, PREFIX);
          return { project: p, files };
        } catch (e: unknown) {
          return { project: p, files: [], error: e instanceof Error ? e.message : String(e) };
        }
      })
    );
    aggregates.value = results;
  } catch (e: unknown) {
    err.value = e instanceof Error ? e.message : String(e);
    projects.value = [];
    aggregates.value = [];
  }
}

onMounted(() => {
  void fetchData();
});

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const projectsWithFiles = computed<ProjectAggregate[]>(() => {
  return (aggregates.value ?? []).filter((a) => a.files.length > 0);
});
const totalFiles = computed<number>(() => {
  return (aggregates.value ?? []).reduce((s, a) => s + a.files.length, 0);
});
const projectsNoData = computed<number>(() => {
  return (aggregates.value ?? []).length - projectsWithFiles.value.length;
});
const isLoading = computed<boolean>(() => {
  return (projects.value === null || aggregates.value === null) && err.value === null;
});

/* ------------------------------------------------------------------ */
/*  工具                                                                */
/* ------------------------------------------------------------------ */

function fileHref(projectId: string, filePath: string): string {
  return `/${projectId}/wiki?path=${encodeURIComponent(filePath)}`;
}
</script>

<template>
  <div class="periodic-tab">
    <!-- 错误态 -->
    <div v-if="err" class="text-sm text-red-600">{{ t('misc.stats.periodicTab.loadFailed', { msg: err }) }}</div>

    <!-- 加载态 -->
    <div
      v-else-if="isLoading"
      class="min-h-[200px] flex items-center justify-center text-gray-400"
    >
      {{ t('misc.stats.periodicTab.loading') }}
    </div>

    <template v-else>
      <div class="card">
        <h2 class="card-title">{{ t('misc.stats.periodicTab.title') }}</h2>
        <p class="card-desc">
          {{ t('misc.stats.periodicTab.descA') }} <code>&lt;project&gt;/docs/stats/aggregated/</code>{{ t('misc.stats.periodicTab.descB') }}
        </p>

        <div class="stat-grid">
          <div class="stat-card-soft">
            <div class="stat-card-label">{{ t('misc.stats.periodicTab.statProjects') }}</div>
            <div class="stat-card-value">{{ aggregates?.length ?? 0 }}</div>
          </div>
          <div class="stat-card-soft">
            <div class="stat-card-label">{{ t('misc.stats.periodicTab.statWithReports') }}</div>
            <div class="stat-card-value">{{ projectsWithFiles.length }}</div>
          </div>
          <div class="stat-card-soft">
            <div class="stat-card-label">{{ t('misc.stats.periodicTab.statTotalFiles') }}</div>
            <div class="stat-card-value">{{ totalFiles }}</div>
          </div>
          <div class="stat-card-soft">
            <div class="stat-card-label">{{ t('misc.stats.periodicTab.statNoDir') }}</div>
            <div class="stat-card-value">{{ projectsNoData }}</div>
          </div>
        </div>

        <template v-if="projectsWithFiles.length === 0">
          <p class="empty-state">
            {{ t('misc.stats.periodicTab.emptyA') }} <code>docs/stats/aggregated/</code>{{ t('misc.stats.periodicTab.emptyB') }}
          </p>
        </template>

        <div v-else class="project-list">
          <div
            v-for="agg in projectsWithFiles"
            :key="agg.project.id"
            class="project-card"
          >
            <div class="project-card-header">
              <h3 class="project-name">{{ agg.project.name }}</h3>
              <span class="muted-tiny">{{ t('misc.stats.periodicTab.filesCount', { n: agg.files.length }) }}</span>
            </div>
            <div class="bucket-list">
              <template v-for="b in BUCKETS" :key="b">
                <div v-if="groupByBucket(agg.files)[b].length > 0" class="bucket-block">
                  <div class="bucket-label">
                    {{ bucketLabel(b) }}（{{ groupByBucket(agg.files)[b].length }}）
                  </div>
                  <div class="file-chips">
                    <router-link
                      v-for="f in groupByBucket(agg.files)[b]"
                      :key="f.path"
                      :to="fileHref(agg.project.id, f.path)"
                      class="file-chip"
                      :title="f.path"
                    >
                      {{ f.name }}
                    </router-link>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <p v-if="projectsNoData > 0" class="muted-tiny">
        {{ t('misc.stats.periodicTab.noDataHintA', { n: projectsNoData }) }} <code>docs/stats/aggregated/</code>{{ t('misc.stats.periodicTab.noDataHintB') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.periodic-tab {
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

.project-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.project-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 16px;
}
.project-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.project-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--tw-gray-900);
}

.bucket-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bucket-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bucket-label {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-bottom: 4px;
}
.file-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.file-chip {
  display: inline-block;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--tw-gray-700);
  cursor: pointer;
  transition: all 0.15s;
}
.file-chip:hover {
  border-color: var(--tw-blue-400);
  background: var(--tw-blue-50);
  color: var(--tw-blue-700);
}
</style>
