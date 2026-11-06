<script setup lang="ts">
/* 功能: 版本看板视图 — 完整镜像 Next.js /[projectId]/[versionId]/page.tsx.
   Next.js 该页本身只是 RSC wrapper (import BoardClient + 走 listTasksPage),
   不渲染版本元数据 UI; 元数据展示走 Next 面包屑 + 上方 layout chrome.
   SPA 端同样拍板: 顶部条只渲染 项目名 + 版本名 + 返回链接 (1 行), 不展开
   元数据 dl 网格 (元数据展示属 R18 VersionDetailView.vue 范畴, 与 R25 是
   两个独立 entry, 不互相覆盖).

   数据源 (并发两路):
     - GET /api/projects/[id] 拿项目名 + 校验项目存在 (master route 暴露)
     - GET /api/versions/[id] 拿版本名 + 校验 version.project_id == projectId
       (master route.ts:38-46 同款两段校验, 跨项目 version 算 404)

   入口: hash 路由 /[projectId]/[versionId] (与 Next.js /[projectId]/[versionId]
   1:1 镜像), 路由声明顺序在 :projectId/wiki (R31) 之后、:projectId/:versionId/
   requirements/:id (R27) 之前 — 段数 2 vs 4 不冲突, 与 :projectId/wiki 同样
   2 段但 wiki 是 static 第二段优先匹配, 互不干扰.

   关注点 (R25 拍板, 与 R18 VersionDetailView 共存):
   - 不带元数据 dl 卡: Next.js 该页本身无 dl 渲染, R25 也不加. 需要元数据
     走 R18 (URL = /projects/:projectId/versions/:versionId, hash 模式).
   - 顶部 chrome 只一行: 项目名 + 版本名 (面包屑形式) + 返回项目链接.
     与 R29 ProjectUnversioned 的 "项目名 · 未挂版本任务" 同款风格, 简化版.
   - 复用 R14 BoardPage: 嵌入零配置, 它 useRoute() 自取 projectId/versionId,
     走 mode='version' 自动发 project + version 过滤参数, 不需要 props 透传.
   - 404 处理: project 404 → "项目不存在或无权限访问", 走 R13 ErrorView.
     version 404 OR version.project_id 不匹配 → "版本不存在或不属于该项目",
     同样走 ErrorView. 两个都是 show-retry=false (重试无效, 与 R17/R29 同款).
   - 路由变化重拉: watch projectId + versionId (route.params 切换时同一组件
     实例会被复用, onMounted 不重跑).
   - hideInTabs: 不设置 — 允许多版本同开多个 tab, tagName='version-board-{vId}'
     区分 (与 R18 'version-{vId}' 同款), 走 ProjectSidebar 版本行入口触发.
*/
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getProjectById, getVersionById } from '@/api/projects';
import type { Project, Version } from '@/api/projects';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import BoardPage from '@/views/BoardPage.vue';

const route = useRoute();
const router = useRouter();

/** 路由参数 projectId / versionId (强转 string 兜底). */
const projectId = computed(() => String(route.params.projectId));
const versionId = computed(() => String(route.params.versionId));

const project = ref<Project | null>(null);
const version = ref<Version | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const retrying = ref(false);

/** 404 文案 (与 master /api/versions/[id] route 行为对齐:
    项目 404 / 版本 404 / 版本不属于该项目 三种都视为 404). */
const NOT_FOUND_MSG = '版本不存在或不属于该项目';

