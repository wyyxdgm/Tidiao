<script setup lang="ts">
/* 功能: Requirements 需求点管理视图 — 对应 Next src/app/requirements/page.tsx +
   src/components/RequirementsListView.tsx. R28 字面要求 = GET /api/requirements 列表
   + 状态筛选 + 创建/编辑. R14 (vault) 加强: 接 R107 + R63 时间胶囊 + version 名
   显示三处 master 直镜像, 复用现有 REST 端点不开新 endpoint.

   关注点 (sheet R28 + R14 vault + 与现实分歧):
   - 列表基础 5 件套 + 3 件镜像增强 = status 过滤 + title + project / version 名
     (R14 vault) + tags + status chip + latest revision badge (R14 vault) + 聚合
     3 chip (R74 W3 / G4 收口, master RequirementsListView:313-343 1:1 镜像).
   - Version 名 (master 用 "v·VersionName", R28 旧版只 "已挂版本/未挂版本"): 复用
     R23 已落地的 listVersions() (不传 project_id = 全部 versions), 一次性预取
     versionNameById map, 行内直接查. 与 Next RequirementsListView 预取所有
     versions 同款语义, 不引新 API.
   - Latest revision badge (master RevisionBadge): 行内展示 "AI·状态" / "人·标题"
     之类的小 chip, 复用现有 GET /api/requirements/[id]/revisions?limit=1 端点.
     N+1 (每行一次轻量 fetch) 但 payload < 1KB, 总 < 20KB / 页 = 可接受. 行内
     revisionsById ref map 缓存, refresh / create / edit 后批量刷新.
   - Aggregates 3 chip (R74 W3): 📋 N / 📈 X% (绿/橙/红染色) / 💬 feedback. 后端
     走 GET /api/requirements/[id]/aggregates 单条路径 (R142 G4). 同样 N+1 拉每行
     (<200B, 20 行/页 <4KB, 与 revision 同款批量 Promise.all). 行内
     aggregatesById ref map 缓存, refresh 后批量补齐. 未加载 = 不渲染 chip
     (与 revision 同款兜底).
   - Version 名 (master 用 "v·VersionName", R28 旧版只 "已挂版本/未挂版本"): 复用
     R23 已落地的 listVersions() (不传 project_id = 全部 versions), 一次性预取
     versionNameById map, 行内直接查. 与 Next RequirementsListView 预取所有
     versions 同款语义, 不引新 API.
   - Latest revision badge (master RevisionBadge): 行内展示 "AI·状态" / "人·标题"
     之类的小 chip, 复用现有 GET /api/requirements/[id]/revisions?limit=1 端点.
     N+1 (每行一次轻量 fetch) 但 payload < 1KB, 总 < 20KB / 页 = 可接受. 行内
     revisionsById ref map 缓存, refresh / create / edit 后批量刷新.
   - 状态过滤 chip 走 buildStatusHref 局部状态 (chip 切换 = 重新调 list, 不持久化
     URL). 与 Next buildFilterHref 行为对齐, 但不走 URL (SPA 无 SSR URL 强制约束,
     局部状态即可). 切 status 回到第 1 页 (与 Next page 故意不传同款).
   - "+ 新建需求" → 创建 modal: project_id 必填 (后端强校验), title 必填, 其余可选.
     创建前先用 useProjectsStore (R14 已就位) 拉项目选项, 失败退化空列表 (与 R24
     LLM 配置退化同款).
   - "编辑" → 编辑 modal: 复用同一 Modal + 区分 isEditing. 后端 PATCH 白名单 = title
     / description / status / priority / tags / version_id. 编辑 mode 预填所有字段;
     PATCH 仅发改动过的字段 (后端按字段存在与否决定覆盖), 本 view 简化 = 编辑时
     全字段回传 (与 R24 templates.ts UpdateTemplateBody 语义同款).
   - status='done' 提交: 后端 R78 W1 §4.3 invariant = 必须有 ≥1 个 dev/test/deploy
     task completed. 未满足会 400 + code=REQUIREMENT_DONE_GUARD; 走 toast.error
     暴露 message, 不前端阻断 (与 Next 端同样把 invariant 校验后端化).
   - 软删除走 R6 ConfirmDialog: 后端 DELETE 走 status='closed', 列表依然显示
     (后端默认含 closed), UI 切回所有 status 时能看到 "已关闭" 行; 不在 UI 端
     隐藏, 与 Next 一致.
   - 分页: R12 Pagination (v-model=currentPage + pageSize/total). 默认 pageSize=20,
     切换 pageSize 自动回 page=1 (R12 内置).
   - 不挂 SSE/事件流 (M3+ 范畴). 不接「从此需求点派任务」跳转 (后续 task). */

import { computed, onMounted, reactive, ref, watch } from 'vue';
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
import { listVersions } from '@/api/projects';
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

