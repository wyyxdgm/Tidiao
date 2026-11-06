<script setup lang="ts">
/* 功能: 详情页「关联任务」section 「+ 新建任务」按钮 + 弹窗表单. 完整镜像 master
   src/app/requirements/[id]/create-task-button.tsx.
   关注点:
   - 收 title (必填) / prompt (必填) / type (必选 workflow 阶段) / 立即启动 vs
     留待启动 (默认立即) / auto_approve / effort / max_turns / allowed_tools
     (multi-toggle). 提交 POST /api/tasks body 带 requirement_id + project_id
     (继承). 「立即启动」路径创建后立刻 POST /api/tasks/[id]/start 让 agent SDK
     立刻进入调度队列;「留待启动」只创建.
   - 不让用户在弹窗里选 project / version: 这俩从 requirement 继承 (用户在
     详情页弹窗 = 已确定 scope).
   - 弹窗自定义 modal (不用 ConfirmDialog): 表单字段多, ConfirmDialog 是简化版
     两按钮弹窗, 不适合. 用自己写的 backdrop + form 风格, 与 master 同款.
   - 失败用 Toast; 成功也用 Toast 提示; 弹窗内错误条用顶部红色 alert.
   - Esc 关弹窗 + backdrop click 关弹窗.
   - type 字段是 R78 W1 §4.3 invariant 前置: 弹窗必须让用户标 workflow 阶段,
     否则下游 invariant 检查无数据可用. */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { post } from '@/api/http';
import { HttpError } from '@/api/http';
import Button from '@/components/Button.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import { useToast } from '@/composables/useToast';
import {
  AVAILABLE_TOOLS,
  EFFORT_LEVELS,
  TASK_TYPE_OPTIONS,
  TOOL_PRESETS,
  type TaskType,
} from '@/lib/constants';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  requirementId: string;
  projectId: string;
  versionId: string | null;
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'created', taskId: string): void;
}>();

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();
const { t } = useI18n();
const open = ref<boolean>(false);
const submitting = ref<boolean>(false);
const formError = ref<string | null>(null);

const title = ref<string>('');
const prompt = ref<string>('');
const taskType = ref<TaskType>('dev');
const autoStart = ref<boolean>(true);
const autoApprove = ref<boolean>(true);
const effort = ref<string>('high');
const maxTurns = ref<string>('200');
const allowedTools = ref<string[]>([...AVAILABLE_TOOLS]);

const titleRef = ref<HTMLInputElement | null>(null);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const effortOptions: { value: string; label: string }[] = EFFORT_LEVELS.map(
  (e) => ({ value: e, label: e }),
);

const autoStartOptions = computed(() => [
  { value: 'now', label: t('requirements.newTask.startNow') },
  { value: 'later', label: t('requirements.newTask.startLater') },
]);

const autoApproveOptions = computed(() => [
  { value: 'off', label: t('common.toolReviewOff') },
  { value: 'on', label: t('common.toolReviewOn') },
]);

const taskTypeHint = (): string =>
  taskType.value === 'design'
    ? t('requirements.newTask.typeDesignHint')
    : t('requirements.newTask.typeDevHint');

/* ------------------------------------------------------------------ */
/*  Esc 关弹窗                                                          */
/* ------------------------------------------------------------------ */

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value && !submitting.value) {
    open.value = false;
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
});

/* ------------------------------------------------------------------ */
/*  helpers                                                             */
/* ------------------------------------------------------------------ */

function toggleTool(tool: string): void {
  allowedTools.value = allowedTools.value.includes(tool)
    ? allowedTools.value.filter((t) => t !== tool)
    : [...allowedTools.value, tool];
}

function resetForm(): void {
  title.value = '';
  prompt.value = '';
  taskType.value = 'dev';
  autoStart.value = true;
  autoApprove.value = true;
  effort.value = 'high';
  maxTurns.value = '200';
  allowedTools.value = [...AVAILABLE_TOOLS];
  formError.value = null;
}

function openModal(): void {
  open.value = true;
  // 下一帧聚焦 title, 与 master 同款
  setTimeout(() => titleRef.value?.focus(), 0);
}

function closeModal(): void {
  if (submitting.value) return;
  open.value = false;
}

/* ------------------------------------------------------------------ */
/*  Submit                                                              */
/* ------------------------------------------------------------------ */

