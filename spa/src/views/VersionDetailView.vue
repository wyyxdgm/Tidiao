<script setup lang="ts">
/* 功能: 版本详情页 — 显示版本元数据 (name/feishu_url/cwd/sync_strategy/created_at)
   + 嵌入 R14 已完工的 BoardPage 组件 (不复制看板逻辑). 数据源唯一 =
   GET /api/versions/[id], 响应形如 { version: Version }.

   R56-B4.8 增量 — 顶部 chrome 对齐 Next.js board-client.tsx:1078-1145:
     面包屑 (项目 › {projectName} › {versionName} + 短 ID 复制) +
     大标题 ({projectName} / {versionName}) + 三个入口按钮
     (+ 新建 Task / 📖 Wiki / 📋 需求点) + cwd 行
     (version.cwd || project.cwd, 继承自项目提示). 入口 URL 全走 SPA
     自有路由 (ProjectWiki 接 ?version= query, requirements 走
     version-requirements 路由). 不渲染 ViewSwitcher (SPA BoardPage 只
     实现 cards/kanban/chat, 没有 Next 的 list/grouped 模式, 强加 5 档
     切换器会触发"点了没反应"UX). BoardPage 现有 viewMode 切换器保留
     兜底, 用户可走那条切. 关注点:
     - chrome 在原 metadata dl 卡片之前, 跟 Next 版"先 chrome 后内容"一致.
     - 短 ID 点击 → copyUrl, 失败 toast.error (镜像 master handleCopyUrl).
     - project meta 拉取失败不阻断 chrome: 面包屑退到「项目 › 未加载 › {vName}」,
       标题退到 vName alone, 入口按钮始终可用 (URL 只依赖 route params).
     - SPA 旧版 chrome (line 161-176) 同步替换, 旧 sync_strategy chip 改为
       dl 卡片内部项, 不再挂右上角.

   关注点 (R18 红线 + 拍板):
   - 只动本文件: 不改 router (路由已挂 /projects/:projectId/versions/:versionId),
     不改 BoardPage (它已通过 useRoute() 自取 projectId/versionId, 嵌入即生效),
     不改 api/projects.ts (现有 listVersions 返回的 Version 字段集偏窄, 单条端点
     字段更全, 本文件就地 inline 类型 + inline fetch).
   - 嵌入而非复制: BoardPage 是 R14 完整交付物, 本组件只 "<BoardPage />", 复
     制逻辑会导致后续 R14 改动 (M3 SSE/M4 子视图) 与版本详情脱钩. 渲染层一个
     Vue 组件实例, 状态机/筛选 URL/分页 100% 由 BoardPage 接管.
   - 路由参数: projectId + versionId 都从 route.params 取, 不通过 props 透传
     (BoardPage 内部已读 URL, props 透传只会增加耦合).
   - 错误处理: 与 ProjectDetailView 一致三态 — Loading / ErrorView / content.
     404 单独提示 ("版本不存在或已删除"), 不复用通用 "加载失败" 文案.
   - feishu_url 渲染为外链, target=_blank + rel=noopener, 避免反爬 referer
     泄漏 + 阻止新窗口反向操控父页. */
import { computed, onActivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, HttpError } from '@/api/http';
import { getProjectById } from '@/api/projects';
import { copyToClipboard } from '@/lib/clipboard';
import { parseDbTime } from '@/lib/datetime';
import { useToast } from '@/composables/useToast';
import { useTagsStore } from '@/stores/tags';
import { formatProjectItemTitle } from '@/lib/format-tab-title';
import BoardPage from '@/views/BoardPage.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import TaskQuickCreate from '@/components/TaskQuickCreate.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** master src/lib/db/versions.ts Version 的 SPA 投影. 与 listVersions 字段集不同
    (后者用 is_current 数字 + created_at number), 这里走单条端点的全字段:
    sync_strategy / feishu_sheet / feishu_column_mapping / deleted_at 都有.
    created_at 服务端返回 ISO 字符串, 客户端不再 number 化. */
interface Version {
  id: string;
  project_id: string;
  name: string;
  feishu_url: string | null;
  feishu_sheet: string | null;
  cwd: string | null;
  feishu_column_mapping: string | null;
  sync_strategy: 'weak' | 'strong' | 'manual';
  // v512: sheetwatch 开关. 1 = 自动派发扫此 version 的飞书表, 0 = 跳过.
  // 缺字段 = 老 DB 行, 按 1 (启用) 处理, 与 partner scripts/sheetwatch 一致.
  enable?: 0 | 1;
  created_at: string;
  deleted_at: string | null;
}

/** GET /api/versions/[id] 响应信封. */
interface VersionResponse {
  version: Version;
}

/** master src/lib/db/projects.ts Project 的最小子集. R56-B4.8 拿项目名做面包屑/标题,
    拿 project.cwd 兜底版本 cwd. 失败不影响 chrome 渲染 (退到「项目 › 未加载」形态). */
interface ProjectMeta {
  id: string;
  name: string;
  cwd: string | null;
}

/** sync_strategy → label + 视觉提示. 与 master versions API 的 'manual/weak/strong'
    三态对齐 (v45 强同步引入). manual = 没配飞书源, 仅人工管; weak = 当前手动
    diff 行为; strong = 飞书即需求物理存储 (CUD 自动派).
    i18n: label 走 computed (模块级常量非响应式, 语言切换不会更新). */
const SYNC_STRATEGY_LABEL = computed<Record<Version['sync_strategy'], string>>(() => ({
  manual: t('requirements.version.detail.syncManual'),
  weak: t('requirements.version.detail.syncWeak'),
  strong: t('requirements.version.detail.syncStrong'),
}));
const SYNC_STRATEGY_COLOR: Record<Version['sync_strategy'], string> = {
  manual: 'sync-manual',
  weak: 'sync-weak',
  strong: 'sync-strong',
};

/* ------------------------------------------------------------------ */
/*  Route                                                              */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const toast = useToast();
// i18n (W3c A2): 用户可见字符串走 t('requirements.version.detail.*').
const { t } = useI18n();

/* R232 Round4 (damo 10-10): 「+ 新建 Task」入口改聊天式弹窗 — 原来跳
   /tasks/new 表单页, 现在就地弹对话窗 (项目/版本预选当前页, 可切换).
   按钮同步改圆形 (damo: 「+ 现在不是圆形」). */
const quickCreateOpen = ref(false);

/** route.params 在 vue-router 4 类型上为 string | string[], 我们的路由是单段
    :projectId / :versionId, 强转 string 兜底. */
