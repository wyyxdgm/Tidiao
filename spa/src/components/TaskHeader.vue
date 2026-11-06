<script setup lang="ts">
/* 功能: 任务详情页头部 — breadcrumb + 标题 (点击编辑) + 状态/类型/优先级 +
   awaiting markers + 收藏 + TaskMetaRow + 超时编辑. 镜像 master task-header.tsx.
   关注点:
   - 标题点击进入编辑态, Enter 提交 / Esc 取消 / 失焦提交; PATCH /api/tasks/[id].
   - 收藏走 POST/DELETE /api/tasks/[id]/favorite, 乐观更新.
   - 状态/上下文/成本/超时剩余通过 SSE 流式刷新 (父组件传入).
   - awaiting_markers JSON 解析失败静默回退到 awaiting_owner_review (R61+R39). */
import { computed, onUnmounted, ref, watch } from 'vue';
import { patch, post, del, HttpError } from '@/api/http';
import { parseAwaitingMarkers } from '@/lib/awaiting-markers';
import QueuedReasonHint from './QueuedReasonHint.vue';
import TaskMetaRow from './TaskMetaRow.vue';
import Modal from './Modal.vue';
import Input from './Input.vue';
import Button from './Button.vue';
import { useToast } from '@/composables/useToast';

const toast = useToast();

interface Props {
  taskId: string;
  title: string;
  status: string;
  type?: string | null;
  priority?: number;
  isDeleted?: boolean;
  model?: string | null;
  resolvedModel?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  costUsd?: number | null;
  /** R239: 成本系数 (相对平台基准模型), 透传 TaskMetaRow 金额后缀 */
  costCoefficient?: number | null;
  contextTokens?: number | null;
  contextMax?: number | null;
  createdAt?: string | null;
  startedAt?: string | null;
  awaitingMarkers?: string | null;
  awaitingOwnerReview?: number;
  /** v531 续: 排队原因人话串 (调度器挡出队时写), queued 状态才渲染. */
  queuedReason?: string | null;
  favorite?: boolean;
  projectName?: string | null;
  versionName?: string | null;
  projectId?: string | null;
  versionId?: string | null;
  parentTitle?: string | null;
  /* 倒计时相关: start 是 started_at ms; total 是 task 总时长 ms; remaining 由父组件每帧推 */
  timeoutAnchor?: string | null;
  timeoutRemainingMs?: number | null;
  timeoutTotalMs?: number | null;
  timeoutOverrideMinutes?: number | null;
  defaultTimeoutMinutes?: number | null;
}
const props = withDefaults(defineProps<Props>(), {
  type: null,
  priority: 0,
  isDeleted: false,
  model: null,
  resolvedModel: null,
  effort: null,
  maxTurns: null,
  costUsd: null,
  costCoefficient: null,
  contextTokens: null,
  contextMax: null,
  createdAt: null,
  startedAt: null,
  awaitingMarkers: null,
  awaitingOwnerReview: 0,
  queuedReason: null,
  favorite: false,
  projectName: null,
  versionName: null,
  projectId: null,
  versionId: null,
  parentTitle: null,
  timeoutAnchor: null,
  timeoutRemainingMs: null,
  timeoutTotalMs: null,
  timeoutOverrideMinutes: null,
  defaultTimeoutMinutes: null,
});

const emit = defineEmits<{
  (e: 'title-updated', title: string): void;
  (e: 'favorite-changed', fav: boolean): void;
  (e: 'timeout-updated', minutes: number | null): void;
}>();

/* ------------------------------------------------------------------ */
/*  Display labels & colors                                            */
/* ------------------------------------------------------------------ */

const TYPE_LABELS: Record<string, string> = {
  design: '设计',
  dev: '开发',
  test: '测试',
  deploy: '部署',
};

const TYPE_COLORS: Record<string, string> = {
  design: 'type-design',
  dev: 'type-dev',
  test: 'type-test',
  deploy: 'type-deploy',
};

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

const typeText = computed<string | null>(() =>
  props.type ? TYPE_LABELS[props.type] || props.type : null,
);
const typeClass = computed<string | null>(() =>
  props.type ? TYPE_COLORS[props.type] || 'type-default' : null,
);
const priorityText = computed<string | null>(() =>
  props.priority > 0 ? `P${props.priority}` : null,
);

const markers = computed(() =>
  parseAwaitingMarkers(props.awaitingMarkers, props.awaitingOwnerReview ?? 0),
);

const resolvedModelLabel = computed<string>(
  () => props.resolvedModel || props.model || '默认',
);

