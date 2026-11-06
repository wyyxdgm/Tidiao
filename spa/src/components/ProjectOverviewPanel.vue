<script setup lang="ts">
/* 功能: 项目概览面板 —— 项目详情页第一个 tab (默认显示). 一块 markdown 看板:
   当前状态 + 常用链接 + 凭据备注. 人读的, 不是给 agent 消费的自动化配置.
   真相源 = DB (project_configs, AES-256-GCM 加密) —— 凭据不进 git, 也不落 cwd 文件.

   关注点:
   - 数据源: GET/PUT /api/projects/[id]/overview. GET 返回 {exists, markdown,
     updated_at, updated_by}; exists=false 渲染空态引导 (不是错误态).
   - 渲染走 markdown-it + @/lib/wiki-markdown 的链接规则 (与 Wiki 页同一份真相):
     跨项目 `project:{UUID}?path=` / 绝对路径命中 cwd / `task:{id}` / 相对 .md /
     裸 URL (飞书链接贴 URL 就自动成链).
   - 编辑态用 Textarea 纯文本编辑 —— 不做所见即所得, 用户要的就是「能改的 md」.
     保存走 PUT, 超限后端返 400, 原样透出原因.
   - 编辑内容与 ProjectDetailView 的元数据/版本列表**互不干扰**: 概览只写
     overview_md 一个 key, 不碰 projects 表.
   - 快捷链接区: 控制台 / Wiki / 需求点 / 新建任务 —— 概览页顶部的「常用链接」
     不用手写, 自动给可点的项目内入口. */

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getProjectOverview,
  saveProjectOverview,
  type ProjectOverview,
} from '@/api/project-overview';
import { get } from '@/api/http';
import { listVersions, type Version } from '@/api/projects';
import { createMarkdownRenderer, type ProjectCwdRef } from '@/lib/wiki-markdown';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Textarea from '@/components/Textarea.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** GET /api/projects 响应投影 —— 用于绝对路径 → 项目匹配 (与 Wiki 页同款). */
interface ProjectListItem {
  id: string;
  cwd: string | null;
}

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const toast = useToast();

const projectId = computed(() => String(route.params.projectId));

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const overview = ref<ProjectOverview | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const retrying = ref(false);

/** 编辑态: draft = textarea 里的正文, editing = 是否处于编辑中. */
const editing = ref(false);
const draft = ref('');
const saving = ref(false);

const versions = ref<Version[]>([]);
const projectsWithCwd = ref<ProjectCwdRef[]>([]);

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** markdown-it 实例 —— 链接规则与 Wiki 页共用 @/lib/wiki-markdown. */
const md = createMarkdownRenderer({
  getCurrentPath: () => 'INDEX.md',
  getProjectsWithCwd: () => projectsWithCwd.value,
  getAllowedExts: () => new Set(['md']),
  getProjectId: () => projectId.value,
});

/** 渲染后的 HTML. 空正文 → 空串 (空态由模板分支处理, 不渲 <p></p>). */
const bodyHtml = computed(() => {
  const src = overview.value?.markdown ?? '';
  if (!src.trim()) return '';
  return md.render(src);
});

/** 是否已有概览内容 (空态 vs 内容态). */
const hasContent = computed(() => (overview.value?.markdown ?? '').trim().length > 0);

/** 当前版本 (快捷链接跳需求点时用). */
const currentVersionId = computed(() => {
  const cur = versions.value.find((v) => v.is_current);
  return cur?.id ?? versions.value[0]?.id ?? null;
});

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