// i18n (W3c): 用户可见字符串走 t('requirements.*'), 文案源
//   spa/src/i18n/locales/{zh-CN,en-US}/requirements.json; 协议常量
//   (status 枚举值 / 颜色 class / actor 类型) 不迁移.
const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  常量                                                                */
/* ------------------------------------------------------------------ */

/** 状态展示文案 — 走 i18n requirements.status.* (公共 key, 主控预置).
    原模块级 STATUS_LABEL 常量非响应式, 改函数保证语言切换实时生效. */
function statusLabel(s: RequirementStatus): string {
  return t(`requirements.status.${s}`);
}

/** 状态 chip 颜色 — 与 Next STATUS_COLOR 对齐 (Tailwind 调色板 → hex 等价色). */
const STATUS_COLOR: Record<RequirementStatus, string> = {
  pending: 'bg-gray-100 text-gray-700',
  done: 'bg-green-100 text-green-700',
  awaiting_reply: 'bg-blue-100 text-blue-700',
  has_suggestion: 'bg-purple-100 text-purple-700',
  blocked: 'bg-orange-100 text-orange-700',
  closed: 'bg-gray-200 text-gray-500',
};

/** 状态过滤 chip 的可选值 (额外加 '' 表示「全部」) — computed 走 t(), 语言切换实时生效. */
const statusFilterOptions = computed<{ value: '' | RequirementStatus; label: string }[]>(() => [
  { value: '', label: t('requirements.list.filterAll') },
  ...REQUIREMENT_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
]);

/** 编辑 modal 状态下拉选项 — computed 走 t(). */
const statusOptions = computed<{ value: RequirementStatus; label: string }[]>(() =>
  REQUIREMENT_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
);

/* ------------------------------------------------------------------ */
/*  R107 / R63 时间胶囊常量 — 1:1 对齐 master RequirementsListView    */
/* ------------------------------------------------------------------ */

/** 变更执行者视觉 — 与 master ACTOR_COLOR 同款 (Tailwind 调色板 → 等价 hex). */
const ACTOR_COLOR: Record<ActorType, { bg: string; color: string; border: string }> = {
  agent: { bg: 'var(--tw-purple-50)', color: 'var(--tw-purple-700)', border: 'var(--tw-purple-200)' },
  user: { bg: 'var(--tw-blue-50)', color: 'var(--tw-blue-700)', border: 'var(--tw-blue-200)' },
  system: { bg: 'var(--tw-gray-50)', color: 'var(--tw-gray-600)', border: 'var(--tw-gray-200)' },
};
/** 变更执行者显示文案 — 走 i18n requirements.actor.* (公共 key, 主控预置). */
function actorLabel(a: ActorType): string {
  return t(`requirements.actor.${a}`);
}
/** 字段显示文案 — 白名单映射到 i18n requirements.field.* (title/description/status/
    priority/tags/version_id). 未知字段 = 原 key (与 Next 端保持兜底展示). */
const FIELD_KEY_MAP: Record<string, string> = {
  title: 'requirements.field.title',
  description: 'requirements.field.description',
  status: 'requirements.field.status',
  priority: 'requirements.field.priority',
  tags: 'requirements.field.tags',
  version_id: 'requirements.field.version_id',
};
function fieldLabel(f: string): string {
  const key = FIELD_KEY_MAP[f];
  return key ? t(key) : f;
}

/* ------------------------------------------------------------------ */
/*  类型                                                                */
/* ------------------------------------------------------------------ */

interface FormState {
  project_id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  priority: string; // '' = 无, 否则 1-5
  tags: string;
  version_id: string; // '' = 不挂版本 (POST 时不传 version_id, 后端走默认; PATCH 时显式 null = 不挂)
}

interface ModalState {
  open: boolean;
  isEditing: boolean;
  targetId: string | null;
  form: FormState;
  submitting: boolean;
}

function emptyForm(): FormState {
  return {
    project_id: '',
    title: '',
    description: '',
    status: 'pending',
    priority: '',
    tags: '',
    version_id: '',
  };
}

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

const statusFilter = ref<'' | RequirementStatus>('');
const currentPage = ref<number>(1);
const pageSize = ref<number>(20);

const modal = reactive<ModalState>({
  open: false,
  isEditing: false,
  targetId: null,
  form: emptyForm(),
  submitting: false,
});

const pendingDelete = ref<Requirement | null>(null);

/** Modal 内「project 选项联动 = 拉该 project 的 version list」缓存 — 不污染 store.
    当 Modal 切换 project_id 时按需拉一次. */
const versionCache = reactive<Record<string, { id: string; name: string }[]>>({});
const versionsLoading = ref<boolean>(false);

/** R107 列表行增强: 全局 versionNameById — 与 Next master 预取所有 versions 同款.
    onMounted 一次性拉 listVersions() (无 project_id = 全部 versions) → id → name.
    行内显示 "v·VersionName" 而不是 R28 旧版的 "已挂版本/未挂版本". */
const versionNameById = ref<Record<string, string>>({});

