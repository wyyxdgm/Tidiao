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

const SCOPE_OPTIONS: { value: SnapshotScope; label: string }[] = [
  { value: 'global', label: '全局' },
  { value: 'project', label: '项目' },
  { value: 'version', label: '版本' },
];

/** 硬编码 model shortcut — 与 TaskNew.vue MASTER_MODEL_OPTIONS 同源. */
const MASTER_MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'MiniMax-M3', label: 'MiniMax-M3' },
  { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'doubao-seed-2.1-turbo', label: 'Doubao-Seed-2.1-Turbo' },
];

const EFFORT_OPTIONS = EFFORT_LEVELS.map((e) => ({ value: e, label: e }));
const AUTO_APPROVE_OPTIONS: { value: '' | 'on' | 'off'; label: string }[] = [
  { value: '', label: '继承默认' },
  { value: 'off', label: '需要审核' },
  { value: 'on', label: '自动通过' },
];
const TASK_TYPE_SELECT = [{ value: '', label: '未分类' }, ...TASK_TYPE_OPTIONS];

const projectOptions = computed(() =>
  props.projects.map((p) => ({ value: p.id, label: p.name })),
);

const llmConfigOptions = computed(() => [
  { value: '', label: '默认（按项目/管理员链解析）' },
  ...props.availableLlmConfigs.map((c) => ({ value: c.id, label: c.name })),
]);

const modelOptions = computed(() => {
  // SPA AvailableLlmConfig 没有 model 字段 (master AvailableLlmConfigSummary 才有),
  // 这里只显示硬编码 builtin 列表. 后端解析走 LLM config 而非 model 字符串, 用户
  // 通过 LLM 配置下拉间接选模型.
  return [
    { value: '', label: '继承默认' },
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
    toast.error(isHttpError(e) ? e.message : '加载快照失败');
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
    toast.error('请填写快照名称');
    return;
  }
  if (form.scope === 'version' && !form.projectId) {
    toast.error('绑定版本需要先选项目');
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
      toast.success('快照已创建');
    } else if (editingId.value) {
      await updateConfigSnapshot(editingId.value, body);
      toast.success('快照已更新');
    }
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error(isHttpError(e) ? e.message : '保存失败');
  }
}

function requestDelete(id: string): void {
  pendingDeleteId.value = id;
}

async function confirmDelete(): Promise<void> {
  if (!pendingDeleteId.value) return;
  try {
    await deleteConfigSnapshot(pendingDeleteId.value);
    toast.success('快照已删除');
    pendingDeleteId.value = null;
    await load();
  } catch (e) {
    toast.error(isHttpError(e) ? e.message : '删除失败');
  }
}

function scopeLabel(s: SnapshotScope): string {
  return s === 'global' ? '全局' : s === 'project' ? '项目' : '版本';
}

function snapshotDetail(s: Snapshot): string {
  const parts: string[] = [];
  if (s.model) parts.push(s.model);
  if (s.effort) parts.push(`effort=${s.effort}`);
  if (s.max_turns != null) parts.push(`${s.max_turns} 轮`);
  if (s.auto_approve === 1) parts.push('自动审批');
  else if (s.auto_approve === 0) parts.push('需审核');
  const tags = parseJsonStringArray(s.tags);
  if (tags.length) parts.push(`#${tags.join(' #')}`);
  return parts.join(' · ') || '（继承默认）';
}
</script>

<template>
  <div class="snapshots">
    <div class="snapshots-header">
      <h2>模板配置</h2>
      <Button variant="primary" @click="openCreate">+ 新建快照</Button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="snapshots.length === 0" class="empty">
      还没有快照。点击「新建快照」创建第一个；或在「完整配置」填写后点「存为快照」。
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
          <button class="link-btn" @click="openEdit(snap)">编辑</button>
          <button class="link-btn danger" @click="requestDelete(snap.id)">删除</button>
        </div>
      </li>
    </ul>

    <!-- 新建/编辑 modal -->
    <Modal v-model="modalOpen" :title="modalMode === 'create' ? '新建快照' : '编辑快照'">
      <div class="form space-y-3">
        <div>
          <label class="lbl">名称 *</label>
          <Input v-model="form.name" placeholder="例如：默认开发配置" />
        </div>
        <div>
          <label class="lbl">描述</label>
          <Textarea v-model="form.description" :rows="2" placeholder="用途说明（可选）" />
        </div>
        <div class="grid-2">
          <div>
            <label class="lbl">作用范围 *</label>
            <Select
              :model-value="form.scope"
              :options="SCOPE_OPTIONS"
              @update:model-value="(v: string | null) => form.scope = (v ?? 'global') as SnapshotScope"
            />
          </div>
          <div v-if="form.scope !== 'global'">
            <label class="lbl">绑定项目</label>
            <Select
              :model-value="form.projectId"
              :options="projectOptions"
              placeholder="选择项目"
              @update:model-value="(v: string | null) => form.projectId = v ?? ''"
            />
          </div>
        </div>
        <div v-if="form.scope === 'version'">
          <label class="lbl">绑定版本</label>
          <Input v-model="form.versionId" placeholder="版本 UUID" />
          <p class="hint-small">必填。从项目 URL 取版本 ID。</p>
        </div>
        <div class="grid-2">
          <div>
            <label class="lbl">LLM 配置</label>
            <Select
              :model-value="form.llm_config_id"
              :options="llmConfigOptions"
              @update:model-value="(v: string | null) => form.llm_config_id = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">模型</label>
            <Select
              :model-value="form.model"
              :options="modelOptions"
              @update:model-value="(v: string | null) => form.model = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">推理强度</label>
            <Select
              :model-value="form.effort"
              :options="[{ value: '', label: '继承默认' }, ...EFFORT_OPTIONS]"
              @update:model-value="(v: string | null) => form.effort = v ?? ''"
            />
          </div>
          <div>
            <label class="lbl">最大轮次</label>
            <Input
              v-model="form.maxTurns"
              type="number"
              :min="1"
              placeholder="留空=继承"
              class-name="input-num"
            />
          </div>
          <div>
            <label class="lbl">工具审核</label>
            <Select
              :model-value="form.autoApprove"
              :options="AUTO_APPROVE_OPTIONS"
              @update:model-value="(v: string | null) => form.autoApprove = (v ?? '') as '' | 'on' | 'off'"
            />
          </div>
          <div>
            <label class="lbl">任务类型</label>
            <Select
              :model-value="form.type"
              :options="TASK_TYPE_SELECT"
              @update:model-value="(v: string | null) => form.type = v ?? ''"
            />
          </div>
        </div>
        <div>
          <label class="lbl">允许的工具</label>
          <div class="preset-row">
            <button
              v-for="p in TOOL_PRESETS"
              :key="p.key"
              type="button"
              class="chip-preset"
              :class="{ active: p.tools.length === form.allowedTools.length && p.tools.every((t) => form.allowedTools.includes(t)) }"
              @click="setToolPreset(p.tools)"
            >
              {{ p.label }}
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
          <label class="lbl">标签</label>
          <Input v-model="form.tags" placeholder="bugfix, auth（逗号分隔）" />
        </div>
      </div>
      <template #footer>
        <Button variant="primary" @click="submit">保存</Button>
        <Button variant="secondary" @click="modalOpen = false">取消</Button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="pendingDeleteId !== null"
      title="删除快照"
      message="确认删除？此操作不可撤销。"
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