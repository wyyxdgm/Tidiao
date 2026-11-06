<script setup lang="ts">
/* 功能: 恢复执行弹窗 — 提交前可调整 auto_approve + max_turns.
   镜像 master tdc.tsx:3682-3812 ResumeModal:
   - Select (auto_approve: 'off' / 'on')
   - input number (maxTurns, 留空 = 保持当前)
   - 提交 = PATCH /api/tasks/[id] { auto_approve, max_turns } +
     POST /api/tasks/[id]/resume
   - 成功 → emit('resumed', newStatus)

   关注点:
   - PATCH 先于 resume: 后端 resume 路由会立刻 re-read task 行拿
     auto_approve/max_turns, PATCH 必须先落库, 否则 resume 拿不到新值.
     这是 master 3696-3718 明确写的注释 ("PATCH first so the new
     auto_approve / max_turns are in DB before the scheduler re-reads").
   - auto_approve 初始 = task.auto_approve ? 'on' : 'off' (master 同款).
   - maxTurns 初始 = 空字符串 (master 同款, placeholder 显示当前值). */
import { computed, ref } from 'vue';
import Modal from '@/components/Modal.vue';
import Button from '@/components/Button.vue';
import Select from '@/components/Select.vue';
import Input from '@/components/Input.vue';
import { useToast } from '@/composables/useToast';
import { patch, isHttpError } from '@/api/http';
import { resumeTask } from '@/api/tasks';

interface Props {
  taskId: string;
  /** 当前 task.auto_approve (1/0). 用于初始化 autoApprove state. */
  currentAutoApprove: number | null;
  /** 当前 task.max_turns. placeholder 显示. */
  currentMaxTurns: number | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'resumed', newStatus: string): void;
}>();

const toast = useToast();

const AUTO_APPROVE_OPTIONS = [
  { value: 'off', label: '需要逐个审核' },
  { value: 'on', label: '自动通过（不审核）' },
];

const autoApprove = ref<'on' | 'off'>(
  props.currentAutoApprove === 1 ? 'on' : 'off',
);
const maxTurns = ref<string>('');
const submitting = ref<boolean>(false);
const submitError = ref<string | null>(null);

const maxTurnsPlaceholder = computed<string>(() => {
  return props.currentMaxTurns
    ? `留空保持当前设置（${props.currentMaxTurns}）`
    : '留空保持当前设置';
});

async function submit(): Promise<void> {
  submitting.value = true;
  submitError.value = null;
  try {
    // 1. PATCH auto_approve + max_turns (master 3697-3712).
    const patchBody: Record<string, unknown> = {
      auto_approve: autoApprove.value === 'on' ? 1 : 0,
    };
    if (maxTurns.value) {
      const n = parseInt(maxTurns.value, 10);
      if (!Number.isNaN(n)) patchBody.max_turns = n;
    }
    const patchRes = await patch(`/api/tasks/${props.taskId}`, patchBody);
    if (patchRes === undefined) {
      // 204 no content 路径 — 也算成功.
    }

    // 2. POST resume.
    const res = await resumeTask(props.taskId);
    toast.success(`已恢复执行 (${res.status})`);
    emit('resumed', res.status);
  } catch (e) {
    submitError.value = isHttpError(e)
      ? e.message
      : e instanceof Error
        ? e.message
        : '恢复失败';
  } finally {
    submitting.value = false;
  }
}

function onClose(): void {
  if (submitting.value) return;
  emit('close');
}
</script>

<template>
  <Modal :model-value="true" title="▶ 恢复执行" size="md" @close="onClose">
    <div class="resume-form">
      <p class="hint">
        恢复前可调整工具审核策略与最大轮次，恢复后对新 session 生效。
      </p>

      <label class="field">
        <span class="lbl">工具审核</span>
        <Select v-model="autoApprove" :options="AUTO_APPROVE_OPTIONS" />
      </label>

      <label class="field">
        <span class="lbl">最大轮次（可选）</span>
        <Input
          v-model="maxTurns"
          type="number"
          :min="1"
          :placeholder="maxTurnsPlaceholder"
        />
      </label>

      <div v-if="submitError" class="error-text">⚠ {{ submitError }}</div>
    </div>

    <template #footer>
      <Button variant="ghost" :disabled="submitting" @click="onClose">取消</Button>
      <Button variant="primary" :loading="submitting" @click="submit">
        {{ submitting ? '恢复中…' : '确认恢复' }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.resume-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lbl {
  font-size: 12px;
  color: var(--color-text-muted);
}
.error-text {
  font-size: 12px;
  color: var(--tw-red-800);
  padding: 6px 10px;
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  border-radius: var(--radius);
}
</style>