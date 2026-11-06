<script setup lang="ts">
/* 功能: 任务详情状态栏 — 镜像 master task-detail-client.tsx:1997-2166 状态行.
   一行 flex 布局: 状态点 + 状态字 + 类型 chip + 状态动作 (LifecycleActions slot)
   + delete + 💬聊天视图 + 📜完整会话 + 右侧工具栏 (dock 收展 + 🔍搜索 +
   ⭐评分 + ➕新建任务 + 📋Fork + 显示模式循环).

   关注点:
   - 状态/动作/链接/工具栏全部 v-model 化 (TaskDetailView 持有 source of truth),
     本组件纯展示 + emit, 跟 master status bar JSX 形态一一对应.
   - 显示模式 / 工具栏持久化由 TaskDetailView 委托 localStorage, 不在本组件.
   - 4 个 dock 面板 (详情/时间线/Checkpoints/Commits) 的 toggle 不放这里,
     用户直接点右侧 RightDock 的 panel header 即可.
   - mobile (sm:hidden) 走 ⋯ 下拉折叠剩余按钮, master 1997 / 2147 同款.
   - R50.5: 工具栏在 fork 旁边加 ➕ 按钮, 走 hash 路由 #/tasks/new?project=&version=
     复用 TaskNew.vue URL prefill (R107 R 列同款), 任何状态下可点 (有 projectId
     才显示, 同 💬聊天视图 口径). mobile 同步折叠到 ⋯ 下拉. */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import IconSvg from '@/components/IconSvg.vue';

const { t } = useI18n();

interface Props {
  taskId: string;
  status: string;
  taskType: string | null;
  /** LifecycleActions 需要的 deletedAt + awaitingOwnerReview. */
  deletedAt: string | null;
  awaitingOwnerReview: boolean;

  /** 主列还有 project_id 时才显示 💬聊天视图 (master 2007 同款). */
  projectId: string | null;
  versionId: string | null;

  /** R217v6 (damo): 聊天模式嵌入 (ChatView) 时「聊天视图」没意义 — 本来就在
      聊天视图. 传此 href (一般 = #/tasks/<id>) 则链接换成「任务视图」跳详情页,
      效果同点面包屑标题. 不传保持原「聊天视图」行为 (详情页嵌入不受影响). */
  taskViewHref?: string | null;

  /** Dock 4 面板各自展开/折叠 (master 2030-2077 同款). */
  dockOpen: {
    details: boolean;
    timeline: boolean;
    checkpoints: boolean;
    commits: boolean;
  };
  /** 整个 dock 收/展 (master 2078-2088 同款). */
  dockCollapsed: boolean;

  /** 搜索条 (master 2089-2099 同款 🔍 toggle). */
  searchOpen: boolean;
  searchQuery: string;

  /** 评分条 (master 2100-2112 同款 ⭐ toggle, 仅 completed/rejected). */
  evalOpen: boolean;

  /** 显示模式图标 + 标签 (master 2133-2145 同款, 工具栏按钮按 mode 三色). */
  displayModeMode: 'text-only' | 'all' | 'expanded';
  displayModeLabel: string;
  displayModeIcon: string;
}

const props = withDefaults(defineProps<Props>(), {
  taskType: null,
  projectId: null,
  versionId: null,
  /** R217v6: 聊天模式嵌入 (ChatView) 传入 → 「聊天视图」链接换成「任务视图」. */
  taskViewHref: null,
});

const emit = defineEmits<{
  (e: 'lifecycle-changed', newStatus: string): void;
  (e: 'lifecycle-open-resume'): void;
  /** 主级操作 (评估/重启) 也走 lifecycle-changed 路由, 但显示当前 status 已删. */
  (e: 'toggle-dock-collapsed'): void;
  (e: 'toggle-search'): void;
  (e: 'clear-search'): void;
  (e: 'toggle-eval'): void;
  (e: 'open-fork'): void;
  (e: 'cycle-display-mode'): void;
}>();

/* ------------------------------------------------------------------ */
/*  STATUS_LABELS / DOT / TYPE_COLORS — 局部常量, 与 TaskHeader 同款     */
/* ------------------------------------------------------------------ */

