<script setup lang="ts">
/* 功能: 需求点详情视图 — 完整镜像 Next.js src/app/requirements/[id]/page.tsx.
   sheet R16 字面要求.
   关注点 (与 master / Next 端 + 与现实分歧):
   - 完整复刻 master 9 大区块:
     ① ← 需求点列表回链 (URL ?project_id + ?version_id 携带);
     ② 头部卡片 (标题 + RequirementStatusFlow dropdown + 描述 + project / version
        / tags / priority / created / updated 元信息);
     ③ RequirementStatusStepper 状态进程条 (R78 W3 §4.1);
     ④ 反馈时间线 (R78 W3 §4.1, 合并 revisions + task events);
     ⑤ 附件列表 (R71, 含删除按钮);
     ⑥ 字段变更明细 (master inline RevisionTimeline, 字段级 diff);
     ⑦ 关联任务森林 (R60 §3.1 + R78 W3, root/sub-task 区分 + TaskByChip +
        TaskStatusChip + CreateRequirementTaskButton);
   - 数据源 (SPA 走 REST):
     - GET /api/requirements/[id]  → RequirementDetail (含 tasks + eligible_for_done)
     - GET /api/requirements/[id]/revisions  → revisions 列表
     - GET /api/requirements/[id]/attachments  → 附件列表
     - GET /api/projects/[id]  → 项目名 (单条)
     - GET /api/versions/[id]  → version 名 (单条)
     - GET /api/tasks/[id]/events  → 每个关联 task 的执行事件 (R40 G5 收口)
     - PATCH /api/requirements/[id]  → 状态切换 (由 RequirementStatusFlow 内部调用)
     - POST /api/tasks  → 新建关联 task (由 CreateRequirementTaskButton 内部调用)
     - POST /api/tasks/[id]/start  → 立即启动 (由 CreateRequirementTaskButton 内部调用)
     - DELETE /api/attachments/[id]  → 删附件 (由 RequirementAttachmentDeleteButton 调用)
   - 与 master / Next 端差异 (本视图主动分歧, 已在 commit 披露):
     (1) master 拼 task events 走 server-side raw SQL `SELECT ... FROM events
         WHERE task_id IN (?,?,?) AND type='status_change'` (page.tsx:159) +
         类型白名单 status_change; SPA 走 REST `GET /api/tasks/[id]/events` 逐
         个 task 拉 (N 次请求) + 不限 type (全展示: status_change / cost /
         tool_use / error / webhook_delivered 等). 差异主动披露:
         (a) N+1 vs batch: SPA N+1 由 G5 REST 一次一个 task 限定, R40 范围内
             不引 batch endpoint (master 是 SQL 单条 IN-list, 不暴露 REST), 接
             Promise.allSettled 摊平失败;
         (b) 类型白名单: master 只展示 status_change (反馈时间线主轴); SPA
             全展示, 工具调用 / 成本 / webhook 投递 也算执行记录, 给更完整的
             「这条需求点做了什么」视角;
         (c) 时间排序: master page.tsx:200 服务端 sort; SPA 客户端 sort
             (数组量级小, ≤50 event × N task, 微不足道).
     (2) master RevisionTimeline + FeedbackTimeline 是同数据两版式 (字段级
         diff vs 合并时间线). SPA 只保留一份: 把 master FeedbackTimeline 那套
         「actor chip + field + diff + 时间 + 回溯 task」直接作为「最近反馈与
         执行」主显示, 不再额外加一个 fields-diff 区块 (信息冗余). R78 W3
         §4.1 的"两段并列"在 master 是为了把 task events 区分开, SPA 拆成
         「revisions 字段变更」+「task events 任务执行」两段 (各走自己的
         视觉块 + 单独 link), 信息更清晰.
     (3) hash 路由下 `useRoute().query` 读 ?project_id + ?version_id (Next 用
         searchParams), 与 R15 RequirementNew 同款拍板.
     (4) 删除附件成功后, 父级 update state 移除本地行 (master router.refresh
         重拉 server data, SPA 没 server refresh 概念).
   - URL: #/requirements/[id]?project_id=X&version_id=Y (R107 R 列跟进). */

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  getRequirementDetail,
  updateRequirement,
  recalcRequirementProgress,
  listRequirementAttachments,
  listRequirementRevisions,
  parseRequirementDependencies,
  parseRequirementTags,
  formatAttachmentSize,
  type RequirementAttachment,
  type RequirementDetail,
  type RequirementRevision,
  type RequirementStatus,
  type RequirementTask,
} from '@/api/requirements';
import { getTaskEvents, type TaskEvent } from '@/api/task-events';
import {
  getProjectById,
  getVersionById,
} from '@/api/projects';
import { HttpError, isHttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import { useToast } from '@/composables/useToast';
import Loading from '@/components/Loading.vue';
import ErrorView from '@/components/ErrorView.vue';
import RequirementStatusFlow from '@/components/RequirementStatusFlow.vue';
import RequirementStatusStepper from '@/components/RequirementStatusStepper.vue';
import RequirementAttachmentDeleteButton from '@/components/RequirementAttachmentDeleteButton.vue';
import CreateRequirementTaskButton from '@/components/CreateRequirementTaskButton.vue';
import TaskByChip from '@/components/TaskByChip.vue';
import TaskStatusChip from '@/components/TaskStatusChip.vue';

/* ------------------------------------------------------------------ */
/*  URL 参数 (R107 R 列跟进)                                           */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();

// i18n (W3c): 用户可见字符串走 t('requirements.*'), 文案源
//   spa/src/i18n/locales/{zh-CN,en-US}/requirements.json; 协议常量
//   (event type / actor 类型 / 颜色 class) 不迁移.
const { t } = useI18n();

const requirementId = computed<string>(() => {
  const id = route.params.requirementId;
  return typeof id === 'string' ? id : Array.isArray(id) ? id[0] ?? '' : '';
});

const presetProjectId = computed<string>(() => {
  const v = route.query.project_id;
  return typeof v === 'string' ? v : '';
});
const presetVersionId = computed<string>(() => {
  const v = route.query.version_id;
  return typeof v === 'string' ? v : '';
});

/** 根据 query + req 自带 project_id / version_id 构造"← 需求点列表" href.
    与 master buildBackToListHref 同款. */
function buildBackToListHref(
  projectId: string | undefined,
  versionId: string | undefined,
): string {
  if (!projectId) return '/requirements';
  const qs = new URLSearchParams();
  qs.set('project_id', projectId);
  if (versionId) qs.set('version_id', versionId);
  return `/requirements?${qs.toString()}`;
}

/* ------------------------------------------------------------------ */
/*  状态                                                                */
/* ------------------------------------------------------------------ */

const toast = useToast();

const detail = ref<RequirementDetail | null>(null);
const revisions = ref<RequirementRevision[]>([]);
const attachments = ref<RequirementAttachment[]>([]);
/** task events — Map<taskId, TaskEvent[]>. 单 task fetch 失败 = 数组空, 不阻断整体. */
const taskEventsByTaskId = ref<Map<string, TaskEvent[]>>(new Map());

const projectName = ref<string>('');
const versionName = ref<string>('');

const loading = ref<boolean>(true);
const loadError = ref<string | null>(null);
const retrying = ref<boolean>(false);
/** 404 = 需求点不存在 / 无权限 → ErrorView 标题切 notFound 文案 (不靠中文子串判断). */
const notFound = ref<boolean>(false);

/** rootTaskId — 森林里 created 最早且无 dispatched_by 的 = root. 与 master
    page.tsx:121 同款 (R78 W3 §4.1). 多个无 dispatched_by 的并行 root,
    这里只高亮最早的那个 (master 拍板口径). */
const rootTaskId = computed<string | null>(() => {
  const list = detail.value?.tasks;
  if (!list) return null;
  const earliest = list.find((t) => t.dispatched_by_task_id == null);
  return earliest?.id ?? null;
});

/** backHref — 优先用 query (新流程从项目页面进来); 兜底用 req 自带的. */
const backHref = computed<string>(() => {
  const p = presetProjectId.value || detail.value?.project_id;
  const v =
    presetVersionId.value ||
    detail.value?.version_id ||
    undefined;
  return buildBackToListHref(p, v);
});

/* ------------------------------------------------------------------ */
/*  加载                                                                */
/* ------------------------------------------------------------------ */

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  notFound.value = false;
  try {
    const req = await getRequirementDetail(requirementId.value);
    detail.value = req;

    // 项目 + version 名 — 并行拉, 失败走兜底 (R64 详情页无 project 标识 → 「未分类」)
    const [pjRes, verRes] = await Promise.allSettled([
      getProjectById(req.project_id),
      req.version_id ? getVersionById(req.version_id) : Promise.resolve(null),
    ]);
    projectName.value =
      pjRes.status === 'fulfilled' && pjRes.value?.name
        ? pjRes.value.name
        : t('requirements.detail.uncategorized');
    versionName.value =
      req.version_id && verRes.status === 'fulfilled' && verRes.value?.name
        ? verRes.value.name
        : t('requirements.detail.versionNone');

    // revisions + attachments 并行拉, 失败静默 (R107 + R71 端点是「详情附」,
    // 失败不影响主视图)
    const [revRes, attRes] = await Promise.allSettled([
      listRequirementRevisions(req.id, { limit: 100 }),
      listRequirementAttachments(req.id),
    ]);
    revisions.value =
      revRes.status === 'fulfilled' ? revRes.value : [];
    attachments.value =
      attRes.status === 'fulfilled' ? attRes.value : [];

    // R40 (G5 收口): 关联 task 的 events — 每个 task 单独拉 (REST 端点
    // 不支持 IN-list, master 是 server-side raw SQL 拼的), Promise.allSettled
    // 摊平失败, 单 task 拉不到 = 该 task events = 空数组 (与 R14 vault
    // revisions 同款「失败静默」).
    const taskIds = req.tasks.map((t) => t.id);
    const evResults = await Promise.allSettled(
      taskIds.map((id) => getTaskEvents(id, { limit: 50 })),
    );
    const map = new Map<string, TaskEvent[]>();
    taskIds.forEach((id, i) => {
      const r = evResults[i];
      map.set(
        id,
        r && r.status === 'fulfilled' ? r.value : [],
      );
    });
    taskEventsByTaskId.value = map;
  } catch (e: unknown) {
    if (isHttpError(e)) {
      notFound.value = e.status === 404;
      loadError.value = e.status === 404
        ? t('requirements.detail.errNotFound')
        : e.message || t('requirements.detail.errHttp', { status: e.status });
    } else if (e instanceof Error) {
      loadError.value = t('requirements.detail.errNetwork', { msg: e.message });
    } else {
      loadError.value = t('requirements.detail.errGeneric');
    }
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function onRetry(): void {
  retrying.value = true;
  void loadAll();
}

onMounted(() => {
  void loadAll();
});

/* route params 变化 → 重新拉 (从 /requirements/[id] 跳到 /requirements/[other]) */
watch(requirementId, () => {
  void loadAll();
});

/* ------------------------------------------------------------------ */
/*  子组件事件                                                          */
/* ------------------------------------------------------------------ */

/** 状态切换后 → 同步本地 detail.status (避免整页 re-fetch, 体验更顺). */
function onStatusChanged(next: RequirementStatus): void {
  if (!detail.value) return;
  detail.value = { ...detail.value, status: next };
}

/* ------------------------------------------------------------------ */
/*  R196 完成度 (显示 + 手动修正 + 规则重算)                              */
/* ------------------------------------------------------------------ */

const progressSaving = ref(false);
const progressRecalcing = ref(false);
/** 修正表单展开标记 (点「修正」开, 保存/收起关). */
const progressEditOpen = ref(false);
/** 手动修正表单: 空字符串 = 清空 (null). */
const progressEditValue = ref<string>('');
const progressEditNote = ref<string>('');

/** progress_source 显示文案 — 走 i18n (原模块级常量非响应式, 改函数). */
function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    rule: 'requirements.detail.sourceRule',
    manual: 'requirements.detail.sourceManual',
    ai: 'requirements.detail.sourceAi',
  };
  const key = map[s];
  return key ? t(key) : s;
}

