<script setup lang="ts">
/* 功能: 全局看板视图 — 跨项目跨版本汇总所有 task, 支持 cards / list / grouped /
   kanban / chat 五种视图模式, 8 维筛选 (项目/版本/状态/模型/标签/搜索/已删/收藏),
   卡片显示归属 (project › version) 区分上下文, lifecycle action 跟 BoardPage
   同源 (R21 LifecycleActions 组件), awaiting marker / requirement / by-chip
   渲染对齐 Next global-board.tsx.

   关注点 (R5 sheet 边界 + R54.2 SSE 接入):
   - 单一职责: 视图 + 筛选 + action, 不拖拽. R54.2 起挂 SSE /api/events 实时更新
     (status_change 4 路分发 + cost patch), 与 Next global-board.tsx:371-435 handler
     1:1 复刻, 走 useTaskEventSource 单例 + 引用计数, 避免同域并发名额占满.
   - URL 即状态: viewMode / statusGroup / project / version / model / tag / q /
     statuses / includeDeleted / favorite / page / pageSize 全在 URL, 复制 URL =
     完整还原看板. 切 tab keep-alive 命中后再开, 不会丢状态.
     R235 例外: viewMode 多一层 localStorage 缓存 ('ao_global_mode', lib/board-mode.ts) —
     裸链接恢复上次显式点选的模式, 优先级 URL ?mode > 缓存 > viewport 缺省.
     R248 例外: statusGroup 同款 — URL ?statusGroup > localStorage 记忆
     (lib/board-status-group.ts, key 跟 syncLevel 两档) > 缺省 '全部'.
   - 数据源唯一 = GET /api/tasks/page?statusGroup=active|terminal&offset=&limit=,
     R59 起 active / terminal 隔离显示 (跟 BoardPage.board-segmented 同款 —
     用户反馈「分页无效」, 根因是 total = activeTotal + terminalTotal, 跳页
     同时拉两段拼接错乱; 现在按 statusGroup 单段加载 + 单段展示, 分页按段
     自己的 total).
     R236 (damo): 「活跃/历史」从 header 挪进状态 chip 行头部, 改成**状态分组
     快捷键** (chip 宏); chip 行展示全部 11 态, 允许跨组混选 — 混选时双段都拉
     (每段窗口切半, 见 loadSegments) + statuses param 服务端精确过滤, preset
     视图仍走 R59 单段路径, 行为不变.
     R248 (damo): 宏加「全部」(= 11 态全集双段同拉) 且成为缺省组; 活跃/历史/
     全部三档记忆走 localStorage (board-status-group.ts).
   - 服务端筛选: q/model/tag/project/version/showDeleted/favorite 全部走 query
     (与 Next buildPageQuery 同口径). 客户端只做 status 多选 (O(n) 过滤).
   - 五视图复用同一份 filteredActive + filteredTerminal + currentGroupTasks:
     cards/list/grouped/kanban/chat 用 currentGroupTasks (按 statusGroup 切),
     分页按段独立. 视图切换不触发 fetch.
   - lifecycle action 走 POST /api/tasks/{id}/{action} (与 R21 LifecycleActions
     组件 + Next 端同款). start 在并发满时后端真返 status=queued → warning toast.
   - SSE handler 4 路 (active↔active / terminal↔terminal 原地 patch; 跨集合移动;
     未知 task 按方向只 refetch 一个集合; cost 原地 patch), 不再走 refetchAll 兜底.
   - awaiting markers / requirement chip 渲染对齐 Next global-board.tsx (R84
     R94 R108 同款 chip 体系). by-chip / awaiting_reason / sub-status chip 同源.
   - 与 Next 端 3 处分歧已披露: (1) ChatView (R53 接入) — 单会话 MVP
     (chat list 多会话切换 / opencode 模型选择 留 R55+); (2) ViewSwitcher
     不抽组件, 用 inline button group (本视图专用, 不抽到 components/
     避免 L0 范围漂移); (3) R59 起 chat 模式 chrome 可折叠 (R56-B7 老特性
     恢复, 折叠按钮从 ChatView pill 挪到 chrome 自己 view-switcher 旁边). */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, del, HttpError } from '@/api/http';
import CategoryBoardView from '@/components/CategoryBoardView.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Input from '@/components/Input.vue';
import Select from '@/components/Select.vue';
import Textarea from '@/components/Textarea.vue';
import Radio from '@/components/Radio.vue';
import RadioGroup from '@/components/RadioGroup.vue';
import Checkbox from '@/components/Checkbox.vue';
import Pagination from '@/components/Pagination.vue';
import QueuedReasonHint from '@/components/QueuedReasonHint.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Modal from '@/components/Modal.vue';
import Button from '@/components/Button.vue';
import { useToast } from '@/composables/useToast';
import { useTaskEventSource } from '@/composables/useTaskEventSource';
import type { GlobalEvent } from '@/composables/useTaskEventSource';
import { parseDbTime } from '@/lib/datetime';
import { readGlobalBoardMode, writeGlobalBoardMode } from '@/lib/board-mode';
// R248: 状态分组（活跃/历史/全部）持久化记忆 — 裸链接恢复上次点选的组.
import { readBoardStatusGroup, writeBoardStatusGroup } from '@/lib/board-status-group';
import KanbanBoard from '@/views/kanban/KanbanBoard.vue';
import ChatView from '@/views/chat/ChatView.vue';
import TaskQuickCreate from '@/components/TaskQuickCreate.vue';
// R232 Round5: 系统资源小块挪顶栏 AppHeader（全页面常驻）— 本视图撤挂载与轮询,
// 顶栏统一 acquire 供全局 badge/资源条用.

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** R248: 补 'all' — 「全部」宏 (damo: 默认全部) = active+terminal 双段同拉,
    与 /api/tasks/page 服务端 StatusGroup 一致. */
type StatusGroup = 'active' | 'terminal' | 'all';

type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'verifying'
  | 'await_user'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

interface TaskTrimmed {
  id: string;
  title: string;
  description: string | null;
  prompt_preview: string;
  result_preview: string;
  error_preview: string;
  status: TaskStatus;
  priority: number;
  type: string;
  model: string | null;
  resolved_model: string | null;
  tags: string | null;
  project_id: string | null;
  version_id: string | null;
  owner_id: string | null;
  deleted_at: string | null;
  cost_usd: number | null;
  updated_at: string;
  auto_approve: number;
  context_tokens: number | null;
  context_max: number | null;
  awaiting_owner_review: number;
  awaiting_markers: string | null;
  dispatched_by_task_id: string | null;
  requirement_status: string | null;
  schedule_id: string | null;
  latest_checkpoint_status: string | null;
  awaiting_reason: string | null;
  queued_order: number | null;
  queued_reason: string | null;
}

interface TasksPageResponse {
  items: TaskTrimmed[];
  total: number;
  hasMore: boolean;
  /** R182: 同 WHERE 下 per-status 计数, 给状态 chip 显示 (如「失败 55」). */
  statusCounts?: Record<string, number>;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  current_version_id: string | null;
  current_version_name: string | null;
}

interface Version {
  id: string;
  project_id: string;
  name: string;
}

interface AwaitingMarker {
  label: string;
  title: string;
  color: string;
}

interface Bucket {
  key: string;
  label: string;
  isUnassigned: boolean;
  tasks: TaskTrimmed[];
}

type ViewMode = 'cards' | 'list' | 'grouped' | 'kanban' | 'chat' | 'category';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待执行',
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  reviewing: '待审核',
  verifying: '验收中',
  await_user: '等用户介入',
  completed: '已完成',
  failed: '失败',
  // 历史 rejected 显示兼容 (2026-09-15 决策): 读路径已映射 cancelled, 标签同步
  // 显示「已取消」— 曾误标「等待中」产生幽灵计数 (damo 2026-11-01 反馈).
  rejected: '已取消',
  cancelled: '已取消',
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'gb-status-pending',
  queued: 'gb-status-queued',
  running: 'gb-status-running',
  paused: 'gb-status-paused',
  reviewing: 'gb-status-reviewing',
  verifying: 'gb-status-verifying',
  await_user: 'gb-status-await-user',
  completed: 'gb-status-completed',
  failed: 'gb-status-failed',
  rejected: 'gb-status-rejected',
  cancelled: 'gb-status-cancelled',
};

const TYPE_LABELS: Record<string, string> = {
  design: '设计',
  dev: '开发',
  test: '测试',
  deploy: '部署',
};

const TYPE_COLORS: Record<string, string> = {
  design: 'gb-type-design',
  dev: 'gb-type-dev',
  test: 'gb-type-test',
  deploy: 'gb-type-deploy',
};

const ACTIVE_STATUSES: TaskStatus[] = [
  'pending', 'queued', 'running', 'paused', 'reviewing', 'verifying', 'await_user',
];

const TERMINAL_STATUSES: TaskStatus[] = [
  'completed', 'failed', 'rejected', 'cancelled',
];

// 完整 11 状态列出现顺序 (与 Next columnOrder 默认一致).
const COLUMN_ORDER: TaskStatus[] = [
  'pending', 'queued', 'running', 'paused',
  'reviewing', 'verifying', 'await_user',
  'completed', 'failed', 'rejected', 'cancelled',
];

// awaiting marker → chip 样式 (与 Next global-board.tsx TYPE_META 同源).
const AWAITING_TYPE_META: Record<string, { color: string; cn: string }> = {
  review: { color: 'gb-marker-review', cn: '需拍板' },
  choice: { color: 'gb-marker-choice', cn: '等选' },
  info: { color: 'gb-marker-info', cn: '提示' },
  waiting_reply: { color: 'gb-marker-waiting', cn: '等回复' },
  suggestion: { color: 'gb-marker-suggestion', cn: '有建议' },
  stuck: { color: 'gb-marker-stuck', cn: '卡住' },
};

// 状态 → 行内操作按钮 (R122 第三轮 #3 全状态核对, R131 加 await_user).
interface ActionBtn {
  key: string;
  label: string;
  tone: 'primary' | 'danger' | 'normal';
}

const STATUS_BUTTONS: Record<TaskStatus, ActionBtn[]> = {
  // R164 追加 (damo): pending/queued 也给「取消 + 删除」— 派发洪水时在列表上
  // 直接止血, 不用进详情页/改库. queued 软删后 schedule() 出队 `!task -> continue` 跳过.
  pending:   [{ key: 'start', label: '启动', tone: 'primary' }, { key: 'cancel', label: '取消', tone: 'danger' }, { key: 'delete', label: '删除', tone: 'danger' }],
  queued:    [{ key: 'start', label: '启动', tone: 'primary' }, { key: 'cancel', label: '取消', tone: 'danger' }, { key: 'delete', label: '删除', tone: 'danger' }],
  running:   [{ key: 'pause', label: '暂停', tone: 'normal' }, { key: 'cancel', label: '取消', tone: 'danger' }],
  paused:    [{ key: 'resume', label: '恢复', tone: 'primary' }, { key: 'cancel', label: '取消', tone: 'danger' }],
  reviewing: [
    { key: 'approve', label: '完成', tone: 'primary' },
    { key: 'refine', label: '继续干', tone: 'primary' },
    { key: 'restart', label: '🔄 清空重来', tone: 'danger' },
    { key: 'cancel', label: '取消', tone: 'danger' },
  ],
  verifying: [{ key: 'cancel', label: '取消', tone: 'danger' }],
  await_user: [
    { key: 'approve', label: '完成', tone: 'primary' },
    { key: 'unawait', label: '继续执行', tone: 'primary' },
    { key: 'cancel', label: '取消', tone: 'danger' },
  ],
  completed: [{ key: 'delete', label: '删除', tone: 'danger' }],
  failed:    [{ key: 'start', label: '重试', tone: 'primary' }, { key: 'delete', label: '删除', tone: 'danger' }],
  // rejected 显示已并入 cancelled (2026-09-15 决策), 行内按钮同口径 (重启/删除).
  rejected:  [{ key: 'start', label: '重启', tone: 'primary' }, { key: 'delete', label: '删除', tone: 'danger' }],
  cancelled: [{ key: 'start', label: '重启', tone: 'primary' }, { key: 'delete', label: '删除', tone: 'danger' }],
};

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
const toast = useToast();

/* ------------------------------------------------------------------ */
/*  URL state (filters / paging / viewMode)                            */
/* ------------------------------------------------------------------ */

/** R59+: 当前 viewport 缺省视图模式 — H5 = cards (避免 kanban 在窄屏被挤),
    桌面 = kanban. matchMedia 是 sync API, 在 viewMode / setViewMode / taskDetailHref
    三处共用保写盘逻辑跟 computed 双向一致. */
function currentDefaultMode(): ViewMode {
  return typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 1023px)').matches
    ? 'cards'
    : 'kanban';
}

const viewMode = computed<ViewMode>(() => {
  const v = route.query.mode;
  if (v === 'list' || v === 'grouped' || v === 'cards' || v === 'chat' || v === 'kanban' || v === 'category') return v;
  /* R235: 裸链接 (不带 ?mode) → 用户上次显式点选的模式 (localStorage),
     从未点选过才回落 viewport 缺省. 优先级: URL ?mode > 缓存 > viewport 缺省. */
  return readGlobalBoardMode() ?? currentDefaultMode();
});

/** R51 (B095) 同步配置: scope=当前 global 单 key / account=全平台共享.
    镜像 BoardPage 3 级 scope/project/account, 但 global board 没有 project 维度,
    故 project 与 scope 走同一 key. 区别仅在 account (跨用户/设备共享偏好).
    🔴 声明必须在 statusGroupKey 之前: 下方 watch([...selectedStatuses...]) 在
    setup 时同步求值 source → statusGroup → statusGroupKey → syncLevel, 声明
    在后会踩 TDZ ReferenceError → 组件挂载失败 → 全局看板整页空白
    (2026-10-27 实证, 「computed 惰性求值兜住前向引用」的假设对 watch source 不成立). */
type SyncLevel = 'scope' | 'project' | 'account';
const syncLevel = ref<SyncLevel>('scope');

/** R248: statusGroup 记忆 key — account 模式全平台共享, 否则 global board 单 key
    (命名与 chipOrder / BoardPage 完全分开, 避免相互覆盖). */
const GLOBAL_SG_KEY_DEFAULT = 'ao-global-status-group-v1';
const GLOBAL_SG_KEY_ACCOUNT = 'ao-global-status-group-account';
const statusGroupKey = computed<string>(() =>
  syncLevel.value === 'account' ? GLOBAL_SG_KEY_ACCOUNT : GLOBAL_SG_KEY_DEFAULT,
);

/** R248 (damo): statusGroup — URL ?statusGroup= 显式最优先; 裸链接读上次显式
    点选的组 (localStorage 记忆, 见 board-status-group.ts); 从未点选过回落 'all'
    (默认全部). 职责只剩「selectedStatuses 缺省回落 + preset 亮灯参照」— 数据
    拉取由 neededActive/neededTerminal 双段驱动, 与 param 值无直接耦合. */
const statusGroup = computed<StatusGroup>(() => {
  const v = route.query.statusGroup;
  if (v === 'active' || v === 'terminal' || v === 'all') return v;
  return readBoardStatusGroup(statusGroupKey.value) ?? 'all';
});

/* R236 (damo): 状态选择不再限于当前 statusGroup 段 — chip 行展示全部 11 态
   (顺序 = ACTIVE + TERMINAL 拼接, 与 COLUMN_ORDER 一致), 用户可跨组混选
   (如 running + completed). statuses param 是选择的真相之源; 不带 param 时
   回落 statusGroup 对应组全集 (「活跃/历史」preset 的默认态).
   2026-11-01: rejected 已废弃 (2026-09-15 决策, 读路径映射 cancelled) —
   chip 行/看板列只展示 DISPLAY 态 (10 个); ALL_PAGE_STATUSES 保留 11 态用于
   数据段判断 (needed* / 服务端 statuses 合法域), 两份清单别混用. */
