<!-- SnapshotManager — R23 镜像 Next /tasks/new 第三栏「模板配置」tab.
     - 顶部「新建快照」按钮 + 列表 (名称 / scope / 项目/版本 / 创建时间 / 操作)
     - 编辑/新建 = Modal (12 字段)
     - 删除 = ConfirmDialog 二次确认
     - API: 复用 spa/src/api/config-snapshots.ts (R23)

     关注点:
     - 内嵌 snapshot 编辑表单: 字段多, 全放一处好维护, 不再拆子组件
     - 与 Next 端 tab 的形态 1:1 对齐: 顶部 "新建快照" 按钮 + 列表 + 空态文案
     - ProjectSidebar 拿不到这里的 create modal, 因此 modal 状态严格本组件内自管
     - watch route query prefill-key: 配合外部"存为快照"按钮注入 (R107). -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  createConfigSnapshot,
  deleteConfigSnapshot,
  listConfigSnapshots,
  updateConfigSnapshot,
  type CreateSnapshotBody,
  type Snapshot,
  type SnapshotScope,
} from '@/api/config-snapshots';
import type { Project } from '@/api/projects';
import type { AvailableLlmConfig } from '@/api/templates';
import { isHttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';
import { AVAILABLE_TOOLS, EFFORT_LEVELS, TASK_TYPE_OPTIONS, TOOL_PRESETS } from '@/lib/constants';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import {
  formatSize,
  parseCsvTags,
  parseJsonStringArray,
  serializeCsvTags,
  serializeJsonStringArray,
} from './predicates';

const props = defineProps<{
  projects: Project[];
  availableLlmConfigs: AvailableLlmConfig[];
  initialProjectId: string;
  initialVersionId: string;
  prefillConfig: Partial<CreateSnapshotBody> | null;
  prefillKey: number;
  scopeProjects: Project[];
}>();

const toast = useToast();
const route = useRoute();
const { t } = useI18n();

const snapshots = ref<Snapshot[]>([]);
const loading = ref<boolean>(false);
const modalOpen = ref<boolean>(false);
const modalMode = ref<'create' | 'edit'>('create');
const editingId = ref<string | null>(null);
const pendingDeleteId = ref<string | null>(null);

interface SnapshotForm {
  name: string;
  description: string;
  scope: SnapshotScope;
  projectId: string;
  versionId: string;
  model: string;
  llm_config_id: string;
  effort: string;
  maxTurns: string;
  autoApprove: '' | 'on' | 'off';
  allowedTools: string[];
  tags: string;
  type: string;
}

function emptyForm(): SnapshotForm {
  return {
    name: '',
    description: '',
    scope: 'global',
    projectId: '',
    versionId: '',
    model: '',
    llm_config_id: '',
    effort: '',
    maxTurns: '',
    autoApprove: '',
    allowedTools: [...AVAILABLE_TOOLS],
    tags: '',
    type: '',
  };
}

const form = reactive<SnapshotForm>(emptyForm());

// 选项 label 走 t() 动态翻译 (语言切换即时生效).
const SCOPE_OPTIONS = computed<{ value: SnapshotScope; label: string }[]>(() => [
  { value: 'global', label: t('taskNew.snap.scopeGlobal') },
  { value: 'project', label: t('taskNew.snap.scopeProject') },
  { value: 'version', label: t('taskNew.snap.scopeVersion') },
]);

/** 硬编码 model shortcut — 与 TaskNew.vue MASTER_MODEL_OPTIONS 同源. */
const MASTER_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'MiniMax-M3', label: 'MiniMax-M3' },
  { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'doubao-seed-2.1-turbo', label: 'Doubao-Seed-2.1-Turbo' },
];

const EFFORT_OPTIONS = EFFORT_LEVELS.map((e) => ({ value: e, label: e }));
const AUTO_APPROVE_OPTIONS = computed<{ value: '' | 'on' | 'off'; label: string }[]>(() => [
  { value: '', label: t('taskNew.snap.inheritDefault') },
  { value: 'off', label: t('taskNew.snap.approveOff') },
  { value: 'on', label: t('taskNew.snap.approveOn') },
]);
// TASK_TYPE_OPTIONS 来自共享 constants.ts (中文 label 不改共享文件) — 按 value
// 映射到 taskNew.type_* key 动态翻译.
const TASK_TYPE_SELECT = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('taskNew.unclassified') },
  ...TASK_TYPE_OPTIONS.map((o) => ({ value: o.value, label: t(`taskNew.type_${o.value}`) })),
]);

const projectOptions = computed(() =>
  props.projects.map((p) => ({ value: p.id, label: p.name })),
);

