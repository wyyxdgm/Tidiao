<script setup lang="ts">
/* 功能: Schedules 视图 — 对应 Next src/app/schedules/schedules-client.tsx 完整镜像.
   R23 已落地基础版 (列表 + 启停 + 5 字段编辑 + 软删除). R6 (本轮) 升级为完整镜像,
   补齐 R68 v2 新建 modal + R92 筛选 (项目/版本/时间区间) + R86 编辑 modal (12 字段 +
   exec_type 锁定) + R53 triggerNow 立即执行 + R75 触发历史面板 (分页/缓存) +
   R79 完整日志弹窗 + R86 SSE 流式日志订阅.

   关注点 (与 sheet 红线 / master 后端分歧):
   - sheet R6 字面 "列表 + toggle + 编辑抽屉 + 软删除过滤". R23 字面要求只覆盖基础版,
     本轮按 "完整功能对等" 拍板升级 — 拍板依据 = sheet 红线 = "完整功能对等" 覆盖 R23 字面.
     与 sheet 字面分歧已在 commit 披露.
   - exec_type 编辑时锁定 (后端 PATCH 白名单 UPDATABLE_SCHEDULE_FIELDS 不含 exec_type,
     切换保存无效 = 反模式). R86 同款.
   - 筛选走 300ms 防抖 — datetime-local 每按键触发, 不防抖会爆 API.
   - 切换项目时清空版本筛选 — 新项目不包含旧 version, 不清 = 后端 WHERE 命中 0 行.
   - 删除走 R6 ConfirmDialog (硬删, 不走软删通道 — 与 master R68 v2 同款).
   - 新建/编辑 modal 复用 R5 Modal lg (Next 端用 fixed inset-0 inline 写, 本视图统一
     Modal 组件, ESC + backdrop 关闭免费).
   - SSE 路径: /api/schedules/runs/[runId]/stream (R86 第二轮). 不在 R53 polling 兜底.
   - ScheduleFormFields / RunsPanel 不抽 .vue 子组件 — inline 在同一 template, 与 Next
     端「单文件多内嵌组件」结构对齐 + 避免拆文件上下文撕裂. */

import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  createSchedule,
  deleteSchedule,
  listRuns,
  listSchedules,
  toggleSchedule,
  triggerNow,
  updateSchedule,
  type CreateScheduleBody,
  type Schedule,
  type ScheduleRun,
  type ScheduleUpdate,
} from '@/api/schedules';
import { isHttpError } from '@/api/http';
import { useProjectsStore } from '@/stores/projects';
import { useToast } from '@/composables/useToast';
import { parseDbTime } from '@/lib/datetime';
import { displayProjectName } from '@/lib/project-display';
import Button from '@/components/Button.vue';
import Modal from '@/components/Modal.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import DateTimePicker from '@/components/DateTimePicker.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const router = useRouter();
const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  类型 (本视图局部用)                                                  */
/* ------------------------------------------------------------------ */

interface Project { id: string; name: string }
interface Version { id: string; name: string; project_id: string }

/** 表单状态 — Next 端 CreateFormState 同款, 12 字段 + agent/shell 条件渲染. */
interface FormState {
  name: string;
  exec_type: 'agent' | 'shell';
  schedule_type: 'cron' | 'once';
  schedule_expr: string;
  timezone: string;
  description: string;
  project_id: string;
  title: string;
  prompt: string;
  command: string;
  cwd: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  exec_type: 'agent',
  schedule_type: 'cron',
  schedule_expr: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  description: '',
  project_id: '',
  title: '',
  prompt: '',
  command: '',
  cwd: '',
};

/** R92 筛选状态 — project + version + lastRun + nextRun 时间区间 + enabled 状态.
    enabled: '' = 全部, 'true' = 启用, 'false' = 停用 (Select 的 value 是 string). */
interface FilterState {
  projectId: string;
  versionId: string;
  enabled: string;
  lastRunFrom: string;
  lastRunTo: string;
  nextRunFrom: string;
  nextRunTo: string;
}
const EMPTY_FILTER: FilterState = {
  projectId: '',
  versionId: '',
  enabled: '',
  lastRunFrom: '',
  lastRunTo: '',
  nextRunFrom: '',
  nextRunTo: '',
};

/* ------------------------------------------------------------------ */
/*  顶层状态                                                            */
/* ------------------------------------------------------------------ */

const projectsStore = useProjectsStore();
const toast = useToast();

const schedules = ref<Schedule[]>([]);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

/** 软删除筛选 — 默认 false (damo 0823 R49 拍板). */
const showDeleted = ref<boolean>(false);

/** R92 筛选状态. */
const filter = reactive<FilterState>({ ...EMPTY_FILTER });

/** R92 防抖计时器 — datetime-local 每按键触发. */
const filterTimerRef = ref<ReturnType<typeof setTimeout> | null>(null);

/** R92 第二批: 项目列表 + 版本列表 — mount 时拉一次, 客户端按 projectId 过滤. */
const projects = ref<Project[]>([]);
const versions = ref<Version[]>([]);

/** R68 v2 删除二次确认. */
const pendingDelete = ref<Schedule | null>(null);

/** R68 v2 新建 modal. */
const createOpen = ref<boolean>(false);
const createForm = reactive<FormState>({ ...EMPTY_FORM });
const creating = ref<boolean>(false);

/** R86 编辑 modal. */
const editTarget = ref<Schedule | null>(null);
const editForm = reactive<FormState>({ ...EMPTY_FORM });
const editing = ref<boolean>(false);

/** R53 triggerNow per-schedule loading. */
const triggering = reactive<Record<string, boolean>>({});

/** R75 触发历史面板状态 — per-schedule 维度. */
const runsOpen = reactive<Record<string, boolean>>({});
const runsPage = reactive<Record<string, number>>({});
const runsData = reactive<Record<string, { runs: ScheduleRun[]; total: number; limit: number; offset: number } | null>>({});
const runsLoading = reactive<Record<string, boolean>>({});

/** R79 完整日志弹窗 + R86 SSE 流. */
const logDialogRun = ref<ScheduleRun | null>(null);
const liveStdout = ref<string>('');
const liveStderr = ref<string>('');
const liveCompleted = ref<boolean>(false);
const liveExitCode = ref<number | null>(null);
const esRef = ref<EventSource | null>(null);
const stdoutEndRef = ref<HTMLDivElement | null>(null);
const stderrEndRef = ref<HTMLDivElement | null>(null);

/** R6 description 折叠 (与 Next 一致: 默认单行截断 + 点击展开). */
const expandedId = ref<string | null>(null);

