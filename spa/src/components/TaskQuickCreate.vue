<script setup lang="ts">
/* 功能: 聊天式快速创建任务弹窗 (R232 Round4, damo 10-10; R233 Round7 补全) —
   点「+」不再跳 /tasks/new 表单页, 就地弹一个对话窗: 顶部选项目/版本 (可切换),
   底部聊天输入框, Enter 发送 → createTask + startTask 立即启动, 弹窗关闭回到
   看板 (SSE 自动把新任务插进列表, 不跳转不丢上下文). 形态参考聊天模式:
   上文选会话 (=项目/版本), 下文输入框 + 发送.
   R233 Round7 (damo 10-10 反馈「弹窗里没有附件和高级选项」):
   - composer foot 加 📎 附件 (chips 列表 + 可拖到输入区) 与「高级」折叠区
     (配置 snapshot select + goal loop 完成条件/最大轮次), 提交口径与
     TaskNew quick 模式完全同口径 (snapshot 覆盖 autoApprove/effort/maxTurns/
     model/llm_config_id/allowedTools/tags/type + goalRounds + 附件两阶段上传).
   - 草稿持久化 (input-history.ts loadDraft/saveDraft, key='quickcreate'):
     打开恢复 / 300ms 防抖保存 / 发送成功清空 — 刷新不丢 (附件 File 对象
     无法持久化, 刷新后附件列表为空, 文本草稿不受影响).
   - 全局共享输入历史 (loadGlobalInputHistory/pushGlobalInputHistory): ↑/↓
     召回任意入口 (task 聊天 / 本弹窗) 发送过的 prompt, terminal-style 劫持
     guard 与 TaskMessageInput 同款 (光标贴边 + 无选区 + IME 组字中不劫持).
   关注点:
   - 版本 Select 含「不挂版本」哨兵 (value=''), 与后端 version_id 可空对齐.
   - 发送中防重: sending 锁 + 按钮 disabled; 失败 toast 不关弹窗 (输入保留,
     不记历史不清草稿).
   - 打开时自动聚焦输入框 (nextTick), ESC/遮罩关闭走 Modal 既有行为. */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Modal from '@/components/Modal.vue';
import Select from '@/components/Select.vue';
import Input from '@/components/Input.vue';
import FileInput from '@/components/FileInput.vue';
import { listProjects, listVersions } from '@/api/projects';
import type { Project, Version } from '@/api/projects';
import { listApplicableSnapshots, type Snapshot } from '@/api/config-snapshots';
import { createTask, startTask, appendTaskAttachments, type TaskType } from '@/api/tasks';
import { uploadAttachmentToTask } from '@/api/assets';
import {
  buildGoalPrompt,
  formatSize,
  parseGoalRoundsInput,
  parseJsonStringArray,
} from '@/views/taskNew/predicates';
import {
  InputHistoryBrowser,
  loadDraft,
  saveDraft,
  loadGlobalInputHistory,
  pushGlobalInputHistory,
} from '@/lib/chat/input-history';
import { pickDefaultVersionId } from '@/lib/version-default';
import { useToast } from '@/composables/useToast';

const props = defineProps<{
  modelValue: boolean;
  /** 打开时预选的项目/版本 (项目看板场景传当前路由值; 全局看板不传). */
  initialProjectId?: string | null;
  initialVersionId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  /** 创建并启动成功, 带新 task id. 父组件可按需刷新 (SSE 一般已自动同步). */
  (e: 'created', taskId: string): void;
}>();

const toast = useToast();

/** 草稿 localStorage key (input-history.ts DRAFT_KEY_PREFIX 后缀). */
const DRAFT_KEY = 'quickcreate';

const projects = ref<Project[]>([]);
const versions = ref<Version[]>([]);
const projectId = ref('');
const versionId = ref('');
const prompt = ref('');
const sending = ref(false);
const loadingProjects = ref(false);
const inputEl = ref<HTMLTextAreaElement | null>(null);

/* R233 Round7: 高级项状态. */
const advancedOpen = ref(false);
const snapshots = ref<Snapshot[]>([]);
const snapshotId = ref('');
const goalText = ref('');
const goalRounds = ref('');
const pendingFiles = ref<File[]>([]);
const fileInputEl = ref<InstanceType<typeof FileInput> | null>(null);