const projectId = computed(() => String(route.params.projectId));
const versionId = computed(() => String(route.params.versionId));
/** R165 phase2: 本实例创建时的参数原值 — keep-alive 驻留后 watch 恢复触发时
 *  用它区分「params 真换了」vs「从别的路由切回来恢复原值」(后者跳过). */
const originProjectId = route.params.projectId ? String(route.params.projectId) : '';
const originVersionId = route.params.versionId ? String(route.params.versionId) : '';

/* ------------------------------------------------------------------ */
/*  R58.5+: 视图模式 — 从 BoardPage 搬到本 chrome 顶部 (用户反馈
    「整体搬到上面去」). state 走 URL ?mode=, BoardPage watch
    URL 自动同步, 无 emit/props. ViewMode 镜像 BoardPage 模式 (cards/
    kanban/chat/list + R244 补 category — 分类视图, 镜像 GlobalBoard
    af48068d; 不含 grouped — BoardPage 没实现 grouped, 跨页搬同款
    才能 setViewMode('grouped') 不被 BoardPage 拒).
    R244 (damo): 活跃/历史 segmented 从 chrome 撤除 — 挪进 BoardPage
    状态 chip 行头部改当分组宏 (镜像 GlobalBoard R236), 本组件不再持有
    statusGroup 切换 UI. */
/* ------------------------------------------------------------------ */
type ViewMode = 'cards' | 'list' | 'grouped' | 'kanban' | 'chat' | 'category';

/** R59+: 当前 viewport 缺省视图模式 — H5 = cards, 桌面 = kanban. 跟 BoardPage
    / GlobalBoard 同步 (三处共用同一份语义), 避免 chrome 端默认 kanban + BoardPage
    端默认 H5 cards 时, 点 kanban 按钮 viewMode.value===m 早 return, URL 不变,
    BoardPage 仍渲染 cards — 用户感知「点了 kanban 没反应」(实测触发现版本).
    matchMedia 是 sync API, 每次 setViewMode 实时取当下 viewport. */
function currentDefaultMode(): ViewMode {
  return typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 1023px)').matches
    ? 'cards'
    : 'kanban';
}

const viewMode = computed<ViewMode>(() => {
  const v = String(route.query.mode || '');
  // whitelist 必须含 'kanban' — R58.5 原始代码漏写, 老 behavior 靠 DEFAULT='kanban'
  // fallback 兜住; R59+ 改成 viewport 缺省后 H5 上 ?mode=kanban 会被错判成
  // currentDefaultMode()='cards', 用户「点 kanban 还是 cards」假死感复活.
  // 'grouped' 不实现 (BoardPage 没 grouped 模式), 走 default — 桌面回 kanban,
  // H5 回 cards, 跟原始 DEFAULT_VIEW_MODE='kanban' 行为兼容.
  return v === 'cards' || v === 'list' || v === 'chat' || v === 'kanban' || v === 'category'
    ? v
    : currentDefaultMode();
});

function setViewMode(m: ViewMode): void {
  if (viewMode.value === m) return;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (typeof v === 'string') next[k] = v;
  }
  // 切到当前 viewport 缺省 (H5=cards / 桌面=kanban) 时移除 param, 否则写.
  // 跟 BoardPage.setViewMode 同款双向一致: URL 干净 + 用户显式选择 sticky.
  // R244: category 同理非 viewport 缺省, 恒写 param.
  if (m === currentDefaultMode()) delete next.mode;
  else next.mode = m;
  // 切视图保留 page (用户希望保留当前页码); statusGroup 不动 (跨段意义不同)
  void router.replace({ query: next });
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const version = ref<Version | null>(null);
const project = ref<ProjectMeta | null>(null);

/** R59: tab 标题 = 「项目(≤8)-版本(≤12)」, 走 R59 统一截断规则. 两个 ref
 *  都声明后再注册 watch, 避免 setup 阶段 getter 同步调用撞 TDZ (跟
 *  TaskDetailView 同款踩坑). applyTitle 内部尊重 customTitle — 用户手动
 *  重命名过就保留. */
const tags = useTagsStore();
watch(
  () =>
    project.value && version.value
      ? { p: project.value.name, v: version.value.name }
      : null,
  (next) => {
    if (!next) return;
    tags.applyTitle(route.path, formatProjectItemTitle(next.p, next.v));
  },
);
const loading = ref(false);
const loadingProject = ref(false);
const error = ref<string | null>(null);
const notFound = ref(false);
const retrying = ref(false);

/* R58 元数据卡片折叠 — 参考 BoardPage chat-top-header-open-v1 (R53.5) 同款
   localStorage 模式. 默认折叠 (用户原话「平台不太需要」这个面板常驻可见,
   5 行字段 cwd/飞书源/同步策略/创建于/名称 大多数日常浏览时不消费),
   持久化 key 命名同款加 v1 后缀便于后续 schema 调整. */
const META_OPEN_KEY = 'version-meta-card-open-v1';
const metaOpen = ref<boolean>(false);
onMounted(() => {
  try {
    const raw = localStorage.getItem(META_OPEN_KEY);
    if (raw === '1') metaOpen.value = true;
  } catch {
    /* localStorage 不可用 (隐私模式/无痕) → 静默降级默认折叠 */
  }
});
watch(metaOpen, (v) => {
  try {
    localStorage.setItem(META_OPEN_KEY, v ? '1' : '0');
  } catch {
    /* 同上: 静默失败, 不弹错 */
  }
});
function toggleMeta(): void {
  metaOpen.value = !metaOpen.value;
}

/* R58 全局 chrome 折叠 — 把上方 3 个面板 (面包屑/标题/cwd/BoardPage header/
   filter) 整体收起来, 让 board 区直接占满. 用户原话「项目上下文右侧的 ›
   让他可以把上面的都收起来」. 默认折叠 (用户原话「上方3个白色区域都直接
   隐藏可以吗」 — 进入新页面默认就是纯 board, 占用最少纵向空间, 需要时
   再点 vd-chrome-collapsed-toggle 或 vd-crumb-toggle 展开),
   持久化 localStorage. 状态透传给 BoardPage, 让其 header + filter 同步
   收起, 视觉一致. */
const CHROME_OPEN_KEY = 'version-chrome-open-v1';
const chromeOpen = ref<boolean>(false);
onMounted(() => {
  try {
    const raw = localStorage.getItem(CHROME_OPEN_KEY);
    if (raw === '1') chromeOpen.value = true;
  } catch {
    /* 同上 */
  }
});
watch(chromeOpen, (v) => {
  try {
    localStorage.setItem(CHROME_OPEN_KEY, v ? '1' : '0');
  } catch {
    /* 同上 */
  }
});
function toggleChrome(): void {
  chromeOpen.value = !chromeOpen.value;
}

