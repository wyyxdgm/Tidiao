<script setup lang="ts">
/* 功能: 看板拖拽视图 — 11 个 status 各成一列, HTML5 原生 drag/drop 把卡片从源
   列拖到目标列, 走现有 POST /api/tasks/[id]/{action} 端点改 status. 成功 →
   emit('updated', taskId, newStatus), 父组件 reload; 失败 → toast.error + 不改.

   关注点 (R48):
   - 不引 dnd-kit / SortableJS, HTML5 原生足够 MVP. dataTransfer 在 drop 时
     仍可读, 兜底用 state 取 source status.
   - 跨列只改 status, 不重排; 同列排序 = R51 (B107) handleSameColReorder,
     列内显示顺序由 sortTasksForKanban 决定 (queued_order ASC 优先, NULL 回落
     updated_at DESC).
   - 不做乐观本地 state: 失败回滚复杂, 直接等服务端响应 → 父组件 refreshAll
     (master 同口径, 走 SSE 推 patch).
   - DRAG_ACTION 复刻 master src/lib/constants.ts:209-223 getStatusDragAction,
     inline; null = 非法 transition → toast 拒 drop, 不发请求.
   - dequeue/await/unawait 需要 body (reason), 其它走空 body. */
import { computed, ref } from 'vue';
import { post, HttpError } from '@/api/http';
import { useI18n } from 'vue-i18n';
import { formatShortDateTime } from '@/lib/datetime';
import { sortTasksForKanban } from './sort-tasks';
import { useToast } from '@/composables/useToast';
import Empty from '@/components/Empty.vue';
import TaskResourceBadge from '@/components/TaskResourceBadge.vue';
import type { TaskResourceSample } from '@/composables/useTaskResources';
import {
  STATUS_LABELS,
  DISPLAY_TASK_STATUSES,
  type TaskStatus,
} from '@/api/tasks';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AwaitingMarker { label: string; title: string; color: string; }

interface TaskTrimmed {
  id: string;
  title: string;
  status: TaskStatus;
  type: string | null;
  priority: number;
  model: string | null;
  resolved_model: string | null;
  tags: string | null;
  project_id: string | null;
  version_id: string | null;
  deleted_at: string | null;
  updated_at: string;
  /** v510: 手动排序序号 (R51/B107). API /api/tasks/page 返回; NULL = 用户没排过. */
  queued_order: number | null;
  awaiting_markers: string | null;
  awaiting_owner_review: number;
  dispatched_by_task_id: string | null;
}

interface Props {
  tasks: TaskTrimmed[];
  /** global board 传, 显示归属; version/unversioned board 不传. */
  scopeLabels?: {
    projectNames: Record<string, string>;
    versionNames: Record<string, string>;
  };
  /* R56-A0: 列顺序 = 用户在 chip 行拖出的 chipOrder (master columnOrder 1:1).
     不传 → 走 ALL_TASK_STATUSES 默认顺序 (global board 当前行为, 不破坏). */
  columnOrder?: TaskStatus[];
  /* R56-A0: 已选 status. 传了 → 不在集合里的 status 列直接不渲染 (对应
     "隐藏后面板也隐藏", master kanban-view.tsx:196-206 同款).
     不传 → 全 11 列都渲染 (global board 当前行为, 不破坏). */
  selectedStatuses?: Set<TaskStatus>;
  /* R232: taskId → 资源采样 (父组件 useTaskResources 单例轮询).
     不传 → 卡片不渲染资源徽章 (向后兼容). */
  resources?: Record<string, TaskResourceSample>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'updated', taskId: string, newStatus: TaskStatus): void;
}>();

/* i18n (W3a): 用户可见字符串走 t('tasks.kanban.*'); 文案源在
   spa/src/i18n/locales/{zh-CN,en-US}/ 下 tasks 域文件 (W3 整合时落盘).
   te() 兜底: locale 域文件未就绪 / 未知 status 时回落旧 STATUS_LABELS 或原始值. */
