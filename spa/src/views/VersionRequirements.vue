<script setup lang="ts">
/* 功能: VersionRequirements 视图 — 完整镜像 Next.js src/app/[projectId]/[versionId]/
   requirements/page.tsx (R26 增量). 与 src/components/RequirementsListView 共享
   渲染逻辑: 顶部条 (项目面包屑 + 清空版本 / 恢复版本 / 重置 / 总入口) +
   status 过滤 chip + 列表 + 分页 + 创建 modal.

   关注点 (与 master 对齐 + 与全局 Requirements.vue 的主动分歧):
   - 入口 URL = #/projects/[projectId]/versions/[versionId]/requirements (与 SPA
     现有 /projects/:projectId/versions/:versionId 嵌套路由对齐), hash 模式下
     :projectId / :versionId 都是路由 params (不是 query). 与 Next.js 路径形式
     /[projectId]/[versionId]/requirements 同款语义, 但路径前缀加了 /projects/
     与 /versions/ (避免与 :projectId 动态参数冲突, 已在 R24 拍板).
   - searchParams 行为 1:1 镜像:
     · ?clear=1 → 不传 version_id 给 listRequirements(), 等价看该 project 全量;
       顶部条切到「清空版本 → 恢复版本」按钮, 文案「当前视图 = 项目全量」.
     · ?status=xxx → 状态过滤; 顶部条 + 列表 chip 都保留 project_id / version_id,
       与 master buildLocalHref 同款 (R87 跟进, 不丢上下文).
     · 不传任何 query = 默认带当前 version 的全量需求.
   - 与全局 Requirements.vue 的差异 (主动披露):
     (1) 顶部条项目面包屑跳 /projects/[id]/versions/[current_version_id] (SPA
         有 current 跳转逻辑, R24); 不跳 /[projectId] (Next.js 行为) 因为 SPA
         :projectId 路径已被 R24 拍板为 redirect-only.
     (2) 创建按钮携带 project_id + version_id 直接打 modal (省去 R15 RequirementNew
         同款 url 跳转步骤), 列表 = 全功能复刻全局 Requirements.vue 的编辑/删除/
         latest revision 时间胶囊 + 聚合 3 chip (R74 W3 / G4 收口).
     (3) 聚合 3 chip (📋 N / 📈 X% / 💬 feedback) 与全局 Requirements.vue 1:1
         同款 (同 RequirementAggregates.vue 共享组件, 数据源 GET 单条 aggregates
         REST). 视觉对等 master RequirementsListView:313-343.
   - hash 路由下 router.push({ query }) 改 path 不会丢 scroll 位置; 与 SPA 路由
     现状 (无 SSR URL 强制约束) 对齐. */

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  listRequirements,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  parseRequirementTags,
  serializeRequirementTags,
  listRequirementRevisions,
  getRequirementAggregates,
  REQUIREMENT_STATUSES,
  type Requirement,
  type RequirementStatus,
  type RequirementRevision,
  type RequirementAggregates,
  type ActorType,
  type CreateRequirementBody,
  type UpdateRequirementBody,
} from '@/api/requirements';
import { listVersions, getProjectById, getVersionById } from '@/api/projects';
import { useProjectsStore } from '@/stores/projects';
import { useToast } from '@/composables/useToast';
import { isHttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Pagination from '@/components/Pagination.vue';
import AggregatesChips from '@/components/RequirementAggregates.vue';

/* ------------------------------------------------------------------ */
/*  常量 — 1:1 对齐 master RequirementsListView                       */
/*  i18n (W3c A2): 含中文的 label 常量改 computed 走 t() (非响应式常量   */
/*  语言切换不会更新); 状态枚举值 / actor 类型 / field 名 = 协议常量保留. */
/* ------------------------------------------------------------------ */

const { t, locale } = useI18n();

/** 状态 label — 复用公共 key requirements.status.*. */
const STATUS_LABEL = computed<Record<RequirementStatus, string>>(() => ({
  pending: t('requirements.status.pending'),
  done: t('requirements.status.done'),
  awaiting_reply: t('requirements.status.awaiting_reply'),
  has_suggestion: t('requirements.status.has_suggestion'),
  blocked: t('requirements.status.blocked'),
  closed: t('requirements.status.closed'),
}));

const STATUS_FILTER_OPTIONS = computed<{ value: '' | RequirementStatus; label: string }[]>(() => [
  { value: '', label: t('requirements.version.reqs.filterAll') },
  ...REQUIREMENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL.value[s] })),
]);