/* ------------------------------------------------------------------ */
/*  Derived (R56-B4.8 chrome)                                         */
/* ------------------------------------------------------------------ */

/** 短 ID 用于面包屑 / 标题行复制按钮. */
const projectShortId = computed<string>(() => projectId.value.slice(0, 8));
const versionShortId = computed<string>(() => versionId.value.slice(0, 8));

/** 项目名 (chrome 用). project 还没拉到 → 退到空字符串让模板走 fallback 文案.
    元数据卡片沿用 version.name 不动. */
const projectName = computed<string>(() => project.value?.name ?? '');

/** 面包屑 / 大标题的「项目 › 未加载」降级. */
const breadcrumbProjectLabel = computed<string>(() =>
  project.value?.name ?? t('requirements.version.detail.projectFallback'),
);

/** 大标题 — Next 端 master board-client.tsx:1103-1104 写 `{project.name} /
    {scopeName}` (scopeName = version?.name || '其他任务'). version 一定存在
    (URL 锁死, 拿不到 version 走 404 不进 chrome), 所以直接拼. */
const pageHeading = computed<string>(() => {
  const p = projectName.value;
  const v = version.value?.name ?? t('requirements.version.detail.versionFallback');
  return p ? `${p} / ${v}` : v;
});

/** 入口 href — 入口按钮的目标 URL. 全部走 SPA 自有路由:
     - Wiki       → /projects/{projectId}/wiki?version={versionId} (R31 ProjectWiki 接受 ?version=)
     - 需求点     → /projects/{projectId}/versions/{versionId}/requirements
                    (version-requirements 路由, 与 Next.js /[projectId]/[versionId]/requirements 1:1)
     - 新建 Task 已改聊天式弹窗 (R232 Round4), 不再有 href. */
const wikiHref = computed<string>(
  () =>
    `/projects/${encodeURIComponent(projectId.value)}/wiki?version=${encodeURIComponent(versionId.value)}`,
);
const requirementsHref = computed<string>(
  () =>
    `/projects/${encodeURIComponent(projectId.value)}/versions/${encodeURIComponent(versionId.value)}/requirements`,
);

/** cwd 显示 — 优先 version.cwd, 缺时回退 project.cwd, 都没有 → null (chrome 不渲染整行). */
const effectiveCwd = computed<string | null>(() => version.value?.cwd || project.value?.cwd || null);
/** 是否继承自项目 (即 version.cwd 为空, 用了 project.cwd). 显示在 cwd 行末尾 (继承自项目). */
const inheritedCwd = computed<boolean>(() => !!(effectiveCwd.value && !version.value?.cwd && project.value?.cwd));

/** feishu_url 是飞书 docs/sheets 链接 → 外链; sheet 子路径本地不可路由, 一律开新窗口. */
const feishuHref = computed<string | null>(() => version.value?.feishu_url || null);

/** ISO 时间戳 → "YYYY-MM-DD HH:mm" 本地化. 失败回原值. 与 ProjectDetailView
    formatDate 同口径 (本文件不复用, 避免本组件反向依赖 ProjectDetailView). */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  // R205: parseDbTime 当 UTC 处理 (BoardPage/GlobalBoard 同口径), 旧
  // new Date(iso) 在 CST 偏早 8h.
  const d = parseDbTime(iso);
  if (!d) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

/** R56-B4.8: 并发拉 project meta (给 chrome 用). 失败不阻断 chrome — project
    null 时面包屑/标题降级到 fallback 文案, 入口按钮照常可用 (URL 只依赖
    route params). 不抛 toast, 静默失败; 用户从面包屑/入口也能继续走. */
async function loadProject(silent = false): Promise<void> {
  if (!silent) loadingProject.value = true;
  try {
    const p = await getProjectById(projectId.value);
    // getProjectById 已归一 404/网络错 → null; 兜底再加一次 null check.
    project.value = p && typeof p.name === 'string' ? { id: p.id, name: p.name, cwd: p.cwd ?? null } : null;
  } catch {
    // 项目元数据失败不影响 chrome 渲染.
    project.value = null;
  } finally {
    if (!silent) loadingProject.value = false;
  }
}

async function loadVersion(silent = false): Promise<void> {
  if (!silent) {
    loading.value = true;
    error.value = null;
    notFound.value = false;
  }
  try {
    const data = await get<VersionResponse>(`/api/versions/${versionId.value}`);
    version.value = data.version;
  } catch (e: unknown) {
    if (silent) return; // 切回 tab 的静默刷新: 保持现状, 不闪 loading/错误
    if (e instanceof HttpError) {
      if (e.status === 404) {
        notFound.value = true;
        error.value = null;
      } else {
        error.value = e.message || t('requirements.version.detail.errHttp', { n: e.status });
      }
    } else if (e instanceof Error) {
      error.value = t('requirements.version.detail.errNetwork', { msg: e.message });
    } else {
      error.value = t('requirements.version.detail.errGeneric');
    }
  } finally {
    if (!silent) {
      loading.value = false;
      retrying.value = false;
    }
  }
}

function retry(): void {
  retrying.value = true;
  void loadVersion();
}

/** R56-B4.8: 复制当前页面 URL. 镜像 master board-client.tsx:428-435 handleCopyUrl.
    失败 toast.error, 成功 toast.success. */
