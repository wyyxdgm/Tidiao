<script setup lang="ts">
/* 功能: 项目未挂版本任务视图 — 完整镜像 Next.js /[projectId]/unversioned.
   数据源:
     - GET /api/projects/[id] 校验项目存在 + 取名字 (master route 已暴露).
     - GET /api/tasks/page (由嵌入的 R14 BoardPage 触发) 拿任务列表,
       active 200 + terminal 50, BoardPage 在 unversioned 模式下自动发
       unversioned=true 过滤参数 (R29 mode 分支).
   入口: hash 路由 /[projectId]/unversioned, static 'unversioned' vs
   static 'board' 不冲突.

   chrome 对齐版本页 (damo 10-29: 「其他任务下的按钮筛选逻辑直接参考
   具体版本」): header 整体换成 VersionDetailView .vd-chrome 同款结构
   (puv- 前缀本地副本 — 仓库 convention 是每页自持 chrome 视觉互相镜像,
   同 GlobalBoard .gb- 前缀, 不做共享组件抽象):
     - 面包屑行 (项目上下文 + 项目 › 其他任务 + 短 ID 复制 + 折叠态展开 FAB).
     - 五档视图切换器 (看板/卡片/列表/分类/聊天) + 收起 toggle. 之前本页
       只有「💬聊天视图/📋卡片视图」二元切换, 且 BoardPage 自带切换器已随
       R217v7 board-header 删除 — list/kanban/category 在本页切不到, 与
       版本页能力不一致. 现在 URL ?mode= 口径与版本页完全一致.
     - 入口按钮组 = 圆形「+」(TaskQuickCreate 对话式弹窗, 预选当前项目,
       版本下拉可切「不挂版本」) / 📖 Wiki (项目级) / 🗂 列表 (全局看板
       分类视图按项目过滤, 版本页同款) / 📋 需求点(旧) (unversioned 需求).
       旧「💬聊天视图」「+ 新建任务」表单跳转 /「🎬 控制台」/「← 返回项目」
       随对齐撤除 (返回项目走面包屑「项目」段, 与版本页同路径).

   关注点:
   - chromeOpen 折叠态与版本页**共用** localStorage key 'version-chrome-open-v1'
     — 用户在一页收起, 另一页也收起, 同一心智不分叉.
   - chrome 折叠透传 BoardPage :chrome-collapsed (隐藏其 filter bar;
     BoardPage 无自有 header, R217v7), 行为与版本页一致.
   - 复用 R14 BoardPage / TaskQuickCreate 而非复制: 本视图只负责项目校验
     + chrome, 看板逻辑 0 复制.
   - 404 处理: getProjectById 把 404/401 等归一为 null → ErrorView
     "项目不存在或无权限访问", 无 retry 按钮 (重试无效). */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getProjectById } from '@/api/projects';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/composables/useToast';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import BoardPage from '@/views/BoardPage.vue';
import TaskQuickCreate from '@/components/TaskQuickCreate.vue';
import { useTagsStore } from '@/stores/tags';
import { formatProjectWithLabel } from '@/lib/format-tab-title';

const route = useRoute();
const router = useRouter();

const toast = useToast();

/** 路由参数 projectId (强转 string 兜底, Vue Router 4 params 推断为
    string | string[], 我们走的是 :projectId 单段). */
const projectId = computed(() => String(route.params.projectId));

/** 传给嵌入 BoardPage / TaskQuickCreate 的 project 名称 — ChatView 的 pill
    显示项目名 (BoardPage 默认从 route param 拿 id, 没有 name). */
const projectName = computed<string | null>(() => project.value?.name ?? null);

const project = ref<Awaited<ReturnType<typeof getProjectById>>>(null);

/** R59: tab 标题 = 「项目(≤8)-其他任务」. applyTitle 内部尊重 customTitle. */
const tags = useTagsStore();
watch(
  () => project.value?.name,
  (name) => {
    if (!name) return;
    tags.applyTitle(
      route.path,
      formatProjectWithLabel(name, '其他任务'),
    );
  },
);
const loading = ref(false);
const error = ref<string | null>(null);
const retrying = ref(false);

