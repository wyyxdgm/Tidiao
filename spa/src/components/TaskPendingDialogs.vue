<script setup lang="ts">
/* 功能: 渲染 Agent 提问列表 (AskUserQuestion) + 单/多选 + 提交/取消. 镜像
   master tdc.tsx §Pending user dialogs.
   关注点:
   - 每个 dialog 可含多个 question; 每 question 含 header chip + multi/single options.
   - POST /api/tasks/[id]/user-dialog body {request_id, answers|cancelled}.
   - 多选用 Set 维护, 提交时 ", " 拼接.
   - 提交后乐观移除 (SSE 通常在 5s 内送达 user_dialog_response). */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { post, HttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';

const toast = useToast();
const { t } = useI18n();

interface UserDialogOption {
  label: string;
  description?: string;
  preview?: string;
}

interface UserDialogQuestion {
  question: string;
  header: string;
  options: UserDialogOption[];
  multi_select: boolean;
}

interface PendingDialog {
  requestId: string;
  dialogKind: string;
  toolUseId?: string;
  questions: UserDialogQuestion[];
  stale?: boolean;
}

interface Props {
  taskId: string;
  dialogs: PendingDialog[];
  /** B262: input form 像素高度, 用于 cap 弹窗高度避免遮挡消息输入栏. */
  inputFormHeight?: number;
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'resolved', requestId: string): void;
}>();

/* 内部 selection 状态 — key = `${requestId}::${question}`, value = Set<label>. */
const selections = ref<Record<string, Set<string>>>({});
const busyIds = ref<Set<string>>(new Set());

const hasDialogs = computed<boolean>(() => props.dialogs.length > 0);

/** B262: dialog 容器 max-height. 取 viewport 减去 input form 高度
    (留 12px buffer), 防止弹窗超出 input form 顶部遮挡. inputFormHeight
    未传 / 为 0 时退回到 60vh (与 master R56 cap 同档). */
const dialogMaxHeight = computed<string>(() => {
  const h = props.inputFormHeight ?? 0;
  if (h <= 0) return '60vh';
  return `calc(100vh - ${h + 12}px)`;
});

function selectionKey(requestId: string, question: string): string {
  return `${requestId}::${question}`;
}

function getSelection(requestId: string, question: string): Set<string> {
  const key = selectionKey(requestId, question);
  if (!selections.value[key]) selections.value[key] = new Set();
  return selections.value[key]!;
}

function isChecked(requestId: string, question: string, label: string): boolean {
  return getSelection(requestId, question).has(label);
}

function toggleOption(requestId: string, question: UserDialogQuestion, label: string): void {
  const set = getSelection(requestId, question.question);
  if (question.multi_select) {
    if (set.has(label)) set.delete(label);
    else set.add(label);
  } else {
    set.clear();
    set.add(label);
  }
}

function isAllAnswered(d: PendingDialog): boolean {
  return d.questions.every((q) => getSelection(d.requestId, q.question).size > 0);
}

async function submit(d: PendingDialog): Promise<void> {
  if (busyIds.value.has(d.requestId)) return;
  if (!isAllAnswered(d)) {
    toast.warn(t('tasks.dialogs.answerAllFirst'));
    return;
  }
  const answers: Record<string, string> = {};
  for (const q of d.questions) {
    answers[q.question] = Array.from(getSelection(d.requestId, q.question)).join(', ');
  }
  busyIds.value.add(d.requestId);
  try {
    await post(`/api/tasks/${props.taskId}/user-dialog`, {
      request_id: d.requestId,
      answers,
    });
    setTimeout(() => emit('resolved', d.requestId), 5000);
  } catch (e) {
    if (e instanceof HttpError) toast.error(t('tasks.dialogs.submitFailedMsg', { msg: e.message }));
    else toast.error(t('tasks.dialogs.submitFailed'));
  } finally {
    busyIds.value.delete(d.requestId);
  }
}