const ALL_PAGE_STATUSES: TaskStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];
const ALL_PAGE_STATUS_SET = new Set<TaskStatus>(ALL_PAGE_STATUSES);
/** chip 行展示集 = 全集剔除 rejected (历史遗留, 已并入 cancelled 显示). */
const DISPLAY_PAGE_STATUSES: TaskStatus[] = ALL_PAGE_STATUSES.filter((s) => s !== 'rejected');
const DISPLAY_PAGE_STATUS_SET = new Set<TaskStatus>(DISPLAY_PAGE_STATUSES);

/** 选择集比较: 大小相等 + 逐个包含 = 集合相等 (给 preset 亮灯 / toggleStatus
   判断「恰好回到某组全集」用). */
function statusSetEq(a: Set<TaskStatus>, list: readonly TaskStatus[]): boolean {
  if (a.size !== list.length) return false;
  return list.every((s) => a.has(s));
}

const selectedStatuses = computed<Set<TaskStatus>>(() => {
  const raw = route.query.statuses;
  // R236: statuses='' (显式清空) = 真空态 (全不选), 不回落默认 — 用户把 chip
  // 全点掉时看到空列表 + 空态提示, 点「活跃/历史」一键回全集.
  if (raw === '') return new Set<TaskStatus>();
  if (typeof raw === 'string' && raw) {
    const arr = raw
      .split(',')
      .filter((s): s is TaskStatus => ALL_PAGE_STATUS_SET.has(s as TaskStatus));
    if (arr.length) return new Set<TaskStatus>(arr);
  }
  const def = statusGroup.value === 'active' ? ACTIVE_STATUSES
    : statusGroup.value === 'terminal' ? TERMINAL_STATUSES
    : ALL_PAGE_STATUSES;
  return new Set<TaskStatus>(def);
});

/** R236 + R248: 当前选择恰好等于某组全集 → 对应 preset 按钮亮灯. 自定义混选 /
   组内子集 → 都不亮 (按钮此时语义是「一键回到该组全集」). */
const allPresetOn = computed<boolean>(() => statusSetEq(selectedStatuses.value, ALL_PAGE_STATUSES));
const activePresetOn = computed<boolean>(() => statusSetEq(selectedStatuses.value, ACTIVE_STATUSES));
const terminalPresetOn = computed<boolean>(() => statusSetEq(selectedStatuses.value, TERMINAL_STATUSES));

/** R236: 当前选择落到哪些数据段. 单段 = 老行为 (只拉那段, 分页窗口 pageSize);
   跨组混选 = 双段都拉 (窗口切半, 见 loadSegments), 前端拼接展示. */
const neededActive = computed<boolean>(() =>
  [...selectedStatuses.value].some((s) => (ACTIVE_STATUSES as readonly string[]).includes(s)),
);
const neededTerminal = computed<boolean>(() =>
  [...selectedStatuses.value].some((s) => (TERMINAL_STATUSES as readonly string[]).includes(s)),
);

/** R236: URL 里显式写的 statuses param 原文 (给服务端请求透传 — 服务端精确
   过滤让 total/分页数学对上子集, 客户端 filterPredicate 双层兜底). */
const explicitStatuses = computed<string | undefined>(() => {
  const raw = route.query.statuses;
  return typeof raw === 'string' && raw ? raw : undefined;
});

const searchText = computed<string>({
  get: () => String(route.query.q || ''),
  set: (v: string) => updateQuery({ q: v || undefined }),
});

const debouncedSearch = ref<string>(searchText.value);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchText, (v) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { debouncedSearch.value = v; }, 200);
});

const projectFilter = computed<string>({
  get: () => String(route.query.project || ''),
  set: (v: string) => updateQuery({ project: v || undefined, version: undefined }),
});
const projectSelect = computed<string | null>({
  get: () => projectFilter.value || null,
  set: (v: string | null) => { projectFilter.value = v || ''; },
});

const versionFilter = computed<string>({
  get: () => String(route.query.version || ''),
  set: (v: string) => updateQuery({ version: v || undefined }),
});
const versionSelect = computed<string | null>({
  get: () => versionFilter.value || null,
  set: (v: string | null) => { versionFilter.value = v || ''; },
});

const modelFilter = computed<string>({
  get: () => String(route.query.model || ''),
  set: (v: string) => updateQuery({ model: v || undefined }),
});
const modelSelect = computed<string | null>({
  get: () => modelFilter.value || null,
  set: (v: string | null) => { modelFilter.value = v || ''; },
});

const tagFilter = computed<string>({
  get: () => String(route.query.tag || ''),
  set: (v: string) => updateQuery({ tag: v || undefined }),
});
const tagSelect = computed<string | null>({
  get: () => tagFilter.value || null,
  set: (v: string | null) => { tagFilter.value = v || ''; },
});

const showDeleted = computed<boolean>({
  get: () => route.query.includeDeleted === 'true',
  set: (v: boolean) => updateQuery({ includeDeleted: v ? 'true' : undefined }),
});

const favoriteOnly = computed<boolean>({
  get: () => route.query.favorite === 'true',
  set: (v: boolean) => updateQuery({ favorite: v ? 'true' : undefined }),
});

const currentPage = computed<number>({
  get: () => {
    const n = Number(route.query.page || 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  },
  set: (v: number) => updateQuery({ page: v > 1 ? String(v) : undefined }),
});

const pageSize = computed<number>({
  get: () => {
    const n = Number(route.query.pageSize || 50);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50;
  },
  set: (v: number) => updateQuery({ pageSize: v !== 50 ? String(v) : undefined }),
});

function updateQuery(patch: Record<string, string | undefined>): void {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (typeof v === 'string') next[k] = v;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  router.replace({ query: next });
}

/* R58.5/R59+: setViewMode 跟当前 viewport 缺省对齐 — mode 等于缺省时移除 param
   (URL 干净), 否则写. 写盘逻辑跟 viewMode computed 双向一致, 跟 BoardPage.vue
   同款 (共享 currentDefaultMode 实现, 但跨文件不抽公共 — GlobalBoard 跟 BoardPage
   各自跑自己的视图模式, 抽公共反而耦合). 之前 line 是 m === 'kanban' ? undefined
   : m — 当时默认 cards 没问题; 改成 H5=cards / 桌面=kanban 动态缺省后必须动态. */
function setViewMode(m: ViewMode): void {
  if (viewMode.value === m) return;
  /* R235: 显式点选即持久化 — 下次裸链接 (#/global 不带 ?mode) 进来恢复该模式
     (readGlobalBoardMode). 写缓存要在剥 param 之前完成: 点选「等于 viewport
     缺省」的模式时 URL param 会被剥掉, viewMode computed 靠缓存 ref 重算. */
  writeGlobalBoardMode(m);
  updateQuery({ mode: m === currentDefaultMode() ? undefined : m });
}

/* R58.5: task 卡片 router-link 跳转时把当前 GlobalBoard 状态写到 URL query.
   用户反馈「点击卡片没有带条件」: 之前只带 mode → 返回 GlobalBoard 走默认
   kanban, 其他筛选条件 (project / version / q / favorite / statusGroup / model
   / tag) 也没体现. 把全部非默认筛选写进 task URL query → 用户后退/刷新/
   详情页内主动跳回 GlobalBoard 都能恢复状态.
   详情页 /tasks/{id} 不读这些 query, 无副作用. */
function taskDetailHref(taskId: string): { path: string; query: Record<string, string> } {
  const next: Record<string, string> = {};
  if (viewMode.value !== currentDefaultMode()) next.mode = viewMode.value;
  // R248: 非缺省组才写 — 缺省 = 持久化记忆 (无记忆 = 'all'), 跳回时走记忆恢复.
  if (statusGroup.value !== (readBoardStatusGroup(statusGroupKey.value) ?? 'all')) {
    next.statusGroup = statusGroup.value;
  }
  if (projectFilter.value) next.project = projectFilter.value;
  if (versionFilter.value) next.version = versionFilter.value;
  if (showDeleted.value) next.includeDeleted = 'true';
  if (favoriteOnly.value) next.favorite = 'true';
  if (debouncedSearch.value) next.q = debouncedSearch.value;
  if (modelFilter.value) next.model = modelFilter.value;
  if (tagFilter.value) next.tag = tagFilter.value;
  return { path: `/tasks/${taskId}`, query: next };
}

/* R236 (damo): 「活跃/历史」从 header 挪进状态 chip 行头部, 语义从「切段加载
   开关」改成**状态分组快捷键** (chip 宏): 点「活跃」= 全选 7 个活跃态 + 反选
   全部终态 (等效把 completed/failed 等一个个点掉, 但一次点击完成). R248 加
   「全部」宏 = 双段全集, 且成为缺省 (URL 无 param + 无记忆时).
   实现 = 写持久化记忆 (下次裸链接恢复) + 清 statuses param (回落该组全集默认)
   + 剥 statusGroup param (缺省 = 记忆, URL 保持干净 — R235 mode 同款套路).
   重复点击同一组也重置 — 从自定义混选一键回到该组全集.
   2026-11-01 (damo): 「全部」宏升级为 toggle — 已是全选态再点 = 全不选
   (?statuses= 真空态, needed 双 false 不拉数据), 之后再点单个 chip 即
   「只看该状态」, 免去逐个点掉其余状态的麻烦; 再点「全部」回全集, 行为对称.
   「活跃/历史」保持原语义 (重复点击 = 回组全集). */
function setStatusGroup(g: StatusGroup): void {
  const wasAllOn = g === 'all' && statusSetEq(selectedStatuses.value, ALL_PAGE_STATUSES);
  writeBoardStatusGroup(statusGroupKey.value, g);
  if (wasAllOn) {
    updateQuery({ statusGroup: undefined, statuses: '', page: undefined });
    return;
  }
  updateQuery({ statusGroup: undefined, statuses: undefined, page: undefined });
}

function toggleStatus(s: TaskStatus): void {
  const next = new Set(selectedStatuses.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  // R236 + R248: 选择恰好等于某组全集 → 清 params + 记住该组 (preset 亮灯,
  // 数据按 needed 段加载); 跨组混选 / 组内子集 → 显式写 statuses param (服务端
  // 精确过滤). 全清空 = statuses='' (真空态, 不回落默认).
  if (statusSetEq(next, ALL_PAGE_STATUSES)) {
    setStatusGroup('all');
    return;
  }
  if (statusSetEq(next, ACTIVE_STATUSES)) {
    setStatusGroup('active');
    return;
  }
  if (statusSetEq(next, TERMINAL_STATUSES)) {
    setStatusGroup('terminal');
    return;
  }
  updateQuery({ statuses: Array.from(next).join(','), page: undefined });
}

/* ------------------------------------------------------------------ */
/*  Data fetching                                                      */
/* ------------------------------------------------------------------ */

const projects = ref<Project[]>([]);
const versions = ref<Version[]>([]);
const activeTasks = ref<TaskTrimmed[]>([]);
const terminalTasks = ref<TaskTrimmed[]>([]);
const activeTotal = ref<number>(0);
const terminalTotal = ref<number>(0);
/** R182: per-status 计数 (来自 /api/tasks/page statusCounts), 给状态 chip 显示.
   R236: 拆成两段各自存 — 跨组混选时两段请求都回来, 按 key 合并 (两段 status
   键天然不相交, 覆盖顺序无影响); 非 0 才渲染. */
const statusCountsActive = ref<Record<string, number>>({});
const statusCountsTerminal = ref<Record<string, number>>({});
const statusCounts = computed<Record<string, number>>(() => ({
  ...statusCountsActive.value,
  ...statusCountsTerminal.value,
}));

const loadingActive = ref<boolean>(false);
const loadingTerminal = ref<boolean>(false);
const loadingMeta = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

function buildPageParams(group: StatusGroup, offset: number, limit: number): URLSearchParams {
  const p = new URLSearchParams();
  p.set('statusGroup', group);
  if (projectFilter.value) {
    p.set('project', projectFilter.value);
    // 飞书 AO-DEV R218: 'null' 字面量 = 未挂版本桶 → 走后端 unversioned=true (IS NULL).
    if (versionFilter.value === 'null') p.set('unversioned', 'true');
    else if (versionFilter.value) p.set('version', versionFilter.value);
  }
  if (showDeleted.value) p.set('includeDeleted', 'true');
  if (favoriteOnly.value) p.set('favorite', 'true');
  if (debouncedSearch.value) p.set('q', debouncedSearch.value);
  if (modelFilter.value) p.set('model', modelFilter.value);
  if (tagFilter.value) p.set('tag', tagFilter.value);
  p.set('limit', String(limit));
  p.set('offset', String(offset));
  // R236: 显式 statuses param 透传服务端 — 精确过滤让 total / 分页数学跟住
  // 子集 (之前组内子集只有服务端组级 total, 跳页尾页稀疏). 非法值服务端丢弃.
  if (explicitStatuses.value) p.set('statuses', explicitStatuses.value);
  return p;
}

async function loadMeta(): Promise<void> {
  loadingMeta.value = true;
  try {
    const [projRes, verRes] = await Promise.all([
      get<{ projects: Project[] }>('/api/projects'),
      get<{ versions: Version[] }>('/api/versions'),
    ]);
    projects.value = Array.isArray(projRes?.projects) ? projRes.projects : [];
    versions.value = Array.isArray(verRes?.versions) ? verRes.versions : [];
  } catch {
    // meta 加载失败不阻断主数据; 筛选栏显示「加载失败」即可, 主数据后续自拉.
    projects.value = [];
    versions.value = [];
  } finally {
    loadingMeta.value = false;
  }
}

/** R56-B20: active 段也按 pageSize 分页 — 之前硬编码 activeLimit=200,
   pageSize=50 时 active 仍 200 + terminal 50 = 250 条/页, 用户报"选了 50
   还是 100 条"实际是 active 没跟着切. 现在 active 用同一 pageSize,
   total=activeTotal (服务端全量 active 计数), page-jump 同步重拉两边. */
async function loadActive(offset: number): Promise<void> {
  loadingActive.value = true;
  error.value = null;
  try {
    // R236: limit 用 currentPerSeg() — 双段混选时每段窗口切半, offset 才不与翻页重叠
    const data = await get<TasksPageResponse>(
      `/api/tasks/page?${buildPageParams('active', offset, currentPerSeg()).toString()}`,
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    activeTasks.value = items;
    activeTotal.value = typeof data?.total === 'number' ? data.total : items.length;
    statusCountsActive.value = data?.statusCounts && typeof data.statusCounts === 'object' ? data.statusCounts : {};
  } catch (e: unknown) {
    setError(e);
  } finally {
    loadingActive.value = false;
    retrying.value = false;
  }
}

async function loadTerminal(offset: number): Promise<void> {
  loadingTerminal.value = true;
  error.value = null;
  try {
    // R236: limit 用 currentPerSeg() — 同 loadActive, 双段窗口切半保页窗口自洽
    const data = await get<TasksPageResponse>(
      `/api/tasks/page?${buildPageParams('terminal', offset, currentPerSeg()).toString()}`,
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    terminalTasks.value = items;
    terminalTotal.value = typeof data?.total === 'number' ? data.total : items.length;
    statusCountsTerminal.value = data?.statusCounts && typeof data.statusCounts === 'object' ? data.statusCounts : {};
  } catch (e: unknown) {
    setError(e);
  } finally {
    loadingTerminal.value = false;
    retrying.value = false;
  }
}

function setError(e: unknown): void {
  if (e instanceof HttpError) {
    error.value = e.message || `请求失败 (HTTP ${e.status})`;
  } else if (e instanceof Error) {
    error.value = `网络异常: ${e.message}`;
  } else {
    error.value = '加载失败';
  }
}

/** R236: 双段同拉时每段窗口 = floor(pageSize/段数). offset / limit / 翻页数学
   必须共用这一个数 — 之前 limit 仍用整 pageSize, 混选页实际拉 2×pageSize 条,
   且翻页 offset(perSeg) 与 limit(pageSize) 窗口重叠 50%. preset 单段 = pageSize,
   与 R59 行为一致. */
function currentPerSeg(): number {
  const segCount = (neededActive.value ? 1 : 0) + (neededTerminal.value ? 1 : 0);
  return segCount > 1 ? Math.max(1, Math.floor(pageSize.value / segCount)) : pageSize.value;
}

/** R56-B7+R59: 按 statusGroup 切 active / terminal 段, 只加载 + 只展示选中段.
   R236 扩展: 选择可跨组 (chip 宏语义下用户自由混选) — neededGroups 决定拉几段.
   跨组混选时每段窗口 = currentPerSeg(), 拼回来 ≈ 一个 pageSize 页, 保住
   「每页 N 条」体感; total = 两段服务端 total 之和, 页数 = ceil(total/pageSize),
   窗口数学自洽 (不复活 R59 前「跳页同时拉两段整窗」的拼接错乱). preset 视图
   (活跃/历史) 恒为单段 = 与 R59 行为完全一致. */
function loadSegments(pageIdx: number): void {
  const offset = pageIdx * currentPerSeg();
  if (neededActive.value) void loadActive(offset);
  if (neededTerminal.value) void loadTerminal(offset);
}

function refreshAll(): void {
  loadSegments(currentPage.value - 1);
}

/** R59: 跳页时只重拉 needed 段 (窗口按段切半, 见 loadSegments). status 选择
   切换走 watcher 自动 refreshAll, 这里专门处理 page-jump (保留 SSE 跨段移动
   逻辑, 不主动 patch). */
function onPageJump(p: number): void {
  currentPage.value = p;
  loadSegments(p - 1);
}

function onRetry(): void {
  retrying.value = true;
  refreshAll();
}

function onPageSizeChange(next: number): void {
  /* 一次 router.replace 写两个字段 — 分两次 setter 各自调 updateQuery 会
     读 stale route.query (router.replace 异步, 第二个 setter 拿到 pageSize=50),
     把 pageSize=20 给覆盖, 用户看到的还是 50 条. 合成一次 patch 避免 race. */
  updateQuery({
    pageSize: next !== 50 ? String(next) : undefined,
    page: undefined,
  });
}

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

const projectNames = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  for (const p of projects.value) m[p.id] = p.name;
  return m;
});

const versionNames = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  for (const v of versions.value) m[v.id] = v.name;
  return m;
});

