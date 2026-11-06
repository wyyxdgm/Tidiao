<script setup lang="ts">
/* 功能: Fork 弹窗 — 从指定 message uuid 处 fork 新 task. POST /api/tasks/[id]/fork
   body { upToMessageId, title?, prompt?, newCwd?, maxTurns?, autoApprove?, compactFirst? }.
   有附件时走 multipart/form-data (R55.6 B249, 镜像 master task-detail-client.tsx:3614-3651).
   镜像 master task-detail-client.tsx:ForkFormModal (3322 fork 按钮调 setForkForm,
   后端同一路由).

   关注点:
   - 模式 = 'message' 唯一支持, upToMessageId 必传 (B230: 从某条 message uuid
     处 fork, 不是从 head/checkpoint). 留 'head'/'checkpoint' 给后续 task.
   - 默认值 = 沿用 task.current_title/prompt 作为新建 task 的 title/prompt;
     newCwd 留空 = 自动隔离; maxTurns 留空 = 不传 = 沿用 parent; autoApprove
     = 'inherit' (后端 forkSession 内部 fallback).
   - 附件 (R55.6): staging 模式 — 用户选的文件先缓存, 提交时 multipart 上传
     (meta=JSON, file*=File). 后端 saveAttachmentFromFile 把文件存到新任务 cwd
     并把"用户上传了以下文件"段落塞进 prompt, agent 首条消息能看到.
   - 提交后 emit('forked', newTaskId) 让父级跳转到新 task. */
import { computed, ref } from 'vue';
import Modal from '@/components/Modal.vue';
import Button from '@/components/Button.vue';
import Select from '@/components/Select.vue';
import Input from '@/components/Input.vue';
import Checkbox from '@/components/Checkbox.vue';
import { useToast } from '@/composables/useToast';
import { isHttpError } from '@/api/http';
import { forkFromMessage, type ForkFromMessageBody } from '@/api/tasks';

interface Props {
  taskId: string;
  /** parent task 当前标题 — fork 默认 title = parent.title (master 同款). */
  parentTitle: string;
  /** parent task 当前 prompt — fork 默认 prompt = parent.prompt (master 同款). */
  parentPrompt: string;
  /** parent task max_turns — placeholder 显示. */
  parentMaxTurns: number | null;
  /** context 占用 — 超过 compact threshold 时默认勾选「压缩后继续」. */
  contextTokens: number | null;
  compactThreshold: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'forked', newTaskId: string): void;
}>();

const toast = useToast();

const AUTO_APPROVE_OPTIONS = [
  { value: 'inherit', label: '继承父 task' },
  { value: 'on', label: '自动通过（不审核）' },
  { value: 'off', label: '需要逐个审核' },
];

/* R55.6 (B249) — 附件 staging. 与聊天输入框相同的"选完先缓存, 提交时再上传"
   模式. 单文件 ≤ 10MB (后端 /api/tasks/[id]/fork 也按这个限制截断, 与 master
   task-detail-client.tsx:3618 同款). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const pendingFiles = ref<File[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);

function pickFiles(fileList: FileList | null): void {
  if (!fileList) return;
  const next: File[] = [...pendingFiles.value];
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList.item(i);
    if (!f) continue;
    if (f.size > MAX_FILE_SIZE) {
      toast.warn(`「${f.name}」超过 10MB, 已跳过`);
      continue;
    }
    next.push(f);
  }
  pendingFiles.value = next;
}

function removeFile(idx: number): void {
  pendingFiles.value = pendingFiles.value.filter((_, i) => i !== idx);
}

function onFileInputChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  pickFiles(input.files);
  // 清空 value, 允许连续选同一文件.
  input.value = '';
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  Form state                                                         */
/* ------------------------------------------------------------------ */