async function loadOverview(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    overview.value = await getProjectOverview(projectId.value);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

/** 版本列表 + 项目 cwd 列表 —— 供链接规则 (绝对路径命中项目) 使用. */
async function loadMeta(): Promise<void> {
  try {
    const [verRes, allRes] = await Promise.all([
      listVersions(projectId.value),
      get<{ projects: ProjectListItem[] }>('/api/projects'),
    ]);
    versions.value = Array.isArray(verRes?.versions) ? verRes.versions : [];
    projectsWithCwd.value = (allRes.projects ?? []).map((p) => ({
      id: p.id,
      cwd: p.cwd,
    }));
  } catch {
    // 元数据拿不到不影响概览正文渲染 —— 链接规则退化成「只认当前项目」.
  }
}

function loadAll(): void {
  void loadOverview();
  void loadMeta();
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

/** 进编辑态 —— draft 预填当前正文. */
function startEdit(): void {
  draft.value = overview.value?.markdown ?? '';
  editing.value = true;
}

/** 退出编辑态, 丢弃改动. */
function cancelEdit(): void {
  editing.value = false;
  draft.value = '';
}

/** 保存. 成功后切回只读 + 刷新元信息. 失败保留编辑态 (不丢用户写的字). */
async function save(): Promise<void> {
  saving.value = true;
  try {
    const saved = await saveProjectOverview(projectId.value, draft.value);
    overview.value = saved;
    editing.value = false;
    toast.success('概览已保存');
  } catch (e: unknown) {
    toast.error(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}

/** 快捷链接: 跳项目内各视图. */
function goto(path: string): void {
  void router.push(path);
}

/** 需求点入口 — 有当前版本跳版本需求页, 否则跳未挂版本需求页. */
function gotoRequirements(): void {
  const v = currentVersionId.value;
  goto(
    v
      ? `/projects/${projectId.value}/versions/${v}/requirements`
      : `/${projectId.value}/unversioned/requirements`,
  );
}

/** 新建任务 — 预填当前项目 + 当前版本. */
function gotoNewTask(): void {
  const v = currentVersionId.value;
  void router.push({
    path: '/tasks/new',
    query: v
      ? { project: projectId.value, version: v }
      : { project: projectId.value },
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** ISO 时间 → "YYYY-MM-DD HH:mm" 本地化. 解析失败回原值. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

onMounted(() => {
  loadAll();
});

/* keep-alive 复用时 onMounted 不重跑 —— 项目 id 变了要重新拉. */
watch(
  () => route.params.projectId,
  (newId, oldId) => {
    if (newId !== oldId) {
      editing.value = false;
      loadAll();
    }
  },
);
</script>

<template>
  <section class="overview-panel">
    <!-- 加载中 -->
    <div v-if="loading && !overview" class="state-block">
      <Loading size="lg" label="加载概览" />
      <p class="state-text muted">加载中…</p>
    </div>

    <!-- 错误 -->
    <ErrorView
      v-else-if="error"
      title="加载概览失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      @retry="retrying = true; loadOverview()"
    />

    <!-- 内容 -->
    <div v-else class="overview-body">
      <!-- 顶部: 标题 + 快捷链接 + 操作 -->
      <header class="ov-header">
        <div class="ov-header-left">
          <h3 class="ov-title">项目概览</h3>
          <span v-if="overview?.updated_at" class="ov-updated muted">
            最后更新 {{ formatDate(overview.updated_at) }}
          </span>
        </div>
        <div class="ov-actions">
          <Button v-if="!editing" variant="secondary" size="sm" @click="startEdit">
            ✏️ 编辑
          </Button>
        </div>
      </header>

      <!-- 常用链接: 项目内各视图入口 (不用手写, 自动可点) -->
      <nav class="ov-links" aria-label="项目内快捷入口">
        <button type="button" class="ov-link" @click="goto(`/${projectId}/console`)">
          🎬 控制台
        </button>
        <button type="button" class="ov-link" @click="goto(`/${projectId}/wiki`)">
          📚 Wiki
        </button>
        <button type="button" class="ov-link" @click="gotoRequirements">
          📋 需求点
        </button>
        <button type="button" class="ov-link" @click="gotoNewTask">
          ➕ 新建任务
        </button>
      </nav>

      <!-- 编辑态 -->
      <div v-if="editing" class="ov-editor">
        <Textarea
          v-model="draft"
          :rows="18"
          autosize
          placeholder="# 项目状态&#10;&#10;## 常用链接&#10;- [飞书表](https://...)&#10;- [任务](task:xxxxxxxx)&#10;&#10;## 凭据&#10;- 某某 key: ****"
        />
        <div class="ov-editor-actions">
          <Button variant="primary" :loading="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </Button>
          <Button variant="secondary" :disabled="saving" @click="cancelEdit">
            取消
          </Button>
        </div>
        <p class="ov-hint muted">
          支持 markdown: 链接 / 表格 / 代码块. 平台内跳转用
          <code>task:任务ID</code> 或相对 <code>.md</code> 路径, 外部链接贴 URL 即可.
        </p>
      </div>

      <!-- 只读态 -->
      <template v-else>
        <Empty
          v-if="!hasContent"
          illustration="folder"
          title="还没写概览"
          description="点右上「编辑」写一份 —— 项目状态、常用链接、凭据备注放这一个文件里"
          size="md"
        />
        <div v-else class="ov-markdown" v-html="bodyHtml"></div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.overview-panel {
  display: flex;
  flex-direction: column;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
}
.state-text {
  margin: 0;
  font-size: 13px;
}
.muted {
  color: var(--color-text-muted);
}

.overview-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ov-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ov-header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.ov-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.ov-updated {
  font-size: 12px;
}

/* 常用链接区 */
.ov-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ov-link {
  padding: 4px 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.ov-link:hover {
  border-color: var(--color-primary);
}
.ov-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
}

/* 编辑器 */
.ov-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ov-editor-actions {
  display: flex;
  gap: 8px;
}
.ov-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

/* markdown 正文 — 与 Wiki 页 .wiki-body-md 视觉对齐 */
.ov-markdown {
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}
.ov-markdown :deep(h1) { font-size: 1.5rem; font-weight: 700; margin: 20px 0 10px; }
.ov-markdown :deep(h2) { font-size: 1.25rem; font-weight: 700; margin: 18px 0 8px; }
.ov-markdown :deep(h3) { font-size: 1.08rem; font-weight: 600; margin: 14px 0 6px; }
.ov-markdown :deep(p) { margin: 10px 0; }
.ov-markdown :deep(ul) { list-style: disc; padding-left: 24px; margin: 10px 0; }
.ov-markdown :deep(ol) { list-style: decimal; padding-left: 24px; margin: 10px 0; }
.ov-markdown :deep(li) { margin: 3px 0; }
.ov-markdown :deep(code) {
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
  color: var(--tw-pink-600);
}
.ov-markdown :deep(pre) {
  background: var(--tw-gray-800);
  color: var(--tw-gray-100);
  padding: 14px;
  border-radius: var(--radius-md);
  overflow-x: auto;
  margin: 12px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.6;
}
.ov-markdown :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
}
.ov-markdown :deep(blockquote) {
  border-left: 4px solid var(--color-border);
  padding-left: 14px;
  color: var(--color-text-muted);
  margin: 12px 0;
}
.ov-markdown :deep(a) { color: var(--color-primary); text-decoration: none; }
.ov-markdown :deep(a:hover) { text-decoration: underline; }
/* 链接类型装饰 —— 与 Wiki 页 .md-link-* 同款 (跨项目 ↗ / 内部 📄 / 外链 ↗) */
.ov-markdown :deep(.md-link-cross)::after { content: ' ↗'; opacity: 0.6; font-size: 0.85em; }
.ov-markdown :deep(.md-link-internal.is-md)::after { content: ' 📄'; opacity: 0.6; font-size: 0.85em; }
.ov-markdown :deep(.md-link-internal.is-attachment)::after { content: ' 📎'; opacity: 0.6; font-size: 0.85em; }
.ov-markdown :deep(.md-link-external)::after { content: ' ↗'; opacity: 0.6; font-size: 0.85em; }
.ov-markdown :deep(table) { border-collapse: collapse; margin: 12px 0; }
.ov-markdown :deep(th),
.ov-markdown :deep(td) {
  border: 1px solid var(--color-border);
  padding: 6px 12px;
}
.ov-markdown :deep(th) { background: var(--color-bg); font-weight: 600; }
.ov-markdown :deep(hr) { border: none; border-top: 1px solid var(--color-border); margin: 20px 0; }
.ov-markdown :deep(img) { max-width: 100%; border-radius: var(--radius-md); }
</style>
