<script setup lang="ts">
/* 功能: 详情页头部状态 badge 改为可点击下拉, 切换 6 态. 完整镜像 master
   src/app/requirements/[id]/status-flow.tsx.
   关注点:
   - 当前 STATUS_LABEL + STATUS_COLOR badge → dropdown trigger; 点开后列 6 态,
     选中即 PATCH /api/requirements/[id] body {status}.
   - 切 closed 走 ConfirmDialog (danger variant) 二次确认 (软删语义).
   - PATCH 成功后 emit('changed', newStatus) 让父级决定是否 refresh 数据;
     SPA 不像 master 调 router.refresh(), 因为这是组件不是 page-level 容器.
   - 失败用 Toast; 不关 dropdown (保留当前选择 + 让用户重试或取消).
   - 点击外部 / Esc 关 dropdown (与 master 同款).
   - eligibleForDone=false 时, 「已完成」项 disabled + tooltip 解释. */

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { updateRequirement, type RequirementStatus } from '@/api/requirements';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { useToast } from '@/composables/useToast';

/* ------------------------------------------------------------------ */
/*  枚举 (与 master status-flow.tsx 同源, 客户端重复是因为 lib/db/requirements.ts
    引 better-sqlite3, 不能进 SPA bundle)                                       */
/* ------------------------------------------------------------------ */

const REQUIREMENT_STATUSES: RequirementStatus[] = [
  'pending',
  'done',
  'awaiting_reply',
  'has_suggestion',
  'blocked',
  'closed',
];

/** 状态 locale key — 复用 requirements.status.* 六键. */
const STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: 'requirements.status.pending',
  done: 'requirements.status.done',
  awaiting_reply: 'requirements.status.awaiting_reply',
  has_suggestion: 'requirements.status.has_suggestion',
  blocked: 'requirements.status.blocked',
  closed: 'requirements.status.closed',
};

const STATUS_COLOR: Record<RequirementStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
  done: 'bg-green-100 text-green-700 hover:bg-green-200',
  awaiting_reply: 'bg-blue-100 text-blue-700 hover:bg-blue-200',
  has_suggestion: 'bg-purple-100 text-purple-700 hover:bg-purple-200',
  blocked: 'bg-orange-100 text-orange-700 hover:bg-orange-200',
  closed: 'bg-gray-200 text-gray-500 hover:bg-gray-300',
};

/* ------------------------------------------------------------------ */
/*  Props / Emits                                                      */
/* ------------------------------------------------------------------ */

interface Props {
  requirementId: string;
  initialStatus: RequirementStatus;
  /** R78 W1 §4.3 (c): 「已完成」项 disabled 判据 — 至少一个 dev/test/deploy
      task 已 completed 才能选. 由父级传 (master server 算好, SPA 走详情接口
      的 eligible_for_done 字段). */
  eligibleForDone: boolean;
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'changed', newStatus: RequirementStatus): void;
}>();

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();
const { t } = useI18n();

/** status → 显示标签 (t(STATUS_LABEL[status])). */
function statusLabel(s: RequirementStatus): string {
  return t(STATUS_LABEL[s]);
}
const status = ref<RequirementStatus>(props.initialStatus);
const open = ref<boolean>(false);
const pending = ref<boolean>(false);
const confirmClosed = ref<boolean>(false);
const rootEl = ref<HTMLElement | null>(null);

/* ------------------------------------------------------------------ */
/*  点击外部 / Esc 关 dropdown                                          */
/* ------------------------------------------------------------------ */

function onDocMouseDown(e: MouseEvent): void {
  if (!rootEl.value) return;
  if (!rootEl.value.contains(e.target as Node)) {
    open.value = false;
  }
}
function onDocKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false;
}
onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown);
  window.addEventListener('keydown', onDocKeyDown);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown);
  window.removeEventListener('keydown', onDocKeyDown);
});

/* ------------------------------------------------------------------ */
/*  PATCH                                                               */
/* ------------------------------------------------------------------ */

async function patchStatus(next: RequirementStatus): Promise<void> {
  pending.value = true;
  try {
    await updateRequirement(props.requirementId, { status: next });
    status.value = next;
    toast.success(t('requirements.flow.changedToast', { status: statusLabel(next) }));
    open.value = false;
    emit('changed', next);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : t('common.unknownError');
    toast.error(t('requirements.flow.changeFailed', { msg }));
  } finally {
    pending.value = false;
  }
}

function onPick(next: RequirementStatus): void {
  if (next === status.value) {
    open.value = false;
    return;
  }
  if (next === 'closed') {
    confirmClosed.value = true;
    return;
  }
  if (next === 'done' && !props.eligibleForDone) {
    toast.error(t('requirements.flow.doneBlocked'));
    return;
  }
  void patchStatus(next);
}
</script>

<template>
  <div class="relative" ref="rootEl">
    <button
      type="button"
      :disabled="pending"
      :title="t('requirements.flow.pickTitle')"
      :class="[
        'text-xs px-3 py-1 rounded-full whitespace-nowrap',
        STATUS_COLOR[status],
        pending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      ]"
      @click="() => !pending && (open = !open)"
    >
      {{ pending ? t('requirements.flow.updating') : statusLabel(status) }}
      <span class="ml-1 opacity-60">▾</span>
    </button>

    <ul
      v-if="open"
      class="absolute right-0 mt-1 z-50 w-44 max-h-60 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg"
    >
      <li v-for="s in REQUIREMENT_STATUSES" :key="s">
        <button
          type="button"
          :disabled="s === 'done' && !eligibleForDone"
          :title="
            s === 'done' && !eligibleForDone
              ? t('requirements.flow.doneBlockedTitle')
              : undefined
          "
          :class="[
            'w-full text-left px-3 py-2 text-sm flex items-center justify-between',
            s === status
              ? 'bg-blue-50 text-blue-700 font-medium'
              : s === 'done' && !eligibleForDone
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-gray-700 hover:bg-gray-50',
          ]"
          @click="() => onPick(s)"
        >
          <span>{{ statusLabel(s) }}</span>
          <span v-if="s === status" class="text-xs">✓</span>
        </button>
      </li>
      <li class="px-3 py-1.5 text-[10px] text-gray-400 border-t">
        {{ t('requirements.flow.closedHint') }}
      </li>
    </ul>

    <ConfirmDialog
      :open="confirmClosed"
      :title="t('requirements.flow.closeTitle')"
      :message="t('requirements.flow.closeMessage', { status: statusLabel('closed') })"
      :confirm-text="t('requirements.flow.closeConfirm')"
      :cancel-text="t('common.cancel')"
      type="danger"
      @confirm="
        () => {
          confirmClosed = false;
          void patchStatus('closed');
        }
      "
      @cancel="() => (confirmClosed = false)"
    />
  </div>
</template>