/** R63 时间胶囊: 每行 1 条最新 revision 缓存. id → RequirementRevision | null
    (null = 拉过确认无 revision, 避免重复请求). 拉新批 items 时调用
    refreshRevisionsFor(items) 批量补齐. */
const latestRevisionById = reactive<Record<string, RequirementRevision | null>>({});

/** R74 W3: 每行 aggregates 缓存 (📋N / 📈X% / 💬feedback 三 chip 数据源).
    id → RequirementAggregates. 没值 = 未加载, 父级 v-if 不渲染 chip.
    拉新批 items 时调用 refreshAggregatesFor(items) 批量补齐. */
const aggregatesById = reactive<Record<string, RequirementAggregates>>({});

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** project id → name map — 列表渲染 project badge 用. */
const projectNameById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const p of projects.projects) out[p.id] = p.name;
  return out;
});

/** 当前选中 project 的 version 列表 — 编辑表单下拉用. */
const currentVersions = computed<{ value: string; label: string }[]>(() => {
  const pid = modal.form.project_id;
  const list = pid ? versionCache[pid] ?? [] : [];
  return [
    { value: '', label: t('requirements.list.versionNoneForced') },
    ...list.map((v) => ({ value: v.id, label: v.name })),
  ];
});

const projectOptions = computed<{ value: string; label: string }[]>(() =>
  projects.projects.map((p) => ({ value: p.id, label: p.name })),
);

const priorityOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('requirements.list.priorityNone') },
  { value: '1', label: 'P1' },
  { value: '2', label: 'P2' },
  { value: '3', label: 'P3' },
  { value: '4', label: 'P4' },
  { value: '5', label: 'P5' },
]);

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

