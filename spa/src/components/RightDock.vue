<script setup lang="ts">
/* 功能: 任务详情右侧 dock — 镜像 master right-dock.tsx 4 面板 accordion:
   详情 / 时间线 / Checkpoints / Commits.

   R56-A3.3 (C1): 替换 SPA 旧版 TaskDetailsPanel.vue (仅关联任务), 1:1 拉齐 master.
   - 4 面板 accordion: 一次只一个展开, 折叠的 panel shrink-0 顶 header,
     展开的 panel flex-1 自动撑满 dock 剩余高度 (master R37 CSS flex 同款).
   - panel 折叠态由 TaskDetailView 通过 :collapsed prop 传入, 本组件纯展示.
   - 父级不传 height map: master R37 后 height map 已死代码, 纯 CSS flex 撑.
   - 链接走 SPA hash 路由 (#/tasks/<id>) + 需求点 (#/requirements/<id>).

   关注点:
   - 详情面板内部 SubSection 折叠态 = 本地 state, 切 task 自动重置.
   - timeline / checkpoints / commits 三面板各自 fetch + 单次刷新键.
   - 关系图 (R62: 派发 / 继承 / 依赖 全在一张图) + 需求点关联走 SubSection. */
import { computed, onMounted, ref, watch } from 'vue';
import { get, post, HttpError } from '@/api/http';
import { parseDbTime } from '@/lib/datetime';
import TaskStatusChip from './TaskStatusChip.vue';
import TaskMetaRow from './TaskMetaRow.vue';

interface DepTask {
  id: string;
  title: string;
  status: string;
  project_id?: string | null;
}

interface RequirementRef {
  id: string;
  title: string;
  status: string;
}

interface Props {
  taskId: string;
  task: {
    id: string;
    title: string;
    prompt: string;
    status: string;
    model: string | null;
    effort?: string | null;
    max_turns?: number | null;
    created_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    cwd: string | null;
    allowed_tools: string | null;
    tags: string | null;
    project_id: string | null;
    version_id: string | null;
    session_id: string | null;
    result: string | null;
    error: string | null;
    preflight_result: string | null;
    requirement_id: string | null;
    base_commit: string | null;
    head_commit: string | null;
    /** 收尾预热产物 (GET /api/tasks/:id 直带, R200 预热; null = 未生成/已失效). */
    card_summary?: { what: string; why: string; at?: string } | null;
    result_layers?: { brief: string; details: string[]; next?: string; result_len?: number } | null;
  };
  /** R242: 动态指标实时值 (父组件 SSE + ticker 驱动, 与 TaskHeader 的 TaskMetaRow
      同源) — 元信息面板嵌 TaskMetaRow 展示; 不传则相应项不显示. */
  contextTokens?: number | null;
  contextMax?: number | null;
  timeoutRemainingMs?: number | null;
  timeoutTotalMs?: number | null;
  costUsd?: number | null;
  costCoefficient?: number | null;
  parentTask: DepTask | null;
  dispatcherTask: DepTask | null;
  dispatchedTasks: DepTask[];
  dependsOnTasks: DepTask[];
  dependentTasks: DepTask[];
  requirementLink: RequirementRef | null;
  requirementSiblings: DepTask[];

  /** 4 面板各自折叠态 (TaskDetailView 持有 source of truth, master use-dock-state
      accordion 同款). */
  collapsed: {
    details: boolean;
    timeline: boolean;
    checkpoints: boolean;
    commits: boolean;
  };

  /** checkpoint 列表的 fork 触发器 (master onForkFromCheckpoint 同款). */
  sessionIdAvailable: boolean;
  onForkFromCheckpoint: (checkpointId: number) => void;
  onClose?: () => void;
}

const props = withDefaults(defineProps<Props>(), {
  parentTask: null,
  dispatcherTask: null,
  requirementLink: null,
});

const emit = defineEmits<{
  (e: 'toggle', panel: 'details' | 'timeline' | 'checkpoints' | 'commits'): void;
}>();

/* R242: 开始/结束时间展示 (与 TaskMetaRow 创建时间同一 parseDbTime 口径, R205
   当 UTC 处理避免 CST 偏早 8h). 精确到秒 — 排查派发链路耗时要看秒位.
   命名 formatDbTime: 区别于上方 formatTime(ms: number) 时长格式化. */
function formatDbTime(iso?: string | null): string {
  if (!iso) return '';
  const d = parseDbTime(iso);
  if (!d) return iso;
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

/* ------------------------------------------------------------------ */
/*  常量                                                              */
/* ------------------------------------------------------------------ */

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-gray-400',
  queued: 'bg-blue-400',
  running: 'bg-sky-400',
  verifying: 'bg-yellow-400',
  paused: 'bg-yellow-400',
  reviewing: 'bg-purple-400',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  rejected: 'bg-orange-400',
  cancelled: 'bg-gray-300',
  await_user: 'bg-indigo-400',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  queued: '排队中',
  running: '运行中',
  verifying: '验收中',
  paused: '已暂停',
  reviewing: '待审核',
  completed: '已完成',
  failed: '失败',
  rejected: '已取消', // 历史 rejected 显示兼容 → 已取消 (2026-09-15 决策, 曾误标等待中)
  cancelled: '已取消',
  await_user: '等用户介入',
};

const PANEL_META: Record<'details' | 'timeline' | 'checkpoints' | 'commits', { icon: string; label: string }> = {
  details: { icon: '🗂', label: '详情' },
  timeline: { icon: '🕒', label: '时间线' },
  checkpoints: { icon: '🧷', label: 'Checkpoints' },
  commits: { icon: '🔗', label: 'Commits' },
};

const REQ_STATUS_COLOR: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  done: 'bg-green-100 text-green-700',
  awaiting_reply: 'bg-blue-100 text-blue-700',
  has_suggestion: 'bg-purple-100 text-purple-700',
  blocked: 'bg-orange-100 text-orange-700',
  closed: 'bg-gray-200 text-gray-500',
};

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: '未开始',
  done: '已完成',
  awaiting_reply: '等回复',
  has_suggestion: '有建议',
  blocked: '需拍板',
  closed: '已关闭',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseStrArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function shortId(id: string): string {
  return id.length >= 8 ? id.slice(0, 8) : id;
}

function taskLink(id: string): string {
  return `#/tasks/${id}`;
}

function reqLink(id: string): string {
  return `#/requirements/${id}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 1) return '<1秒';
  if (totalSec < 60) return `${totalSec}秒`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}时${mins}分`;
}