/* Tailwind bg-* utility classes 在 SPA 不可用 (无 tailwind/postcss), 全部用 hex
   写到 inline style. animate-pulse 用 CSS animation. 与 master src/lib/constants.ts
   STATUS_DOT 保持同色族 (R56 同步口径). */
const STATUS_DOT_COLOR: Record<string, string> = {
  pending: 'var(--tw-gray-400)',     // gray-400
  queued: 'var(--tw-blue-400)',      // blue-400
  running: 'var(--tw-sky-400)',     // sky-400
  verifying: 'var(--tw-yellow-400)',   // yellow-400 (DAG P3 收尾 2026-09-21: 同 paused 色族)
  paused: 'var(--tw-yellow-400)',      // yellow-400
  reviewing: 'var(--tw-purple-400)',   // purple-400
  completed: 'var(--tw-emerald-400)',   // emerald-400
  failed: 'var(--tw-red-400)',      // red-400
  rejected: 'var(--tw-orange-400)', // orange-400
  cancelled: 'var(--tw-gray-300)',   // gray-300
  await_user: 'var(--tw-indigo-400)',  // indigo-400
};

const STATUS_DOT_ANIMATE: Record<string, boolean> = {
  running: true,
};

/** 状态字前景色 + 背景色 — 跟 TaskHeader status-chip 同款 (reviewing=紫底紫字,
    running=青底青字 etc). 之前只有 dot 有色 + 字全灰 = 视觉割裂; 现在 bg+fg
    都跟 dot 同色系, 一眼能扫到状态. */
const STATUS_LABEL_FG: Record<string, string> = {
  pending: 'var(--tw-gray-700)',
  queued: 'var(--tw-blue-700)',
  running: 'var(--tw-sky-700)',
  verifying: 'var(--tw-violet-800)',
  paused: 'var(--tw-yellow-800)',
  reviewing: 'var(--tw-purple-800)',
  completed: 'var(--tw-emerald-800)',
  failed: 'var(--tw-red-800)',
  rejected: 'var(--tw-orange-800)',
  cancelled: 'var(--tw-gray-500)',
  await_user: 'var(--tw-indigo-700)',
};

const STATUS_LABEL_BG: Record<string, string> = {
  pending: 'var(--tw-gray-100)',
  queued: 'var(--tw-blue-100)',
  running: 'var(--tw-sky-100)',
  verifying: 'var(--tw-violet-100)',
  paused: 'var(--tw-yellow-100)',
  reviewing: 'var(--tw-purple-100)',
  completed: 'var(--tw-emerald-100)',
  failed: 'var(--tw-red-100)',
  rejected: 'var(--tw-orange-50)',
  cancelled: 'var(--tw-gray-100)',
  await_user: 'var(--tw-amber-100)',
};

// i18n: 复用 tasks.kanban.status.* / tasks.kanban.type.* locale key.
const STATUS_LABELS: Record<string, string> = {
  pending: 'tasks.kanban.status.pending',
  queued: 'tasks.kanban.status.queued',
  running: 'tasks.kanban.status.running',
  verifying: 'tasks.kanban.status.verifying',
  paused: 'tasks.kanban.status.paused',
  reviewing: 'tasks.kanban.status.reviewing',
  completed: 'tasks.kanban.status.completed',
  failed: 'tasks.kanban.status.failed',
  rejected: 'tasks.kanban.status.rejected', // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策, 曾误标等待中)
  cancelled: 'tasks.kanban.status.cancelled',
  await_user: 'tasks.kanban.status.await_user',
};

const TYPE_LABELS: Record<string, string> = {
  design: 'tasks.kanban.type.design',
  dev: 'tasks.kanban.type.dev',
  test: 'tasks.kanban.type.test',
  deploy: 'tasks.kanban.type.deploy',
};

/* 跟 STATUS_DOT 同口径 — Tailwind bg/text/border-* 在 SPA 不可用, 全部 hex
   写到 inline style. 与 master 设计同步: design=粉, dev=蓝, test=紫, deploy=绿. */