/** 拉一次列表 — statusFilter / currentPage / pageSize 任一变化触发. */
async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const out = await listRequirements({
      status: statusFilter.value || undefined,
      page: currentPage.value,
      page_size: pageSize.value,
    });
    items.value = out.items;
    total.value = out.total;
    // R63 时间胶囊: 列表回来后并行拉每行最新 revision (缓存命中跳过).
    void refreshRevisionsFor(out.items);
    // R74 W3: 同款 N+1 拉每行 aggregates (payload < 200B, 20 行/页 = <4KB, 可接受).
    void refreshAggregatesFor(out.items);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('requirements.list.errHttp', { status: e.status });
    } else if (e instanceof Error) {
      error.value = t('requirements.list.errNetwork', { msg: e.message });
    } else {
      error.value = t('requirements.list.errGeneric');
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

/** 拉选中 project 的 version 列表 (modal 内 version 下拉选项用). */
async function loadVersionsIfNeeded(projectId: string): Promise<void> {
  if (!projectId || versionCache[projectId]) return;
  versionsLoading.value = true;
  try {
    const { listVersions } = await import('@/api/projects');
    const resp = await listVersions(projectId);
    versionCache[projectId] = (resp.versions ?? []).map((v) => ({
      id: v.id,
      name: v.name,
    }));
  } catch {
    versionCache[projectId] = [];
  } finally {
    versionsLoading.value = false;
  }
}

onMounted(() => {
  void projects.load();
  void refresh();
  void loadAllVersions();
});

/** R107 一次性预取所有 versions → versionNameById map. 失败静默, 行 fallback
    回 R28 旧版 "已挂版本/未挂版本". 与 master listVersions(undefined, userId)
    行为对齐. */
async function loadAllVersions(): Promise<void> {
  try {
    const resp = await listVersions();
    const map: Record<string, string> = {};
    for (const v of resp.versions ?? []) map[v.id] = v.name;
    versionNameById.value = map;
  } catch {
    // 静默失败 → versionNameById 空, versionDisplay fallback.
    versionNameById.value = {};
  }
}

/** R63 时间胶囊: 批量拉 rows 的最新 1 条 revision (limit=1). 已 cache 过的
    (含 null = 拉过无 revision) 跳过, 避免重复请求. 失败静默, 缺数据 = 不显示
    badge (与 Next 端 v !== undefined 等价: 没数据 = 不渲染). */
async function refreshRevisionsFor(rows: Requirement[]): Promise<void> {
  const pending = rows.filter((r) => !(r.id in latestRevisionById));
  if (pending.length === 0) return;
  await Promise.all(
    pending.map(async (r) => {
      try {
        const revs = await listRequirementRevisions(r.id, { limit: 1 });
        latestRevisionById[r.id] = revs[0] ?? null;
      } catch {
        // 401/404/网络错误 = 标记 null 不重试 (避免死循环); 行内不显示 badge.
        latestRevisionById[r.id] = null;
      }
    }),
  );
}

/** R74 W3: 批量拉 rows 的 aggregates. 已 cache 过的跳过, 失败静默 (与 R63 revision
    同款: 失败 = 不重试不阻断, 缺数据 = 父级 v-if 不渲染 chip). */
async function refreshAggregatesFor(rows: Requirement[]): Promise<void> {
  const pending = rows.filter((r) => !(r.id in aggregatesById));
  if (pending.length === 0) return;
  await Promise.all(
    pending.map(async (r) => {
      try {
        aggregatesById[r.id] = await getRequirementAggregates(r.id);
      } catch {
        // 失败留空 = 父级 v-if 不渲染, 与 R63 revision 静默处理一致.
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/*  Filter / pagination 联动                                            */
/* ------------------------------------------------------------------ */

watch(statusFilter, () => {
  currentPage.value = 1;
  void refresh();
});

watch([currentPage, pageSize], () => {
  void refresh();
});

/** 监听 modal project 切换 → 拉对应 versions + 重置 version_id. */
watch(
  () => modal.form.project_id,
  (next) => {
    modal.form.version_id = '';
    if (next) void loadVersionsIfNeeded(next);
  },
);

/* ------------------------------------------------------------------ */
/*  Modal — create / edit                                               */
/* ------------------------------------------------------------------ */

function openCreate(): void {
  modal.isEditing = false;
  modal.targetId = null;
  modal.form = emptyForm();
  // 默认选第一个 project (有的话) — 减少点击. 没拉到项目 = 留空让用户必选.
  if (projects.projects.length > 0) {
    modal.form.project_id = projects.projects[0].id;
  }
  modal.submitting = false;
  modal.open = true;
}

function openEdit(r: Requirement): void {
  modal.isEditing = true;
  modal.targetId = r.id;
  modal.form = {
    project_id: r.project_id,
    title: r.title,
    description: r.description ?? '',
    status: r.status,
    priority: r.priority !== null ? String(r.priority) : '',
    tags: parseRequirementTags(r.tags).join(', '),
    version_id: r.version_id ?? '',
  };
  modal.submitting = false;
  modal.open = true;
  // 异步拉 version 列表 (modal 不阻塞 UI).
  void loadVersionsIfNeeded(r.project_id);
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

function parsePriorityInput(raw: string): number | null {
  if (!raw.trim()) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

async function submitModal(): Promise<void> {
  const projectId = modal.form.project_id;
  const title = modal.form.title.trim();
  if (!projectId) {
    toast.error(t('requirements.list.errProjectRequired'));
    return;
  }
  if (!title) {
    toast.error(t('requirements.list.errTitleRequired'));
    return;
  }
  const priorityNum = parsePriorityInput(modal.form.priority);
  if (
    modal.form.priority.trim() &&
    (priorityNum === null || priorityNum < 1 || priorityNum > 5)
  ) {
    toast.error(t('requirements.list.errPriorityRange'));
    return;
  }

  modal.submitting = true;
  try {
    if (modal.isEditing && modal.targetId) {
      // 编辑 — PATCH; version_id 字段特殊: '' = 显式置空 (跨版本迁移), 其他 = 字符串.
      // tags 数组可能为空 (后端接受空数组, 落 null 也行).
      const tagsArray = parseTagsInput(modal.form.tags);
      const body: UpdateRequirementBody = {
        title,
        description: modal.form.description.trim() || null,
        status: modal.form.status,
        priority: priorityNum,
        tags: tagsArray,
        version_id: modal.form.version_id === '' ? null : modal.form.version_id,
      };
      const updated = await updateRequirement(modal.targetId, body);
      // 本地替换, 不重拉整页.
      const idx = items.value.findIndex((r) => r.id === updated.id);
      if (idx >= 0) items.value[idx] = updated;
      // R63 时间胶囊: 刚编辑的 row 强制刷一次 (删除 cache → refreshRevisionsFor 重新拉).
      delete latestRevisionById[updated.id];
      void refreshRevisionsFor([updated]);
      toast.success(t('requirements.list.saved'));
      closeModal();
    } else {
      // 创建 — POST; description/priority/tags/version_id 空 = 不传 (后端默认 null).
      const tagsArray = parseTagsInput(modal.form.tags);
      const body: CreateRequirementBody = {
        project_id: projectId,
        title,
        ...(modal.form.description.trim() ? { description: modal.form.description.trim() } : {}),
        ...(priorityNum !== null ? { priority: priorityNum } : {}),
        ...(tagsArray.length ? { tags: tagsArray } : {}),
      };
      // version_id: 创建时 '' = 不传 (后端兜底到 current_version_id); 字符串 = 显式挂.
      if (modal.form.version_id) {
        body.version_id = modal.form.version_id;
      }
      const created = await createRequirement(body);
      // 创建后 = 直接显示在列表头部, 但若 statusFilter 不匹配 (例: 创建 pending 但 filter=done)
      // 不强行重拉 — 与 Next 「创建后停在表单不动」行为不同, SPA 主动刷新列表以保持一致.
      if (
        statusFilter.value &&
        statusFilter.value !== created.status
      ) {
        // 不匹配 filter = 列表里看不到, 但 total 计数会变; 走轻量 refresh (保留 page).
        await refresh();
      } else {
        items.value = [created, ...items.value];
        total.value += 1;
      }
      toast.success(t('requirements.list.created'));
      closeModal();
    }
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('requirements.list.saveErrHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('requirements.list.saveErrNetwork', { msg: e.message }));
    } else {
      toast.error(t('requirements.list.saveErrGeneric'));
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
    // 后端软删 = status='closed'; 默认还在列表里. 仅当 statusFilter === 'closed'
    // 才显示, 否则维持列表可见 (与 Next 一致).
    // 强制刷新拿最新 status, 因为本地状态可能与后端实际 status 不同 (filter 切换等).
    await refresh();
    toast.success(t('requirements.list.closedToast'));
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('requirements.list.deleteErrHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('requirements.list.deleteErrNetwork', { msg: e.message }));
    } else {
      toast.error(t('requirements.list.deleteErrGeneric'));
    }
  }
  // R63 时间胶囊: 删除也会生成 status 变更 revision, 但下次列表刷新自然重拉.
  // 这里无需主动 invalidate — refresh() 已触发 refreshRevisionsFor().
}

/* ------------------------------------------------------------------ */
/*  渲染辅助                                                            */
/* ------------------------------------------------------------------ */

/** 时间格式化 — zh-CN locale + 24h. */
function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
    return parseDbTime(iso)?.toLocaleString('zh-CN', { hour12: false }) ?? iso;
  } catch {
    return iso;
  }
}

/** 取状态 chip className (与 Next STATUS_COLOR 调色板对齐, 等价 hex). */
function statusClass(s: RequirementStatus): string {
  return STATUS_COLOR[s];
}

/** 单条 row 的 project 展示名 — 找不到 fallback 后 8 位 (避免泄漏全 id). */
function projectDisplay(r: Requirement): string {
  return projectNameById.value[r.project_id] ?? `#${r.project_id.slice(-8)}`;
}

/** version 展示 — 与 Next RequirementsListView 行内渲染对齐:
    - 有 version_id + versionNameById 命中 = "v·VersionName" (绿底)
    - 有 version_id 但未命中 = "已挂版本" (绿底, fallback "未挂版本" 文案)
    - 没 version_id = "未挂版本" (黄底). */
function versionDisplay(r: Requirement): { text: string; cls: string } {
  if (!r.version_id) return { text: t('requirements.list.versionNone'), cls: 'badge-version-none' };
  const name = versionNameById.value[r.version_id];
  if (name) return { text: `v·${name}`, cls: 'badge-version-set' };
  return { text: t('requirements.list.versionSet'), cls: 'badge-version-set' };
}

/** R63 时间胶囊: 行内取最新 1 条 revision. 没数据 (cache miss / 没 revision) = null,
    模板里判断 null 不渲染 chip. */
function rowLatestRevision(r: Requirement): RequirementRevision | null {
  return latestRevisionById[r.id] ?? null;
}

/** revision 行展示 — 把 actor + field 拼成 "AI·状态" / "人·标题" 之类 chip. */
function revisionChipText(rev: RequirementRevision): string {
  return `${actorLabel(rev.actor_type)}·${fieldLabel(rev.field)}`;
}

/** rev-chip hover title — "{actor}改 {field} · {time}" 走 i18n 插值. */
function revisionTitle(rev: RequirementRevision): string {
  return t('requirements.list.revTitle', {
    actor: actorLabel(rev.actor_type),
    field: fieldLabel(rev.field),
    time: fmt(rev.created_at),
  });
}

/** R196 散点数据点 hover title — 未评估文案走 i18n. */
function scatterDotTitle(pt: ScatterPoint): string {
  const evaluated = pt.evaluated ? `${pt.y}%` : t('requirements.list.dotNotEvaluated');
  return `${pt.title} · P${pt.x} · ${evaluated}`;
}

/** revision chip 颜色 — 与 master ACTOR_COLOR 等价 hex (scoped CSS 不接 Tailwind). */
function revisionChipStyle(rev: RequirementRevision): Record<string, string> {
  const c = ACTOR_COLOR[rev.actor_type];
  return { backgroundColor: c.bg, color: c.color, borderColor: c.border };
}

/** tags 解析 — 空数组返空. */
function rowTags(r: Requirement): string[] {
  return parseRequirementTags(r.tags);
}

/** 状态过滤 chip 选中样式 — 当前 filter 命中 = primary, 否则 ghost. */
function isStatusActive(s: '' | RequirementStatus): boolean {
  return statusFilter.value === s;
}

// ---- R196 完成度 × 紧急程度 二维散点视图 ----

/** 视图模式: list = 卡片列表 (默认), scatter = 完成度×紧急程度散点. */
const viewMode = ref<'list' | 'scatter'>('list');

/** 散点数据: x = 紧急程度 P1-P5 (未填 = P3 中位), y = 完成度 0-100 (未评估 = 0 + 空心点).
    点击点 → 打开该需求编辑弹窗 (damo R196: "点开就能看"). */
interface ScatterPoint {
  req: Requirement;
  x: number;
  y: number;
  evaluated: boolean;
  cx: number;
  cy: number;
  title: string;
}
const scatterPoints = computed<ScatterPoint[]>(() => {
  const W = 640, H = 340, PAD_L = 48, PAD_R = 20, PAD_T = 16, PAD_B = 40;
  return items.value.map((r, i) => {
    const x = r.priority ?? 3;
    const evaluated = r.progress !== null && r.progress !== undefined;
    const y = evaluated ? (r.progress as number) : 0;
    // 同坐标多点微偏移 (按索引确定性偏移, 不用随机 → 每次渲染稳定).
    const dx = ((i % 5) - 2) * 7;
    const dy = (Math.floor(i / 5) % 3) * 6 - 6;
    const cx = PAD_L + ((x - 1) / 4) * (W - PAD_L - PAD_R) + dx;
    const cy = PAD_T + (1 - y / 100) * (H - PAD_T - PAD_B) + dy;
    return { req: r, x, y, evaluated, cx, cy, title: r.title };
  });
});

const SCATTER_W = 640, SCATTER_H = 340, SCATTER_PAD_L = 48, SCATTER_PAD_T = 16, SCATTER_PAD_B = 40;
/** P 值 → x 坐标 (模板里画网格线用). */
function pToCx(p: number): number {
  return SCATTER_PAD_L + ((p - 1) / 4) * (SCATTER_W - SCATTER_PAD_L - 20);
}
/** 完成度 → y 坐标. */
function pctToCy(pct: number): number {
  return SCATTER_PAD_T + (1 - pct / 100) * (SCATTER_H - SCATTER_PAD_T - SCATTER_PAD_B);
}
/** 完成度点颜色: done=绿, ≥90=蓝, 中段=琥珀, 低=灰 (与 status chip 色系一致). */
function scatterColor(pt: ScatterPoint): string {
  if (pt.req.status === 'done') return 'var(--tw-green-600)';
  if (!pt.evaluated) return 'var(--tw-gray-400)';
  if (pt.y >= 90) return 'var(--tw-blue-600)';
  if (pt.y >= 40) return 'var(--tw-amber-600)';
  return 'var(--tw-gray-400)';
}

/** 把 status chip 颜色 (Tailwind 类) 映射到 hex (用于 scoped style).
    这里直接在模板里用 statusClass() 拼到 class 上, scoped 内 Tailwind utility
    默认不生效; 改用 hex 内联 chip 样式 — 见 <style> 内联 background/color. */
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
  <div class="requirements-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('requirements.list.title') }}</h1>
        <p class="page-subtitle">
          {{ t('requirements.list.subtitle') }}
        </p>
      </div>
      <div class="header-actions">
        <Button
          variant="primary"
          size="sm"
          @click="openCreate"
        >
          {{ t('requirements.list.newBtn') }}
        </Button>
      </div>
    </header>

    <!-- Status filter chips (R28 字面 = 状态筛选; 与 Next buildFilterHref 行为对齐) -->
    <div class="filter-bar">
      <button
        v-for="opt in statusFilterOptions"
        :key="opt.value"
        type="button"
        :class="['chip', isStatusActive(opt.value) ? 'chip-active' : 'chip-default']"
        @click="statusFilter = opt.value"
      >
        {{ opt.label }}
      </button>
      <span class="filter-spacer" />
      <!-- R196: 视图切换 — 列表 / 完成度×紧急程度 二维散点 -->
      <button
        type="button"
        :class="['chip', viewMode === 'list' ? 'chip-active' : 'chip-default']"
        @click="viewMode = 'list'"
      >
        {{ t('requirements.list.viewList') }}
      </button>
      <button
        type="button"
        :class="['chip', viewMode === 'scatter' ? 'chip-active' : 'chip-default']"
        :title="t('requirements.list.scatterHint')"
        @click="viewMode = 'scatter'"
      >
        {{ t('requirements.list.viewScatter') }}
      </button>
    </div>

    <!-- Body -->
    <div class="page-body">
      <div v-if="loading && items.length === 0" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">{{ t('requirements.list.loading') }}</p>
      </div>

      <ErrorView
        v-else-if="error"
        :title="t('requirements.list.loadFailedTitle')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <Empty
        v-else-if="items.length === 0"
        :title="statusFilter ? t('requirements.list.emptyFilteredTitle') : t('requirements.list.emptyTitle')"
        :description="statusFilter
          ? t('requirements.list.emptyFilteredDesc')
          : t('requirements.list.emptyDesc')"
        illustration="inbox"
      />

      <div v-else-if="viewMode === 'list'" class="list-block">
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
                  v-for="tag in rowTags(r)"
                  :key="tag"
                  class="badge badge-tag"
                >
                  #{{ tag }}
                </span>
                <span class="meta-time">{{ fmt(r.created_at) }}</span>
                <span v-if="r.priority !== null" class="meta-priority">
                  · P{{ r.priority }}
                </span>
                <!-- R196: 完成度 badge (有评估才显示; source 图标: rule=⚙ manual=✋ ai=🤖) -->
                <span
                  v-if="r.progress !== null && r.progress !== undefined"
                  class="meta-progress"
                  :title="`${r.progress_note ?? ''} (${r.progress_source ?? ''} · ${r.progress_updated_at ?? ''})`"
                >
                  · {{ r.progress_source === 'rule' ? '⚙' : r.progress_source === 'ai' ? '🤖' : '✋' }} {{ r.progress }}%
                </span>
                <!-- R63 时间胶囊: 最新一次字段变更 (人/AI/系统 + 字段名).
                     行内 inline style 着色, scoped CSS 不接 Tailwind. -->
                <span
                  v-if="rowLatestRevision(r)"
                  class="rev-chip"
                  :style="revisionChipStyle(rowLatestRevision(r)!)"
                  :title="revisionTitle(rowLatestRevision(r)!)"
                >
                  <span>{{ actorLabel(rowLatestRevision(r)!.actor_type) }}</span>
                  <span class="rev-dot">·</span>
                  <span>{{ fieldLabel(rowLatestRevision(r)!.field) }}</span>
                </span>
                <!-- R74 W3: aggregates 3 chip (📋N / 📈X% / 💬feedback).
                     未加载 = 不渲染 (与 R63 rev-chip 同款兜底). -->
                <AggregatesChips
                  v-if="aggregatesById[r.id]"
                  :aggregates="aggregatesById[r.id]"
                />
              </div>
            </div>
            <span
              class="status-chip"
              :style="statusChipStyle(r.status)"
            >
              {{ statusLabel(r.status) }}
            </span>
            <button
              type="button"
              class="row-delete"
              :title="t('requirements.list.deleteHint')"
              :aria-label="t('requirements.list.deleteAria')"
              @click.stop="askDelete(r)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
                <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </article>

        <!-- Pagination -->
        <Pagination
          v-if="total > 0"
          v-model="currentPage"
          v-model:page-size="pageSize"
          :total="total"
        />
      </div>

      <!-- R196: 完成度 × 紧急程度 二维散点视图.
           横轴 = P1-P5 (越右越急), 纵轴 = 完成度 0-100% (越上越接近完成).
           空心点 = 未评估 (progress null); 点击点 = 打开该需求编辑弹窗. -->
      <div v-else class="scatter-block">
        <svg
          class="scatter-svg"
          :viewBox="`0 0 ${SCATTER_W} ${SCATTER_H}`"
          role="img"
          :aria-label="t('requirements.list.scatterAria')"
        >
          <!-- 网格 + 坐标轴刻度 -->
          <g v-for="p in [1, 2, 3, 4, 5]" :key="`gx${p}`">
            <line :x1="pToCx(p)" :y1="SCATTER_PAD_T" :x2="pToCx(p)" :y2="SCATTER_H - SCATTER_PAD_B" class="grid-line" />
            <text :x="pToCx(p)" :y="SCATTER_H - SCATTER_PAD_B + 18" class="axis-text" text-anchor="middle">P{{ p }}</text>
          </g>
          <g v-for="pct in [0, 25, 50, 75, 100]" :key="`gy${pct}`">
            <line :x1="SCATTER_PAD_L" :y1="pctToCy(pct)" :x2="SCATTER_W - 20" :y2="pctToCy(pct)" class="grid-line" />
            <text :x="SCATTER_PAD_L - 8" :y="pctToCy(pct) + 4" class="axis-text" text-anchor="end">{{ pct }}%</text>
          </g>
          <!-- 数据点 -->
          <circle
            v-for="(pt, i) in scatterPoints"
            :key="pt.req.id"
            :cx="pt.cx"
            :cy="pt.cy"
            r="7"
            :fill="pt.evaluated ? scatterColor(pt) : 'transparent'"
            :stroke="scatterColor(pt)"
            stroke-width="1.5"
            :class="['scatter-dot', pt.evaluated ? '' : 'dot-unevaluated']"
            :title="scatterDotTitle(pt)"
            @click.stop="openEdit(pt.req)"
          />
          <!-- 轴标题 -->
          <text :x="(SCATTER_PAD_L + SCATTER_W - 20) / 2" :y="SCATTER_H - 4" class="axis-title" text-anchor="middle">{{ t('requirements.list.axisUrgency') }}</text>
          <text :x="12" :y="SCATTER_H / 2" class="axis-title" text-anchor="middle" :transform="`rotate(-90 12 ${SCATTER_H / 2})`">{{ t('requirements.list.axisProgress') }}</text>
        </svg>
        <p class="scatter-legend">
          <span class="legend-dot" style="background:#16a34a" /> {{ t('requirements.list.legendDone') }}
          <span class="legend-dot" style="background:#2563eb" /> {{ t('requirements.list.legendHigh') }}
          <span class="legend-dot" style="background:#d97706" /> {{ t('requirements.list.legendMid') }}
          <span class="legend-dot legend-hollow" /> {{ t('requirements.list.legendUnevaluated') }}
          {{ t('requirements.list.legendHint') }}
        </p>
      </div>
    </div>

    <!-- Create / Edit Modal -->
    <Modal
      :model-value="modal.open"
      :title="modal.isEditing ? t('requirements.list.editTitle') : t('requirements.list.createTitle')"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeModal(); }"
    >
      <div class="form">
        <div class="form-row">
          <label class="form-label">
            {{ t('requirements.list.fieldProject') }} <span class="required">*</span>
          </label>
          <Select
            v-model="modal.form.project_id"
            :options="projectOptions"
            :placeholder="t('requirements.list.projectPlaceholder')"
            :disabled="modal.isEditing || modal.submitting"
          />
          <p v-if="modal.isEditing" class="form-hint">
            {{ t('requirements.list.projectFixedHint') }}
          </p>
        </div>

        <div class="form-row">
          <label class="form-label">
            {{ t('requirements.field.title') }} <span class="required">*</span>
          </label>
          <Input
            v-model="modal.form.title"
            :placeholder="t('requirements.list.titlePlaceholder')"
            :disabled="modal.submitting"
          />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('requirements.field.description') }}</label>
          <Textarea
            v-model="modal.form.description"
            :rows="3"
            :placeholder="t('requirements.list.descPlaceholder')"
            :disabled="modal.submitting"
          />
        </div>

        <div class="form-grid">
          <div class="form-row">
            <label class="form-label">{{ t('requirements.field.status') }}</label>
            <Select
              v-model="modal.form.status"
              :options="statusOptions"
              :disabled="modal.submitting"
            />
            <p class="form-hint">
              {{ t('requirements.list.statusHint') }}
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
          <label class="form-label">{{ t('requirements.field.version_id') }}</label>
          <Select
            v-model="modal.form.version_id"
            :options="currentVersions"
            :placeholder="versionsLoading ? t('requirements.list.loading') : t('requirements.list.versionPlaceholder')"
            :disabled="modal.submitting || !modal.form.project_id"
          />
          <p class="form-hint">
            {{ t('requirements.list.versionHint') }}
          </p>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('requirements.field.tags') }}</label>
          <Input
            v-model="modal.form.tags"
            :placeholder="t('requirements.list.tagsPlaceholder')"
            :disabled="modal.submitting"
          />
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" :disabled="modal.submitting" @click="closeModal">
          {{ t('requirements.list.cancelBtn') }}
        </Button>
        <Button :loading="modal.submitting" :disabled="modal.submitting" @click="submitModal">
          {{ modal.isEditing ? t('requirements.list.saveBtn') : t('requirements.list.createBtn') }}
        </Button>
      </template>
    </Modal>

    <!-- Delete confirm (R6) -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="t('requirements.list.confirmTitle')"
      :message="pendingDelete
        ? t('requirements.list.confirmMessage', { title: pendingDelete.title })
        : ''"
      :confirm-text="t('requirements.list.confirmBtn')"
      :cancel-text="t('requirements.list.cancelBtn')"
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
.requirements-page {
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
.loading-text {
  margin: 0;
  font-size: 14px;
}

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
.row-left {
  flex: 1;
  min-width: 0;
}
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

/* R196: 完成度 badge + 二维散点视图 */
.meta-progress { color: var(--color-text-muted); font-weight: 500; }
.filter-spacer { flex: 1; }
.scatter-block { padding: 8px 0; }
.scatter-svg { width: 100%; max-width: 720px; height: auto; display: block; margin: 0 auto; }
.grid-line { stroke: var(--color-border, #e5e7eb); stroke-width: 1; }
.axis-text { font-size: 11px; fill: var(--color-text-muted, #6b7280); }
.axis-title { font-size: 12px; fill: var(--color-text-muted, #6b7280); }
.scatter-dot { cursor: pointer; }
.scatter-dot:hover { stroke-width: 2.5; }
.legend-hollow { background: transparent; border: 1.5px solid var(--tw-gray-400); }
.scatter-legend {
  display: flex; align-items: center; gap: 6px; justify-content: center;
  font-size: 12px; color: var(--color-text-muted, #6b7280); margin-top: 4px;
}
.legend-dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  margin-left: 10px;
}

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
.badge-version-set {
  background: var(--tw-green-100);
  color: var(--tw-green-800);
}
.badge-version-none {
  background: var(--tw-amber-100);
  color: var(--tw-amber-800);
}
.badge-tag {
  background: var(--tw-blue-50);
  color: var(--tw-blue-700);
}

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

/* R63 时间胶囊 chip — 与 master RevisionBadge bg-* text-* border-* 等价,
   inline style 控制色彩, scoped CSS 只管 layout + border. */
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
  width: 30px;
  height: 30px;
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
</style>