<script setup lang="ts">
/* 功能: 任务卡片 — 单卡片渲染 + 整卡点击跳详情 + hover 显示完整标题.
   接受简化 task 形状 (字段直接由父组件 /api/tasks/page 解出后传入, 组件不做 fetch).
   视觉与 BoardPage.vue 内联 .task-card 对齐, 但作为可复用组件独立出来.

   关注点 (R15 边界):
   - 只做 "展示 + 跳路由", 不挂 SSE / 不做拖拽 / 不内嵌右键菜单. 这些是
     M3+ 范畴, 单独派 task 接入. 本组件强解耦 (无 store 订阅, 无 onMounted).
   - owner 字段透传: TaskTrimmed 接口没有 owner_name, 仅 owner_id. 父组件
     传 owner 字符串 (从 /api/users 取或预留 null) 时优先展示; 否则回落到
     owner_id 短 8 字符 (与 TaskByChip 同款口径); 全空 → "未分配".
   - status chip 11 色与 Next TaskStatusChip "同款色系": 圆润 pill + 浅 bg
     + 较深 text + 低饱和. 不引 Tailwind palette, 与 BoardPage R14 风格统一.
   - 路由 /tasks/[id] 当前未挂载 (M3 范畴). 组件先按 router.push 写, M3
     挂载后零改动; 路由未注册时 router.push 静默失败, 不阻塞.
   - 不引入新依赖. */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { parseDbTime } from '@/lib/datetime';
import TaskResourceBadge from '@/components/TaskResourceBadge.vue';
import QueuedReasonHint from '@/components/QueuedReasonHint.vue';
import type { TaskResourceSample } from '@/composables/useTaskResources';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 11 个 TaskStatus — 与 master src/lib/runtime/types.ts TaskStatus 对齐.
    R131 加入 await_user. */
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

/** 卡片需要的最小字段集. 父组件从 TaskTrimmed 透传, 缺字段以 optional 兜底.
    组件不强制要求完整 TaskTrimmed, 便于父组件 (BoardPage / KanbanView /
    SearchResult) 按需投影. */
export interface TaskCardData {
  id: string;
  title: string;
  status: TaskStatus;
  /** 0 = 默认无优先级. >0 显示 P{n} 标签. */
  priority?: number;
  /** ISO string. 缺省 → 用 updated_at / 不渲染. */
  created_at?: string;
  /** ISO string. 缺省 created_at 时作为回落. */
  updated_at?: string;
  /** owner_id 短标识 (8 字符). 父组件可传更长字符串 (用户名/邮箱). */
  owner_id?: string | null;
  /** 是否软删除 — 走 deleted_at 非空判定. */
  deleted_at?: string | null;
  /** v531: 排队原因人话串 (父组件投影时透传). queued 状态才渲染. */
  queued_reason?: string | null;
}

interface TaskCardProps {
  task: TaskCardData;
  /** 解析后的 owner 显示名 (优先于 owner_id 短 8 字符). 不传 → 走回落. */
  owner?: string | null;
  /** R232: 该任务的资源采样 (父组件从 useTaskResources 单例取). 不传不渲染徽章. */
  resource?: TaskResourceSample | null;
}

const props = defineProps<TaskCardProps>();
const router = useRouter();

/* ------------------------------------------------------------------ */
/*  Status chip — 11 状态色 (与 BoardPage R14 scoped class 同源)       */
/* ------------------------------------------------------------------ */

/** 状态中文标签 — 与 master STATUS_LABELS 对齐. */
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待执行',
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  reviewing: '待审核',
  verifying: '验收中',
  await_user: '等用户介入',
  completed: '已完成',
  failed: '失败',
  rejected: '已取消', // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策, 曾误标等待中)
  cancelled: '已取消',
};

/** 状态 → chip class. 用本组件 scoped class, 不引 Tailwind palette
    (项目统一规范, 见 R8 Input / R9 Select 风格). */
const STATUS_CHIP_CLASS: Record<TaskStatus, string> = {
  pending: 'tc-status-pending',
  queued: 'tc-status-queued',
  running: 'tc-status-running',
  paused: 'tc-status-paused',
  reviewing: 'tc-status-reviewing',
  verifying: 'tc-status-verifying',
  await_user: 'tc-status-await-user',
  completed: 'tc-status-completed',
  failed: 'tc-status-failed',
  rejected: 'tc-status-rejected',
  cancelled: 'tc-status-cancelled',
};

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** status 显示 class (含 unknown 兜底). */
const statusClass = computed<string>(() =>
  STATUS_CHIP_CLASS[props.task.status] || 'tc-status-default',
);

/** status 中文标签 (含 unknown 兜底). */
const statusLabel = computed<string>(() =>
  STATUS_LABELS[props.task.status] || props.task.status,
);

/** 优先级文本. priority>0 才显示. */
const priorityText = computed<string | null>(() =>
  props.task.priority && props.task.priority > 0 ? `P${props.task.priority}` : null,
);

/** 显示用 owner 字符串.
    解析顺序: props.owner (如有) → owner_id 短 8 字符 → "未分配". */
const ownerText = computed<string>(() => {
  const o = props.owner;
  if (o && o.trim().length > 0) return o;
  const id = props.task.owner_id;
  if (id && id.length > 0) return id.slice(0, 8);
  return '未分配';
});