const ACTOR_COLOR: Record<ActorType, { bg: string; color: string; border: string }> = {
  agent: { bg: 'var(--tw-purple-50)', color: 'var(--tw-purple-700)', border: 'var(--tw-purple-200)' },
  user: { bg: 'var(--tw-blue-50)', color: 'var(--tw-blue-700)', border: 'var(--tw-blue-200)' },
  system: { bg: 'var(--tw-gray-50)', color: 'var(--tw-gray-600)', border: 'var(--tw-gray-200)' },
};
/** actor label — 复用公共 key requirements.actor.*. */
const ACTOR_LABEL = computed<Record<ActorType, string>>(() => ({
  agent: t('requirements.actor.agent'),
  user: t('requirements.actor.user'),
  system: t('requirements.actor.system'),
}));
/** field label — 复用公共 key requirements.field.*. */
const FIELD_LABEL = computed<Record<string, string>>(() => ({
  title: t('requirements.field.title'),
  description: t('requirements.field.description'),
  status: t('requirements.field.status'),
  priority: t('requirements.field.priority'),
  tags: t('requirements.field.tags'),
  version_id: t('requirements.field.version_id'),
}));

/* ------------------------------------------------------------------ */
/*  类型                                                                */
/* ------------------------------------------------------------------ */

interface FormState {
  title: string;
  description: string;
  status: RequirementStatus;
  priority: string;
  tags: string;
  /** 当前版本锁死 — 创建 modal 默认挂在进入页的 version; PATCH 不动 (与
      master 既有语义一致). */
  version_id: string;
}

interface ModalState {
  open: boolean;
  isEditing: boolean;
  targetId: string | null;
  form: FormState;
  submitting: boolean;
}

function emptyForm(versionId: string): FormState {
  return {
    title: '',
    description: '',
    status: 'pending',
    priority: '',
    tags: '',
    version_id: versionId,
  };
}

/* ------------------------------------------------------------------ */
/*  Route + 上下文                                                       */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();

/** URL 上的 :projectId / :versionId — hash 路由下都是 params. */
const projectId = computed<string>(() => String(route.params.projectId ?? ''));
const versionId = computed<string>(() => String(route.params.versionId ?? ''));

/** searchParams 解析 — ?clear=1 + ?status=xxx, 1:1 对齐 master. */
const isCleared = computed<boolean>(() => route.query.clear === '1');
const statusFilter = computed<'' | RequirementStatus>(() => {
  const v = route.query.status;
  if (typeof v !== 'string' || !v) return '';
  const candidate = v as RequirementStatus;
  return REQUIREMENT_STATUSES.includes(candidate) ? candidate : '';
});

/* ------------------------------------------------------------------ */
/*  顶部条 — project/version 元数据                                      */
/* ------------------------------------------------------------------ */

interface ProjectMeta {
  id: string;
  name: string;
  current_version_id: string | null;
}
interface VersionMeta {
  id: string;
  name: string;
}

const projectName = computed<string>(() => projectMeta.value?.name ?? projectId.value);
const versionName = computed<string>(() => versionMeta.value?.name ?? versionId.value);
const projectMeta = ref<ProjectMeta | null>(null);
const versionMeta = ref<VersionMeta | null>(null);

/** 当前视图文案 — 与 master "· 当前视图 = xxx" 1:1. */
const viewModeLabel = computed<string>(() =>
  isCleared.value
    ? t('requirements.version.reqs.viewAllProjects')
    : t('requirements.version.reqs.viewCurrentVersion'),
);

