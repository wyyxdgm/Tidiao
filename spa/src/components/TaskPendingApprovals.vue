<script setup lang="ts">
/* 功能: 渲染待审批工具调用列表 + 允许/拒绝按钮. 镜像 master tdc.tsx §Pending
   tool approvals.
   关注点:
   - POST /api/tasks/[id]/tool-approval body {request_id, approved, feedback?}.
   - 拒绝时支持 feedback (可选), 输入框与按钮同行.
   - 列表为空时不渲染容器 (避免空块占空间). */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { post, HttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';

const toast = useToast();
const { t } = useI18n();

interface PendingApproval {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface Props {
  taskId: string;
  approvals: PendingApproval[];
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'resolved', requestId: string): void;
}>();

const feedbackMap = ref<Record<string, string>>({});
const busyIds = ref<Set<string>>(new Set());

const hasApprovals = computed<boolean>(() => props.approvals.length > 0);

function setFeedback(requestId: string, value: string): void {
  feedbackMap.value = { ...feedbackMap.value, [requestId]: value };
}

function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

async function approve(requestId: string): Promise<void> {
  if (busyIds.value.has(requestId)) return;
  busyIds.value.add(requestId);
  try {
    await post(`/api/tasks/${props.taskId}/tool-approval`, {
      request_id: requestId,
      approved: true,
    });
    emit('resolved', requestId);
  } catch (e) {
    if (e instanceof HttpError) toast.error(t('tasks.approvals.allowFailedMsg', { msg: e.message }));
    else toast.error(t('tasks.approvals.allowFailed'));
  } finally {
    busyIds.value.delete(requestId);
  }
}

async function reject(requestId: string): Promise<void> {
  if (busyIds.value.has(requestId)) return;
  const feedback = feedbackMap.value[requestId]?.trim() || undefined;
  busyIds.value.add(requestId);
  try {
    await post(`/api/tasks/${props.taskId}/tool-approval`, {
      request_id: requestId,
      approved: false,
      feedback,
    });
    emit('resolved', requestId);
  } catch (e) {
    if (e instanceof HttpError) toast.error(t('tasks.approvals.rejectFailedMsg', { msg: e.message }));
    else toast.error(t('tasks.approvals.rejectFailed'));
  } finally {
    busyIds.value.delete(requestId);
  }
}
</script>

<template>
  <div v-if="hasApprovals" class="pending-approvals">
    <div class="approvals-header">⚠️ {{ t('tasks.approvals.header', { n: approvals.length }) }}</div>
    <div v-for="a in approvals" :key="a.requestId" class="approval-card">
      <div class="approval-body">
        <div class="approval-left">
          <div class="tool-name">🔧 {{ a.toolName }}</div>
          <pre class="tool-input">{{ formatInput(a.toolInput) }}</pre>
        </div>
        <div class="approval-actions">
          <button
            type="button"
            class="btn-allow"
            :disabled="busyIds.has(a.requestId)"
            @click="approve(a.requestId)"
          >
            ✅ {{ t('tasks.approvals.allow') }}
          </button>
          <div class="reject-row">
            <input
              :value="feedbackMap[a.requestId] ?? ''"
              type="text"
              :placeholder="t('tasks.approvals.rejectPlaceholder')"
              class="reject-input"
              @input="(e) => setFeedback(a.requestId, (e.target as HTMLInputElement).value)"
            />
            <button
              type="button"
              class="btn-reject"
              :disabled="busyIds.has(a.requestId)"
              @click="reject(a.requestId)"
            >
              ❌ {{ t('tasks.approvals.reject') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pending-approvals {
  background: var(--tw-orange-50);
  border-bottom: 1px solid var(--tw-orange-200);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.approvals-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--tw-orange-800);
}
.approval-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-orange-200);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.approval-body {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.approval-left {
  flex: 1;
  min-width: 0;
}
.tool-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--tw-orange-700);
}
.tool-input {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--tw-gray-600);
  background: var(--color-bg);
  padding: 6px 8px;
  border-radius: var(--radius);
  overflow-x: auto;
  max-height: 140px;
  white-space: pre-wrap;
  word-break: break-word;
}
.approval-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.btn-allow {
  background: var(--tw-emerald-600-solid);
  color: white;
  padding: 5px 12px;
  font-size: 12px;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
}
.btn-allow:hover {
  background: var(--tw-emerald-700-solid);
}
.btn-allow:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.reject-row {
  display: flex;
  gap: 4px;
}
.reject-input {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 3px 6px;
  font-size: 11px;
  width: 100px;
  outline: none;
}
.btn-reject {
  background: var(--tw-red-500-solid);
  color: white;
  padding: 4px 8px;
  font-size: 11px;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
}
.btn-reject:hover {
  background: var(--tw-red-600-solid);
}
.btn-reject:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>