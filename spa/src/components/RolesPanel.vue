<script setup lang="ts">
/* 波3 P5 (docs/plans/role-scoped-roles.md D5): Settings「角色」tab 面板.
   Role = 可复用配置包 (system_prompt + model/effort/max_turns/allowed_tools
   defaults), 建任务时继承. v525 项目绑定 (null=全局) + v527 飞书回写开关. */
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import Modal from '@/components/Modal.vue';
import Loading from '@/components/Loading.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/components/ConfirmDialog.vue';
import { useAvailableModels } from '@/composables/useAvailableModels';
import {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  parseAllowedTools,
  type Role,
} from '@/api/roles';
import { listProjects, type Project } from '@/api/projects';
import { EFFORT_LEVELS } from '@/lib/constants';

const toast = useToast();
const { confirm } = useConfirm();
const { t } = useI18n();

const roles = ref<Role[]>([]);
const projects = ref<Project[]>([]);
const loading = ref<boolean>(true);
const error = ref<string>('');

const { options: modelOptions } = useAvailableModels();

const EFFORT_OPTIONS = EFFORT_LEVELS.map((e) => ({ value: e, label: e }));

const projectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('settings.roles.allProjects') },
  ...projects.value.map((p) => ({ value: p.id, label: p.name })),
]);

function projectName(id: string | null): string {
  if (!id) return t('settings.roles.global');
  return projects.value.find((p) => p.id === id)?.name ?? id.slice(0, 8);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [rs, ps] = await Promise.all([
      listRoles(),
      listProjects().then((r) => r.projects ?? []),
    ]);
    roles.value = rs;
    projects.value = ps;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('settings.roles.loadFailed');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

/* ------------------------------------------------------------------ */
/*  新建 / 编辑表单                                                     */
/* ------------------------------------------------------------------ */

const modalOpen = ref<boolean>(false);
const editing = ref<Role | null>(null);
const saving = ref<boolean>(false);

interface RoleDraft {
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  effort: string | null;
  max_turns: string;
  allowed_tools: string; // CSV
  memory_doc: string;
  project_id: string | null; // '' = 全局
  feishu_writeback: boolean;
}

function emptyDraft(): RoleDraft {
  return {
    name: '',
    description: '',
    system_prompt: '',
    model: '',
    effort: null,
    max_turns: '',
    allowed_tools: '',
    memory_doc: '',
    project_id: '',
    feishu_writeback: true,
  };
}

const draft = reactive<RoleDraft>(emptyDraft());

function openCreate(): void {
  editing.value = null;
  Object.assign(draft, emptyDraft());
  modalOpen.value = true;
}

function openEdit(role: Role): void {
  editing.value = role;
  Object.assign(draft, {
    name: role.name,
    description: role.description ?? '',
    system_prompt: role.system_prompt,
    model: role.model ?? '',
    effort: role.effort ?? null,
    max_turns: role.max_turns === null ? '' : String(role.max_turns),
    allowed_tools: parseAllowedTools(role.allowed_tools).join(', '),
    memory_doc: role.memory_doc ?? '',
    project_id: role.project_id ?? '',
    feishu_writeback: role.feishu_writeback !== 0,
  });
  modalOpen.value = true;
}

function draftToBody(): Record<string, unknown> {
  const maxTurnsNum = draft.max_turns.trim() ? Number(draft.max_turns) : undefined;
  const tools = draft.allowed_tools
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: draft.name.trim(),
    system_prompt: draft.system_prompt,
    description: draft.description || undefined,
    model: draft.model || undefined,
    effort: draft.effort || undefined,
    max_turns: maxTurnsNum !== undefined && Number.isFinite(maxTurnsNum) ? maxTurnsNum : undefined,
    allowed_tools: tools.length > 0 ? tools : undefined,
    memory_doc: draft.memory_doc || undefined,
    project_id: draft.project_id || null,
    feishu_writeback: draft.feishu_writeback ? 1 : 0,
  };
}

