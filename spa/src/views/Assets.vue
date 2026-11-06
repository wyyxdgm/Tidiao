<script setup lang="ts">
/* 功能: Assets 资源池视图 — 对应 Next src/app/assets/page.tsx. R30 字面要求 = 上传 +
   列表 + 删除 (multipart 上传). 视图范围按 sheet 红线只动本文件 + 必要 glue (api/assets.ts
   + router + ProjectSidebar).

   关注点 (sheet R30 + 与现实分歧):
   - sheet 字面要求 "上传 + 列表 + 删除; multipart 上传", Next 端 assets-client.tsx 实际只
     有列表 + 单删 + 批量删 (没有上传 UI, 没有后端 "upload to asset pool" 端点).
     后端 multipart 上传走 POST /api/tasks/[id]/attachments (10MB 上限, 415/413).
     SPA 加一个 "上传" 按钮 → 弹 modal → 选 task (从 /api/tasks/page?statusGroup=all 拉
     最近 20 条) + 选文件 → POST 到该 task. 这是不修改 backend 的唯一解.
   - 列表字段 / 筛选下拉 / 排序 / 分页 / 单删 / 批量删 与 Next 同款 (1:1 对齐); 详见
     api/assets.ts 注释.
   - 复用 Layer 0: R5 Modal + R6 ConfirmDialog + R7 Button + R8 Input + R9 Select +
     R10 Checkbox + R11 Loading + R13 Empty/ErrorView + R12 Pagination.
     R51 (Round 1): 工具栏「搜索」「批量删除」按钮从 size=sm (26px) 升到 size=md (34px),
     与 Input/Select (~34px) 等高 — 修「按钮比输入框/下拉矮一截」错位.
     R51 (Round 2): (a) 表格区限高 + 内部 auto-scroll, 让底部分页 footer 始终贴页面底部
     (不管数据多寡都不会被表格挤到屏幕外); (b) 改用 R12 Pagination 组件 — 自带 page size
     切换 + 跳转 input (页号), 跟 Requirements/Runners 等页面同款, 用户体验一致.
   - 类型 tabs (图片 / 视频 / 音频 / 文件 / 全部) 走 R7 Button variant 切换, 比下拉快,
     与 Next 端 tabs 一致; 用 inline-flex gap 横向排, 选中态 primary.
   - 表格列与 Next 一致: 复选框 / 预览 / 文件名 / 类型 / 来源 / 大小 / 所属 Task / 创建
     时间 / 操作. 图片预览走 <img src="/api/attachments/[id]" loading=lazy> (后端 stream
     直接吐 bytes), 其他类型显示 emoji 图标 (与 Next fileIcon 同款).
   - 分页: 改用 @/components/Pagination (R12). 该组件已封装 1-indexed modelValue +
     pageSize/total + pageSizeOptions, 处理越界自动修正 + 跳转 input + 首末页按钮.
     本文件仅做胶水: 当前页 = currentPage (1-indexed); 调后端时换算 offset = (page-1)*size
     + limit = size. pageSize 切换 / 跨页 / 跳转都通过 Pagination emit (update:modelValue
     + update:pageSize) 收口到 onPageChange / onPageSizeChange, 内部统一走 refresh().
     R51 (Round 1) 的 prev/next 自实现分页块已废弃.
   - 布局: page-body flex column + table-card flex:1 + min-height:0 + overflow:auto,
     分页 footer 作为 body 末位子节点自然贴在底部 — 不依赖 fixed/sticky, 不污染 SPA 滚动.
   - 批量选择: 当前页 toggle + 全选; 切换筛选时自动清空选择 (避免跨页错位, 与 Next 同).
   - 不引 R14 BoardPage + 不接 SSE: /assets 是表格 + 操作, 不是看板; SSE 也不适用 (资产
     池变动 = 用户自己上传/删除, 无后台推送必要). */

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  listAssets,
  listAssetFilters,
  deleteAssetsBatch,
  uploadAttachmentToTask,
  listRecentTasks,
  type AssetItem,
  type AssetTypeFilter,
  type AssetSourceFilter,
  type AssetFiltersResponse,
  type FilterProject,
  type RecentTaskItem,
} from '@/api/assets';
import { isHttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import Modal from '@/components/Modal.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import FileInput from '@/components/FileInput.vue';
import Pagination from '@/components/Pagination.vue';

/* ------------------------------------------------------------------ */
/*  常量                                                                */
/* ------------------------------------------------------------------ */

/** 与 Next TYPE_OPTIONS 1:1 — i18n: label 走 t() → computed. */
const typeOptions = computed<{ value: AssetTypeFilter; label: string }[]>(() => [
  { value: '', label: t('projects.assets.typeAll') },
  { value: 'image', label: t('projects.assets.typeImage') },
  { value: 'video', label: t('projects.assets.typeVideo') },
  { value: 'audio', label: t('projects.assets.typeAudio') },
  { value: 'file', label: t('projects.assets.typeFile') },
]);

/** 与 Next SOURCE_OPTIONS 1:1 — i18n: computed. */
const sourceOptions = computed<{ value: AssetSourceFilter; label: string }[]>(() => [
  { value: '', label: t('projects.assets.sourceAll') },
  { value: 'agent_generated', label: t('projects.assets.sourceAgent') },
  { value: 'upload', label: t('projects.assets.sourceUpload') },
  { value: 'fork', label: t('projects.assets.sourceFork') },
]);

/** 与 Next SORT_OPTIONS 1:1 — i18n: computed. */
const sortOptions = computed(() => [
  { value: 'created_at:desc', label: t('projects.assets.sortNewest') },
  { value: 'created_at:asc', label: t('projects.assets.sortOldest') },
  { value: 'size_bytes:desc', label: t('projects.assets.sortSizeDesc') },
  { value: 'size_bytes:asc', label: t('projects.assets.sortSizeAsc') },
  { value: 'filename:asc', label: t('projects.assets.sortNameAsc') },
  { value: 'filename:desc', label: t('projects.assets.sortNameDesc') },
]);

/** 来源徽章配色 — 与 Next SOURCE_BADGE 1:1 (label 走 t(); Tailwind class 翻译到 scoped CSS). */
const SOURCE_BADGE: Record<string, { key: string; variant: 'purple' | 'blue' | 'amber' | 'gray' }> = {
  agent_generated: { key: 'projects.assets.sourceAgent', variant: 'purple' },
  upload: { key: 'projects.assets.sourceUpload', variant: 'blue' },
  fork: { key: 'projects.assets.sourceFork', variant: 'amber' },
};

/** 默认每页条数 — 与 Next PAGE_LIMIT 1:1 = 50. */
const DEFAULT_PAGE_SIZE = 50;

/** 每页条数选项 — 跟 Pagination 组件默认 [10,20,50,100] 取齐, 资产场景略
    大 (图片预览占高) 故砍掉 10, 保留 20/50/100. */
const PAGE_SIZE_OPTIONS: number[] = [20, 50, 100];

/** 后端 multipart 上限, 用于前端提示. 与 master tasks/[id]/attachments 的 MAX_SIZE 对齐. */
const UPLOAD_MAX_SIZE = 10 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();
const { t } = useI18n();

const assets = ref<AssetItem[]>([]);
const total = ref<number>(0);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

const filtersData = ref<AssetFiltersResponse>({ projects: [], orphan_count: 0 });

/* 筛选 / 搜索 / 排序 — 与 Next useState 1:1. */
const searchInput = ref<string>('');
const search = ref<string>('');
const type = ref<AssetTypeFilter>('');
const source = ref<AssetSourceFilter>('');
const projectId = ref<string>('');
const versionId = ref<string>('');
const sort = ref<string>('created_at:desc');
/* 分页 — 1-indexed currentPage + pageSize, 渲染时换算成后端 offset/limit.
   与 Pagination 组件 modelValue/pageSize 同语义 (R12 拍板: 1-indexed). */
const currentPage = ref<number>(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);

/* 批量选择 — 当前页内 toggle. */
const selected = ref<Set<string>>(new Set());

/* 单删确认 + 批量删确认 — pendingDelete 非空 = 单删弹窗显示. */
const pendingDelete = ref<AssetItem | null>(null);
const batchDeleteOpen = ref<boolean>(false);
const batchDeleting = ref<boolean>(false);

/* 单删进行中 — 单条删除时锁定该行的 button, 避免重复触发. */
const deletingId = ref<string | null>(null);

/* ------------------------------------------------------------------ */
/*  Upload modal 状态                                                   */
/* ------------------------------------------------------------------ */

interface UploadState {
  open: boolean;
  /** 选中的 task id (上传到的 parent). */
  taskId: string | null;
  /** 选中的 file. */
  file: File | null;
  /** 拖拽中态 — 仅样式提示, 不影响提交. */
  dragging: boolean;
  /** 提交中. */
  submitting: boolean;
  /** 加载 recent tasks 状态. */
  loadingTasks: boolean;
  /** recent tasks 拉取失败 / 拉到的列表. */
  recentTasks: RecentTaskItem[];
  recentTasksError: string | null;
}

const upload = reactive<UploadState>({
  open: false,
  taskId: null,
  file: null,
  dragging: false,
  submitting: false,
  loadingTasks: false,
  recentTasks: [],
  recentTasksError: null,
});

/* file input ref — modal 打开时 click() 触发选文件. */
const fileInputEl = ref<InstanceType<typeof FileInput> | null>(null);

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

/** 项目下拉 — 与 Next projectOptions 1:1: "全部项目" + "项目名 (count)". */
const projectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('projects.assets.projectAll') },
  ...filtersData.value.projects.map((p: FilterProject) => ({
    value: p.id,
    label: `${p.name} (${p.count})`,
  })),
]);