// R56-B18: 改用 lib/datetime parseDbTime 当 UTC 处理, 不再用本地 new Date(s) —
// SQLite DATETIME 返回 UTC 无时区标记, 直接 new Date() 在 CST 偏 8h (master
// 等价物 src/lib/datetime.ts:14, 本地 lib/datetime.ts 同口径).
// (下方局部 parseDbTime 已删, 用 import 的版本.)

const allowedTools = computed<string[]>(() => parseStrArray(props.task.allowed_tools));
const tags = computed<string[]>(() => parseStrArray(props.task.tags));

const hasOutcome = computed<boolean>(() => !!(props.task.result || props.task.error));

/* 「总结」模块显隐: 收尾预热产物 (干啥/有啥用 + 概览/流程图/下一步) 至少有一份才显示.
 * 存量任务 (预热前完成) 两字段为 null → 模块整体隐藏, 不占面板空间. */
/* 1010: 总结重算兜底 — warm 失败 / 缓存判废后 payload 两字段为 null, 面板原来
 * 整段隐藏没有任何补救入口. 本地 override 存点「重新生成」后的结果 (props 只读),
 * 成功即显; 失败显示原因. 有 result 但没总结时也渲染模块 (只含重算入口). */
interface CardSummaryPayload { what: string; why: string }
interface ResultLayersPayload { brief: string; details: string[]; next?: string }
const regenCard = ref<CardSummaryPayload | null>(null);
const regenLayers = ref<ResultLayersPayload | null>(null);
const regenerating = ref(false);
const regenError = ref<string | null>(null);

const viewCard = computed<CardSummaryPayload | null>(() => regenCard.value ?? props.task.card_summary ?? null);
const viewLayers = computed<ResultLayersPayload | null>(() => regenLayers.value ?? props.task.result_layers ?? null);
const hasSummary = computed<boolean>(() => !!(viewCard.value || viewLayers.value));

// 功能: 强制重算本任务的两份总结 (card-summary + result-layers, 双双 refresh=true),
//   任一成功即更新本地 override; 双双失败 → regenError 提示.
// 关注点: 路由侧 ensure 带 LLM 生成, 最长 ~50s (交互档); allSettled 双轨互不拖死.
async function regenerateSummary(): Promise<void> {
  if (regenerating.value) return;
  regenerating.value = true;
  regenError.value = null;
  const [cardR, layersR] = await Promise.allSettled([
    get<{ what: string; why: string; source: string }>(`/api/tasks/${props.taskId}/card-summary?refresh=true`),
    get<{ brief: string; details: string[]; next?: string; source: string }>(`/api/tasks/${props.taskId}/result-layers?refresh=true`),
  ]);
  let ok = false;
  if (cardR.status === 'fulfilled' && (cardR.value.what || cardR.value.why)) {
    regenCard.value = { what: cardR.value.what, why: cardR.value.why };
    ok = true;
  }
  if (layersR.status === 'fulfilled' && (layersR.value.brief || (layersR.value.details?.length ?? 0) > 0)) {
    regenLayers.value = { brief: layersR.value.brief, details: layersR.value.details ?? [], next: layersR.value.next };
    ok = true;
  }
  if (!ok) {
    regenError.value = '生成失败 (总结链路不可用或超时), 稍后再试';
  }
  regenerating.value = false;
}

/*  R62 (damo 飞书 AO-DEV-spa R62): 依赖图升级为「全关系图」。
 *  原来这一段只画 depends_on / dependent 两种, 派发 (dispatcher / dispatched) 和
 *  继承 (fork 父任务) 散在别的 SubSection 里 —— 图上看不出「谁派生了谁」。
 *  现在统一成 上游[派发自 / 继承自 / 依赖] → 当前任务 → 下游[派发 / 被依赖],
 *  每组带一个关系标签 (派发=紫 / 继承=琥珀 / 依赖=蓝), 一眼分得清边的类型。
 *  关注点: 原「派发与依赖」SubSection 的内容已被本图完全覆盖, 已删除避免同一批
 *  task 在一个面板里出现两遍。 */
const MAX_REL_VISIBLE = 5;

interface RelGroup {
  /** 组标签 (派发自 / 继承自 / 上游（依赖）…)。 */
  label: string;
  /** 关系类型标签 + 配色 (区分边的语义)。 */
  tag: string;
  tagCls: string;
  /** 截断后的可见项。 */
  items: DepTask[];
  /** 超出 MAX_REL_VISIBLE 被折叠的数量。 */
  hidden: number;
}

function relGroup(
  label: string,
  tag: string,
  tagCls: string,
  list: DepTask[]
): RelGroup | null {
  if (list.length === 0) return null;
  return {
    label,
    tag,
    tagCls,
    items: list.slice(0, MAX_REL_VISIBLE),
    hidden: list.length - Math.min(list.length, MAX_REL_VISIBLE),
  };
}

const upstreamGroups = computed<RelGroup[]>(() =>
  [
    relGroup('派发自（上游任务）', '派发', 'rd-tag-dispatch', props.dispatcherTask ? [props.dispatcherTask] : []),
    relGroup('继承自（Fork 父任务）', '继承', 'rd-tag-fork', props.parentTask ? [props.parentTask] : []),
    relGroup('上游（依赖）', '依赖', 'rd-tag-depends', props.dependsOnTasks),
  ].filter((g): g is RelGroup => g !== null)
);

const downstreamGroups = computed<RelGroup[]>(() =>
  [
    relGroup('本任务派发（下游任务）', '派发', 'rd-tag-dispatch', props.dispatchedTasks),
    relGroup('下游（被依赖）', '依赖', 'rd-tag-depends', props.dependentTasks),
  ].filter((g): g is RelGroup => g !== null)
);

const relUpCount = computed<number>(() => upstreamGroups.value.reduce((n, g) => n + g.items.length + g.hidden, 0));
const relDownCount = computed<number>(() => downstreamGroups.value.reduce((n, g) => n + g.items.length + g.hidden, 0));
const hasAnyRelation = computed<boolean>(() => relUpCount.value > 0 || relDownCount.value > 0);

/* ------------------------------------------------------------------ */
/*  Details panel SubSection 折叠                                       */
/* ------------------------------------------------------------------ */

const subOpen = ref<Record<string, boolean>>({});
function initSubOpen(): void {
  subOpen.value = {
    summary: hasSummary.value,
    prompt: true,
    outcome: hasOutcome.value,
    meta: false,
    requirement: !!props.requirementLink,
    dependency: hasAnyRelation.value,
  };
}
onMounted(() => initSubOpen());
watch(() => props.task.id, () => initSubOpen());