/** R75 触发历史内部常量. */
const PAGE_SIZE = 10;
const STDERR_PREVIEW = 200;
const STDOUT_PREVIEW = 200;

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const enabledCount = computed<number>(
  () => schedules.value.filter((s) => s.enabled).length,
);

/** 当前 filter 是否非空 — 控制重置按钮显示. */
const filterActive = computed<boolean>(
  () =>
    !!filter.projectId ||
    !!filter.versionId ||
    !!filter.enabled ||
    !!filter.lastRunFrom ||
    !!filter.lastRunTo ||
    !!filter.nextRunFrom ||
    !!filter.nextRunTo ||
    showDeleted.value,
);

/** 版本选项 — 客户端按 projectId 过滤.
    飞书 AO-DEV R218: 追加「其他版本」桶 (value='null' 字面量) = 未挂版本的 schedule. */
const versionOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('misc.schedules.allVersions') },
  ...versions.value
    .filter((v) => !filter.projectId || v.project_id === filter.projectId)
    .map((v) => ({ value: v.id, label: v.name })),
  { value: 'null', label: t('misc.schedules.otherVersions') },
]);

/* ------------------------------------------------------------------ */
/*  数据加载                                                            */
/* ------------------------------------------------------------------ */

/** R92: 统一拉列表 — showDeleted + project + 时间区间 + version. */
async function refetch(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await listSchedules({
      includeDeleted: showDeleted.value,
      project: filter.projectId || undefined,
      // 飞书 AO-DEV R218: 'null' 字面量 = 未挂版本桶, 透传给后端 IS NULL 过滤.
      version: filter.versionId === 'null' ? 'null' : filter.versionId || undefined,
      enabled: filter.enabled === '' ? undefined : filter.enabled === 'true',
      lastRunFrom: filter.lastRunFrom ? `${filter.lastRunFrom}:00Z` : undefined,
      lastRunTo: filter.lastRunTo ? `${filter.lastRunTo}:00Z` : undefined,
      nextRunFrom: filter.nextRunFrom ? `${filter.nextRunFrom}:00Z` : undefined,
      nextRunTo: filter.nextRunTo ? `${filter.nextRunTo}:00Z` : undefined,
    });
    schedules.value = Array.isArray(list) ? list : [];
  } catch (e: unknown) {
    if (isHttpError(e)) {
      error.value = e.message || t('misc.schedules.loadFailedHttp', { n: e.status });
    } else {
      error.value = t('misc.schedules.loadFailed');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function onRetry(): void {
  retrying.value = true;
  void refetch();
}

function onToggleShowDeleted(next: boolean): void {
  showDeleted.value = next;
  void refetch();
}

/** R92 筛选变更 — 300ms 防抖. */
function onFilterChange(patch: Partial<FilterState>): void {
  Object.assign(filter, patch);
  if (filterTimerRef.value) clearTimeout(filterTimerRef.value);
  filterTimerRef.value = setTimeout(() => {
    void refetch();
  }, 300);
}

function resetFilters(): void {
  Object.assign(filter, EMPTY_FILTER);
  showDeleted.value = false;
  void refetch();
}

/** R92 第二批: 切换项目时清空版本筛选 — 新项目不含旧 version. */
const prevProjectIdRef = ref<string | null>(null);
watch(
  () => filter.projectId,
  (next) => {
    const prev = prevProjectIdRef.value;
    prevProjectIdRef.value = next;
    if (prev === null) return;
    if (prev !== next && filter.versionId) {
      onFilterChange({ versionId: '' });
    }
  },
);

/* ------------------------------------------------------------------ */
/*  启停 toggle                                                        */
/* ------------------------------------------------------------------ */

async function onToggle(s: Schedule): Promise<void> {
  const next = !s.enabled;
  const prev = s.enabled;
  s.enabled = next;
  try {
    const updated = await toggleSchedule(s.id, next);
    Object.assign(s, updated);
    toast.success(next ? t('misc.schedules.enabled') : t('misc.schedules.disabled'));
  } catch (e: unknown) {
    s.enabled = prev;
    toast.error(isHttpError(e) ? e.message : t('misc.schedules.opFailed'));
  }
}

/* ------------------------------------------------------------------ */
/*  新建 modal (R68 v2)                                                */
/* ------------------------------------------------------------------ */

function openCreate(): void {
  Object.assign(createForm, EMPTY_FORM);
  if (!createForm.project_id && projects.value[0]) {
    createForm.project_id = projects.value[0].id;
  }
  createOpen.value = true;
}

function closeCreate(): void {
  if (creating.value) return;
  createOpen.value = false;
}

function validateForm(f: FormState): string | null {
  if (!f.name.trim()) return t('misc.schedules.errNameRequired');
  if (!f.schedule_expr.trim()) return t('misc.schedules.errExprRequired');
  if (f.exec_type === 'agent') {
    if (!f.project_id) return t('misc.schedules.errProjectRequired');
    if (!f.title.trim()) return t('misc.schedules.errTitleRequired');
    if (!f.prompt.trim()) return t('misc.schedules.errPromptRequired');
  } else if (!f.command.trim()) {
    return t('misc.schedules.errCommandRequired');
  }
  return null;
}

async function submitCreate(): Promise<void> {
  const err = validateForm(createForm);
  if (err) {
    toast.error(err);
    return;
  }
  if (!createForm.description.trim()) {
    toast.warn(t('misc.schedules.descWarn'));
  }
  creating.value = true;
  const body: CreateScheduleBody = {
    name: createForm.name.trim(),
    exec_type: createForm.exec_type,
    schedule_type: createForm.schedule_type,
    schedule_expr: createForm.schedule_expr.trim(),
    timezone: createForm.timezone.trim() || 'Asia/Shanghai',
  };
  if (createForm.description.trim()) body.description = createForm.description.trim();
  if (createForm.exec_type === 'agent') {
    body.project_id = createForm.project_id;
    body.title = createForm.title.trim();
    body.prompt = createForm.prompt.trim();
  } else {
    body.command = createForm.command.trim();
    if (createForm.cwd.trim()) body.cwd = createForm.cwd.trim();
  }
  try {
    const created = await createSchedule(body);
    schedules.value = [created, ...schedules.value];
    toast.success(t('misc.schedules.created'));
    closeCreate();
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('misc.schedules.createFailed'));
  } finally {
    creating.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  编辑 modal (R86)                                                    */
/* ------------------------------------------------------------------ */

function openEdit(s: Schedule): void {
  editTarget.value = s;
  Object.assign(editForm, {
    name: s.name,
    exec_type: s.exec_type,
    schedule_type: s.schedule_type,
    schedule_expr: s.schedule_expr,
    timezone: s.timezone,
    description: s.description ?? '',
    project_id: s.project_id ?? '',
    title: s.title ?? '',
    prompt: s.prompt ?? '',
    command: s.command ?? '',
    cwd: s.cwd ?? '',
  } satisfies FormState);
}

function closeEdit(): void {
  // 不守 editing — submitEdit 成功后 closeEdit() 调用时 editing 仍为 true,
  // 加守卫会把弹窗卡住不关 (R45 反馈). 镜像 master line 336-339 无守卫实现.
  editTarget.value = null;
  Object.assign(editForm, EMPTY_FORM);
}

async function submitEdit(): Promise<void> {
  if (!editTarget.value) return;
  const err = validateForm(editForm);
  if (err) {
    toast.error(err);
    return;
  }
  if (!editForm.description.trim()) {
    toast.warn(t('misc.schedules.descWarn'));
  }
  editing.value = true;
  const body: ScheduleUpdate = {
    name: editForm.name.trim(),
    schedule_type: editForm.schedule_type,
    schedule_expr: editForm.schedule_expr.trim(),
    timezone: editForm.timezone.trim() || 'Asia/Shanghai',
  };
  if (editForm.description.trim()) body.description = editForm.description.trim();
  if (editForm.exec_type === 'agent') {
    body.title = editForm.title.trim();
    body.prompt = editForm.prompt.trim();
  } else {
    body.command = editForm.command.trim();
    if (editForm.cwd.trim()) body.cwd = editForm.cwd.trim();
  }
  try {
    const updated = await updateSchedule(editTarget.value.id, body);
    const idx = schedules.value.findIndex((s) => s.id === updated.id);
    if (idx >= 0) schedules.value[idx] = updated;
    toast.success(t('misc.schedules.saved'));
    closeEdit();
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('misc.schedules.saveFailed'));
  } finally {
    editing.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  删除 (R68 v2 + R6 ConfirmDialog)                                    */
/* ------------------------------------------------------------------ */

function askDelete(s: Schedule): void {
  pendingDelete.value = s;
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    await deleteSchedule(target.id);
    schedules.value = schedules.value.filter((s) => s.id !== target.id);
    toast.success(t('misc.schedules.deleted'));
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('misc.schedules.deleteFailed'));
  }
}

/* ------------------------------------------------------------------ */
/*  立即执行 (R53)                                                      */
/* ------------------------------------------------------------------ */

async function onTriggerNow(s: Schedule): Promise<void> {
  if (s.deleted_at) {
    toast.error(t('misc.schedules.errSoftDeleted'));
    return;
  }
  triggering[s.id] = true;
  try {
    const result = await triggerNow(s.id);
    if (s.exec_type === 'agent' && result.task_id) {
      toast.success(t('misc.schedules.triggeredTask', { id: result.task_id.slice(0, 8) }));
    } else {
      toast.success(t('misc.schedules.triggeredShell'));
    }
    runsPage[s.id] = 0;
    void fetchRuns(s.id, 0);
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('misc.schedules.triggerFailed'));
  } finally {
    triggering[s.id] = false;
  }
}

/* ------------------------------------------------------------------ */
/*  触发历史面板 (R75)                                                  */
/* ------------------------------------------------------------------ */

async function fetchRuns(scheduleId: string, page: number): Promise<void> {
  runsLoading[scheduleId] = true;
  const limit = PAGE_SIZE;
  const offset = page * limit;
  try {
    const data = await listRuns(scheduleId, { limit, offset });
    runsData[scheduleId] = data;
    runsPage[scheduleId] = page;
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('misc.schedules.loadRunsFailed'));
  } finally {
    runsLoading[scheduleId] = false;
  }
}