/* ------------------------------------------------------------------ */
/*  Title edit                                                         */
/* ------------------------------------------------------------------ */

const isEditing = ref<boolean>(false);
const editingTitle = ref<string>('');
const titleSaving = ref<boolean>(false);

function startEdit(): void {
  if (props.isDeleted) return;
  editingTitle.value = props.title;
  isEditing.value = true;
}

async function commitTitle(): Promise<void> {
  const next = editingTitle.value.trim();
  if (!next || next === props.title) {
    isEditing.value = false;
    return;
  }
  titleSaving.value = true;
  try {
    await patch(`/api/tasks/${props.taskId}`, { title: next });
    emit('title-updated', next);
  } catch (e) {
    if (e instanceof HttpError) {
      toast.error(`保存失败: ${e.message}`);
    } else {
      toast.error('保存失败');
    }
  } finally {
    titleSaving.value = false;
    isEditing.value = false;
  }
}

function cancelEdit(): void {
  isEditing.value = false;
  editingTitle.value = props.title;
}

/* ------------------------------------------------------------------ */
/*  ID copy                                                            */
/* ------------------------------------------------------------------ */

const copied = ref<boolean>(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.taskId);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    toast.error('复制失败');
  }
}

onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer);
});

/* ------------------------------------------------------------------ */
/*  Favorite toggle                                                    */
/* ------------------------------------------------------------------ */

const favBusy = ref<boolean>(false);