const TYPE_COLORS: Record<string, { fg: string; bg: string; border: string }> = {
  design: { fg: 'var(--tw-pink-800)', bg: 'var(--tw-pink-50)', border: 'var(--tw-pink-200)' }, // pink-700 / pink-50 / pink-200
  dev: { fg: 'var(--tw-blue-700)', bg: 'var(--tw-blue-50)', border: 'var(--tw-blue-200)' },    // blue-700 / blue-50 / blue-200
  test: { fg: 'var(--tw-violet-700)', bg: 'var(--tw-violet-50)', border: 'var(--tw-violet-200)' },   // violet-700 / violet-50 / violet-200
  deploy: { fg: 'var(--tw-emerald-700)', bg: 'var(--tw-emerald-50)', border: 'var(--tw-emerald-200)' }, // emerald-700 / emerald-50 / emerald-200
};
const TYPE_DEFAULT = { fg: 'var(--tw-gray-500)', bg: 'var(--tw-gray-50)', border: 'var(--tw-gray-200)' };

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

const statusDotStyle = computed<{ background: string }>(() => ({
  background: STATUS_DOT_COLOR[props.status] ?? 'var(--tw-gray-400)',
}));
const statusDotClass = computed<string>(() =>
  STATUS_DOT_ANIMATE[props.status] ? 'tsb-dot-pulse' : '',
);
const statusLabel = computed<string>(() => {
  const key = STATUS_LABELS[props.status];
  return key ? t(key) : props.status;
});
const statusLabelStyle = computed<{ color: string; background: string }>(() => ({
  color: STATUS_LABEL_FG[props.status] ?? 'var(--color-text)',
  background: STATUS_LABEL_BG[props.status] ?? 'transparent',
}));
const typeLabel = computed<string | null>(() =>
  props.taskType ? (TYPE_LABELS[props.taskType] ? t(TYPE_LABELS[props.taskType]) : props.taskType) : null,
);
const typeClass = computed<string | null>(() => null);
const typeChipStyle = computed<{ color: string; background: string; borderColor: string } | null>(() => {
  if (!props.taskType) return null;
  const c = TYPE_COLORS[props.taskType] ?? TYPE_DEFAULT;
  return { color: c.fg, background: c.bg, borderColor: c.border };
});

/** 聊天视图 URL — master `/${pid}/${vid || "unversioned"}?mode=chat&taskId=`.
    SPA hash 路由走 projects/<pid>/versions/<vid> + 同款 query. */
const chatViewHref = computed<string | null>(() => {
  if (!props.projectId) return null;
  const v = props.versionId ?? 'unversioned';
  return `#/projects/${props.projectId}/versions/${v}?mode=chat&taskId=${props.taskId}`;
});

/** R217v6: 视图链接二选一 — 聊天模式嵌入传了 taskViewHref → 「任务视图」
    (跳详情页); 否则原「聊天视图」. 都没有 → 不渲染. */
const viewLink = computed<{ href: string; icon: string; label: string; title: string } | null>(() => {
  if (props.taskViewHref) {
    return { href: props.taskViewHref, icon: '🗗', label: t('tasks.statusBar.taskView'), title: t('tasks.statusBar.taskViewTitle') };
  }
  if (chatViewHref.value) {
    return { href: chatViewHref.value, icon: '💬', label: t('tasks.statusBar.chatView'), title: t('tasks.statusBar.chatViewTitle') };
  }
  return null;
});

/** 完整会话转录 URL — master `/transcript/${taskId}` 新页面. SPA 暂无独立
    transcript 页, 暂时跳 SPA 同任务 (留 R56-A4 后续). */
const transcriptHref = computed<string | null>(
  () => `#/transcript/${props.taskId}`,
);

/** R50.5: 新建任务 URL — 复用 TaskNew.vue ?project=&version= URL prefill (R107 R 列同款),
    直接基于当前 task 所在 version 落地. 无 projectId 则不显示 (同 💬聊天视图 口径,
    不能盲跳到 /tasks/new 让用户手选项目). */
const newTaskHref = computed<string | null>(() => {
  if (!props.projectId) return null;
  const v = props.versionId ?? '';
  const params = new URLSearchParams({ project: props.projectId });
  if (v) params.set('version', v);
  return `#/tasks/new?${params.toString()}`;
});

/** 是否可评分 (master 2100 同款). */
const canEval = computed<boolean>(
  () => props.status === 'completed' || props.status === 'rejected',
);