function toggleRuns(scheduleId: string): void {
  const next = !runsOpen[scheduleId];
  runsOpen[scheduleId] = next;
  if (next && !runsData[scheduleId]) {
    void fetchRuns(scheduleId, 0);
  }
}

function gotoPage(scheduleId: string, page: number): void {
  runsPage[scheduleId] = page;
  void fetchRuns(scheduleId, page);
}

/* ------------------------------------------------------------------ */
/*  完整日志弹窗 (R79) + SSE (R86)                                      */
/* ------------------------------------------------------------------ */

function openLogDialog(r: ScheduleRun): void {
  logDialogRun.value = r;
}

function closeLogDialog(): void {
  logDialogRun.value = null;
}

// SSE 订阅 — logDialogRun 变化时启动/停止 EventSource
// R228: 弹窗的 run 日志流也是 HTTP/1.1 长连接, keep-alive 切走时关闭、切回
// 时若弹窗还开着且未完成则重开 (否则后台 tab 占住并发名额饿死其他请求).
function openRunLogStream(run: ScheduleRun): void {
  if (esRef.value) {
    esRef.value.close();
    esRef.value = null;
  }
  liveStdout.value = '';
  liveStderr.value = '';
  liveCompleted.value = false;
  liveExitCode.value = null;
  const url = `/api/schedules/runs/${run.id}/stream`;
  const es = new EventSource(url, { withCredentials: true });
  esRef.value = es;
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(ev.data) as {
        stdout?: string;
        stderr?: string;
        completed?: boolean;
        exitCode?: number | null;
      };
      if (typeof payload.stdout === 'string') liveStdout.value = payload.stdout;
      if (typeof payload.stderr === 'string') liveStderr.value = payload.stderr;
      if (typeof payload.completed === 'boolean') liveCompleted.value = payload.completed;
      if ('exitCode' in payload) liveExitCode.value = payload.exitCode ?? null;
      if (payload.completed) {
        es.close();
        esRef.value = null;
      }
    } catch {
      // 单帧解析失败, 继续等下一帧
    }
  };
  // EventSource 原生会自动重连; 静默处理 onerror
}

let runStreamWasDeactivated = false;
onDeactivated(() => {
  runStreamWasDeactivated = true;
  if (esRef.value) {
    esRef.value.close();
    esRef.value = null;
  }
});
onActivated(() => {
  if (!runStreamWasDeactivated) return; // 首次 mount 的 onActivated 跳过
  runStreamWasDeactivated = false;
  const run = logDialogRun.value;
  if (run && !liveCompleted.value) openRunLogStream(run);
});

watch(
  () => logDialogRun.value,
  (run) => {
    if (esRef.value) {
      esRef.value.close();
      esRef.value = null;
    }
    if (!run) return;
    openRunLogStream(run);
  },
);

// 自动滚动到 stdout/stderr 末尾
watch(liveStdout, async () => {
  await nextTick();
  stdoutEndRef.value?.scrollIntoView({ behavior: 'smooth', block: 'end' });
});
watch(liveStderr, async () => {
  await nextTick();
  stderrEndRef.value?.scrollIntoView({ behavior: 'smooth', block: 'end' });
});