const progressPct = computed<number | null>(() => {
  const v = detail.value?.progress;
  return v === null || v === undefined ? null : v;
});

function openProgressEdit(): void {
  progressEditOpen.value = true;
  progressEditValue.value =
    progressPct.value === null ? '' : String(progressPct.value);
  progressEditNote.value = detail.value?.progress_note ?? '';
}

/** 手动修正完成度 — PATCH {progress, progress_note} (后端固定 progress_source='manual'). */
async function saveProgress(): Promise<void> {
  if (!detail.value || progressSaving.value) return;
  const raw = progressEditValue.value.trim();
  const value = raw === '' ? null : Number(raw);
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
    toast.error(t('requirements.detail.errProgressRange'));
    return;
  }
  progressSaving.value = true;
  try {
    const updated = await updateRequirement(detail.value.id, {
      progress: value,
      progress_note: progressEditNote.value.trim() || null,
    });
    detail.value = { ...detail.value, ...updated };
    progressEditOpen.value = false;
    toast.success(
      value === null
        ? t('requirements.detail.progressCleared')
        : t('requirements.detail.progressUpdated', { value }),
    );
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('requirements.detail.progressSaveFailed'));
  } finally {
    progressSaving.value = false;
  }
}

/** 规则重算 — POST /api/requirements/[id]/progress (source='rule', note 自动生成). */
async function recalcProgress(): Promise<void> {
  if (!detail.value || progressRecalcing.value) return;
  progressRecalcing.value = true;
  try {
    const updated = await recalcRequirementProgress(detail.value.id);
    detail.value = { ...detail.value, ...updated };
    toast.success(t('requirements.detail.recalcDone', { value: updated.progress }));
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : t('requirements.detail.recalcFailed'));
  } finally {
    progressRecalcing.value = false;
  }
}