const { t, te } = useI18n();

/** status 列名: 优先走 locale, miss 时回落 STATUS_LABELS (中文) / 原始 key. */
function statusLabel(s: TaskStatus): string {
  const k = `tasks.kanban.status.${s}`;
  return te(k) ? t(k) : (STATUS_LABELS[s] || s);
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'kb-status-pending',
  queued: 'kb-status-queued',
  running: 'kb-status-running',
  paused: 'kb-status-paused',
  reviewing: 'kb-status-reviewing',
  verifying: 'kb-status-verifying',
  await_user: 'kb-status-await-user',
  completed: 'kb-status-completed',
  failed: 'kb-status-failed',
  rejected: 'kb-status-rejected',
  cancelled: 'kb-status-cancelled',
};

/* type 标签走 locale (computed 跟随语言切换); 未知 type 回落原始值 (模板 || t.type). */
const TYPE_LABELS = computed<Record<string, string>>(() => ({
  design: t('tasks.kanban.type.design'),
  dev: t('tasks.kanban.type.dev'),
  test: t('tasks.kanban.type.test'),
  deploy: t('tasks.kanban.type.deploy'),
}));

const TYPE_COLORS: Record<string, string> = {
  design: 'kb-type-design', dev: 'kb-type-dev',
  test: 'kb-type-test', deploy: 'kb-type-deploy',
};

/* cn → labelKey: 标签文案进 locale, color 样式类仍走静态表. */
const AWAITING_TYPE_META: Record<string, { color: string; labelKey: string }> = {
  review: { color: 'kb-marker-review', labelKey: 'tasks.kanban.marker.review' },
  choice: { color: 'kb-marker-choice', labelKey: 'tasks.kanban.marker.choice' },
  info: { color: 'kb-marker-info', labelKey: 'tasks.kanban.marker.info' },
  waiting_reply: { color: 'kb-marker-waiting', labelKey: 'tasks.kanban.marker.waitingReply' },
  suggestion: { color: 'kb-marker-suggestion', labelKey: 'tasks.kanban.marker.suggestion' },
  stuck: { color: 'kb-marker-stuck', labelKey: 'tasks.kanban.marker.stuck' },
};

/** 跨列拖拽 → action 名. 复刻 master constants.ts getStatusDragAction. null = 非法. */
const DRAG_ACTION: Record<TaskStatus, Partial<Record<TaskStatus, string>>> = {
  pending:   { running: 'start', queued: 'start', cancelled: 'cancel' },
  queued:    { running: 'start', cancelled: 'cancel', pending: 'dequeue' },
  running:   { paused: 'pause', await_user: 'await', cancelled: 'cancel' },
  paused:    { running: 'resume', completed: 'approve', cancelled: 'cancel' },
  reviewing: { completed: 'approve', running: 'refine' },
  verifying: {},
  await_user:{ running: 'unawait', completed: 'approve', cancelled: 'cancel' },
  completed: { running: 'start' },
  failed:    { running: 'start' },
  rejected:  { running: 'start', completed: 'approve' },
  cancelled: { running: 'start' },
};

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const toast = useToast();

const draggingId = ref<string | null>(null);
const dragOverCol = ref<TaskStatus | null>(null);
const inFlightAction = ref<string | null>(null);

/* R51 (B107) — 同列内拖拽手动排序 (v510 镜像). drop 时把目标列可见 task
   全部写连续 queued_order (10/20/30…), POST /api/tasks/queue-order.
   客户端乐观更新: splice 拖到 hoverIdx; 失败 revert.
   dragOverIdx: 用户把卡拖到哪两个卡之间. -1 = 列尾 (drop on column body 末尾).
   draggingFromIdx: 拖出前的源 index, 失败 revert 用. */