/** 404 文案独立, ErrorView 用 showRetry=false 隐藏重试按钮. */
const NOT_FOUND_MSG = '项目不存在或无权限访问';

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    project.value = await getProjectById(projectId.value);
    if (!project.value) {
      error.value = NOT_FOUND_MSG;
    }
  } catch (e: unknown) {
    // getProjectById 内部已 catch → null, 理论走不到这里; 兜底防兜底.
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

/** 面包屑「项目」段点击 → 跳项目级 ProjectDetailView (版本列表 + 元数据).
    与版本页 goProject 同款语义 (原「← 返回项目」按钮由它承接). */
function goProject(): void {
  void router.push(`/projects/${projectId.value}`);
}

/** 复制当前页面 URL. 镜像 VersionDetailView copyUrl (R51 B091 同源). */
async function copyUrl(): Promise<void> {
  try {
    await copyToClipboard(window.location.href);
    toast.success('已复制链接');
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    toast.error(`复制失败: ${msg}`);
  }
}

/* ------------------------------------------------------------------ */
/*  视图模式 — 镜像 VersionDetailView R58.5+/R244 (URL ?mode= 持久化,   */
/*  BoardPage watch URL 自动同步, 无 emit/props).                       */
/* ------------------------------------------------------------------ */
type ViewMode = 'cards' | 'list' | 'grouped' | 'kanban' | 'chat' | 'category';

/** 当前 viewport 缺省视图模式 — H5 = cards, 桌面 = kanban. matchMedia 是
    sync API, 每次 setViewMode 实时取当下 viewport. */
function currentDefaultMode(): ViewMode {
  return typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 1023px)').matches
    ? 'cards'
    : 'kanban';
}

/** whitelist 必须含 'kanban' (否则 H5 上 ?mode=kanban 被错判成 cards 缺省,
    「点 kanban 还是 cards」假死感). 'grouped' 不实现 (BoardPage 没 grouped),
    走 viewport 缺省. */