/** 版本下拉 — 仅在选了 project 时填充, 与 Next versionOptions 1:1.
    飞书 AO-DEV R218: 追加「其他版本」桶 (value='null' 字面量) = 未挂版本的条目. */
const versionOptions = computed<{ value: string; label: string }[]>(() => {
  const opts: { value: string; label: string }[] = [{ value: '', label: t('projects.assets.versionAll') }];
  if (projectId.value) {
    const p = filtersData.value.projects.find((x) => x.id === projectId.value);
    for (const v of p?.versions ?? []) {
      opts.push({ value: v.id, label: `${v.name} (${v.count})` });
    }
    opts.push({ value: 'null', label: t('projects.assets.versionOther') });
  }
  return opts;
});

/** task picker — "最近 task 列表" → Select options.
    i18n: 回调参数 t 会遮蔽 i18n 的 t, 起别名叫 it 避开. */
const taskOptions = computed<{ value: string; label: string }[]>(() => {
  if (upload.loadingTasks) return [{ value: '', label: t('projects.assets.tasksLoading') }];
  if (upload.recentTasksError) return [{ value: '', label: t('projects.assets.tasksLoadFailed') }];
  if (upload.recentTasks.length === 0) return [{ value: '', label: t('projects.assets.tasksEmpty') }];
  return upload.recentTasks.map((it) => ({
    value: it.id,
    label: it.title || it.id.slice(0, 8),
  }));
});