async function toggleFavorite(): Promise<void> {
  if (favBusy.value) return;
  favBusy.value = true;
  const nextFav = !props.favorite;
  emit('favorite-changed', nextFav);
  try {
    if (nextFav) {
      await post(`/api/tasks/${props.taskId}/favorite`);
    } else {
      await del(`/api/tasks/${props.taskId}/favorite`);
    }
  } catch (e) {
    emit('favorite-changed', props.favorite);
    if (e instanceof HttpError) {
      toast.error(`收藏失败: ${e.message}`);
    } else {
      toast.error('收藏失败');
    }
  } finally {
    favBusy.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Timeout edit dialog                                                */
/* ------------------------------------------------------------------ */

const showTimeoutEdit = ref<boolean>(false);
const timeoutInput = ref<string>('');
const timeoutSaving = ref<boolean>(false);
const timeoutClear = ref<boolean>(false);

function openTimeoutEdit(): void {
  timeoutInput.value = props.timeoutOverrideMinutes != null
    ? String(props.timeoutOverrideMinutes)
    : props.defaultTimeoutMinutes != null
      ? String(props.defaultTimeoutMinutes)
      : '60';
  timeoutClear.value = props.timeoutOverrideMinutes == null;
  showTimeoutEdit.value = true;
}

async function saveTimeout(): Promise<void> {
  timeoutSaving.value = true;
  try {
    let nextMinutes: number | null;
    if (timeoutClear.value) {
      nextMinutes = null;
    } else {
      const n = Number(timeoutInput.value);
      if (!Number.isFinite(n) || n <= 0) {
        toast.warn('请输入正整数分钟');
        return;
      }
      nextMinutes = Math.floor(n);
    }
    await patch(`/api/tasks/${props.taskId}`, { timeout_minutes: nextMinutes });
    emit('timeout-updated', nextMinutes);
    showTimeoutEdit.value = false;
  } catch (e) {
    if (e instanceof HttpError) {
      toast.error(`保存失败: ${e.message}`);
    } else {
      toast.error('保存失败');
    }
  } finally {
    timeoutSaving.value = false;
  }
}

watch(
  () => props.title,
  (t) => {
    if (!isEditing.value) editingTitle.value = t;
  },
);
</script>

<template>
  <header class="task-header">
    <!-- Breadcrumb — R56-B9: 镜像 master task-header.tsx:303-319. 顶层
         不再写固定「项目」字眼 (R59 后续): 直接进入 project/version 链,
         任务没挂项目/版本时走「其他任务」兜底. 右侧拼 (projectId…/versionId…)
         短哈希 (前 8 位 + 省略号), 与 Next.js page.tsx 同款. -->
    <nav class="breadcrumb">
      <router-link
        v-if="projectId"
        :to="`/${projectId}`"
        class="breadcrumb-link"
      >{{ projectName || '其他任务' }}</router-link>
      <span v-if="versionId && versionName && versionName !== projectName" class="sep">›</span>
      <router-link
        v-if="versionId && versionName && versionName !== projectName"
        :to="`/projects/${projectId}/versions/${versionId}`"
        class="breadcrumb-link"
      >{{ versionName }}</router-link>
      <span v-if="!projectId" class="breadcrumb-current">其他任务</span>
      <span v-if="projectId" class="breadcrumb-hash">
        ({{ projectId.slice(0, 8) }}…<template v-if="versionId">/{{ versionId.slice(0, 8) }}…</template>)
      </span>
    </nav>

    <!-- Title row -->
    <div class="title-row">
      <div class="title-left">
        <h2 v-if="!isEditing" class="task-title" :class="{ deleted: isDeleted }" @click="startEdit">
          {{ title }}
          <span v-if="!isDeleted" class="edit-hint">点击编辑</span>
        </h2>
        <div v-else class="title-edit">
          <input
            v-model="editingTitle"
            class="title-input"
            :disabled="titleSaving"
            autofocus
            @keydown.enter.prevent="commitTitle"
            @keydown.esc.prevent="cancelEdit"
            @blur="commitTitle"
          />
          <span v-if="titleSaving" class="title-saving">保存中…</span>
        </div>

        <div class="meta-row">
          <span v-if="typeText" :class="['type-chip', typeClass]">{{ typeText }}</span>
          <span v-if="priorityText" class="priority-chip">{{ priorityText }}</span>
          <span v-if="isDeleted" class="deleted-badge">已删除</span>
          <!-- v531 续: 排队原因详情页同款显示 (列表/看板已有, 这里补齐详情页). -->
          <QueuedReasonHint :status="status" :reason="queuedReason" />
        </div>

        <div v-if="markers.length > 0" class="markers">
          <span
            v-for="(m, idx) in markers"
            :key="idx"
            :class="['marker', m.cssClass]"
            :title="m.title"
          >
            {{ m.icon }} {{ m.label }}
          </span>
        </div>
      </div>

      <div class="title-right">
        <button
          type="button"
          class="icon-btn fav-btn"
          :class="{ active: favorite }"
          :disabled="favBusy"
          :title="favorite ? '取消收藏' : '收藏任务'"
          @click="toggleFavorite"
        >
          {{ favorite ? '★' : '☆' }}
        </button>
        <button
          type="button"
          class="icon-btn"
          :class="{ active: copied }"
          :title="copied ? '已复制' : '复制 ID'"
          @click="copyId"
        >
          {{ copied ? '✓' : '⧉' }}
        </button>
      </div>
    </div>

    <!-- Meta row -->
    <div class="meta-row-flex">
      <TaskMetaRow
        :model="resolvedModelLabel"
        :effort="effort"
        :max-turns="maxTurns"
        :created-at="createdAt"
        :context-tokens="contextTokens"
        :context-max="contextMax"
        :cost="costUsd"
        :cost-coefficient="costCoefficient"
        :timeout-remaining-ms="timeoutRemainingMs"
        :timeout-total-ms="timeoutTotalMs"
      />

      <!-- R56-B9: 超时编辑按钮 — master task-header.tsx:425-435 同款 ✎ icon button
           (紧随 TaskMetaRow 后面), 替换旧版文字 "超时: 60m (默认)" 链接. 已删
           任务不显示. 与 ⭐ / ⧉ 视觉一致 (round icon button + 灰色 hover 蓝). -->
      <button
        v-if="!isDeleted"
        type="button"
        class="icon-btn"
        title="编辑单任务超时"
        aria-label="编辑超时"
        @click="openTimeoutEdit"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
          <path d="M2.695 14.763l-1.262 3.155a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.886L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
        </svg>
      </button>
    </div>

    <!-- 超时编辑弹窗 -->
    <Modal
      :model-value="showTimeoutEdit"
      title="编辑超时时长"
      size="sm"
      @update:model-value="(v: boolean) => (showTimeoutEdit = v)"
      @close="showTimeoutEdit = false"
    >
      <div class="timeout-form">
        <label class="checkbox-line">
          <input v-model="timeoutClear" type="checkbox" />
          <span>使用项目/全局默认值 (不覆盖)</span>
        </label>
        <div v-if="!timeoutClear" class="timeout-input-line">
          <span class="muted">分钟:</span>
          <!-- class-name="timeout-input-num" 给 Input 一个 max-width, 避免
               .input-wrap 默认 width: 100% 在 flex 父容器里把整行撑满,
               导致 "分钟:" 标签被挤到下一行垂直显示. -->
          <Input
            v-model="timeoutInput"
            type="number"
            :min="1"
            :max="1440"
            class-name="timeout-input-num"
          />
        </div>
        <p class="muted small">
          当前覆盖: {{ timeoutOverrideMinutes ?? '无' }}; 默认: {{ defaultTimeoutMinutes ?? 60 }} 分钟
        </p>
      </div>
      <template #footer>
        <Button variant="ghost" @click="showTimeoutEdit = false">取消</Button>
        <Button variant="primary" :loading="timeoutSaving" @click="saveTimeout">保存</Button>
      </template>
    </Modal>
  </header>
</template>

<style scoped>
.task-header {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 14px 18px;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
}

.breadcrumb {
  font-size: 12px;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.breadcrumb .sep {
  opacity: 0.6;
}
.breadcrumb-link {
  color: var(--color-text-muted);
  text-decoration: none;
}
.breadcrumb-link:hover {
  color: var(--color-primary, #2563eb);
  text-decoration: underline;
}
.breadcrumb-current {
  color: var(--color-text);
  font-weight: 500;
}
.breadcrumb-hash {
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.7;
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.title-left {
  flex: 1;
  min-width: 0;
}

.task-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  word-break: break-word;
  cursor: pointer;
}
.task-title.deleted {
  text-decoration: line-through;
  color: var(--color-text-muted);
  cursor: not-allowed;
}
.edit-hint {
  margin-left: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity 0.1s;
}
.task-title:hover .edit-hint {
  opacity: 1;
}

.title-edit {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-input {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  outline: none;
}
.title-input:focus {
  border-color: var(--color-primary, #3b82f6);
}
.title-saving {
  font-size: 12px;
  color: var(--color-text-muted);
}

.title-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.icon-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
}
.icon-btn.active {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
  border-color: var(--color-primary, #3b82f6);
}

/* R59: 收藏激活时 ★ 染色金黄 (#f59e0b amber-500) — 五角星通用视觉语义.
   用 .fav-btn 限定只染 favorite 按钮, 不影响隔壁 copy 按钮 (active 时仍灰).
   非激活 (☆) 维持 currentColor 灰色. */
.fav-btn.active {
  color: var(--tw-amber-500);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.markers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.marker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid;
}
.marker-review     { background: var(--tw-amber-100); color: var(--tw-amber-800); border-color: var(--tw-amber-200); }
.marker-choice     { background: var(--tw-blue-100); color: var(--tw-blue-800); border-color: var(--tw-blue-200); }
.marker-info       { background: var(--tw-gray-100); color: var(--tw-gray-700); border-color: var(--tw-gray-200); }
.marker-waiting    { background: var(--tw-cyan-100); color: var(--tw-cyan-800); border-color: var(--tw-cyan-200); }
.marker-suggestion { background: var(--tw-emerald-100); color: var(--tw-emerald-800); border-color: var(--tw-emerald-200); }
.marker-stuck      { background: var(--tw-red-100); color: var(--tw-red-800); border-color: var(--tw-red-200); }
.marker-default    { background: var(--tw-purple-100); color: var(--tw-purple-800); border-color: var(--tw-purple-200); }

/* R56-B9: TaskMetaRow + ✎ 按钮并排 flex 行 (master task-header.tsx:412 同款).
   旧版的 .timeout-edit 绝对定位 + .link-btn 文字按钮已废, template 里换成
   .meta-row-flex + .icon-btn (与 ⭐ / ⧉ 同款 svg round button). */
.meta-row-flex {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.timeout-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.checkbox-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.timeout-input-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 限制 Input 宽度, 防止 .input-wrap 默认 width:100% 在 flex 父容器里把
   "分钟:" 标签挤到下一行垂直显示. 给 .timeout-input-line 内 .input-wrap
   一个固定宽度即可让 label + input 横排. */
.timeout-input-num.input-wrap {
  width: auto;
  min-width: 96px;
  max-width: 160px;
}
.muted {
  color: var(--color-text-muted);
}
.small {
  font-size: 11.5px;
}

/* status/type chips */
.type-chip {
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 500;
}
.priority-chip {
  font-size: 11px;
  color: var(--tw-orange-600);
  font-weight: 500;
}
.deleted-badge {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--tw-red-100);
  color: var(--tw-red-700);
  font-size: 11px;
  font-weight: 500;
}
.type-design  { color: var(--tw-pink-700); background: var(--tw-pink-100); }
.type-dev     { color: var(--tw-blue-700); background: var(--tw-blue-100); }
.type-test    { color: var(--tw-violet-700); background: var(--tw-violet-100); }
.type-deploy  { color: var(--tw-emerald-700); background: var(--tw-emerald-100); }
.type-default { color: var(--color-text-muted); background: var(--color-bg); }
</style>