const dragOverIdx = ref<number>(-1);
const draggingFromIdx = ref<number>(-1);

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 按 status 分桶, 列顺序 = columnOrder (master columnOrder 1:1) 或回退
   DISPLAY_TASK_STATUSES (10 态 — 历史 rejected 已废弃, 读路径映射 cancelled,
   不再单列; damo 2026-11-01 反馈「等待中」幽灵列).
   selectedStatuses 传了 → 不在集合里的列不渲染 ("隐藏后面板也隐藏").
   不传 selectedStatuses → 全列保留 (global board 旧行为).
   v510 (bug 修复 2026-10-26): 每列走 sortTasksForKanban — 之前漏移植这步 →
   拖拽写库成功但 reload 后列序还是 API 的 updated_at DESC = 「拖了没变化」.
   master 对照 = kanban-view.tsx visibleColumns memo 内 sortTasksForKanban.
   2026-11-05 (damo): 列内排序改「默认时间倒序, 定制的除外」— sortTasksForKanban
   加 col 参数, queued_order 定制序只在 running/queued 生效; 其他列纯
   updated_at DESC (之前全列 queued_order 优先, 残留值把 completed 等列
   劫持成几周前的旧序, 实证 completed 顶部是 10-31 老任务). */
const columns = computed(() => {
  const order = props.columnOrder ?? DISPLAY_TASK_STATUSES;
  const sel = props.selectedStatuses;
  const bucket = new Map<TaskStatus, TaskTrimmed[]>();
  for (const s of order) bucket.set(s, []);
  // 兜底: 不在 columnOrder 里的 status 追加到末尾 (按首次出现序), 不静默丢任务.
  const extras: TaskStatus[] = [];
  for (const t of props.tasks) {
    let arr = bucket.get(t.status);
    if (!arr) {
      arr = [];
      bucket.set(t.status, arr);
      extras.push(t.status);
    }
    arr.push(t);
  }
  const fullOrder = [...order, ...extras.filter((s) => !order.includes(s))];
  return fullOrder
    .filter((s) => sel === undefined || sel.has(s))
    .map((s) => ({
      key: s,
      label: statusLabel(s),
      tasks: sortTasksForKanban<TaskTrimmed>(bucket.get(s) ?? [], s),
    }));
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseAwaitingMarkers(json: string | null, awaitingOwnerReview: number): AwaitingMarker[] {
  if (json) {
    try {
      const parsed = JSON.parse(json) as Array<{ type?: string; desc?: string | null }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m) => {
          // 局部变量名避开外层 i18n 的 t (同名会 shadow 掉翻译函数).
          const mtype = (m.type || 'review').toLowerCase();
          const meta = AWAITING_TYPE_META[mtype] || { color: 'kb-marker-default', labelKey: '' };
          const labelText = meta.labelKey ? t(meta.labelKey) : (mtype || t('tasks.kanban.marker.review'));
          const descSnippet = m.desc
            ? ` · ${m.desc.slice(0, 20)}${m.desc.length > 20 ? '…' : ''}`
            : '';
          return {
            label: `${labelText}${descSnippet}`,
            title: m.desc ? `${mtype}: ${m.desc}` : `awaiting marker (type=${mtype})`,
            color: meta.color,
          };
        });
      }
    } catch { /* fallthrough */ }
  }
  if (awaitingOwnerReview === 1) {
    return [{ label: t('tasks.kanban.marker.review'), title: 'awaiting owner review', color: 'kb-marker-review' }];
  }
  return [];
}

function formatTime(iso: string): string {
  // R211: updated_at 是 SQLite 裸 UTC 串 ("YYYY-MM-DD HH:MM:SS"), 旧 new Date(iso)
  // 按浏览器本地时区解析 → CST 偏早 8h. 统一走 lib/datetime 的 parseDbTime 口径
  // (跟卡片/列表/分组视图的 formatUpdatedAt 同源).
  return formatShortDateTime(iso);
}

/* ------------------------------------------------------------------ */
/*  Drag handlers (HTML5 native)                                       */
/* ------------------------------------------------------------------ */