const versionOptions = computed<{ value: string; label: string }[]>(() => {
  const list = projectFilter.value
    ? versions.value.filter((v) => v.project_id === projectFilter.value)
    : versions.value;
  // 飞书 AO-DEV R218: 追加「其他版本」桶 (value='null' 字面量) = 未挂具体版本的条目。
  //   仅选中项目时出现 (与 Assets 一致; 后端 unversioned=true 也要求 project),
  //   标签按级联格式拼 → 如「taoke / 其他版本」。
  const opts: { value: string; label: string }[] = [
    { value: '', label: '全部版本' },
    ...list.map((v) => ({
      value: v.id,
      label: `${projectNames.value[v.project_id] || '?'} / ${v.name}`,
    })),
  ];
  if (projectFilter.value) {
    opts.push({
      value: 'null',
      label: `${projectNames.value[projectFilter.value] || '?'} / 其他版本`,
    });
  }
  return opts;
});

const projectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: '全部项目' },
  ...projects.value.map((p) => ({ value: p.id, label: p.name })),
]);

const modelOptions = computed<{ value: string; label: string }[]>(() => {
  const m = new Set<string>();
  for (const t of [...activeTasks.value, ...terminalTasks.value]) if (t.model) m.add(t.model);
  const list = Array.from(m).sort();
  return [{ value: '', label: '全部模型' }, ...list.map((x) => ({ value: x, label: x }))];
});

const tagOptions = computed<{ value: string; label: string }[]>(() => {
  const tags = new Set<string>();
  for (const t of [...activeTasks.value, ...terminalTasks.value]) {
    const arr = parseTags(t.tags);
    for (const x of arr) tags.add(x);
  }
  const list = Array.from(tags).sort();
  return [{ value: '', label: '全部标签' }, ...list.map((x) => ({ value: x, label: x }))];
});

const filterPredicate = (t: TaskTrimmed): boolean => {
  if (t.deleted_at && !showDeleted.value) return false;
  if (!selectedStatuses.value.has(t.status)) return false;
  if (projectFilter.value && t.project_id !== projectFilter.value) return false;
  // 飞书 AO-DEV R218: 'null' 字面量 = 只看未挂版本的条目。
  if (versionFilter.value === 'null') {
    if (t.version_id) return false;
  } else if (versionFilter.value && t.version_id !== versionFilter.value) {
    return false;
  }
  if (modelFilter.value && t.model !== modelFilter.value) return false;
  if (tagFilter.value) {
    const arr = parseTags(t.tags);
    if (!arr.includes(tagFilter.value)) return false;
  }
  return true;
};

const filteredActive = computed<TaskTrimmed[]>(() => activeTasks.value.filter(filterPredicate));
const filteredTerminal = computed<TaskTrimmed[]>(() => terminalTasks.value.filter(filterPredicate));
/* R59: 当前选中 statusGroup 的任务列表 — 卡片/列表/分组/看板统一用这个,
   分页按段独立. R236: 选择可跨组 — needed 段拼接 (active 前 terminal 后),
   双段同屏时按 updated_at 倒序重排一次 (页内排序; 跨页顺序不保证全局有序).
   preset 视图恒单段, 行为与 R59 完全一致. */
const currentGroupTasks = computed<TaskTrimmed[]>(() => {
  const list: TaskTrimmed[] = [
    ...(neededActive.value ? filteredActive.value : []),
    ...(neededTerminal.value ? filteredTerminal.value : []),
  ];
  if (neededActive.value && neededTerminal.value) {
    list.sort((a, b) => {
      const ta = parseDbTime(a.updated_at)?.getTime() ?? 0;
      const tb = parseDbTime(b.updated_at)?.getTime() ?? 0;
      return tb - ta;
    });
  }
  return list;
});
const currentGroupTotal = computed<number>(() => {
  let total = 0;
  if (neededActive.value) total += activeTotal.value;
  if (neededTerminal.value) total += terminalTotal.value;
  return total;
});

// 按 project_id 分桶 (grouped view). R59: 用 currentGroupTasks 单段,
// active/terminal 隔离, 分段看各自的桶.
const buckets = computed<Bucket[]>(() => {
  const map = new Map<string, TaskTrimmed[]>();
  for (const t of currentGroupTasks.value) {
    const k = t.project_id || '__unassigned__';
    const arr = map.get(k);
    if (arr) arr.push(t);
    else map.set(k, [t]);
  }
  const arr: Bucket[] = Array.from(map.entries()).map(([key, ts]) => ({
    key,
    label: key === '__unassigned__' ? '未分类' : (projectNames.value[key] || key.slice(0, 8)),
    isUnassigned: key === '__unassigned__',
    tasks: ts,
  }));
  arr.sort((a, b) => {
    if (a.isUnassigned) return 1;
    if (b.isUnassigned) return -1;
    return a.label.localeCompare(b.label, 'zh-CN');
  });
  return arr;
});

/* R236: 初次加载态按 needed 段判断 — 历史 preset 只看 terminal 段时也正确显示
   加载中 (之前只盯 loadingActive, terminal-only 视图首屏没有 loading). */
const initialLoading = computed<boolean>(() => {
  if (error.value) return false;
  if (neededActive.value && loadingActive.value && activeTasks.value.length === 0) return true;
  if (neededTerminal.value && loadingTerminal.value && terminalTasks.value.length === 0) return true;
  return false;
});

/* ------------------------------------------------------------------ */
/*  Task actions                                                       */
/* ------------------------------------------------------------------ */

const deleteConfirm = ref<{ taskId: string; taskTitle: string; status?: TaskStatus } | null>(null);
const refineDialog = ref<{ taskId: string; taskTitle: string } | null>(null);
const refineMessage = ref<string>('');

async function runAction(taskId: string, action: string, body?: Record<string, unknown>): Promise<void> {
  try {
    if (action === 'delete') {
      // R164 修复 latent bug: 之前走 POST /api/tasks/[id]/delete, 后端无此子路由
      // 恒 404 → 删除从未成功过. 改走真 DELETE /api/tasks/[id] (软删).
      await del<void>(`/api/tasks/${taskId}`);
      const now = new Date().toISOString();
      patchTask(taskId, { deleted_at: now });
      return;
    }
    const url = body
      ? `/api/tasks/${taskId}/${action}`
      : `/api/tasks/${taskId}/${action}`;
    const data = await post<{ status?: TaskStatus }>(url, body);
    if (action === 'start' && data?.status === 'queued') {
      toast.warn('已加入排队, 并发已满, 等槽位空闲后自动运行');
    } else if (action === 'restore') {
      patchTask(taskId, { deleted_at: null });
    } else if (data?.status) {
      patchTask(taskId, { status: data.status, updated_at: new Date().toISOString() });
    }
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      toast.error(`${action} 失败: ${e.message || `HTTP ${e.status}`}`);
    } else if (e instanceof Error) {
      toast.error(`网络错误: ${e.message}`);
    } else {
      toast.error(`${action} 失败`);
    }
  }
}

function patchTask(id: string, patch: Partial<TaskTrimmed>): void {
  activeTasks.value = activeTasks.value.map((t) => (t.id === id ? { ...t, ...patch } : t));
  terminalTasks.value = terminalTasks.value.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

function handleDeleteClick(task: TaskTrimmed, e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  deleteConfirm.value = { taskId: task.id, taskTitle: task.title, status: task.status };
}

async function confirmDelete(): Promise<void> {
  const ctx = deleteConfirm.value;
  deleteConfirm.value = null;
  if (!ctx) return;
  // R164 追加: 非终态任务先 cancel 再删 — cancelTask 会把内存队列 dequeue 干净,
  // 否则 DB status 停在 queued 语义混乱. cancel 尽力而为, 失败不阻断删除.
  const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'queued', 'running', 'paused', 'reviewing', 'verifying', 'await_user'];
  if (ctx.status && ACTIVE_STATUSES.includes(ctx.status)) {
    try { await post<void>(`/api/tasks/${ctx.taskId}/cancel`); } catch { /* 尽力 cancel, 失败继续删 */ }
  }
  await runAction(ctx.taskId, 'delete');
}

function handleRestoreClick(task: TaskTrimmed, e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  void runAction(task.id, 'restore');
}

function handleRefineClick(task: TaskTrimmed): void {
  refineDialog.value = { taskId: task.id, taskTitle: task.title };
  refineMessage.value = '';
}

async function submitRefine(): Promise<void> {
  const ctx = refineDialog.value;
  refineDialog.value = null;
  if (!ctx) return;
  const msg = refineMessage.value.trim();
  await runAction(ctx.taskId, 'refine', msg ? { message: msg } : undefined);
  refineMessage.value = '';
}

function canDeleteTask(status: TaskStatus, deletedAt: string | null): boolean {
  // Next canDeleteTask 守门: terminal 状态 + 已删除可走 delete endpoint.
  // 与 master src/lib/constants.ts canDeleteTask 同口径.
  // R164 追加 (damo): pending/queued 放开 — 派发洪水止血要能直接删;
  // queued 软删后 schedule() 出队 `!task -> continue` 跳过, 不会跑起来.
  if (deletedAt) return true;
  return ['pending', 'queued', 'completed', 'failed', 'rejected', 'cancelled'].includes(status);
}

function handleListAction(task: TaskTrimmed, action: string): void {
  if (action === 'delete' && !canDeleteTask(task.status, task.deleted_at)) {
    toast.error('无法删除此任务');
    return;
  }
  if (action === 'refine') {
    handleRefineClick(task);
    return;
  }
  void runAction(task.id, action);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function formatUpdatedAt(iso: string): string {
  // R56-B18: 用 parseDbTime 当 UTC 处理 (master src/lib/datetime.ts 同口径).
  // 旧实现 new Date(iso) 把 SQLite UTC 时间当本地时间, CST 偏 8h, 跟 master
  // /global 看板对不上 (例 master 显示 08-26 07:03, SPA 显示 08-25 23:03).
  const d = parseDbTime(iso);
  if (!d) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildHoverTooltip(task: TaskTrimmed): string {
  const text = (task.result_preview && task.result_preview.trim())
    || (task.prompt_preview && task.prompt_preview.trim())
    || task.title;
  return text.slice(0, 300);
}

function parseAwaitingMarkers(json: string | null, awaitingOwnerReview: number): AwaitingMarker[] {
  if (json) {
    try {
      const parsed = JSON.parse(json) as Array<{ type?: string; desc?: string | null }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m) => {
          const t = (m.type || 'review').toLowerCase();
          const meta = AWAITING_TYPE_META[t] || {
            color: 'gb-marker-default',
            cn: t || '需拍板',
          };
          const descSnippet = m.desc
            ? ` · ${m.desc.slice(0, 20)}${m.desc.length > 20 ? '…' : ''}`
            : '';
          return {
            label: `${meta.cn}${descSnippet}`,
            title: m.desc ? `${t}: ${m.desc}` : `awaiting marker (type=${t})`,
            color: meta.color,
          };
        });
      }
    } catch {
      // 解析失败 → 走 awaiting_owner_review 回退.
    }
  }
  if (awaitingOwnerReview === 1) {
    return [{
      label: '需拍板',
      title: 'Agent 标了需拍板 — 需先调 unset-awaiting-review 才能 approve',
      color: 'gb-marker-review',
    }];
  }
  return [];
}

function requirementChip(task: TaskTrimmed): { label: string; title: string; color: string } | null {
  // 简化版 requirement chip — 与 Next getRequirementChipMeta 形态对齐 (4 态):
  // pending / in_progress / done / cancelled.
  const r = task.requirement_status;
  if (!r) return null;
  const map: Record<string, { label: string; color: string }> = {
    pending: { label: '需求待办', color: 'gb-req-pending' },
    in_progress: { label: '需求进行中', color: 'gb-req-in-progress' },
    done: { label: '需求完成', color: 'gb-req-done' },
    cancelled: { label: '需求取消', color: 'gb-req-cancelled' },
  };
  const meta = map[r];
  if (!meta) return null;
  return { label: meta.label, title: `requirement_status: ${r}`, color: meta.color };
}

/* ------------------------------------------------------------------ */
/*  Watchers                                                           */
/* ------------------------------------------------------------------ */

watch(
  [
    selectedStatuses, debouncedSearch,
    projectFilter, versionFilter,
    modelFilter, tagFilter,
    showDeleted, favoriteOnly,
    pageSize,
  ],
  () => {
    currentPage.value = 1;
    refreshAll();
  },
);

// 切项目时清空 version (避免 version 不属于该项目).
watch(projectFilter, (v) => {
  if (v && versionFilter.value) {
    const found = versions.value.find((x) => x.id === versionFilter.value);
    if (!found || found.project_id !== v) {
      versionFilter.value = '';
    }
  }
});

