<script setup lang="ts">
/* 功能: 项目详情页 — 三个 tab 切换: **概览** (默认) / 元数据 / 版本列表.
   概览 = 单文件 markdown 看板 (状态 + 常用链接 + 凭据备注), 人读的;
   元数据/版本列表 = R17 原有的字段展示 (名/描述/cwd/ports/… + 版本清单).

   数据源唯一 = GET /api/projects/[id] + GET /api/versions?project=id
   + GET /api/projects/[id]/overview. 与 Next src/app/[projectId]/page.tsx (redirect 用)
   的分歧拍板:
     1) Next 是 redirect-only — 拿到 current_version_id 就跳走. R17 显式要求"显示
        项目元数据 + 版本列表", 拍在 R17 sheet 不再 redirect. 用户从项目列表点进来
        先看到项目卡片 + 版本列表, 再点具体版本才进看板.
     2) 版本列表直接调 /api/versions?project=, 不复用 store 缓存 — R17 红线"只动
        ProjectDetailView.vue", 暂不扩 store 接口.
     3) "+版本" — R172 迭代: 原 stub (toast 提示) 换成真表单, 内联展开
        NewVersionForm (含 AI 解析输入, 与项目列表页共用组件), 创建成功刷新版本列表.
   关注点:
   - URL: /projects/:projectId, route.params.projectId 取值, 不再 from store.
   - 错误处理: HttpError → message; 网络错 → "网络异常"; 兜底 → "加载失败" (与
     BoardPage loadPage 同口径, 风格一致).
   - 版本行点击 = router.push 到 /projects/:projectId/versions/:versionId (与
     M1 router 已挂路由对齐). 当前版本标 "current" 徽章 (视觉锚点 + 提示用户
     这是 Next 默认跳转目标).
   - 🔴 tab 状态**不进 URL** (不引 ?tab= query): 概览是默认落地页, 加 query 会让
     「分享项目页链接」带上一次性状态. 切换只在组件内 (ref), 刷新回到默认 tab
     —— 这正是想要的 (概览是门面). */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, HttpError, isHttpError } from '@/api/http';
import { listVersions, updateProject, updateVersion, type Version } from '@/api/projects';
import { getScopeCounts, type ScopeCounts } from '@/api/stats';
import { parseDbTime } from '@/lib/datetime';
import { useToast } from '@/composables/useToast';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Checkbox from '@/components/Checkbox.vue';
import NewVersionForm from '@/components/NewVersionForm.vue';
import ProjectLlmConfigPanel from '@/components/ProjectLlmConfigPanel.vue';
import ProjectAdvancedOptionsPanel from '@/components/ProjectAdvancedOptionsPanel.vue';
import ProjectOverviewPanel from '@/components/ProjectOverviewPanel.vue';
import { useTagsStore } from '@/stores/tags';
import { formatProjectTitle } from '@/lib/format-tab-title';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** /api/projects/[id] 响应投影. 字段集对齐 master src/lib/db/projects.ts 的
    Project (id/name/description/cwd/ports/created_at/current_version_id/...).
    created_at 服务端返回 ISO 字符串, 客户端不再 number 化. */
interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  /** 后端 GET 直接 SELECT 出 DB 列 = JSON 字符串 ("[13001,13002]"), 不是
      number[] — master getProjectById 没解析. formatPorts 容错 string /
      array / null. */
  ports: number[] | string | null;
  created_at: string;
  current_version_id: string | null;
  current_version_name: string | null;
  // R70 advanced-options 字段 — 与 master Project (DB 列) 1:1 对齐.
  // 后端 GET 直接 SELECT 不解析 (与 ports 同款), 容错 string / array / null.
  parallel_limit?: number | null;
  timeout_minutes?: number | null;
  wiki_extra_extensions?: string[] | string | null;
  runners?: Array<{
    runner_id: string;
    purpose: string;
    cwd_mapping: string;
    command_patterns: string[];
    os_type?: string;
  }> | string | null;
}