/** 是否可 fork (master 2113 session_id_available 同款, R131 + await_user 也算). */
const canFork = computed<boolean>(
  () => ['paused', 'reviewing', 'rejected', 'await_user', 'completed', 'failed', 'cancelled'].includes(props.status),
);

/** 显示模式工具栏按钮三态背景色 (master 2133-2145 同款). */
const displayModeTbtnClass = computed<string>(() => {
  const m = props.displayModeMode;
  if (m === 'text-only') return 'tsb-tbtn-active-gray';
  if (m === 'expanded') return 'tsb-tbtn-active-sky';
  return 'tsb-tbtn-active-amber';
});

/* ------------------------------------------------------------------ */
/*  Toggle helpers                                                     */
/* ------------------------------------------------------------------ */

function onToggleDockCollapsed(): void {
  emit('toggle-dock-collapsed');
}
function onToggleSearch(): void {
  /* 真正的 toggle. 旧版先 emit('clear-search') 再 emit('toggle-search'),
     而父级 onToggleSearch = !searchOpen: 打开时点 🔍 走 clear(关) → toggle(开)
     = 永远关不掉. 改成 if/else: 开 → clear(关), 关 → toggle(开). */
  if (props.searchOpen) emit('clear-search');
  else emit('toggle-search');
}
function onToggleEval(): void {
  emit('toggle-eval');
}
function onOpenFork(): void {
  emit('open-fork');
}
function onCycleDisplayMode(): void {
  emit('cycle-display-mode');
}

/* ------------------------------------------------------------------ */
/*  R56-A4.4: 手机端 ⋯ 下拉 (master tdc.tsx:2147-2266 同款).               */
/* ------------------------------------------------------------------ */

/** 下拉开关. 父级只需要 dock-toggle/search/eval/fork/display-mode
    等 emit, 这里把所有 ⋯ 内点击都走现有 emit handlers 即可. */
const moreMenuOpen = ref<boolean>(false);

function toggleMoreMenu(): void {
  moreMenuOpen.value = !moreMenuOpen.value;
}
function closeMoreMenu(): void {
  moreMenuOpen.value = false;
}

/** mobile 点 pill 外关菜单 — backdrop 在模板里. */
function onToggleDockCollapsedFromMenu(): void {
  emit('toggle-dock-collapsed');
  closeMoreMenu();
}
function onToggleSearchFromMenu(): void {
  emit('toggle-search');
  closeMoreMenu();
}
function onToggleEvalFromMenu(): void {
  emit('toggle-eval');
  closeMoreMenu();
}
function onOpenForkFromMenu(): void {
  emit('open-fork');
  closeMoreMenu();
}
function onCycleDisplayModeFromMenu(): void {
  emit('cycle-display-mode');
  closeMoreMenu();
}
</script>