const viewMode = computed<ViewMode>(() => {
  const v = String(route.query.mode || '');
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
  // URL 干净 + 用户显式选择 sticky, 与 BoardPage.setViewMode 双向一致.
  if (m === currentDefaultMode()) delete next.mode;
  else next.mode = m;
  // 切视图保留 page; statusGroup 不动 (跨段意义不同).
  void router.replace({ query: next });
}

/* ------------------------------------------------------------------ */
/*  chrome 折叠 — 与版本页共用 localStorage key, 两页状态同步.          */
/* ------------------------------------------------------------------ */
const CHROME_OPEN_KEY = 'version-chrome-open-v1';
const chromeOpen = ref<boolean>(false);
onMounted(() => {
  try {
    const raw = localStorage.getItem(CHROME_OPEN_KEY);
    if (raw === '1') chromeOpen.value = true;
  } catch {
    /* localStorage 不可用 (隐私模式/无痕) → 静默降级默认折叠 */
  }
});
watch(chromeOpen, (v) => {
  try {
    localStorage.setItem(CHROME_OPEN_KEY, v ? '1' : '0');
  } catch {
    /* 同上: 静默失败 */
  }
});
function toggleChrome(): void {
  chromeOpen.value = !chromeOpen.value;
}

/* ------------------------------------------------------------------ */
/*  chrome derived (镜像 VersionDetailView 同名 computed)               */
/* ------------------------------------------------------------------ */

const projectShortId = computed<string>(() => projectId.value.slice(0, 8));

/** 面包屑「项目」段降级 (project 未加载时). */
const breadcrumbProjectLabel = computed<string>(() =>
  project.value?.name ?? '项目',
);

/** 大标题 — 版本页形态是 `{project} / {version}`, 本页对应
    `{project} · 其他任务`. */
const pageHeading = computed<string>(() => {
  const p = projectName.value;
  return p ? `${p} · 其他任务` : '其他任务';
});

/** 入口 href — Wiki 走项目级 (无 version query), 需求点走 unversioned 需求
    (R30 路由, 锁死 version_id=null 过滤). 列表按钮照版本页走函数跳全局
    看板分类视图按项目过滤. */
const wikiHref = computed<string>(() => `/${encodeURIComponent(projectId.value)}/wiki`);
const requirementsHref = computed<string>(
  () => `/${encodeURIComponent(projectId.value)}/unversioned/requirements`,
);

/** 项目级 cwd (本页无版本继承链, 只显 project.cwd, 没有则整行不渲染). */
const effectiveCwd = computed<string | null>(() => project.value?.cwd ?? null);

/** 🗂 列表 → 全局看板分类视图按当前项目过滤 (版本页同款行为). */
function goGlobalCategory(): void {
  void router.push({ path: '/global', query: { mode: 'category', project: projectId.value } });
}

/** R232 Round4 同款: 圆形「+」开聊天式创建弹窗, 预选当前项目. */
const quickCreateOpen = ref(false);

onMounted(() => {
  void load();
});

/** route.params.projectId 变化 → 重拉 (route 切换不重挂载时也覆盖). */
watch(projectId, () => {
  void load();
});
</script>

<template>
  <div class="project-unversioned">
    <!-- Initial loading (project meta 未就绪) -->
    <div v-if="loading && !project" class="puv-loading">
      <Loading size="lg" />
      <p class="puv-loading-text">加载中…</p>
    </div>

    <!-- Project meta 加载失败 -->
    <ErrorView
      v-else-if="error"
      title="加载失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      :show-retry="error !== NOT_FOUND_MSG"
      @retry="onRetry"
    />

    <div v-else-if="project" class="puv-content">
      <!-- chrome — 镜像 VersionDetailView .vd-chrome 结构 (puv- 前缀本地副本).
           左半 .puv-header-text 纵向 stack (面包屑 + 标题 + cwd), 右半
           .puv-header-right 纵向 stack (view-switcher + 收起 toggle /
           入口按钮组). chromeOpen=false 时只留面包屑一行 + 末尾展开 FAB. -->
      <header class="puv-chrome">
        <div class="puv-header-text">
          <!-- 面包屑行: 项目上下文 + 项目 › 其他任务 + 短 ID 复制. 常显不受折叠影响. -->
          <div class="puv-breadcrumb">
            <span class="puv-context-label">项目上下文</span>
            <button
              type="button"
              class="puv-crumb-link puv-crumb-btn"
              :title="`跳到 ${breadcrumbProjectLabel}`"
              @click="goProject"
            >
              {{ breadcrumbProjectLabel }}
            </button>
            <span class="puv-crumb-sep">›</span>
            <span class="puv-crumb-current">其他任务</span>
            <button
              type="button"
              class="puv-short-id"
              :title="`复制当前页面链接 (${projectId})`"
              @click="copyUrl"
            >
              ({{ projectShortId }}…)
            </button>
            <!-- chrome 折叠态 FAB 兜底展开 — 面包屑末尾 inline 同行 (版本页同款). -->
            <button
              v-if="!chromeOpen"
              type="button"
              class="puv-chrome-fab"
              title="展开上方面板"
              aria-label="展开上方面板"
              @click="toggleChrome"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
              </svg>
              <span>展开</span>
            </button>
          </div>

          <template v-if="chromeOpen">
            <!-- 标题行: 大标题 (chromeOpen=false 时整体隐藏, 仅留面包屑). -->
            <h1 class="puv-heading">{{ pageHeading }}</h1>
            <!-- cwd 行 — 项目级 cwd, 无继承链. -->
            <div v-if="effectiveCwd" class="puv-cwd-row">
              <div class="puv-cwd">
                <span class="muted">cwd:</span>
                <span class="puv-cwd-path">{{ effectiveCwd }}</span>
              </div>
            </div>
          </template>
        </div><!-- /puv-header-text -->

        <div v-if="chromeOpen" class="puv-header-right">
          <!-- 视图模式切换器 (看板/卡片/列表/分类/聊天) + chrome 收起 toggle
               — 版本页同款排布 (vd-controls 镜像). -->
          <div class="puv-controls" role="toolbar" aria-label="视图模式">
            <div class="puv-view-switcher" role="tablist" aria-label="视图模式">
              <button
                v-for="m in (['kanban', 'cards', 'list', 'category', 'chat'] as ViewMode[])"
                :key="m"
                type="button"
                role="tab"
                :aria-selected="viewMode === m"
                :class="['puv-view-btn', { 'puv-view-btn-active': viewMode === m }]"
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
                <span class="puv-view-label">{{ m === 'cards' ? '卡片' : m === 'kanban' ? '看板' : m === 'chat' ? '聊天' : m === 'category' ? '分类' : '列表' }}</span>
              </button>
            </div>
            <!-- chrome 折叠 toggle (版本页同位置同款) -->
            <button
              type="button"
              class="puv-chrome-toggle"
              :title="chromeOpen ? '收起上方面板' : '展开上方面板'"
              :aria-expanded="chromeOpen"
              aria-label="切换上方面板折叠"
              @click="toggleChrome"
            >
              <svg class="puv-chrome-chevron" :class="{ 'puv-chrome-chevron-open': chromeOpen }" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
              </svg>
              <span>{{ chromeOpen ? '收起' : '展开' }}</span>
            </button>
          </div>
          <!-- 入口按钮组: 圆形「+」(对话式新建) / Wiki / 列表 / 需求点(旧). -->
          <div class="puv-entry-actions">
            <button
              type="button"
              class="puv-entry-fab"
              title="新建任务 (对话式, Enter 发送)"
              aria-label="新建任务"
              @click="quickCreateOpen = true"
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
              </svg>
            </button>
            <router-link
              :to="wikiHref"
              class="btn btn-secondary puv-entry-btn"
              title="项目 Wiki"
            >
              <span class="puv-entry-icon">📖</span><span class="puv-entry-text">Wiki</span>
            </router-link>
            <button
              type="button"
              class="btn btn-secondary puv-entry-btn"
              title="项目列表（任务容器 — 全局看板「分类」视图, 替代需求入口）"
              @click="goGlobalCategory"
            >
              <span class="puv-entry-icon">🗂</span><span class="puv-entry-text">列表</span>
            </button>
            <router-link
              :to="requirementsHref"
              class="btn btn-secondary puv-entry-btn"
              title="需求点管理（旧版 — 已由「列表」替代, 数据保留可查）"
            >
              <span class="puv-entry-icon">📋</span><span class="puv-entry-text">需求点(旧)</span>
            </router-link>
          </div>
        </div><!-- /puv-header-right -->
      </header>

      <!-- 看板区: 嵌入 R14 BoardPage (unversioned 模式). chrome 折叠透传,
           filter bar 同步隐藏 — 行为与版本页一致. ?mode= 由上方切换器写,
           BoardPage watch URL 自动同步. -->
      <section class="puv-board">
        <BoardPage :chrome-collapsed="!chromeOpen" :project-name="projectName" />
      </section>
    </div>

    <!-- R232 Round4 同款: 聊天式快速创建弹窗, 预选当前项目 (版本下拉可切
         「不挂版本」— TaskQuickCreate 空版本走 current→第一个→不挂 兜底). -->
    <TaskQuickCreate
      v-model="quickCreateOpen"
      :initial-project-id="projectId"
    />
  </div>
</template>

<style scoped>
.project-unversioned {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

.puv-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* chrome 顶条 — 样式镜像 VersionDetailView .vd-chrome (puv- 前缀本地副本). */
.puv-chrome {
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  padding: 18px 24px 14px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.puv-header-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.puv-header-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.puv-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.puv-context-label {
  font-size: 12px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-right: 2px;
}

.puv-crumb-link {
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
  transition: color 0.15s;
}

.puv-crumb-link:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

.puv-crumb-btn {
  /* 视觉上跟 router-link 行为一致, 走 goProject 函数 */
}

.puv-crumb-sep {
  color: var(--color-text-muted);
  opacity: 0.6;
}

/* chevron 默认朝右 (展开提示), chromeOpen=true 时旋转到 0deg 朝下 (收起提示). */
.puv-chrome-chevron {
  flex-shrink: 0;
  transform: rotate(-90deg);
  transition: transform 0.2s;
}
.puv-chrome-chevron-open {
  transform: rotate(0deg);
}

.puv-crumb-current {
  color: var(--color-text);
  font-weight: 500;
}

.puv-short-id {
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

.puv-short-id:hover {
  background: var(--color-bg);
  color: var(--color-primary);
}

.puv-heading {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
  line-height: 1.3;
}

.puv-entry-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 入口按钮缩一号, 跟 .btn (4px 12px / 12px) 对齐; 圆角 8px 与 view-switcher
   / chrome-toggle 同档 (版本页 R58.5 同款口径). */
.puv-entry-btn {
  text-decoration: none;
  white-space: nowrap;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 8px;
}

/* 圆形「+」创建入口 — 与看板 FAB 同视觉语言, inline 尺寸 34px 融进按钮排. */
.puv-entry-fab {
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

.puv-entry-fab:hover {
  filter: brightness(1.08);
}

.puv-entry-text {
  margin-left: 6px;
}

/* 窄屏入口按钮只露图标, 文字藏 (title 属性兜底 hover 提示). */
@media (max-width: 1023px) {
  .puv-entry-text {
    display: none;
  }
  .puv-entry-btn {
    padding: 4px 10px;
  }
}

.puv-cwd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.puv-cwd-path {
  word-break: break-all;
}

/* 视图模式切换器 + 收起 toggle 控件行 — 镜像 .vd-controls. */
.puv-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-left: auto;
}

/* chrome 折叠 toggle — 圆角 8px + border + 内联 svg + label, 跟
   view-switcher 同高度 (版本页/GlobalBoard 同款). */
.puv-chrome-toggle {
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

.puv-chrome-toggle:hover {
  background: var(--color-bg-hover, #f3f4f6);
  border-color: var(--color-border-hover, #d1d5db);
}

.puv-chrome-toggle svg {
  flex-shrink: 0;
  transition: transform 0.15s;
}

.puv-chrome-toggle[aria-expanded="true"] svg {
  transform: rotate(-180deg);
}

@media (max-width: 1023px) {
  .puv-chrome-toggle span {
    display: none;
  }
}

/* chrome 折叠态 FAB — 面包屑末尾 inline 同行, margin-left: auto 靠右.
   圆角 999px + chevron + 「展开」文字 (版本页/GlobalBoard 同款). */
.puv-chrome-fab {
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

.puv-chrome-fab:hover {
  background: var(--color-bg);
  border-color: var(--color-primary, #93c5fd);
  color: var(--color-primary, #1d4ed8);
}

.puv-chrome-fab svg {
  flex-shrink: 0;
}

@media (max-width: 1023px) {
  .puv-chrome-fab span {
    display: none;
  }
  .puv-chrome-fab {
    padding: 8px;
  }
}

/* 五档视图切换器 — 镜像 .vd-view-switcher (样式对齐 BoardPage
   .board-view-switcher, scoped 不共享本地副本). */
.puv-view-switcher {
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

.puv-view-btn {
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

.puv-view-btn svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.puv-view-btn:hover {
  background: var(--color-bg-hover, #f3f4f6);
}

.puv-view-btn-active {
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-weight: 500;
}

.puv-view-btn-active:hover {
  background: var(--color-primary-hover, #1d4ed8);
  color: #fff;
}

@media (max-width: 1023px) {
  .puv-view-label {
    display: none;
  }
}

/* 窄屏 chrome 整体变 column — header-right 不把 header-text 挤扁
   (版本页同款断点行为). */
@media (max-width: 1023px) {
  .puv-chrome {
    flex-direction: column;
    gap: 12px;
  }
  .puv-header-right {
    align-items: flex-start;
    width: 100%;
  }
  .puv-header-text {
    width: 100%;
  }
}

.muted {
  color: var(--color-text-muted);
}

.puv-board {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.puv-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}

.puv-loading-text {
  margin: 0;
  font-size: 14px;
}
</style>