async function save(): Promise<void> {
  if (!draft.name.trim() || !draft.system_prompt.trim()) {
    toast.error(t('settings.roles.errRequired'));
    return;
  }
  saving.value = true;
  try {
    const body = draftToBody();
    if (editing.value) {
      await updateRole(editing.value.id, body);
      toast.success(t('settings.roles.updated'));
    } else {
      await createRole(body as never);
      toast.success(t('settings.roles.created'));
    }
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('settings.common.saveFailed'));
  } finally {
    saving.value = false;
  }
}

async function remove(role: Role): Promise<void> {
  const ok = await confirm(
    t('settings.roles.confirmDelete', { name: role.name }),
    { title: t('settings.roles.deleteTitle'), type: 'danger', confirmText: t('settings.common.delete') },
  );
  if (!ok) return;
  try {
    await deleteRole(role.id);
    toast.success(t('settings.common.deleted'));
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('settings.common.deleteFailed'));
  }
}
</script>

<template>
  <section class="card section-card">
    <div class="section-head">
      <h2 class="section-title">{{ t('settings.roles.title') }}</h2>
      <span class="badge badge-info">{{ t('settings.roles.badge') }}</span>
      <Button variant="primary" class="head-action" @click="openCreate">{{ t('settings.roles.create') }}</Button>
    </div>

    <Loading v-if="loading" />
    <ErrorView v-else-if="error" :title="t('settings.roles.loadFailed')" :description="error" @retry="load" />
    <template v-else>
      <Empty
        v-if="roles.length === 0"
        :title="t('settings.roles.emptyTitle')"
        :description="t('settings.roles.emptyDesc')"
      />
      <table v-else class="roles-table">
        <thead>
          <tr>
            <th>{{ t('settings.roles.thName') }}</th>
            <th>{{ t('settings.roles.thProject') }}</th>
            <th>{{ t('settings.roles.thWriteback') }}</th>
            <th>{{ t('settings.roles.thParams') }}</th>
            <th>{{ t('settings.roles.thUpdated') }}</th>
            <th class="col-actions">{{ t('settings.roles.thActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in roles" :key="r.id">
            <td>
              <div class="role-name">{{ r.name }}</div>
              <div v-if="r.description" class="role-desc">{{ r.description }}</div>
            </td>
            <td>
              <span class="badge" :class="r.project_id ? 'badge-info' : 'badge-muted'">
                {{ projectName(r.project_id) }}
              </span>
            </td>
            <td>
              <span class="badge" :class="r.feishu_writeback !== 0 ? 'badge-ok' : 'badge-warn'">
                {{ r.feishu_writeback !== 0 ? t('settings.roles.allow') : t('settings.roles.forbid') }}
              </span>
            </td>
            <td class="muted small">
              {{ [r.model || t('settings.roles.defaultModel'), r.effort || t('settings.roles.defaultEffort'), r.max_turns ? t('settings.roles.turns', { n: r.max_turns }) : null].filter(Boolean).join(' · ') }}
            </td>
            <td class="muted small">{{ (r.updated_at || '').slice(0, 16).replace('T', ' ') }}</td>
            <td class="col-actions">
              <Button variant="ghost" size="sm" @click="openEdit(r)">{{ t('settings.common.edit') }}</Button>
              <Button variant="danger" size="sm" @click="remove(r)">{{ t('settings.common.delete') }}</Button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small form-aside">
        {{ t('settings.roles.aside') }}
      </p>
    </template>

    <!-- 新建 / 编辑 -->
    <Modal v-model="modalOpen" :title="editing ? t('settings.roles.editTitle', { name: editing.name }) : t('settings.roles.createTitle')" size="lg">
      <div class="role-form">
        <div class="form-grid">
          <div>
            <label class="lbl">{{ t('settings.roles.lblName') }} <span class="req">*</span></label>
            <Input v-model="draft.name" :placeholder="t('settings.roles.phName')" :disabled="saving" />
          </div>
          <div>
            <label class="lbl">{{ t('settings.roles.lblProject') }}</label>
            <Select
              :model-value="draft.project_id"
              :options="projectOptions"
              :disabled="saving"
              @update:model-value="(v: string | null) => draft.project_id = v ?? ''"
            />
          </div>
        </div>
        <div>
          <label class="lbl">{{ t('settings.roles.lblDesc') }}</label>
          <Input v-model="draft.description" :placeholder="t('settings.roles.phDesc')" :disabled="saving" />
        </div>
        <div>
          <label class="lbl">{{ t('settings.roles.lblSystemPrompt') }} <span class="req">*</span></label>
          <Textarea
            v-model="draft.system_prompt"
            :rows="7"
            :placeholder="t('settings.roles.phPrompt')"
            :disabled="saving"
          />
        </div>
        <div class="form-grid form-grid-3">
          <div>
            <label class="lbl">{{ t('settings.roles.lblModel') }}</label>
            <Input v-model="draft.model" list="role-model-options" :placeholder="t('settings.roles.phModel')" :disabled="saving" />
            <datalist id="role-model-options">
              <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </datalist>
          </div>
          <div>
            <label class="lbl">{{ t('settings.roles.lblEffort') }}</label>
            <Select
              :model-value="draft.effort"
              :options="EFFORT_OPTIONS"
              :placeholder="t('settings.common.default')"
              :disabled="saving"
              @update:model-value="(v: string | null) => draft.effort = v"
            />
          </div>
          <div>
            <label class="lbl">{{ t('settings.roles.lblMaxTurns') }}</label>
            <Input v-model="draft.max_turns" type="number" :min="1" :placeholder="t('settings.common.default')" :disabled="saving" />
          </div>
        </div>
        <div>
          <label class="lbl">{{ t('settings.roles.lblTools') }}</label>
          <Input v-model="draft.allowed_tools" placeholder="Read, Glob, Grep, Bash" :disabled="saving" />
        </div>
        <div>
          <label class="lbl">{{ t('settings.roles.lblMemory') }}</label>
          <Input v-model="draft.memory_doc" :placeholder="t('settings.roles.phMemory')" :disabled="saving" />
        </div>
        <Checkbox
          :model-value="draft.feishu_writeback"
          :disabled="saving"
          :label="t('settings.roles.writebackLabel')"
          @update:model-value="(v: boolean) => draft.feishu_writeback = v"
        />
      </div>
      <template #footer>
        <div class="modal-actions">
          <Button variant="ghost" :disabled="saving" @click="modalOpen = false">{{ t('settings.common.cancel') }}</Button>
          <Button variant="primary" :loading="saving" @click="save">
            {{ editing ? t('settings.common.save') : t('settings.common.create') }}
          </Button>
        </div>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-action {
  margin-left: auto;
}
.roles-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.roles-table th,
.roles-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  vertical-align: top;
}
.roles-table th {
  color: var(--text-muted, #6b7280);
  font-weight: 500;
  font-size: 12px;
}
.col-actions {
  white-space: nowrap;
  text-align: right;
}
.col-actions > * + * {
  margin-left: 6px;
}
.role-name {
  font-weight: 600;
}
.role-desc {
  color: var(--text-muted, #6b7280);
  font-size: 12px;
  max-width: 320px;
}
.badge-muted {
  background: var(--bg-muted, #f3f4f6);
  color: var(--text-muted, #6b7280);
}
.badge-ok {
  background: var(--bg-ok, #ecfdf5);
  color: var(--text-ok, #047857);
}
.badge-warn {
  background: var(--bg-warn, #fffbeb);
  color: var(--text-warn, #b45309);
}
.form-aside {
  margin-top: 10px;
}
.role-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-grid-3 {
  grid-template-columns: 2fr 1fr 1fr;
}
.lbl {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
  margin-bottom: 4px;
}
.req {
  color: var(--text-danger, #dc2626);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
