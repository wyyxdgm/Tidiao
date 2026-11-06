<script setup lang="ts">
/* 功能: 项目级 LLM 配置面板 — 镜像 master src/app/projects-client.tsx LLM 段
   (line 1484-1635). 多份 LLM 配置 CRUD + 设默认 + 删确认. 由父视图 (ProjectsView
   / ProjectDetailView) 控制 `:open` 状态, 自身管 configs / draft / saving.

   关注点:
   - owner_type='project' 隐含 (后端路由强制), UI 不暴露 selector.
   - 协议 type='anthropic' 当前固定 (master 暂不开放), UI 不暴露.
   - 删除不受默认/最后一份限制 (R215: 删光走平台默认 fallback), server 兜底.
   - 修改现有 config: api_key 留空保留旧 key, 勾选 clear_api_key 才真清.
   - 编辑/保存后保持面板打开 + 刷新列表 (master 同款; 与 Settings.vue
     handleLlmSave 用法一致). 父视图监听 'updated' 事件触发更广刷新 (如 scopeCounts).
   - Model `<datalist>` 喂建议 (composable useAvailableModels), 用户仍可输自定义.
   - ConfirmDialog (imperative useConfirm) 用于删除二次确认. */
import { computed, reactive, ref, watch } from 'vue';
import {
  createProjectLlmConfig,
  deleteProjectLlmConfig,
  listProjectLlmConfigs,
  setProjectLlmConfigDefault,
  updateProjectLlmConfig,
  type ProjectLlmConfig,
  type ProjectLlmConfigInput,
} from '@/api/project-llm-config';
import { isHttpError } from '@/api/http';
import { useConfirm } from '@/components/ConfirmDialog.vue';
import { useToast } from '@/composables/useToast';
import { useAvailableModels } from '@/composables/useAvailableModels';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Checkbox from '@/components/Checkbox.vue';

const props = defineProps<{ projectId: string; open: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updated'): void;
}>();

const toast = useToast();
const { confirm: confirmDialog } = useConfirm();
const { options: modelOptions } = useAvailableModels();

const modelStringList = computed<string[]>(() =>
  modelOptions.value
    .map((o) => o.value)
    .filter((v): v is string => !!v),
);

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const llmConfigs = ref<ProjectLlmConfig[]>([]);
const loading = ref<boolean>(false);
const editingLlmConfigId = ref<string | 'new' | null>(null);
const llmSaving = ref<boolean>(false);
const llmMessage = ref<string | null>(null);

interface LlmDraft {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  clear_api_key: boolean;
}
const llmDraft = reactive<LlmDraft>({
  name: '',
  base_url: '',
  model: '',
  api_key: '',
  clear_api_key: false,
});

/* ------------------------------------------------------------------ */
/*  Data load                                                          */
/* ------------------------------------------------------------------ */

async function loadConfigs(): Promise<void> {
  if (!props.open) return;
  loading.value = true;
  try {
    llmConfigs.value = await listProjectLlmConfigs(props.projectId);
  } catch (e: unknown) {
    llmConfigs.value = [];
    if (isHttpError(e)) toast.error(`加载 LLM 配置失败: ${e.message}`);
    else toast.error('加载 LLM 配置失败');
  } finally {
    loading.value = false;
  }
}

/* `open` 变 true 才拉, 取到新鲜数据. 父视图切换 project 时也触发 (projectId 变
   且 open=true) — 一并刷新, 防止前一个项目残留. */