function toggleSub(key: string): void {
  subOpen.value = { ...subOpen.value, [key]: !subOpen.value[key] };
}

/* ------------------------------------------------------------------ */
/*  Timeline panel — fetch /api/tasks/[id]/timeline                     */
/* ------------------------------------------------------------------ */

interface TimelineEvent {
  id: number | null;
  from: string | null;
  to: string;
  created_at: string;
  is_initial: boolean;
  duration_ms: number | null;
}

const timelineEvents = ref<TimelineEvent[]>([]);
const timelineLoading = ref<boolean>(false);
const timelineError = ref<string | null>(null);

async function loadTimeline(): Promise<void> {
  timelineLoading.value = true;
  timelineError.value = null;
  try {
    const data = await get<{ events: TimelineEvent[] }>(`/api/tasks/${props.taskId}/timeline`);
    timelineEvents.value = Array.isArray(data.events) ? data.events : [];
  } catch (e: unknown) {
    timelineError.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    timelineLoading.value = false;
  }
}

watch(
  () => props.taskId,
  () => loadTimeline(),
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/*  Checkpoints panel — fetch /api/tasks/[id]/checkpoints               */
/* ------------------------------------------------------------------ */

interface CheckpointRow {
  id: number;
  task_id: string;
  session_id: string;
  step: string;
  summary: string | null;
  by: string | null;
  status: string | null;
  commit_id: string | null;
  up_to_message_id: string | null;
  created_at: string;
}

const checkpoints = ref<CheckpointRow[]>([]);
const checkpointsLoading = ref<boolean>(false);
const checkpointsError = ref<string | null>(null);
const checkpointRefresh = ref<number>(0);

async function loadCheckpoints(): Promise<void> {
  checkpointsLoading.value = true;
  checkpointsError.value = null;
  try {
    const data = await get<CheckpointRow[] | { error?: string }>(`/api/tasks/${props.taskId}/checkpoints`);
    if (Array.isArray(data)) checkpoints.value = data;
    else checkpoints.value = [];
  } catch (e: unknown) {
    checkpointsError.value = e instanceof Error ? e.message : '加载失败';
    checkpoints.value = [];
  } finally {
    checkpointsLoading.value = false;
  }
}

watch(
  () => [props.taskId, checkpointRefresh.value] as const,
  () => loadCheckpoints(),
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/*  Commits panel — fetch /api/tasks/[id]/commits                       */
/* ------------------------------------------------------------------ */

interface CommitEntry {
  task_id: string;
  commit_id: string;
  desc: string | null;
  files: string[];
  created_at: string;
}

interface DescendantTaskSummary {
  task_id: string;
  task_title: string;
}

const commitEntries = ref<CommitEntry[]>([]);
const descendantTasks = ref<DescendantTaskSummary[]>([]);
const commitsLoading = ref<boolean>(false);
const commitsError = ref<string | null>(null);
const expandedCommitId = ref<string | null>(null);

async function loadCommits(): Promise<void> {
  commitsLoading.value = true;
  commitsError.value = null;
  try {
    const data = await get<{ entries: CommitEntry[]; descendant_tasks?: DescendantTaskSummary[] }>(
      `/api/tasks/${props.taskId}/commits`,
    );
    commitEntries.value = Array.isArray(data.entries) ? data.entries : [];
    descendantTasks.value = Array.isArray(data.descendant_tasks) ? data.descendant_tasks : [];
    if (expandedCommitId.value && !commitEntries.value.some((e) => e.commit_id === expandedCommitId.value)) {
      expandedCommitId.value = null;
    }
  } catch (e: unknown) {
    commitsError.value = e instanceof Error ? e.message : '加载失败';
    commitEntries.value = [];
  } finally {
    commitsLoading.value = false;
  }
}

watch(
  () => props.taskId,
  () => loadCommits(),
  { immediate: true },
);

function toggleCommitFiles(commitId: string): void {
  expandedCommitId.value = expandedCommitId.value === commitId ? null : commitId;
}

function onPanelToggle(panel: 'details' | 'timeline' | 'checkpoints' | 'commits'): void {
  emit('toggle', panel);
}

/** R56-A4.2: 手动添加 checkpoint 成功后 → 刷新 checkpoints 列表. */
function onCheckpointCreated(): void {
  checkpointRefresh.value++;
}
</script>

<template>
  <div class="rd-root">
    <!-- 4 面板 (DOCK_ORDER = details / timeline / checkpoints / commits).
         master R37: 展开的 panel flex-1 自动撑满 dock 剩余高度 (零 JS),
         折叠的 panel shrink-0 顶自然高度 header. -->
    <div
      v-for="panel in (['details', 'timeline', 'checkpoints', 'commits'] as const)"
      :key="panel"
      class="rd-panel"
      :class="props.collapsed[panel] ? 'rd-panel-collapsed' : 'rd-panel-expanded'"
    >
      <button
        type="button"
        class="rd-panel-header"
        :aria-expanded="!props.collapsed[panel]"
        :title="`${props.collapsed[panel] ? '展开' : '折叠'}「${PANEL_META[panel].label}」面板`"
        @click="onPanelToggle(panel)"
      >
        <span class="rd-caret">{{ props.collapsed[panel] ? '▶' : '▼' }}</span>
        <span class="rd-panel-title">
          {{ PANEL_META[panel].icon }} {{ PANEL_META[panel].label }}
        </span>
        <span v-if="panel === 'timeline' && timelineEvents.length > 0" class="rd-panel-count">
          {{ timelineEvents.length }} 个节点
        </span>
        <span v-else-if="panel === 'checkpoints' && checkpoints.length > 0" class="rd-panel-count">
          {{ checkpoints.length }} 个
        </span>
        <span v-else-if="panel === 'commits' && commitEntries.length > 0" class="rd-panel-count">
          {{ commitEntries.length }} 条 commit
        </span>
      </button>

      <!-- 1. Details panel -->
      <div
        v-if="panel === 'details'"
        v-show="!props.collapsed.details"
        class="rd-panel-body"
      >
        <!-- 总结 (R200 收尾预热 + 本批次直读): 干啥/有啥用 + 概览/核心细节流程图/下一步.
             数据随 GET /api/tasks/:id 直带 (card_summary / result_layers), 不调 Console 按需接口.
             1010: 无缓存判废/预热失败 → 模块仍显示 (有 result 时), 提供「重新生成」兜底入口. -->
        <div v-if="hasSummary || hasOutcome" class="rd-section">
          <button
            type="button"
            class="rd-sub-header"
            :aria-expanded="!!subOpen['summary']"
            @click="toggleSub('summary')"
          >
            <span class="rd-caret">{{ subOpen['summary'] ? '▼' : '▶' }}</span>
            <span class="rd-sub-title">总结</span>
            <span class="rd-sub-hint">{{ hasSummary ? '收尾自动生成' : '未生成' }}</span>
          </button>
          <div v-if="subOpen['summary']" class="rd-sub-body">
            <p v-if="viewCard?.what" class="rd-sum-line">
              <span class="rd-sum-tag">干啥</span>{{ viewCard.what }}
            </p>
            <p v-if="viewCard?.why" class="rd-sum-line">
              <span class="rd-sum-tag rd-sum-tag-gain">有啥用</span>{{ viewCard.why }}
            </p>
            <template v-if="viewLayers">
              <p v-if="viewLayers.brief" class="rd-sum-brief">{{ viewLayers.brief }}</p>
              <ol v-if="viewLayers.details?.length" class="rd-sum-flow">
                <li v-for="(d, i) in viewLayers.details" :key="i" class="rd-flow-node">
                  <span class="rd-flow-dot">{{ i + 1 }}</span>
                  <span class="rd-flow-text">{{ d }}</span>
                </li>
              </ol>
              <p v-if="viewLayers.next" class="rd-sum-line">
                <span class="rd-sum-tag">下一步</span>{{ viewLayers.next }}
              </p>
            </template>
          </div>
          <div class="rd-sum-regen">
            <button
              type="button"
              class="rd-regen-btn"
              :disabled="regenerating"
              :title="regenerating ? '正在调用总结链路 (最长约 1 分钟)' : '强制重算干啥/有啥用 + 概览/细节流程'"
              @click="regenerateSummary"
            >
              {{ regenerating ? '生成中…' : '↻ 重新生成' }}
            </button>
            <span v-if="regenError" class="rd-regen-err">{{ regenError }}</span>
          </div>
        </div>

        <div class="rd-section">
          <button
            type="button"
            class="rd-sub-header"
            :aria-expanded="!!subOpen['prompt']"
            @click="toggleSub('prompt')"
          >
            <span class="rd-caret">{{ subOpen['prompt'] ? '▼' : '▶' }}</span>
            <span class="rd-sub-title">Prompt</span>
            <span v-if="task.prompt.length > 80" class="rd-sub-hint">{{ task.prompt.length }} chars</span>
          </button>
          <div v-if="subOpen['prompt']" class="rd-sub-body">
            <pre class="rd-prompt">{{ task.prompt }}</pre>
          </div>
        </div>

        <!-- 需求点关联 (master right-dock.tsx 574 同款, 仅 requirement_id 非空). -->
        <div v-if="requirementLink" class="rd-section">
          <button
            type="button"
            class="rd-sub-header"
            :aria-expanded="!!subOpen['requirement']"
            @click="toggleSub('requirement')"
          >
            <span class="rd-caret">{{ subOpen['requirement'] ? '▼' : '▶' }}</span>
            <span class="rd-sub-title">需求点关联</span>
            <span v-if="requirementSiblings.length > 0" class="rd-sub-hint">
              森林 {{ requirementSiblings.length + 1 }} 个
            </span>
          </button>
          <div v-if="subOpen['requirement']" class="rd-sub-body">
            <a class="rd-link-row" :href="reqLink(requirementLink.id)">
              <span class="rd-icon">📋</span>
              <span class="rd-link-title" :title="requirementLink.title">{{ requirementLink.title }}</span>
              <span :class="['rd-req-chip', REQ_STATUS_COLOR[requirementLink.status] || 'bg-gray-100 text-gray-700']">
                {{ REQ_STATUS_LABEL[requirementLink.status] || requirementLink.status }}
              </span>
            </a>
            <div v-if="requirementSiblings.length > 0" class="rd-siblings-block">
              <div class="rd-sub-label">同需求点下的其他 task (森林)</div>
              <a
                v-for="sib in requirementSiblings"
                :key="sib.id"
                class="rd-link-row"
                :href="taskLink(sib.id)"
              >
                <span class="rd-status-dot" :class="STATUS_DOT[sib.status] || 'bg-gray-400'" />
                <span class="rd-link-title" :title="sib.title">{{ sib.title }}</span>
                <span class="rd-link-status">{{ STATUS_LABELS[sib.status] || sib.status }}</span>
              </a>
              <a :href="reqLink(requirementLink.id)" class="rd-view-forest">查看森林 →</a>
            </div>
          </div>
        </div>

        <!-- 关系图 (R62: 原「依赖图」只画 depends/dependent, 现补齐 派发 + 继承;
             始终渲染, 无任何关系时显示占位文案). -->
        <div class="rd-section">
          <button
            type="button"
            class="rd-sub-header"
            :aria-expanded="!!subOpen['dependency']"
            @click="toggleSub('dependency')"
          >
            <span class="rd-caret">{{ subOpen['dependency'] ? '▼' : '▶' }}</span>
            <span class="rd-sub-title">关系图</span>
            <span v-if="hasAnyRelation" class="rd-sub-hint">
              {{ relUpCount }} 上游 · {{ relDownCount }} 下游
            </span>
          </button>
          <div v-if="subOpen['dependency']" class="rd-sub-body">
            <div v-if="!hasAnyRelation" class="rd-empty">此任务无关联关系</div>
            <div v-if="upstreamGroups.length > 0" class="rd-upstream">
              <div
                v-for="g in upstreamGroups"
                :key="g.label"
                class="rd-rel-group"
              >
                <div class="rd-upstream-label">
                  {{ g.label }}
                  <span class="rd-rel-tag" :class="g.tagCls">{{ g.tag }}</span>
                </div>
                <a
                  v-for="dep in g.items"
                  :key="dep.id"
                  class="rd-link-row"
                  :href="taskLink(dep.id)"
                >
                  <span class="rd-status-dot" :class="STATUS_DOT[dep.status] || 'bg-gray-400'" />
                  <span class="rd-link-title rd-link-up" :title="dep.title">{{ dep.title }}</span>
                  <span
                    v-if="dep.project_id && dep.project_id !== task.project_id"
                    class="rd-cross-project"
                    :title="`跨项目: ${dep.project_id}`"
                  >跨项目</span>
                  <span class="rd-link-status">{{ STATUS_LABELS[dep.status] || dep.status }}</span>
                  <span class="rd-link-id">#{{ shortId(dep.id) }}</span>
                </a>
                <div v-if="g.hidden > 0" class="rd-hidden-count">
                  还有 {{ g.hidden }} 个未展示…
                </div>
              </div>
            </div>
            <div v-if="hasAnyRelation" class="rd-current">
              <div class="rd-current-label">当前任务</div>
              <div class="rd-current-title" :title="task.title">{{ task.title }}</div>
              <div class="rd-current-meta">
                <span class="rd-status-dot" :class="STATUS_DOT[task.status] || 'bg-gray-400'" />
                <span>{{ STATUS_LABELS[task.status] || task.status }}</span>
                <span class="rd-link-id">#{{ shortId(task.id) }}</span>
              </div>
            </div>
            <div v-if="downstreamGroups.length > 0" class="rd-downstream">
              <div
                v-for="g in downstreamGroups"
                :key="g.label"
                class="rd-rel-group"
              >
                <div class="rd-downstream-label">
                  {{ g.label }}
                  <span class="rd-rel-tag" :class="g.tagCls">{{ g.tag }}</span>
                </div>
                <a
                  v-for="dep in g.items"
                  :key="dep.id"
                  class="rd-link-row"
                  :href="taskLink(dep.id)"
                >
                  <span class="rd-status-dot" :class="STATUS_DOT[dep.status] || 'bg-gray-400'" />
                  <span class="rd-link-title" :title="dep.title">{{ dep.title }}</span>
                  <span
                    v-if="dep.project_id && dep.project_id !== task.project_id"
                    class="rd-cross-project"
                    :title="`跨项目: ${dep.project_id}`"
                  >跨项目</span>
                  <span class="rd-link-status">{{ STATUS_LABELS[dep.status] || dep.status }}</span>
                  <span class="rd-link-id">#{{ shortId(dep.id) }}</span>
                </a>
                <div v-if="g.hidden > 0" class="rd-hidden-count">
                  还有 {{ g.hidden }} 个未展示…
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 结果 (master right-dock.tsx 788 同款, 仅 hasOutcome). -->
        <div v-if="hasOutcome" class="rd-section">
          <button
            type="button"
            class="rd-sub-header"
            :aria-expanded="!!subOpen['outcome']"
            @click="toggleSub('outcome')"
          >
            <span class="rd-caret">{{ subOpen['outcome'] ? '▼' : '▶' }}</span>
            <span class="rd-sub-title">结果</span>
            <span class="rd-sub-hint">
              {{ [task.result ? 'result' : null, task.error ? 'error' : null].filter(Boolean).join(' + ') }}
            </span>
          </button>
          <div v-if="subOpen['outcome']" class="rd-sub-body">
            <div v-if="task.result">
              <div class="rd-sub-label">result</div>
              <pre class="rd-outcome">{{ task.result }}</pre>
            </div>
            <div v-if="task.error" :class="task.result ? 'rd-margin-top' : ''">
              <div class="rd-sub-label">error</div>
              <pre class="rd-outcome rd-outcome-error">{{ task.error }}</pre>
            </div>
          </div>
        </div>

        <!-- 元信息 (master right-dock.tsx 827 同款, 默认折叠). -->
        <div class="rd-section">
          <button
            type="button"
            class="rd-sub-header"
            :aria-expanded="!!subOpen['meta']"
            @click="toggleSub('meta')"
          >
            <span class="rd-caret">{{ subOpen['meta'] ? '▼' : '▶' }}</span>
            <span class="rd-sub-title">元信息</span>
          </button>
          <div v-if="subOpen['meta']" class="rd-sub-body rd-meta-body">
            <!-- R242: 任务基本信息块 — 复用 TaskMetaRow (模型/强度/最大轮次/创建时间/
                 上下文占用/超时剩余/成本). 动态三项由父组件 SSE + 1s ticker 实时驱动,
                 与顶部 TaskHeader 同源同值, 满足「动态信息实时更新, 要么就不要」. -->
            <div class="rd-meta-basics">
              <TaskMetaRow
                :model="task.model"
                :effort="task.effort ?? null"
                :max-turns="task.max_turns ?? null"
                :created-at="task.created_at ?? null"
                :context-tokens="contextTokens ?? null"
                :context-max="contextMax ?? null"
                :cost="costUsd ?? null"
                :cost-coefficient="costCoefficient ?? null"
                :timeout-remaining-ms="timeoutRemainingMs ?? null"
                :timeout-total-ms="timeoutTotalMs ?? null"
              />
              <div v-if="task.started_at || task.completed_at" class="rd-meta-times">
                <span v-if="task.started_at" class="rd-meta-time-item">开始: <strong>{{ formatDbTime(task.started_at) }}</strong></span>
                <span v-if="task.completed_at" class="rd-meta-time-item">结束: <strong>{{ formatDbTime(task.completed_at) }}</strong></span>
              </div>
            </div>
            <div v-if="task.cwd">
              <div class="rd-sub-label">工作目录</div>
              <p class="rd-mono">{{ task.cwd }}</p>
            </div>
            <div v-if="task.preflight_result">
              <div class="rd-sub-label">Preflight 自检（系统执行）</div>
              <pre class="rd-preflight">{{ task.preflight_result }}</pre>
            </div>
            <div v-if="allowedTools.length > 0">
              <div class="rd-sub-label">工具</div>
              <div class="rd-chips">
                <span v-for="t in allowedTools" :key="t" class="rd-chip">{{ t }}</span>
              </div>
            </div>
            <div v-if="tags.length > 0">
              <div class="rd-sub-label">标签</div>
              <div class="rd-chips">
                <span v-for="t in tags" :key="t" class="rd-chip rd-chip-blue">{{ t }}</span>
              </div>
            </div>
            <div v-if="task.project_id || task.version_id">
              <div class="rd-sub-label">归属</div>
              <span v-if="task.project_id" class="rd-chip rd-chip-purple">项目: {{ shortId(task.project_id) }}…</span>
              <span v-if="task.version_id" class="rd-chip rd-chip-orange">版本: {{ shortId(task.version_id) }}…</span>
            </div>
            <div v-if="parentTask">
              <div class="rd-sub-label">父任务</div>
              <a class="rd-link-row" :href="taskLink(parentTask.id)">
                <span class="rd-status-dot" :class="STATUS_DOT[parentTask.status] || 'bg-gray-400'" />
                <span class="rd-link-title rd-link-up" :title="parentTask.title">{{ parentTask.title }}</span>
                <span class="rd-link-id">#{{ shortId(parentTask.id) }}</span>
              </a>
            </div>
            <div v-if="task.session_id">
              <div class="rd-sub-label">Session</div>
              <p class="rd-mono rd-session">{{ task.session_id }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Timeline panel -->
      <div
        v-else-if="panel === 'timeline'"
        v-show="!props.collapsed.timeline"
        class="rd-panel-body"
      >
        <div v-if="timelineLoading" class="rd-state">加载中...</div>
        <div v-else-if="timelineError" class="rd-state rd-state-error">⚠ {{ timelineError }}</div>
        <div v-else-if="timelineEvents.length === 0" class="rd-state">暂无事件</div>
        <ol v-else class="rd-timeline">
          <span class="rd-timeline-rail" aria-hidden="true" />
          <li
            v-for="(ev, i) in timelineEvents"
            :key="`${ev.id ?? 'init'}-${i}`"
            class="rd-timeline-node"
          >
            <span
              class="rd-timeline-dot"
              :class="[
                STATUS_DOT[ev.to] || 'bg-gray-400',
                ev.from === 'running' && ev.to === 'reviewing' ? 'rd-timeline-dot-highlight' : '',
              ]"
            />
            <div
              class="rd-timeline-card"
              :class="ev.from === 'running' && ev.to === 'reviewing' ? 'rd-timeline-card-highlight' : ''"
            >
              <div class="rd-timeline-meta">
                <span class="rd-mono rd-timeline-time">
                  {{ formatTime(parseDbTime(ev.created_at)?.getTime() ?? 0) }}
                </span>
                <span class="rd-timeline-label">
                  {{ ev.from
                    ? `${STATUS_LABELS[ev.from] || ev.from} → ${STATUS_LABELS[ev.to] || ev.to}`
                    : STATUS_LABELS[ev.to] || ev.to }}
                </span>
                <span v-if="ev.from === 'running' && ev.to === 'reviewing'" class="rd-tag rd-tag-purple">完成</span>
                <span v-if="ev.is_initial" class="rd-tag rd-tag-gray">起始</span>
              </div>
              <div v-if="ev.duration_ms != null" class="rd-timeline-duration">
                ⏱ 持续 {{ formatDuration(ev.duration_ms) }}
              </div>
            </div>
          </li>
        </ol>
      </div>

      <!-- 3. Checkpoints panel -->
      <div
        v-else-if="panel === 'checkpoints'"
        v-show="!props.collapsed.checkpoints"
        class="rd-panel-body"
      >
        <div v-if="checkpointsLoading" class="rd-state">加载中...</div>
        <div v-else-if="checkpointsError" class="rd-state rd-state-error">⚠ {{ checkpointsError }}</div>
        <ol v-else-if="checkpoints.length > 0" class="rd-checkpoints">
          <li
            v-for="cp in checkpoints"
            :key="cp.id"
            class="rd-checkpoint"
          >
            <div class="rd-checkpoint-meta">
              <span class="rd-mono rd-cp-step">step {{ cp.step }}</span>
              <span class="rd-cp-dot">·</span>
              <span>{{ formatTime(parseDbTime(cp.created_at)?.getTime() ?? 0) }}</span>
              <template v-if="cp.commit_id">
                <span class="rd-cp-dot">·</span>
                <code class="rd-mono rd-cp-commit" :title="cp.commit_id">
                  {{ cp.commit_id.slice(0, 7) }}
                </code>
              </template>
              <span v-if="cp.by" class="rd-tag rd-tag-slate" :title="`写这个 checkpoint 的 agent: ${cp.by}`">
                [by]{{ cp.by }}
              </span>
            </div>
            <div class="rd-checkpoint-summary">
              {{ cp.summary || '(no summary)' }}
            </div>
            <button
              v-if="sessionIdAvailable && cp.up_to_message_id"
              type="button"
              class="rd-cp-fork-btn"
              @click="onForkFromCheckpoint(cp.id)"
            >
              Fork from here
            </button>
            <div v-else-if="!cp.up_to_message_id" class="rd-cp-anchor-note">
              fork point not available (anchor only)
            </div>
          </li>
        </ol>
        <div v-else class="rd-state rd-state-multi-line">
          <div>暂无 checkpoint。</div>
          <div class="rd-state-hint">
            让 agent 在输出里写
            <code>&lt;checkpoint step=N summary="..."&gt;</code>，
            或手动添加一个 fork 点。
          </div>
        </div>
        <!-- R56-A4.2: 手动添加 checkpoint 表单 (master right-dock.tsx:1228-1324
             AddCheckpointControl 同款). 折叠时一个按钮, 展开后 summary + step
             两字段, 提交 POST /api/tasks/[id]/checkpoints 走 status 检查后
             写入 checkpoints 表, 成功后 onCreated() 触发父级刷新. -->
        <AddCheckpointControl
          :task-id="taskId"
          :session-id-available="sessionIdAvailable"
          :on-created="onCheckpointCreated"
        />
      </div>

      <!-- 4. Commits panel -->
      <div
        v-else-if="panel === 'commits'"
        v-show="!props.collapsed.commits"
        class="rd-panel-body"
      >
        <div v-if="commitsLoading" class="rd-state">加载中...</div>
        <div v-else-if="commitsError" class="rd-state rd-state-error">⚠ {{ commitsError }}</div>
        <div v-else-if="commitEntries.length === 0" class="rd-state rd-state-multi-line">
          <div class="rd-state-line">agent 未声明 git 提交</div>
          <div class="rd-state-hint">
            让 agent 在输出里写
            <code>&lt;git commit-id="abc" desc="..." files="a.ts,b.ts"/&gt;</code>，
            或手动 git commit 后重启任务。
          </div>
          <div v-if="task.base_commit || task.head_commit" class="rd-state-hint rd-mono">
            区间 base {{ task.base_commit?.slice(0, 7) ?? '—' }}
            →
            head {{ task.head_commit?.slice(0, 7) ?? '—' }}
          </div>
        </div>
        <ol v-else class="rd-commits">
          <li
            v-for="e in commitEntries"
            :key="`${e.task_id}-${e.commit_id}`"
            class="rd-commit"
          >
            <button
              type="button"
              class="rd-commit-row"
              :aria-expanded="expandedCommitId === e.commit_id"
              @click="toggleCommitFiles(e.commit_id)"
            >
              <span class="rd-caret">{{ expandedCommitId === e.commit_id ? '▼' : '▶' }}</span>
              <code class="rd-mono rd-commit-sha">{{ e.commit_id.slice(0, 7) }}</code>
              <span class="rd-commit-desc">{{ e.desc || '(no desc)' }}</span>
              <span class="rd-mono rd-commit-time">
                {{ formatTime(parseDbTime(e.created_at)?.getTime() ?? 0) }}
              </span>
            </button>
            <div v-if="expandedCommitId === e.commit_id && e.files.length > 0" class="rd-commit-files">
              <div
                v-for="f in e.files"
                :key="f"
                class="rd-mono rd-commit-file"
                :title="f"
              >{{ f }}</div>
            </div>
            <div v-else-if="expandedCommitId === e.commit_id && e.files.length === 0" class="rd-commit-files-empty">
              (无文件清单 — agent marker 没写 files 属性)
            </div>
          </li>
        </ol>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/* AddCheckpointControl 由独立 AddCheckpointControl.vue 提供; 这里留
   空 script 块仅为保留 ts 文件结构 (vue-tsc 需要 .vue 文件双 script 块
   才认 defineComponent, 这里仅 import + 注册). */
import AddCheckpointControl from './AddCheckpointControl.vue';
export default {
  components: { AddCheckpointControl },
};
</script>

<style scoped>
/* R242: 元信息面板「任务基本信息」块 — TaskMetaRow 外再补开始/结束时间行. */
.rd-meta-basics {
  padding-bottom: 6px;
  margin-bottom: 8px;
  border-bottom: 1px dashed var(--color-border);
}
.rd-meta-times {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--color-text-muted);
}
.rd-meta-time-item strong {
  color: var(--color-text);
  font-weight: 600;
}

.rd-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--color-bg-elevated);
}