/* ------------------------------------------------------------------ */
/*  R56-A1: status chip 行拖拽重排 + 同步齿轮                            */
/* ------------------------------------------------------------------ */

/** R51 (B095) 同步配置: scope=当前 global 单 key / account=全平台共享.
    镜像 BoardPage 3 级 scope/project/account, 但 global board 没有 project 维度,
    故 project 与 scope 走同一 key. 区别仅在 account (跨用户/设备共享偏好).
    (syncLevel ref 本体声明在文件前段 — statusGroupKey 链路要在 setup watch
    同步求值时用到, 详见前段注释.) */
const showSyncMenu = ref<boolean>(false);
const syncMenuRef = ref<HTMLElement | null>(null);

const SYNC_META: Record<SyncLevel, { label: string; hint: string }> = {
  scope: { label: '不同步', hint: '配置仅应用于当前 global board (本浏览器)' },
  project: { label: '弱同步', hint: 'global board 无 project 维度, 等同不同步' },
  account: { label: '强同步', hint: '所有浏览器 / 设备共享同一偏好' },
};

/** 同步级别 localStorage key — 与 BoardPage (ao-board-sync-level) 区分, 各自独立. */
const GLOBAL_SYNC_KEY = 'ao-global-sync-level';

function loadSyncLevel(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(GLOBAL_SYNC_KEY);
    if (raw === 'scope' || raw === 'project' || raw === 'account') {
      syncLevel.value = raw;
    }
  } catch { /* ignore */ }
}

function setSyncLevel(level: SyncLevel): void {
  syncLevel.value = level;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(GLOBAL_SYNC_KEY, level); } catch { /* ignore */ }
  }
  showSyncMenu.value = false;
  // 重新解析 chipOrderKey → 触发 watch loadChipOrder. 直接调一次也安全.
  loadChipOrder();
}

/** localStorage key 解析: account → 全平台共享, 否则 → 当前 global board 单 key.
    命名与 BoardPage (ao-board-column-order-*) 完全分开, 避免相互覆盖. */
const GLOBAL_CHIP_KEY_DEFAULT = 'ao-global-chip-order-v1';
const GLOBAL_CHIP_KEY_ACCOUNT = 'ao-global-chip-order-account';

const chipOrderKey = computed<string>(() => {
  if (syncLevel.value === 'account') return GLOBAL_CHIP_KEY_ACCOUNT;
  return GLOBAL_CHIP_KEY_DEFAULT;
});

/** R51 (B093): 当前 chip 顺序. 缺省 = 显示态全集顺序 (R236: 之前只展示当前
    statusGroup 段的状态, 现在 chip 行是唯一筛选真相, 全量展示; 顺序 =
    ACTIVE + TERMINAL 拼接, 与 COLUMN_ORDER 一致. 2026-11-01: 剔除 rejected —
    历史遗留态已并入 cancelled 显示, 不再单列 chip). 拖拽后写 localStorage,
    挂载时读回. 老用户 localStorage 里只有半组状态 → missing 追加自动迁移
    (含 rejected 残留 → valid 集过滤自动清掉). */
const chipOrder = ref<TaskStatus[]>([]);
function loadChipOrder(): void {
  const fallback = DISPLAY_PAGE_STATUSES;
  if (typeof localStorage === 'undefined') {
    chipOrder.value = [...fallback];
    return;
  }
  try {
    const raw = localStorage.getItem(chipOrderKey.value);
    if (!raw) {
      chipOrder.value = [...fallback];
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      chipOrder.value = [...fallback];
      return;
    }
    // 过滤掉不在显示集的 status (避免 stale 残留), 然后追加任何
    // 漏掉的 (保持显示集完整覆盖).
    const filtered = parsed.filter((s: unknown): s is TaskStatus =>
      typeof s === 'string' && DISPLAY_PAGE_STATUS_SET.has(s as TaskStatus),
    );
    const have = new Set(filtered);
    const missing = DISPLAY_PAGE_STATUSES.filter((s) => !have.has(s));
    chipOrder.value = [...filtered, ...missing];
  } catch {
    chipOrder.value = [...fallback];
  }
}

function saveChipOrder(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(chipOrderKey.value, JSON.stringify(chipOrder.value));
  } catch {
    /* localStorage 满 / 隐私模式 → 静默 */
  }
}

/* R51 (B093): chip 拖拽 HTML5 原生 drag/drop. 镜像 BoardPage onChipDrag*.
   draggingChip/dragOverChip 用 ref 控制视觉反馈 (opacity + amber ring). */
const draggingChip = ref<TaskStatus | null>(null);
const dragOverChip = ref<TaskStatus | null>(null);

function onChipDragStart(status: TaskStatus, e: DragEvent): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData('application/status-tag', status);
  e.dataTransfer.effectAllowed = 'move';
  draggingChip.value = status;
}

function onChipDragOver(status: TaskStatus, e: DragEvent): void {
  e.preventDefault();
  if (draggingChip.value && draggingChip.value !== status) {
    dragOverChip.value = status;
  }
}

function onChipDragLeave(status: TaskStatus): void {
  if (dragOverChip.value === status) dragOverChip.value = null;
}

function onChipDrop(target: TaskStatus, e: DragEvent): void {
  e.preventDefault();
  const from = draggingChip.value;
  draggingChip.value = null;
  dragOverChip.value = null;
  if (!from || from === target) return;
  const next = [...chipOrder.value];
  const fromIdx = next.indexOf(from);
  const toIdx = next.indexOf(target);
  if (fromIdx < 0 || toIdx < 0) return;
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, from);
  chipOrder.value = next;
  saveChipOrder();
}

function onChipDragEnd(): void {
  draggingChip.value = null;
  dragOverChip.value = null;
}

/** 同步菜单 click-outside 关闭. 镜像 BoardPage onDocMouseDown. */
function onDocMouseDown(e: MouseEvent): void {
  if (!showSyncMenu.value) return;
  const root = syncMenuRef.value;
  if (root && !root.contains(e.target as Node)) {
    showSyncMenu.value = false;
  }
}

/** Watch chipOrderKey — syncLevel 切换 / 首次挂载后重读 localStorage. */
watch(() => chipOrderKey.value, () => {
  loadChipOrder();
});

/* ------------------------------------------------------------------ */
/*  Chat view integration (R53.2 + B351 + B366 + B367)                  */
/* ------------------------------------------------------------------ */

/** chat 视图传入的"当前 project/version context". 与全局筛选栏联动 — pill 选
   project/version → emit update:projectId / update:versionId → 同步筛选栏 URL.
   反向 (筛选栏改) → 也走 projectFilter/versionFilter 派生, 单一真相. */
const chatActiveProject = computed<{ id: string; name: string } | null>(() => {
  if (!projectFilter.value) return null;
  const p = projects.value.find((x) => x.id === projectFilter.value);
  return p ? { id: p.id, name: p.name } : null;
});

const chatActiveVersion = computed<{ id: string; name: string } | null>(() => {
  if (!versionFilter.value) return null;
  const v = versions.value.find((x) => x.id === versionFilter.value);
  return v ? { id: v.id, name: v.name } : null;
});

/** B351 — chat 模式 ?taskId deep-link. 读 URL ?taskId, 如有且当前是 chat 视图
   → 传给 ChatView 当 initialTaskId (在 chat 内加载该 task, 不跳走).
   其他模式 → 不动 (master global-board.tsx:228-233 同款). */
const chatInitialTaskId = computed<string | null>(() => {
  const t = route.query.taskId;
  if (typeof t === 'string' && t) return t;
  return null;
});

/** B367 — ChatView 新建 task 后, 按 status 落到对应数组.
   preview 字段用本地 slice 算 (与 DB SUBSTR 同口径), SSE / refresh 后续覆盖. */
interface ChatTaskPayload {
  id: string;
  title: string;
  prompt?: string;
  prompt_preview?: string;
  result_preview?: string;
  status: TaskStatus;
  project_id?: string | null;
  version_id?: string | null;
  updated_at?: string;
}

function taskToTrimmed(task: ChatTaskPayload): TaskTrimmed {
  const now = new Date().toISOString();
  const promptSrc = task.prompt ?? task.prompt_preview ?? '';
  return {
    id: task.id,
    title: task.title,
    description: null,
    prompt_preview: (task.prompt_preview ?? promptSrc).slice(0, 200),
    result_preview: (task.result_preview ?? '').slice(0, 200),
    error_preview: '',
    status: task.status,
    priority: 0,
    type: 'dev',
    model: null,
    resolved_model: null,
    tags: null,
    project_id: task.project_id ?? null,
    version_id: task.version_id ?? null,
    owner_id: null,
    deleted_at: null,
    cost_usd: null,
    updated_at: task.updated_at ?? now,
    auto_approve: 0,
    context_tokens: null,
    context_max: null,
    awaiting_owner_review: 0,
    awaiting_markers: null,
    dispatched_by_task_id: null,
    requirement_status: null,
    schedule_id: null,
    latest_checkpoint_status: null,
    awaiting_reason: null,
    queued_order: null,
    queued_reason: null,
  };
}

const TERMINAL_STATUS_SET = new Set<TaskStatus>(['completed', 'failed', 'rejected', 'cancelled']);

function onChatTaskCreated(task: ChatTaskPayload): void {
  const trimmed = taskToTrimmed(task);
  if (TERMINAL_STATUS_SET.has(trimmed.status)) {
    terminalTasks.value = [trimmed, ...terminalTasks.value];
    terminalTotal.value = terminalTotal.value + 1;
  } else {
    activeTasks.value = [trimmed, ...activeTasks.value];
  }
}

/* ------------------------------------------------------------------ */
/*  SSE 实时事件订阅 (R54.2)                                           */
/* ------------------------------------------------------------------ */

// R54.2: SSE 实时事件订阅. status_change 走 4 路分发 (active↔active / terminal↔
// terminal 原地 patch; 跨集合则移动; 未知 task 按方向只 refetch 一个集合); cost
// 原地 patch cost_usd. 与 Next global-board.tsx:371-435 handler 1:1 复刻, 替代
// R54 前 refetchAll 兜底. 闭包直接读 setup() 的 activeTasks/terminalTasks/terminalTotal
// ref, 无需 cbRef — Vue setup 每组件实例只跑一次, 函数引用稳定 (与 master React
// useRef.current 每 render 重写不同).
function onGlobalEvent(raw: GlobalEvent): void {
  const event = raw;
  if (event.type === 'status_change' && event.task_id && event.to) {
    const id = event.task_id;
    const toStatus = event.to as TaskStatus;
    const toIsTerminal = TERMINAL_STATUS_SET.has(toStatus);
    const inActive = activeTasks.value.some((t) => t.id === id);
    const inTerminal = terminalTasks.value.some((t) => t.id === id);
    const now = new Date().toISOString();

    if (!inActive && !inTerminal) {
      // 未知 task: 按方向只 refetch 一个集合, 不全量 refetchAll.
      // R236: 加 needed+selected 守卫 — 目标段不在当前选择范围 (跨组混选只
      // 看一半 / 目标状态被反选) 时不白拉一段 (拉回来也会被 filterPredicate
      // 滤掉, 纯浪费请求).
      if (toIsTerminal) {
        if (neededTerminal.value && selectedStatuses.value.has(toStatus)) void loadTerminal(0);
      } else {
        if (neededActive.value && selectedStatuses.value.has(toStatus)) {
          // R236: offset 用 currentPerSeg() — 与 loadSegments 翻页窗口同一数学
          void loadActive((currentPage.value - 1) * currentPerSeg());
        }
      }
      return;
    }

    if (inTerminal && toIsTerminal) {
      terminalTasks.value = terminalTasks.value.map((t) =>
        t.id === id ? { ...t, status: toStatus, updated_at: now } : t,
      );
    } else if (inActive && !toIsTerminal) {
      activeTasks.value = activeTasks.value.map((t) =>
        t.id === id ? { ...t, status: toStatus, updated_at: now } : t,
      );
    } else if (inActive && toIsTerminal) {
      const moved = activeTasks.value.find((t) => t.id === id);
      if (moved) {
        const patched: TaskTrimmed = { ...moved, status: toStatus, updated_at: now };
        activeTasks.value = activeTasks.value.filter((t) => t.id !== id);
        terminalTasks.value = [patched, ...terminalTasks.value];
        terminalTotal.value = terminalTotal.value + 1;
      }
    } else if (inTerminal && !toIsTerminal) {
      const moved = terminalTasks.value.find((t) => t.id === id);
      if (moved) {
        const patched: TaskTrimmed = { ...moved, status: toStatus, updated_at: now };
        terminalTasks.value = terminalTasks.value.filter((t) => t.id !== id);
        activeTasks.value = [patched, ...activeTasks.value];
        terminalTotal.value = Math.max(0, terminalTotal.value - 1);
      }
    }
    return;
  }

  if (event.type === 'cost' && event.task_id && typeof event.cost_usd === 'number') {
    const id = event.task_id;
    const cost = event.cost_usd;
    if (activeTasks.value.some((t) => t.id === id)) {
      activeTasks.value = activeTasks.value.map((t) => (t.id === id ? { ...t, cost_usd: cost } : t));
    }
    if (terminalTasks.value.some((t) => t.id === id)) {
      terminalTasks.value = terminalTasks.value.map((t) => (t.id === id ? { ...t, cost_usd: cost } : t));
    }
  }
  // 其他事件类型未知, 静默忽略 (与 Next global-board.tsx:435 同款 — master
  // 不触发 refetchAll, 信任服务端 event 类型收敛).
}

/** R56-B7: chat 模式顶部 chrome 折叠/展开. 默认展开, 折叠状态持久化到
   localStorage chat-top-header-open-v1 (与 BoardPage 共享 key — 全 chat
   视图统一一个偏好). 折叠按钮放在 chrome 自己 view-switcher 旁边
   (R59 ChatView 顶部已压成一行面包屑, 没有 fold 触发器). */
const TOP_HEADER_OPEN_KEY = 'chat-top-header-open-v1';
const topHeaderOpen = ref<boolean>(true);
const topHeaderMounted = ref<boolean>(false);

onMounted(() => {
  try {
    const raw = localStorage.getItem(TOP_HEADER_OPEN_KEY);
    if (raw === '0') topHeaderOpen.value = false;
  } catch {
    /* ignore */
  }
  topHeaderMounted.value = true;
  loadSyncLevel();
  loadChipOrder();
  void loadMeta();
  refreshAll();
  if (typeof document !== 'undefined') {
    document.addEventListener('mousedown', onDocMouseDown);
  }
});

watch(topHeaderOpen, (v) => {
  if (!topHeaderMounted.value) return;
  try {
    localStorage.setItem(TOP_HEADER_OPEN_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
});

function handleToggleTopHeader(): void {
  topHeaderOpen.value = !topHeaderOpen.value;
}

/* R232 Round4 (damo 10-10): 聊天式快速创建弹窗开关 (FAB / 后续入口共用). */
const quickCreateOpen = ref(false);

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousedown', onDocMouseDown);
  }
});

// R54.2: 全局 /api/events 单例订阅 (useTaskEventSource 内部 onBeforeUnmount 清理).
// R245: SSE 断线窗口内 status_change / cost 事件永久丢失 (服务端无 Last-Event-ID
// 回放), 原地 patch 的卡片状态会僵死 — 重连时全量刷看板两段 + meta 兜底.
useTaskEventSource('/api/events', onGlobalEvent, () => {
  void loadMeta();
  refreshAll();
});
</script>