watch(
  () => [props.open, props.projectId] as const,
  ([isOpen]) => {
    if (isOpen) void loadConfigs();
    else {
      editingLlmConfigId.value = null;
      llmMessage.value = null;
    }
  },
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function startEdit(cfg: ProjectLlmConfig | 'new'): void {
  if (cfg === 'new') {
    editingLlmConfigId.value = 'new';
    llmDraft.name = '';
    llmDraft.base_url = '';
    llmDraft.model = '';
    llmDraft.api_key = '';
    llmDraft.clear_api_key = false;
  } else {
    editingLlmConfigId.value = cfg.id;
    llmDraft.name = cfg.name;
    llmDraft.base_url = cfg.base_url ?? '';
    llmDraft.model = cfg.model ?? '';
    llmDraft.api_key = '';
    llmDraft.clear_api_key = false;
  }
  llmMessage.value = null;
}

function cancelEdit(): void {
  editingLlmConfigId.value = null;
  llmMessage.value = null;
}

async function save(): Promise<void> {
  if (!llmDraft.name.trim()) {
    llmMessage.value = '名称必填';
    return;
  }
  llmSaving.value = true;
  llmMessage.value = null;
  const body: ProjectLlmConfigInput = {
    name: llmDraft.name.trim(),
    base_url: llmDraft.base_url.trim() || null,
    model: llmDraft.model.trim() || null,
  };
  if (llmDraft.clear_api_key) {
    body.clear_api_key = true;
  } else if (llmDraft.api_key.trim()) {
    body.api_key = llmDraft.api_key.trim();
  }
  try {
    if (editingLlmConfigId.value === 'new') {
      await createProjectLlmConfig(props.projectId, body);
    } else if (editingLlmConfigId.value) {
      await updateProjectLlmConfig(
        props.projectId,
        editingLlmConfigId.value,
        body,
      );
    } else {
      llmMessage.value = '无正在编辑的配置';
      return;
    }
    llmMessage.value = '✅ 已保存';
    cancelEdit();
    await loadConfigs();
    emit('updated');
  } catch (e: unknown) {
    if (isHttpError(e)) llmMessage.value = e.message;
    else llmMessage.value = '保存失败';
  } finally {
    llmSaving.value = false;
  }
}

async function setDefault(configId: string): Promise<void> {
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    await setProjectLlmConfigDefault(props.projectId, configId);
    llmMessage.value = '✅ 已设为默认';
    await loadConfigs();
    emit('updated');
  } catch (e: unknown) {
    if (isHttpError(e)) llmMessage.value = e.message;
    else llmMessage.value = '设置失败';
  } finally {
    llmSaving.value = false;
  }
}