/** 项目链接 — 跳 SPA 项目根. R24 拍板 :projectId 路由是 redirect-only, 跳到 SPA
    现有的 /projects/[id] 视图 (R17 ProjectDetailView) 显示元数据 + 版本列表. */
const projectLink = computed<string>(() => `/projects/${projectId.value}`);

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const projects = useProjectsStore();
const toast = useToast();

const items = ref<Requirement[]>([]);
const total = ref<number>(0);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

const currentPage = ref<number>(1);
const pageSize = ref<number>(20);

const modal = reactive<ModalState>({
  open: false,
  isEditing: false,
  targetId: null,
  form: emptyForm(''),
  submitting: false,
});

const pendingDelete = ref<Requirement | null>(null);

/** 全局 versionNameById — 与全局 Requirements.vue 同款 (R107 行增强). */
const versionNameById = ref<Record<string, string>>({});
const latestRevisionById = reactive<Record<string, RequirementRevision | null>>({});

/** R74 W3: 每行 aggregates 缓存 (同 Requirements.vue). */
const aggregatesById = reactive<Record<string, RequirementAggregates>>({});

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** version 过滤传给 listRequirements: clear=1 → undefined (不过滤), 否则用
    path 上的 versionId. R64 语义保持 (undefined = 不过滤; null = 不挂版本; string
    = 具体 version). */
const versionIdFilter = computed<string | undefined>(() =>
  isCleared.value ? undefined : versionId.value,
);

/** 顶部条按钮 href — buildLocalHref 1:1 对齐 master: 保留 path 上下文, 不丢
    project_id / version_id (path 上, 不进 query). */
function localHref(opts: { clear?: boolean; status?: string | null }): string {
  const qs = new URLSearchParams();
  const useClear = opts.clear ?? isCleared.value;
  if (!useClear) qs.set('version_id', versionId.value);
  if (opts.status !== undefined) {
    if (opts.status !== null) qs.set('status', opts.status);
  } else if (statusFilter.value) {
    qs.set('status', statusFilter.value);
  }
  const q = qs.toString();
  return q ? `${route.path}?${q}` : route.path;
}

const clearToggleHref = computed<string>(() =>
  localHref({ clear: !isCleared.value }),
);
const resetHref = computed<string>(() => route.path);
const totalEntryHref = computed<string>(() => '/requirements');

const projectOptions = computed<{ value: string; label: string }[]>(() =>
  projects.projects.map((p) => ({ value: p.id, label: p.name })),
);

const priorityOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('requirements.version.reqs.priorityNone') },
  { value: '1', label: 'P1' },
  { value: '2', label: 'P2' },
  { value: '3', label: 'P3' },
  { value: '4', label: 'P4' },
  { value: '5', label: 'P5' },
]);

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const out = await listRequirements({
      status: statusFilter.value || undefined,
      project_id: projectId.value,
      version_id: versionIdFilter.value,
      page: currentPage.value,
      page_size: pageSize.value,
    });
    items.value = out.items;
    total.value = out.total;
    void refreshRevisionsFor(out.items);
    // R74 W3: aggregates 3 chip (与全局 Requirements.vue 同款).
    void refreshAggregatesFor(out.items);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('requirements.version.reqs.errHttp', { n: e.status });
    } else if (e instanceof Error) {
      error.value = t('requirements.version.reqs.errNetwork', { msg: e.message });
    } else {
      error.value = t('requirements.version.reqs.errGeneric');
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

async function loadAllVersions(): Promise<void> {
  try {
    const resp = await listVersions();
    const map: Record<string, string> = {};
    for (const v of resp.versions ?? []) map[v.id] = v.name;
    versionNameById.value = map;
  } catch {
    versionNameById.value = {};
  }
}

async function loadContextMeta(): Promise<void> {
  // 项目 + 版本元数据独立 fetch; 任一失败仅降级 (顶部条显示 id), 不阻断列表.
  const [proj, ver] = await Promise.all([
    getProjectById(projectId.value),
    getVersionById(versionId.value),
  ]);
  projectMeta.value = proj
    ? { id: proj.id, name: proj.name, current_version_id: proj.current_version_id ?? null }
    : null;
  versionMeta.value = ver ? { id: ver.id, name: ver.name } : null;
}

async function refreshRevisionsFor(rows: Requirement[]): Promise<void> {
  const pending = rows.filter((r) => !(r.id in latestRevisionById));
  if (pending.length === 0) return;
  await Promise.all(
    pending.map(async (r) => {
      try {
        const revs = await listRequirementRevisions(r.id, { limit: 1 });
        latestRevisionById[r.id] = revs[0] ?? null;
      } catch {
        latestRevisionById[r.id] = null;
      }
    }),
  );
}

/** R74 W3: aggregates 批量拉 (与全局 Requirements.vue 同款). */
async function refreshAggregatesFor(rows: Requirement[]): Promise<void> {
  const pending = rows.filter((r) => !(r.id in aggregatesById));
  if (pending.length === 0) return;
  await Promise.all(
    pending.map(async (r) => {
      try {
        aggregatesById[r.id] = await getRequirementAggregates(r.id);
      } catch {
        // 失败静默 = 父级 v-if 不渲染 chip.
      }
    }),
  );
}

onMounted(() => {
  void projects.load();
  void loadAllVersions();
  void loadContextMeta();
  void refresh();
});

/* ------------------------------------------------------------------ */
/*  URL 联动 (R87 跟进: chip 切 status 保留 version 上下文)                */
/* ------------------------------------------------------------------ */

watch(
  () => [projectId.value, versionId.value, isCleared.value],
  () => {
    currentPage.value = 1;
    void refresh();
  },
);

watch([currentPage, pageSize], () => {
  void refresh();
});

/** chip 切 status → router.push 改 query, 不丢 path + clear 标记. */
function onChipClick(s: '' | RequirementStatus): void {
  const next = s || null;
  router.push({ query: next ? { status: next } : {} });
}

/* ------------------------------------------------------------------ */
/*  Modal — create / edit                                               */
/* ------------------------------------------------------------------ */

function openCreate(): void {
  modal.isEditing = false;
  modal.targetId = null;
  modal.form = emptyForm(versionId.value);
  modal.submitting = false;
  modal.open = true;
}

function openEdit(r: Requirement): void {
  modal.isEditing = true;
  modal.targetId = r.id;
  modal.form = {
    title: r.title,
    description: r.description ?? '',
    status: r.status,
    priority: r.priority !== null ? String(r.priority) : '',
    tags: parseRequirementTags(r.tags).join(', '),
    // 编辑时不改 version_id — version 是路径锁定上下文, master PATCH 白名单
    // 也允许改 version_id, 但产品语义上「跨版本迁移」是显式操作, 这里保守锁死.
    version_id: r.version_id ?? '',
  };
  modal.submitting = false;
  modal.open = true;
}

function closeModal(): void {
  if (modal.submitting) return;
  modal.open = false;
  modal.targetId = null;
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePriorityInput(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

async function submitModal(): Promise<void> {
  const title = modal.form.title.trim();
  if (!title) {
    toast.error(t('requirements.version.reqs.errTitleRequired'));
    return;
  }
  const priorityNum = parsePriorityInput(modal.form.priority);
  if (
    modal.form.priority.trim() &&
    (priorityNum === null || priorityNum < 1 || priorityNum > 5)
  ) {
    toast.error(t('requirements.version.reqs.errPriorityRange'));
    return;
  }

  modal.submitting = true;
  try {
    if (modal.isEditing && modal.targetId) {
      const tagsArray = parseTagsInput(modal.form.tags);
      const body: UpdateRequirementBody = {
        title,
        description: modal.form.description.trim() || null,
        status: modal.form.status,
        priority: priorityNum,
        tags: tagsArray,
      };
      const updated = await updateRequirement(modal.targetId, body);
      const idx = items.value.findIndex((r) => r.id === updated.id);
      if (idx >= 0) items.value[idx] = updated;
      delete latestRevisionById[updated.id];
      void refreshRevisionsFor([updated]);
      toast.success(t('requirements.version.reqs.saved'));
      closeModal();
    } else {
      const tagsArray = parseTagsInput(modal.form.tags);
      const body: CreateRequirementBody = {
        project_id: projectId.value,
        version_id: versionId.value,
        title,
        ...(modal.form.description.trim() ? { description: modal.form.description.trim() } : {}),
        ...(priorityNum !== null ? { priority: priorityNum } : {}),
        ...(tagsArray.length ? { tags: tagsArray } : {}),
      };
      const created = await createRequirement(body);
      if (statusFilter.value && statusFilter.value !== created.status) {
        await refresh();
      } else {
        items.value = [created, ...items.value];
        total.value += 1;
      }
      toast.success(t('requirements.version.reqs.created'));
      closeModal();
    }
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('requirements.version.reqs.saveErrHttp', { n: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('requirements.version.reqs.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('requirements.version.reqs.saveFailed'));
    }
  } finally {
    modal.submitting = false;
  }
}

/* ------------------------------------------------------------------ */
/*  删除                                                                */
/* ------------------------------------------------------------------ */

function askDelete(r: Requirement): void {
  pendingDelete.value = r;
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    await deleteRequirement(target.id);
    await refresh();
    toast.success(t('requirements.version.reqs.closedToast'));
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('requirements.version.reqs.deleteErrHttp', { n: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('requirements.version.reqs.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('requirements.version.reqs.deleteFailed'));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  渲染辅助                                                            */
/* ------------------------------------------------------------------ */

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
    // i18n: 本地化格式随当前 locale (zh-CN / en-US).
    return parseDbTime(iso)?.toLocaleString(locale.value, { hour12: false }) ?? iso;
  } catch {
    return iso;
  }
}

function statusLabel(s: RequirementStatus): string {
  return STATUS_LABEL.value[s];
}

function projectDisplay(r: Requirement): string {
  return projectName.value || `#${r.project_id.slice(-8)}`;
}

function versionDisplay(r: Requirement): { text: string; cls: string } {
  if (!r.version_id) return { text: t('requirements.version.reqs.noVersion'), cls: 'badge-version-none' };
  const name = versionNameById.value[r.version_id];
  if (name) return { text: `v·${name}`, cls: 'badge-version-set' };
  return { text: t('requirements.version.reqs.hasVersion'), cls: 'badge-version-set' };
}

function rowLatestRevision(r: Requirement): RequirementRevision | null {
  return latestRevisionById[r.id] ?? null;
}

function revisionChipText(rev: RequirementRevision): string {
  return `${ACTOR_LABEL.value[rev.actor_type]}·${FIELD_LABEL.value[rev.field] ?? rev.field}`;
}

/** 时间胶囊 hover title (i18n 插值, 替代模板内模板字符串拼中文). */
function revisionChipTitle(rev: RequirementRevision): string {
  return t('requirements.version.reqs.revChipTitle', {
    actor: ACTOR_LABEL.value[rev.actor_type],
    field: FIELD_LABEL.value[rev.field] ?? rev.field,
    time: fmt(rev.created_at),
  });
}

function revisionChipStyle(rev: RequirementRevision): Record<string, string> {
  const c = ACTOR_COLOR[rev.actor_type];
  return { backgroundColor: c.bg, color: c.color, borderColor: c.border };
}

function rowTags(r: Requirement): string[] {
  return parseRequirementTags(r.tags);
}

function isStatusActive(s: '' | RequirementStatus): boolean {
  return statusFilter.value === s;
}

function statusChipStyle(s: RequirementStatus): Record<string, string> {
  const map: Record<RequirementStatus, { bg: string; color: string }> = {
    pending: { bg: 'var(--tw-gray-100)', color: 'var(--tw-gray-700)' },
    done: { bg: 'var(--tw-green-100)', color: 'var(--tw-green-700)' },
    awaiting_reply: { bg: 'var(--tw-blue-100)', color: 'var(--tw-blue-700)' },
    has_suggestion: { bg: 'var(--tw-purple-100)', color: 'var(--tw-purple-700)' },
    blocked: { bg: 'var(--tw-orange-200)', color: 'var(--tw-orange-800)' },
    closed: { bg: 'var(--tw-gray-200)', color: 'var(--tw-gray-500)' },
  };
  return { backgroundColor: map[s].bg, color: map[s].color };
}
</script>

<template>
  <div class="version-requirements-page">
    <!-- 顶部条 — 1:1 镜像 master topBar: 面包屑 + 4 个操作按钮 -->
    <div class="version-top-bar">
      <div class="breadcrumb">
        <a
          :href="projectLink"
          class="project-link"
          :title="projectName"
        >
          {{ projectName }}
        </a>
        <span class="sep">/</span>
        <span class="version-name" :title="versionName">{{ versionName }}</span>
        <span class="view-mode">· {{ t('requirements.version.reqs.currentView', { mode: viewModeLabel }) }}</span>
      </div>
      <div class="actions">
        <a
          v-if="!isCleared"
          :href="clearToggleHref"
          class="action-btn action-btn-action"
          :title="t('requirements.version.reqs.clearVersionTitle')"
        >
          {{ t('requirements.version.reqs.clearVersion') }}
        </a>
        <a
          v-else
          :href="clearToggleHref"
          class="action-btn action-btn-primary"
          :title="t('requirements.version.reqs.restoreVersionTitle')"
        >
          {{ t('requirements.version.reqs.restoreVersion') }}
        </a>
        <a
          :href="resetHref"
          class="action-btn action-btn-action"
          :title="t('requirements.version.reqs.resetTitle')"
        >
          {{ t('requirements.version.reqs.reset') }}
        </a>
        <a
          :href="totalEntryHref"
          class="action-btn action-btn-action"
          :title="t('requirements.version.reqs.totalEntryTitle')"
        >
          {{ t('requirements.version.reqs.totalEntry') }}
        </a>
      </div>
    </div>

    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('requirements.version.reqs.title') }}</h1>
        <p class="page-subtitle">
          {{ isCleared
            ? t('requirements.version.reqs.subtitleCleared', { name: projectName })
            : t('requirements.version.reqs.subtitleVersion', { p: projectName, v: versionName }) }}
        </p>
      </div>
      <div class="header-actions">
        <Button variant="primary" size="sm" @click="openCreate">
          + {{ t('requirements.version.reqs.newBtn') }}
        </Button>
      </div>
    </header>

    <!-- Status filter chips (与 master buildFilterHref 行为对齐) -->
    <div class="filter-bar">
      <button
        v-for="opt in STATUS_FILTER_OPTIONS"
        :key="opt.value"
        type="button"
        :class="['chip', isStatusActive(opt.value) ? 'chip-active' : 'chip-default']"
        @click="onChipClick(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>

    <!-- Body -->
    <div class="page-body">
      <div v-if="loading && items.length === 0" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">{{ t('requirements.version.reqs.loading') }}</p>
      </div>

      <ErrorView
        v-else-if="error"
        :title="t('requirements.version.reqs.loadFailedTitle')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <Empty
        v-else-if="items.length === 0"
        :title="statusFilter
          ? t('requirements.version.reqs.emptyStatus')
          : (isCleared ? t('requirements.version.reqs.emptyProject') : t('requirements.version.reqs.emptyVersion'))"
        :description="statusFilter
          ? t('requirements.version.reqs.emptyStatusDesc')
          : t('requirements.version.reqs.emptyDesc')"
        illustration="inbox"
      />

      <div v-else class="list-block">
        <article
          v-for="r in items"
          :key="r.id"
          class="row-card"
          @click="openEdit(r)"
          role="button"
          tabindex="0"
          @keydown.enter="openEdit(r)"
        >
          <div class="row-main">
            <div class="row-left">
              <div class="row-title">{{ r.title }}</div>
              <div v-if="r.description" class="row-desc">
                {{ r.description }}
              </div>
              <div class="row-meta">
                <span class="badge badge-project">{{ projectDisplay(r) }}</span>
                <span :class="['badge', versionDisplay(r).cls]">
                  {{ versionDisplay(r).text }}
                </span>
                <span
                  v-for="t in rowTags(r)"
                  :key="t"
                  class="badge badge-tag"
                >
                  #{{ t }}
                </span>
                <span class="meta-time">{{ fmt(r.created_at) }}</span>
                <span v-if="r.priority !== null" class="meta-priority">
                  · P{{ r.priority }}
                </span>
                <span
                  v-if="rowLatestRevision(r)"
                  class="rev-chip"
                  :style="revisionChipStyle(rowLatestRevision(r)!)"
                  :title="revisionChipTitle(rowLatestRevision(r)!)"
                >
                  <span>{{ ACTOR_LABEL[rowLatestRevision(r)!.actor_type] }}</span>
                  <span class="rev-dot">·</span>
                  <span>{{ FIELD_LABEL[rowLatestRevision(r)!.field] ?? rowLatestRevision(r)!.field }}</span>
                </span>
                <!-- R74 W3: aggregates 3 chip (📋N / 📈X% / 💬feedback). -->
                <AggregatesChips
                  v-if="aggregatesById[r.id]"
                  :aggregates="aggregatesById[r.id]"
                />
              </div>
            </div>
            <span class="status-chip" :style="statusChipStyle(r.status)">
              {{ statusLabel(r.status) }}
            </span>
            <button
              type="button"
              class="row-delete"
              :title="t('requirements.version.reqs.deleteTitle')"
              :aria-label="t('requirements.version.reqs.deleteAria')"
              @click.stop="askDelete(r)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </article>

        <Pagination
          v-if="total > 0"
          v-model="currentPage"
          v-model:page-size="pageSize"
          :total="total"
        />
      </div>
    </div>

    <!-- Create / Edit Modal -->
    <Modal
      :model-value="modal.open"
      :title="modal.isEditing ? t('requirements.version.reqs.editTitle') : t('requirements.version.reqs.createTitle')"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeModal(); }"
    >
      <div class="form">
        <div v-if="!modal.isEditing" class="form-row">
          <label class="form-label">{{ t('requirements.version.reqs.fieldOwnership') }}</label>
          <div class="locked-context">
            <span class="badge badge-project">{{ projectName }}</span>
            <span class="badge badge-version-set">v·{{ versionName }}</span>
          </div>
          <p class="form-hint">
            {{ t('requirements.version.reqs.ownershipHint', { p: projectName, v: versionName }) }}
          </p>
        </div>

        <div class="form-row">
          <label class="form-label">
            {{ t('requirements.field.title') }} <span class="required">*</span>
          </label>
          <Input
            v-model="modal.form.title"
            :placeholder="t('requirements.version.reqs.titlePlaceholder')"
            :disabled="modal.submitting"
          />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('requirements.field.description') }}</label>
          <Textarea
            v-model="modal.form.description"
            :rows="3"
            :placeholder="t('requirements.version.reqs.descPlaceholder')"
            :disabled="modal.submitting"
          />
        </div>

        <div class="form-grid">
          <div class="form-row">
            <label class="form-label">{{ t('requirements.field.status') }}</label>
            <Select
              v-model="modal.form.status"
              :options="REQUIREMENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))"
              :disabled="modal.submitting"
            />
            <p class="form-hint">
              {{ t('requirements.version.reqs.statusHint') }}
            </p>
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('requirements.field.priority') }}</label>
            <Select
              v-model="modal.form.priority"
              :options="priorityOptions"
              :disabled="modal.submitting"
            />
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('requirements.field.tags') }}</label>
          <Input
            v-model="modal.form.tags"
            :placeholder="t('requirements.version.reqs.tagsPlaceholder')"
            :disabled="modal.submitting"
          />
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" :disabled="modal.submitting" @click="closeModal">
          {{ t('requirements.version.reqs.cancel') }}
        </Button>
        <Button :loading="modal.submitting" :disabled="modal.submitting" @click="submitModal">
          {{ modal.isEditing ? t('requirements.version.reqs.saveChanges') : t('requirements.version.reqs.createBtn') }}
        </Button>
      </template>
    </Modal>

    <!-- Delete confirm -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="t('requirements.version.reqs.confirmTitle')"
      :message="pendingDelete
        ? t('requirements.version.reqs.confirmMessage', { title: pendingDelete.title })
        : ''"
      :confirm-text="t('requirements.version.reqs.confirmClose')"
      :cancel-text="t('requirements.version.reqs.cancel')"
      type="danger"
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.version-requirements-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

