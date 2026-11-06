<script setup lang="ts">
/* 功能: 手动添加 checkpoint 表单 — RightDock Checkpoints 面板底部.
   折叠态 = 单个「+ 手动添加 checkpoint」按钮; 展开后 summary (textarea) +
   step (input, 可选) + 添加/取消按钮. 提交走 POST /api/tasks/[id]/checkpoints,
   body { summary?, step? }, step 留空时后端用 ms-timestamp 兜底 (R46 同款).
   成功后 onCreated() 通知父级刷新 checkpoints 列表 (调父级 checkpointRefresh++
   → watcher 重新 fetch).

   关注点:
   - SPA 走 useRoute + HttpError 而不是 master 的 toast; 失败时 inline 错误显示,
     用户可重试或取消.
   - sessionIdAvailable=false 时按钮 disabled (需要先启动任务生成 session_id). */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { post, HttpError } from '@/api/http';

interface Props {
  taskId: string;
  sessionIdAvailable: boolean;
  onCreated: () => void;
}
const props = defineProps<Props>();
const { t } = useI18n();

const open = ref<boolean>(false);
const summary = ref<string>('');
const stepInput = ref<string>('');
const submitting = ref<boolean>(false);
const error = ref<string | null>(null);

async function handleSubmit(e: Event): Promise<void> {
  e.preventDefault();
  submitting.value = true;
  error.value = null;
  try {
    const body: { summary?: string; step?: string } = {};
    const s = summary.value.trim();
    if (s) body.summary = s;
    const st = stepInput.value.trim();
    if (st) body.step = st;
    await post(`/api/tasks/${props.taskId}/checkpoints`, body);
    summary.value = '';
    stepInput.value = '';
    open.value = false;
    props.onCreated();
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : (err instanceof Error ? err.message : t('tasks.checkpoint.addFailed'));
  } finally {
    submitting.value = false;
  }
}

function cancel(): void {
  open.value = false;
  error.value = null;
}
</script>

<template>
  <button
    v-if="!open"
    type="button"
    class="add-cp-btn"
    :disabled="!sessionIdAvailable"
    :title="sessionIdAvailable ? t('tasks.checkpoint.addTitle') : t('tasks.checkpoint.needSessionTitle')"
    @click="open = true"
  >
    {{ t('tasks.checkpoint.addBtn') }}
  </button>
  <form v-else class="add-cp-form" @submit="handleSubmit">
    <textarea
      v-model="summary"
      class="add-cp-textarea"
      :placeholder="t('tasks.checkpoint.summaryPlaceholder')"
      rows="2"
    />
    <input
      v-model="stepInput"
      class="add-cp-input"
      :placeholder="t('tasks.checkpoint.stepPlaceholder')"
    />
    <div v-if="error" class="add-cp-error">⚠ {{ error }}</div>
    <div class="add-cp-actions">
      <button
        type="submit"
        class="add-cp-submit"
        :disabled="submitting"
      >{{ submitting ? t('tasks.checkpoint.adding') : t('tasks.checkpoint.add') }}</button>
      <button
        type="button"
        class="add-cp-cancel"
        @click="cancel"
      >{{ t('common.cancel') }}</button>
    </div>
  </form>
</template>

<style scoped>
/* R56-A4.2: 手动添加 checkpoint 表单 (master right-dock.tsx:1228 同款灰底卡片). */
.add-cp-btn {
  width: 100%;
  margin-top: 8px;
  font-size: 11.5px;
  padding: 5px 10px;
  border: 1px solid var(--tw-gray-300);
  color: var(--tw-gray-600);
  border-radius: 4px;
  background: var(--color-bg-elevated);
  cursor: pointer;
}
.add-cp-btn:hover:not(:disabled) {
  background: var(--tw-gray-50);
}
.add-cp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-cp-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 6px;
  background: var(--tw-gray-50);
}

.add-cp-textarea {
  width: 100%;
  font-size: 12.5px;
  padding: 6px 8px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 4px;
  resize: none;
  font-family: inherit;
  background: var(--color-bg-elevated);
  box-sizing: border-box;
}
.add-cp-textarea:focus,
.add-cp-input:focus {
  outline: none;
  border-color: var(--tw-blue-400);
  box-shadow: 0 0 0 1px var(--tw-blue-400);
}

.add-cp-input {
  width: 100%;
  font-size: 11.5px;
  padding: 4px 8px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg-elevated);
  box-sizing: border-box;
}

.add-cp-error {
  font-size: 11px;
  color: var(--tw-red-700);
  word-break: break-word;
}

.add-cp-actions {
  display: flex;
  gap: 6px;
}

.add-cp-submit {
  font-size: 11.5px;
  padding: 4px 10px;
  background: var(--tw-emerald-600-solid);
  color: #fff;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.add-cp-submit:hover:not(:disabled) {
  background: var(--tw-emerald-700-solid);
}
.add-cp-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-cp-cancel {
  font-size: 11.5px;
  padding: 4px 10px;
  border: 1px solid var(--tw-gray-300);
  color: var(--tw-gray-600);
  border-radius: 4px;
  background: var(--color-bg-elevated);
  cursor: pointer;
}
.add-cp-cancel:hover {
  background: var(--tw-gray-100);
}
</style>