async function copyUrl(): Promise<void> {
  try {
    await copyToClipboard(window.location.href);
    toast.success(t('requirements.version.detail.copied'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('requirements.version.detail.unknownError');
    toast.error(t('requirements.version.detail.copyFailed', { msg }));
  }
}

/** 视图模式 label (i18n) — kanban/cards/list/category/chat 五档. */
function viewModeLabel(m: ViewMode): string {
  switch (m) {
    case 'cards':
      return t('requirements.version.detail.modeCards');
    case 'list':
      return t('requirements.version.detail.modeList');
    case 'category':
      return t('requirements.version.detail.modeCategory');
    case 'chat':
      return t('requirements.version.detail.modeChat');
    default:
      return t('requirements.version.detail.modeKanban');
  }
}

/** 面包屑「项目」段点击 → 跳到项目级 ProjectDetailView (那里有版本列表 + 元数据).
    不走 router.replace, 推一个新 tab 在 SPA tab 系统里也合理. */
function goProject(): void {
  void router.push(`/projects/${projectId.value}`);
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

/** 路由变化 → 重拉 (params 改了就 fetch 新的版本). 默认 same-route 不会触发,
    兜底防 vue-router 复用组件导致 stale data.
    ⚠️ R165 keep-alive 生效后本实例在切走时**不再销毁**, 这个 watch 在路由去往
    别处 (如 /global, params 变 undefined) 时也会触发 —— 必须 id 无效时跳过,
    否则会拉 /api/versions/undefined (实测 404 一对). */
watch(
  () => [projectId.value, versionId.value],
  () => {
    if (!route.params.projectId || !route.params.versionId) return;
    /* R165 phase2: 切回 tab 时 params 从驻留期的空恢复成本实例原值, watch 会
       触发 → 若不拦会闪 loading 全量重拉 (onActivated 的静默刷新就在后面,
       全量那发纯多余). 值没变 = 恢复, 跳过; 真换了 id 才走全量. */
    if (projectId.value === originProjectId && versionId.value === originVersionId) return;
    version.value = null;
    project.value = null;
    void loadVersion();
    void loadProject();
  },
);

onMounted(() => {
  void loadVersion();
  void loadProject();
});

/* R165: keep-alive 生效后切回 tab 不再重跑 onMounted, 版本元数据会停在切走
   时的状态 → onActivated 补一次静默重拉 (版本名/入口按钮用的元数据).
   首次挂载也会触发 onActivated (在 onMounted 之后), 用 first 标志跳过避免
   与 onMounted 重复拉. 失败静默: 切回 tab 不该因元数据刷新失败弹错,
   BoardPage 自身的数据由它内部的探针负责, 这里只管 chrome 元数据. */
let activatedOnce = false;
onActivated(() => {
  // id 不在 URL 上 (路由去了别处又回来?) 时不刷, 防止 /api/versions/undefined.
  if (!route.params.projectId || !route.params.versionId) return;
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }
  void loadVersion(true);
  void loadProject(true);
});
</script>

<template>
  <div class="version-detail">
    <!-- Body: loading / error / not-found / content -->
    <div v-if="loading && !version" class="state-block">
      <Loading size="lg" :label="t('requirements.version.detail.loadingMeta')" />
      <p class="state-text muted">{{ t('requirements.version.detail.loading') }}</p>
    </div>

    <ErrorView
      v-else-if="notFound"
      :title="t('requirements.version.detail.notFoundTitle')"
      :description="t('requirements.version.detail.notFoundDesc')"
      variant="warning"
      :show-retry="false"
    />

    <ErrorView
      v-else-if="error"
      :title="t('requirements.version.detail.loadFailedTitle')"
      :description="error"
      variant="error"
      :retrying="retrying"
      @retry="retry"
    />

    <div v-else-if="version" class="content">
      <!-- R56-B4.8: 顶部 chrome — 完整镜像 Next.js board-client.tsx:1078-1145.
           面包屑 (项目 › {projectName} › {versionName} + 短 ID 复制) +
           大标题 ({projectName} / {versionName}) + 三个入口按钮
           (+ 新建 Task / 📖 Wiki / 📋 需求点) + cwd 行. 不渲染 ViewSwitcher
           (SPA BoardPage 没有 list/grouped 模式). project 加载失败时面包屑
           / 大标题降级到 fallback 文案, 入口按钮照常可用 (URL 只依赖 route
           params, 不依赖 project meta). -->
      <header class="vd-chrome">
        <!-- R58.5+: chrome 整体改成 flex row 左右两块布局 (用户反馈「vd-breadcrumb
             和 vd-title-row 变成只占左侧一半空间, 然后 vd-title-row 里右侧的
             按钮就可以挪到右侧, 看起来不会和第3行里的按钮挤得太挤」).
             左半 .vd-header-text 纵向 stack (breadcrumb + title), 右半
             .vd-header-right 纵向 stack (vd-controls + chrome-toggle).
             cwd-row 跨整 chrome 宽 (作为 chrome 第三行), 入口按钮组靠右
             = 跟第2行右侧的控件视觉对齐 (都不跟左侧挤).

             FAB 兜底展开保留 chrome 折叠态显示. chrome 折叠时只留 breadcrumb
             一行, FAB inline 在面包屑末尾自然居中. -->
        <div class="vd-header-text">
        <!-- 面包屑行: 项目 › {projectName} › {versionName} ({short}/{short}…). -->
        <div class="vd-breadcrumb">
          <!-- R58: 镜像 Next.js master board-client.tsx:610-613 — 顶部 pill
               加一个 "项目上下文" 小灰标签, 与 chat-view.tsx 同款. -->
          <span class="vd-context-label">{{ t('requirements.version.detail.contextLabel') }}</span>
          <router-link to="/projects" class="vd-crumb-link">{{ t('requirements.version.detail.project') }}</router-link>
          <span class="vd-crumb-sep">›</span>
          <button
            type="button"
            class="vd-crumb-link vd-crumb-btn"
            :title="t('requirements.version.detail.jumpToProject', { name: breadcrumbProjectLabel })"
            @click="goProject"
          >
            {{ breadcrumbProjectLabel }}
          </button>
          <span class="vd-crumb-sep">›</span>
          <span class="vd-crumb-current">{{ version.name }}</span>
          <button
            type="button"
            class="vd-short-id"
            :title="t('requirements.version.detail.copyLinkTitle', { p: projectId, v: versionId })"
            @click="copyUrl"
          >
            ({{ projectShortId }}…/{{ versionShortId }}…)
          </button>
          <!-- R176 (飞书): 面包屑常显激活态 chip — 元数据卡片默认双重折叠
               (chromeOpen + metaOpen 都 false), 激活与否深藏看不到. 这里
               面包屑行不受折叠影响, 一进页面即可见. -->
          <span
            v-if="version.feishu_url"
            :class="['vd-watch-chip', version.enable === 0 ? 'vd-watch-chip-off' : 'vd-watch-chip-on']"
            :title="version.enable === 0
              ? t('requirements.version.detail.watchOffTitle')
              : t('requirements.version.detail.watchOnTitle')"
          >
            {{ version.enable === 0 ? t('requirements.version.detail.watchOff') : t('requirements.version.detail.watchOn') }}
          </span>
          <!-- R58.5+: chrome 折叠态 FAB 兜底展开 — 放面包屑末尾 (跟
               breadcrumb 同一行 inline, 自然水平居中 — 用户反馈「展开
               按钮偏下」= absolute 定位在 breadcrumb 中间看着偏下;
               改为 inline 同行). chromeOpen=false 时显示. 视觉跟
               GlobalBoard .gb-chrome-fab 同款 (圆角 999px + chevron +
               「展开」文字). -->
          <button
            v-if="!chromeOpen"
            type="button"
            class="vd-chrome-fab"
            :title="t('requirements.version.detail.expandPanels')"
            :aria-label="t('requirements.version.detail.expandPanels')"
            @click="toggleChrome"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
              <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
            </svg>
            <span>{{ t('requirements.version.detail.expand') }}</span>
          </button>
        </div>

        <template v-if="chromeOpen">
        <!-- 标题行: 大标题. R58 chromeOpen=false 时整体隐藏, 仅留面包屑. -->
        <h1 class="vd-heading">{{ pageHeading }}</h1>
        <!-- cwd 行 + 三个入口按钮 — 跟 breadcrumb / title 上下垂直 stack 在
             .vd-header-text 内 (用户反馈「cwd 父容器要上下」= 之前 cwd-row
             是 chrome 直接子级, 跟 .vd-header-text / .vd-header-right 左
             右并排 = 横向 row 布局; 现在改成 column stack, cwd 跟 breadcrumb
             + title 同一列上下排). 入口按钮 margin-left: auto 让按钮组
             贴 cwd-row 末尾 (= 左半右边缘; 跟 .vd-header-right 右侧控件
             在不同行, 视觉分层清楚不挤). -->
        <div v-if="effectiveCwd || chromeOpen" class="vd-cwd-row">
          <div v-if="effectiveCwd" class="vd-cwd">
            <span class="muted">cwd:</span>
            <span class="vd-cwd-path">{{ effectiveCwd }}</span>
            <span v-if="inheritedCwd" class="vd-cwd-hint">{{ t('requirements.version.detail.cwdInherited') }}</span>
          </div>
        </div>
        </template>
        </div><!-- /vd-header-text -->

        <!-- R58.5+: chrome 右侧控件组 — 镜像 GlobalBoard .gb-header-right
             (segmented + view-switcher + chrome-toggle 三块横向 row 排).
             放在 .vd-header-right (flex column) 内, 让控件整体跟左侧文
             本 stack 视觉对齐, chrome 高度 = max(左侧文本, 右侧控件).
             chromeOpen=false 时整块隐藏, 跟 GlobalBoard 同步行为. -->
        <div v-if="chromeOpen" class="vd-header-right">
          <div class="vd-controls" role="toolbar" :aria-label="t('requirements.version.detail.viewMode')">
            <!-- 飞书 R244 (damo): 活跃/历史从 chrome 撤除 — 挪进 BoardPage 状态
                 chip 行头部改当分组宏 (镜像 GlobalBoard R236), 本处不再持有. -->
            <!-- 视图模式 (kanban / cards / list / category / chat) — 看板调第一位.
                 R244: 补 category (分类视图, 镜像 GlobalBoard af48068d). -->
            <div class="vd-view-switcher" role="tablist" :aria-label="t('requirements.version.detail.viewMode')">
              <button
                v-for="m in (['kanban', 'cards', 'list', 'category', 'chat'] as ViewMode[])"
                :key="m"
                type="button"
                role="tab"
                :aria-selected="viewMode === m"
                :class="['vd-view-btn', { 'vd-view-btn-active': viewMode === m }]"
                @click="setViewMode(m)"
              >
                <svg v-if="m === 'kanban'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                  <rect x="2" y="3" width="3.5" height="10" rx="1" />
                  <rect x="6.5" y="3" width="3.5" height="7" rx="1" />
                  <rect x="11" y="3" width="3.5" height="10" rx="1" />
                </svg>
                <svg v-else-if="m === 'cards'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                  <rect x="2" y="2" width="5" height="5" rx="1" />
                  <rect x="9" y="2" width="5" height="5" rx="1" />
                  <rect x="2" y="9" width="5" height="5" rx="1" />
                  <rect x="9" y="9" width="5" height="5" rx="1" />
                </svg>
                <svg v-else-if="m === 'list'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                  <line x1="3" y1="4.5" x2="13" y2="4.5" />
                  <line x1="3" y1="8" x2="13" y2="8" />
                  <line x1="3" y1="11.5" x2="13" y2="11.5" />
                </svg>
                <svg v-else-if="m === 'category'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2 4a1.5 1.5 0 011.5-1.5h3l1.5 2h5.5A1.5 1.5 0 0115 6v6a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 012 12V4z" />
                </svg>
                <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 5a2 2 0 012-2h6a2 2 0 012 2v3a2 2 0 01-2 2H7l-3 3v-3H5a2 2 0 01-2-2V5z" />
                </svg>
                <span class="vd-view-label">{{ viewModeLabel(m) }}</span>
              </button>
            </div>
            <!-- chrome 折叠 toggle (跟 GlobalBoard chrome-toggle 同位置) -->
            <button
              type="button"
              class="vd-chrome-toggle"
              :title="chromeOpen ? t('requirements.version.detail.collapsePanels') : t('requirements.version.detail.expandPanels')"
              :aria-expanded="chromeOpen"
              :aria-label="t('requirements.version.detail.togglePanels')"
              @click="toggleChrome"
            >
              <svg class="vd-chrome-chevron" :class="{ 'vd-chrome-chevron-open': chromeOpen }" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
              </svg>
              <span>{{ chromeOpen ? t('requirements.version.detail.collapse') : t('requirements.version.detail.expand') }}</span>
            </button>
          </div>
          <!-- R58.5+: 三个入口按钮 (+新建Task/Wiki/需求点) 挪进 .vd-header-right
               (用户反馈「vd-entry-actions 丢到右侧去, vd-header-right 里」).
               之前 cwd-row 内的 entry-actions 跟 chrome 控件在不同列, 现在
               跟 segmented + view-switcher + chrome-toggle 同在右半, 跟
               GlobalBoard chrome 控件 + 入口按钮视觉一致. -->
          <div v-if="chromeOpen" class="vd-entry-actions">
            <!-- R232 Round4 (damo 10-10): 圆形「+」— 点击开聊天式创建弹窗
                 (不再跳 /tasks/new). 圆形口径与看板 FAB (board-fab-new) 一致,
                 inline 尺寸收小 (34px) 融入 chrome 按钮排. -->
            <button
              type="button"
              class="vd-entry-fab"
              :title="t('requirements.version.detail.newTaskTitle')"
              :aria-label="t('requirements.version.detail.newTask')"
              @click="quickCreateOpen = true"
            >
              <!-- R233 Round7: 文本「+」字形受字体基线影响视觉偏下, 换 SVG 十字几何居中. -->
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
              </svg>
            </button>
            <router-link
              :to="wikiHref"
              class="btn btn-secondary vd-entry-btn"
              :title="t('requirements.version.detail.wikiTitle')"
            >
              <span class="vd-entry-icon">📖</span><span class="vd-entry-text">Wiki</span>
            </router-link>
            <button
              type="button"
              class="btn btn-secondary vd-entry-btn"
              :title="t('requirements.version.detail.listTitle')"
              @click="router.push({ path: '/global', query: { mode: 'category', project: projectId } })"
            >
              <span class="vd-entry-icon">🗂</span><span class="vd-entry-text">{{ t('requirements.version.detail.list') }}</span>
            </button>
            <router-link
              :to="requirementsHref"
              class="btn btn-secondary vd-entry-btn"
              :title="t('requirements.version.detail.reqsTitle')"
            >
              <span class="vd-entry-icon">📋</span><span class="vd-entry-text">{{ t('requirements.version.detail.reqsLegacy') }}</span>
            </router-link>
          </div>
        </div><!-- /vd-header-right -->


        <!-- cwd 行 + 三个入口按钮. R58.5+ 按钮组从原 title-row 拿下来跟 cwd
             并排, 跨整 chrome 宽 (用户反馈「入口按钮靠页面右侧」, 整宽 layout
             让 entry-actions margin-left: auto 推到 viewport 右边缘). flex 让
             cwd-row 已挪进 .vd-header-text 内 (R58.5+ 用户反馈「cwd 父容
             器要上下」, 跟 breadcrumb/title 上下 stack, 不跟左右两块并
             排). 此处不再有 chrome 直接子级 cwd-row. -->
      </header>

      <!-- 元数据卡片: name / feishu_url / cwd / sync_strategy / created_at. R58 加
           折叠: 点标题 (整行) 切换, chevron 旋转指示状态, 默认折叠, localStorage
           持久化 (version-meta-card-open-v1). 平台日常浏览 cwd/飞书源/创建于 不
           必看, 折叠后 board 区直接顶上去少 100px 滚动.

           chrome 联动: chromeOpen=false 时 meta card 也隐藏 (与 chrome
           header / BoardPage header + filter 一起, 让「项目右侧 ›」一个
           toggle 控制所有上方 3 块白色面板). chromeOpen=true 时
           metaOpen 仍可独立 fold. -->
      <section v-if="metaOpen && chromeOpen" class="meta-card card">
        <h3 class="section-title section-title-toggleable" role="button" tabindex="0"
          :aria-expanded="metaOpen" @click="toggleMeta" @keydown.enter="toggleMeta"
          @keydown.space.prevent="toggleMeta">
          <span>{{ t('requirements.version.detail.metaTitle') }}</span>
          <svg class="meta-chevron" :class="{ 'meta-chevron-open': metaOpen }"
            xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </h3>
        <dl v-if="metaOpen" class="meta-grid">
          <dt class="muted">{{ t('requirements.version.detail.fieldName') }}</dt>
          <dd class="meta-value">{{ version.name }}</dd>

          <dt class="muted">{{ t('requirements.version.detail.fieldFeishu') }}</dt>
          <dd class="meta-value">
            <a
              v-if="feishuHref"
              :href="feishuHref"
              class="meta-link"
              target="_blank"
              rel="noopener noreferrer"
              :title="feishuHref"
            >
              {{ feishuHref }} ↗
            </a>
            <span v-else class="muted">—</span>
          </dd>

          <dt class="muted">cwd</dt>
          <dd class="meta-value mono">
            <span v-if="version.cwd">{{ version.cwd }}</span>
            <span v-else class="muted">—</span>
          </dd>

          <dt class="muted">{{ t('requirements.version.detail.fieldSyncStrategy') }}</dt>
          <dd class="meta-value">
            <span :class="['sync-inline', SYNC_STRATEGY_COLOR[version.sync_strategy]]">
              {{ SYNC_STRATEGY_LABEL[version.sync_strategy] }}
            </span>
          </dd>

          <dt class="muted">{{ t('requirements.version.detail.fieldAutoDispatch') }}</dt>
          <dd class="meta-value">
            <span v-if="version.feishu_url && version.enable === 0" class="watch-off-inline">
              {{ t('requirements.version.detail.dispatchOff') }}
            </span>
            <span v-else class="muted">
              {{ version.feishu_url ? t('requirements.version.detail.dispatchOn') : '—' }}
            </span>
          </dd>

          <dt class="muted">{{ t('requirements.version.detail.fieldCreatedAt') }}</dt>
          <dd class="meta-value muted">{{ formatDate(version.created_at) }}</dd>
        </dl>
      </section>

      <!-- 看板区: 嵌入 R14 已完工 BoardPage (URL 路径 /projects/:projectId/versions/:versionId
           下 useRoute() 直接拿 projectId/versionId, 嵌入零配置). R58 透传
           chromeCollapsed 让 BoardPage header + filter 同步折叠. -->
      <section class="board-card">
        <BoardPage :chrome-collapsed="!chromeOpen" :version-name="version?.name ?? null" :project-name="projectName" />
      </section>
    </div>

    <!-- R232 Round4 (damo 10-10): 聊天式快速创建弹窗, 预选当前项目/版本. -->
    <TaskQuickCreate
      v-model="quickCreateOpen"
      :initial-project-id="projectId"
      :initial-version-id="versionId"
    />
  </div>
</template>

<style scoped>
.version-detail {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 24px 12px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.header-right {
  flex-shrink: 0;
}

.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}

.page-id {
  font-size: 12px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ------------------------------------------------------------------ */
/* R56-B4.8 chrome (替代原 .page-header/.header-left/.header-right,    */
/* 那些类已不再被 template 引用, 死代码留待后续清理轮统一处理)        */
/* ------------------------------------------------------------------ */

/* R58.5+: chrome 改成 flex row 左右两块布局 (用户反馈「vd-breadcrumb 和
   vd-title-row 变成只占左侧一半空间, 然后 vd-title-row 里右侧的按钮
   就可以挪到右侧, 看起来不会和第3行里的按钮挤得太挤」). 之前是 flex
   column 3 行, 现在 row 布局: 左 .vd-header-text (column stack breadcrumb
   + title), 右 .vd-header-right (column stack 控件 + toggle), 下方
   .vd-cwd-row 跨整 chrome 宽. align-items: flex-start 让左右两块顶
   对齐. */
.vd-chrome {
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  padding: 18px 24px 14px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

/* R58.5+: 左侧文本 stack (面包屑 + 大标题). flex column 垂直堆栈,
   跟 GlobalBoard .gb-header-text 「breadcrumb + title + subtitle 纵向排
   列」同款. min-width: 0 让内容溢出时正常收缩, 不撑爆 row. flex: 1 让
   左侧只占 chrome 一半 (右侧 .vd-header-right flex-shrink:0 占另一半). */
.vd-header-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

/* R58.5+: 右侧控件组 — 镜像 GlobalBoard .gb-header-right (segmented +
   view-switcher + chrome-toggle 三块横向 row 排). flex-shrink: 0 让控件
   不被压缩, 自然靠右. */
.vd-header-right {
  /* R58.5+: 改 flex-direction column — 之前 row 让 controls + entry-actions
     横向并排, 现在 entry-actions 是独立列, controls 在上 + entry-actions
     在下纵向 stack. gap 8 保留两组之间视觉间隔. */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

/* R58.5+: cwd 行 — 跨整 chrome 宽 (作为 chrome 第三行直接子级, 不在
   .vd-header-text 内). 用户反馈「入口按钮靠页面右侧」: 跨整宽让
   margin-left: auto 推到 viewport 右边缘, 不依赖 .vd-cwd flex:1 把按钮
   挤到中间. padding 0 跟 chrome 一致, wrap 让窄屏按钮掉下一行不挤. */
.vd-cwd-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
}

.vd-cwd-row .vd-cwd {
  flex: 1;
  min-width: 0;
}

.vd-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

/* R58: 镜像 Next.js master chat-view.tsx:613 — 顶部 pill "项目上下文"
   小灰标签. text-xs (12px) + muted 色 + shrink-0, 跟 chrome 项目区视觉锚定. */
.vd-context-label {
  font-size: 12px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-right: 2px;
}

.vd-crumb-link {
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
  transition: color 0.15s;
}

.vd-crumb-link:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.vd-crumb-btn {
  /* 视觉上跟 router-link 行为一致, 但走 goProject 函数 (push 新 tab) */
}

.vd-crumb-sep {
  color: var(--color-text-muted);
  opacity: 0.6;
}

/* R58: 面包屑最右侧的 chevron toggle button — 收起上方 3 个面板 (chrome
   header + meta card + BoardPage header + filter). 与 vd-crumb-sep 同色
   (灰色 + opacity 0.6), 鼠标 hover 时高亮. chromeOpen=true 时朝下 (收起
   提示); chromeOpen=false 时整个 header 被 v-if 隐藏, 此按钮也隐藏. */
.vd-crumb-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid var(--color-border);
  cursor: pointer;
  margin-left: 8px;
  padding: 3px 8px;
  border-radius: var(--radius);
  color: var(--color-text-muted);
  font-size: 12px;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.vd-crumb-toggle:hover {
  background: var(--color-bg);
  color: var(--color-primary);
  border-color: var(--color-primary);
}
.vd-crumb-toggle:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
/* R58: chevron 默认朝右 (展开提示), chromeOpen=true 时旋转到 0deg 朝下
   (收起提示). transition 0.2s 平滑. 仅面包屑末尾 toggle 用. */
.vd-chrome-chevron {
  flex-shrink: 0;
  transform: rotate(-90deg);
  transition: transform 0.2s;
}
.vd-chrome-chevron-open {
  transform: rotate(0deg);
}

.vd-crumb-current {
  color: var(--color-text);
  font-weight: 500;
}

/* R176: 面包屑飞书激活 chip — 绿(监听中)/琥珀(已关) 两态, 常显不受折叠影响. */
.vd-watch-chip {
  flex-shrink: 0;
  margin-left: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  cursor: help;
}
.vd-watch-chip-on {
  background: var(--tw-green-100);
  color: var(--tw-green-700);
}
.vd-watch-chip-off {
  background: var(--tw-amber-100);
  color: var(--tw-amber-700);
}

.vd-short-id {
  margin-left: 6px;
  padding: 2px 8px;
  background: transparent;
  border: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: background 0.15s, color 0.15s;
}

.vd-short-id:hover {
  background: var(--color-bg);
  color: var(--color-primary);
}

.vd-title-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
}

@media (min-width: 640px) {
  .vd-title-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.vd-heading {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.3;
}

.vd-entry-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* R58.5: vd-entry-btn 缩小一号 — 跟全系统 .btn (4px 12px / 12px) 对齐.
   之前 6px 14px / font 13px 是大按钮尺寸, 现在跟 segmented btn 一档.
   border-radius 8px 跟 .vd-view-switcher / .vd-chrome-toggle 同档 (用户反馈
   「圆角和上面几个按钮对齐一下, 别太矩形」). 之前试过
   10px, 用户反馈「和上面收起那几个按钮一致就好了, 好像比他们还园现在」
   → 改回 8px 跟上面按钮完全一致. */
.vd-entry-btn {
  text-decoration: none;
  white-space: nowrap;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 8px;
}

/* R232 Round4 (damo 10-10): 圆形「+」创建入口 — 与看板 FAB (board-fab-new)
   同视觉语言 (primary 圆钮), inline 尺寸 34px 融进 chrome 按钮排.
   关注点: 全局 button reset 只动 font/cursor, 圆形靠 border-radius:50% +
   固定宽高; 「+」基线偏移用 line-height 1 + padding 微调垂直居中. */
.vd-entry-fab {
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}

.vd-entry-fab:hover {
  filter: brightness(1.08);
}

.vd-entry-icon {
  /* 与文字小间距 */
}

.vd-entry-text {
  margin-left: 6px;
}

/* 小屏幕 (跟 .tsb-tbtn-text / .lca-label 1024px 同断点) — 入口按钮只露图标,
   文字藏. title 属性 (上面 router-link 的 title=) 提供 hover 提示兜底.
   R58.5: 同步缩 padding — 跟桌面 4px 12px 视觉延续. */
@media (max-width: 1023px) {
  .vd-entry-text {
    display: none;
  }
  .vd-entry-btn {
    padding: 4px 10px;
  }
}

.vd-cwd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.vd-cwd-path {
  word-break: break-all;
}

.vd-cwd-hint {
  font-family: inherit;
  font-style: italic;
  color: var(--color-text-muted);
  opacity: 0.8;
}

/* R58.5+: 视图模式 + 状态分组 控件行 — 跟 title-row 同层 (用户反馈
   「现有的 vd-controls 挪到 vd-title-row」). 样式对齐 BoardPage
   .board-segmented / .board-view-switcher (scoped 不共享, 本地副本).
   gap 12px 让两组之间有清晰间隔, 自然分组但视觉单一 chrome 内.
   margin-left: auto 让控件在 vd-title-row (flex row) 横向靠右 — 替代
   之前在独立行时用的 align-self: flex-end (那条规则只在 flex column
   父容器生效, title-row 是 row 必须改用 margin-left: auto). vd-controls
   后面跟 vd-chrome-toggle (从面包屑挪过来), 共用一行最右侧 = 跟
   GlobalBoard chrome 排布对齐. */
.vd-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
}

/* R58.5+: vd-chrome 折叠 toggle — 从 vd-breadcrumb 挪到 vd-title-row 最右.
   样式对齐 GlobalBoard .gb-chrome-toggle: 圆角 8px + border + 内联 svg +
   label, gap 4px. 视觉跟 vd-view-switcher 同高度 (28px 左右),
   排在一起协调. */
.vd-chrome-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text-muted, #4b5563);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, border-color 0.12s;
}

.vd-chrome-toggle:hover {
  background: var(--color-bg-hover, #f3f4f6);
  border-color: var(--color-border-hover, #d1d5db);
}

.vd-chrome-toggle svg {
  flex-shrink: 0;
  transition: transform 0.15s;
}

.vd-chrome-toggle[aria-expanded="true"] svg {
  transform: rotate(-180deg);
}

@media (max-width: 1023px) {
  .vd-chrome-toggle span {
    display: none;
  }
}

/* R58.5+: chrome 折叠态 FAB — chromeOpen=false 时显示, 放面包屑末尾
   inline 同行 (用户反馈「展开按钮偏下」= 之前 absolute top:12px 在
   breadcrumb 中间高度看着偏下; 改为 inline 跟面包屑元素同高度, 自然
   水平居中). margin-left: auto 让它靠右 (跟面包屑其它元素对齐到右边缘).
   视觉跟 GlobalBoard .gb-chrome-fab 同款 (圆角 999px + chevron + 「展开」
   文字). 不需要 vd-chrome position:relative (绝对定位已废弃). */
.vd-chrome-fab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 6px 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: 999px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted, #4b5563);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.vd-chrome-fab:hover {
  background: var(--color-bg);
  border-color: var(--color-primary, #93c5fd);
  color: var(--color-primary, #1d4ed8);
}

.vd-chrome-fab svg {
  flex-shrink: 0;
}

@media (max-width: 1023px) {
  .vd-chrome-fab span {
    display: none;
  }
  .vd-chrome-fab {
    padding: 8px;
  }
}

/* 飞书 R244: .vd-segmented/.vd-seg-* 样式随 chrome 侧活跃/历史撤除一并删 —
   分组宏现在住在 BoardPage filter 行 (复用其 .board-segmented). 只留 view-switcher. */
.vd-view-switcher {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-wrap: nowrap;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  flex-shrink: 0;
}

.vd-view-btn {
  border: 0;
  padding: 4px 12px;
  background: transparent;
  font-size: 12px;
  color: var(--color-text-muted, #4b5563);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.vd-view-btn svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.vd-view-btn:hover {
  background: var(--color-bg-hover, #f3f4f6);
}

.vd-view-btn-active {
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-weight: 500;
}

.vd-view-btn-active:hover {
  background: var(--color-primary-hover, #1d4ed8);
  color: #fff;
}

@media (max-width: 1023px) {
  .vd-view-label {
    display: none;
  }
}

/* R59: 窄屏 (≤1023px) 让 chrome 整体变 column — 避免 .vd-header-right
   flex-shrink:0 (~240px+) 把 .vd-header-text 挤扁, 内部 breadcrumb
   flex-wrap 让每个面包屑元素独占一行 = "文字被挤压成一列". 改 column
   后 header-text 占满 chrome 宽, header-right 下方延展. 控件 label
   已在上方 1023px 断点隐藏, 占宽 ~250px 刚好放得下. */
@media (max-width: 1023px) {
  .vd-chrome {
    flex-direction: column;
    gap: 12px;
  }
  .vd-header-right {
    align-items: flex-start;
    width: 100%;
  }
  /* header-text 在 column chrome 下不再是 flex 1, 显式 width: 100% 防止
     内部 .vd-cwd-row width: 100% 依赖父级 column stretch (column stretch
     默认只对 block 子级生效, .vd-cwd-row 是 flex 容器需显式 100%). */
  .vd-header-text {
    width: 100%;
  }
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
  padding: 64px 16px;
}

.state-text {
  margin: 0;
  font-size: 13px;
}

.content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  box-shadow: var(--shadow-sm);
  margin: 16px 24px 0;
}

.section-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

/* R58 折叠交互: 整行可点, chevron 旋转指示状态. 复用 section-title 字体/
   margin, 加 cursor + flex 排版 + focus-visible outline. */
.section-title-toggleable {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  padding: 4px 6px;
  margin: -4px -6px 6px;
  border-radius: var(--radius);
  transition: background 0.15s;
}
.section-title-toggleable:hover {
  background: var(--color-bg);
}
.section-title-toggleable:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.meta-chevron {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.2s;
}
.meta-chevron-open {
  transform: rotate(180deg);
}

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

.meta-link {
  color: var(--color-primary);
  text-decoration: none;
}

.meta-link:hover {
  text-decoration: underline;
}

/* 同步策略 chip — 与 ProjectDetailView version-badge 风格分清, 这里多态点更多 */
.sync-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}

.sync-inline {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 500;
}

.sync-manual { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.sync-weak   { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.sync-strong { background: var(--tw-violet-100); color: var(--tw-violet-700); }

/* v512: 自动派发已关 —— 琥珀色胶囊, 与 .sync-inline 同款形状不同色,
   视觉上表达「注意, 不是错误也不是就绪」. */
.watch-off-inline {
  display: inline-block;
  padding: 1px 8px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 500;
  background: var(--tw-amber-100);
  color: var(--tw-amber-700);
}

/* 看板区: 透明 wrapper, 不再是卡片 (用户反馈「board-card margin去掉就是」).
   之前 .board-card 有 border/radius/shadow + margin 16 24 24, 跟上方 meta-card
   形成"卡片套卡片" + 16px 缝隙, 用户要的是统一一个连续视觉 — meta-card 直接
   接看板区, 无缝. 这里只保留 flex 让 BoardPage 撑高 (board-page height:100%
   链路), border/radius/shadow/margin 全去掉. */
.board-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* R58: position:relative 让 vd-chrome-fab (absolute top:8px right:12px)
     锚定到 board-card 内, 而不飘到 viewport. */
  position: relative;
  overflow: hidden;
}

.board-card > :deep(.board-page) {
  flex: 1;
  min-height: 0;
}
</style>