<template>
  <!-- gb-page-chat: chat 视图依赖「锁视口 + 内部滚动」布局 (.cv-page absolute
       inset:0 铺满 gb-body), 移动端文档流解锁时要豁免 — 见 style 末尾 media query. -->
  <div class="gb-page" :class="{ 'gb-page-chat': viewMode === 'chat' }">
    <!-- Header: 标题 + view switcher. R58.5: 全模式都能折叠 — 之前仅 chat
         模式, 现在 kanban/cards/list/grouped/chat 都允许收起顶部 chrome.
         折叠态由 chrome 自己 view-switcher 旁边的 toggle 触发, 状态持久化
         localStorage chat-top-header-open-v1. 折叠后 FAB 兜底展开. -->
    <header v-if="topHeaderOpen" class="gb-header">
      <div class="gb-header-text">
        <div class="gb-breadcrumb">
          <router-link to="/" class="gb-breadcrumb-link">项目</router-link>
          <span class="gb-breadcrumb-sep">›</span>
          <span class="gb-breadcrumb-current">全局看板</span>
        </div>
        <!-- R217v7 (damo): 大字「全局看板」h1 删 — 面包屑已有「全局看板」,
             大标题重复占一行. header 高度随之收一截. -->
      </div>
      <!-- R236 (damo): 「活跃/历史」segmented 从 header 挪进下方状态 chip 行
           头部 (语义改为状态分组快捷键), header 只留 view-switcher. -->
      <div class="gb-view-switcher" role="tablist" aria-label="视图模式">
        <button
          v-for="m in (['kanban', 'cards', 'list', 'grouped', 'category', 'chat'] as ViewMode[])"
          :key="m"
          type="button"
          role="tab"
          :aria-selected="viewMode === m"
          :class="['gb-view-btn', { 'gb-view-btn-active': viewMode === m }]"
          @click="setViewMode(m)"
        >
          <span class="gb-view-icon">
            <!-- R59: 5 个 view 模式用 line-style SVG 图标 (跟 chrome chevron 同款风格),
                 monochrome 跟 label 颜色一致, 不被 emoji 自带彩色字形吃掉.
                 视图宽度 14 / 高度 14 / stroke 1.5 — 跟 Heroicons outline 同比例. -->
            <template v-if="m === 'cards'">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <rect x="2" y="2" width="5" height="5" rx="1" />
                <rect x="9" y="2" width="5" height="5" rx="1" />
                <rect x="2" y="9" width="5" height="5" rx="1" />
                <rect x="9" y="9" width="5" height="5" rx="1" />
              </svg>
            </template>
            <template v-else-if="m === 'list'">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <line x1="3" y1="4.5" x2="13" y2="4.5" />
                <line x1="3" y1="8" x2="13" y2="8" />
                <line x1="3" y1="11.5" x2="13" y2="11.5" />
              </svg>
            </template>
            <template v-else-if="m === 'grouped'">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <circle cx="3.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
                <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
                <circle cx="3.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
                <line x1="6" y1="4.5" x2="13" y2="4.5" />
                <line x1="6" y1="8" x2="13" y2="8" />
                <line x1="6" y1="11.5" x2="13" y2="11.5" />
              </svg>
            </template>
            <template v-else-if="m === 'kanban'">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <rect x="2" y="3" width="3.5" height="10" rx="1" />
                <rect x="6.5" y="3" width="3.5" height="7" rx="1" />
                <rect x="11" y="3" width="3.5" height="10" rx="1" />
              </svg>
            </template>
            <template v-else-if="m === 'category'">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 4a1.5 1.5 0 011.5-1.5h3l1.5 2h5.5A1.5 1.5 0 0115 6v6a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 012 12V4z" />
              </svg>
            </template>
            <template v-else>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 5a2 2 0 012-2h6a2 2 0 012 2v3a2 2 0 01-2 2H7l-3 3v-3H5a2 2 0 01-2-2V5z" />
              </svg>
            </template>
          </span>
          <span class="gb-view-label">{{ m === 'cards' ? '卡片' : m === 'list' ? '列表' : m === 'grouped' ? '分组' : m === 'kanban' ? '看板' : m === 'category' ? '分类' : '聊天' }}</span>
        </button>
      </div>
      <!-- R59: chrome 折叠按钮 — 之前仅 chat 模式显示 (其他模式 chrome 常驻).
           R58.5: 用户反馈其他模式 (kanban / cards / list / grouped) 也需要「收起
           上方」按钮 — 全模式都允许折叠 chrome 节省纵向空间. 折叠后 FAB 兜底
           展开 (line 1342 已有). -->
      <button
        type="button"
        class="gb-chrome-toggle"
        :title="topHeaderOpen ? '收起' : '展开'"
        :aria-expanded="topHeaderOpen"
        aria-label="切换折叠"
        @click="handleToggleTopHeader"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
          <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
        </svg>
        <span>{{ topHeaderOpen ? '收起' : '展开' }}</span>
      </button>
    </header>

    <!-- R59: chrome 折叠态 FAB — catch-22 规避. 折叠按钮本身在 chrome 内,
         chrome 收起后按钮也消失, 用户回不来. 加一个 FAB 在 gb-page 右下角,
         chrome 折叠态显示, 点一下展开回 chrome. 视觉跟 chrome-toggle
         同款 chevron + 「展开 chrome」文字, ≤1024px 文字藏只剩 chevron.
         R58.5: 之前仅 chat 模式显示, 现在全模式折叠后都显示 FAB 兜底.
         R217v6 (damo): FAB 不再 absolute 悬浮 — 收起后正好盖住操作行右端
         「+新建」. 改文档流右上小条 (gb-collapsed-bar), 占一行高度但不盖任何元素. -->
    <div v-if="!topHeaderOpen" class="gb-collapsed-bar">
      <button
        type="button"
        class="gb-chrome-fab"
        :title="'展开'"
        aria-label="展开"
        @click="handleToggleTopHeader"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
          <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
        </svg>
        <span>展开</span>
      </button>
    </div>

    <!-- Filter bar. R217v6 (damo): 收起按钮本来就该收这一排 — 之前 gb-filter
         不受 topHeaderOpen 门控, 点「收起」只藏了 gb-header 标题行, 过滤排
         (项目/版本/状态/模型/标签/搜索) 纹丝不动 = 「收起没啥用」. 现在
         chrome 收起 = header + filter 全收 (过滤状态在 ref 里, 重展开不丢). -->
    <div v-if="topHeaderOpen" class="gb-filter">
      <!-- Row 1: project / version / status -->
      <div class="gb-filter-row">
        <Select
          v-model="projectSelect"
          :options="projectOptions"
          placeholder="全部项目"
          class-name="gb-filter-select"
        />
        <Select
          v-model="versionSelect"
          :options="versionOptions"
          placeholder="全部版本"
          class-name="gb-filter-select-wide"
        />
        <span class="gb-filter-label">状态</span>
        <!-- R236 (damo) + R248: 全部/活跃/历史 = 状态分组快捷键 (chip 宏) — 点
             「活跃」= 全选 7 个活跃态 + 反选全部终态 (等效把已完成/失败逐个点掉
             的一次点击版); 点「全部」= 11 态全集 (双段同拉, damo: 默认全部).
             高亮判据 = 当前 chip 选择恰等于该组全集 (自定义混选时都不亮, 此时
             按钮语义 = 一键回到该组全集). filter 行五视图
             (kanban/cards/list/grouped/chat) 共享 → 任意模式下都成立. -->
        <div class="gb-segmented gb-segmented-inline" role="tablist" aria-label="状态分组快捷键">
          <button
            type="button"
            role="tab"
            :aria-selected="allPresetOn"
            :class="['seg-btn', { 'seg-btn-active': allPresetOn }]"
            :title="allPresetOn ? '再点一次 = 全不选，然后点单个状态可只看该状态' : '全选全部状态'"
            @click="setStatusGroup('all')"
          >
            全部
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activePresetOn"
            :class="['seg-btn', { 'seg-btn-active': activePresetOn }]"
            @click="setStatusGroup('active')"
          >
            活跃
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="terminalPresetOn"
            :class="['seg-btn', { 'seg-btn-active': terminalPresetOn }]"
            @click="setStatusGroup('terminal')"
          >
            历史
          </button>
        </div>
        <!-- R56-A1: chip 行拖拽重排 — 镜像 BoardPage onChipDrag* (HTML5 原生 drag/drop).
             chipOrder 持久化到 localStorage[ao-global-chip-order-v1] (account 模式
             走 ao-global-chip-order-account). 拖拽只改 chipOrder, 不动 selectedStatuses
             (chip 是否「选中」与「位置」互不影响, 取消勾选后位置仍保留). -->
        <button
          v-for="s in chipOrder"
          :key="s"
          type="button"
          :class="[
            'gb-status-chip',
            STATUS_COLORS[s] || 'gb-status-default',
            { 'gb-status-chip-on': selectedStatuses.has(s), 'gb-status-chip-off': !selectedStatuses.has(s) },
            { 'gb-status-chip-dragging': draggingChip === s },
            { 'gb-status-chip-dragover': dragOverChip === s && draggingChip && draggingChip !== s },
          ]"
          :aria-pressed="selectedStatuses.has(s)"
          :draggable="true"
          @click="toggleStatus(s)"
          @dragstart="(e: DragEvent) => onChipDragStart(s, e)"
          @dragover="(e: DragEvent) => onChipDragOver(s, e)"
          @dragleave="() => onChipDragLeave(s)"
          @drop="(e: DragEvent) => onChipDrop(s, e)"
          @dragend="onChipDragEnd"
        >
          {{ STATUS_LABELS[s] || s }}<span
            v-if="statusCounts[s]"
            class="gb-status-chip-count"
          >{{ statusCounts[s] }}</span>
        </button>

        <!-- R56-A1: 同步配置齿轮 — 镜像 BoardPage R51.3 风格.
             3 radio (不同步/弱同步/强同步). account → 全平台共享, 否则当前
             global board 单 key. 持久化到 localStorage[ao-global-sync-level] -->
        <div ref="syncMenuRef" class="gb-sync-menu-root">
          <button
            type="button"
            class="gb-sync-menu-trigger"
            title="同步配置"
            :aria-expanded="showSyncMenu"
            @click="showSyncMenu = !showSyncMenu"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.533 1.533 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
            </svg>
          </button>
          <div v-if="showSyncMenu" class="gb-sync-menu">
            <div class="gb-sync-menu-title">同步级别</div>
            <label
              v-for="(meta, lvl) in SYNC_META"
              :key="lvl"
              :class="['gb-sync-menu-item', { 'gb-sync-menu-item-on': syncLevel === lvl }]"
            >
              <Radio
                name="globalSyncLevel"
                :value="lvl"
                :model-value="syncLevel"
                @update:model-value="(v) => setSyncLevel(v as SyncLevel)"
              />
              <span class="gb-sync-menu-text">
                <span class="gb-sync-menu-label">{{ meta.label }}</span>
                <span class="gb-sync-menu-hint">{{ meta.hint }}</span>
              </span>
            </label>
          </div>
        </div>
      </div>
      <!-- Row 2: model / tag / search / showDeleted / favorite -->
      <div class="gb-filter-row">
        <Select
          v-model="modelSelect"
          :options="modelOptions"
          placeholder="全部模型"
          class-name="gb-filter-select"
        />
        <Select
          v-model="tagSelect"
          :options="tagOptions"
          placeholder="全部标签"
          class-name="gb-filter-select"
        />
        <div class="gb-filter-search">
          <Input
            v-model="searchText"
            placeholder="搜索标题、指令、结果、标签、ID..."
            clearable
          />
        </div>
        <label class="gb-filter-toggle">
          <Checkbox
            :model-value="showDeleted"
            @update:model-value="(v: boolean) => (showDeleted = v)"
          />
          <span>显示已删除</span>
        </label>
        <label class="gb-filter-toggle gb-filter-toggle-fav" :class="{ 'gb-filter-toggle-fav-on': favoriteOnly }">
          <Checkbox
            :model-value="favoriteOnly"
            @update:model-value="(v: boolean) => (favoriteOnly = v)"
          />
          <span :class="favoriteOnly ? 'gb-star-on' : ''">★</span>
          <span>只看收藏</span>
        </label>
      </div>
    </div>

    <!-- Body -->
    <div class="gb-body">
      <!-- Initial loading -->
      <div v-if="initialLoading" class="gb-loading">
        <Loading size="lg" />
        <p class="gb-loading-text">加载中…</p>
      </div>

      <!-- Error -->
      <ErrorView
        v-else-if="error"
        title="加载失败"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <!-- Empty -->
      <Empty
        v-else-if="currentGroupTasks.length === 0"
        :title="(activeTasks.length === 0 && terminalTasks.length === 0)
          ? '暂无任务'
          : '没有匹配筛选条件的任务'"
        :description="(activeTasks.length === 0 && terminalTasks.length === 0)
          ? '新建任务后会出现在这里'
          : '试试调整筛选条件或清除搜索'"
        illustration="inbox"
      />

      <!-- CARDS VIEW -->
      <div v-else-if="viewMode === 'cards'" class="gb-cards">
        <!-- R59: 镜像 BoardPage — active / terminal 按段展示. R236: v-if 从
             statusGroup 改为 needed* — 跨组混选时两段同屏 (各段卡片丰富度
             保留: active 多 await/checkpoint 标记, terminal 多 delete/restore). -->
        <section v-if="neededActive && filteredActive.length > 0">
          <h2 class="gb-section-title">
            活跃 <span class="gb-section-count">({{ activeTotal }})</span>
          </h2>
          <div class="gb-grid">
            <article
              v-for="t in filteredActive"
              :key="t.id"
              :class="['gb-card', { 'gb-card-deleted': !!t.deleted_at }]"
            >
              <div class="gb-card-top">
                <span :class="['gb-status-badge', STATUS_COLORS[t.status] || 'gb-status-default']">
                  {{ STATUS_LABELS[t.status] || t.status }}
                </span>
                <QueuedReasonHint :status="t.status" :reason="t.queued_reason" />
                <template
                  v-for="m in parseAwaitingMarkers(t.awaiting_markers, t.awaiting_owner_review)"
                  :key="`m-${m.label}`"
                >
                  <span :class="['gb-marker', m.color]" :title="m.title">{{ m.label }}</span>
                </template>
                <span
                  v-if="requirementChip(t)"
                  :class="['gb-marker', requirementChip(t)!.color]"
                  :title="requirementChip(t)!.title"
                >
                  {{ requirementChip(t)!.label }}
                </span>
                <span v-if="t.dispatched_by_task_id" class="gb-by-chip" :title="`由 ${t.dispatched_by_task_id.slice(0, 8)} 派发`">
                  [by]{{ t.dispatched_by_task_id.slice(0, 8) }}
                </span>
                <span v-if="t.latest_checkpoint_status" class="gb-sub-status" :title="`sub-status: ${t.latest_checkpoint_status}`">
                  {{ t.latest_checkpoint_status }}
                </span>
                <span v-if="t.awaiting_reason" class="gb-sub-status" :title="`awaiting: ${t.awaiting_reason}`">
                  {{ t.awaiting_reason }}
                </span>
                <span v-if="t.type" :class="['gb-type', TYPE_COLORS[t.type] || 'gb-type-default']">
                  {{ TYPE_LABELS[t.type] || t.type }}
                </span>
                <span v-if="t.priority > 0" class="gb-priority">P{{ t.priority }}</span>
                <span v-if="t.deleted_at" class="gb-deleted-badge">已删除</span>
              </div>

              <div class="gb-scope">
                <router-link
                  v-if="t.project_id"
                  :to="`/projects/${t.project_id}`"
                  class="gb-scope-link"
                  @click.stop
                >
                  {{ projectNames[t.project_id] || '?' }}
                </router-link>
                <template v-if="t.project_id && t.version_id">
                  <span class="gb-scope-sep">›</span>
                  <router-link
                    :to="`/projects/${t.project_id}/versions/${t.version_id}`"
                    class="gb-scope-link"
                    @click.stop
                  >
                    {{ versionNames[t.version_id] || '?' }}
                  </router-link>
                </template>
              </div>

              <router-link :to="taskDetailHref(t.id)" class="gb-card-body">
                <h3 :class="['gb-card-title', { 'gb-card-title-strike': !!t.deleted_at }]">
                  {{ t.title }}
                </h3>
                <p class="gb-card-preview">{{ t.prompt_preview.slice(0, 100) }}</p>
              </router-link>

              <div class="gb-card-meta">
                <!-- R56-B17: 短任务 ID badge — cron 派发的同模板任务 (例 "R78-R80
                     监控轮次" 每 15min 一轮, 200 张卡片 title/prompt 完全一致,
                     只 cost/time 不同). 跟 TaskHeader breadcrumb 同款短哈希
                     (前 8 位 + 等宽字体 chip), 让用户一眼能区分 200 张卡片
                     实际是不同的 task. 卡片链接 = /tasks/{t.id}, 短哈希仅
                     提供视觉锚点 (复制完整 ID 仍走详情页 ⧉ 按钮). -->
                <span class="gb-card-id" :title="`任务 ID: ${t.id}`">{{ t.id.slice(0, 8) }}</span>
                <span class="gb-card-model" :title="t.resolved_model || t.model || '(default)'">
                  {{ t.resolved_model || t.model || '(default)' }}
                </span>
                <span v-if="t.cost_usd != null" class="gb-card-cost">
                  ${{ t.cost_usd.toFixed(4) }}
                </span>
                <span class="gb-card-time">{{ formatUpdatedAt(t.updated_at) }}</span>
              </div>
            </article>
          </div>
        </section>

        <!-- Terminal 段 -->
        <section v-if="neededTerminal && filteredTerminal.length > 0">
          <h2 class="gb-section-title">
            历史 <span class="gb-section-count">({{ terminalTotal }})</span>
          </h2>
          <div class="gb-grid">
            <article
              v-for="t in filteredTerminal"
              :key="t.id"
              :class="['gb-card', { 'gb-card-deleted': !!t.deleted_at }]"
              @mouseenter.stop
            >
              <button
                v-if="t.deleted_at"
                type="button"
                class="gb-card-action gb-card-action-restore"
                title="恢复任务"
                @click="handleRestoreClick(t, $event)"
              >
                ↩
              </button>
              <button
                v-else-if="(STATUS_COLORS[t.status] && ['pending','queued','completed','failed','rejected','cancelled'].includes(t.status)) || t.deleted_at"
                type="button"
                class="gb-card-action gb-card-action-delete"
                title="删除任务"
                @click="handleDeleteClick(t, $event)"
              >
                🗑
              </button>
              <div class="gb-card-top">
                <span :class="['gb-status-badge', STATUS_COLORS[t.status] || 'gb-status-default']">
                  {{ STATUS_LABELS[t.status] || t.status }}
                </span>
                <QueuedReasonHint :status="t.status" :reason="t.queued_reason" />
                <span v-if="t.priority > 0" class="gb-priority">P{{ t.priority }}</span>
                <span v-if="t.type" :class="['gb-type', TYPE_COLORS[t.type] || 'gb-type-default']">
                  {{ TYPE_LABELS[t.type] || t.type }}
                </span>
                <span v-if="t.deleted_at" class="gb-deleted-badge">已删除</span>
              </div>
              <div class="gb-scope">
                <span v-if="t.project_id">{{ projectNames[t.project_id] || '?' }}</span>
                <template v-if="t.project_id && t.version_id">
                  <span class="gb-scope-sep">›</span>
                  <span>{{ versionNames[t.version_id] || '?' }}</span>
                </template>
              </div>
              <router-link :to="taskDetailHref(t.id)" class="gb-card-body">
                <h3 :class="['gb-card-title', { 'gb-card-title-strike': !!t.deleted_at }]">
                  {{ t.title }}
                </h3>
                <p class="gb-card-preview" :title="buildHoverTooltip(t)">
                  {{ (t.result_preview || t.prompt_preview).slice(0, 100) }}
                </p>
              </router-link>
              <div class="gb-card-meta">
                <span class="gb-card-id" :title="`任务 ID: ${t.id}`">{{ t.id.slice(0, 8) }}</span>
                <span class="gb-card-time">{{ formatUpdatedAt(t.updated_at) }}</span>
              </div>
            </article>
          </div>
        </section>

        <!-- R59: Pagination 按当前段 total — 切到 active 用 activeTotal, 切到
             terminal 用 terminalTotal. 跳页只重拉当前段 (之前同时拉两段拼接错乱).
             镜像 BoardPage 单段分页形态. -->
        <Pagination
          v-if="currentGroupTotal > 0"
          :model-value="currentPage"
          :page-size="pageSize"
          :total="currentGroupTotal"
          :page-size-options="[10, 20, 50, 100, 200]"
          class-name="gb-cards-pagination"
          @update:model-value="onPageJump"
          @update:page-size="onPageSizeChange"
        />
      </div>

      <!-- LIST VIEW — R59: 单段展示 (statusGroup 切 active/terminal), 分页按段 -->
      <div v-else-if="viewMode === 'list'" class="gb-list-wrap">
        <div class="gb-list-table-wrap">
          <table class="gb-list-table">
            <thead>
              <tr>
                <th class="gb-list-th-title">标题</th>
                <th class="gb-list-th-proj">项目</th>
                <th class="gb-list-th-ver">版本</th>
                <th class="gb-list-th-status">状态</th>
                <th class="gb-list-th-type">类型</th>
                <th class="gb-list-th-time">更新时间</th>
                <th class="gb-list-th-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="task in currentGroupTasks"
                :key="task.id"
                :class="{ 'gb-list-row-deleted': !!task.deleted_at }"
              >
                <td class="gb-list-td-title">
                  <router-link
                    :to="taskDetailHref(task.id)"
                    class="gb-list-title-link"
                    :title="buildHoverTooltip(task)"
                  >
                    {{ task.title }}
                  </router-link>
                  <span v-if="task.priority > 0" class="gb-priority">P{{ task.priority }}</span>
                </td>
                <td class="gb-list-td-proj">
                  {{ task.project_id ? (projectNames[task.project_id] || '?') : '-' }}
                </td>
                <td class="gb-list-td-ver">
                  {{ task.version_id ? (versionNames[task.version_id] || '?') : '-' }}
                </td>
                <td class="gb-list-td-status">
                  <span :class="['gb-status-badge', STATUS_COLORS[task.status] || 'gb-status-default']">
                    {{ STATUS_LABELS[task.status] || task.status }}
                  </span>
                  <QueuedReasonHint :status="task.status" :reason="task.queued_reason" />
                </td>
                <td class="gb-list-td-type">
                  <span
                    v-if="task.type"
                    :class="['gb-type', TYPE_COLORS[task.type] || 'gb-type-default']"
                  >
                    {{ TYPE_LABELS[task.type] || task.type }}
                  </span>
                </td>
                <td class="gb-list-td-time">{{ formatUpdatedAt(task.updated_at) }}</td>
                <td class="gb-list-td-actions">
                  <div class="gb-list-action-row">
                    <template v-if="task.deleted_at">
                      <button class="gb-action-btn gb-action-primary" @click="handleRestoreClick(task, $event)">
                        恢复
                      </button>
                    </template>
                    <template v-else>
                      <button
                        v-for="btn in (STATUS_BUTTONS[task.status] || [])"
                        :key="btn.key"
                        :class="[
                          'gb-action-btn',
                          btn.tone === 'primary' ? 'gb-action-primary'
                            : btn.tone === 'danger' ? 'gb-action-danger'
                            : 'gb-action-normal',
                        ]"
                        @click="handleListAction(task, btn.key)"
                      >
                        {{ btn.label }}
                      </button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="currentGroupTasks.length === 0" class="gb-list-empty">📭 暂无任务</div>
        </div>

        <!-- Pagination — R59: 按当前段 total, 跳页只重拉当前段 -->
        <Pagination
          v-if="currentGroupTotal > 0"
          :model-value="currentPage"
          :page-size="pageSize"
          :total="currentGroupTotal"
          :page-size-options="[10, 20, 50, 100, 200]"
          class-name="gb-list-pagination"
          @update:model-value="onPageJump"
          @update:page-size="onPageSizeChange"
        />
      </div>

      <!-- GROUPED VIEW -->
      <div v-else-if="viewMode === 'grouped'" class="gb-grouped">
        <div class="gb-grouped-row">
          <section
            v-for="bucket in buckets"
            :key="bucket.key"
            class="gb-grouped-col"
          >
            <header class="gb-grouped-col-head">
              <span class="gb-grouped-col-title">{{ bucket.label }}</span>
              <span class="gb-grouped-col-count">{{ bucket.tasks.length }}</span>
            </header>
            <div class="gb-grouped-col-body">
              <router-link
                v-for="task in bucket.tasks"
                :key="task.id"
                :to="taskDetailHref(task.id)"
                class="gb-grouped-card"
                :title="buildHoverTooltip(task)"
              >
                <h4 :class="['gb-grouped-card-title', { 'gb-card-title-strike': !!task.deleted_at }]">
                  {{ task.title }}
                </h4>
                <div class="gb-grouped-card-chips">
                  <span :class="['gb-status-badge', STATUS_COLORS[task.status] || 'gb-status-default']">
                    {{ STATUS_LABELS[task.status] || task.status }}
                  </span>
                  <QueuedReasonHint :status="task.status" :reason="task.queued_reason" />
                  <span
                    v-if="task.type"
                    :class="['gb-type', TYPE_COLORS[task.type] || 'gb-type-default']"
                  >
                    {{ TYPE_LABELS[task.type] || task.type }}
                  </span>
                  <span v-if="task.priority > 0" class="gb-priority">P{{ task.priority }}</span>
                </div>
                <div class="gb-grouped-card-meta">
                  <span class="gb-grouped-card-version">
                    {{ task.version_id ? (versionNames[task.version_id] || '?') : '—' }}
                  </span>
                  <span class="gb-grouped-card-time">{{ formatUpdatedAt(task.updated_at) }}</span>
                </div>
              </router-link>
              <div v-if="bucket.tasks.length === 0" class="gb-grouped-col-empty">该列无任务</div>
            </div>
          </section>
        </div>
        <!-- R56-B20: 统一 Pagination — 跟 cards/list 一致, 按当前段 total. grouped
             桶内不再有"加载更多"按钮 (R2025-XX 拍板: 整页跳页足以覆盖, 不混用). -->
        <div class="gb-pagination-row">
          <Pagination
            v-if="currentGroupTotal > 0"
            :model-value="currentPage"
            :page-size="pageSize"
            :total="currentGroupTotal"
            :page-size-options="[10, 20, 50, 100, 200]"
            class-name="gb-grouped-pagination"
            @update:model-value="onPageJump"
            @update:page-size="onPageSizeChange"
          />
        </div>
        <div v-if="currentGroupTasks.length === 0" class="gb-list-empty">📭 暂无任务</div>
      </div>

      <!-- KANBAN VIEW (R48: 4 模式 — cards/list/grouped/kanban) -->
      <!-- R59: 用 currentGroupTasks 单段, statusGroup 切 active/terminal -->
      <KanbanBoard
        v-else-if="viewMode === 'kanban'"
        :tasks="currentGroupTasks"
        :scope-labels="{ projectNames, versionNames }"
        :column-order="chipOrder"
        :selected-statuses="selectedStatuses"
        @updated="refreshAll"
      />

      <!-- R58.5: Kanban 也加 Pagination — 之前 cards/list/grouped 都有,
           kanban 没有. 用户反馈 /global 默认 kanban 模式看不到分页条,
           任务多了没法跳页/切 pageSize. 复用当前段分页逻辑. -->
      <div v-if="viewMode === 'kanban' && currentGroupTotal > 0" class="gb-kanban-pagination">
        <Pagination
          :model-value="currentPage"
          :page-size="pageSize"
          :total="currentGroupTotal"
          :page-size-options="[10, 20, 50, 100, 200]"
          class-name="gb-kanban-pagination-bar"
          @update:model-value="onPageJump"
          @update:page-size="onPageSizeChange"
        />
      </div>

      <!-- CATEGORY VIEW (idea-canvas 列表升级, damo 1012): 分类视图 — 未分类池
           拖任务进自建分类, 分类 CRUD, 任务删除自动出列. 自包含组件 (自拉数据),
           筛选 props 透传 (damo 1013: chip 行/q 在 category 下原来不管用).
           R31 (damo 1013): ?project= 项目作用域透传 — 项目内「列表」入口只看
           该项目任务, 分类内条目同样按项目过滤; 全局入口不带 = 全项目. -->
      <CategoryBoardView
        v-else-if="viewMode === 'category'"
        :status-filter="selectedStatuses"
        :search="debouncedSearch"
        :project-id="projectSelect"
      />
      <!-- CHAT VIEW (R53: 5 模式 — cards/list/grouped/kanban/chat) -->
      <!-- R59: 用 currentGroupTasks 单段 -->
      <ChatView
        v-else-if="viewMode === 'chat'"
        :tasks="currentGroupTasks"
        :project="chatActiveProject"
        :version="chatActiveVersion"
        :project-names="projectNames"
        :version-names="versionNames"
        :initial-task-id="chatInitialTaskId"
        @created="onChatTaskCreated"
      />
    </div>

    <!-- Delete confirm dialog -->
    <ConfirmDialog
      :open="!!deleteConfirm"
      title="删除任务"
      :message="`确定删除「${deleteConfirm?.taskTitle || ''}」？删除后可通过「显示已删除」恢复。`"
      confirm-label="删除"
      cancel-label="取消"
      variant="danger"
      @confirm="confirmDelete"
      @cancel="deleteConfirm = null"
    />

    <!-- Refine dialog (R131 替旧 reject) — ConfirmDialog 声明式 API 仅接
         string message, 不支持 default slot, 这里直接用 Modal + Textarea 自建. -->
    <Modal
      :model-value="!!refineDialog"
      title="让 agent 接着干"
      size="sm"
      @update:model-value="(v: boolean) => { if (!v) { refineDialog = null; refineMessage = ''; } }"
    >
      <div class="gb-refine-body">
        <p class="gb-refine-hint">
          任务 <strong>{{ refineDialog?.taskTitle }}</strong> 从 reviewing 切回 running, agent 会按新指示继续. 消息可选.
        </p>
        <Textarea
          v-model="refineMessage"
          :rows="4"
          placeholder="(可选) 给 agent 的继续消息"
          class-name="gb-refine-textarea"
        />
      </div>
      <template #footer>
        <Button variant="secondary" @click="() => { refineDialog = null; refineMessage = ''; }">
          取消
        </Button>
        <Button variant="primary" @click="submitRefine">
          ↻ 继续干
        </Button>
      </template>
    </Modal>

    <!-- R232 Round4 (damo 10-10): 聊天式快速创建弹窗 — 全局看板入口, 项目/版本
         弹窗内自选 (全局页没有「当前项目」语境, 不预选). 创建成功 SSE 自动插行
         (onGlobalEvent 落数组), 兜底 refreshAll. -->
    <TaskQuickCreate
      v-model="quickCreateOpen"
      @created="refreshAll"
    />

    <!-- R232 Round4: 常驻圆形创建 FAB — 全局看板此前完全没有创建入口 (只有
         空态文案「新建任务后会出现在这里」). 右下角圆形「+」, 与项目看板 FAB
         (board-fab-new) 同视觉语言. -->
    <button
      type="button"
      class="gb-fab-new"
      title="新建任务 (对话式, Enter 发送)"
      aria-label="新建任务"
      @click="quickCreateOpen = true"
    >
      <!-- R233 Round7: 文本「+」字形受字体基线影响视觉偏下, 换 SVG 十字几何居中. -->
      <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true">
        <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