function onDragStart(e: DragEvent, taskId: string, fromStatus: TaskStatus): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData('application/task', JSON.stringify({ taskId, fromStatus }));
  e.dataTransfer.effectAllowed = 'move';
  draggingId.value = taskId;
  // R51 (B107): 源 index 记录, 失败 revert 用.
  const colTasks = props.tasks.filter((t) => t.status === fromStatus);
  draggingFromIdx.value = colTasks.findIndex((t) => t.id === taskId);
}

function onDragEnd(): void {
  draggingId.value = null;
  dragOverCol.value = null;
  dragOverIdx.value = -1;
  draggingFromIdx.value = -1;
}

/** R51 (B107): 单卡 dragover, 用 clientY 与卡片中线比决定 insert 位置
   (idx 或 idx+1). stopPropagation 防止冒泡到 column 的 dragover. */
function onCardDragOver(e: DragEvent, idx: number): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (!draggingId.value) return;
  const card = e.currentTarget as HTMLElement | null;
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  dragOverIdx.value = e.clientY < mid ? idx : idx + 1;
}

function onColDragOver(e: DragEvent, colKey: TaskStatus): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dragOverCol.value = colKey;
  // 列 body dragover 不带具体 idx. 仅外部拖入时设 -1 (列尾); 同列内 drag
  // 已在 onCardDragOver 设过 idx, 不要覆盖.
  if (draggingId.value === null) dragOverIdx.value = -1;
}

function onColDragLeave(e: DragEvent, colKey: TaskStatus): void {
  if (dragOverCol.value === colKey) dragOverCol.value = null;
  dragOverIdx.value = -1;
  e.stopPropagation();
}

async function onColDrop(e: DragEvent, targetCol: TaskStatus): Promise<void> {
  e.preventDefault();
  const draggedId = draggingId.value;
  draggingId.value = null;
  dragOverCol.value = null;
  const insertAt = dragOverIdx.value;
  dragOverIdx.value = -1;
  draggingFromIdx.value = -1;
  if (!draggedId || inFlightAction.value) return;

  // 从 dataTransfer 读 source status, 失败回落到 props.tasks 反查.
  let fromStatus: TaskStatus | null = null;
  try {
    const raw = e.dataTransfer?.getData('application/task');
    if (raw) fromStatus = (JSON.parse(raw) as { fromStatus: TaskStatus }).fromStatus;
  } catch { /* fallthrough */ }
  if (!fromStatus) {
    const task = props.tasks.find((x) => x.id === draggedId);
    if (task) fromStatus = task.status;
  }
  if (!fromStatus) return;

  // R51 (B107) — 同列内拖拽走 handleSameColReorder.
  if (fromStatus === targetCol) {
    void handleSameColReorder(draggedId, targetCol, insertAt);
    return;
  }

  const action = DRAG_ACTION[fromStatus]?.[targetCol] ?? null;
  if (!action) {
    toast.error(t('tasks.kanban.errIllegalTransition', {
      from: statusLabel(fromStatus),
      to: statusLabel(targetCol),
    }));
    return;
  }

  inFlightAction.value = `${draggedId}:${action}`;
  try {
    let body: Record<string, unknown> | undefined;
    if (action === 'await') body = { reason: 'decision_pending' };
    else if (action === 'unawait') body = { reason: 'agent_self_resolved' };
    const res = await post<{ status?: TaskStatus }>(
      `/api/tasks/${draggedId}/${action}`,
      body,
    );
    const newStatus = res?.status ?? targetCol;
    toast.success(t('tasks.kanban.movedTo', { status: statusLabel(newStatus) }));
    emit('updated', draggedId, newStatus);
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      toast.error(t('tasks.kanban.errChangeStatus', { msg: err.message || `HTTP ${err.status}` }));
    } else if (err instanceof Error) {
      toast.error(t('tasks.kanban.errNetwork', { msg: err.message }));
    } else {
      toast.error(t('tasks.kanban.errChangeStatusFallback'));
    }
  } finally {
    inFlightAction.value = null;
  }
}