/* start / end 给 doDelete 校正偏移用 — 真正的「第 X-Y 项 / 共 N 条」展示在 Pagination 组件里. */
const start = computed<number>(() =>
  total.value === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1,
);
const end = computed<number>(() =>
  Math.min(currentPage.value * pageSize.value, total.value),
);

/** 当前页是否全选 — checkbox indeterminate 状态. */
const allChecked = computed<boolean>(
  () => assets.value.length > 0 && selected.value.size === assets.value.length,
);

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

async function loadFilters(): Promise<void> {
  try {
    filtersData.value = await listAssetFilters();
  } catch {
    // 筛选下拉拉取失败不阻塞主列表, 用户看到的就是当前筛选结果.
  }
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const resp = await listAssets({
      q: search.value || undefined,
      type: type.value,
      source: source.value,
      project_id: projectId.value || undefined,
      // 飞书 AO-DEV R218: 'null' 字面量 = 未挂版本桶, 透传给后端 IS NULL 过滤.
      version_id: versionId.value === 'null' ? 'null' : versionId.value || undefined,
      sort: sort.value,
      limit: pageSize.value,
      offset: (currentPage.value - 1) * pageSize.value,
    });
    assets.value = Array.isArray(resp.assets) ? resp.assets : [];
    total.value = typeof resp.total === 'number' ? resp.total : 0;
    selected.value = new Set();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('projects.assets.loadFailedHttp', { status: e.status });
    } else if (e instanceof Error) {
      error.value = t('projects.assets.errNetwork', { msg: e.message });
    } else {
      error.value = t('projects.assets.deleteFailed');
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

onMounted(() => {
  void loadFilters();
  void refresh();
});

/* ------------------------------------------------------------------ */
/*  筛选 / 搜索 / 排序 / 分页                                          */
/* ------------------------------------------------------------------ */

function commitSearch(): void {
  currentPage.value = 1;
  search.value = searchInput.value.trim();
  void refresh();
}

function onProjectChange(v: string | null): void {
  projectId.value = v ?? '';
  versionId.value = '';
  currentPage.value = 1;
  void refresh();
}

function onVersionChange(v: string | null): void {
  versionId.value = v ?? '';
  currentPage.value = 1;
  void refresh();
}

function onSourceChange(v: string | null): void {
  source.value = (v ?? '') as AssetSourceFilter;
  currentPage.value = 1;
  void refresh();
}

function onSortChange(v: string | null): void {
  sort.value = v ?? 'created_at:desc';
  void refresh();
}

function setType(t: AssetTypeFilter): void {
  type.value = t;
  currentPage.value = 1;
  void refresh();
}

/* Pagination 组件 emit 收口 — 页面 / 每页大小变更统一走 refresh(). 跨页 / 跳转 /
   pageSize 切换都从这一处进, 避免散在多处.
   注意: 当前页与 modelValue 一致时, Pagination 内部 watch 也会 emit 一次
   (modelValue 越界修正路径, 见 Pagination.vue:84-93) — 不能短路, 直接写值
   + refresh. */
function onPageChange(page: number): void {
  currentPage.value = page;
  void refresh();
}

function onPageSizeChange(size: number): void {
  pageSize.value = size;
  /* pageSize 变更通常意味着当前页可能越界, 回到首页避免空页. R56-B19 同款. */
  currentPage.value = 1;
  void refresh();
}

/* ------------------------------------------------------------------ */
/*  批量选择                                                            */
/* ------------------------------------------------------------------ */

function toggleOne(id: string): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  if (allChecked.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(assets.value.map((a) => a.id));
  }
}