/** 删除附件后 → 同步本地 attachments 列表. */
function onAttachmentDeleted(id: string): void {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

/** 新建 task 后 → 主动拉一次 detail 拿到最新 tasks + eligible_for_done. */
async function onTaskCreated(taskId: string): Promise<void> {
  toast.success(t('requirements.detail.taskCreatedToast'));
  // SPA 跳到 /tasks/[id] (TaskDetailView R19), 让用户看即时反馈.
  // 与 R15 RequirementNew 拍板"创建后跳列表"不同: 本视图是详情页,
  // 用户期待看刚建任务详情; 而且 R107 R 列要求 context 携带, 但新建任务
  // 本身已是新会话锚点, 不需带 query.
  void router.push(`/tasks/${taskId}`);
  // 顺手刷新 detail 拿最新 tasks (后台, 不阻塞跳转).
  try {
    const req = await getRequirementDetail(requirementId.value);
    detail.value = req;
  } catch {
    // 静默失败: 用户已在跳过去的任务页, 回头本视图再刷新即可
  }
}

/* ------------------------------------------------------------------ */
/*  派生                                                                */
/* ------------------------------------------------------------------ */

const tags = computed<string[]>(() => {
  if (!detail.value) return [];
  return parseRequirementTags(detail.value.tags);
});

/** 主反馈时间线: revisions (字段变更) + task events (执行事件) 两段各排;
 * SPA 不像 master 把两类 merge 到一条时间线 (master 也只在 FeedbackTimeline
 * 内合并, RevisionTimeline 仍独立, 故 master 实际是两段+合并的混合). */
const revisionEntries = computed<
  Array<{
    kind: 'revision';
    rev: RequirementRevision;
    createdAt: string;
  }>
>(() => {
  return revisions.value
    .map((rev) => ({
      kind: 'revision' as const,
      rev,
      createdAt: rev.created_at,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
});

const visibleRevisions = computed(() => revisionEntries.value.slice(0, 10));
const revisionCount = computed<number>(() => revisions.value.length);

/** task events 派生: 每个 task 的 events 平铺成 (task + event) 元组, 按
 * created_at DESC 排; 拼上 task 标题方便显示. 与 revisions 时间线视觉对齐
 * (同 card 样式, 见模板). */
const taskEventEntries = computed<
  Array<{
    kind: 'task_event';
    ev: TaskEvent;
    createdAt: string;
    taskId: string;
    taskTitle: string;
  }>
>(() => {
  const out: Array<{
    kind: 'task_event';
    ev: TaskEvent;
    createdAt: string;
    taskId: string;
    taskTitle: string;
  }> = [];
  const taskTitleById = new Map<string, string>();
  if (detail.value) {
    for (const t of detail.value.tasks) taskTitleById.set(t.id, t.title);
  }
  for (const [taskId, evs] of taskEventsByTaskId.value.entries()) {
    const taskTitle = taskTitleById.get(taskId) ?? t('requirements.detail.deletedTask');
    for (const ev of evs) {
      // 后端兜底 created_at = null; 用稳定 fallback (按 id 排序时可能乱序,
      // 但 events 表 id DESC 保证有序, 详见 G5 route.ts:50 comment).
      out.push({
        kind: 'task_event' as const,
        ev,
        createdAt: ev.created_at ?? '',
        taskId,
        taskTitle,
      });
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
});

const visibleTaskEvents = computed(() => taskEventEntries.value.slice(0, 10));
const taskEventCount = computed<number>(() =>
  Array.from(taskEventsByTaskId.value.values()).reduce(
    (acc, evs) => acc + evs.length,
    0,
  ),
);

/** 关联 task id 列表 (用于 task events 段底部的「看每个 task 右侧时间线」chip). */
const taskIdsForFooter = computed<string[]>(() => {
  if (!detail.value) return [];
  return detail.value.tasks.map((t) => t.id);
});

/* ------------------------------------------------------------------ */
/*  渲染辅助                                                            */
/* ------------------------------------------------------------------ */

const ACTOR_COLOR: Record<string, string> = {
  agent: 'bg-purple-100 text-purple-700',
  user: 'bg-blue-100 text-blue-700',
  system: 'bg-gray-100 text-gray-600',
};
/** 变更执行者显示文案 — 走 i18n requirements.actor.* (公共 key, 主控预置). */
function actorLabel(a: string): string {
  return t(`requirements.actor.${a}`);
}
/** 字段显示文案 — 6 个公共字段走 requirements.field.*, progress 系走 detail 私有
    key; 未知字段 = 原 key (与 Next 端保持兜底展示). */
const FIELD_KEY_MAP: Record<string, string> = {
  title: 'requirements.field.title',
  description: 'requirements.field.description',
  status: 'requirements.field.status',
  priority: 'requirements.field.priority',
  tags: 'requirements.field.tags',
  version_id: 'requirements.field.version_id',
  progress: 'requirements.detail.fieldProgress',
  progress_note: 'requirements.detail.fieldProgressNote',
};
function fieldLabel(f: string): string {
  const key = FIELD_KEY_MAP[f];
  return key ? t(key) : f;
}

function diffPreview(
  oldVal: string | null,
  newVal: string | null,
): string {
  const o = oldVal === null ? '∅' : oldVal;
  const n = newVal === null ? '∅' : newVal;
  return `${o} → ${n}`;
}

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function fmtDate(iso: string): string {
  // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
  return parseDbTime(iso)?.toLocaleString('zh-CN') ?? iso;
}

function fmtShortDate(iso: string): string {
  return parseDbTime(iso)?.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }) ?? iso;
}

/* ------------------------------------------------------------------ */
/*  Task event 渲染辅助 (R40 G5 收口)                                  */
/* ------------------------------------------------------------------ */

// event type → 视觉颜色 (点 + chip 背景). 与 master TASK_STATUS_DOT
// (feedback-timeline.tsx:101) 同款 status 调色, 扩展到其它 type 用中性色.
/** event type → 显示文案 (走 i18n; 未知 type = 原样展示协议值). */
const TASK_EVENT_TYPE_KEY: Record<string, string> = {
  status_change: 'requirements.detail.eventStatusChange',
  tool_use: 'requirements.detail.eventToolUse',
  tool_result: 'requirements.detail.eventToolResult',
  message: 'requirements.detail.eventMessage',
  cost: 'requirements.detail.eventCost',
  error: 'requirements.detail.eventError',
  webhook_delivered: 'requirements.detail.eventWebhookDelivered',
  webhook_delivery_failed: 'requirements.detail.eventWebhookFailed',
  parent_notify_dispatched: 'requirements.detail.eventParentNotify',
};
function eventTypeLabel(type: string): string {
  const key = TASK_EVENT_TYPE_KEY[type];
  return key ? t(key) : type;
}
const TASK_EVENT_DOT_COLOR: Record<string, string> = {
  status_change: 'bg-sky-400',
  tool_use: 'bg-indigo-400',
  tool_result: 'bg-purple-400',
  message: 'bg-blue-400',
  cost: 'bg-emerald-400',
  error: 'bg-red-400',
  webhook_delivered: 'bg-teal-400',
  webhook_delivery_failed: 'bg-orange-400',
  parent_notify_dispatched: 'bg-yellow-400',
};
// chip 背景 — 比 -400 浅一档, 用作 text 颜色同源. 显式映射而非正则转换
// (避免 'bg-orange-400' 拆不出 'orange' 类名时的脆弱).
const TASK_EVENT_CHIP_COLOR: Record<string, string> = {
  status_change: 'bg-sky-100 text-sky-700',
  tool_use: 'bg-indigo-100 text-indigo-700',
  tool_result: 'bg-purple-100 text-purple-700',
  message: 'bg-blue-100 text-blue-700',
  cost: 'bg-emerald-100 text-emerald-700',
  error: 'bg-red-100 text-red-700',
  webhook_delivered: 'bg-teal-100 text-teal-700',
  webhook_delivery_failed: 'bg-orange-100 text-orange-700',
  parent_notify_dispatched: 'bg-yellow-100 text-yellow-700',
};

/** 把 ev.data 安全展平成「key=value」短摘要. data 可能是 object / 数组 / 原文字符串 /
 * null/undefined; 一律 JSON.stringify (非 string 走 JSON.stringify 兜底). 防 XSS:
 * 模板里只走 {{ }} 文本插值, Vue 自动转义. 最多取前 2 字段防止太长. */
function eventSummary(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return trunc(data, 60);
  if (Array.isArray(data)) {
    return trunc(JSON.stringify(data), 60);
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>).slice(0, 2);
    if (entries.length === 0) return '';
    return entries
      .map(([k, v]) => {
        const vs =
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? String(v)
            : JSON.stringify(v);
        return `${k}=${trunc(vs, 30)}`;
      })
      .join(' · ');
  }
  return String(data);
}

/** status_change 事件的专用摘要: "from → to". 其它 type 用 eventSummary. */
function eventLine(ev: TaskEvent): string {
  if (ev.type === 'status_change' && ev.data && typeof ev.data === 'object') {
    const d = ev.data as Record<string, unknown>;
    const from = typeof d.from === 'string' ? d.from : null;
    const to = typeof d.to === 'string' ? d.to : null;
    if (from && to) return `${from} → ${to}`;
    if (to) return t('requirements.detail.startedTo', { to });
  }
  const summary = eventSummary(ev.data);
  return summary || eventTypeLabel(ev.type);
}

/* ------------------------------------------------------------------ */
/*  任务行渲染 (内联, 不抽组件)                                          */
/* ------------------------------------------------------------------ */

function taskDeps(t: RequirementTask): string[] {
  return parseRequirementDependencies(t.depends_on);
}
</script>

<template>
  <div class="max-w-4xl mx-auto p-6">
    <!-- ① ← 需求点列表回链 -->
    <div class="mb-4">
      <RouterLink
        :to="backHref"
        class="text-sm text-blue-600 hover:underline"
      >
        {{ t('requirements.detail.backLink') }}
      </RouterLink>
    </div>

    <!-- 加载态 -->
    <Loading v-if="loading" />

    <!-- 错误态 -->
    <ErrorView
      v-else-if="loadError"
      :title="notFound ? t('requirements.detail.notFoundTitle') : t('requirements.detail.loadFailedTitle')"
      :description="loadError"
      variant="error"
      :retrying="retrying"
      @retry="onRetry"
    />

    <!-- 主内容 -->
    <template v-else-if="detail">
      <!-- ② 头部卡片 -->
      <div class="bg-white rounded-lg shadow p-6 mb-6">
        <div class="flex items-start justify-between gap-3 mb-4">
          <h1 class="text-2xl font-bold flex-1">{{ detail.title }}</h1>
          <RequirementStatusFlow
            :requirement-id="detail.id"
            :initial-status="detail.status"
            :eligible-for-done="detail.eligible_for_done"
            @changed="onStatusChanged"
          />
        </div>
        <div
          v-if="detail.description"
          class="text-gray-700 whitespace-pre-wrap mb-4"
        >
          {{ detail.description }}
        </div>
        <div class="flex flex-wrap gap-3 text-xs text-gray-500">
          <RouterLink
            :to="`/requirements?project_id=${detail.project_id}`"
            class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            {{ projectName }}
          </RouterLink>
          <RouterLink
            v-if="detail.version_id"
            :to="`/requirements?version_id=${detail.version_id}`"
            class="px-1.5 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100"
          >
            v·{{ versionName }}
          </RouterLink>
          <span
            v-else
            class="px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700"
          >
            {{ t('requirements.detail.versionNone') }}
          </span>
          <span
            v-for="tag in tags"
            :key="tag"
            class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600"
          >
            #{{ tag }}
          </span>
          <span v-if="detail.priority !== null">{{ t('requirements.detail.priorityLabel', { priority: detail.priority }) }}</span>
          <span>{{ t('requirements.detail.createdAt', { time: fmtDate(detail.created_at) }) }}</span>
          <span>{{ t('requirements.detail.updatedAt', { time: fmtDate(detail.updated_at) }) }}</span>
        </div>
      </div>

      <!-- ③ 状态进程条 -->
      <RequirementStatusStepper :current="detail.status" />

      <!-- ③-1 R196 完成度卡片: 显示 + 手动修正 + 规则重算.
           口径: 100% = done 终态 (部署+验证通过); 0-90 由 task 聚合. -->
      <div class="bg-white rounded-lg shadow mb-6 p-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="font-semibold">{{ t('requirements.detail.progressTitle') }}</h2>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              :disabled="progressRecalcing"
              @click="recalcProgress"
            >
              {{ progressRecalcing ? t('requirements.detail.recalcing') : t('requirements.detail.recalcBtn') }}
            </button>
            <button
              type="button"
              class="text-xs px-2 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50"
              @click="openProgressEdit"
            >
              {{ t('requirements.detail.fixBtn') }}
            </button>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <div class="flex-1 h-3 rounded-full bg-gray-100 overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              :class="progressPct === null ? '' : progressPct >= 100 ? 'bg-green-500' : progressPct >= 90 ? 'bg-blue-500' : 'bg-amber-500'"
              :style="{ width: `${progressPct ?? 0}%` }"
            />
          </div>
          <span class="text-sm font-semibold whitespace-nowrap">
            {{ progressPct === null ? t('requirements.detail.notEvaluated') : `${progressPct}%` }}
          </span>
          <span
            v-if="detail.progress_source"
            class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 whitespace-nowrap"
          >
            {{ sourceLabel(detail.progress_source) }}
          </span>
        </div>
        <p v-if="detail.progress_note" class="text-xs text-gray-500 mt-2" :title="detail.progress_updated_at ?? ''">
          {{ detail.progress_note }}
        </p>
        <p v-else class="text-xs text-gray-400 mt-2">
          {{ t('requirements.detail.progressHint') }}
        </p>
        <!-- 修正表单 (点「修正」展开) -->
        <div v-if="progressEditOpen" class="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
          <input
            v-model="progressEditValue"
            type="number"
            min="0"
            max="100"
            :placeholder="t('requirements.detail.progressPlaceholder')"
            class="w-32 px-2 py-1 text-sm border rounded"
          />
          <input
            v-model="progressEditNote"
            type="text"
            :placeholder="t('requirements.detail.progressNotePlaceholder')"
            class="flex-1 min-w-[160px] px-2 py-1 text-sm border rounded"
          />
          <button
            type="button"
            class="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="progressSaving"
            @click="saveProgress"
          >
            {{ progressSaving ? t('requirements.detail.saving') : t('requirements.detail.saveBtn') }}
          </button>
        </div>
      </div>

      <!-- ④-1 最近反馈 (revisions 字段变更, 单独一段) -->
      <div class="bg-white rounded-lg shadow mb-6">
        <div class="p-4 border-b">
          <h2 class="font-semibold">
            {{ t('requirements.detail.feedbackTitle', { n: revisionCount }) }}
          </h2>
        </div>
        <div v-if="visibleRevisions.length === 0" class="p-6 text-center text-sm text-gray-500">
          {{ t('requirements.detail.noRevisions') }}
        </div>
        <ul v-else class="divide-y">
          <li
            v-for="(entry, i) in visibleRevisions"
            :key="`rev-${entry.rev.id}-${i}`"
            class="p-4 flex items-start gap-3"
          >
            <span
              :class="[
                'text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap',
                ACTOR_COLOR[entry.rev.actor_type] ?? 'bg-gray-100 text-gray-600',
              ]"
            >
              {{ actorLabel(entry.rev.actor_type) }}
            </span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 text-sm">
                <span class="font-medium text-gray-900">
                  {{ fieldLabel(entry.rev.field) }}
                </span>
                <span
                  class="text-xs text-gray-500 truncate"
                  :title="`${entry.rev.old_value ?? '∅'} → ${entry.rev.new_value ?? '∅'}`"
                >
                  {{ trunc(entry.rev.old_value ?? '∅', 24) }} →
                  {{ trunc(entry.rev.new_value ?? '∅', 24) }}
                </span>
              </div>
              <div class="text-xs text-gray-400 mt-0.5">
                {{ fmtShortDate(entry.rev.created_at) }}
                <span v-if="entry.rev.actor_id && entry.rev.actor_id !== 'system'">
                  · {{ entry.rev.actor_id }}
                </span>
                <RouterLink
                  v-if="entry.rev.task_id"
                  :to="`/tasks/${entry.rev.task_id}`"
                  class="ml-1 text-blue-600 hover:underline"
                >
                  {{ t('requirements.detail.traceTask') }}
                </RouterLink>
              </div>
            </div>
          </li>
        </ul>
        <div
          v-if="revisionCount > visibleRevisions.length"
          class="px-4 py-3 border-t flex flex-wrap items-center justify-center gap-x-4 gap-y-1"
        >
          <a
            :href="`/api/requirements/${detail.id}/revisions`"
            target="_blank"
            rel="noreferrer"
            class="text-xs text-blue-600 hover:underline"
            :title="t('requirements.detail.viewAllRevisionsTitle')"
          >
            {{ t('requirements.detail.viewAllRevisions', { n: revisionCount }) }}
          </a>
        </div>
      </div>

      <!-- ④-2 Task 执行事件 (R40 G5 收口, 单独一段) -->
      <div class="bg-white rounded-lg shadow mb-6">
        <div class="p-4 border-b">
          <h2 class="font-semibold">
            {{ t('requirements.detail.taskEventsTitle', { n: taskEventCount }) }}
          </h2>
        </div>
        <div v-if="visibleTaskEvents.length === 0" class="p-6 text-center text-sm text-gray-500">
          <template v-if="detail.tasks.length === 0">
            {{ t('requirements.detail.noLinkedTasks') }}
          </template>
          <template v-else>
            {{ t('requirements.detail.noTaskEvents') }}
          </template>
        </div>
        <ul v-else class="divide-y">
          <li
            v-for="(entry, i) in visibleTaskEvents"
            :key="`tev-${entry.ev.id ?? 'null'}-${entry.taskId}-${i}`"
            class="p-4 flex items-start gap-3"
          >
            <span
              :class="[
                'inline-block w-2 h-2 rounded-full mt-1.5 shrink-0',
                TASK_EVENT_DOT_COLOR[entry.ev.type] ?? 'bg-gray-400',
              ]"
              :title="entry.ev.type"
            />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 text-sm flex-wrap">
                <span
                  :class="[
                    'text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap',
                    TASK_EVENT_CHIP_COLOR[entry.ev.type] ?? 'bg-gray-100 text-gray-600',
                  ]"
                >
                  {{ eventTypeLabel(entry.ev.type) }}
                </span>
                <span class="text-gray-700 truncate" :title="eventLine(entry.ev)">
                  {{ eventLine(entry.ev) }}
                </span>
                <RouterLink
                  :to="`/tasks/${entry.taskId}`"
                  class="text-xs text-blue-600 hover:underline truncate"
                  :title="entry.taskTitle"
                >
                  · {{ trunc(entry.taskTitle, 28) }}
                </RouterLink>
              </div>
              <div class="text-xs text-gray-400 mt-0.5">
                {{ entry.createdAt ? fmtShortDate(entry.createdAt) : t('requirements.detail.timeUnknown') }}
              </div>
            </div>
          </li>
        </ul>
        <div
          v-if="taskIdsForFooter.length > 0"
          class="px-4 py-3 border-t flex flex-wrap items-center justify-center gap-x-4 gap-y-1"
        >
          <span class="text-xs text-gray-600">
            {{ t('requirements.detail.execRecords', { n: taskEventCount }) }}
            <template
              v-for="(id, i) in taskIdsForFooter.slice(0, 3)"
              :key="id"
            >
              <span v-if="i > 0">, </span>
              <RouterLink
                :to="`/tasks/${id}`"
                class="text-blue-600 hover:underline font-mono"
                :title="t('requirements.detail.taskLinkTitle', { id: id.slice(0, 8) })"
              >
                #{{ id.slice(0, 8) }}
              </RouterLink>
            </template>
            <span v-if="taskIdsForFooter.length > 3" class="text-gray-400">
              {{ t('requirements.detail.andMore', { n: taskIdsForFooter.length }) }}
            </span>
            <span class="text-gray-400"> {{ t('requirements.detail.footerHint') }}</span>
          </span>
        </div>
      </div>

      <!-- ⑤ 附件列表 -->
      <div class="bg-white rounded-lg shadow mb-6">
        <div class="p-4 border-b">
          <h2 class="font-semibold">{{ t('requirements.detail.attachmentsTitle', { n: attachments.length }) }}</h2>
        </div>
        <div v-if="attachments.length === 0" class="p-6 text-center text-sm text-gray-500">
          {{ t('requirements.detail.noAttachments') }}
        </div>
        <ul v-else class="divide-y">
          <li
            v-for="a in attachments"
            :key="a.id"
            class="p-4 flex items-center gap-3"
          >
            <div class="flex-1 min-w-0">
              <a
                :href="`/api/attachments/${a.id}`"
                target="_blank"
                rel="noreferrer"
                class="text-blue-600 hover:underline truncate block"
              >
                {{ a.filename }}
              </a>
              <div class="text-xs text-gray-500 mt-0.5">
                {{ a.media_type }} · {{ formatAttachmentSize(a.size_bytes) }}
              </div>
            </div>
            <RequirementAttachmentDeleteButton
              :attachment-id="a.id"
              @deleted="onAttachmentDeleted"
            />
          </li>
        </ul>
      </div>

      <!-- ⑦ 关联任务森林 -->
      <div class="bg-white rounded-lg shadow">
        <div class="p-4 border-b flex items-center justify-between">
          <h2 class="font-semibold">{{ t('requirements.detail.relatedTasksTitle', { n: detail.tasks.length }) }}</h2>
          <CreateRequirementTaskButton
            :requirement-id="detail.id"
            :project-id="detail.project_id"
            :version-id="detail.version_id"
            @created="onTaskCreated"
          />
        </div>
        <div v-if="detail.tasks.length === 0" class="p-8 text-center text-sm text-gray-500">
          {{ t('requirements.detail.noRelatedTasks') }}
        </div>
        <div v-else class="divide-y">
          <div
            v-for="task in detail.tasks"
            :key="task.id"
            class="p-4"
          >
            <div class="flex items-center gap-2 flex-wrap">
              <span
                v-if="task.id === rootTaskId"
                class="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold"
                :title="t('requirements.detail.rootTaskTitle')"
              >
                root
              </span>
              <span
                v-else
                class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500"
              >
                sub-task
              </span>
              <RouterLink
                :to="`/tasks/${task.id}`"
                class="font-medium text-gray-900 hover:text-blue-600"
              >
                {{ task.title }}
              </RouterLink>
            </div>
            <div class="flex items-center gap-2 mt-1 text-xs text-gray-500 flex-wrap">
              <span>{{ t('requirements.detail.statusLabel', { status: task.status }) }}</span>
              <span v-if="taskDeps(task).length > 0">{{ t('requirements.detail.depsLabel', { n: taskDeps(task).length }) }}</span>
              <TaskByChip v-if="task.dispatched_by_task_id" :dispatched-by-task-id="task.dispatched_by_task_id" />
              <TaskStatusChip v-if="task.latest_checkpoint_status" :status="task.latest_checkpoint_status" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