/** 显示用时间. 优先 created_at; 缺则回落 updated_at. */
const createdAtText = computed<string | null>(() => {
  const iso = props.task.created_at || props.task.updated_at;
  if (!iso) return null;
  return formatDateTime(iso);
});

/** 软删标识. */
const isDeleted = computed<boolean>(() => !!props.task.deleted_at);

/** ISO → MM-DD HH:mm. 与 BoardPage R14 formatUpdatedAt 同口径.
    R56-B18: 用 parseDbTime 当 UTC 处理 (master src/lib/datetime.ts 同口径),
    旧 new Date(iso) 在 CST 偏 8h, 跟 master /global 看板对不上. */
function formatDateTime(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

/** 整卡点击跳 /tasks/[id]. 子元素 (status chip 等) 不挂自己的 onClick,
    冒泡自然走 card 路由. M3 路由未注册时 router.push 静默失败, 不报错. */
function onCardClick(): void {
  void router.push(`/tasks/${props.task.id}`);
}
</script>

<template>
  <article
    :class="['tc-root', { 'tc-deleted': isDeleted }]"
    role="button"
    tabindex="0"
    :aria-label="`任务: ${task.title}`"
    :title="task.title"
    @click="onCardClick"
    @keydown.enter.prevent="onCardClick"
    @keydown.space.prevent="onCardClick"
  >
    <div class="tc-top">
      <span :class="['tc-status', statusClass]">{{ statusLabel }}</span>
      <QueuedReasonHint :status="task.status" :reason="task.queued_reason" />
      <span v-if="priorityText" class="tc-priority">{{ priorityText }}</span>
      <span v-if="isDeleted" class="tc-deleted-badge">已删除</span>
    </div>

    <h3 :class="['tc-title', { 'tc-title-strike': isDeleted }]">
      {{ task.title }}
    </h3>

    <div class="tc-meta">
      <span class="tc-owner" :title="`归属：${ownerText}`">@{{ ownerText }}</span>
      <span v-if="createdAtText" class="tc-time">{{ createdAtText }}</span>
      <!-- R232: 运行中任务资源徽章 — 父组件传 resource (useTaskResources 采样) 才渲染. -->
      <TaskResourceBadge
        v-if="resource"
        :sample="resource"
        :warn="(resource.cpuPercent ?? 0) > 80 || (resource.memPercent ?? 0) > 50"
        class="tc-resource-badge"
      />
    </div>
  </article>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

.tc-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s, transform 0.05s;
  outline: none;
}

.tc-root:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
}

.tc-root:focus-visible {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-soft, rgba(59, 130, 246, 0.35));
}

.tc-root:active {
  transform: translateY(1px);
}

.tc-deleted {
  opacity: 0.6;
  border-color: var(--tw-red-200);
}

/* R232: 资源徽章贴 meta 行右侧. */
.tc-resource-badge {
  margin-left: auto;
}

.tc-deleted:hover {
  opacity: 1;
}

/* ------------------------------------------------------------------ */
/*  Top row: status chip + priority + deleted badge                    */
/* ------------------------------------------------------------------ */

.tc-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* ------------------------------------------------------------------ */
/*  Status chip — 11 色 (与 Next TaskStatusChip 同款色系: 圆润 pill +  */
/*  浅 bg + 较深 text + 低饱和). 不引 Tailwind palette.                */
/* ------------------------------------------------------------------ */

.tc-status {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.tc-status-pending    { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.tc-status-queued     { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.tc-status-running    { background: var(--tw-sky-100); color: var(--tw-sky-700); }
.tc-status-paused     { background: var(--tw-yellow-100); color: var(--tw-yellow-800); }
.tc-status-reviewing  { background: var(--tw-purple-100); color: var(--tw-purple-800); }
.tc-status-verifying  { background: var(--tw-violet-100); color: var(--tw-violet-800); }
.tc-status-await-user { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.tc-status-completed  { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.tc-status-failed     { background: var(--tw-red-100); color: var(--tw-red-800); }
.tc-status-rejected   { background: var(--tw-orange-50); color: var(--tw-orange-700); }
.tc-status-cancelled  { background: var(--tw-gray-100); color: var(--tw-gray-500); }
.tc-status-default    { background: var(--tw-gray-100); color: var(--tw-gray-700); }

.tc-priority {
  font-size: 11px;
  color: var(--tw-orange-600);
  font-weight: 500;
}

.tc-deleted-badge {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--tw-red-100);
  color: var(--tw-red-700);
  font-size: 11px;
  font-weight: 500;
}

/* ------------------------------------------------------------------ */
/*  Title — hover 由 .tc-root 触发边框/阴影, 完整标题走 title attribute */
/* ------------------------------------------------------------------ */

.tc-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-text);
  /* 单卡片标题可能很长 — 限两行 + 省略, hover 时浏览器原生 title 显示完整 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.tc-title-strike {
  text-decoration: line-through;
}

/* ------------------------------------------------------------------ */
/*  Meta — owner + created_at                                          */
/* ------------------------------------------------------------------ */

.tc-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: auto;
}

.tc-owner {
  font-variant-numeric: tabular-nums;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tc-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
</style>