const selectedSnapshot = computed<Snapshot | null>(
  () => snapshots.value.find((s) => s.id === snapshotId.value) ?? null,
);

const snapshotOptions = computed<Array<{ value: string; label: string }>>(() => [
  { value: '', label: '默认配置（自动审批 · high · 200 轮）' },
  ...snapshots.value.map((s) => ({
    value: s.id,
    label: `${s.name}${
      s.scope === 'version' ? '（版本）' : s.scope === 'project' ? '（项目）' : '（全局）'
    }`,
  })),
]);

const projectOptions = ref<Array<{ value: string; label: string }>>([]);
const versionOptions = ref<Array<{ value: string; label: string }>>([]);

/* 草稿 + 全局历史 (非响应式 — 纯键盘交互/落盘, 无渲染依赖). */
let draftTimer: number | null = null;
let globalHistory: string[] = [];
let histBrowser = new InputHistoryBrowser([]);

/** 打开时初始化: 拉项目列表 + 预选 + 恢复草稿 + 装载全局历史. */
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    loadingProjects.value = true;
    try {
      const { projects: list } = await listProjects();
      projects.value = list ?? [];
      projectOptions.value = projects.value.map((p) => ({ value: p.id, label: p.name }));
      const preferred = props.initialProjectId && projects.value.some((p) => p.id === props.initialProjectId)
        ? props.initialProjectId
        : (projects.value[0]?.id ?? '');
      // 预选意图先落 pendingPreferVersion, 拉版本统一走 watch(或补一次直接调用).
      // projectId 值不变时 watch 不触发 (第二次打开同项目), 需手动补拉.
      const unchanged = projectId.value === preferred;
      pendingPreferVersion = props.initialVersionId ?? null;
      projectId.value = preferred;
      if (unchanged) await loadVersions(preferred, pendingPreferVersion);
    } catch {
      toast.error('项目列表加载失败');
    } finally {
      loadingProjects.value = false;
    }
    // 竞态防护: 拉项目列表期间用户可能已敲字/召回, 只在仍为空时恢复草稿.
    if (prompt.value === '') prompt.value = loadDraft(DRAFT_KEY);
    goalText.value = '';
    goalRounds.value = '';
    advancedOpen.value = false;
    globalHistory = loadGlobalInputHistory();
    histBrowser = new InputHistoryBrowser(globalHistory);
    await nextTick();
    inputEl.value?.focus();
  },
);

/** 意图预选版本 (props.initialVersionId). watch 重拉时也要带上 —— 打开弹窗时
    projectId 赋值会触发 watch 的 loadVersions, 若不带 prefer, 项目看板场景的
    预选版本会被 current/第一个覆盖 (双 fetch 竞态). 用户手动切项目时清掉. */
let pendingPreferVersion: string | null = null;

/** 切项目重拉版本. prefer = props 预选 → 项目 current_version_id → 第一个 → 不挂.
    默认版本权威源 = projects.current_version_id; versions 表无 is_current 列
    (R56-B22 同款坑), 旧代码 is_current===1 永远 false → 永远选第一个版本. */
async function loadVersions(pid: string, preferVersion?: string | null): Promise<void> {
  versionId.value = '';
  versionOptions.value = [{ value: '', label: '不挂版本' }];
  if (!pid) return;
  try {
    const { versions: list } = await listVersions(pid);
    versions.value = list ?? [];
    versionOptions.value = [
      { value: '', label: '不挂版本' },
      ...versions.value.map((v) => ({ value: v.id, label: v.name })),
    ];
    versionId.value = pickDefaultVersionId(versions.value, {
      preferVersionId: preferVersion,
      currentVersionId: projects.value.find((p) => p.id === pid)?.current_version_id,
    });
  } catch {
    toast.error('版本列表加载失败');
  }
}

/** 项目/版本变化 → 重拉适用 snapshot (失败静默 = 无快照可选, 走默认配置). */
async function loadSnapshots(): Promise<void> {
  snapshotId.value = '';
  if (!projectId.value && !versionId.value) {
    snapshots.value = [];
    return;
  }
  try {
    snapshots.value = await listApplicableSnapshots(projectId.value, versionId.value);
  } catch {
    snapshots.value = [];
  }
}