.rd-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-bottom: 1px solid var(--color-border);
  width: 100%;
}
.rd-panel:last-child {
  border-bottom: none;
}

/* R37 flex 模式: 展开的 panel flex-1 自填剩余高度, 折叠的 shrink-0 仅顶 header. */
.rd-panel-expanded {
  flex: 1;
  overflow: hidden;
}
.rd-panel-collapsed {
  flex-shrink: 0;
}

.rd-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s;
}
.rd-panel-header:hover {
  background: var(--tw-gray-50);
}

.rd-caret {
  font-size: 10px;
  color: var(--color-text-muted);
  width: 12px;
  display: inline-block;
  text-align: center;
  flex-shrink: 0;
}

.rd-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--tw-gray-700);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rd-panel-count {
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.rd-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.rd-section {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-elevated);
  margin-bottom: 8px;
  overflow: hidden;
}
.rd-section:last-child {
  margin-bottom: 0;
}

.rd-sub-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  color: var(--tw-gray-700);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}
.rd-sub-header:hover {
  background: var(--tw-gray-50);
}

.rd-sub-title {
  flex: 1;
}

.rd-sub-hint {
  font-size: 10px;
  color: var(--color-text-muted);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60%;
}

.rd-sub-body {
  padding: 8px 10px 12px;
  max-height: 400px;
  overflow-y: auto;
}