const title = ref<string>(props.parentTitle);
const prompt = ref<string>(''); // master: prompt 留空 = 走 parent default
const newCwd = ref<string>(''); // 空 = 自动隔离 (后端 fallback)
const maxTurns = ref<string>(''); // 空 = 不传 = parent 当前值
const autoApprove = ref<'inherit' | 'on' | 'off'>('inherit');
const compactFirst = ref<boolean>(
  (props.contextTokens ?? 0) > props.compactThreshold,
);

const submitting = ref<boolean>(false);
const submitError = ref<string | null>(null);

/* ------------------------------------------------------------------ */
/*  Computed                                                           */
/* ------------------------------------------------------------------ */

/** 给父级提供 upToMessageId — 由 TaskTranscript 通过 slot / 调用 prefill
    注入. 这里提供一个 re-open 时再赋值的入口.

    R56-A4.1: 支持 session-head 模式 — 状态栏 📋 触发时 upToMessageId 留空,
    后端 forkSession 会从 session 末尾 fork. 加 sessionHead prop 切换提示文案 +
    放宽 canSubmit (只检 title). */
const upToMessageId = ref<string>('');
const sessionHead = ref<boolean>(false);

function prefillUpToMessageId(uuid: string): void {
  upToMessageId.value = uuid;
  sessionHead.value = false;
}
function setSessionHead(): void {
  upToMessageId.value = '';
  sessionHead.value = true;
}
defineExpose({ prefillUpToMessageId, setSessionHead });

const canSubmit = computed<boolean>(
  () => (sessionHead.value || !!upToMessageId.value) && !!title.value.trim(),
);

