<script setup lang="ts">
/* 波3 P5 (docs/plans/role-scoped-roles.md D5): Settings「角色」tab 面板.
   Role = 可复用配置包 (system_prompt + model/effort/max_turns/allowed_tools
   defaults), 建任务时继承. v525 项目绑定 (null=全局) + v527 飞书回写开关. */
import { computed, onMounted, reactive, ref } from 'vue';
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

const roles = ref<Role[]>([]);
const projects = ref<Project[]>([]);
const loading = ref<boolean>(true);
const error = ref<string>('');

const { options: modelOptions } = useAvailableModels();

const EFFORT_OPTIONS = EFFORT_LEVELS.map((e) => ({ value: e, label: e }));

const projectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: '全局（所有项目可用）' },
  ...projects.value.map((p) => ({ value: p.id, label: p.name })),
]);

function projectName(id: string | null): string {
  if (!id) return '全局';
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
    error.value = e instanceof Error ? e.message : '加载角色失败';
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
    toast.error('名称和 system_prompt 必填');
    return;
  }
  saving.value = true;
  try {
    const body = draftToBody();
    if (editing.value) {
      await updateRole(editing.value.id, body);
      toast.success('角色已更新');
    } else {
      await createRole(body as never);
      toast.success('角色已创建');
    }
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(role: Role): Promise<void> {
  const ok = await confirm(
    `确定删除角色「${role.name}」？已有任务不受影响（role 随 task 定型）。`,
    { title: '删除角色', type: 'danger', confirmText: '删除' },
  );
  if (!ok) return;
  try {
    await deleteRole(role.id);
    toast.success('已删除');
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '删除失败');
  }
}
</script>

<template>
  <section class="card section-card">
    <div class="section-head">
      <h2 class="section-title">🎭 角色预设</h2>
      <span class="badge badge-info">建任务时继承 system_prompt + 默认参数</span>
      <Button variant="primary" class="head-action" @click="openCreate">＋ 新建角色</Button>
    </div>

    <Loading v-if="loading" />
    <ErrorView v-else-if="error" title="加载角色失败" :description="error" @retry="load" />
    <template v-else>
      <Empty
        v-if="roles.length === 0"
        title="还没有角色"
        description="角色 = 可复用的 system_prompt + 默认参数包，派发时选一个即可让任务带着预设人设与约束跑。点右上角「新建角色」开始。"
      />
      <table v-else class="roles-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>项目绑定</th>
            <th>飞书回写</th>
            <th>模型 / 强度 / 轮次</th>
            <th>更新时间</th>
            <th class="col-actions">操作</th>
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
                {{ r.feishu_writeback !== 0 ? '允许' : '禁止' }}
              </span>
            </td>
            <td class="muted small">
              {{ [r.model || '默认模型', r.effort || '默认强度', r.max_turns ? `${r.max_turns} 轮` : null].filter(Boolean).join(' · ') }}
            </td>
            <td class="muted small">{{ (r.updated_at || '').slice(0, 16).replace('T', ' ') }}</td>
            <td class="col-actions">
              <Button variant="ghost" size="sm" @click="openEdit(r)">编辑</Button>
              <Button variant="danger" size="sm" @click="remove(r)">删除</Button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted small form-aside">
        全局角色所有项目可选用；绑定项目的角色只在该项目派发时出现在角色下拉里。
        「禁止回写」角色的任务完成后不自动同步飞书（行为开关，agent 直写通道不受限）。
      </p>
    </template>

    <!-- 新建 / 编辑 -->
    <Modal v-model="modalOpen" :title="editing ? `编辑角色：${editing.name}` : '新建角色'" size="lg">
      <div class="role-form">
        <div class="form-grid">
          <div>
            <label class="lbl">名称 <span class="req">*</span></label>
            <Input v-model="draft.name" placeholder="如 Talker / Reviewer" :disabled="saving" />
          </div>
          <div>
            <label class="lbl">项目绑定</label>
            <Select
              :model-value="draft.project_id"
              :options="projectOptions"
              :disabled="saving"
              @update:model-value="(v: string | null) => draft.project_id = v ?? ''"
            />
          </div>
        </div>
        <div>
          <label class="lbl">描述</label>
          <Input v-model="draft.description" placeholder="一句话说明这个角色干什么" :disabled="saving" />
        </div>
        <div>
          <label class="lbl">System Prompt <span class="req">*</span></label>
          <Textarea
            v-model="draft.system_prompt"
            :rows="7"
            placeholder="角色人设 / 约束 / 输出要求。建任务时拼到 prompt 头部作 [role: 名称] 前缀。"
            :disabled="saving"
          />
        </div>
        <div class="form-grid form-grid-3">
          <div>
            <label class="lbl">模型覆盖</label>
            <Input v-model="draft.model" list="role-model-options" placeholder="留空 = 个人/项目配置" :disabled="saving" />
            <datalist id="role-model-options">
              <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </datalist>
          </div>
          <div>
            <label class="lbl">推理强度</label>
            <Select
              :model-value="draft.effort"
              :options="EFFORT_OPTIONS"
              placeholder="默认"
              :disabled="saving"
              @update:model-value="(v: string | null) => draft.effort = v"
            />
          </div>
          <div>
            <label class="lbl">最大轮次</label>
            <Input v-model="draft.max_turns" type="number" :min="1" placeholder="默认" :disabled="saving" />
          </div>
        </div>
        <div>
          <label class="lbl">允许工具（逗号分隔，留空 = 全部）</label>
          <Input v-model="draft.allowed_tools" placeholder="Read, Glob, Grep, Bash" :disabled="saving" />
        </div>
        <div>
          <label class="lbl">记忆文档路径（memory_doc）</label>
          <Input v-model="draft.memory_doc" placeholder="如 docs/memory/talker.md（运行时外化状态，可留空）" :disabled="saving" />
        </div>
        <Checkbox
          :model-value="draft.feishu_writeback"
          :disabled="saving"
          label="允许飞书回写（任务完成后自动同步结果到绑定 sheet）"
          @update:model-value="(v: boolean) => draft.feishu_writeback = v"
        />
      </div>
      <template #footer>
        <div class="modal-actions">
          <Button variant="ghost" :disabled="saving" @click="modalOpen = false">取消</Button>
          <Button variant="primary" :loading="saving" @click="save">
            {{ editing ? '保存' : '创建' }}
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