/* R51 (B107) — 同列内拖拽手动排序 (v510 镜像). drop 时把目标列可见 task 全部
   写连续 queued_order (10/20/30…) → POST /api/tasks/queue-order. 父组件
   emit updated 让父 reload 拿服务端真值. 不本地乐观 (props 不允许改父).

   拍板 (damo 2026-09-27): 只允许 running + queued 同列排序. 其他列
   (pending / paused / reviewing / verifying / await_user / completed /
   failed / rejected / cancelled) 同列 drop → toast 提示「不参与排序」
   直接 return. 原因: queued_order 字段在 master 端只对 queued 列真正
   影响调度顺序, running 是抢占式不排队但允许手动干预 (双击调度优先
   级), 其他列是单卡状态或终态无队列语义 — 前端允许拖 ≠ 后端生效,
   会出现「拖了但下次刷新顺序还是老」的错觉. */
const REORDERABLE_STATUSES = new Set<TaskStatus>(['running', 'queued']);

async function handleSameColReorder(
  draggedId: string,
  colKey: TaskStatus,
  insertAt: number,
): Promise<void> {
  if (!REORDERABLE_STATUSES.has(colKey)) {
    toast.error(t('tasks.kanban.errNotReorderable', { col: statusLabel(colKey) }));
    return;
  }
  const beforeOrder = props.tasks.filter((t) => t.status === colKey);
  if (beforeOrder.length < 2) return; // 单元素 reorder 无意义
  const fromIdx = beforeOrder.findIndex((t) => t.id === draggedId);
  if (fromIdx < 0) return;

  const reordered = [...beforeOrder];
  reordered.splice(fromIdx, 1);
  let toIdx = insertAt;
  if (toIdx > fromIdx) toIdx -= 1;
  if (toIdx < 0) toIdx = reordered.length;
  if (toIdx > reordered.length) toIdx = reordered.length;
  reordered.splice(toIdx, 0, beforeOrder[fromIdx]);

  // 顺序没变就不发请求.
  if (reordered.every((t, i) => t.id === beforeOrder[i].id)) return;

  const orderPayload = reordered.map((t, i) => ({ id: t.id, order: (i + 1) * 10 }));
  inFlightAction.value = `${draggedId}:reorder`;
  try {
    const res = await post<{ ok?: boolean }>('/api/tasks/queue-order', {
      orders: orderPayload,
    });
    if (!res || !res.ok) {
      toast.error(t('tasks.kanban.errReorderRejected'));
      return;
    }
    toast.success(t('tasks.kanban.reordered', { n: reordered.length }));
    emit('updated', draggedId, colKey);
  } catch (err: unknown) {
    const msg = err instanceof HttpError
      ? (err.message || `HTTP ${err.status}`)
      : err instanceof Error ? err.message : t('tasks.kanban.errUnknown');
    toast.error(t('tasks.kanban.errReorder', { msg }));
    emit('updated', draggedId, colKey);
  } finally {
    inFlightAction.value = null;
  }
}
</script>