<template>
  <!-- R56-A3.2 (C3): master tdc.tsx:1997 状态行 — flex flex-nowrap mobile 横向滚,
       sm+ 恢复 flex-wrap 自适应; 整体 relative 给后续 mobile ⋯ 下拉定位锚. -->
  <div class="tsb-root">
    <div class="tsb-row relative">
      <span
        class="tsb-dot"
        :class="statusDotClass"
        :style="statusDotStyle"
        aria-hidden="true"
      />
      <span class="tsb-label" :style="statusLabelStyle">{{ statusLabel }}</span>
      <span
        v-if="typeLabel"
        class="tsb-type-chip"
        :class="typeClass"
        :style="typeChipStyle"
      >{{ typeLabel }}</span>

      <!-- 状态动作槽位 — 父级传 <LifecycleActions/> 进来, 复用现有 action + confirm
           逻辑 (start/pause/cancel/approve/refine/restart/await/unawait/delete). -->
      <slot name="actions" />

      <!-- 📜 完整会话 (master 2016-2024 同款 — 始终可见, mobile icon-only). -->
      <a
        v-if="transcriptHref"
        :href="transcriptHref"
        target="_blank"
        rel="noopener noreferrer"
        class="tsb-link"
        :title="t('tasks.statusBar.transcriptTitle')"
      >
        📜 <span class="tsb-link-text">{{ t('tasks.statusBar.transcript') }}</span>
      </a>

      <!-- R217v6: 视图链接 — 详情页嵌 = 💬聊天视图; 聊天模式嵌 (ChatView 传
           task-view-href) = 🗗任务视图 (跳详情页, 同点面包屑标题). -->
      <a
        v-if="viewLink"
        :href="viewLink.href"
        class="tsb-link"
        :title="viewLink.title"
      >
        {{ viewLink.icon }} <span class="tsb-link-text">{{ viewLink.label }}</span>
      </a>

      <!-- 右侧工具栏 (master 2029-2146) — ml-auto 推到右, mobile 隐藏整体,
           由下面的 ⋯ 折叠. 4 个 dock 面板 toggle 不在这里, 走 RightDock panel header. -->
      <div class="tsb-toolbar">
        <!-- R61: 激活态 = dock 展开中. 原代码写反了 (dockCollapsed 才加
             tsb-tbtn-active-blue), 用户反馈「感觉现在状态有点放过来」.
             现在 dock 展开 → 蓝底高亮, 收起 → 灰. -->
        <button
          type="button"
          class="tsb-tbtn"
          :class="props.dockCollapsed ? '' : 'tsb-tbtn-active-blue'"
          :title="props.dockCollapsed ? t('tasks.statusBar.expandDock') : t('tasks.statusBar.collapseDock')"
          @click="onToggleDockCollapsed"
        >
          {{ props.dockCollapsed ? t('tasks.statusBar.panelCollapsedIcon') : '◨' }}
        </button>
        <button
          type="button"
          class="tsb-tbtn"
          :class="(props.searchOpen || props.searchQuery) ? 'tsb-tbtn-active-sky' : ''"
          :title="t('tasks.statusBar.searchMessages')"
          @click="onToggleSearch"
        >
          🔍
        </button>
        <button
          v-if="canEval"
          type="button"
          class="tsb-tbtn"
          :class="props.evalOpen ? 'tsb-tbtn-active-amber' : ''"
          :title="t('tasks.statusBar.eval')"
          @click="onToggleEval"
        >
          ⭐
        </button>
        <button
          v-if="canFork"
          type="button"
          class="tsb-tbtn"
          :title="t('tasks.statusBar.forkSession')"
          @click="onOpenFork"
        >
          <span><IconSvg name="fork" /></span><span class="tsb-tbtn-text">Fork</span>
        </button>
        <!-- R50.5: ➕ 新建任务 (基于当前 task 所在 version). 任何状态可点, 走 TaskNew
             ?project=&version= URL prefill (复用 R107 R 列同款). 无 projectId 不显示,
             同 💬聊天视图 口径. 放在 fork 旁边, tsb-tbtn-text 仅 ≥1024px 显示「新建」文字. -->
        <a
          v-if="newTaskHref"
          :href="newTaskHref"
          class="tsb-tbtn"
          :title="t('tasks.statusBar.newTaskTitle')"
        >
          <span>➕</span><span class="tsb-tbtn-text">{{ t('tasks.statusBar.new') }}</span>
        </a>
        <button
          type="button"
          class="tsb-tbtn"
          :class="displayModeTbtnClass"
          :title="t('tasks.statusBar.displayModeTitle', { mode: props.displayModeLabel })"
          @click="onCycleDisplayMode"
        >
          <IconSvg :name="props.displayModeIcon" />
        </button>
      </div>

      <!-- R56-A4.4: 手机端 ⋯更多 按钮 (master tdc.tsx:2151-2165 同款). 桌面 (sm:) 由
           上面 tsb-toolbar 渲染, 这里 mobile-only. -->
      <div class="tsb-more-trigger">
        <button
          type="button"
          class="tsb-tbtn"
          :class="moreMenuOpen ? 'tsb-tbtn-active-blue' : ''"
          :title="t('tasks.statusBar.menuAria')"
          aria-haspopup="menu"
          :aria-expanded="moreMenuOpen"
          @click="toggleMoreMenu"
        >⋯</button>
      </div>
    </div>

    <!-- R56-A4.4: 手机端下拉菜单 — 折叠 dock 收展/搜索/评分/Fork + displayMode +
         完整会话链接 (master tdc.tsx:2169-2267 同款). 4 个面板 toggle 不在这里,
         走 RightDock panel header. absolute 定位浮在状态栏下方, 不撑高 flex-wrap 行. -->
    <template v-if="moreMenuOpen">
      <div class="tsb-more-backdrop" @click="closeMoreMenu" aria-hidden="true" />
      <div role="menu" class="tsb-more-menu">
        <button
          type="button"
          class="tsb-more-item"
          @click="onCycleDisplayModeFromMenu"
        >
          <span><IconSvg :name="props.displayModeIcon" /></span>
          <span>{{ t('tasks.statusBar.viewPrefix') }}{{ props.displayModeLabel }}</span>
        </button>
        <div class="tsb-more-divider" />
        <!-- 「完整会话」从 ⋯ 下拉里删 — 状态栏已经始终有 📜 图标 (R56 之前
             是 .tsb-link-hidden-mobile 整段藏, 现在保留只 icon-only), 重复了. -->
        <button
          type="button"
          class="tsb-more-item"
          @click="onToggleDockCollapsedFromMenu"
        >
          <span>{{ props.dockCollapsed ? '◧' : '◨' }}</span>
          <span>{{ props.dockCollapsed ? t('tasks.statusBar.expandDock') : t('tasks.statusBar.collapseDock') }}</span>
        </button>
        <button
          type="button"
          class="tsb-more-item"
          @click="onToggleSearchFromMenu"
        >
          <span>🔍</span><span>{{ t('tasks.statusBar.searchMessages') }}</span>
        </button>
        <button
          v-if="canEval"
          type="button"
          class="tsb-more-item"
          @click="onToggleEvalFromMenu"
        >
          <span>⭐</span><span>{{ t('tasks.statusBar.eval') }}</span>
        </button>
        <button
          v-if="canFork"
          type="button"
          class="tsb-more-item"
          @click="onOpenForkFromMenu"
        >
          <span><IconSvg name="fork" /></span><span>{{ t('tasks.statusBar.forkSession') }}</span>
        </button>
        <!-- R50.5: ➕ 新建任务 (mobile 折叠到下拉, 同 fork 兜底). -->
        <a
          v-if="newTaskHref"
          :href="newTaskHref"
          class="tsb-more-item"
          @click="closeMoreMenu"
        >
          <span>➕</span><span>{{ t('tasks.statusBar.newTaskTitle') }}</span>
        </a>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
