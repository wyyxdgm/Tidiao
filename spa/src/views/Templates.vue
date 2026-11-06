<script setup lang="ts">
/* 功能: Templates 模板管理视图 — 对应 Next src/app/templates/page.tsx, R24 字面
   要求 = GET /api/templates 列表 + 编辑 + 新建 modal. 视图范围按 sheet 红线只动
   本文件; 不动 router (挂载下一轮). UI 与 Next 同款: 卡片网格 + header 顶部新建
   按钮 + 单 Modal 切换 create/edit (复用 R5 Modal + 内嵌表单) + 删除走 R6
   ConfirmDialog.

   关注点 (sheet R24 + 与现实分歧):
   - sheet 字面 "GET /api/templates 列表 + 编辑 + 新建 modal", Next 端 page.tsx
     实现完整 8 字段表单 (name/prompt/model/llm_config_id/effort/maxTurns/
     autoApprove/tags), 本视图完整复刻 — 字段集对齐 = 与后端 model 一致.
   - Next model 字段用 <input list="..."> + datalist 做自动补全; SPA 没有原生
     datalist 包装, 这里降级为 Input + placeholder 提示常用模型. 用户仍可输入
     任意字符串 (后端 model 字段本身是自由文本, datalist 只是 UX 加分, 不影响
     数据形状). 已披露在 commit.
   - 创建/编辑共用一个 Modal, 模式由 isEditing 切换; 编辑时预填字段 (与 Next
     EditTemplateForm 同款). form 类型用本地 FormState (字段非可选), 提交时
     按新建/编辑映射到 CreateTemplateBody / UpdateTemplateBody.
   - maxTurns / autoApprove 等字段在编辑时按后端实际值反序列化 (number/boolean)
     → 表单本地字符串 ('')/boolean → 提交时再 parseInt/原值, 与 Next 端
     handleSubmit 同口径.
   - tags 是 JSON 字符串数组 (master 存储格式), UI 上展示为数组 + 输入框
     接受逗号分隔字符串; 解析/序列化用 api/templates.ts 暴露的 parseTags/
     serializeTags 工具.
   - LLM 配置选择项由 GET /api/user/llm-config/available 拉一次 (与 Next
     page.tsx 同款, 在 useEffect 拉一次缓存); 拉不到时退化为空列表 (UI 仍可用,
     只是少了 LLM 配置下拉). 已披露.
   - 不挂 SSE/事件流 (M3+ 范畴); 「从此模板创建任务」按钮 R41-B1 已接通:
     router.push('/tasks/new?<template fields>'), 复用 TaskNew.vue:651-676 URL prefill
     (8 字段 name/prompt/model/llm_config_id/effort/maxTurns/autoApprove/tags 全覆盖).
   - 软删除/版本管理/master 多视图等后续 task, 本轮只交付本视图本身. */

import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listAvailableLlmConfigs,
  parseTags,
  serializeTags,
  type Template,
  type AvailableLlmConfig,
  type CreateTemplateBody,
  type UpdateTemplateBody,
} from '@/api/templates';
import { useToast } from '@/composables/useToast';
import { useAvailableModels } from '@/composables/useAvailableModels';
import { isHttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import Button from '@/components/Button.vue';
import Textarea from '@/components/Textarea.vue';
import Input from '@/components/Input.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';

/* ------------------------------------------------------------------ */
/*  常量                                                                */
/* ------------------------------------------------------------------ */

/** 推理强度档位 — 与 master src/lib/constants.ts EFFORT_LEVELS 对齐. 内联在此是因为
    SPA bundle 不依赖 master 仓; 增删改一处即可, 后端校验是最终口径.
    i18n: label 走 t() (computed), value 是协议值原样. */
const EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const effortOptions = computed<{ value: string; label: string }[]>(() =>
  EFFORT_VALUES.map((v) => ({ value: v, label: v === '' ? t('misc.templates.effortDefault') : v })),
);

/* ------------------------------------------------------------------ */
/*  类型                                                                */
/* ------------------------------------------------------------------ */

/** 单条表单字段 — 所有字段都受控, 提交时再按 isEditing 映射到 Create/Update body. */
interface FormState {
  name: string;
  prompt: string;
  model: string;
  llm_config_id: string | null;
  effort: string;
  maxTurns: string;
  autoApprove: boolean;
  tags: string;
}

/** Modal 状态 — open + isEditing + form + submitting. */
interface ModalState {
  open: boolean;
  isEditing: boolean;
  /** 编辑模式下的目标 template id (用于 PATCH); null = 创建模式. */
  targetId: string | null;
  form: FormState;
  submitting: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    prompt: '',
    model: '',
    llm_config_id: null,
    effort: '',
    maxTurns: '',
    autoApprove: false,
    tags: '',
  };
}

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();
const router = useRouter();
const { t } = useI18n();