/* ------------------------------------------------------------------ */
/*  Route + stores                                                     */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();

/** 路由参数 projectId. 强转 string 兜底 (Vue Router 4 params 类型推断为
    string | string[], 这里我们走的是 :projectId 单段). */
const projectId = computed(() => String(route.params.projectId));

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const project = ref<ProjectDetail | null>(null);

/** R59: tab 标题 = 项目名 (≤8 字, 走 R59 统一截断规则). applyTitle 内部
 *  尊重 customTitle (用户手动重命名过 → 自定义标题保留, 自动标题不再覆
 *  盖). 必须在 project 声明后注册 — watch 的 getter 在 setup 阶段被同
 *  步调用一次建立依赖追踪, 提前引用 project 会撞 TDZ (跟 TaskDetailView
 *  同款踩坑). */
const tags = useTagsStore();
watch(
  () => project.value?.name,
  (name) => {
    if (!name) return;
    tags.applyTitle(route.path, formatProjectTitle(name));
  },
);
const versions = ref<Version[]>([]);
const loading = ref(false);
const loadingVersions = ref(false);
const error = ref<string | null>(null);
const retrying = ref(false);

/** "+版本" 展开状态 — R172 迭代: stub 换真表单 (NewVersionForm 内联展开). */
const showNewVersion = ref(false);

/* ------------------------------------------------------------------ */
/*  Tabs (2026-11-01: 项目概览落地)                                     */
/* ------------------------------------------------------------------ */

/** 当前 tab. overview = 默认 (单文件 md 看板); meta = 元数据; versions = 版本列表. */
type ProjectTab = 'overview' | 'meta' | 'versions';
const activeTab = ref<ProjectTab>('overview');

/** tab 列表 — 标签与顺序在这里定, 模板 v-for 渲染. */
const TABS: Array<{ key: ProjectTab; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'meta', label: '元数据' },
  { key: 'versions', label: '版本' },
];

/* ------------------------------------------------------------------ */
/*  R176 (飞书): 版本行内联编辑 — 版本名/描述/飞书 URL/Sheet 名/自动派发   */
/* ------------------------------------------------------------------ */

const toast = useToast();
const editingVersionId = ref<string | null>(null);
const editName = ref('');
const editDescription = ref('');
const editFeishuUrl = ref('');
const editFeishuSheet = ref('');
/** v512 语义: true = sheetwatch 扫这张表; 缺字段按 1 (启用) 处理. */
const editEnable = ref(true);
const savingVersion = ref(false);

/** 点「编辑」→ 展开面板 + 预填当前值. 镜像 ProjectsView.startEditVersion,
 *  多一个 name 字段 (R176 要求「版本相关信息」也可改). */
function startEditVersion(v: Version): void {
  if (editingVersionId.value === v.id) {
    cancelEditVersion();
    return;
  }
  editingVersionId.value = v.id;
  editName.value = v.name;
  editDescription.value = v.description ?? '';
  editFeishuUrl.value = v.feishu_url ?? '';
  editFeishuSheet.value = v.feishu_sheet ?? '';
  editEnable.value = v.enable !== 0;
}

function cancelEditVersion(): void {
  editingVersionId.value = null;
  editName.value = '';
  editDescription.value = '';
  editFeishuUrl.value = '';
  editFeishuSheet.value = '';
  editEnable.value = true;
}

/** PATCH /api/versions/[id] — trim + 空串转 null (留空保存即清除绑定, 与
 *  ProjectsView.saveEditVersion 同口径). name 必填非空. 成功后 toast +
 *  收起面板 + 重拉版本列表 (行标签「飞书 · 监听中/已关」跟着 enable 刷新). */