// 不再需要单独的 <script> 块 (displayModeTbtnClass 已搬到 setup).
export default {
  name: 'TaskStatusBar',
};
</script>

<style scoped>
.tsb-root {
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  /* 手机端 ⋯ 下拉 (`.tsb-more-menu` `position: absolute; top: 100%`) 需要定位锚.
     `.tsb-row` 虽然 position:relative, 但 menu 是 row 的兄弟节点不是后代,
     找不到 row 只能一路走到 viewport → menu 落到屏幕最底. 这里把 .tsb-root
     设为定位祖先即可. */
  position: relative;
}

.tsb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  flex-wrap: nowrap;
  overflow-x: auto;
  position: relative;
}

@media (min-width: 640px) {
  .tsb-row {
    gap: 8px;
    padding: 8px 16px;
    flex-wrap: wrap;
    overflow: visible;
  }
}

.tsb-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 9999px;
  flex-shrink: 0;
}
/* 跑动中的 dot 走原生 CSS animate-pulse — Tailwind utility 在 SPA 不可用 */
.tsb-dot-pulse {
  animation: tsb-dot-pulse 1.4s ease-in-out infinite;
}
@keyframes tsb-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.tsb-label {
  font-size: 13px;
  font-weight: 500;
  /* 颜色由 :style="statusLabelStyle" 注入 (fg+bg 跟 dot 同色系) */
  padding: 2px 8px;
  border-radius: 9999px;
  /* R59+: H5 flex 排不下时 .tsb-label 被 flex-shrink:1 (默认) 压窄, 中文
     text 按字宽断行变竖直单字多行, 加上 border-radius:9999px, pill 从横向
     胶囊被挤成竖直胶囊看着「圆了」(用户原话「tsb-label 状态文字背景, 圆了」).
     flex-shrink:0 保不被压, white-space:nowrap 保不换行, 两件一起才能维持
     横向 pill 形状. 跟 .tsb-type-chip 同口径 (line 516 flex-shrink:0). */
  flex-shrink: 0;
  white-space: nowrap;
}