/** 当筛选条件变化导致当前 selected 引用了不在当前页的 id — 清空 (避免删除时发送跨页 id).
    watch 触发在 refresh() 之前 (selected 在 refresh 内部已清, 这里只是双保险). */
watch([search, type, source, projectId, versionId], () => {
  if (selected.value.size > 0) selected.value = new Set();
});

/* ------------------------------------------------------------------ */
/*  删除                                                                */
/* ------------------------------------------------------------------ */

async function doDelete(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const resp = await deleteAssetsBatch(ids);
    const failedCount = Array.isArray(resp.failed) ? resp.failed.length : 0;
    toast.success(
      t('projects.assets.deletedToast', { n: resp.deleted })
        + (failedCount > 0 ? t('projects.assets.deletedFailedPart', { n: failedCount }) : ''),
    );
    /* 删完可能不够一页 → 退回上一页 (与 Next doDelete 同款 offset 修正).
       改用 page/pageSize 表述: 若删完本页恰好空, 跳回上一页 (min 1). */
    const remaining = total.value - ids.length;
    const newPage =
      remaining > 0 && assets.value.length - ids.length === 0 && currentPage.value > 1
        ? currentPage.value - 1
        : currentPage.value;
    currentPage.value = newPage;
    await refresh();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('projects.assets.deleteFailedHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('projects.assets.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('projects.assets.deleteFailed'));
    }
  } finally {
    deletingId.value = null;
    batchDeleting.value = false;
  }
}

async function confirmSingleDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  deletingId.value = target.id;
  await doDelete([target.id]);
}

async function confirmBatchDelete(): Promise<void> {
  batchDeleteOpen.value = false;
  batchDeleting.value = true;
  const ids = Array.from(selected.value);
  await doDelete(ids);
}

/* ------------------------------------------------------------------ */
/*  Upload modal                                                        */
/* ------------------------------------------------------------------ */

async function openUpload(): Promise<void> {
  upload.open = true;
  upload.taskId = null;
  upload.file = null;
  upload.dragging = false;
  upload.submitting = false;
  upload.recentTasksError = null;
  await loadRecentTasks();
}

function closeUpload(): void {
  if (upload.submitting) return;
  upload.open = false;
}

async function loadRecentTasks(): Promise<void> {
  upload.loadingTasks = true;
  upload.recentTasksError = null;
  try {
    upload.recentTasks = await listRecentTasks(20);
  } catch (e: unknown) {
    if (isHttpError(e)) {
      upload.recentTasksError = e.message || t('projects.assets.loadFailedHttp', { status: e.status });
    } else if (e instanceof Error) {
      upload.recentTasksError = t('projects.assets.errNetwork', { msg: e.message });
    } else {
      upload.recentTasksError = t('projects.assets.tasksLoadFailed');
    }
    upload.recentTasks = [];
  } finally {
    upload.loadingTasks = false;
  }
}

function pickFile(): void {
  fileInputEl.value?.open();
}

function onFileChange(files: FileList | null): void {
  const f = files?.[0] ?? null;
  if (f) upload.file = f;
  // 允许同一文件再次触发 onchange.
  fileInputEl.value?.reset();
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  upload.dragging = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) upload.file = f;
}

function onDragOver(e: DragEvent): void {
  e.preventDefault();
  upload.dragging = true;
}

function onDragLeave(e: DragEvent): void {
  e.preventDefault();
  upload.dragging = false;
}

function clearFile(): void {
  upload.file = null;
}