async function cancel(d: PendingDialog): Promise<void> {
  if (busyIds.value.has(d.requestId)) return;
  busyIds.value.add(d.requestId);
  try {
    await post(`/api/tasks/${props.taskId}/user-dialog`, {
      request_id: d.requestId,
      cancelled: true,
    });
    setTimeout(() => emit('resolved', d.requestId), 5000);
  } catch (e) {
    if (e instanceof HttpError) toast.error(t('tasks.dialogs.cancelFailedMsg', { msg: e.message }));
    else toast.error(t('tasks.dialogs.cancelFailed'));
  } finally {
    busyIds.value.delete(d.requestId);
  }
}
</script>

<template>
  <div v-if="hasDialogs" class="pending-dialogs" :style="{ maxHeight: dialogMaxHeight }">
    <div class="dialogs-header">
      <div class="header-left">❓ {{ t('tasks.dialogs.header', { n: dialogs.length }) }}</div>
      <div class="header-hint">{{ t('tasks.dialogs.headerHint') }}</div>
    </div>
    <div v-for="d in dialogs" :key="d.requestId" class="dialog-card">
      <div v-if="d.stale" class="stale-warn">
        ⚠ {{ t('tasks.dialogs.staleWarn') }}
      </div>
      <div class="dialog-scroll">
        <div v-for="q in d.questions" :key="q.question" class="question">
          <div v-if="q.header" class="header-chip">{{ q.header }}</div>
          <div class="question-text">{{ q.question }}</div>
          <div class="options">
            <label
              v-for="opt in q.options"
              :key="opt.label"
              class="option"
              :class="{ checked: isChecked(d.requestId, q.question, opt.label) }"
            >
              <input
                :type="q.multi_select ? 'checkbox' : 'radio'"
                :name="`q-${d.requestId}-${q.question}`"
                :checked="isChecked(d.requestId, q.question, opt.label)"
                @change="toggleOption(d.requestId, q, opt.label)"
              />
              <div class="option-body">
                <div class="option-label">{{ opt.label }}</div>
                <div v-if="opt.description" class="option-desc">{{ opt.description }}</div>
              </div>
            </label>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <button
          type="button"
          class="btn-cancel"
          :disabled="busyIds.has(d.requestId)"
          @click="cancel(d)"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn-submit"
          :disabled="!isAllAnswered(d) || busyIds.has(d.requestId)"
          @click="submit(d)"
        >
          {{ t('tasks.dialogs.submit') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pending-dialogs {
  background: var(--tw-violet-50);
  border-bottom: 1px solid var(--tw-violet-200);
  padding: 10px 14px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}
.dialogs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header-left {
  font-size: 13px;
  font-weight: 600;
  color: var(--tw-violet-800);
}
.header-hint {
  font-size: 11.5px;
  color: var(--tw-violet-600);
}
.dialog-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-violet-200);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.stale-warn {
  font-size: 11.5px;
  color: var(--tw-amber-800);
  background: var(--tw-amber-100);
  border: 1px solid var(--tw-amber-200);
  border-radius: var(--radius);
  padding: 6px 10px;
  flex-shrink: 0;
}
.dialog-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.question {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.header-chip {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: var(--tw-violet-800);
  background: var(--tw-violet-100);
  border-radius: 4px;
  padding: 1px 6px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  align-self: flex-start;
}
.question-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--tw-gray-800);
  white-space: pre-wrap;
  word-break: break-word;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.option {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  cursor: pointer;
  font-size: 13px;
}
.option:hover {
  border-color: var(--tw-violet-300);
}
.option.checked {
  border-color: var(--tw-violet-600);
  background: var(--tw-violet-100);
  box-shadow: 0 0 0 1px var(--tw-violet-300) inset;
}
.option input {
  margin-top: 2px;
  flex-shrink: 0;
}
.option-body {
  flex: 1;
  min-width: 0;
}
.option-label {
  color: var(--tw-gray-800);
  word-break: break-word;
}
.option-desc {
  font-size: 11.5px;
  color: var(--tw-gray-500);
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}
.btn-cancel {
  padding: 4px 12px;
  font-size: 12.5px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  border-radius: var(--radius);
  cursor: pointer;
}
.btn-submit {
  padding: 4px 14px;
  font-size: 12.5px;
  background: var(--tw-violet-600-solid);
  color: white;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
}
.btn-submit:hover {
  background: var(--tw-violet-700-solid);
}
.btn-submit:disabled,
.btn-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>