async function saveEditVersion(v: Version): Promise<void> {
  const name = editName.value.trim();
  if (!name) {
    toast.error('版本名不能为空');
    return;
  }
  savingVersion.value = true;
  try {
    await updateVersion(v.id, {
      name,
      description: editDescription.value.trim() || null,
      feishu_url: editFeishuUrl.value.trim() || null,
      feishu_sheet: editFeishuSheet.value.trim() || null,
      enable: editEnable.value,
    });
    toast.success(`版本「${name}」已更新`);
    cancelEditVersion();
    await loadVersions();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(`保存失败: ${e.message}`);
    } else {
      toast.error('保存失败');
    }
  } finally {
    savingVersion.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  R70 inline panel state (LLM 配置 + 高级选项)                         */
/* ------------------------------------------------------------------ */

/** 详情页只展示单个项目 — 两面板互斥 (单项目不需 projectId, 简化为 boolean).
    切换类型自动关另一. */
const editingLlm = ref<boolean>(false);
const editingAdvanced = ref<boolean>(false);
function toggleLlmPanel(): void {
  editingLlm.value = !editingLlm.value;
  if (editingLlm.value) editingAdvanced.value = false;
}
function toggleAdvancedPanel(): void {
  editingAdvanced.value = !editingAdvanced.value;
  if (editingAdvanced.value) editingLlm.value = false;
}

/** R70: scope counts — per-version 徽章数据源. 单项目详情只需 key
    "{projectId}:{versionId}", 不需要累加 (每个 version 行独立显示). */
const scopeCounts = ref<Record<string, ScopeCounts>>({});

async function loadScopeCounts(force = false): Promise<void> {
  if (!force && Object.keys(scopeCounts.value).length > 0) return;
  try {
    scopeCounts.value = await getScopeCounts();
  } catch {
    // 静默失败 — 徽章不渲染.
  }
}

/** per-version task counts. 缺 key 返 0 (version 删除后自然没 key). */
function versionTaskCounts(versionId: string): ScopeCounts {
  const c = scopeCounts.value[`${projectId.value}:${versionId}`];
  return c ?? { running: 0, reviewing: 0, paused: 0, total: 0 };
}

/** advanced 面板更新后 — 重载项目字段 (parallel_limit / timeout_minutes /
   runners / ports 跟新). scopeCounts 任务数理论上不动, 保险起见也强刷. */
async function refreshAfterPanelUpdate(): Promise<void> {
  await Promise.all([loadProject(), loadScopeCounts(true)]);
}

/** ProjectDetail → Project 类型适配 (created_at: string → number). 后端
    /api/projects/[id] 实际返 ISO string, 但 Project 类型定义 created_at 为
    number — 同 Settings.vue / BoardPage 等其他视图一致. AdvancedOptionsPanel
    只读字段 (id / parallel_limit / timeout_minutes / wiki_extra_extensions /
    runners / ports), 不依赖 created_at, cast 安全. */
const projectForPanel = computed<import('@/api/projects').Project | null>(() => {
  if (!project.value) return null;
  return {
    ...project.value,
    created_at: typeof project.value.created_at === 'string'
      // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏 8h.
      ? parseDbTime(project.value.created_at)?.getTime() ?? 0
      : project.value.created_at,
  } as import('@/api/projects').Project;
});

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 是否有版本. 决定主区显示 list 还是 Empty. */
const hasVersions = computed(() => versions.value.length > 0);

/** 时间戳 → "YYYY-MM-DD HH:mm" 本地化. 兼容 string (ISO, project.created_at) 和
    number (timestamp ms, version.created_at — 旧 api/projects.ts 类型 bug, 本文件不修
    只适配). Date 解析保稳, 解析失败回原值. */
function formatDate(iso: string | number | null): string {
  if (iso === null || iso === undefined) return '—';
  // number 当 ms 时间戳处理; string 走 parseDbTime 当 UTC 处理 (R205, 旧
  // new Date(iso) 在 CST 偏早 8h).
  const d = typeof iso === 'number' ? new Date(iso) : parseDbTime(iso);
  if (!d || Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ports 渲染: DB 列存 JSON 字符串 ("[13001, 13002]"), master
    getProjectById 不解析直接 SELECT 出 — 后端实际返 string, 不是 number[].
    也兼容 SPA 入参 (PATCH 时接受 CSV 字符串) 和 null. 解析后 join; 解析失败 /
    空数组 → "—". 跟 ProjectsView "前端 split → number[]" 同口径.
    关注点: 字符串 trim + startsWith('[') 判定 JSON vs CSV — 后端 JSON 形式优先
    (实际数据 100% 是 JSON, CSV 仅 POST/PATCH 入参; 这里只读不改, 防御性兼容). */
function formatPorts(ports: number[] | string | null): string {
  if (ports == null) return '—';
  let arr: number[];
  if (Array.isArray(ports)) {
    arr = ports;
  } else if (typeof ports === 'string') {
    const s = ports.trim();
    try {
      const parsed = s.startsWith('[') ? JSON.parse(s) : s.split(',');
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      return '—';
    }
  } else {
    return '—';
  }
  if (arr.length === 0) return '—';
  return arr.map((n) => String(n)).join(', ');
}

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

async function loadProject(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await get<{ project: ProjectDetail }>(`/api/projects/${projectId.value}`);
    project.value = data.project;
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      error.value = e.message || `请求失败 (HTTP ${e.status})`;
    } else if (e instanceof Error) {
      error.value = `网络异常: ${e.message}`;
    } else {
      error.value = '加载失败';
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

async function loadVersions(): Promise<void> {
  loadingVersions.value = true;
  try {
    const data = await listVersions(projectId.value);
    versions.value = Array.isArray(data?.versions) ? data.versions : [];
  } catch {
    // 版本列表失败不阻断项目元数据展示 — 主区已成功, 版本区只显示空态 + 错误条.
    versions.value = [];
  } finally {
    loadingVersions.value = false;
  }
}

function loadAll(): void {
  void loadProject();
  void loadVersions();
  void loadScopeCounts();
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

/** 重试按钮: 仅重试元数据加载 (主信息); 版本列表若无数据按需重拉. */
function retry(): void {
  retrying.value = true;
  void loadProject();
  void loadVersions();
}

/** 版本行点击 → 跳版本详情 (现有 router 已挂 /projects/:projectId/versions/:versionId). */
function goVersion(v: Version): void {
  void router.push(`/projects/${projectId.value}/versions/${v.id}`);
}

/** R171: 快捷创建任务入口 — 跳 TaskNew 并预填 project (+ 默认版本).
    versionId 不传时用 current_version_id; 项目没设默认版本则只带 project,
    版本由用户在 TaskNew 自选 (TaskNew 对缺省 query 已兜底). */
function goNewTask(versionId?: string): void {
  const v = versionId ?? project.value?.current_version_id ?? null;
  void router.push({
    path: '/tasks/new',
    query: v ? { project: projectId.value, version: v } : { project: projectId.value },
  });
}

/** "+版本" — R172 迭代: stub 换真表单. 点按钮切换内联 NewVersionForm 展开. */
function toggleCreateVersion(): void {
  showNewVersion.value = !showNewVersion.value;
}

/** NewVersionForm created 回调 — 刷新版本列表 + scopeCounts, 收起表单. */
async function onVersionCreated(): Promise<void> {
  showNewVersion.value = false;
  await loadVersions();
  await loadScopeCounts(true);
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

onMounted(() => {
  loadAll();
});

/* R56-B23: 外层 MainLayout 用 <keep-alive :include="cachedNames"> 包裹 router-view,
   keep-alive 缓存复用时 onMounted 不重跑. 用户从 /projects/X 切到 /projects/Y
   (e.g. 侧栏点不同项目), route.params.projectId 已变但组件实例被复用, loadProject
   不触发, 一直显示旧 loading (转圈圈). 镜像 R24 ProjectDetail.vue:137-143 同款
   做法: watch route param 变化时重跑 loadAll. immediate:false 让首次挂载仍走
   onMounted, 不重复跑. */
watch(
  () => route.params.projectId,
  (newId, oldId) => {
    if (newId !== oldId) loadAll();
  },
);
</script>

<template>
  <div class="project-detail">
    <!-- Header: 项目名 + 右上 "+版本" -->
    <header class="page-header">
      <div class="header-left">
        <h2 class="page-title">{{ project?.name ?? '项目详情' }}</h2>
        <span v-if="project" class="page-id">{{ project.id }}</span>
      </div>
      <div class="header-right">
        <!-- R177: 总控制台画布入口 — 画布已替代看板作项目门面. -->
        <router-link
          v-if="project"
          :to="`/${project.id}/console`"
          class="pdv-console-link"
          title="任务画布总控制台"
        >
          🎬 控制台
        </router-link>
        <!-- R171: 项目详情页创建任务入口, 默认预填 current_version_id. -->
        <Button
          variant="primary"
          size="sm"
          :disabled="!project"
          @click="goNewTask()"
        >
          新建任务
        </Button>
        <Button
          variant="secondary"
          size="sm"
          :disabled="!project"
          @click="toggleCreateVersion"
        >
          + 版本
        </Button>
      </div>
    </header>

    <!-- R172 迭代: 新建版本表单内联展开 (含 AI 解析输入, 与项目列表页共用组件) -->
    <NewVersionForm
      v-if="showNewVersion && project"
      :project-id="project.id"
      @created="onVersionCreated"
      @cancel="showNewVersion = false"
    />

    <!-- Body: loading / error / content -->
    <div v-if="loading && !project" class="state-block">
      <Loading size="lg" label="加载项目元数据" />
      <p class="state-text muted">加载中…</p>
    </div>

    <ErrorView
      v-else-if="error"
      title="加载项目失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      @retry="retry"
    />

    <div v-else-if="project" class="content">
      <!-- Tab 切换: 概览 (默认) / 元数据 / 版本. 2026-11-01 加概览 tab. -->
      <nav class="pdv-tabs" role="tablist" aria-label="项目详情分区">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === t.key"
          :class="['pdv-tab', { 'pdv-tab-active': activeTab === t.key }]"
          @click="activeTab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <!-- 概览 tab: 单文件 md 看板 (状态 / 常用链接 / 凭据备注) -->
      <ProjectOverviewPanel v-if="activeTab === 'overview'" />

      <!-- 元数据 tab -->
      <template v-else-if="activeTab === 'meta'">
      <!-- 元数据卡片 -->
      <section class="meta-card card">
        <h3 class="section-title">项目元数据</h3>
        <dl class="meta-grid">
          <dt class="muted">名称</dt>
          <dd class="meta-value">{{ project.name }}</dd>

          <dt class="muted">描述</dt>
          <dd class="meta-value">
            <span v-if="project.description">{{ project.description }}</span>
            <span v-else class="muted">—</span>
          </dd>

          <dt class="muted">cwd</dt>
          <dd class="meta-value mono">
            <span v-if="project.cwd">{{ project.cwd }}</span>
            <span v-else class="muted">—</span>
          </dd>

          <dt class="muted">ports</dt>
          <dd class="meta-value mono">{{ formatPorts(project.ports) }}</dd>

          <dt class="muted">当前版本</dt>
          <dd class="meta-value">
            <span v-if="project.current_version_name">{{ project.current_version_name }}</span>
            <span v-else class="muted">未设置</span>
          </dd>

          <!-- R70: advanced-options 字段在元数据卡露出 (同 master 详情页). -->
          <dt class="muted">同目录并发</dt>
          <dd class="meta-value">
            <span v-if="(project.parallel_limit ?? 1) > 1" class="meta-badge-warn">
              ⚡ {{ project.parallel_limit }}
            </span>
            <span v-else class="muted">1 (串行)</span>
          </dd>

          <dt class="muted">任务超时</dt>
          <dd class="meta-value">
            <span v-if="project.timeout_minutes != null" class="meta-badge-warn">
              ⏱ {{ project.timeout_minutes }} 分钟
            </span>
            <span v-else class="muted">跟随全局默认</span>
          </dd>

          <dt class="muted">runners</dt>
          <dd class="meta-value">
            <span
              v-if="(Array.isArray(project.runners) ? project.runners.length : (typeof project.runners === 'string' && project.runners ? 1 : 0)) > 0"
              class="meta-badge-warn"
            >🛰️ 已配</span>
            <span v-else class="muted">未配</span>
          </dd>

          <dt class="muted">创建于</dt>
          <dd class="meta-value muted">{{ formatDate(project.created_at) }}</dd>
        </dl>

        <!-- R70: 高级选项 toggle + inline-expand 面板. 详情页 toggle 始终可见
             (不像列表卡 hover-fade) — 详情页用户专程来调配置, 减少一次 hover. -->
        <div class="meta-actions">
          <Button
            :variant="editingAdvanced ? 'primary' : 'secondary'"
            size="sm"
            :disabled="!project"
            @click="toggleAdvancedPanel"
          >
            ⚙️ {{ editingAdvanced ? '收起高级选项' : '高级选项' }}
          </Button>
          <Button
            :variant="editingLlm ? 'primary' : 'secondary'"
            size="sm"
            :disabled="!project"
            @click="toggleLlmPanel"
          >
            📡 {{ editingLlm ? '收起 LLM 配置' : 'LLM 配置' }}
          </Button>
        </div>

        <ProjectAdvancedOptionsPanel
          v-if="projectForPanel"
          :project="projectForPanel"
          :open="editingAdvanced"
          @close="editingAdvanced = false"
          @updated="refreshAfterPanelUpdate"
        />
      </section>

      <!-- R70: LLM 配置独立 section, 高级选项内嵌在 meta-card 内.
           两面板互斥 (toggle 时另一关). -->
      <section v-if="editingLlm && project" class="llm-card card">
        <h3 class="section-title">📡 LLM 配置</h3>
        <ProjectLlmConfigPanel
          :project-id="project.id"
          :open="editingLlm"
          @close="editingLlm = false"
          @updated="refreshAfterPanelUpdate"
        />
      </section>
      </template>

      <!-- 版本 tab -->
      <template v-else>
      <!-- 版本列表 -->
      <section class="versions-card card">
        <h3 class="section-title">
          版本列表
          <span class="section-count muted">({{ versions.length }})</span>
        </h3>

        <div v-if="loadingVersions && versions.length === 0" class="state-block">
          <Loading size="md" label="加载版本" />
          <p class="state-text muted">加载版本中…</p>
        </div>

        <Empty
          v-else-if="!hasVersions"
          illustration="folder"
          title="该项目还没有版本"
          description="点击右上角 “+ 版本” 创建第一个版本（UI 待 R18 接入）"
          size="md"
        />

        <ul v-else class="version-list">
          <li
            v-for="v in versions"
            :key="v.id"
            class="version-item"
            role="button"
            tabindex="0"
            @click="goVersion(v)"
            @keydown.enter="goVersion(v)"
            @keydown.space.prevent="goVersion(v)"
          >
            <div class="version-main">
              <span class="version-name">{{ v.name }}</span>
              <span v-if="v.is_current" class="badge badge-current" title="current 版本">current</span>
              <!-- R171 + R176 迭代: 版本行操作按钮组 — 包 wrapper 推到行尾 + 内部
                   适当隔开. 之前两个按钮各自 margin-left:auto, flex 会把 free space
                   平分给两个 auto margin → 「+ 任务」落在行正中间、「编辑」贴尾
                   (damo 飞书反馈: 「尽量都放在尾部，适当隔开，而不是一个在中间」). -->
              <div class="version-row-actions">
                <Button
                  class="version-newtask"
                  variant="ghost"
                  size="mini"
                  title="在该版本下新建任务"
                  @click.stop="goNewTask(v.id)"
                >
                  + 任务
                </Button>
                <!-- R176 (飞书): 版本行编辑入口 — 展开内联面板改
                     名称/描述/飞书链接/Sheet 名/自动派发. -->
                <Button
                  v-if="editingVersionId !== v.id"
                  class="version-newtask"
                  variant="ghost"
                  size="mini"
                  title="编辑版本信息（飞书链接 / Sheet 信息 / 自动派发）"
                  @click.stop="startEditVersion(v)"
                >
                  编辑
                </Button>
              </div>
            </div>
            <div class="version-meta muted">
              <span v-if="v.cwd" class="version-cwd mono">{{ v.cwd }}</span>
              <!-- R176 (飞书): 飞书标签带激活两态 — enable=1(或缺字段按 1)显示"监听中"
                   正向标志, enable=0 显示"已关". 之前只显示"飞书"二字, 激活与否看不出来. -->
              <span
                v-if="v.feishu_url"
                :class="['version-feishu', { 'version-feishu-off': v.enable === 0 }]"
                :title="v.enable === 0
                  ? `飞书已绑定但自动派发已关闭 — sheetwatch 不会扫这张表. ${v.feishu_url}`
                  : `飞书监听中 — sheetwatch 自动派发已开启. ${v.feishu_url}`"
              >飞书 · {{ v.enable === 0 ? '已关' : '监听中' }}</span>
              <!-- R70: per-version 任务计数徽章. -->
              <span v-if="versionTaskCounts(v.id).running > 0" class="version-count version-count-running">
                {{ versionTaskCounts(v.id).running }} 运行
              </span>
              <span v-if="versionTaskCounts(v.id).reviewing > 0" class="version-count version-count-reviewing">
                {{ versionTaskCounts(v.id).reviewing }} 审核
              </span>
              <span v-if="versionTaskCounts(v.id).total > 0" class="version-count version-count-total">
                {{ versionTaskCounts(v.id).total }} 个任务
              </span>
              <span class="version-time">{{ formatDate(v.created_at) }}</span>
            </div>
            <!-- R176 (飞书): 内联编辑面板 — 版本名 + 描述 + 飞书 URL + Sheet 名 +
                 自动派发开关. @click.stop 防触发整行 goVersion 跳详情. -->
            <div
              v-if="editingVersionId === v.id"
              class="version-edit"
              @click.stop
              @keydown.stop
            >
              <div class="version-edit-row">
                <Input v-model="editName" placeholder="版本名（必填）" class-name="version-edit-input" />
                <Input v-model="editFeishuUrl" placeholder="飞书 sheet URL（留空保存即清除绑定）" class-name="version-edit-input" />
              </div>
              <div class="version-edit-row">
                <Input v-model="editFeishuSheet" placeholder="Sheet 名或 id（如 Sheet2）" class-name="version-edit-input" />
                <Input v-model="editDescription" placeholder="版本干啥的（可选）" class-name="version-edit-input" />
              </div>
              <div class="version-edit-row">
                <Checkbox
                  v-model="editEnable"
                  label="开启 sheetwatch 自动派发（关掉后这张表改了也不会自动派任务）"
                />
              </div>
              <div class="version-edit-actions">
                <Button size="sm" :disabled="savingVersion" @click="saveEditVersion(v)">
                  {{ savingVersion ? '保存中…' : '保存' }}
                </Button>
                <Button size="sm" variant="secondary" :disabled="savingVersion" @click="cancelEditVersion">
                  取消
                </Button>
              </div>
            </div>
          </li>
        </ul>
      </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.project-detail {
  padding: 18px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.header-right {
  flex-shrink: 0;
  /* R172 反馈①: 「新建任务」与「+版本」挨太近 — 加按钮间距 */
  display: flex;
  gap: 8px;
  align-items: center;
}
/* R177: 🎬 控制台链接 — 对齐 Button sm 视觉 (main.css .btn 4px 12px / 12px). */
.pdv-console-link {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  color: var(--color-text);
  font-size: 12px;
  text-decoration: none;
  transition: border-color 0.15s;
}
.pdv-console-link:hover {
  border-color: var(--color-primary);
}
.page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.page-id {
  font-size: 12px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.muted {
  color: var(--color-text-muted);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
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

.content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Tab 切换条 (2026-11-01 加概览 tab) — 与 Assets.vue .type-tabs 同款形态 */
.pdv-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  align-self: flex-start;
}
.pdv-tab {
  padding: 5px 14px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.pdv-tab:hover {
  color: var(--color-text);
}
.pdv-tab-active {
  background: var(--color-bg-elevated);
  color: var(--color-primary);
  font-weight: 500;
  box-shadow: var(--shadow-sm);
}
.pdv-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
}

.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  box-shadow: var(--shadow-sm);
}

.section-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}
.section-count {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 400;
}

/* Meta grid (definition list, 2 列: label + value) */
.meta-grid {
  margin: 0;
  display: grid;
  grid-template-columns: 96px 1fr;
  row-gap: 6px;
  column-gap: 12px;
  font-size: 13px;
}
.meta-grid dt {
  font-weight: 400;
  text-align: right;
}
.meta-grid dd {
  margin: 0;
  word-break: break-all;
}
.meta-value {
  color: var(--color-text);
}

/* R70: 高级字段元数据值 (warn 调色板, 同列表卡 project-badge-warn). */
.meta-badge-warn {
  display: inline-block;
  color: var(--tw-amber-700);
  font-size: 12.5px;
}

/* R70: 详情页高级选项 / LLM toggle 按钮行. */
.meta-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}

/* R70: LLM 配置独立 section (高级选项内嵌在 meta-card 内, LLM 另起). */
.llm-card {
  /* 复用 .card 全局基类, 仅上 spacing */
}

/* Version list */
.version-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.version-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background 0.1s;
}
.version-item:last-child {
  border-bottom: none;
}
.version-item:hover,
.version-item:focus-visible {
  background: var(--color-bg);
  outline: none;
}
.version-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-name {
  font-weight: 500;
}
/* R171 + R176 迭代: 行内操作按钮组 — 单一 auto margin 推到行尾 (两个 auto 会
   平分 free space 让第一个按钮掉到中间), 内部 gap 8 适当隔开. */
.version-row-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-newtask {
  opacity: 0;
  transition: opacity 0.1s;
}
.version-item:hover .version-newtask,
.version-item:focus-within .version-newtask {
  opacity: 1;
}
.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius);
  font-size: 11px;
  line-height: 1.4;
  font-weight: 500;
}
.badge-current {
  background: var(--color-primary);
  color: #fff;
}
.version-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}
.version-cwd {
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.version-feishu {
  color: var(--color-primary);
}
/* R176: 飞书标签关闭态 — 琥珀色, 与 ProjectsView .version-watch-off 同视觉. */
.version-feishu-off {
  background: var(--tw-amber-100);
  color: var(--tw-amber-700);
  padding: 1px 8px;
  border-radius: var(--radius);
}

/* R176: 版本行内联编辑面板 — 与 ProjectsView .version-edit 同款浅底卡片,
   展开时覆盖在 version-meta 下方. */
.version-edit {
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.version-edit-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.version-edit-row .version-edit-input {
  flex: 1;
  min-width: 180px;
}
.version-edit-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-time {
  margin-left: auto;
}

/* R70: per-version 任务计数徽章 (与列表卡 project-badge 风格统一, 但 inline). */
.version-count {
  font-size: 11px;
}
.version-count-running {
  color: var(--tw-blue-600);
}
.version-count-reviewing {
  background: var(--tw-purple-100);
  color: var(--tw-violet-600);
  border-radius: 999px;
  padding: 0 6px;
  font-weight: 600;
  font-size: 10px;
}
.version-count-total {
  color: var(--color-text-muted);
}
</style>