/* ---- 总结模块 (干啥/有啥用 + 概览 + 核心细节流程图 + 下一步) ----
 * 口径同 Console 弹窗 (ConsoleCanvas tm-line / layer-flow), 浅色面板适配. */
.rd-sum-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--color-text);
  word-break: break-word;
}
.rd-sum-tag {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  margin-top: 1px;
  color: var(--color-primary, #2563eb);
  background: color-mix(in srgb, var(--color-primary, #2563eb) 10%, transparent);
}
.rd-sum-tag-gain {
  color: #059669;
  background: color-mix(in srgb, #059669 10%, transparent);
}
.rd-sum-brief {
  margin: 0 0 8px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--color-text);
  word-break: break-word;
}
/* 核心细节 = 处理流程图解: 竖向步骤图, 序号圆点 + 连接线 (Console layer-flow 同款). */
.rd-sum-flow {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  position: relative;
}
.rd-flow-node {
  position: relative;
  display: flex;
  gap: 8px;
  padding: 0 0 10px;
  word-break: break-word;
}
.rd-flow-node:last-child { padding-bottom: 0; }
/* 连接线: 圆点中心向下连到下一节点 (最后一个节点不画) */
.rd-flow-node:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 16px;
  bottom: -2px;
  width: 2px;
  background: color-mix(in srgb, var(--color-primary, #2563eb) 25%, transparent);
}
.rd-flow-dot {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--color-primary, #2563eb);
  opacity: 0.85;
  z-index: 1;
}
.rd-flow-text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text);
  padding-top: 1px;
}
/* 重算兜底行 (1010): 总结缺失/失败时的「重新生成」入口 */
.rd-sum-regen {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 8px;
}
.rd-regen-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
}
.rd-regen-btn:hover:not(:disabled) {
  color: var(--color-primary, #2563eb);
}
.rd-regen-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
.rd-regen-err {
  font-size: 11px;
  color: #dc2626;
}

.rd-sub-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 4px;
}

.rd-prompt {
  font-size: 12px;
  background: var(--tw-gray-50);
  border-radius: 4px;
  padding: 8px;
  margin: 0;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-word;
}

.rd-outcome {
  font-size: 12px;
  background: var(--tw-gray-50);
  border-radius: 4px;
  padding: 8px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.rd-outcome-error {
  background: var(--tw-red-50);
  color: var(--tw-red-800);
}

.rd-preflight {
  font-size: 11px;
  background: var(--tw-amber-50);
  border: 1px solid var(--tw-amber-200);
  border-radius: 4px;
  padding: 6px;
  margin: 0;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-word;
}

.rd-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  word-break: break-all;
}

.rd-session {
  font-size: 11px;
  color: var(--color-text-muted);
}

.rd-meta-body > * + * {
  margin-top: 10px;
}

.rd-margin-top {
  margin-top: 10px;
}

.rd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.rd-chip {
  padding: 2px 8px;
  background: var(--tw-gray-100);
  border-radius: 9999px;
  font-size: 11px;
}

.rd-chip-blue {
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
}
.rd-chip-purple {
  background: var(--tw-purple-100);
  color: var(--tw-purple-800);
}
.rd-chip-orange {
  background: var(--tw-orange-100);
  color: var(--tw-orange-700);
}

.rd-link-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;
  font-size: 12px;
  transition: background 0.1s;
}
.rd-link-row:hover {
  background: var(--tw-gray-50);
}