/* ------------------------------------------------------------------ */
/*  格式化                                                              */
/* ------------------------------------------------------------------ */

function fmt(iso: string | null): string {
  if (!iso) return '—';
  if (iso.startsWith('9999')) return '—';
  try {
    // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
    return parseDbTime(iso)?.toLocaleString('zh-CN', { hour12: false }) ?? iso;
  } catch {
    return iso;
  }
}

interface Badge { text: string; cls: string }
function exitBadge(code: number | null): Badge {
  if (code === null) return { text: t('misc.schedules.badgeRunning'), cls: 'badge-running' };
  if (code === 0) return { text: t('misc.schedules.badgeSuccess', { n: code }), cls: 'badge-success' };
  return { text: t('misc.schedules.badgeFailed', { n: code }), cls: 'badge-failed' };
}

/** R75 agent run → 跳转 task 详情页. R6 原走 window.location 整页跳 (理由: hash
    模式 SPA 不内嵌 Next /tasks/[id]), 但 master 路由 `tasks/:taskId` 在 R22 已挂
    SPA router, 改走 router.push 同 SPA 内跳转 (G2 收口硬跳转). */
function handleTaskNav(taskId: string | null): void {
  if (!taskId) {
    toast.error(t('misc.schedules.noTaskId'));
    return;
  }
  void router.push(`/tasks/${taskId}`);
}

/* ------------------------------------------------------------------ */
/*  生命周期                                                            */
/* ------------------------------------------------------------------ */

onMounted(async () => {
  // 复用 store 拉 projects (R14 已挂载 mount 时 load)
  void projectsStore.load();
  projects.value = projectsStore.projects as Project[];
  // 单独拉全量 versions (R92 第二批)
  try {
    const res = await fetch('/api/versions', { credentials: 'include' });
    const data: unknown = await res.json();
    versions.value = Array.isArray(data)
      ? data
      : ((data as { versions?: Version[] })?.versions ?? []);
  } catch {
    // 静默失败 — 用户能看到空下拉
  }
  await refetch();
});

onBeforeUnmount(() => {
  if (filterTimerRef.value) clearTimeout(filterTimerRef.value);
  if (esRef.value) {
    esRef.value.close();
    esRef.value = null;
  }
});

/** watch projectsStore.projects 变化同步到本地 ref (R14 store 异步加载完成时). */
watch(() => projectsStore.projects, (next) => {
  projects.value = next as Project[];
}, { immediate: false });
</script>