.tsb-type-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid transparent;
  flex-shrink: 0;
}

.tsb-link {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  padding: 3px 8px;
  min-height: 26.5px; /* 跟 .tsb-tbtn / Button size="mini" 同档 — 一排按钮统一高度 */
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-muted, #4b5563);
  text-decoration: none;
  flex-shrink: 0;
  gap: 6px;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.tsb-link:hover {
  background: var(--tw-gray-50);
  color: var(--tw-blue-600);
  border-color: var(--tw-blue-300);
}

.tsb-link-text {
  /* icon 文字间距走父 .tsb-link 的 gap, 这里只负责 mobile 隐藏 */
}
/* 小屏幕 (跟 .tsb-tbtn-text 1024px 同断点) — 链接只露图标, 文字藏. */
@media (max-width: 1023px) {
  .tsb-link-text {
    display: none;
  }
  .tsb-link {
    padding: 6px 10px;
  }
}

.tsb-toolbar {
  margin-left: auto;
  display: none;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
@media (min-width: 640px) {
  .tsb-toolbar {
    display: flex;
  }
}

.tsb-tbtn {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  padding: 3px 8px;
  min-height: 26.5px; /* 跟 .tsb-link / Button size="mini" 同档 — 一排按钮统一高度 */
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-muted, #4b5563);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.tsb-tbtn:hover {
  background: var(--tw-gray-50);
}

.tsb-tbtn-text {
  margin-left: 4px;
}
@media (max-width: 1023px) {
  .tsb-tbtn-text {
    display: none;
  }
}

.tsb-tbtn-active-blue {
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
  border-color: var(--tw-blue-200);
}
.tsb-tbtn-active-sky {
  background: var(--tw-sky-100);
  color: var(--tw-sky-700);
  border-color: var(--tw-sky-200);
}
.tsb-tbtn-active-purple {
  background: var(--tw-purple-100);
  color: var(--tw-purple-700);
  border-color: var(--tw-purple-200);
}
.tsb-tbtn-active-emerald {
  background: var(--tw-emerald-100);
  color: var(--tw-emerald-700);
  border-color: var(--tw-emerald-200);
}
.tsb-tbtn-active-indigo {
  background: var(--tw-indigo-100);
  color: var(--tw-indigo-700);
  border-color: var(--tw-indigo-200);
}
.tsb-tbtn-active-amber {
  background: var(--tw-amber-100);
  color: var(--tw-amber-700);
  border-color: var(--tw-amber-200);
}
.tsb-tbtn-active-gray {
  background: var(--tw-gray-100);
  color: var(--tw-gray-700);
  border-color: var(--tw-gray-300);
}

/* R56-A4.4: 手机端 ⋯ 触发按钮 (sm:hidden) + 下拉菜单.
   master tdc.tsx:2151-2165 + 2169-2267 同款 — mobile-only, 桌面 hidden. */
.tsb-more-trigger {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
}
@media (min-width: 640px) {
  .tsb-more-trigger {
    display: none;
  }
}

.tsb-more-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
@media (min-width: 640px) {
  .tsb-more-backdrop {
    display: none;
  }
}

.tsb-more-menu {
  position: absolute;
  right: 8px;
  top: 100%;
  margin-top: 4px;
  z-index: 50;
  min-width: 180px;
  padding: 4px 0;
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-gray-200);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
}
@media (min-width: 640px) {
  .tsb-more-menu {
    display: none;
  }
}

.tsb-more-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  font-size: 12px;
  text-align: left;
  background: transparent;
  border: 0;
  color: var(--tw-gray-700);
  cursor: pointer;
  text-decoration: none;
}
.tsb-more-item:hover {
  background: var(--tw-gray-50);
}

.tsb-more-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--tw-gray-100);
}

.tsb-more-item-active-sky     { color: var(--tw-sky-700); font-weight: 500; }
.tsb-more-item-active-purple  { color: var(--tw-purple-800); font-weight: 500; }
.tsb-more-item-active-emerald { color: var(--tw-emerald-700); font-weight: 500; }
.tsb-more-item-active-indigo  { color: var(--tw-indigo-700); font-weight: 500; }
</style>