async function handleSubmit(e: Event): Promise<void> {
  e.preventDefault();
  formError.value = null;
  if (!title.value.trim()) {
    formError.value = t('requirements.newTask.errTitleRequired');
    return;
  }
  if (!prompt.value.trim()) {
    formError.value = t('requirements.newTask.errPromptRequired');
    return;
  }
  submitting.value = true;
  try {
    const body: Record<string, unknown> = {
      title: title.value.trim(),
      prompt: prompt.value.trim(),
      type: taskType.value,
      autoApprove: autoApprove.value,
      effort: effort.value,
      maxTurns: parseInt(maxTurns.value, 10) || undefined,
      allowedTools: allowedTools.value,
      project_id: props.projectId,
      requirement_id: props.requirementId,
    };
    if (props.versionId) body.version_id = props.versionId;

    const task = (await post<{ id: string; title: string }>(
      '/api/tasks',
      body,
    )) as { id: string; title: string };

    if (autoStart.value) {
      try {
        const started = (await post<{ status: string }>(
          `/api/tasks/${task.id}/start`,
          {},
        )) as { status: string };
        toast.success(
          t('requirements.newTask.createdStarted', { title: task.title, status: started.status }),
        );
      } catch (startErr: unknown) {
        const msg =
          startErr instanceof HttpError
            ? `${startErr.message}${startErr.code ? ` [${startErr.code}]` : ''}`
            : startErr instanceof Error
              ? startErr.message
              : String(startErr);
        toast.error(t('requirements.newTask.createdStartFailed', { msg }));
      }
    } else {
      toast.success(t('requirements.newTask.createdPending', { title: task.title }));
    }

    open.value = false;
    resetForm();
    emit('created', task.id);
  } catch (err: unknown) {
    const msg =
      err instanceof HttpError
        ? `${err.message}${err.code ? ` [${err.code}]` : ''}`
        : err instanceof Error
          ? err.message
          : t('requirements.newTask.createFailed');
    formError.value = msg;
    toast.error(t('requirements.newTask.createFailedMsg', { msg }));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Button variant="primary" size="sm" @click="openModal"> + {{ t('requirements.newTask.openBtn') }} </Button>

  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center">
      <!-- Backdrop -->
      <div
        class="absolute inset-0 bg-black/40 backdrop-blur-sm"
        @click="closeModal"
      ></div>
      <!-- Dialog -->
      <form
        class="relative bg-white rounded-xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-y-auto p-6 space-y-4"
        @submit="handleSubmit"
      >
        <h3 class="text-lg font-semibold text-gray-900">{{ t('requirements.newTask.title') }}</h3>

        <div
          v-if="formError"
          class="p-3 bg-red-50 text-red-700 rounded text-sm"
        >
          {{ formError }}
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {{ t('requirements.newTask.labelTitle') }}
          </label>
          <input
            ref="titleRef"
            v-model="title"
            type="text"
            maxlength="200"
            :placeholder="t('requirements.newTask.placeholderTitle')"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {{ t('requirements.newTask.labelPrompt') }}
          </label>
          <Textarea
            v-model="prompt"
            :rows="6"
            :placeholder="t('requirements.newTask.placeholderPrompt')"
          />
          <p class="mt-1 text-xs text-gray-500">
            {{ t('requirements.newTask.forestHint') }}
          </p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {{ t('requirements.newTask.labelType') }}
          </label>
          <Select
            :model-value="taskType"
            :options="TASK_TYPE_OPTIONS"
            @update:model-value="
              (v) => (taskType = (v ?? 'dev') as TaskType)
            "
          />
          <p class="mt-1 text-xs text-gray-500">{{ taskTypeHint() }}</p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {{ t('requirements.newTask.labelStart') }}
          </label>
          <Select
            :model-value="autoStart ? 'now' : 'later'"
            :options="autoStartOptions"
            @update:model-value="(v) => (autoStart = v === 'now')"
          />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              {{ t('requirements.newTask.labelEffort') }}
            </label>
            <Select
              v-model="effort"
              :options="effortOptions"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              {{ t('requirements.newTask.labelMaxTurns') }}
            </label>
            <input
              v-model="maxTurns"
              type="number"
              min="1"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {{ t('tasks.resume.toolReviewLabel') }}
          </label>
          <Select
            :model-value="autoApprove ? 'on' : 'off'"
            :options="autoApproveOptions"
            @update:model-value="(v) => (autoApprove = v === 'on')"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            {{ t('requirements.newTask.labelTools') }}
          </label>
          <div class="flex flex-wrap gap-2 mb-2">
            <button
              v-for="p in TOOL_PRESETS"
              :key="p.key"
              type="button"
              :class="[
                'px-2.5 py-1 rounded-full text-xs border',
                p.tools.length === allowedTools.length &&
                p.tools.every((t) => allowedTools.includes(t))
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-gray-50 text-gray-600 border-gray-300 hover:border-blue-400',
              ]"
              @click="allowedTools = [...p.tools]"
            >
              {{ p.label }}
            </button>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="tool in AVAILABLE_TOOLS"
              :key="tool"
              type="button"
              :class="[
                'px-3 py-1 rounded text-sm',
                allowedTools.includes(tool)
                  ? 'bg-blue-100 text-blue-700 border border-blue-300'
                  : 'bg-gray-100 text-gray-500 border border-gray-200',
              ]"
              @click="toggleTool(tool)"
            >
              {{ tool }}
            </button>
          </div>
        </div>

        <div class="flex gap-3 justify-end pt-2 border-t mt-2">
          <Button
            variant="secondary"
            :disabled="submitting"
            @click="closeModal"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button
            type="submit"
            variant="primary"
            :loading="submitting"
            :disabled="!title.trim() || !prompt.trim()"
          >
            {{ submitting ? t('common.creating') : autoStart ? t('requirements.newTask.submitStart') : t('requirements.newTask.submitPending') }}
          </Button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