.gb-page {
  display: flex;
  flex-direction: column;
  /* height:100% 撑满 .content-area (≈ 100vh - 92px AppHeader+TagsView), 让
     sticky 分页贴 viewport 底部, 不是 80vh 处. overflow:hidden 让 .gb-body
     (overflow:auto) 成为唯一滚动上下文, 分页永远粘在 .gb-body 视口底部
     (= .gb-page 底边 = viewport 底边减去 header/tags).

     为什么不用 height:80vh: 80vh 处距 viewport 底部还差 20vh-92px ≈ 12%,
     sticky 分页看起来像悬浮在空中, 不"在底部". 之前 height:80vh 是镜像
     BoardPage R58 拍板, 但 BoardPage 没暴露这问题是因为内容总是满; GlobalBoard
     全局有空 group 漏出来 → 用户两次反馈分页不在底部.

     position:relative 是 .gb-chrome-fab (chat 模式 chrome 折叠 FAB) 的定位
     ancestor — 没它 FAB 沿 DOM 向上找不到 relative, 落到 viewport 右上角
     被 AppHeader (44px) 盖住, 用户切到 chat 后点「收起」就回不来了. */
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}

/* ------------------------------------------------------------------ */
/*  Header                                                             */
/* ------------------------------------------------------------------ */

