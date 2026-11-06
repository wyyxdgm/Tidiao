<script setup lang="ts">
/* 功能: Uncategorized 未分类任务视图 — 对应 Next src/app/uncategorized/page.tsx +
   master 后端 GET /api/tasks?unassigned=true. R33 字面要求 = 列表展示当前用户
   project_id IS NULL 的任务 (legacy "未挂项目" tasks).

   关注点 (sheet R33 + 与现实分歧):
   - 与 Next /uncategorized/page.tsx 的语义分歧已披露: Next 端只做 server-side
     redirect → /{未分类project}/unversioned (legacy bookmark compat), 不渲染
     列表. SPA 直接走 REST API 渲染真「未挂项目」tasks = 更直观的「inbox」体验
     (用户能看到所有待整理的任务, 而不是再跳一次). 这是 SPA 主动加强的功能.
   - 列表数据源单一: GET /api/tasks?unassigned=true, 不引 BoardPage R14 的
     /api/tasks/page (后者是 statusGroup-driven 看板, 与 unassigned 互斥语义).
   - 状态过滤 chip 在前端做 (服务端不带 status in(...) 参数, 11 状态集小,
     客户端 O(n) 过滤开销忽略; 切 filter 即时响应, 不用回服务端).
   - 不挂 SSE / 不接分页 (后端不带). 用户主动点刷新按钮拉新.
   - 状态机三态: 加载中 (R11 Loading) / 加载失败 (R13 ErrorView + 重试) /
     空 (R13 Empty inbox 插画, 附 CTA "去新建任务" 占位, R+ 范畴).
   - TaskCard 复用 R15 组件 (status chip + priority + owner + 时间); 卡片点
     击跳 /tasks/[id], R19 TaskDetailView 已就位. */
import { computed, onMounted, ref } from 'vue';
import {
  listUnassignedTasks,
  DISPLAY_TASK_STATUSES,
  STATUS_LABELS,
  type UnassignedTask,
  type TaskStatus,
} from '@/api/tasks';
import { isHttpError } from '@/api/http';
import Button from '@/components/Button.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import TaskCard from '@/components/TaskCard.vue';

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const tasks = ref<UnassignedTask[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

/** 状态过滤 — '' = 全部. 客户端切 chip 即时过滤, 不回服务端. */
const statusFilter = ref<'' | TaskStatus>('');

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** 状态过滤选项 — chip 渲染列表, 顺序与 DISPLAY_TASK_STATUSES 一致
    (10 态; 历史 rejected 已并入 cancelled, 2026-09-15 决策). */
const STATUS_FILTER_OPTIONS: { value: '' | TaskStatus; label: string }[] = [
  { value: '', label: '全部' },
  ...DISPLAY_TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
];

/** 过滤后任务列表. 客户端 O(n) — 11 状态集小, 全量数据集典型几十条. */
const filteredTasks = computed<UnassignedTask[]>(() => {
  const f = statusFilter.value;
  if (!f) return tasks.value;
  return tasks.value.filter((t) => t.status === f);
});

/** 总数 (含当前 filter 计数 + 全量计数). 头部 badge 用. */
const filteredCount = computed<number>(() => filteredTasks.value.length);
const totalCount = computed<number>(() => tasks.value.length);

/** 当前 filter 命中的 chip 是否高亮. */
function isStatusActive(s: '' | TaskStatus): boolean {
  return statusFilter.value === s;
}

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

/** 拉一次列表. onMounted + 手动刷新共用. */
async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await listUnassignedTasks();
    tasks.value = Array.isArray(list) ? list : [];
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || `加载失败 (HTTP ${e.status})`;
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

function onRetry(): void {
  retrying.value = true;
  void refresh();
}

function onManualRefresh(): void {
  // 手动刷新按钮 — 即便当前没报错也走 loading, 给用户视觉反馈.
  void refresh();
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="uncategorized-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">未分类任务</h1>
        <p class="page-subtitle">
          project_id 为空的 task (legacy 「未挂项目」). 多为定时任务脚本派发 /
          调度器漏派 / 用户手动创建后未挂项目等场景. 点击卡片跳详情.
        </p>
      </div>
      <div class="header-actions">
        <span class="meta-count">
          <template v-if="statusFilter">
            {{ filteredCount }} / {{ totalCount }} 条
          </template>
          <template v-else>
            共 {{ totalCount }} 条
          </template>
        </span>
        <Button
          variant="secondary"
          size="sm"
          :loading="loading && tasks.length > 0"
          :disabled="loading"
          @click="onManualRefresh"
        >
          ↻ 刷新
        </Button>
      </div>
    </header>

    <!-- Status filter chips -->
    <div class="filter-bar">
      <button
        v-for="opt in STATUS_FILTER_OPTIONS"
        :key="opt.value || 'all'"
        type="button"
        :class="['chip', isStatusActive(opt.value) ? 'chip-active' : 'chip-default']"
        @click="statusFilter = opt.value"
      >
        {{ opt.label }}
      </button>
    </div>

    <!-- Body -->
    <div class="page-body">
      <div v-if="loading && tasks.length === 0" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">加载中…</p>
      </div>

      <ErrorView
        v-else-if="error"
        title="加载失败"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <Empty
        v-else-if="filteredTasks.length === 0"
        :title="statusFilter ? '该状态下没有未挂项目任务' : '没有未挂项目任务'"
        :description="statusFilter
          ? '切换到「全部」或选择其他状态试试'
          : '所有任务都归属到了项目, 状态良好. 如需把任务挂到项目, 跳详情页编辑.'"
        illustration="inbox"
      />

      <div v-else class="list-block">
        <TaskCard
          v-for="t in filteredTasks"
          :key="t.id"
          :task="t"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  页面                                                                */
/* ------------------------------------------------------------------ */
.uncategorized-page {
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
  gap: 12px;
  flex-shrink: 0;
}
.meta-count {
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  Filter bar                                                          */
/* ------------------------------------------------------------------ */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.chip {
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.chip-default:hover {
  background: var(--tw-blue-50);
  border-color: var(--tw-blue-300);
}
.chip-active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

/* ------------------------------------------------------------------ */
/*  Body                                                                */
/* ------------------------------------------------------------------ */
.page-body {
  flex: 1;
  padding: 20px 24px 32px;
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
/*  List                                                               */
/* ------------------------------------------------------------------ */
.list-block {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
  max-width: 1200px;
}
</style>