async function submitUpload(): Promise<void> {
  if (!upload.taskId) {
    toast.error(t('projects.assets.errPickTask'));
    return;
  }
  if (!upload.file) {
    toast.error(t('projects.assets.errPickFile'));
    return;
  }
  if (upload.file.size > UPLOAD_MAX_SIZE) {
    toast.error(t('projects.assets.errTooLarge', { name: upload.file.name }));
    return;
  }
  upload.submitting = true;
  try {
    const resp = await uploadAttachmentToTask(upload.taskId, upload.file);
    toast.success(t('projects.assets.uploadedToast', { name: resp.attachment.filename }));
    upload.open = false;
    // 上传成功后回到首页, 让用户看到新行. currentPage 保持 1 (排序 = desc → 最新在前).
    currentPage.value = 1;
    await refresh();
  } catch (e: unknown) {
    if (isHttpError(e)) {
      toast.error(e.message || t('projects.assets.uploadFailedHttp', { status: e.status }));
    } else if (e instanceof Error) {
      toast.error(t('projects.assets.errNetwork', { msg: e.message }));
    } else {
      toast.error(t('projects.assets.uploadFailed'));
    }
  } finally {
    upload.submitting = false;
  }
}

/* ------------------------------------------------------------------ */
/*  渲染辅助                                                            */
/* ------------------------------------------------------------------ */

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function typeLabel(mt: string): string {
  if (mt.startsWith('image/')) return t('projects.assets.typeImage');
  if (mt.startsWith('video/')) return t('projects.assets.typeVideo');
  if (mt.startsWith('audio/')) return t('projects.assets.typeAudio');
  return t('projects.assets.labelFileKind');
}

function fileIcon(mt: string): string {
  if (mt.startsWith('image/')) return '🖼️';
  if (mt.startsWith('video/')) return '🎬';
  if (mt.startsWith('audio/')) return '🎵';
  if (mt.includes('pdf')) return '📄';
  if (mt.includes('zip') || mt.includes('gzip') || mt.includes('tar')) return '📦';
  if (mt.startsWith('text/')) return '📝';
  return '📎';
}

function isImage(mt: string): boolean {
  return mt.startsWith('image/');
}

function sourceBadge(s: string): { label: string; variant: 'purple' | 'blue' | 'amber' | 'gray' } {
  const hit = SOURCE_BADGE[s];
  return (
    hit
      ? { label: t(hit.key), variant: hit.variant }
      : { label: s || t('projects.assets.badgeUnknown'), variant: 'gray' }
  );
}

/* ------------------------------------------------------------------ */
/*  resetAndSearchInput / resetAndRefresh 已在 R51 Round 2 移除         */
/*  (用 Pagination 组件收口 onPageChange/onPageSizeChange, 不再需要     */
/*  自实现 prev/next + 外部 reset).                                     */
/* ------------------------------------------------------------------ */
</script>