.gb-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.gb-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.gb-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.gb-breadcrumb-link {
  color: inherit;
  text-decoration: none;
}

.gb-breadcrumb-link:hover {
  color: var(--color-primary);
}

.gb-breadcrumb-sep {
  color: var(--color-text-muted);
}

.gb-breadcrumb-current {
  color: var(--color-text);
  font-weight: 500;
}

/* R217v7: .gb-title 大标题已删 (面包屑重复), header 紧凑一截. */

/* View switcher — pill group 风格, 跟 .gb-segmented 完全对齐 (R59 用户反馈
   「参考活跃」). 之前是 pill-row (内嵌 button + border-left 分隔), 跟
   segmented 风格不一致. 改成 pill group: 外框 padding 2px + border +
   border-radius 8px, 内 button padding 4px 12px + border-radius 6px,
   gap 2px, 无 border-left 分隔. 两组视觉统一. */
.gb-view-switcher {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-wrap: nowrap;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  flex-shrink: 0;
}

.gb-view-btn {
  border: 0;
  padding: 4px 12px;
  background: transparent;
  font-size: 12px;
  color: var(--color-text-muted, #4b5563);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

/* R59: view icon + label 双 span. SVG inline icons (line-style, monochrome).
   icon 始终显示 (跟 label 颜色一致), 不像 emoji 自带彩色字形. 小屏 (≤1023px)
   藏 label 只剩 icon. */
.gb-view-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.gb-view-icon svg {
  width: 14px;
  height: 14px;
}
@media (max-width: 1023px) {
  .gb-view-label {
    display: none;
  }
}

.gb-view-btn:hover {
  background: var(--color-bg-hover, #f3f4f6);
}

.gb-view-btn-active {
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-weight: 500;
}

.gb-view-btn-active:hover {
  background: var(--color-primary-hover, #1d4ed8);
  color: #fff;
}

/* R59: status group segmented (活跃 / 历史) — 镜像 BoardPage.board-segmented.
   R236 (damo): 从 header 右侧挪进下方 filter 状态行头部, 语义从「切段加载
   开关」改成状态分组快捷键 (chip 宏, 见 setStatusGroup). 高亮由 activePresetOn /
   terminalPresetOn 驱动 (选择恰等于该组全集才亮), 不再绑定 statusGroup param. */
/* R59: status group segmented — pill 风格 (button 自带 border-radius,
   跟 view-switcher 的 pill-row 区分). view-switcher 是 row of pills
   (内嵌 button + border-left 分隔), segmented 是 pill group (外框
   padding + 内 button 各自圆角), 两种视觉不同但都是一致的「按钮
   组」概念. 用户反馈「按钮格式统一下」+「参考原来的活跃」= view-
   switcher 保留 pill-row (已经是这样), segmented 用 pill 风格
   (回归 R59 最初版, 跟之前的 stylesheet 一致). */
.gb-segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  flex-shrink: 0;
}
.seg-btn {
  padding: 4px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted, #4b5563);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.seg-btn:hover {
  background: var(--color-bg-hover, #f3f4f6);
}
.seg-btn-active {
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-weight: 500;
}
.seg-btn-active:hover {
  background: var(--color-primary-hover, #1d4ed8);
  color: #fff;
}
/* R236: segmented 挪进 filter 状态行头部 — 覆盖 header 时代的 margin-left:auto
   (那会把按钮组推到行尾), 与「状态」label 紧邻 (preset 在前, 11 个 chip 在后). */
.gb-filter .gb-segmented {
  margin-left: 0;
}

/* R59: chrome 折叠 toggle — chat 模式 view-switcher 旁边的收起/展开按钮.
   跟 BoardPage.board-chrome-toggle 同款, 视觉一致. padding-top/bottom
   调到 6px 跟旁边 .gb-segmented / .gb-view-switcher (≈ 28-32px) 齐 —
   之前 4px 让按钮整体偏矮 2-4px, 顶对齐 (align-items:flex-start) 后
   视觉上「收起」按钮比 segmented/view-switcher 偏上 1-2px. */
.gb-chrome-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text-muted, #4b5563);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.gb-chrome-toggle:hover {
  background: var(--color-bg-hover, #f3f4f6);
  border-color: var(--color-border-hover, #d1d5db);
}
.gb-chrome-toggle svg {
  flex-shrink: 0;
  transition: transform 0.15s;
}
.gb-chrome-toggle[aria-expanded="true"] svg {
  transform: rotate(-180deg);
}
@media (max-width: 1023px) {
  .gb-chrome-toggle span {
    display: none;
  }
}

/* R59: chrome 折叠态 FAB — 仅 !topHeaderOpen + viewMode==='chat' 显示,
   兜底 catch-22 (chrome 内 toggle 按钮随 chrome 一起消失). 浮在
   gb-page 右下角, 不挡 chat 内容. */
/* R217v6 (damo): 折叠态「展开」入口 — 文档流右上小条. 原 absolute top/right
   悬浮在收起后正好盖住操作行右端「+新建」; 改占位小条后谁也不盖. */
.gb-collapsed-bar {
  display: flex;
  justify-content: flex-end;
  padding: 5px 12px;
}

.gb-chrome-fab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--color-border-strong);
  border-radius: 999px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted, #4b5563);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.gb-chrome-fab:hover {
  background: var(--color-bg);
  border-color: var(--color-primary, #93c5fd);
  color: var(--color-primary, #1d4ed8);
}
.gb-chrome-fab svg {
  flex-shrink: 0;
}
@media (max-width: 1023px) {
  .gb-chrome-fab span {
    display: none;
  }
  .gb-chrome-fab {
    padding: 8px;
  }
}

/* R59+: 窄屏 (≤1023px) 让 chrome 整体变 flex-wrap — 避免右侧 segmented +
   view-switcher + chrome-toggle 三组不收缩 (~280px+) 把 .gb-header-text
   挤扁, 内部面包屑 flex-wrap 让每个面包屑元素独占一行 = 「按钮组把左侧
   的文字都挤压成一条线了」(用户反馈). flex-wrap + header-text flex-basis
   100% 强制换行: text 占第一行, 按钮组自然排第二行 (用户反馈「好像一排
   能放下所有按钮?」 — 实测 500px viewport 下三个按钮总宽 372, 375px H5
   下 ~294, 都放得下). 跟 VersionDetailView vd-chrome R59 修复同款. */
@media (max-width: 1023px) {
  .gb-header {
    flex-wrap: wrap;
    gap: 10px 12px;
  }
  /* header-text 强制占满第一行 (flex-basis 100% = 触发换行). 后续三个按钮
     容器 flex: 0 0 auto, 自然排在第二行 */
  .gb-header-text {
    flex: 1 1 100%;
    min-width: 0;
  }
  .gb-segmented,
  .gb-view-switcher,
  .gb-chrome-toggle {
    flex: 0 0 auto;
  }
}

/* ------------------------------------------------------------------ */
/*  Filter bar                                                         */
/* ------------------------------------------------------------------ */

.gb-filter {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.gb-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.gb-filter-select {
  width: 140px;
  flex-shrink: 0;
}

.gb-filter-select-wide {
  width: 220px;
  flex-shrink: 0;
}

.gb-filter-label {
  font-size: 13px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-left: 8px;
}

.gb-filter-search {
  flex: 1;
  min-width: 220px;
  max-width: 380px;
}

.gb-filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.gb-filter-toggle-fav-on {
  color: var(--tw-amber-600);
}

/* R232 Round4: 全局看板常驻圆形创建 FAB — 与 BoardPage .board-fab-new 同款
   (46px / primary / 右下角). 全局看板此前无任何创建入口. */
.gb-fab-new {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 46px;
  height: 46px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  z-index: 40;
}

.gb-fab-new:hover {
  filter: brightness(1.08);
}

@media (max-width: 1023px) {
  .gb-fab-new {
    right: 16px;
    bottom: 16px;
  }
}

.gb-star-on {
  color: var(--tw-amber-500);
}

/* Status chips */
.gb-status-chip {
  padding: 4px 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, text-decoration 0.15s;
}

.gb-status-chip-off {
  opacity: 0.4;
  text-decoration: line-through;
}

/* R182: chip 内计数徽标 (如「失败 55」) — 让被淹没的状态 (terminal 段 completed
   淹没 failed) 计数可见, 点 chip 即过滤. */
.gb-status-chip-count {
  margin-left: 5px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.14);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.gb-status-chip-on:hover,
.gb-status-chip-off:hover {
  opacity: 1;
}

/* R56-A1: chip 拖拽视觉反馈. 镜像 BoardPage status-chip-dragging/dragover
   (master board-client.tsx:1201-1203: dragging=opacity 0.5, dragover=amber ring). */
.gb-status-chip-dragging {
  opacity: 0.5;
}

.gb-status-chip-dragover {
  box-shadow: 0 0 0 2px var(--tw-amber-500);
}

/* R56-A1: 同步配置齿轮 (镜像 BoardPage sync-menu-* 风格, scoped CSS). */
.gb-sync-menu-root {
  position: relative;
  margin-left: auto;
}

.gb-sync-menu-trigger {
  border: 0;
  background: transparent;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.gb-sync-menu-trigger:hover {
  background: var(--color-bg);
  color: var(--color-text);
}

.gb-sync-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  width: 240px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.08));
  z-index: 50;
  padding: 4px 0;
}

.gb-sync-menu-title {
  padding: 6px 12px 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
}

.gb-sync-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.gb-sync-menu-item:hover {
  background: var(--color-bg);
}

.gb-sync-menu-item-on {
  background: var(--color-bg);
}

.gb-sync-menu-radio {
  margin: 0;
  accent-color: var(--color-primary);
}

.gb-sync-menu-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.gb-sync-menu-label {
  font-size: 13px;
  color: var(--color-text);
}

.gb-sync-menu-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 状态色 — 用本文件 scoped 类, 不引 Tailwind palette. */
.gb-status-pending    { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.gb-status-queued     { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.gb-status-running    { background: var(--tw-sky-100); color: var(--tw-sky-700); }
.gb-status-paused     { background: var(--tw-yellow-100); color: var(--tw-yellow-800); }
.gb-status-reviewing  { background: var(--tw-purple-100); color: var(--tw-purple-800); }
.gb-status-verifying  { background: var(--tw-violet-100); color: var(--tw-violet-800); }
.gb-status-await-user { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.gb-status-completed  { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.gb-status-failed     { background: var(--tw-red-100); color: var(--tw-red-800); }
.gb-status-rejected   { background: var(--tw-orange-50); color: var(--tw-orange-700); }
.gb-status-cancelled  { background: var(--tw-gray-100); color: var(--tw-gray-500); }
.gb-status-default    { background: var(--tw-gray-100); color: var(--tw-gray-700); }

/* Type chip */
.gb-type {
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 500;
}

.gb-type-design  { color: var(--tw-pink-700); background: var(--tw-pink-100); }
.gb-type-dev     { color: var(--tw-blue-700); background: var(--tw-blue-100); }
.gb-type-test    { color: var(--tw-violet-700); background: var(--tw-violet-100); }
.gb-type-deploy  { color: var(--tw-emerald-700); background: var(--tw-emerald-100); }
.gb-type-default { color: var(--color-text-muted); background: var(--color-bg); }

/* Awaiting marker chips */
.gb-marker {
  padding: 2px 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.gb-marker-review     { background: var(--tw-amber-100); color: var(--tw-amber-800); border-color: var(--tw-amber-200); }
.gb-marker-choice     { background: var(--tw-blue-100); color: var(--tw-blue-800); border-color: var(--tw-blue-200); }
.gb-marker-info       { background: var(--tw-gray-100); color: var(--tw-gray-700); border-color: var(--tw-gray-200); }
.gb-marker-waiting    { background: var(--tw-cyan-100); color: var(--tw-cyan-800); border-color: var(--tw-cyan-200); }
.gb-marker-suggestion { background: var(--tw-emerald-100); color: var(--tw-emerald-800); border-color: var(--tw-emerald-200); }
.gb-marker-stuck      { background: var(--tw-red-100); color: var(--tw-red-800); border-color: var(--tw-red-200); }
.gb-marker-default    { background: var(--tw-purple-100); color: var(--tw-purple-800); border-color: var(--tw-purple-200); }

/* Requirement chip */
.gb-req-pending     { background: var(--tw-gray-100); color: var(--tw-gray-700); border-color: var(--tw-gray-200); }
.gb-req-in-progress { background: var(--tw-blue-100); color: var(--tw-blue-800); border-color: var(--tw-blue-200); }
.gb-req-done        { background: var(--tw-emerald-100); color: var(--tw-emerald-800); border-color: var(--tw-emerald-200); }
.gb-req-cancelled   { background: var(--tw-red-100); color: var(--tw-red-800); border-color: var(--tw-red-200); }

/* by-chip (R108 T3 [by]<id>) */
.gb-by-chip {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--tw-gray-100);
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* sub-status / awaiting_reason chip */
.gb-sub-status {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--tw-indigo-50);
  color: var(--tw-indigo-700);
  font-size: 11px;
}

/* ------------------------------------------------------------------ */
/*  Body                                                               */
/* ------------------------------------------------------------------ */

.gb-body {
  /* 接管滚动: flex:1 撑满 .gb-page (height:100%) 减去 header + sticky
     pagination; min-height:0 配合才能正确收缩. overflow:auto 让 cards/
     list/grouped 在内部独立滚动, sticky pagination 始终贴底.

     padding-bottom 故意为 0 — 之前的 padding-bottom:80px 把 sticky 分页
     整个上推 80px, 用户视觉上"分页下方还有 50+px 空白". 改用 .gb-body::after
     占位, sticky 分页贴 .gb-body 物理底边 (= viewport 底), 占位 64px 仅防
     卡片最后一行被 sticky 覆盖. */
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: auto;
  padding: 16px 24px 0;
}

.gb-body::after {
  /* 占位: R58.5 去掉 — 之前 96 → 56px buffer 防 sticky 分页盖住最后一行.
     列内滚动由 .gb-grouped-col-body / .kb-col-body flex:1 + overflow-y:auto
     接管, sticky 分页只在 gb-body 物理底覆盖列容器外框, 不压列内滚动内容.
     留 ::after 占位反而把 sticky 分页顶部往下挤 (=占位高度), 用户实测
     分页距页面底部还有 55px 空白就是 56px 占位的副作用.
     删掉后 sticky 分页直接贴 gb-body 物理底, 等于贴 viewport 底 (gb-body
     = gb-page 高度 = viewport - AppHeader/TagsView ≈ 100vh - 92px).
     列内容最后一行与 sticky 分页上沿之间: kanban/grouped 由列 padding 16
     + 列内 body padding 8px = 24px 自然间距, 不需要额外占位. */
  content: none;
}

.gb-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}

.gb-loading-text {
  margin: 0;
  font-size: 14px;
}

/* ------------------------------------------------------------------ */
/*  Cards view                                                         */
/* ------------------------------------------------------------------ */

.gb-cards {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.gb-section-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.gb-section-count {
  font-weight: 400;
  opacity: 0.7;
}

.gb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

.gb-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.15s, border-color 0.15s;
}

.gb-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
}

.gb-card-deleted {
  opacity: 0.6;
  border-color: var(--tw-red-200);
}

.gb-card-deleted:hover {
  opacity: 1;
}

.gb-card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.gb-status-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.gb-priority {
  font-size: 11px;
  color: var(--tw-orange-600);
  font-weight: 500;
}

.gb-deleted-badge {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--tw-red-100);
  color: var(--tw-red-700);
  font-size: 11px;
  font-weight: 500;
}

.gb-card-action {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  font-size: 13px;
  cursor: pointer;
  opacity: 0;
  border-radius: var(--radius);
  transition: opacity 0.15s;
}

.gb-card:hover .gb-card-action {
  opacity: 1;
}

.gb-card-action-delete:hover {
  background: var(--tw-red-100);
}

.gb-card-action-restore {
  color: var(--color-primary);
}

.gb-card-action-restore:hover {
  background: var(--tw-blue-100);
}

.gb-scope {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
  min-width: 0;
}

.gb-scope-link {
  color: inherit;
  text-decoration: none;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gb-scope-link:hover {
  color: var(--color-primary);
}

.gb-scope-sep {
  color: var(--color-text-muted);
  opacity: 0.5;
}

.gb-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: inherit;
  text-decoration: none;
}

.gb-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.gb-card-title-strike {
  text-decoration: line-through;
}

.gb-card-preview {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.gb-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: auto;
}

/* R56-B17: 短任务 ID chip — 等宽字体小芯片, 8 字符短哈希. 与 TaskHeader
   breadcrumb-hash 同源 (前 8 位 ID). 让 cron 派发同模板的卡片一眼能区分. */
.gb-card-id {
  flex-shrink: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  letter-spacing: 0.02em;
}

.gb-card-model {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gb-card-cost {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  flex-shrink: 0;
}

.gb-card-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  Pagination                                                          */
/* ------------------------------------------------------------------ */

/* Sticky 底部: 不管是 grouped 的 .gb-pagination-row wrapper 还是 cards/list
   直接挂的 Pagination root, 都让分页始终贴 .gb-body 滚动容器底部.
   background + border-top = 滚动时视觉分隔, z-index > 内容覆盖最末行.
   margin 左右 -24px 抵消 .gb-body padding 让背景延伸到边缘.
   上下 padding 12px = sticky 分页更厚更好点 (用户反馈 '怕不好点' 第二轮:
   '分页上下padding'), 视觉呼吸感更足.

   margin-top:auto — 关键修复: position:sticky 只在自然位置低于视口底部
   时粘住, 内容少时 (filter 选某 group 只剩几条任务) 自然位置在视口顶部
   附近, 向上滚分页跟着滚. margin-top:auto 在 view mode 内部 flex column
   里吸收剩余空间, 把 sticky 推到 view mode 底部, 永远在 .gb-body 视口底. */
/* R58.5 方案 A: 5 个分页容器 — 上下靠 Pagination 内部 padding-block:12px
   (Pagination.vue) 兜底, 横向 24px 由容器 padding-left/right 提供.

   grouped 模式特殊: 有外层 wrapper .gb-pagination-row + 内层 Pagination root
   className .gb-grouped-pagination (两个不同 div). 容器 padding 只能设在
   一层, 否则叠加成 48px (用户实测). 改: 外层 wrapper 设 padding-left/right,
   内层 className 不设 — grouped 模式用户视觉验证 padding 24px 不再叠加.

   kanban 模式同样有外层 wrapper + 内层 className (gb-kanban-pagination-bar),
   但外层 wrapper 类是 gb-kanban-pagination (跟内层 className 不同). 两个
   选择器都设 padding 同样叠加 = 48px. 修法同上: 外层 .gb-kanban-pagination
   设 padding, 内层 .gb-kanban-pagination-bar 不设.

   cards / list 模式没外层 wrapper, Pagination root class-name 直接挂.
   容器 padding 设在 .gb-cards-pagination / .gb-list-pagination (就是
   Pagination root 本身) — 单一 div, 不存在叠加.

   margin-top:auto — 关键修复: position:sticky 只在自然位置低于视口底部
   时粘住, 内容少时 (filter 选某 group 只剩几条任务) 自然位置在视口顶部
   附近, 向上滚分页跟着滚. margin-top:auto 在 view mode 内部 flex column
   里吸收剩余空间, 把 sticky 推到 view mode 底部, 永远在 .gb-body 视口底.

   border-top 拆开: cards/list/pagination-row 保留 (用户视觉对比无问题),
   kanban/grouped 无 (用户之前反馈 group 分页条 border-top 不明所以). */

/* 外层 wrapper 负责 padding (跟背景/边框/border-top 一起) */
.gb-pagination-row,
.gb-kanban-pagination {
  position: sticky;
  bottom: 0;
  flex-shrink: 0;
  margin-top: auto;
  /* R58.5: margin-left/right -24px 让背景延伸 .gb-body padding 外, 贴 viewport
     边 (用户「白底通到边边」反馈). padding-left/right 40px 让内容距容器左边
     40px = 距 viewport 边 16px (内容往中间拉一点, 用户反馈背景延伸后文字
     偏两边). */
  margin-left: -24px;
  margin-right: -24px;
  padding-left: 40px;
  padding-right: 40px;
  z-index: 1;
}
.gb-pagination-row {
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
}
.gb-kanban-pagination {
  background: var(--color-bg-elevated);
}

/* cards/list 模式: 没 wrapper, Pagination root class-name 直接挂 —
   这里设 padding/background/border-top */
.gb-cards-pagination,
.gb-list-pagination {
  position: sticky;
  bottom: 0;
  flex-shrink: 0;
  margin-top: auto;
  /* R58.5: margin-left/right -24px 让背景延伸, 跟 wrapper 容器一致贯通 viewport 边.
     padding-left/right 40px 让内容往中间拉一点 (用户反馈). */
  margin-left: -24px;
  margin-right: -24px;
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
  padding-left: 40px;
  padding-right: 40px;
  z-index: 1;
}

/* grouped 模式内层 Pagination root + kanban 内层 Pagination root (class-name
   透传) — 不设 padding, 避免跟外层 wrapper 叠加. 只继承 background. */
.gb-grouped-pagination,
.gb-kanban-pagination-bar {
  background: var(--color-bg-elevated);
}

/* ------------------------------------------------------------------ */
/*  List view                                                          */
/* ------------------------------------------------------------------ */

.gb-list-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* AO-DEV R237: flex:1 + min-height:0 让 list 容器撑满 .gb-body 剩余高度 —
     给 .gb-list-table-wrap 一个「可用高度」上限, 长列表时表格卡内部滚动,
     thead 的 sticky top:0 才能贴住卡顶. 短列表时表格卡保持内容高 (flex 不
     抢高), 分页由 margin-top:auto 推到贴底, 与既有行为一致. */
  flex: 1 1 auto;
  min-height: 0;
}

.gb-list-table-wrap {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: auto;
  /* R237: 只缩不放 — 长列表时收到 .gb-list-wrap 剩余高度, 表格在卡内滚
     (sticky thead 随之生效); 短列表/空态时不拉伸, 卡片不出现大块空白. */
  flex: 0 1 auto;
  min-height: 0;
}

.gb-list-table {
  width: 100%;
  /* R237: collapse 改 separate + spacing 0 — collapse 模式下 sticky 表头
     滚动离位后 th 的 border-bottom 会留在原位不跟着走 (Chrome/FF 已知
     渲染怪癖), 表头钉住后底部分隔线消失. separate 让每格边线随格子走.
     本表边框只有 bottom 一向, separate 无并集/双线副作用. */
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}

.gb-list-table thead {
  background: var(--color-bg);
  position: sticky;
  top: 0;
  z-index: 1;
}

.gb-list-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.gb-list-th-title { width: 28%; }
.gb-list-th-proj { width: 14%; }
.gb-list-th-ver { width: 12%; }
.gb-list-th-status { width: 10%; }
.gb-list-th-type { width: 8%; }
.gb-list-th-time { width: 12%; }
.gb-list-th-actions { width: 16%; min-width: 220px; }

.gb-list-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  vertical-align: middle;
}

.gb-list-table tbody tr:hover {
  background: var(--color-bg);
}

.gb-list-row-deleted {
  opacity: 0.6;
}

.gb-list-td-title {
  max-width: 360px;
}

.gb-list-title-link {
  color: var(--color-text);
  text-decoration: none;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.gb-list-title-link:hover {
  color: var(--color-primary);
}

.gb-list-td-proj,
.gb-list-td-ver {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

.gb-list-td-time {
  color: var(--color-text-muted);
  font-size: 12px;
}

.gb-list-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
}

.gb-action-btn {
  padding: 3px 10px;
  border: 1px solid;
  border-radius: var(--radius);
  font-size: 11px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s;
}

.gb-action-primary {
  border-color: var(--tw-blue-300);
  color: var(--tw-blue-700);
}

.gb-action-primary:hover {
  background: var(--tw-blue-100);
}

.gb-action-danger {
  border-color: var(--tw-gray-300);
  color: var(--color-text);
}

.gb-action-danger:hover {
  background: var(--tw-red-100);
  color: var(--tw-red-700);
  border-color: var(--tw-red-200);
}

.gb-action-normal {
  border-color: var(--tw-gray-300);
  color: var(--color-text);
}

.gb-action-normal:hover {
  background: var(--color-bg);
}

.gb-list-empty {
  padding: 64px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}

/* ------------------------------------------------------------------ */
/*  Grouped view                                                       */
/* ------------------------------------------------------------------ */

.gb-grouped {
  /* R58.5: 撑满 .gb-body 剩余高度 (减 header / pagination 占位), 让列高
     flex 自适应, 分页靠底. 之前没 flex:1 + min-height:0, .gb-grouped-row
     只能靠 max-height:70vh 硬编码, 大屏列矮. */
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.gb-grouped-row {
  /* R58.5: flex 自适应父容器剩余高度 — 之前没设高度, 列靠 max-height:70vh
     硬编码, 大屏列矮, 分页没靠底. 加 flex:1 + min-height:0 让 .gb-grouped-row
     撑满父容器 (.gb-body 减 header / pagination 占位), 列高跟 row 走. */
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 8px;
  flex: 1;
  min-height: 0;
}

.gb-grouped-col {
  flex: 0 0 320px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  /* R58.5: 去掉 max-height:70vh, 列高跟 row 走 (row 是 flex:1 撑满
     .gb-grouped 剩余). 列内任务滚动由 .gb-grouped-col-body flex:1 +
     overflow-y:auto 处理 (已存在). min-height:0 让列可以更短. */
  min-height: 0;
}

.gb-grouped-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  position: sticky;
  top: 0;
}

.gb-grouped-col-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gb-grouped-col-count {
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg);
  padding: 1px 7px;
  border-radius: 999px;
}

.gb-grouped-col-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gb-grouped-card {
  display: block;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.gb-grouped-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}

.gb-grouped-card-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.gb-grouped-card-chips {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 11px;
}

.gb-grouped-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.gb-grouped-card-version {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gb-grouped-card-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.gb-grouped-col-empty {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 16px 8px;
}

/* ------------------------------------------------------------------ */
/*  Refine dialog body                                                 */
/* ------------------------------------------------------------------ */

.gb-refine-body {
  margin-top: 8px;
}

.gb-refine-hint {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.gb-refine-textarea {
  width: 100%;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}

/* ------------------------------------------------------------------ */
/*  Mobile (≤767px) — 解锁视口, 整页交给 .content-area 原生滚动          */
/* ------------------------------------------------------------------ */

/* 桌面布局是「锁视口 + 内部滚动」: .gb-page height:100% + overflow:hidden,
   .gb-body (overflow:auto) 做唯一滚动上下文. 手机窄屏上 header (~190px) +
   filter 折行 (~273px) + sticky 分页 (~97px) 把 587px 的 content-area 吃到
   只剩 ~27px 可滚缝隙 — 2026-10-04 实测 (375x667) 卡片/看板上下都滑不动
   (桌面模拟器靠滚轮命中那条缝所以"看起来正常"). 移动端改回文档流: 页面
   自然高, 滚动交还 .content-area, 屏幕任意位置触摸都能滚. */
@media (max-width: 767px) {
  .gb-page {
    height: auto;
    min-height: 100%;
    overflow: visible;
  }

  .gb-body {
    overflow: visible;
    /* flex:none = 文档流自然高. 必须: 留 flex:1 1 0 时 auto 高容器按 flex-base
       0 算内容高, min-height:100% (587px) 减去 header/filter 全给了 gb-body,
       内容靠 overflow 外溢, 布局乱 (分页悬在中部). */
    flex: none;
  }

  /* kanban 视图 (KanbanBoard 子组件, scoped 需 :deep): 取消 root/row 的 flex:1
     抢高, 列限 70vh 让列内滚动 (.kb-col-body overflow-y:auto) 接管, 横向滑列
     不变. BoardPage 也用 KanbanBoard 但仍锁视口布局, 这里的 :deep 只在
     .gb-body 下生效, 不影响 BoardPage. */
  .gb-body :deep(.kb-root),
  .gb-body :deep(.kb-row) {
    flex: none;
  }

  .gb-body :deep(.kb-col) {
    max-height: 70vh;
  }

  /* grouped 视图: 同理取消 flex 抢高, 列限 70vh. */
  .gb-grouped,
  .gb-grouped-row {
    flex: none;
  }

  .gb-grouped-col {
    max-height: 70vh;
  }

  /* 分页不再 sticky — 相对 .content-area 粘底会一直盖住底部 ~97px 内容;
     落回文档流, 滚到底部操作. */
  .gb-pagination-row,
  .gb-kanban-pagination,
  .gb-cards-pagination,
  .gb-list-pagination {
    position: static;
  }

  /* chat 视图豁免: .cv-page absolute inset:0 铺 .gb-body, 依赖锁视口布局,
     保持桌面行为 (锁高 + 内部滚动 + gb-body flex:1), 不参与文档流解锁. */
  .gb-page.gb-page-chat {
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .gb-page-chat .gb-body {
    overflow: hidden;
    flex: 1 1 0;
  }
}

</style>