/* ------------------------------------------------------------------ */
/*  Submit                                                             */
/* ------------------------------------------------------------------ */

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    submitError.value = sessionHead.value ? '请填写新任务标题' : '请先从 transcript 选择一条消息';
    return;
  }
  submitting.value = true;
  submitError.value = null;
  try {
    // R56-A4.1: session-head 模式不传 upToMessageId, 后端 forkSession 会从
    // session 末尾 fork (master ForkFormModal mode="head" 同款).
    const body: ForkFromMessageBody = {
      ...(sessionHead.value ? {} : { upToMessageId: upToMessageId.value }),
      title: title.value.trim() || undefined,
      prompt: prompt.value.trim() || undefined,
      newCwd: newCwd.value.trim() || undefined,
      autoApprove: autoApprove.value === 'inherit' ? undefined : autoApprove.value === 'on',
      compactFirst: compactFirst.value,
    };
    const turnsNum = maxTurns.value ? parseInt(maxTurns.value, 10) : NaN;
    if (!Number.isNaN(turnsNum)) body.maxTurns = turnsNum;

    const res = await forkFromMessage(props.taskId, body, pendingFiles.value);
    const attachCount = res.attachments?.length ?? 0;
    toast.success(
      attachCount > 0
        ? `已 fork 新 task #${res.new_task_id.slice(0, 8)} (+${attachCount} 附件)`
        : `已 fork 新 task #${res.new_task_id.slice(0, 8)}`,
    );
    emit('forked', res.new_task_id);
  } catch (e) {
    submitError.value = isHttpError(e) ? e.message : (e instanceof Error ? e.message : 'fork 失败');
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
  <Modal
    :model-value="true"
    :title="sessionHead ? '📋 从当前会话 Fork' : '🔀 从消息处 Fork'"
    size="md"
    @close="onClose"
  >
    <div class="fork-form">
      <p class="hint">
        <template v-if="sessionHead">
          从当前 session 末尾 fork，新任务继承完整 session 历史 + 上下文。
          未填字段 = 沿用父 task 当前值。
        </template>
        <template v-else>
          从 transcript 中某条消息处 fork，新 task 继承到此为止的历史。
          未填字段 = 沿用父 task 当前值。
        </template>
      </p>

      <label v-if="!sessionHead" class="field">
        <span class="lbl">Fork 起点消息</span>
        <Input :model-value="upToMessageId" placeholder="(由 transcript hover ⑂ 按钮填入)" readonly />
      </label>

      <label class="field">
        <span class="lbl">新任务标题</span>
        <Input v-model="title" placeholder="新 fork 任务标题" />
      </label>

      <label class="field">
        <span class="lbl">新 prompt (可选)</span>
        <textarea
          v-model="prompt"
          class="ta"
          rows="3"
          placeholder="留空 = 沿用父 task prompt"
        />
      </label>

      <div class="grid-2">
        <label class="field">
          <span class="lbl">新 cwd (可选)</span>
          <Input v-model="newCwd" placeholder="留空 = 自动隔离" />
        </label>
        <label class="field">
          <span class="lbl">最大轮次 (可选)</span>
          <Input
            v-model="maxTurns"
            type="number"
            :min="1"
            :max="1000"
            :placeholder="parentMaxTurns ? `留空保持 ${parentMaxTurns}` : '留空保持当前设置'"
          />
        </label>
      </div>

      <label class="field">
        <span class="lbl">工具审核</span>
        <Select v-model="autoApprove" :options="AUTO_APPROVE_OPTIONS" />
      </label>

      <label class="field inline-field">
        <Checkbox v-model="compactFirst" />
        <span>压缩后继续（context 占用过高时推荐）</span>
      </label>

      <!-- R55.6 (B249) — 附件 staging. 与 master task-detail-client.tsx:3614-3651 同款.
           文件先入 pendingFiles, 提交时随 multipart 一起发到 /api/tasks/[id]/fork.
           后端 saveAttachmentFromFile 把文件存到新任务 cwd, prompt 拼接「用户上传
           了以下文件」段落, agent 首条消息就能看到绝对路径 + media_type + size. -->
      <div class="field">
        <div class="attach-head">
          <span class="lbl">附件 (可选, 单文件 ≤ 10MB)</span>
          <button
            type="button"
            class="attach-add"
            @click="fileInputRef?.click()"
          >📎 添加</button>
          <input
            ref="fileInputRef"
            type="file"
            multiple
            class="hidden-input"
            @change="onFileInputChange"
          />
        </div>
        <ul v-if="pendingFiles.length > 0" class="attach-list">
          <li
            v-for="(f, idx) in pendingFiles"
            :key="`${f.name}-${idx}`"
            class="attach-item"
          >
            <span class="attach-name">
              {{ f.name }}
              <span class="attach-meta">({{ fmtSize(f.size) }})</span>
            </span>
            <button
              type="button"
              class="attach-remove"
              title="移除"
              @click="removeFile(idx)"
            >×</button>
          </li>
        </ul>
      </div>

      <div v-if="submitError" class="error-text">⚠ {{ submitError }}</div>
    </div>

    <template #footer>
      <Button variant="ghost" :disabled="submitting" @click="onClose">取消</Button>
      <Button variant="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
        Fork 新任务
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.fork-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.field.inline-field {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.lbl {
  font-size: 12px;
  color: var(--color-text-muted);
}
.ta {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 13px;
  resize: vertical;
  box-sizing: border-box;
  font-family: inherit;
}
.ta:focus {
  outline: none;
  border-color: var(--color-primary, #3b82f6);
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.error-text {
  font-size: 12px;
  color: var(--tw-red-800);
  padding: 6px 10px;
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  border-radius: var(--radius);
}
.attach-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.attach-add {
  background: transparent;
  border: 0;
  color: var(--tw-blue-600);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.attach-add:hover { color: var(--tw-blue-700); text-decoration: underline; }
.hidden-input { display: none; }
.attach-list {
  list-style: none;
  padding: 0;
  margin: 4px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.attach-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--color-text-muted);
  background: var(--tw-gray-50);
  border-radius: var(--radius);
  padding: 4px 8px;
}
.attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-meta { color: var(--tw-gray-400); margin-left: 4px; }
.attach-remove {
  background: transparent;
  border: 0;
  color: var(--tw-gray-400);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  margin-left: 4px;
}
.attach-remove:hover { color: var(--tw-red-700); }
</style>