<template>
  <div class="schedules-page">
    <!-- Header -->
    <header class="page-header">
      <div class="header-text">
        <h1 class="page-title">{{ t('misc.schedules.pageTitle') }}</h1>
        <p class="page-subtitle">
          {{ t('misc.schedules.pageSubtitle') }}
        </p>
      </div>
      <div class="header-meta">
        <span class="meta-count">{{ t('misc.schedules.enabledCount', { n: enabledCount, total: schedules.length }) }}</span>
        <Button variant="primary" @click="openCreate">{{ t('misc.schedules.newBtn') }}</Button>
      </div>
    </header>

    <!-- Toolbar: 筛选条 (R92) + 软删除 (v68) + 重置 -->
    <div class="toolbar">
      <div class="toolbar-filters">
        <div class="filter-item">
          <span class="filter-label">{{ t('misc.schedules.projectLabel') }}</span>
          <div class="filter-control">
            <Select
              :model-value="filter.projectId || null"
              @update:model-value="(v: string | null) => onFilterChange({ projectId: v || '' })"
              :options="[{ value: '', label: t('misc.schedules.allProjects') }, ...projects.map(p => ({ value: p.id, label: displayProjectName(p.name) }))]"
              :placeholder="t('misc.schedules.allProjects')"
            />
          </div>
        </div>

        <div class="filter-item">
          <span class="filter-label">{{ t('misc.schedules.versionLabel') }}</span>
          <div class="filter-control">
            <Select
              :model-value="filter.versionId || null"
              @update:model-value="(v: string | null) => onFilterChange({ versionId: v || '' })"
              :options="versionOptions"
              :placeholder="t('misc.schedules.allVersions')"
            />
          </div>
        </div>

        <div class="filter-item">
          <span class="filter-label">{{ t('misc.schedules.statusLabel') }}</span>
          <div class="filter-control">
            <Select
              :model-value="filter.enabled || null"
              @update:model-value="(v: string | null) => onFilterChange({ enabled: v || '' })"
              :options="[
                { value: '', label: t('misc.schedules.allStatuses') },
                { value: 'true', label: t('misc.schedules.enabled') },
                { value: 'false', label: t('misc.schedules.disabled') },
              ]"
              :placeholder="t('misc.schedules.allStatuses')"
              :filterable="false"
            />
          </div>
        </div>

        <div class="filter-item">
          <span class="filter-label">{{ t('misc.schedules.lastLabel') }}</span>
          <DateTimePicker
            :model-value="filter.lastRunFrom"
            :aria-label="t('misc.schedules.lastFromAria')"
            @update:model-value="(v: string) => onFilterChange({ lastRunFrom: v })"
          />
          <span class="filter-sep">→</span>
          <DateTimePicker
            :model-value="filter.lastRunTo"
            :aria-label="t('misc.schedules.lastToAria')"
            @update:model-value="(v: string) => onFilterChange({ lastRunTo: v })"
          />
        </div>

        <div class="filter-item">
          <span class="filter-label">{{ t('misc.schedules.nextLabel') }}</span>
          <DateTimePicker
            :model-value="filter.nextRunFrom"
            :aria-label="t('misc.schedules.nextFromAria')"
            @update:model-value="(v: string) => onFilterChange({ nextRunFrom: v })"
          />
          <span class="filter-sep">→</span>
          <DateTimePicker
            :model-value="filter.nextRunTo"
            :aria-label="t('misc.schedules.nextToAria')"
            @update:model-value="(v: string) => onFilterChange({ nextRunTo: v })"
          />
        </div>

        <label class="show-deleted">
          <Checkbox
            :model-value="showDeleted"
            @update:model-value="(v: boolean) => onToggleShowDeleted(v)"
          />
          <span>{{ t('misc.schedules.showDeleted') }}</span>
        </label>

        <Button v-if="filterActive" variant="ghost" size="sm" @click="resetFilters">
          {{ t('misc.schedules.reset') }}
        </Button>
      </div>
    </div>

    <!-- Body -->
    <div class="page-body">
      <div v-if="loading && schedules.length === 0" class="loading-block">
        <Loading size="lg" />
        <p class="loading-text">{{ t('misc.schedules.loading') }}</p>
      </div>

      <ErrorView
        v-else-if="error"
        :title="t('misc.schedules.loadFailed')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <Empty
        v-else-if="schedules.length === 0"
        :title="filterActive ? t('misc.schedules.noMatchTitle') : t('misc.schedules.emptyTitle')"
        :description="filterActive
          ? t('misc.schedules.noMatchDesc')
          : t('misc.schedules.emptyDesc')"
        illustration="inbox"
      />

      <div v-else class="card-list">
        <article
          v-for="s in schedules"
          :key="s.id"
          :class="['schedule-card', { 'schedule-card-deleted': !!s.deleted_at }]"
        >
          <div class="card-top">
            <div class="card-info">
              <div class="card-title-row">
                <h3 class="card-title">{{ s.name }}</h3>
                <span v-if="s.deleted_at" class="chip chip-deleted" :title="t('misc.schedules.deletedAtTip', { time: fmt(s.deleted_at) })">
                  {{ t('misc.schedules.deleted') }}
                </span>
                <span :class="['chip', s.enabled ? 'chip-enabled' : 'chip-disabled']">
                  {{ s.enabled ? t('misc.schedules.enabled') : t('misc.schedules.disabled') }}
                </span>
                <span class="chip chip-exec">{{ s.exec_type }}</span>
                <span :class="['chip', s.schedule_type === 'cron' ? 'chip-cron' : 'chip-once']">
                  {{ s.schedule_type === 'cron' ? t('misc.schedules.chipCron') : t('misc.schedules.chipOnce') }}
                </span>
                <span class="chip chip-expr">{{ s.schedule_expr }}</span>
                <span v-if="s.skip_if_running" class="chip chip-skip">{{ t('misc.schedules.skipIfRunning') }}</span>
              </div>

              <div v-if="s.exec_type === 'agent' && s.title" class="card-sub">
                {{ s.title }}
              </div>
              <code v-else-if="s.exec_type === 'shell' && s.command" class="card-command">
                $ {{ s.command }}
              </code>

              <div
                v-if="s.description"
                :class="['card-desc', expandedId === s.id ? '' : 'desc-clamp']"
                :title="expandedId === s.id ? t('misc.schedules.collapseDesc') : t('misc.schedules.expandDesc')"
                @click="expandedId = expandedId === s.id ? null : s.id"
              >
                {{ s.description }}
              </div>

              <div class="card-meta">
                <span class="meta-item">
                  {{ t('misc.schedules.createdLabel') }} <span class="meta-value">{{ fmt(s.created_at) }}</span>
                </span>
                <span class="meta-item">
                  {{ t('misc.schedules.nextLabel') }}: <span class="meta-value">{{ s.enabled ? fmt(s.next_run) : '—' }}</span>
                </span>
                <span class="meta-item">
                  {{ t('misc.schedules.lastLabel') }}: <span class="meta-value">{{ fmt(s.last_run) }}</span>
                </span>
                <span v-if="s.exec_type === 'agent' && s.last_task_id" class="meta-item">
                  {{ t('misc.schedules.lastTaskLabel') }}
                  <span class="meta-value mono">{{ s.last_task_id.slice(0, 8) }}</span>
                </span>
                <span v-if="s.exec_type === 'shell' && s.last_exit_code !== null" class="meta-item">
                  {{ t('misc.schedules.lastResultLabel') }}
                  <span :class="['badge', exitBadge(s.last_exit_code).cls]">
                    {{ exitBadge(s.last_exit_code).text }}
                  </span>
                </span>
              </div>
            </div>

            <!-- 操作按钮组 (R86: SPA 桌面端常显 — 避免 hover-only 摸不到) -->
            <div class="card-actions">
              <Button
                size="sm"
                :variant="s.enabled ? 'secondary' : 'primary'"
                :loading="false"
                :disabled="!!s.deleted_at"
                @click="onToggle(s)"
              >
                {{ s.enabled ? t('misc.schedules.disabled') : t('misc.schedules.enabled') }}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                :loading="!!triggering[s.id]"
                :disabled="!!s.deleted_at || !!triggering[s.id]"
                @click="onTriggerNow(s)"
              >
                {{ triggering[s.id] ? t('misc.schedules.triggering') : t('misc.schedules.triggerNow') }}
              </Button>
              <Button size="sm" variant="secondary" @click="openEdit(s)">{{ t('misc.schedules.edit') }}</Button>
              <Button
                size="sm"
                variant="danger"
                :disabled="!!s.deleted_at"
                @click="askDelete(s)"
              >
                {{ t('misc.schedules.delete') }}
              </Button>
            </div>
          </div>

          <!-- 触发历史按钮 + 面板 (R75) -->
          <div class="runs-toggle-row">
            <Button
              size="sm"
              variant="ghost"
              :aria-expanded="!!runsOpen[s.id]"
              @click="toggleRuns(s.id)"
            >
              {{ runsOpen[s.id] ? t('misc.schedules.collapseHistory') : t('misc.schedules.runsHistory') }}
            </Button>
          </div>

          <!-- RunsPanel (inline, 与 Next 端 ScheduleFormFields/RunsPanel 单文件结构对齐) -->
          <div v-if="runsOpen[s.id]" class="runs-panel">
            <div class="runs-panel-header">
              <div class="runs-panel-title">
                {{ t('misc.schedules.runsHistory') }}
                <span class="runs-panel-count">
                  {{ t('misc.schedules.runsCount', { total: runsData[s.id]?.total ?? 0, page: (runsPage[s.id] ?? 0) + 1, pages: Math.max(1, Math.ceil((runsData[s.id]?.total ?? 0) / PAGE_SIZE)) }) }}
                </span>
              </div>
              <div class="runs-panel-pager">
                <button
                  type="button"
                  class="pager-btn"
                  :disabled="(runsPage[s.id] ?? 0) <= 0 || !!runsLoading[s.id]"
                  @click="gotoPage(s.id, (runsPage[s.id] ?? 0) - 1)"
                >
                  {{ t('misc.schedules.prevPage') }}
                </button>
                <button
                  type="button"
                  class="pager-btn"
                  :disabled="(runsPage[s.id] ?? 0) + 1 >= Math.max(1, Math.ceil((runsData[s.id]?.total ?? 0) / PAGE_SIZE)) || !!runsLoading[s.id]"
                  @click="gotoPage(s.id, (runsPage[s.id] ?? 0) + 1)"
                >
                  {{ t('misc.schedules.nextPage') }}
                </button>
              </div>
            </div>

            <div v-if="!!runsLoading[s.id] && !(runsData[s.id]?.runs?.length)" class="runs-empty">{{ t('misc.schedules.loading') }}</div>
            <div v-else-if="!runsLoading[s.id] && (runsData[s.id]?.total ?? 0) === 0" class="runs-empty">{{ t('misc.schedules.noRuns') }}</div>

            <div v-else-if="(runsData[s.id]?.runs?.length ?? 0) > 0" class="runs-table-wrap">
              <table class="runs-table">
                <colgroup>
                  <col class="col-time" />
                  <col class="col-time" />
                  <col class="col-type" />
                  <col class="col-status" />
                  <col />
                  <col class="col-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>{{ t('misc.schedules.thStart') }}</th>
                    <th>{{ t('misc.schedules.thEnd') }}</th>
                    <th>{{ t('misc.schedules.thType') }}</th>
                    <th>{{ t('misc.schedules.thStatus') }}</th>
                    <th>
                      {{ s.exec_type === 'agent' ? t('misc.schedules.thAgentCol') : t('misc.schedules.thShellCol') }}
                    </th>
                    <th class="text-right">{{ t('misc.schedules.thActions') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in (runsData[s.id]?.runs ?? [])" :key="r.id">
                    <td class="mono">{{ fmt(r.started_at) }}</td>
                    <td class="mono">{{ r.completed_at ? fmt(r.completed_at) : '—' }}</td>
                    <td>{{ r.exec_type }}</td>
                    <td>
                      <span :class="['badge', exitBadge(r.exit_code).cls]">{{ exitBadge(r.exit_code).text }}</span>
                    </td>
                    <td>
                      <div>
                        <span v-if="s.exec_type === 'agent' && r.task_id" class="task-link">
                          <span class="mono">{{ r.task_id.slice(0, 8) }}</span>
                          <span class="text-muted">{{ t('misc.schedules.viewTask') }}</span>
                        </span>
                        <code v-if="s.exec_type === 'shell' && r.command" class="run-command">
                          $ {{ r.command }}
                        </code>
                      </div>
                      <pre v-if="s.exec_type === 'shell' && r.output" class="run-preview run-preview-stdout">
                        {{ r.output.length > STDOUT_PREVIEW ? r.output.slice(0, STDOUT_PREVIEW) + '…' : r.output }}
                      </pre>
                      <pre v-if="r.error" class="run-preview run-preview-stderr">
                        {{ r.error.length > STDERR_PREVIEW ? r.error.slice(0, STDERR_PREVIEW) + '…' : r.error }}
                      </pre>
                    </td>
                    <td class="text-right">
                      <button
                        v-if="s.exec_type === 'agent'"
                        type="button"
                        class="row-action-btn"
                        :disabled="!r.task_id"
                        :title="r.task_id ? t('misc.schedules.viewLogTip') : t('misc.schedules.noTaskTip')"
                        @click="handleTaskNav(r.task_id)"
                      >
                        {{ t('misc.schedules.viewLog') }}
                      </button>
                      <button
                        v-else
                        type="button"
                        class="row-action-btn"
                        @click="openLogDialog(r)"
                      >
                        {{ t('misc.schedules.viewLog') }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </article>
      </div>
    </div>

    <!-- 新建 modal (R68 v2) -->
    <Modal
      :model-value="createOpen"
      :title="t('misc.schedules.createTitle')"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeCreate(); }"
    >
      <!-- ScheduleFormFields (R86) inline -->
      <div class="schedule-form">
        <div class="form-row-2col">
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.nameLabel') }} <span class="required">*</span></label>
            <Input v-model="createForm.name" :placeholder="t('misc.schedules.phName')" />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.timezoneLabel') }}</label>
            <Input v-model="createForm.timezone" placeholder="Asia/Shanghai" />
            <p class="form-hint">{{ t('misc.schedules.hintTimezone') }}</p>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('misc.schedules.execLabel') }} <span class="required">*</span></label>
          <Select
            :model-value="createForm.exec_type"
            @update:model-value="(v: string | null) => createForm.exec_type = (v || 'agent') as 'agent' | 'shell'"
            :options="[
              { value: 'agent', label: t('misc.schedules.optAgent') },
              { value: 'shell', label: t('misc.schedules.optShell') },
            ]"
          />
        </div>

        <div class="form-row-2col">
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.typeLabel') }} <span class="required">*</span></label>
            <Select
              :model-value="createForm.schedule_type"
              @update:model-value="(v: string | null) => createForm.schedule_type = (v || 'cron') as 'cron' | 'once'"
              :options="[
                { value: 'cron', label: t('misc.schedules.optCron') },
                { value: 'once', label: t('misc.schedules.optOnce') },
              ]"
            />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.exprLabel') }} <span class="required">*</span></label>
            <Input
              v-model="createForm.schedule_expr"
              :placeholder="createForm.schedule_type === 'cron' ? '0 9 * * *' : '2026-12-31T16:00:00Z'"
              class-name="form-mono"
            />
            <p class="form-hint">
              {{ createForm.schedule_type === 'cron'
                ? t('misc.schedules.hintCron')
                : t('misc.schedules.hintOnce') }}
            </p>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('misc.schedules.descLabel') }}</label>
          <Textarea
            v-model="createForm.description"
            :rows="2"
            :placeholder="t('misc.schedules.phDesc')"
          />
        </div>

        <!-- agent 字段 -->
        <div v-if="createForm.exec_type === 'agent'" class="form-section">
          <div class="form-section-title">{{ t('misc.schedules.agentSection') }}</div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.projectLabel') }} <span class="required">*</span></label>
            <Select
              :model-value="createForm.project_id || null"
              @update:model-value="(v: string | null) => createForm.project_id = v || ''"
              :options="projects.map(p => ({ value: p.id, label: displayProjectName(p.name) }))"
              :placeholder="projects.length === 0 ? t('misc.schedules.noProjects') : t('misc.schedules.selectProject')"
            />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.titleLabel') }} <span class="required">*</span></label>
            <Input v-model="createForm.title" :placeholder="t('misc.schedules.phTitle')" />
            <p class="form-hint">{{ t('misc.schedules.hintTitle') }}</p>
          </div>
          <div class="form-row">
            <label class="form-label">prompt <span class="required">*</span></label>
            <Textarea
              v-model="createForm.prompt"
              :rows="9"
              :placeholder="t('misc.schedules.phPrompt')"
            />
            <p class="form-hint">{{ t('misc.schedules.hintPrompt') }}</p>
          </div>
        </div>

        <!-- shell 字段 -->
        <div v-else class="form-section">
          <div class="form-section-title">{{ t('misc.schedules.shellSection') }}</div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.commandLabel') }} <span class="required">*</span></label>
            <Input
              v-model="createForm.command"
              :placeholder="t('misc.schedules.phCommand')"
              class-name="form-mono"
            />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.cwdLabel') }}</label>
            <Input
              v-model="createForm.cwd"
              placeholder="/path/to/workdir"
              class-name="form-mono"
            />
            <p class="form-hint">{{ t('misc.schedules.hintCwd') }}</p>
          </div>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" :disabled="creating" @click="closeCreate">{{ t('misc.schedules.cancel') }}</Button>
        <Button :loading="creating" :disabled="creating" @click="submitCreate">
          {{ creating ? t('misc.schedules.creating') : t('misc.schedules.create') }}
        </Button>
      </template>
    </Modal>

    <!-- 编辑 modal (R86) -->
    <Modal
      :model-value="!!editTarget"
      :title="editTarget ? t('misc.schedules.editTitle', { id: editTarget.id.slice(0, 8) }) : ''"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeEdit(); }"
    >
      <div class="schedule-form">
        <div class="form-row-2col">
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.nameLabel') }} <span class="required">*</span></label>
            <Input v-model="editForm.name" :placeholder="t('misc.schedules.phName')" />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.timezoneLabel') }}</label>
            <Input v-model="editForm.timezone" placeholder="Asia/Shanghai" />
            <p class="form-hint">{{ t('misc.schedules.hintTimezone') }}</p>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('misc.schedules.execLabel') }}</label>
          <div class="exec-locked">
            {{ editForm.exec_type === 'agent' ? t('misc.schedules.optAgent') : t('misc.schedules.optShell') }}
          </div>
          <p class="form-hint">{{ t('misc.schedules.hintExecLocked') }}</p>
        </div>

        <div class="form-row-2col">
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.typeLabel') }} <span class="required">*</span></label>
            <Select
              :model-value="editForm.schedule_type"
              @update:model-value="(v: string | null) => editForm.schedule_type = (v || 'cron') as 'cron' | 'once'"
              :options="[
                { value: 'cron', label: t('misc.schedules.optCron') },
                { value: 'once', label: t('misc.schedules.optOnce') },
              ]"
            />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.exprLabel') }} <span class="required">*</span></label>
            <Input
              v-model="editForm.schedule_expr"
              :placeholder="editForm.schedule_type === 'cron' ? '0 9 * * *' : '2026-12-31T16:00:00Z'"
              class-name="form-mono"
            />
            <p class="form-hint">
              {{ editForm.schedule_type === 'cron'
                ? t('misc.schedules.hintCron')
                : t('misc.schedules.hintOnce') }}
            </p>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('misc.schedules.descLabel') }}</label>
          <Textarea
            v-model="editForm.description"
            :rows="2"
            :placeholder="t('misc.schedules.phDesc')"
          />
        </div>

        <!-- agent 字段 (exec_type 锁定后决定展示) -->
        <div v-if="editForm.exec_type === 'agent'" class="form-section">
          <div class="form-section-title">{{ t('misc.schedules.agentSection') }}</div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.titleLabel') }} <span class="required">*</span></label>
            <Input v-model="editForm.title" :placeholder="t('misc.schedules.phTitle')" />
          </div>
          <div class="form-row">
            <label class="form-label">prompt <span class="required">*</span></label>
            <Textarea v-model="editForm.prompt" :rows="9" />
          </div>
        </div>

        <div v-else class="form-section">
          <div class="form-section-title">{{ t('misc.schedules.shellSection') }}</div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.commandLabel') }} <span class="required">*</span></label>
            <Input
              v-model="editForm.command"
              :placeholder="t('misc.schedules.phCommand')"
              class-name="form-mono"
            />
          </div>
          <div class="form-row">
            <label class="form-label">{{ t('misc.schedules.cwdLabel') }}</label>
            <Input
              v-model="editForm.cwd"
              placeholder="/path/to/workdir"
              class-name="form-mono"
            />
          </div>
        </div>
      </div>

      <template #footer>
        <Button variant="secondary" :disabled="editing" @click="closeEdit">{{ t('misc.schedules.cancel') }}</Button>
        <Button :loading="editing" :disabled="editing" @click="submitEdit">
          {{ editing ? t('misc.schedules.saving') : t('misc.schedules.save') }}
        </Button>
      </template>
    </Modal>

    <!-- 完整日志弹窗 (R79 + R86 SSE) -->
    <Modal
      :model-value="!!logDialogRun"
      :title="liveCompleted ? t('misc.schedules.logTitleDone', { exit: liveExitCode !== null ? ' · exit=' + liveExitCode : '' }) : t('misc.schedules.logTitleLive')"
      size="lg"
      @update:model-value="(v: boolean) => { if (!v) closeLogDialog(); }"
    >
      <div v-if="logDialogRun" class="log-dialog-body">
        <p class="log-meta">
          run #{{ logDialogRun.id }} · {{ fmt(logDialogRun.started_at) }}
          <template v-if="logDialogRun.completed_at"> → {{ fmt(logDialogRun.completed_at) }}</template>
          <template v-if="logDialogRun.exit_code !== null"> · exit={{ logDialogRun.exit_code }}</template>
        </p>
        <div class="log-section">
          <div class="log-label">
            stdout
            <span class="log-count">{{ t('misc.schedules.charsCount', { n: ((liveStdout || logDialogRun.output) ?? '').length }) }}</span>
          </div>
          <pre class="log-pre log-pre-stdout">
            <span v-if="!(liveStdout || logDialogRun.output)" class="log-empty">{{ t('misc.schedules.emptyOutput') }}</span>
            <template v-else>{{ liveStdout || logDialogRun.output }}</template>
            <div ref="stdoutEndRef" />
          </pre>
        </div>
        <div class="log-section">
          <div class="log-label">
            stderr
            <span class="log-count">{{ t('misc.schedules.charsCount', { n: ((liveStderr || logDialogRun.error) ?? '').length }) }}</span>
          </div>
          <pre class="log-pre log-pre-stderr">
            <span v-if="!(liveStderr || logDialogRun.error)" class="log-empty">{{ t('misc.schedules.emptyOutput') }}</span>
            <template v-else>{{ liveStderr || logDialogRun.error }}</template>
            <div ref="stderrEndRef" />
          </pre>
        </div>
      </div>
    </Modal>

    <!-- 删除二次确认 (R6) -->
    <ConfirmDialog
      :open="!!pendingDelete"
      :title="t('misc.schedules.deleteConfirmTitle')"
      :message="pendingDelete
        ? t('misc.schedules.deleteConfirmMsg', { name: pendingDelete.name })
        : ''"
      :confirm-text="t('misc.schedules.delete')"
      :cancel-text="t('misc.schedules.cancel')"
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
.schedules-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
}