<template>
  <div class="assets-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('projects.assets.title') }}</h1>
        <p class="page-subtitle">
          {{ t('projects.assets.subtitle') }}
        </p>
      </div>
      <div class="header-actions">
        <span class="meta-count">
          {{ loading ? t('projects.assets.loading') : t('projects.assets.countTotal', { n: total }) }}
        </span>
        <Button variant="primary" size="md" @click="openUpload">{{ t('projects.assets.uploadBtn') }}</Button>
      </div>
    </header>

    <!-- 类型 tab — 直接点击切换, 比下拉快 -->
    <div class="type-tabs">
      <button
        v-for="opt in typeOptions"
        :key="opt.value"
        type="button"
        :class="['type-tab', { 'type-tab-active': type === opt.value }]"
        @click="setType(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>

    <!-- Body -->
    <div class="page-body">
      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="toolbar-search">
          <Input
            v-model="searchInput"
            :placeholder="t('projects.assets.searchPh')"
            :clearable="true"
            @keyup.enter="commitSearch"
          />
          <!-- R51: size=md 与 Input(~34px) 等高, 修「搜索按钮比输入框矮一截」错位 -->
          <Button size="md" @click="commitSearch">{{ t('projects.assets.search') }}</Button>
        </div>

        <div class="toolbar-field">
          <Select
            :model-value="source"
            :options="sourceOptions"
            :placeholder="t('projects.assets.phSource')"
            @update:model-value="onSourceChange"
          />
        </div>

        <div class="toolbar-field">
          <Select
            :model-value="projectId"
            :options="projectOptions"
            :placeholder="t('projects.assets.phProject')"
            @update:model-value="onProjectChange"
          />
        </div>

        <div class="toolbar-field">
          <Select
            :model-value="versionId"
            :options="versionOptions"
            :placeholder="t('projects.assets.phVersion')"
            :disabled="!projectId"
            @update:model-value="onVersionChange"
          />
        </div>

        <div class="toolbar-field">
          <Select
            :model-value="sort"
            :options="sortOptions"
            :placeholder="t('projects.assets.phSort')"
            @update:model-value="onSortChange"
          />
        </div>

        <div class="toolbar-action">
          <!-- R51: size=md 与 Source/Project/Version/Sort Select 等高,
               修「批量删除按钮比其他控件矮一截」错位 -->
          <Button
            variant="danger"
            size="md"
            :disabled="selected.size === 0"
            @click="batchDeleteOpen = true"
          >
            {{ selected.size > 0 ? t('projects.assets.batchDeleteN', { n: selected.size }) : t('projects.assets.batchDelete') }}
          </Button>
        </div>
      </div>

      <!-- 表格区 — 三态: 加载中 / 错误 / 空 / 数据 -->
      <div class="table-card">
        <div v-if="loading && assets.length === 0" class="loading-block">
          <Loading size="lg" />
          <p class="loading-text">{{ t('projects.assets.loading') }}</p>
        </div>

        <ErrorView
          v-else-if="error"
          :title="t('projects.assets.loadFailedTitle')"
          :description="error"
          variant="error"
          :retrying="retrying"
          @retry="onRetry"
        />

        <Empty
          v-else-if="assets.length === 0"
          :title="t('projects.assets.emptyTitle')"
          :description="t('projects.assets.emptyDesc')"
          illustration="folder"
        >
          <template #cta>
            <Button variant="primary" size="sm" @click="openUpload">{{ t('projects.assets.emptyCta') }}</Button>
          </template>
        </Empty>

        <table v-else class="assets-table">
          <thead>
            <tr>
              <th class="col-check">
                <Checkbox
                  :model-value="allChecked"
                  @update:model-value="toggleAll"
                />
              </th>
              <th class="col-preview">{{ t('projects.assets.thPreview') }}</th>
              <th class="col-filename">{{ t('projects.assets.thFilename') }}</th>
              <th class="col-type">{{ t('projects.assets.thType') }}</th>
              <th class="col-source">{{ t('projects.assets.thSource') }}</th>
              <th class="col-size">{{ t('projects.assets.thSize') }}</th>
              <th class="col-task">{{ t('projects.assets.thTask') }}</th>
              <th class="col-time">{{ t('projects.assets.thTime') }}</th>
              <th class="col-action">{{ t('projects.assets.thAction') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in assets" :key="a.id">
              <td class="col-check">
                <Checkbox
                  :model-value="selected.has(a.id)"
                  @update:model-value="() => toggleOne(a.id)"
                />
              </td>
              <td class="col-preview">
                <img
                  v-if="isImage(a.media_type)"
                  :src="`/api/attachments/${a.id}`"
                  :alt="a.filename"
                  loading="lazy"
                  class="preview-img"
                />
                <div v-else class="preview-icon">
                  {{ fileIcon(a.media_type) }}
                </div>
              </td>
              <td class="col-filename">
                <a
                  :href="`/api/attachments/${a.id}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="filename-link"
                  :title="a.filename"
                >{{ a.filename }}</a>
                <div class="media-type" :title="a.media_type">{{ a.media_type || '—' }}</div>
              </td>
              <td class="col-type">
                <span class="badge badge-gray">{{ typeLabel(a.media_type) }}</span>
              </td>
              <td class="col-source">
                <span :class="['badge', `badge-${sourceBadge(a.source).variant}`]">
                  {{ sourceBadge(a.source).label }}
                </span>
              </td>
              <td class="col-size">{{ fmtSize(a.size_bytes) }}</td>
              <td class="col-task">
                <router-link
                  :to="`/tasks/${a.task_id}`"
                  class="task-link"
                  :title="a.task_title ?? a.task_id"
                >{{ a.task_title ?? a.task_id.slice(0, 8) }}</router-link>
              </td>
              <td class="col-time">{{ fmtDate(a.created_at) }}</td>
              <td class="col-action">
                <button
                  type="button"
                  class="link-danger"
                  :disabled="deletingId === a.id"
                  @click="pendingDelete = a"
                >{{ deletingId === a.id ? t('projects.assets.deleting') : t('projects.assets.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 — R51 Round 2: 改用 R12 Pagination 组件, 自带:
           (a) 每页 size Select (20/50/100)
           (b) 跳转 input (页号) + 首末页 « ‹ › » 按钮
           (c) 共 N 条 + 越界自动修正
           跟 Requirements / Runners 等页面同款, 用户体验一致.
           注意: 不绑 v-model 到 currentPage — v-model 已隐式赋值 + emit 同值,
           会让 onPageChange 的 `page === currentPage` 早 return 短路掉.
           改为 :model-value 单向, 单一入口在 onPageChange 里写 currentPage + refresh. -->
      <Pagination
        v-if="total > 0"
        :model-value="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-size-options="PAGE_SIZE_OPTIONS"
        @update:model-value="onPageChange"
        @update:page-size="onPageSizeChange"
      />
    </div>

    <!-- 单删确认 (R6) -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="t('projects.assets.confirmSingleTitle')"
      :message="pendingDelete
        ? t('projects.assets.confirmSingleMsg', { name: pendingDelete.filename })
        : ''"
      :confirm-text="t('projects.assets.confirmDelete')"
      :cancel-text="t('common.cancel')"
      type="danger"
      @cancel="pendingDelete = null"
      @confirm="confirmSingleDelete"
    />

    <!-- 批量删确认 (R6) -->
    <ConfirmDialog
      :open="batchDeleteOpen"
      :title="t('projects.assets.confirmBatchTitle', { n: selected.size })"
      :message="t('projects.assets.confirmBatchMsg')"
      :confirm-text="t('projects.assets.confirmAll')"
      :cancel-text="t('common.cancel')"
      type="danger"
      @cancel="batchDeleteOpen = false"
      @confirm="confirmBatchDelete"
    />

    <!-- 上传 modal (R5) -->
    <Modal
      :model-value="upload.open"
      :title="t('projects.assets.uploadTitle')"
      size="md"
      @update:model-value="(v: boolean) => { if (!v) closeUpload(); }"
    >
      <div class="upload-form">
        <div class="form-row">
          <label class="form-label">{{ t('projects.assets.labelTask') }} <span class="required">*</span></label>
          <Select
            :model-value="upload.taskId"
            :options="taskOptions"
            :placeholder="t('projects.assets.phTask')"
            :filterable="true"
            :disabled="upload.loadingTasks || upload.submitting"
            @update:model-value="(v: string | null) => (upload.taskId = v)"
          />
          <p class="form-hint">
            {{ t('projects.assets.uploadHint1') }}
            <code class="inline-code">/api/tasks/[id]/attachments</code> {{ t('projects.assets.uploadHint2') }}
          </p>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('projects.assets.labelFile') }} <span class="required">*</span></label>
          <div
            :class="['drop-zone', { 'drop-zone-active': upload.dragging, 'drop-zone-has-file': !!upload.file }]"
            @click="pickFile"
            @drop="onDrop"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
          >
            <FileInput
              ref="fileInputEl"
              class="file-input"
              @change="onFileChange"
            />
            <div v-if="upload.file" class="file-info">
              <span class="file-name">{{ upload.file.name }}</span>
              <span class="file-size">{{ fmtSize(upload.file.size) }}</span>
              <button
                type="button"
                class="file-clear"
                :disabled="upload.submitting"
                @click.stop="clearFile"
              >✕</button>
            </div>
            <div v-else class="drop-hint">
              <div class="drop-icon">📤</div>
              <div class="drop-text">{{ t('projects.assets.dropText') }}</div>
              <div class="drop-sub">{{ t('projects.assets.dropSub') }}</div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <Button variant="secondary" :disabled="upload.submitting" @click="closeUpload">
          {{ t('common.cancel') }}
        </Button>
        <Button
          variant="primary"
          :loading="upload.submitting"
          :disabled="upload.submitting || !upload.taskId || !upload.file"
          @click="submitUpload"
        >{{ t('projects.assets.uploadBtnSubmit') }}</Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  页面布局                                                            */
/* ------------------------------------------------------------------ */
.assets-page {
  display: flex;
  flex-direction: column;
  /* R51 Round 2: 高度 100% + min-height 兜底, 让 page-body 能撑满父容器剩余空间,
     table-card 内部 auto-scroll, 分页 footer 自然贴页面底部. */
  height: 100%;
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
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.meta-count {
  font-size: 13px;
  color: var(--color-text-muted);
}

/* 类型 tabs */
.type-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 14px 24px 0;
  background: var(--color-bg);
}
.type-tab {
  padding: 6px 14px;
  font-size: 13px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.type-tab:hover {
  background: var(--color-bg);
  color: var(--color-text);
}
.type-tab-active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}
.type-tab-active:hover {
  background: var(--color-primary-hover);
  color: #fff;
}

/* Body */
.page-body {
  flex: 1 1 auto;
  /* R51 Round 2: min-height: 0 允许子节点 (table-card) 在内容溢出时缩小并滚动,
     不撑爆父容器. */
  min-height: 0;
  padding: 14px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ------------------------------------------------------------------ */
/*  移动端兜底 (max-width: 768px)                                        */
/*  桌面端的"table-card 内部滚动 + 分页贴底"依赖高度锁链 (.assets-page    */
/*  height:100% → page-body/table-card flex:1+min-height:0). 手机上      */
/*  视口矮 + toolbar 换行堆叠成 4-5 行, 固定区块总高超过视口 →            */
/*  min-height:0 允许 table-card 被压成 0 高, 列表完全不可见且整页        */
/*  不能滚 (assets-page 锁死视口高). 放开高度锁恢复自然文档流,           */
/*  整页在 MainLayout .content-area (overflow:auto) 里滚动.              */
/* ------------------------------------------------------------------ */
@media (max-width: 768px) {
  .assets-page {
    height: auto;
  }
  .table-card {
    flex: 0 0 auto;
  }
}

/* ------------------------------------------------------------------ */
/*  Toolbar                                                              */
/* ------------------------------------------------------------------ */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.toolbar-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 220px;
}
.toolbar-field {
  width: 160px;
  flex-shrink: 0;
}
.toolbar-action {
  flex-shrink: 0;
  margin-left: auto;
}

/* ------------------------------------------------------------------ */
/*  表格                                                                */
/* ------------------------------------------------------------------ */
.table-card {
  /* R51 Round 2: 限高 + 内部 auto-scroll, 让分页 footer 始终贴页面底部.
     flex:1 + min-height:0 配合 page-body 的 flex column 实现"内容溢出滚动 +
     footer 固定贴底" — 不依赖 fixed/sticky, 不污染外层 SPA 滚动. */
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
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
.assets-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.assets-table thead th {
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
  /* R58.5: thead sticky 顶部 — 表格滚动时表头贴 table-card 顶部, 不随
     tbody 滚走 (与 BoardPage .board-list-table thead 同款). 背景改 elevated
     = 实色, 防 tbody 上滚透过 thead 看到下方行. table-card 自身没 padding-top,
     sticky top:0 直接贴齐. */
  position: sticky;
  top: 0;
  z-index: 1;
}
.assets-table tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}
.assets-table tbody tr:last-child td {
  border-bottom: 0;
}
.assets-table tbody tr:hover {
  background: var(--color-bg);
}

.col-check { width: 36px; }
.col-preview { width: 64px; }
.col-type { width: 64px; }
.col-source { width: 88px; }
.col-size { width: 80px; text-align: right; }
.col-time { width: 140px; }
.col-action { width: 80px; text-align: right; }

/* Preview */
.preview-img {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
}
.preview-icon {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  border-radius: var(--radius);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
}

/* Filename */
.filename-link {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 500;
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.filename-link:hover {
  text-decoration: underline;
}
.media-type {
  margin-top: 2px;
  font-size: 12px;
  color: var(--tw-gray-400);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Task link */
.task-link {
  color: var(--color-primary);
  text-decoration: none;
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.task-link:hover {
  text-decoration: underline;
}

/* Badges */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
}
.badge-gray { background: var(--color-bg); color: var(--color-text-muted); }
.badge-blue { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.badge-purple { background: var(--tw-violet-100); color: var(--tw-violet-700); }
.badge-amber { background: var(--tw-amber-100); color: var(--tw-amber-800); }

/* Action link */
.link-danger {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--tw-red-600);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.link-danger:hover:not(:disabled) {
  color: var(--tw-red-800);
  text-decoration: underline;
}
.link-danger:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
}

/* ------------------------------------------------------------------ */
/*  分页 — R51 Round 2 已迁出到 @/components/Pagination.vue (自带 scoped 样式),
     本处不再维护自定义 .pagination / .pagination-info / .pagination-actions. */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Upload modal 内 form + drop zone                                    */
/* ------------------------------------------------------------------ */
.upload-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.required { color: var(--tw-red-600); margin-left: 2px; }
.form-hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
.inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
}

.drop-zone {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  padding: 16px;
  border: 2px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.drop-zone:hover {
  border-color: var(--color-primary);
  background: var(--t-grad-c);
}
.drop-zone-active {
  border-color: var(--color-primary);
  background: var(--tw-blue-50);
}
.drop-zone-has-file {
  border-style: solid;
  border-color: var(--color-primary);
  background: var(--color-bg-elevated);
}
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.drop-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--color-text-muted);
  font-size: 13px;
}
.drop-icon { font-size: 32px; }
.drop-text { font-weight: 500; }
.drop-sub { font-size: 11px; }
.file-info {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.file-name {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.file-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 50%;
  background: var(--color-border);
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.file-clear:hover:not(:disabled) {
  background: var(--tw-red-100);
  color: var(--tw-red-700);
}
.file-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