const llmConfigOptions = computed(() => [
  { value: '', label: t('taskNew.snap.llmDefaultChain') },
  ...props.availableLlmConfigs.map((c) => ({ value: c.id, label: c.name })),
]);

const modelOptions = computed(() => {
  // SPA AvailableLlmConfig 没有 model 字段 (master AvailableLlmConfigSummary 才有),
  // 这里只显示硬编码 builtin 列表. 后端解析走 LLM config 而非 model 字符串, 用户
  // 通过 LLM 配置下拉间接选模型.
  return [
    { value: '', label: t('taskNew.snap.inheritDefault') },
    ...MASTER_MODEL_OPTIONS.map((m) => ({ value: m.value, label: m.label })),
  ];
});

function toggleTool(tool: string): void {
  form.allowedTools = form.allowedTools.includes(tool)
    ? form.allowedTools.filter((t) => t !== tool)
    : [...form.allowedTools, tool];
}

function setToolPreset(tools: string[]): void {
  form.allowedTools = [...tools];
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    snapshots.value = await listConfigSnapshots();
  } catch (e) {
    toast.error(isHttpError(e) ? e.message : t('taskNew.snap.loadFailed'));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// 接收 "存为快照" 按钮注入 (R107). prefillKey 自增, 触发一次.
watch(
  () => props.prefillKey,
  (newKey) => {
    if (newKey > 0 && props.prefillConfig) {
      Object.assign(form, emptyForm(), props.prefillConfig);
      modalMode.value = 'create';
      editingId.value = null;
      modalOpen.value = true;
    }
  },
);

function openCreate(): void {
  Object.assign(form, emptyForm());
  if (props.initialProjectId) form.projectId = props.initialProjectId;
  if (props.initialVersionId) form.versionId = props.initialVersionId;
  modalMode.value = 'create';
  editingId.value = null;
  modalOpen.value = true;
}

function openEdit(snap: Snapshot): void {
  modalMode.value = 'edit';
  editingId.value = snap.id;
  Object.assign(form, emptyForm(), {
    name: snap.name,
    description: snap.description ?? '',
    scope: snap.scope,
    projectId: snap.project_id ?? '',
    versionId: snap.version_id ?? '',
    model: snap.model ?? '',
    llm_config_id: snap.llm_config_id ?? '',
    effort: snap.effort ?? '',
    maxTurns: snap.max_turns != null ? String(snap.max_turns) : '',
    autoApprove:
      snap.auto_approve === 1 ? 'on' : snap.auto_approve === 0 ? 'off' : '',
    allowedTools: parseJsonStringArray(snap.allowed_tools),
    tags: serializeCsvTags(parseJsonStringArray(snap.tags)),
    type: snap.type ?? '',
  });
  modalOpen.value = true;
}

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    toast.error(t('taskNew.snap.errNameRequired'));
    return;
  }
  if (form.scope === 'version' && !form.projectId) {
    toast.error(t('taskNew.snap.errVersionNeedsProject'));
    return;
  }
  const body: CreateSnapshotBody = {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    scope: form.scope,
    projectId: form.scope !== 'global' ? form.projectId || undefined : undefined,
    versionId: form.scope === 'version' ? form.versionId || undefined : undefined,
    model: form.model.trim() || undefined,
    llm_config_id: form.llm_config_id || null,
    effort: form.effort || undefined,
    maxTurns: form.maxTurns.trim() ? Number(form.maxTurns) : undefined,
    autoApprove: form.autoApprove === '' ? undefined : form.autoApprove === 'on',
    allowedTools: form.allowedTools.length ? form.allowedTools : undefined,
    tags: parseCsvTags(form.tags).length ? parseCsvTags(form.tags) : undefined,
    type: form.type || undefined,
  };
  try {
    if (modalMode.value === 'create') {
      await createConfigSnapshot(body);
      toast.success(t('taskNew.snap.created'));
    } else if (editingId.value) {
      await updateConfigSnapshot(editingId.value, body);
      toast.success(t('taskNew.snap.updated'));
    }
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error(isHttpError(e) ? e.message : t('taskNew.snap.saveFailed'));
  }
}

function requestDelete(id: string): void {
  pendingDeleteId.value = id;
}

async function confirmDelete(): Promise<void> {
  if (!pendingDeleteId.value) return;
  try {
    await deleteConfigSnapshot(pendingDeleteId.value);
    toast.success(t('taskNew.snap.deleted'));
    pendingDeleteId.value = null;
    await load();
  } catch (e) {
    toast.error(isHttpError(e) ? e.message : t('taskNew.snap.deleteFailed'));
  }
}