.rd-icon {
  font-size: 12px;
}

.rd-link-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rd-link-up {
  color: var(--tw-blue-700);
}
.rd-link-row:hover .rd-link-up {
  text-decoration: underline;
}

.rd-link-status {
  font-size: 10px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.rd-link-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.rd-status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  flex-shrink: 0;
}

.rd-cross-project {
  font-size: 10px;
  color: var(--tw-purple-800);
  flex-shrink: 0;
}

.rd-req-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 9999px;
  flex-shrink: 0;
}

.rd-siblings-block {
  margin-top: 8px;
}

.rd-view-forest {
  display: block;
  text-align: center;
  font-size: 11px;
  color: var(--tw-blue-700);
  text-decoration: none;
  margin-top: 4px;
  padding: 4px;
}
.rd-view-forest:hover {
  text-decoration: underline;
}

.rd-block + .rd-block {
  margin-top: 10px;
}

.rd-empty {
  font-size: 11px;
  color: var(--color-text-muted);
  font-style: italic;
  padding: 2px 4px;
}

.rd-upstream,
.rd-downstream {
  padding-left: 6px;
}
.rd-upstream {
  border-left: 2px solid var(--tw-blue-200);
}
.rd-downstream {
  border-left: 2px solid var(--tw-green-200);
}