/* Header */
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
.header-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
/* R59+: header-meta 内所有交互元素统一 30px (跟 Button / .quick-link /
   .sort-select 等同档). 之前 font 13px + padding 4px 12px 自然高 ~22-24px,
   比 Button 30px 矮. 现在 inline-flex + height:30px + padding:0 12px +
   align-items:center, 文本垂直居中. */
.meta-count {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: var(--color-bg);
  border-radius: 999px;
  box-sizing: border-box;
}

/* Toolbar */
/* 不加 overflow-x: auto —— 它会把内部 Select 的绝对定位下拉裁剪在工具栏边界内
   （overflow 非 visible 的容器 = 裁剪上下文, 下拉 z-index 再高也穿不出去）。
   窄屏场景由 .toolbar-filters 的 flex-wrap: wrap 换行兜底, 不需要横向滚动。 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}
.toolbar-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  flex: 1;
}
.filter-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.filter-label {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.filter-control {
  width: 160px;
}
.filter-sep {
  font-size: 12px;
  color: var(--color-text-muted);
}
.show-deleted {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

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

/* Card list */
.card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1000px;
}
.schedule-card {
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.schedule-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}
.schedule-card-deleted {
  opacity: 0.65;
  border-color: var(--tw-red-200);
  background: var(--tw-red-50);
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.card-info {
  flex: 1;
  min-width: 0;
}
.card-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}
.card-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.card-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--color-text);
}
.card-command {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--tw-gray-700);
  background: var(--color-bg);
  padding: 6px 10px;
  border-radius: var(--radius);
  word-break: break-all;
}
.card-desc {
  margin-top: 8px;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--radius);
  transition: background 0.15s;
}
.card-desc:hover {
  background: var(--color-bg);
}
.desc-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.meta-item { display: inline-flex; align-items: center; gap: 4px; }
.meta-value {
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.meta-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.runs-toggle-row {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
}

/* Chips */
.chip {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  background: var(--color-bg);
  color: var(--color-text-muted);
}
.chip-deleted { background: var(--tw-red-100); color: var(--tw-red-700); }
.chip-enabled { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.chip-disabled { background: var(--tw-gray-100); color: var(--tw-gray-500); }
.chip-exec { background: var(--tw-purple-100); color: var(--tw-purple-800); }
.chip-cron { background: var(--tw-indigo-100); color: var(--tw-indigo-800); }
.chip-once { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.chip-expr {
  background: var(--tw-blue-50);
  color: var(--tw-blue-700);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.chip-skip { background: var(--tw-gray-100); color: var(--tw-gray-500); }

/* Badge (shell exit) */
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.badge-running { background: var(--tw-yellow-100); color: var(--tw-yellow-800); }
.badge-success { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.badge-failed { background: var(--tw-red-100); color: var(--tw-red-800); }

/* Schedule form (新建/编辑 modal) */
.schedule-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-row-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
}
.form-section {
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.exec-locked {
  padding: 7px 12px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--color-text);
}
:deep(.form-mono input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Log dialog (R79 + R86) */
.log-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.log-meta {
  margin: 0;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--color-text-muted);
}
.log-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.log-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
}
.log-count {
  font-weight: 400;
  color: var(--color-text-muted);
  margin-left: 4px;
}
.log-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 35vh;
  overflow: auto;
}
.log-pre-stdout {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  color: var(--color-text);
}
.log-pre-stderr {
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
  color: var(--tw-red-800);
}
.log-empty {
  color: var(--color-text-muted);
  font-style: italic;
}

/* Runs panel (R75) */
.runs-panel {
  margin-top: 10px;
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
}
.runs-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.runs-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.runs-panel-count {
  margin-left: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 400;
}
.runs-panel-pager {
  display: flex;
  gap: 6px;
}
.pager-btn {
  padding: 4px 10px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-elevated);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.15s;
}
.pager-btn:hover:not(:disabled) {
  background: var(--color-bg);
}
.pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.runs-empty {
  text-align: center;
  padding: 16px;
  font-size: 13px;
  color: var(--color-text-muted);
}
.runs-table-wrap {
  overflow-x: auto;
}
.runs-table {
  width: 100%;
  font-size: 12px;
  table-layout: fixed;
  border-collapse: collapse;
}
.runs-table th,
.runs-table td {
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--color-border);
}
.runs-table th {
  font-weight: 500;
  color: var(--color-text-muted);
  font-size: 11px;
  border-bottom: 1px solid var(--color-border-strong);
}
.col-time { width: 160px; }
.col-type { width: 64px; }
.col-status { width: 80px; }
.col-action { width: 96px; }
.text-right { text-align: right; }
.text-muted { color: var(--color-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.task-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--tw-blue-600);
  font-size: 12px;
}
.run-command {
  display: inline-block;
  padding: 2px 6px;
  background: var(--color-bg);
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
  color: var(--color-text);
}
.run-preview {
  margin: 4px 0 0;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.run-preview-stdout {
  color: var(--color-text-muted);
}
.run-preview-stderr {
  color: var(--tw-red-800);
}
.row-action-btn {
  padding: 3px 8px;
  border-radius: var(--radius);
  color: var(--tw-blue-600);
  background: transparent;
  border: 0;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.row-action-btn:hover:not(:disabled) {
  background: var(--tw-blue-50);
  text-decoration: underline;
}
.row-action-btn:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
  text-decoration: none;
}

/* ------------------------------------------------------------------ */
/*  移动端 (≤768px, 与 Assets.vue 同档)                                   */
/*  关注点: 桌面 .card-top 是 info+actions 横排不换行, 手机上 info      */
/*  被压到 ~150px 宽 → chips 每行一个字竖排成列. 改 column 后 info      */
/*  占满行宽; runs 表是 table-layout:fixed + width:100%, 手机上固定    */
/*  列宽按比例缩水把内容列挤成竖条, 给 min-width + wrap 横滚保住可读.  */
/* ------------------------------------------------------------------ */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 14px 16px 12px;
  }
  .header-meta {
    justify-content: space-between;
  }
  .toolbar {
    padding: 10px 16px;
  }
  .page-body {
    padding: 14px 16px 24px;
  }
  /* 时间区间 (两个 picker + →) 一行放不下时换行, 不挤压 picker */
  .filter-item {
    flex-wrap: wrap;
  }
  .filter-control {
    flex: 1;
    min-width: 140px;
  }

  .card-top {
    flex-direction: column;
    gap: 10px;
  }
  /* 操作按钮整行均分, 触控目标 ≥44px 高 */
  .card-actions {
    width: 100%;
  }
  .card-actions > * {
    flex: 1;
  }

  /* runs 表: 桌面 fixed 列宽总 ~560px, 手机按比例缩水内容列 → 撑最小宽
     走横向滚动, 首屏信息完整 */
  .runs-table {
    min-width: 640px;
  }

  /* 新建/编辑 modal 两列表单在手机上改单列 */
  .form-row-2col {
    grid-template-columns: 1fr;
  }
}
</style>