/* ------------------------------------------------------------------ */
/*  顶部条 (master topBar 1:1 镜像)                                       */
/* ------------------------------------------------------------------ */
.version-top-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: var(--tw-blue-50);
  border-bottom: 1px solid var(--tw-blue-100);
  font-size: 13px;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--color-text-muted);
}
.project-link {
  color: var(--tw-blue-700);
  text-decoration: none;
  font-weight: 500;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-link:hover { text-decoration: underline; }
.sep { color: var(--tw-gray-400); }
.version-name {
  color: var(--color-text);
  font-weight: 500;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.view-mode {
  color: var(--tw-gray-500);
  font-size: 11px;
}
.actions {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.action-btn {
  display: inline-block;
  padding: 4px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  text-decoration: none;
  border: 1px solid var(--tw-gray-300);
  background: var(--color-bg-elevated);
  color: var(--color-text);
  transition: background 0.15s, border-color 0.15s;
}
.action-btn:hover { background: var(--tw-gray-100); }
.action-btn-action { color: var(--tw-gray-700); }
.action-btn-primary {
  color: var(--tw-blue-700);
  border-color: var(--tw-blue-300);
  background: var(--color-bg-elevated);
}
.action-btn-primary:hover { background: var(--tw-blue-50); }

/* ------------------------------------------------------------------ */
/*  Header                                                              */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/*  Filter bar                                                          */
/* ------------------------------------------------------------------ */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.chip {
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.chip-default:hover {
  background: var(--tw-blue-50);
  border-color: var(--tw-blue-300);
}
.chip-active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

/* ------------------------------------------------------------------ */
/*  Body                                                                */
/* ------------------------------------------------------------------ */
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
.loading-text { margin: 0; font-size: 14px; }

/* ------------------------------------------------------------------ */
/*  List rows                                                          */
/* ------------------------------------------------------------------ */
.list-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 960px;
}
.row-card {
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.row-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}
.row-card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.row-main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.row-left { flex: 1; min-width: 0; }
.row-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-desc {
  margin-top: 4px;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.row-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.meta-time { font-variant-numeric: tabular-nums; }
.meta-priority { color: var(--color-primary); font-weight: 500; }

/* Badges */
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.badge-project {
  background: var(--color-bg);
  color: var(--color-text-muted);
}
.badge-version-set { background: var(--tw-green-100); color: var(--tw-green-800); }
.badge-version-none { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.badge-tag { background: var(--tw-blue-50); color: var(--tw-blue-700); }

/* Status chip (inline style from statusChipStyle()) */
.status-chip {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

/* R63 时间胶囊 chip — 与 master RevisionBadge 等价 */
.rev-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid;
  font-size: 10px;
  line-height: 1.4;
  white-space: nowrap;
}
.rev-dot {
  opacity: 0.55;
  padding: 0 1px;
}

/* Row delete button */
.row-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--tw-gray-300);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}
.row-delete:hover {
  color: var(--tw-red-600);
  background: var(--tw-red-50);
}

/* ------------------------------------------------------------------ */
/*  Form                                                                */
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
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
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
.locked-context {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 8px 0;
}
</style>