.rd-upstream-label,
.rd-downstream-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 4px;
}
.rd-upstream-label {
  color: var(--tw-blue-700);
}
.rd-downstream-label {
  color: var(--tw-emerald-700);
}

/* R62: 关系图里一组同类型关系 (派发自 / 继承自 / 依赖 / 派发 / 被依赖). */
.rd-rel-group + .rd-rel-group {
  margin-top: 8px;
}

/* 关系类型徽标 — 靠颜色区分边的语义: 紫=派发, 琥珀=继承, 蓝=依赖. */
.rd-rel-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  vertical-align: middle;
}
.rd-tag-dispatch {
  background: var(--tw-violet-100);
  color: var(--tw-violet-700);
}
.rd-tag-fork {
  background: var(--tw-amber-100);
  color: var(--tw-amber-700);
}
.rd-tag-depends {
  background: var(--tw-blue-100);
  color: var(--tw-blue-700);
}

.rd-current {
  border: 2px solid var(--tw-blue-500);
  background: var(--tw-blue-50);
  border-radius: 6px;
  padding: 6px 8px;
  margin: 8px 0;
}
.rd-current-label {
  font-size: 9px;
  color: var(--tw-blue-700);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.rd-current-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--tw-blue-900);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rd-current-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 10px;
  color: var(--tw-blue-800);
}