function scopeLabel(s: SnapshotScope): string {
  return s === 'global'
    ? t('taskNew.snap.scopeGlobal')
    : s === 'project'
      ? t('taskNew.snap.scopeProject')
      : t('taskNew.snap.scopeVersion');
}

function snapshotDetail(s: Snapshot): string {
  const parts: string[] = [];
  if (s.model) parts.push(s.model);
  if (s.effort) parts.push(`effort=${s.effort}`);
  if (s.max_turns != null) parts.push(t('taskNew.snap.roundsN', { n: s.max_turns }));
  if (s.auto_approve === 1) parts.push(t('taskNew.snap.detailAutoApprove'));
  else if (s.auto_approve === 0) parts.push(t('taskNew.snap.detailNeedReview'));
  const tags = parseJsonStringArray(s.tags);
  if (tags.length) parts.push(`#${tags.join(' #')}`);
  return parts.join(' · ') || t('taskNew.snap.detailInherit');
}
</script>

<template>
  <div class="snapshots">
    <div class="snapshots-header">
      <h2>{{ t('taskNew.snap.title') }}</h2>
      <Button variant="primary" @click="openCreate">{{ t('taskNew.snap.new') }}</Button>
    </div>

    <div v-if="loading" class="empty">{{ t('taskNew.snap.loading') }}</div>
    <div v-else-if="snapshots.length === 0" class="empty">
      {{ t('taskNew.snap.empty') }}
    </div>
    <ul v-else class="snap-list">
      <li v-for="snap in snapshots" :key="snap.id" class="snap-item">
        <div class="snap-main">
          <div class="snap-title-row">
            <strong>{{ snap.name }}</strong>
            <span class="badge">{{ scopeLabel(snap.scope) }}</span>
            <span v-if="snap.scope !== 'global' && snap.scope === 'project'" class="muted-small">
              {{ snap.project_id }}
            </span>
            <span v-else-if="snap.scope === 'version'" class="muted-small">
              {{ snap.project_id }}/{{ snap.version_id }}
            </span>
          </div>
          <p v-if="snap.description" class="snap-desc">{{ snap.description }}</p>
          <div class="snap-detail muted-small">{{ snapshotDetail(snap) }}</div>
        </div>
        <div class="snap-actions">
          <button class="link-btn" @click="openEdit(snap)">{{ t('taskNew.snap.edit') }}</button>
          <button class="link-btn danger" @click="requestDelete(snap.id)">{{ t('taskNew.snap.delete') }}</button>
        </div>
      </li>
    </ul>

    <!-- 新建/编辑 modal -->
    <Modal v-model="modalOpen" :title="modalMode === 'create' ? t('taskNew.snap.modalCreate') : t('taskNew.snap.modalEdit')">
      <div class="form space-y-3">
        <div>
          <label class="lbl">{{ t('taskNew.snap.nameLabel') }}</label>
          <Input v-model="form.name" :placeholder="t('taskNew.snap.namePlaceholder')" />
        </div>
        <div>
          <label class="lbl">{{ t('taskNew.snap.descLabel') }}</label>
          <Textarea v-model="form.description" :rows="2" :placeholder="t('taskNew.snap.descPlaceholder')" />
        </div>
        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.snap.scopeLabel') }}</label>
            <Select
              :model-value="form.scope"
              :options="SCOPE_OPTIONS"
              @update:model-value="(v: string | null) => form.scope = (v ?? 'global') as SnapshotScope"
            />
          </div>
          <div v-if="form.scope !== 'global'">
            <label class="lbl">{{ t('taskNew.snap.bindProject') }}</label>
            <Select
              :model-value="form.projectId"
              :options="projectOptions"
              :placeholder="t('taskNew.snap.selectProject')"
              @update:model-value="(v: string | null) => form.projectId = v ?? ''"
            />
          </div>
        </div>
        <div v-if="form.scope === 'version'">
          <label class="lbl">{{ t('taskNew.snap.bindVersion') }}</label>
          <Input v-model="form.versionId" :placeholder="t('taskNew.snap.versionPlaceholder')" />
          <p class="hint-small">{{ t('taskNew.snap.versionHint') }}</p>
        </div>
        <div class="grid-2">
          <div>
            <label class="lbl">{{ t('taskNew.snap.llmLabel') }}</label>
            <Select
              :model-value="form.llm_config_id"
              :options="llmConfigOptions"
              @update:model-value="(v: string | null) => form.llm_config_id = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.snap.modelLabel') }}</label>
            <Select
              :model-value="form.model"
              :options="modelOptions"
              @update:model-value="(v: string | null) => form.model = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.effortLabel') }}</label>
            <Select
              :model-value="form.effort"
              :options="[{ value: '', label: t('taskNew.snap.inheritDefault') }, ...EFFORT_OPTIONS]"
              @update:model-value="(v: string | null) => form.effort = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.maxRounds') }}</label>
            <Input
              v-model="form.maxTurns"
              type="number"
              :min="1"
              :placeholder="t('taskNew.snap.maxTurnsPlaceholder')"
              class-name="input-num"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.approveLabel') }}</label>
            <Select
              :model-value="form.autoApprove"
              :options="AUTO_APPROVE_OPTIONS"
              @update:model-value="(v: string | null) => form.autoApprove = (v ?? '') as '' | 'on' | 'off'"
            />
          </div>
          <div>
            <label class="lbl">{{ t('taskNew.snap.typeLabel') }}</label>
            <Select
              :model-value="form.type"
              :options="TASK_TYPE_SELECT"
              @update:model-value="(v: string | null) => form.type = v ?? ''"
            />
          </div>
        </div>
        <div>
          <label class="lbl">{{ t('taskNew.toolsLabel') }}</label>
          <div class="preset-row">
            <button
              v-for="p in TOOL_PRESETS"
              :key="p.key"
              type="button"
              class="chip-preset"
              :class="{ active: p.tools.length === form.allowedTools.length && p.tools.every((tool) => form.allowedTools.includes(tool)) }"
              @click="setToolPreset(p.tools)"
            >
              {{ t(`taskNew.preset_${p.key}`) }}
            </button>
          </div>
          <div class="tools-row">
            <button
              v-for="tool in AVAILABLE_TOOLS"
              :key="tool"
              type="button"
              class="chip-tool"
              :class="{ active: form.allowedTools.includes(tool) }"
              @click="toggleTool(tool)"
            >
              {{ tool }}
            </button>
          </div>
        </div>
        <div>
          <label class="lbl">{{ t('taskNew.tagsLabel') }}</label>
          <Input v-model="form.tags" :placeholder="t('taskNew.snap.tagsPlaceholder')" />
        </div>
      </div>
      <template #footer>
        <Button variant="primary" @click="submit">{{ t('taskNew.snap.save') }}</Button>
        <Button variant="secondary" @click="modalOpen = false">{{ t('taskNew.snap.cancel') }}</Button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="pendingDeleteId !== null"
      :title="t('taskNew.snap.deleteTitle')"
      :message="t('taskNew.snap.deleteMessage')"
      @confirm="confirmDelete"
      @cancel="pendingDeleteId = null"
    />
  </div>