watch(projectId, (next, prev) => {
  if (next && next !== prev) void loadVersions(next, pendingPreferVersion);
});

/** 用户手动切项目 = 放弃外部预选 (下次重拉按新项目 current/第一个选). */
function onProjectManuallyChanged(): void {
  pendingPreferVersion = null;
}

watch([projectId, versionId], () => {
  void loadSnapshots();
});

/* 草稿持久化: 输入即存 (300ms 防抖), 刷新后打开弹窗恢复. */
watch(prompt, (v) => {
  if (draftTimer != null) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    draftTimer = null;
    saveDraft(DRAFT_KEY, v);
  }, 300);
});

onBeforeUnmount(() => {
  if (draftTimer != null) {
    window.clearTimeout(draftTimer);
    saveDraft(DRAFT_KEY, prompt.value);
  }
});

const canSubmit = (): boolean => !sending.value && projectId.value !== '' && prompt.value.trim().length > 0;

/** Enter 发送 (Shift+Enter 换行) — 聊天习惯. IME 组合中不触发.
    ↑/↓ 召回全局历史 (terminal-style): 仅光标贴边 (↑ 首行 / ↓ 末行) +
    无选区时劫持, 多行文本内部方向键仍移动光标. */
function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const t = e.target as HTMLTextAreaElement | null;
    if (!t || t.selectionStart !== t.selectionEnd) return;
    if (e.key === 'ArrowUp') {
      if (t.value.slice(0, t.selectionStart).includes('\n')) return;
      if (globalHistory.length === 0) return;
      e.preventDefault();
      prompt.value = histBrowser.up(prompt.value);
    } else {
      if (t.value.slice(t.selectionEnd).includes('\n')) return;
      if (!histBrowser.active) return;
      e.preventDefault();
      prompt.value = histBrowser.down(prompt.value);
    }
    // 召回后光标落末尾 (v-model 异步 patch DOM, 用 microtask 等 patch 完).
    queueMicrotask(() => {
      const el = inputEl.value;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  void submit();
}

/* 附件: 📎 选择 + 拖到输入区皆可; × 移除. File 对象不持久化 (见文件头). */
function handleDrop(e: DragEvent): void {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) pendingFiles.value = [...pendingFiles.value, ...files];
}

function handleFileInputChange(files: FileList | null): void {
  const list = Array.from(files ?? []);
  if (list.length) pendingFiles.value = [...pendingFiles.value, ...list];
}

function removePendingFile(idx: number): void {
  pendingFiles.value = pendingFiles.value.filter((_, i) => i !== idx);
}

/** 附件两阶段上传 (创建后逐个传, 单文件失败不阻断 — 与 TaskNew 同款). */
async function uploadAttachments(taskId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const file of pendingFiles.value) {
    try {
      const resp = await uploadAttachmentToTask(taskId, file);
      if (resp.attachment?.id) ids.push(resp.attachment.id);
    } catch (err) {
      console.error('Attachment upload failed:', err);
    }
  }
  return ids;
}