const templates = ref<Template[]>([]);
const llmConfigs = ref<AvailableLlmConfig[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

const modal = reactive<ModalState>({
  open: false,
  isEditing: false,
  targetId: null,
  form: emptyForm(),
  submitting: false,
});

/** 删除二次确认 — pendingDelete 非空 = 弹窗显示. */
const pendingDelete = ref<Template | null>(null);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** LLM 配置下拉 options — 空选项代表「默认 (按解析链)」. */
const llmConfigOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('misc.templates.llmDefault') },
  ...llmConfigs.value.map((c) => ({
    value: c.id,
    label: `${c.source === 'self' ? t('misc.templates.llmMine') : t('misc.templates.llmPlatform')} · ${c.name}${c.is_default ? t('misc.templates.llmIsDefault') : ''}`,
  })),
]);

/** R56-B4: 模型下拉统一走 useAvailableModels() (configured + builtin + used 三源并集),
    取代 R19 简化的本地 modelOptions (只有 6 条且不含用户已配置 + 历史 task). */
const { options: modelOptions } = useAvailableModels();

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await listTemplates();
    templates.value = Array.isArray(list) ? list : [];
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('misc.templates.loadFailedHttp', { n: e.status });
    } else if (e instanceof Error) {
      error.value = t('misc.templates.errNetwork', { msg: e.message });
    } else {
      error.value = t('misc.templates.loadFailed');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function onRetry(): void {
  retrying.value = true;
  void refresh();
}

async function loadLlmConfigs(): Promise<void> {
  // 静默拉取; 失败退化为空列表 (UI 上不显示 LLM 配置下拉, 不阻塞表单提交).
  llmConfigs.value = await listAvailableLlmConfigs();
}

onMounted(() => {
  void refresh();
  void loadLlmConfigs();
});

/* ------------------------------------------------------------------ */
/*  Modal — create / edit                                              */
/* ------------------------------------------------------------------ */

function openCreate(): void {
  modal.isEditing = false;
  modal.targetId = null;
  modal.form = emptyForm();
  modal.submitting = false;
  modal.open = true;
}

function openEdit(tpl: Template): void {
  modal.isEditing = true;
  modal.targetId = tpl.id;
  modal.form = {
    name: tpl.name,
    prompt: tpl.prompt,
    model: tpl.model ?? '',
    llm_config_id: tpl.llm_config_id,
    effort: tpl.effort ?? '',
    maxTurns: tpl.max_turns ? String(tpl.max_turns) : '',
    autoApprove: !!tpl.auto_approve,
    tags: parseTags(tpl.tags).join(', '),
  };
  modal.submitting = false;
  modal.open = true;
}

function closeModal(): void {
  if (modal.submitting) return;
  modal.open = false;
  modal.targetId = null;
  modal.form = emptyForm();
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function submitModal(): Promise<void> {
  const name = modal.form.name.trim();
  const prompt = modal.form.prompt.trim();
  if (!name) {
    toast.error(t('misc.templates.errNameRequired'));
    return;
  }
  if (!prompt) {
    toast.error(t('misc.templates.errPromptRequired'));
    return;
  }
  const maxTurnsNum = modal.form.maxTurns.trim() ? parseInt(modal.form.maxTurns, 10) : undefined;
  if (modal.form.maxTurns.trim() && (Number.isNaN(maxTurnsNum!) || maxTurnsNum! <= 0)) {
    toast.error(t('misc.templates.errMaxTurns'));
    return;
  }

  modal.submitting = true;
  try {
    if (modal.isEditing && modal.targetId) {
      // 编辑 — PATCH; 没改动的字段也回传 (后端 updateTemplate 按字段在不在 body 决定是否覆盖,
      // 所以这里回传全字段; 与 Next EditTemplateForm 同款).
      const tagsArray = parseTagsInput(modal.form.tags);
      const body: UpdateTemplateBody = {
        name,
        prompt,
        model: modal.form.model.trim() || null,
        llm_config_id: modal.form.llm_config_id || null,
        effort: modal.form.effort || null,
        maxTurns: maxTurnsNum ?? null,
        autoApprove: modal.form.autoApprove,
        tags: tagsArray,
      };
      const updated = await updateTemplate(modal.targetId, body);
      const idx = templates.value.findIndex((t) => t.id === updated.id);
      if (idx >= 0) templates.value[idx] = updated;
      toast.success(t('misc.templates.saved'));
      closeModal();
    } else {
      // 创建 — POST; maxTurns/effort/model/llm_config_id/tags 走「空 = 不传」语义 (master 后端
      // createTemplate 会把空值落 null, 不传等价).
      const tagsArray = parseTagsInput(modal.form.tags);
      const body: CreateTemplateBody = {
        name,
        prompt,
        ...(modal.form.model.trim() ? { model: modal.form.model.trim() } : {}),
        ...(modal.form.llm_config_id ? { llm_config_id: modal.form.llm_config_id } : {}),
        ...(modal.form.effort ? { effort: modal.form.effort } : {}),
        ...(maxTurnsNum !== undefined ? { maxTurns: maxTurnsNum } : {}),
        autoApprove: modal.form.autoApprove,
        ...(tagsArray.length ? { tags: tagsArray } : {}),
      };
      const created = await createTemplate(body);
      templates.value.unshift(created);
      toast.success(t('misc.templates.created'));
      closeModal();
    }
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('misc.templates.saveFailedHttp', { n: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('misc.templates.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('misc.templates.saveFailed'));
    }
  } finally {
    modal.submitting = false;
  }
}

/* ------------------------------------------------------------------ */
/*  删除                                                                */
/* ------------------------------------------------------------------ */

function askDelete(tpl: Template): void {
  pendingDelete.value = tpl;
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    await deleteTemplate(target.id);
    templates.value = templates.value.filter((t) => t.id !== target.id);
    toast.success(t('misc.templates.deleted'));
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('misc.templates.deleteFailedHttp', { n: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('misc.templates.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('misc.templates.deleteFailed'));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  「从此模板创建任务」                                                */
/* ------------------------------------------------------------------ */

/** R41-B1: 把模板字段映射到 TaskNew URL prefill params (sheet 拍板).
    TaskNew.vue:652-676 接受 ?name=&prompt=&model=&llm_config_id=&effort=&maxTurns=&autoApprove=&tags=,
    走的是 SPA 自己的 router.push — 不破坏模板编辑 modal, 也不重复实现表单.

    template.name → task title (符合 task 描述 "title" 字段语义);
    template.tags 是 JSON 字符串数组, 走 TaskNew 字符串入参 (前端 parseCsvTags 再处理). */
function onInstantiate(tpl: Template): void {
  const params: Record<string, string> = {};
  params.name = tpl.name;
  if (tpl.prompt) params.prompt = tpl.prompt;
  if (tpl.model) params.model = tpl.model;
  if (tpl.llm_config_id) params.llm_config_id = tpl.llm_config_id;
  if (tpl.effort) params.effort = tpl.effort;
  if (typeof tpl.max_turns === 'number' && Number.isFinite(tpl.max_turns)) {
    params.maxTurns = String(tpl.max_turns);
  }
  params.autoApprove = tpl.auto_approve ? 'true' : 'false';
  if (tpl.tags) {
    try {
      const parsed = JSON.parse(tpl.tags);
      if (Array.isArray(parsed) && parsed.length > 0) {
        params.tags = parsed.filter((x): x is string => typeof x === 'string').join(',');
      }
    } catch {
      /* tags 非 JSON 数组字符串 — 跳过, 让用户在 TaskNew 自行填写 */
    }
  }
  const qs = new URLSearchParams(params).toString();
  void router.push(`/tasks/new${qs ? `?${qs}` : ''}`);
}

/* ------------------------------------------------------------------ */
/*  渲染辅助                                                            */
/* ------------------------------------------------------------------ */

/** 时间格式化 — 与 Schedules.vue fmt 同款 (zh-CN + 24h). */
function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (iso.startsWith('9999')) return '—';
  try {
    // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
    return parseDbTime(iso)?.toLocaleString('zh-CN', { hour12: false }) ?? iso;
  } catch {
    return iso;
  }
}

/** 解析 LLM 配置 id → 显示名. 找不到时 fallback 后 8 位 (避免泄漏全 id). */
function llmConfigName(id: string | null): string | null {
  if (!id) return null;
  const found = llmConfigs.value.find((c) => c.id === id);
  return found ? found.name : `#${id.slice(-8)}`;
}

/** 卡片 meta 字段 — 把配置名 / 模型 / effort / maxTurns / autoApprove 拍平成片段.
    i18n: 用 {text, llm} 结构替代原 startsWith('LLM:') 判定 (en 前缀不同, 不能靠前缀识别). */
function cardMeta(tpl: Template): Array<{ text: string; llm: boolean }> {
  // 改名 tpl: 原 const t 参数会遮蔽 i18n 的 t(), 调 t('...') 会炸 (i18n W3c B2 迁移时修)
  const parts: Array<{ text: string; llm: boolean }> = [];
  const llmName = llmConfigName(tpl.llm_config_id);
  if (llmName) parts.push({ text: t('misc.templates.metaLlm', { name: llmName }), llm: true });
  if (tpl.model) parts.push({ text: tpl.model, llm: false });
  if (tpl.effort) parts.push({ text: tpl.effort, llm: false });
  if (tpl.max_turns) parts.push({ text: t('misc.templates.metaTurns', { n: tpl.max_turns }), llm: false });
  if (tpl.auto_approve) parts.push({ text: t('misc.templates.autoApprove'), llm: false });
  return parts;
}

/** 标签 chips — 最多展示 3 个, 多的隐藏 (与 Next 端 TemplateCard 同款). */
function cardTags(tpl: Template): string[] {
  return parseTags(tpl.tags).slice(0, 3);
}
</script>

<template>
  <div class="templates-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('misc.templates.pageTitle') }}</h1>
        <p class="page-subtitle">
          {{ t('misc.templates.pageSubtitle') }}
        </p>
      </div>
      <div class="header-actions">
        <Button
          variant="primary"
          size="sm"
          @click="openCreate"
        >
          {{ t('misc.templates.newBtn') }}
        </Button>
      </div>
    </header>

    <!-- Body -->
    <div class="page-body">
      <div v-if="loading && templates.length === 0" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">{{ t('misc.templates.loading') }}</p>
      </div>

      <ErrorView
        v-else-if="error"
        :title="t('misc.templates.loadFailed')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <Empty
        v-else-if="templates.length === 0"
        :title="t('misc.templates.emptyTitle')"
        :description="t('misc.templates.emptyDesc')"
        illustration="inbox"
      />

      <div v-else class="card-grid">
        <article
          v-for="tpl in templates"
          :key="tpl.id"
          class="template-card"
        >
          <!-- Header row -->
          <div class="card-top">
            <h3 class="card-title" :title="tpl.name">{{ tpl.name }}</h3>
            <div class="card-actions">
              <button
                class="icon-btn"
                :title="t('misc.templates.editBtn')"
                :aria-label="t('misc.templates.editBtn')"
                @click="openEdit(tpl)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM5 12.586V14h1.414l7.586-7.586L12.586 5 5 12.586z" />
                </svg>
              </button>
              <button
                class="icon-btn icon-btn-danger"
                :title="t('misc.templates.deleteBtn')"
                :aria-label="t('misc.templates.deleteBtn')"
                @click="askDelete(tpl)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                  <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Prompt summary -->
          <p class="card-prompt">{{ tpl.prompt }}</p>

          <!-- Meta row -->
          <div class="card-meta">
            <span
              v-for="(m, i) in cardMeta(tpl)"
              :key="i"
              :class="['meta-item', m.llm ? 'meta-llm' : '']"
            >
              {{ m.text }}
            </span>
            <span v-if="tpl.auto_approve" class="meta-auto">{{ t('misc.templates.autoApprove') }}</span>
            <div v-if="cardTags(tpl).length > 0" class="meta-tags">
              <span v-for="(tag, i) in cardTags(tpl)" :key="i" class="tag-chip">{{ tag }}</span>
            </div>
            <span class="meta-time">
              {{ fmt(tpl.updated_at) }}
            </span>
          </div>

          <!-- Instantiate button -->
          <button
            class="instantiate-btn"
            type="button"
            @click="onInstantiate(tpl)"
          >
            {{ t('misc.templates.instantiate') }}
          </button>
        </article>
      </div>
    </div>

    <!-- Create / Edit Modal -->
    <Modal
      :model-value="modal.open"
      :title="modal.isEditing ? t('misc.templates.editTitle') : t('misc.templates.createTitle')"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeModal(); }"
    >
      <div class="form">
        <!-- Name -->
        <div class="form-row">
          <label class="form-label">{{ t('misc.templates.nameLabel') }} <span class="required">*</span></label>
          <Input
            v-model="modal.form.name"
            :placeholder="t('misc.templates.phName')"
            :disabled="modal.submitting"
          />
        </div>

        <!-- Prompt -->
        <div class="form-row">
          <label class="form-label">Prompt <span class="required">*</span></label>
          <Textarea
            v-model="modal.form.prompt"
            :rows="8"
            :placeholder="t('misc.templates.phPrompt')"
            :disabled="modal.submitting"
          />
        </div>

        <!-- Optional config grid -->
        <div class="form-grid">
          <div class="form-row">
            <label class="form-label">{{ t('misc.templates.modelLabel') }}</label>
            <Select
              v-model="modal.form.model"
              :options="modelOptions"
              :placeholder="t('misc.templates.phDefault')"
              :disabled="modal.submitting"
            />
            <p class="form-hint">{{ t('misc.templates.hintModel') }}</p>
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.templates.llmLabel') }}</label>
            <Select
              v-model="modal.form.llm_config_id"
              :options="llmConfigOptions"
              :placeholder="t('misc.templates.llmDefault')"
              :disabled="modal.submitting"
            />
            <p class="form-hint">{{ t('misc.templates.hintLlm') }}</p>
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.templates.effortLabel') }}</label>
            <Select
              v-model="modal.form.effort"
              :options="effortOptions"
              :placeholder="t('misc.templates.phDefault')"
              :disabled="modal.submitting"
            />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.templates.maxTurnsLabel') }}</label>
            <Input
              v-model="modal.form.maxTurns"
              type="number"
              :placeholder="t('misc.templates.phDefault')"
              :disabled="modal.submitting"
            />
          </div>
          <div class="form-row form-row-inline">
            <Checkbox v-model="modal.form.autoApprove" :disabled="modal.submitting" />
            <span>{{ t('misc.templates.autoApprove') }}</span>
          </div>
        </div>

        <!-- Tags -->
        <div class="form-row">
          <label class="form-label">{{ t('misc.templates.tagsLabel') }}</label>
          <Input
            v-model="modal.form.tags"
            :placeholder="t('misc.templates.phTags')"
            :disabled="modal.submitting"
          />
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" :disabled="modal.submitting" @click="closeModal">
          {{ t('misc.templates.cancel') }}
        </Button>
        <Button :loading="modal.submitting" :disabled="modal.submitting" @click="submitModal">
          {{ modal.isEditing ? t('misc.templates.save') : t('misc.templates.create') }}
        </Button>
      </template>
    </Modal>

    <!-- Delete confirm (R6) -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="t('misc.templates.deleteConfirmTitle')"
      :message="pendingDelete
        ? t('misc.templates.deleteConfirmMsg', { name: pendingDelete.name })
        : ''"
      :confirm-text="t('misc.templates.delete')"
      :cancel-text="t('misc.templates.cancel')"
      type="danger"
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  页面                                                                */
/* ------------------------------------------------------------------ */
.templates-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.header-text { min-width: 0; }
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}
.page-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.header-actions { flex-shrink: 0; }

/* Body */
.page-body {
  flex: 1;
  padding: 20px 24px 32px;
}

.loading-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}
.loading-text {
  margin: 0;
  font-size: 14px;
}

/* Card grid */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.template-card {
  display: flex;
  flex-direction: column;
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.template-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--tw-gray-300);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.icon-btn:hover {
  color: var(--color-primary);
  background: var(--color-bg);
}
.icon-btn-danger:hover {
  color: var(--tw-red-600);
}

.card-prompt {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}

.card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.meta-item { display: inline-block; }
.meta-llm { color: var(--color-primary); }
.meta-auto {
  color: var(--tw-emerald-600);
  font-weight: 500;
}
.meta-tags {
  display: inline-flex;
  gap: 4px;
  overflow: hidden;
}
.tag-chip {
  display: inline-block;
  padding: 1px 8px;
  background: var(--color-bg);
  color: var(--color-text-muted);
  border-radius: var(--radius);
  font-size: 11px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.instantiate-btn {
  margin-top: 12px;
  width: 100%;
  padding: 6px 12px;
  background: var(--color-bg);
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.instantiate-btn:hover {
  background: var(--tw-blue-50);
  color: var(--color-primary);
  border-color: var(--tw-blue-300);
}

/* ------------------------------------------------------------------ */
/*  表单 (Modal 内)                                                    */
/* ------------------------------------------------------------------ */
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-row-inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.form-grid .form-row:last-child {
  grid-column: 1 / -1;
}
.form-label {
  font-size: 13px;
  color: var(--color-text);
}
.required { color: var(--tw-red-600); margin-left: 2px; }
.form-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.4;
}
</style>