async function handleDelete(c: ProjectLlmConfig): Promise<void> {
  const ok = await confirmDialog(
    '确定要删除这份配置？删除后该项目回落到平台默认 LLM 配置。',
    {
      title: `删除项目 LLM 配置「${c.name}」`,
      type: 'danger',
      confirmText: '删除',
    },
  );
  if (!ok) return;
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    await deleteProjectLlmConfig(props.projectId, c.id);
    llmMessage.value = '✅ 已删除';
    await loadConfigs();
    emit('updated');
  } catch (e: unknown) {
    if (isHttpError(e)) llmMessage.value = e.message;
    else llmMessage.value = '删除失败';
  } finally {
    llmSaving.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="llm-panel">
    <div class="llm-desc">
      项目级 LLM 配置（可多份，命名区分）。该项目下的任务优先用此处的默认配置；不配则按 admin → user → env 链路解析。
    </div>

    <div v-if="loading && llmConfigs.length === 0" class="llm-loading muted">
      加载中…
    </div>

    <!-- 列表 -->
    <div v-else-if="llmConfigs.length > 0" class="llm-table-wrap">
      <table class="llm-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>Base URL</th>
            <th>Model</th>
            <th>Key</th>
            <th>默认</th>
            <th class="text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cfg in llmConfigs" :key="cfg.id">
            <td class="llm-cell-name">{{ cfg.name }}</td>
            <td class="llm-cell-mono" :title="cfg.base_url || ''">
              {{ cfg.base_url || '—' }}
            </td>
            <td class="llm-cell-mono" :title="cfg.model || ''">
              {{ cfg.model || '—' }}
            </td>
            <td>
              <code v-if="cfg.has_api_key" class="llm-key-chip">{{ cfg.api_key_masked }}</code>
              <span v-else class="llm-key-warn">未配</span>
            </td>
            <td>
              <span v-if="cfg.is_default" class="llm-badge-default">默认</span>
              <button
                v-else
                type="button"
                class="llm-link"
                :disabled="llmSaving"
                @click="setDefault(cfg.id)"
              >设为默认</button>
            </td>
            <td class="llm-actions">
              <button
                type="button"
                class="llm-link"
                :disabled="llmSaving"
                @click="startEdit(cfg)"
              >编辑</button>
              <button
                type="button"
                class="llm-link llm-link-danger"
                :disabled="llmSaving"
                @click="handleDelete(cfg)"
              >删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新增 / 编辑表单 -->
    <div class="llm-form-section">
      <div class="llm-form-head">
        <h4 v-if="editingLlmConfigId !== null" class="llm-form-title">
          {{ editingLlmConfigId === 'new' ? '新增项目 LLM 配置' : '编辑项目 LLM 配置' }}
        </h4>
        <Button
          v-else
          variant="primary"
          size="sm"
          :disabled="llmSaving"
          @click="startEdit('new')"
        >+ 新增配置</Button>
      </div>

      <div v-if="editingLlmConfigId !== null" class="llm-form">
        <label class="llm-form-label">
          名称 *
          <Input
            v-model="llmDraft.name"
            placeholder="如：Claude 生产 / 火山方舟测试"
            :disabled="llmSaving"
          />
        </label>
        <label class="llm-form-label">
          Base URL
          <Input
            v-model="llmDraft.base_url"
            placeholder="留空继承上级"
            :disabled="llmSaving"
          />
        </label>
        <label class="llm-form-label">
          Model
          <Input
            v-model="llmDraft.model"
            placeholder="选择或输入自定义模型名"
            list="project-llm-model-options"
            :disabled="llmSaving"
          />
          <datalist id="project-llm-model-options">
            <option v-for="m in modelStringList" :key="m" :value="m" />
          </datalist>
        </label>
        <label class="llm-form-label">
          API Key
          <Input
            v-model="llmDraft.api_key"
            type="password"
            :placeholder="editingLlmConfigId !== 'new' ? '留空保留现有 key' : '输入 API Key'"
            :disabled="llmSaving"
            @update:model-value="(v: string) => { if (v) llmDraft.clear_api_key = false; }"
          />
          <span v-if="editingLlmConfigId !== 'new'" class="llm-clear-row">
            <Checkbox
              id="clear-project-api-key"
              :model-value="llmDraft.clear_api_key"
              :disabled="llmSaving"
              @update:model-value="(v: boolean) => llmDraft.clear_api_key = v"
            />
            <label for="clear-project-api-key" class="llm-clear-label">清除现有 key</label>
          </span>
        </label>

        <div class="llm-form-actions">
          <Button
            variant="primary"
            size="sm"
            :loading="llmSaving"
            :disabled="!llmDraft.name.trim()"
            @click="save"
          >保存</Button>
          <Button variant="ghost" size="sm" :disabled="llmSaving" @click="cancelEdit">取消</Button>
          <span v-if="llmMessage" class="llm-msg">{{ llmMessage }}</span>
        </div>
      </div>
      <span v-else-if="llmMessage" class="llm-msg">{{ llmMessage }}</span>
    </div>
  </div>
</template>

<style scoped>
/* R70: ProjectLlmConfigPanel — 蓝调 (与 advanced options 的 amber 区分).
   scoped 在父视图 (ProjectsView / ProjectDetailView) 内, 不污染其他视图.
   颜色用 inline hex 而非 var(), 因为 panel-specific 调色不在 main.css token 里;
   未来要主题化再抽 token. */
.llm-panel {
  background: var(--tw-blue-50);
  border-top: 1px solid var(--tw-blue-200);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.llm-desc {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--tw-blue-800);
}
.llm-loading {
  font-size: 12px;
}

.llm-table-wrap {
  overflow-x: auto;
  background: var(--color-bg-elevated);
  border-radius: var(--radius);
}
.llm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.llm-table th {
  text-align: left;
  font-weight: 500;
  color: var(--color-text-muted);
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  background: var(--tw-gray-50);
}
.llm-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}
.llm-table tr:last-child td {
  border-bottom: none;
}
.llm-cell-name {
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-cell-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.llm-key-chip {
  background: var(--tw-gray-100);
  padding: 1px 6px;
  border-radius: var(--radius);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.llm-key-warn {
  color: var(--tw-red-700);
  font-size: 11.5px;
}
.llm-badge-default {
  display: inline-block;
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  font-weight: 500;
}
.llm-actions {
  text-align: right;
  white-space: nowrap;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.llm-link {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 11.5px;
  color: var(--tw-blue-600);
  cursor: pointer;
}
.llm-link:hover:not(:disabled) {
  text-decoration: underline;
}
.llm-link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.llm-link-danger {
  color: var(--tw-red-600);
}

.llm-form-section {
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-blue-200);
  border-radius: var(--radius);
  padding: 10px;
}
.llm-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.llm-form-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--color-text);
}
.llm-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}
.llm-form-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--color-text);
}
.llm-clear-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.llm-clear-label {
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
}
.llm-form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.llm-msg {
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>