.rd-hidden-count {
  font-size: 10px;
  color: var(--color-text-muted);
  padding: 2px 6px;
}

.rd-state {
  text-align: center;
  color: var(--color-text-muted);
  padding: 16px 8px;
  font-size: 12px;
}
.rd-state-error {
  color: var(--tw-red-700);
}
.rd-state-multi-line {
  line-height: 1.6;
}
.rd-state-line {
  font-size: 12px;
  color: var(--tw-gray-600);
}
.rd-state-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 4px;
}
.rd-state-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  padding: 1px 4px;
  background: var(--tw-gray-100);
  border-radius: 3px;
}

/* Timeline */
.rd-timeline {
  position: relative;
  list-style: none;
  margin: 0;
  padding: 0;
}
.rd-timeline-rail {
  position: absolute;
  left: 7px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: var(--tw-gray-200);
}
.rd-timeline-node {
  position: relative;
  padding: 0 0 12px 24px;
}
.rd-timeline-node:last-child {
  padding-bottom: 0;
}
.rd-timeline-dot {
  position: absolute;
  left: 0;
  top: 2px;
  display: inline-block;
  width: 15px;
  height: 15px;
  border-radius: 9999px;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.rd-timeline-dot-highlight {
  box-shadow: 0 0 0 2px var(--tw-purple-400), 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.rd-timeline-card {
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
}
.rd-timeline-card-highlight {
  background: var(--tw-purple-50);
  border: 1px solid var(--tw-purple-200);
}
.rd-timeline-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.rd-timeline-time {
  font-size: 11px;
  color: var(--color-text-muted);
}
.rd-timeline-label {
  font-size: 11px;
  color: var(--tw-gray-700);
}
.rd-timeline-card-highlight .rd-timeline-label {
  color: var(--tw-purple-800);
  font-weight: 600;
}
.rd-timeline-duration {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}

.rd-tag {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 9999px;
}
.rd-tag-purple {
  background: var(--tw-purple-100);
  color: var(--tw-purple-800);
}
.rd-tag-gray {
  background: var(--tw-gray-100);
  color: var(--tw-gray-600);
}
.rd-tag-slate {
  background: var(--tw-slate-100);
  color: var(--tw-slate-600);
  border: 1px solid var(--tw-slate-200);
}

/* Checkpoints */
.rd-checkpoints {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rd-checkpoint {
  background: var(--tw-emerald-50);
  border: 1px solid var(--tw-emerald-200);
  border-radius: 6px;
  padding: 6px 8px;
}
.rd-checkpoint-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}
.rd-cp-step {
  color: var(--tw-emerald-700);
  font-weight: 500;
}
.rd-cp-dot {
  opacity: 0.6;
}
.rd-cp-commit {
  color: var(--color-text-muted);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rd-checkpoint-summary {
  font-size: 12px;
  color: var(--tw-gray-800);
  margin-top: 4px;
  word-break: break-word;
}
.rd-cp-fork-btn {
  margin-top: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--tw-emerald-300);
  color: var(--tw-emerald-700);
  background: var(--color-bg-elevated);
  border-radius: 4px;
  cursor: pointer;
}
.rd-cp-fork-btn:hover {
  background: var(--tw-emerald-100);
}
.rd-cp-anchor-note {
  margin-top: 2px;
  font-size: 10px;
  color: var(--color-text-muted);
}

/* Commits */
.rd-commits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rd-commit {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.rd-commit-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-size: 11px;
  transition: background 0.1s;
}
.rd-commit-row:hover {
  background: var(--tw-gray-50);
}
.rd-commit-sha {
  color: var(--tw-indigo-700);
  font-weight: 600;
  flex-shrink: 0;
  margin-top: 1px;
}
.rd-commit-desc {
  flex: 1;
  min-width: 0;
  color: var(--tw-gray-700);
  word-break: break-word;
}
.rd-commit-time {
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-top: 1px;
}
.rd-commit-files {
  border-top: 1px solid var(--tw-gray-100);
  background: var(--tw-gray-50);
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rd-commit-file {
  font-size: 10px;
  color: var(--tw-gray-600);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rd-commit-files-empty {
  border-top: 1px solid var(--tw-gray-100);
  background: var(--tw-gray-50);
  padding: 6px 10px;
  font-size: 10px;
  color: var(--color-text-muted);
  font-style: italic;
}
</style>