<template>
  <div class="kb-root">
    <Empty
      v-if="columns.every((c) => c.tasks.length === 0)"
      :title="t('tasks.kanban.emptyTitle')"
      :description="t('tasks.kanban.emptyDesc')"
      illustration="inbox"
    />
    <div v-else class="kb-row">
      <section
        v-for="col in columns"
        :key="col.key"
        :class="['kb-col', { 'kb-col-dragover': dragOverCol === col.key }]"
        @dragover="(e: DragEvent) => onColDragOver(e, col.key)"
        @dragleave="(e: DragEvent) => onColDragLeave(e, col.key)"
        @drop="(e: DragEvent) => onColDrop(e, col.key)"
      >
        <header class="kb-col-head">
          <span :class="['kb-status-badge', STATUS_COLORS[col.key]]">{{ col.label }}</span>
          <span class="kb-col-count">{{ col.tasks.length }}</span>
        </header>

        <div class="kb-col-body">
          <article
            v-for="(task, idx) in col.tasks"
            :key="task.id"
            :class="[
              'kb-card',
              { 'kb-card-dragging': draggingId === task.id, 'kb-card-deleted': !!task.deleted_at },
              { 'kb-card-drop-before': dragOverCol === col.key && dragOverIdx === idx && draggingId !== null },
              { 'kb-card-drop-after': dragOverCol === col.key && dragOverIdx === idx + 1 && draggingId !== null && idx === col.tasks.length - 1 },
            ]"
            draggable="true"
            @dragstart="(e: DragEvent) => onDragStart(e, task.id, task.status)"
            @dragover="(e: DragEvent) => onCardDragOver(e, idx)"
            @dragend="onDragEnd"
          >
            <div class="kb-card-top">
              <span v-if="task.priority > 0" class="kb-priority" :title="t('tasks.kanban.priorityTitle', { n: task.priority })">
                P{{ task.priority }}
              </span>
              <span v-if="task.type" :class="['kb-type', TYPE_COLORS[task.type] || 'kb-type-default']">
                {{ TYPE_LABELS[task.type] || task.type }}
              </span>
              <span
                v-if="task.dispatched_by_task_id"
                class="kb-by-chip"
                :title="t('tasks.kanban.byTitle', { id: task.dispatched_by_task_id.slice(0, 8) })"
              >[by]{{ task.dispatched_by_task_id.slice(0, 8) }}</span>
              <template
                v-for="m in parseAwaitingMarkers(task.awaiting_markers, task.awaiting_owner_review)"
                :key="m.label"
              >
                <span :class="['kb-marker', m.color]" :title="m.title">{{ m.label }}</span>
              </template>
              <span v-if="task.deleted_at" class="kb-deleted-badge">{{ t('tasks.kanban.deleted') }}</span>
            </div>

            <div v-if="scopeLabels && task.project_id" class="kb-card-scope">
              <span>{{ scopeLabels.projectNames[task.project_id] || '?' }}</span>
              <template v-if="task.version_id">
                <span class="kb-scope-sep">›</span>
                <span>{{ scopeLabels.versionNames[task.version_id] || '?' }}</span>
              </template>
            </div>

            <router-link :to="`/tasks/${task.id}`" class="kb-card-title" :title="task.title" draggable="false">
              {{ task.title }}
            </router-link>

            <div class="kb-card-meta">
              <span class="kb-card-model" :title="task.resolved_model || task.model || '(default)'">
                {{ task.resolved_model || task.model || '(default)' }}
              </span>
              <span class="kb-card-time">{{ formatTime(task.updated_at) }}</span>
              <!-- R232: 运行中任务资源徽章 (父组件传 resources 才有数据) -->
              <TaskResourceBadge
                v-if="props.resources?.[task.id]"
                :sample="props.resources[task.id]"
                :warn="(props.resources[task.id]?.cpuPercent ?? 0) > 80 || (props.resources[task.id]?.memPercent ?? 0) > 50"
                class="kb-card-resource-badge"
              />
            </div>
          </article>

          <div v-if="col.tasks.length === 0" class="kb-col-empty-hint">{{ t('tasks.kanban.emptyCol') }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* R58.5: 布局改为 flex 自适应父容器剩余高度 — 之前 .kb-row 写死 min-height:320px
   (矮) + .kb-col 写死 max-height:calc(100vh - 220px) (硬编码 viewport 减法,
   不考虑实际父容器高度). 用户反馈: 看板下面还有大量空间没用, 分页没靠底.

   新布局:
   - .kb-root: flex column + flex:1 + min-height:0, 让父容器 (.gb-body) 的剩余
     高度全部给 KanbanBoard
   - .kb-row: flex:1 + min-height:0 (去掉 320px 硬编码), 让 .kb-col 撑大
   - .kb-col: flex:1 (去掉 280px width) + 去掉 max-height, 跟父 row 等高
     (280px 宽度之前是 fixed; 改用 width:280px 让 row 仍按列宽排)
   - .kb-col-body: flex:1 + overflow-y:auto, 单列内部滚动, 不会撑爆整行

   结果: 看板列高 = (gb-body - header - pagination 占位) 自动撑满,
   列内任务多了列内滚动, 看板整体跟分页条上下紧贴. */
.kb-root {
  /* R58.5+: padding-top 0 (BoardPage 链路) — board-body 自带 padding-top:16
     (跟 GlobalBoard .gb-body 同款), 这里不需要再给 16. kb-row 直接贴
     board-body content 顶 (= GlobalBoard 链路 gb-body content 顶位置,
     视觉等效). 之前 padding-top 16 是 board-body padding-top 0 时为了让
     kanban 列不贴物理顶; 现在 board-body 接管顶部呼吸, 这里归零. */
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  padding-top: 0;
}

.kb-row {
  /* R58.5: 去掉 padding — 让 kanban 列跟 cards/list/grouped 一样贴
     .gb-body padding (16/24/0) 走, 视觉对齐. 列内列间距 (16 上 / 24 横向)
     改由 .gb-body padding 提供. 列上下间距靠列本身 min-height + flex:1
     自适应, 不需要 kb-row 自己撑. */
  display: flex; gap: 12px;
  overflow-x: auto; flex: 1; min-height: 0;
}

.kb-col {
  flex: 0 0 280px;
  display: flex; flex-direction: column;
  background: var(--color-bg, #f9fafb);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-md, 6px);
  transition: box-shadow 0.15s, border-color 0.15s;
  /* 列高 = row 高 (row 现在 flex:1 撑满 .kb-root 剩余), 不再硬编码 100vh-220px */
  min-height: 0;
}

.kb-col-dragover {
  border-color: var(--color-primary, #2563eb);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.3);
}

.kb-col-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  background: var(--color-bg-elevated, #fff);
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius-md, 6px) var(--radius-md, 6px) 0 0;
  position: sticky; top: 0;
}

.kb-status-badge { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }

.kb-col-count {
  font-size: 11px; color: var(--color-text-muted, #6b7280);
  background: var(--color-bg, #f9fafb); padding: 1px 8px; border-radius: 999px;
}

.kb-col-body { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }

.kb-card {
  background: var(--color-bg-elevated, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: var(--radius, 4px);
  padding: 10px 12px;
  cursor: grab;
  display: flex; flex-direction: column; gap: 6px;
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s;
}

.kb-card:active { cursor: grabbing; }
.kb-card:hover { border-color: var(--color-primary, #2563eb); box-shadow: var(--shadow-sm); }
.kb-card-dragging { opacity: 0.4; }
.kb-card-deleted { opacity: 0.6; border-color: var(--tw-red-200); }

/* R51 (B107): 同列内拖拽 — 用 box-shadow top/bottom 显示插入位置 (蓝色 2px 高亮). */
.kb-card-drop-before {
  box-shadow: 0 -2px 0 0 var(--color-primary, #2563eb);
}
.kb-card-drop-after {
  box-shadow: 0 2px 0 0 var(--color-primary, #2563eb);
}

.kb-card-top { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; }

.kb-card-scope {
  font-size: 11px; color: var(--color-text-muted, #6b7280);
  display: flex; gap: 4px; min-width: 0;
}
.kb-scope-sep { opacity: 0.6; }

.kb-card-title {
  font-size: 13px; font-weight: 500; color: var(--color-text, #111827);
  line-height: 1.4; text-decoration: none;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; word-break: break-word;
}
.kb-card-title:hover { color: var(--color-primary, #2563eb); }

.kb-card-meta {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--color-text-muted, #6b7280); margin-top: 2px;
}

.kb-card-model {
  flex: 1; min-width: 0; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.kb-card-time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
/* R232: 资源徽章挤占 meta 行空间时收窄 model, 徽章本体不缩.
   R243: kanban 列宽固定 280px, 徽章呼吸不影响整板宽度 — 豁免组件的
   min-width:185px 钉宽 (保 model 名空间), 接受卡内 meta 微移. */
.kb-card-resource-badge { margin-left: 6px; flex-shrink: 0; }
.kb-card-resource-badge.trb-root { min-width: 0; justify-content: flex-start; }

.kb-priority { color: var(--tw-orange-600); font-weight: 500; }
.kb-deleted-badge {
  padding: 1px 6px; border-radius: var(--radius, 4px);
  background: var(--tw-red-100); color: var(--tw-red-700); font-size: 10px; font-weight: 500;
}

.kb-col-empty-hint {
  text-align: center; padding: 16px 8px;
  color: var(--color-text-muted, #9ca3af); font-size: 12px;
}

/* Status / type / marker 色板 — 与 GlobalBoard 同源 */
.kb-status-pending    { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.kb-status-queued     { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.kb-status-running    { background: var(--tw-sky-100); color: var(--tw-sky-700); }
.kb-status-paused     { background: var(--tw-yellow-100); color: var(--tw-yellow-800); }
.kb-status-reviewing  { background: var(--tw-purple-100); color: var(--tw-purple-800); }
.kb-status-verifying  { background: var(--tw-violet-100); color: var(--tw-violet-800); }
.kb-status-await-user { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.kb-status-completed  { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.kb-status-failed     { background: var(--tw-red-100); color: var(--tw-red-800); }
.kb-status-rejected   { background: var(--tw-orange-50); color: var(--tw-orange-700); }
.kb-status-cancelled  { background: var(--tw-gray-100); color: var(--tw-gray-500); }

.kb-type {
  padding: 1px 6px; border: 1px solid currentColor;
  border-radius: var(--radius, 4px); font-size: 10px; font-weight: 500;
}
.kb-type-design  { color: var(--tw-pink-700); background: var(--tw-pink-100); }
.kb-type-dev     { color: var(--tw-blue-700); background: var(--tw-blue-100); }
.kb-type-test    { color: var(--tw-violet-700); background: var(--tw-violet-100); }
.kb-type-deploy  { color: var(--tw-emerald-700); background: var(--tw-emerald-100); }
.kb-type-default { color: var(--color-text-muted, #6b7280); background: var(--color-bg, #f9fafb); }

.kb-marker {
  padding: 1px 6px; border: 1px solid;
  border-radius: 999px; font-size: 10px; font-weight: 500;
}
.kb-marker-review     { background: var(--tw-amber-100); color: var(--tw-amber-800); border-color: var(--tw-amber-200); }
.kb-marker-choice     { background: var(--tw-blue-100); color: var(--tw-blue-800); border-color: var(--tw-blue-200); }
.kb-marker-info       { background: var(--tw-gray-100); color: var(--tw-gray-700); border-color: var(--tw-gray-200); }
.kb-marker-waiting    { background: var(--tw-cyan-100); color: var(--tw-cyan-800); border-color: var(--tw-cyan-200); }
.kb-marker-suggestion { background: var(--tw-emerald-100); color: var(--tw-emerald-800); border-color: var(--tw-emerald-200); }
.kb-marker-stuck      { background: var(--tw-red-100); color: var(--tw-red-800); border-color: var(--tw-red-200); }
.kb-marker-default    { background: var(--tw-purple-100); color: var(--tw-purple-800); border-color: var(--tw-purple-200); }

.kb-by-chip {
  padding: 1px 6px; border-radius: var(--radius, 4px);
  background: var(--tw-gray-100); color: var(--color-text-muted, #6b7280);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px;
}
</style>