</template>

<style scoped>
.snapshots { padding: 4px; }
.snapshots-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.snapshots-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
.empty {
  padding: 40px;
  text-align: center;
  color: var(--tw-gray-400);
  font-size: 13px;
  background: var(--tw-gray-50);
  border-radius: 6px;
  border: 1px dashed var(--tw-gray-300);
}
.snap-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.snap-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-gray-200);
  border-radius: 6px;
}
.snap-main { flex: 1; min-width: 0; }
.snap-title-row { display: flex; align-items: center; gap: 8px; }
.snap-title-row strong { font-size: 14px; }
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--tw-blue-50);
  color: var(--tw-blue-800);
  border: 1px solid var(--tw-blue-300);
}
.snap-desc { font-size: 12px; color: var(--tw-gray-500); margin: 4px 0 0 0; }
.snap-detail { margin-top: 4px; }
.snap-actions { display: flex; gap: 8px; }
.link-btn {
  background: none;
  border: none;
  color: var(--tw-blue-500);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
}
.link-btn:hover { text-decoration: underline; }
.link-btn.danger { color: var(--tw-red-500); }

.form { display: flex; flex-direction: column; gap: 12px; }
.space-y-3 > * + * { margin-top: 12px; }
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.lbl { display: block; font-size: 13px; font-weight: 500; color: var(--tw-gray-700); margin-bottom: 4px; }
.input-num { width: 100%; }
.hint-small { font-size: 11px; color: var(--tw-gray-500); margin: 4px 0 0 0; }
.muted-small { font-size: 11px; color: var(--tw-gray-400); }

.preset-row, .tools-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.chip-preset, .chip-tool {
  padding: 4px 10px;
  border: 1px solid var(--tw-gray-300);
  background: var(--color-bg-elevated);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.chip-preset.active, .chip-tool.active {
  background: var(--tw-blue-500-solid);
  color: white;
  border-color: var(--tw-blue-500);
}
</style>