async function submit(): Promise<void> {
  if (!canSubmit()) return;
  sending.value = true;
  const s = selectedSnapshot.value;
  try {
    const text = prompt.value.trim();
    const task = await createTask({
      title: text.length > 60 ? text.slice(0, 60) + '...' : text,
      prompt: buildGoalPrompt(text, goalText.value),
      autoApprove:
        s && s.auto_approve !== null && s.auto_approve !== undefined
          ? s.auto_approve === 1
          : true,
      effort: s?.effort ?? 'high',
      maxTurns: s?.max_turns ?? 200,
      model: s?.model ?? undefined,
      llm_config_id: s?.llm_config_id ?? undefined,
      allowedTools: s?.allowed_tools ? parseJsonStringArray(s.allowed_tools) : undefined,
      tags: s?.tags ? parseJsonStringArray(s.tags) : undefined,
      type: (s?.type as TaskType | null) || undefined,
      project_id: projectId.value,
      version_id: versionId.value || undefined,
      goalRounds: parseGoalRoundsInput(goalRounds.value) ?? undefined,
    });
    const taskId = (task as { id: string }).id;
    const attIds = await uploadAttachments(taskId);
    if (attIds.length > 0) await appendTaskAttachments(taskId, attIds);
    await startTask(taskId);
    // 成功才清草稿 + 记全局历史 (失败输入保留, 与 toast 不关弹窗一致).
    saveDraft(DRAFT_KEY, '');
    globalHistory = pushGlobalInputHistory(text);
    histBrowser = new InputHistoryBrowser(globalHistory);
    pendingFiles.value = [];
    goalText.value = '';
    goalRounds.value = '';
    advancedOpen.value = false;
    toast.success('任务已创建并启动');
    emit('created', taskId);
    emit('update:modelValue', false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '创建失败';
    toast.error(msg);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    title="新建任务"
    size="md"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="tqc-root">
      <div class="tqc-scope">
        <Select
          v-model="projectId"
          :options="projectOptions"
          :placeholder="loadingProjects ? '加载中…' : '选择项目'"
          class-name="tqc-select"
          @change="onProjectManuallyChanged"
        />
        <Select
          v-model="versionId"
          :options="versionOptions"
          placeholder="版本"
          class-name="tqc-select"
        />
      </div>
      <div class="tqc-hint-bubble">
        输入指令直接发送，任务会<span class="tqc-hint-strong">立即启动</span>。
        附件与高级选项在输入框下方，↑ 可翻历史指令。Enter 发送，Shift+Enter 换行。
      </div>
      <ul v-if="pendingFiles.length > 0" class="tqc-files">
        <li v-for="(f, i) in pendingFiles" :key="i" class="tqc-file-chip">
          <span class="tqc-file-name">{{ f.name }}</span>
          <span class="tqc-file-size">({{ formatSize(f.size) }})</span>
          <button type="button" class="tqc-file-x" title="移除附件" @click="removePendingFile(i)">×</button>
        </li>
      </ul>
      <div
        class="tqc-composer"
        @dragover.prevent
        @drop="handleDrop"
      >
        <textarea
          ref="inputEl"
          v-model="prompt"
          class="tqc-input"
          rows="3"
          placeholder="给这个项目/版本下达任务指令…"
          :disabled="sending"
          @keydown="onInputKeydown"
        />
        <div class="tqc-composer-foot">
          <div class="tqc-foot-tools">
            <button
              type="button"
              class="tqc-tool-btn"
              title="添加附件"
              @click="fileInputEl?.open()"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M13.5 7.5l-5.2 5.2a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6a2.3 2.3 0 0 1 3.2 3.2L6.7 11a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9" />
              </svg>
            </button>
            <button
              type="button"
              class="tqc-tool-btn"
              :class="{ active: advancedOpen }"
              :title="advancedOpen ? '收起高级选项' : '高级选项（配置快照 / 完成条件）'"
              @click="advancedOpen = !advancedOpen"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="2.2" />
                <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.5 1.5M10.9 10.9l1.5 1.5M12.4 3.6l-1.5 1.5M5.1 10.9l-1.5 1.5" />
              </svg>
              <span>高级</span>
            </button>
          </div>
          <span class="tqc-scope-name">{{ projectOptions.find((o) => o.value === projectId)?.label ?? '未选项目' }}<template v-if="versionId"> · {{ versionOptions.find((o) => o.value === versionId)?.label }}</template></span>
          <button
            type="button"
            class="tqc-send"
            :disabled="!canSubmit()"
            :title="sending ? '发送中…' : '发送 (Enter)'"
            @click="submit()"
          >
            <span v-if="sending" class="tqc-send-spinner" />
            <svg v-else viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 2 L7 9" />
              <path d="M14 2 L9.5 14 L7 9 L2 6.5 Z" />
            </svg>
            <span>{{ sending ? '发送中' : '发送' }}</span>
          </button>
        </div>
      </div>
      <div v-if="advancedOpen" class="tqc-advanced">
        <div class="tqc-adv-field">
          <label class="tqc-adv-lbl">配置</label>
          <Select
            v-model="snapshotId"
            :options="snapshotOptions"
            :disabled="snapshots.length === 0"
            class-name="tqc-adv-select"
          />
        </div>
        <div class="tqc-adv-field">
          <label class="tqc-adv-lbl">完成条件（goal loop，可选）</label>
          <textarea
            v-model="goalText"
            class="tqc-adv-goal"
            rows="2"
            placeholder="例：docs/foo.md 第一段第一个词是 'bar'（且其他内容不变）"
          />
          <div class="tqc-goal-rounds-row">
            <label class="tqc-adv-lbl-inline">最大轮次</label>
            <Input
              v-model="goalRounds"
              type="number"
              :min="0"
              :max="1000"
              :disabled="!goalText.trim()"
              placeholder="留空=默认 20, 0=不限"
              class-name="tqc-goal-num"
            />
            <span v-if="!goalText.trim() && goalRounds.trim()" class="tqc-goal-warn">⚠ goal_text 为空, 该数字无效</span>
          </div>
          <p class="tqc-adv-hint">
            提交时拼成 <code>&lt;goal&gt;...&lt;/goal&gt;</code> 追加到指令末尾，每轮由 grader 判定是否达成，未达成自动续跑。
          </p>
        </div>
      </div>
      <FileInput ref="fileInputEl" multiple @change="handleFileInputChange" />
    </div>
  </Modal>
</template>

<style scoped>
.tqc-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tqc-scope {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tqc-select {
  flex: 1 1 180px;
  min-width: 150px;
}

/* 聊天引导气泡: assistant 气泡视觉 (浅底 + 圆角 + 左下直角). */
.tqc-hint-bubble {
  align-self: flex-start;
  max-width: 92%;
  padding: 8px 12px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px 12px 12px 4px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.tqc-hint-strong {
  color: var(--color-text);
  font-weight: 600;
}

/* 附件 chips (composer 上方). */
.tqc-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tqc-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 3px 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--color-text);
}

.tqc-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tqc-file-size {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.tqc-file-x {
  background: none;
  border: 0;
  padding: 0 2px;
  font-size: 14px;
  line-height: 1;
  color: var(--color-text-muted);
  cursor: pointer;
}

.tqc-file-x:hover {
  color: var(--tw-red-500);
}

/* 底部输入区: 聊天输入框形态 (圆角大框 + 底部动作行). */
.tqc-composer {
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg);
  padding: 10px 12px 8px;
  transition: border-color 0.15s ease;
}

.tqc-composer:focus-within {
  border-color: var(--color-primary);
}

.tqc-input {
  width: 100%;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13.5px;
  line-height: 1.6;
  font-family: inherit;
}

.tqc-composer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.tqc-foot-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.tqc-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.tqc-tool-btn:hover {
  background: var(--color-bg);
  color: var(--color-text);
}

.tqc-tool-btn.active {
  color: var(--color-primary);
  background: var(--color-bg);
}

.tqc-scope-name {
  font-size: 11.5px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
}

.tqc-send {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 0;
  border-radius: 999px;
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.tqc-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tqc-send-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: tqc-spin 0.8s linear infinite;
}

@keyframes tqc-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 高级选项折叠区 (composer 下方): 配置快照 + goal loop. */
.tqc-advanced {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg);
}

.tqc-adv-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tqc-adv-lbl {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
}

.tqc-adv-select {
  width: 100%;
}

.tqc-adv-goal {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  font-size: 12.5px;
  line-height: 1.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 6px 8px;
  resize: vertical;
  box-sizing: border-box;
}

.tqc-adv-goal:focus {
  outline: none;
  border-color: var(--color-primary);
}

.tqc-goal-rounds-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.tqc-adv-lbl-inline {
  font-size: 12px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.tqc-goal-num {
  width: 110px;
}

.tqc-goal-warn {
  font-size: 11px;
  color: var(--tw-amber-500, #f59e0b);
}

.tqc-adv-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.tqc-adv-hint code {
  font-size: 10.5px;
}

/* ≤1023px (SPA 移动端断点惯例): Modal 已 maxWidth:92vw, 这里收间距. */
@media (max-width: 1023px) {
  .tqc-select {
    flex: 1 1 100%;
  }
}
</style>