/** 校验 project 是否拿到 (404 也归一为 error, 走 ErrorView showRetry=false). */
async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  project.value = null;
  version.value = null;
  try {
    // 并发两路, 任一失败各自分支处理.
    const [proj, ver] = await Promise.all([
      getProjectById(projectId.value),
      getVersionById(versionId.value),
    ]);
    project.value = proj;
    version.value = ver;
    // 任一缺失 → 视为不存在.
    if (!proj || !ver) {
      error.value = !proj ? '项目不存在或无权限访问' : NOT_FOUND_MSG;
    } else if (ver.project_id !== proj.id) {
      // version 存在但不属于该项目 → 当作 404 (master route 同款).
      error.value = NOT_FOUND_MSG;
    }
  } catch (e: unknown) {
    // getProjectById/getVersionById 内部已 catch → null; 这里兜底网络异常.
    error.value = e instanceof Error ? `网络异常: ${e.message}` : '加载失败';
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function onRetry(): void {
  retrying.value = true;
  void load();
}

function goBack(): void {
  void router.push(`/projects/${projectId.value}`);
}

/** 顶部标题: 项目名 + 版本名 拼接 (Next 端面包屑风格, 不带元数据 dl). */
const pageTitle = computed<string>(() => {
  if (project.value && version.value) {
    return `${project.value.name} · ${version.value.name}`;
  }
  if (version.value) return version.value.name;
  if (project.value) return project.value.name;
  return '版本看板';
});

onMounted(() => {
  void load();
});

/** route.params 切换 → 重拉 (route 切换不重挂载时也覆盖).
 *  R165 phase2: 本组件被 keep-alive 驻留、路由已走到别的页面时, params 变成
 *  空 → String() 出 'undefined' 字符串 → 打出 /api/projects/undefined [404]
 *  (实测 reqid 690/691) → 驻留期跳过. 切回 tab 时 params 从空恢复成本实例
 *  原值, watch 也会触发 (实测 reqid 692/693 多打两发全量 200) → 值没变也跳过.
 *  数据真变了的情况 (:key 同 path 下不会发生, 兜底留着) 才重拉; 看板数据由
 *  内嵌 BoardPage 的 onActivated 探针刷. */
const originProjectId = route.params.projectId ? String(route.params.projectId) : '';
const originVersionId = route.params.versionId ? String(route.params.versionId) : '';
watch([projectId, versionId], () => {
  if (!route.params.projectId || !route.params.versionId) return;
  if (projectId.value === originProjectId && versionId.value === originVersionId) return;
  void load();
});
</script>

<template>
  <div class="version-board">
    <header class="vb-header">
      <div class="vb-header-text">
        <h1 class="vb-title">{{ pageTitle }}</h1>
        <p v-if="project && version" class="vb-subtitle">该项目该版本下的任务看板</p>
      </div>
      <div class="vb-header-actions">
        <!-- R177: 画布总控制台互跳 (画布已替代版本看板作项目门面). -->
        <router-link :to="`/${projectId}/console`" class="btn btn-secondary" title="任务画布总控制台">
          🎬 画布
        </router-link>
        <button type="button" class="btn btn-secondary" @click="goBack">
          ← 返回项目
        </button>
      </div>
    </header>

    <!-- Initial loading (project + version 都没就绪) -->
    <div v-if="loading && !project && !version" class="vb-loading">
      <Loading size="lg" />
      <p class="vb-loading-text">加载中…</p>
    </div>

    <!-- 404 / 网络错 -->
    <ErrorView
      v-else-if="error"
      title="加载失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      :show-retry="error !== '项目不存在或无权限访问' && error !== NOT_FOUND_MSG"
      @retry="onRetry"
    />

    <!-- Content: 嵌入 BoardPage (version 模式自动从 route.params 取) -->
    <BoardPage v-else-if="project && version" />
  </div>
</template>

<style scoped>
.version-board {
  display: flex;
  flex-direction: column;
  /* R58.5: height 100% (不是 min-height: 100%) — 让 BoardPage 内部 .board-page
     用 height:100% 撑满此 wrapper, 跟 GlobalBoard 同款链路 (.gb-page height:100%
     撑满 .content-area). min-height:100% 让 VersionBoard 高度由内容驱动,
     短内容时 board-page 的 100% 找不到明确高度 = 退回内容高度, sticky 分页
     不靠底. 改成 height:100% 强制等于 content-area 高度 (= viewport - 92px
     AppHeader/TagsView). */
  height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

.vb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 12px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.vb-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.vb-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.vb-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}

.vb-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-muted);
}

.vb-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}

.vb-loading-text {
  margin: 0;
  font-size: 14px;
}
</style>