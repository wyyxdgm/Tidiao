<script setup lang="ts">
/* 功能: 任务看板视图 — 同时覆盖 [projectId]/[versionId] 与 /global 两个入口, 通过
   useRoute() 区分模式. 数据源唯一 = GET /api/tasks/page, statusGroup 必填 (active
   / terminal / all), 其他筛选透传到服务端 (q/model/tag/includeDeleted). 筛选状态
   全部同步进 URL query (router.replace), 与 Next 版 "URL 是真相" 口径一致.
   R248 例外: statusGroup 裸链接走 localStorage 记忆 (lib/board-status-group.ts,
   key 跟 syncLevel 三级) > 缺省 '全部'.

   关注点 (M2 scope, 来自 R14 任务清单):
   - 单一职责: 只负责 "展示 + 筛选", 不挂拖拽 / kanban / chat / SSE. 这些是
     M3+ 范畴, 单独派 task 接入. 本文件不强耦合这些依赖 (无 router-view 嵌套,
     无 store 订阅, 无 onMounted 副作用之外的全局副作用).
   - URL 即状态: searchText / model / tag / showDeleted / page / statusGroup 全
     在 URL. 复制 URL = 完整还原看板视图. 避免本地 pinia store 缓存的脏数据.
   - 防抖搜索: searchText 即时写 URL (满足 "保留筛选 query 进 URL"), 但真正
     触发 fetch 的 debouncedSearch 等 200ms 再用 (与 Next 版 R114 防抖同口径).
   - server-side 筛选: q/model/tag 全部走服务端 (避免加载全表再过滤, 与
     /api/tasks/page 设计对齐). 客户端只做 status 多选 (服务端没提供 status
     in(...) 参数; status set 数量小, 客户端 O(n) 过滤开销忽略).
   - terminal 分页: loadMore 模式 — R12 Pagination 用于切 pageSize / 跳页;
     hasMore 信封驱动 "加载更多" 按钮 (与 Next terminalHasMore 同款).
   - 错误态用 R13 ErrorView 重试; loading 用 R11 Loading; 空态用 R13 Empty
     (无 task 时附 CTA "新建任务" 跳 /tasks/new).
   - 与 R14 红线对齐: 不动 router 文件, 本组件未挂路由 (M2 路由挂载是下一 task,
     本轮只交付 "能 typecheck + build 通过的完整组件").
   - 与 Next 版分歧 (Vue 拍板, 拍在 commit message 里):
       1) R55.5 反转 → 挂 SSE. Next EventSource 实时 patch 同源 board-client.tsx:612
          用 /api/projects/{id}/events 走项目级事件流; SPA 复用 R54 useTaskEventSource
          composable (单例 + 引用计数), 不再新建 EventSource 避免 HTTP/1.1 同域名额占满.
          status_change / cost 事件做原地 patch; 未知 task 仅 refetch 当前 statusGroup 集合
          (避免 R54 fix 被本轮反推).
       2) 不实现拖拽排序 / KanbanView / ChatView. Next 三视图同源组件, SPA
          一文件一视图, 后续按视图独立 file 派发.
       3) status 多选默认全选, 服务端按 statusGroup 收窄到 ACTIVE/TERMINAL
          集合, 客户端 only hide (语义: "显示哪些 status"). URL ?statuses=
        缺省时不写 (URL 干净); 只在用户主动去勾选时写.
   - R29 增量: 加 'unversioned' 第三模式 (route.name = 'project-unversioned'),
     镜像 Next.js /[projectId]/unversioned — active 全量 + terminal 50,
     只取 project 下未挂 version 的任务. 与 'version' / 'global' 并列,
     buildParams 分支处理 (发 unversioned=true 不发 version). 头部 chrome
     由包装视图 ProjectUnversioned.vue 提供, 本组件不重复. */
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, getIfChanged, del, post, HttpError } from '@/api/http';
import { useTick } from '@/composables/useTick';
import { useToast } from '@/composables/useToast';
import { useTaskEventSource } from '@/composables/useTaskEventSource';
import { useBackgroundSync, probeNow } from '@/composables/useBackgroundSync';
import { readSnapshot, saveSnapshot } from '@/lib/snapshot-cache';
import { parseDbTime } from '@/lib/datetime';
// R248: 状态分组（活跃/历史/全部）持久化记忆 — 裸链接恢复上次点选的组.
import { readBoardStatusGroup, writeBoardStatusGroup } from '@/lib/board-status-group';
import type { GlobalEvent } from '@/composables/useTaskEventSource';
import {
  taskResources,
  acquireTaskResourcesPolling,
  releaseTaskResourcesPolling,
} from '@/composables/useTaskResources';
// R232 Round5: SystemResourceBars 挪顶栏 AppHeader（全页面常驻）— 本视图撤挂载;
// 轮询 acquire/release 保留 (列表/kanban 的 TaskResourceBadge 仍消费同一份数据).
import Empty from '@/components/Empty.vue';
// 飞书 R244: 分类视图 — 复用全局看板同一份自包含组件 (自拉 pin-lists + 全量任务).
import CategoryBoardView from '@/components/CategoryBoardView.vue';
import QueuedReasonHint from '@/components/QueuedReasonHint.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Select from '@/components/Select.vue';
import Radio from '@/components/Radio.vue';
import Checkbox from '@/components/Checkbox.vue';
import Textarea from '@/components/Textarea.vue';
import Modal from '@/components/Modal.vue';
import Pagination from '@/components/Pagination.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import DecisionBanner from '@/components/DecisionBanner.vue';
import type { ParsedDecision } from '@/components/DecisionBanner.vue';
import KanbanBoard from '@/views/kanban/KanbanBoard.vue';
import ChatView from '@/views/chat/ChatView.vue';
import TaskResourceBadge from '@/components/TaskResourceBadge.vue';
import TaskQuickCreate from '@/components/TaskQuickCreate.vue';
// i18n (W3a): 用户可见字符串走 t('tasks.board.*'), 文案源 locales/{zh-CN,en-US}/tasks.json
// (tasks.board 域); 通用 key 复用 common.*. 迁移模式照抄 LoginView.vue (W1 样板).
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 看板 API 入参 statusGroup. 与 /api/tasks/page 服务端 StatusGroup 一致
    (active/terminal/all). R221: 补 'all' — chat 模式会话列表用. */
type StatusGroup = 'active' | 'terminal' | 'all';

/** R58: 视图模式 — kanban (默认, R58.5 改, 看板优先) / cards (R14 落地) /
    chat (R53) / list (R58 加, 紧凑 table 渲染, 镜像 GlobalBoard gb-list-table).
    category (飞书 R244, 参考 GlobalBoard af48068d) = 分类视图 (自包含组件).
    grouped 留给后续 R+ task. URL ?mode= 持久化. */
type ViewMode = 'cards' | 'kanban' | 'chat' | 'list' | 'category';

/** 任务状态枚举 (与 master TaskStatus 对齐: 11 状态, active 7 + terminal 4). */
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

/** TaskTrimmed 精简投影 — 字段名 / 类型严格对齐 master src/lib/runtime/types.ts
    TaskTrimmed 定义. 多余字段 UI 不消费也不读取, 这里只列必需字段. */
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

/** /api/tasks/page 信封响应 (route.ts 返回 { items, total, hasMore }). */
interface TasksPageResponse {
  items: TaskTrimmed[];
  total: number;
  hasMore: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** 状态中文标签 (与 master STATUS_LABELS 对齐). R131 加入 await_user = "等用户介入".
    i18n (W3a): computed 包一层让语言切换时标签即时刷新. */
const STATUS_LABELS = computed<Record<TaskStatus, string>>(() => ({
  pending: t('tasks.board.statusPending'),
  queued: t('tasks.board.statusQueued'),
  running: t('tasks.board.statusRunning'),
  paused: t('tasks.board.statusPaused'),
  reviewing: t('tasks.board.statusReviewing'),
  verifying: t('tasks.board.statusVerifying'),
  await_user: t('tasks.board.statusAwaitUser'),
  completed: t('tasks.board.statusCompleted'),
  failed: t('tasks.board.statusFailed'),
  // 历史 rejected 显示兼容 (2026-09-15 决策): 读路径已映射 cancelled, 标签同步
  // 显示「已取消」— 曾误标「等待中」产生幽灵计数 (damo 2026-11-01 反馈).
  rejected: t('tasks.board.statusCancelled'),
  cancelled: t('tasks.board.statusCancelled'),
}));

/** 状态对应 chip class — 走本文件 scoped CSS 变量, 不引 Tailwind palette
    (项目统一规范, 见 R8 Input/R9 Select 风格). */
const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: 'status-pending',
  queued: 'status-queued',
  running: 'status-running',
  paused: 'status-paused',
  reviewing: 'status-reviewing',
  verifying: 'status-verifying',
  await_user: 'status-await-user',
  completed: 'status-completed',
  failed: 'status-failed',
  rejected: 'status-rejected',
  cancelled: 'status-cancelled',
};

/** active 状态全集 (看板分流). 与 master BOARD_ACTIVE_STATUSES 一致 (7 个).
    顺序与 Next 看板 status 标签出现顺序一致, 视觉对齐. */
const ACTIVE_STATUSES: TaskStatus[] = [
  'pending', 'queued', 'running', 'paused', 'reviewing', 'verifying', 'await_user',
];

/** terminal 状态全集. 与 master BOARD_TERMINAL_STATUSES 一致 (4 个). */
const TERMINAL_STATUSES: TaskStatus[] = [
  'completed', 'failed', 'rejected', 'cancelled',
];

/** R221: 全状态集合 (chat 会话列表用). 顺序 = active 段在前 + terminal 段在后. */
const ALL_STATUSES: TaskStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];

/** type 标签 + chip class. 与 master TYPE_LABELS / TYPE_COLORS 对齐
    (Tailwind 字符串不在 SPA 渲染, 这里改为组件 scoped class). */
const TYPE_LABELS = computed<Record<string, string>>(() => ({
  design: t('tasks.board.typeDesign'),
  dev: t('tasks.board.typeDev'),
  test: t('tasks.board.typeTest'),
  deploy: t('tasks.board.typeDeploy'),
}));

const TYPE_CHIP: Record<string, string> = {
  design: 'type-design',
  dev: 'type-dev',
  test: 'type-test',
  deploy: 'type-deploy',
};

/* ------------------------------------------------------------------ */
/*  Router & mode detection                                            */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();

/* R51 (B108) — 60s tick. 让卡片时间显示 (MM-DD HH:mm) 长时间停留自动刷新.
   useTick 返回 Ref<number>, 在 formatUpdatedAt 调用时作为第二参数传入, 让
   模板对 tick 产生响应式依赖, 60s 后 Vue 重新计算该表达式, 时间戳即时刷新. */
const tick = useTick(60_000);

/** 模式: project-version board / global board / project unversioned. 判定口径:
    - 路由名 project-unversioned (R29 增量) → unversioned
    - 路由名 global-board (将来挂 /global) OR 路径以 /global 兜底 → global
    - 路径含 projectId param → version
    - 都无 → 退到 version (router 挂载点必然给其中之一)
    router 暂未挂载这些路由 (M2+ 范畴), 但本组件已完整支持所有入口, 挂载后零改动. */
const mode = computed<'version' | 'global' | 'unversioned'>(() => {
  if (route.name === 'project-unversioned') return 'unversioned';
  if (route.name === 'global-board') return 'global';
  if (typeof route.path === 'string' && route.path.startsWith('/global')) return 'global';
  return 'version';
});

const projectId = computed<string>(() =>
  route.params.projectId ? String(route.params.projectId) : '',
);
const versionId = computed<string>(() =>
  route.params.versionId ? String(route.params.versionId) : '',
);

/** R53.4: 嵌入视图 (ProjectUnversioned) 可通过 prop 传项目名, 让 ChatView
    pill 显真名 (避免出现空名). 不传则退到 route param id (version mode 下
    ProjectSidebar 等已显示名字, 这里不强求). */
interface RootProps {
  projectName?: string | null;
  /** R217: 版本名透传 (VersionDetailView 有 version.name) — chat 右侧面板
      「归属」行 + 列表项 scope 行显真名, 没有则 ChatView 降级 id 前 8 位. */
  versionName?: string | null;
  /** R58: VersionDetailView 透传 chrome 折叠态. true = 上方 chrome 收起,
      BoardPage 自己的 header (含 活跃/历史 + view-mode toggle) + filter
      bar (status/model/tag/search) 同步隐藏, 让 board 内容直接占满. */
  chromeCollapsed?: boolean;
}
const rootProps = withDefaults(defineProps<RootProps>(), {
  projectName: null,
  chromeCollapsed: false,
});

/* ------------------------------------------------------------------ */
/*  URL state (filter / paging)                                        */
/* ------------------------------------------------------------------ */

/** R248 (damo): statusGroup — URL ?statusGroup= 显式最优先; 裸链接读上次显式
    点选的组 (localStorage 记忆, key 跟 syncLevel 三级走, 见 statusGroupKey);
    从未点选过回落 'all' (默认全部). 原缺省 active; chat 模式 R221/R244 的
    「缺省 all + 显式段才生效」语义被统一记忆模型覆盖 (记忆缺省 = all, 点宏
    显式写记忆, 行为等价且跨模式一致). */
const statusGroup = computed<StatusGroup>(() => {
  const v = route.query.statusGroup;
  if (v === 'active' || v === 'terminal' || v === 'all') return v;
  return readBoardStatusGroup(statusGroupKey.value) ?? 'all';
});

/** statuses 多选过滤 (客户端 O(n) 过滤). URL ?statuses=pending,queued,... 缺省 =
    statusGroup 对应组全集 (R248: 记忆缺省 'all' 时 = 11 态全集).
    2026-11-01: raw === '' (显式空 param) = 真空态 (全不选), 不回落默认 — 镜像
    GlobalBoard R236 口径. 同时修掉旧 bug: 把组内 chip 全点掉时 join 出 ''
    被当缺省回落全集, 「点掉最后一个 chip 取消勾选失效」; 现在显式空 = 真空. */
const selectedStatuses = computed<Set<TaskStatus>>(() => {
  const raw = route.query.statuses;
  if (raw === '') return new Set<TaskStatus>();
  const defaultSet = effectiveStatusGroup.value === 'active' ? ACTIVE_STATUSES
    : effectiveStatusGroup.value === 'terminal' ? TERMINAL_STATUSES
    : ALL_STATUSES;
  if (typeof raw !== 'string' || !raw) return new Set<TaskStatus>(defaultSet);
  const arr = raw
    .split(',')
    .filter((s): s is TaskStatus => (defaultSet as readonly string[]).includes(s));
  return new Set<TaskStatus>(arr.length ? arr : defaultSet);
});

/** 当前展示的 status 集合 (chip 用). 等于 selectedStatuses 但类型强一些.
    2026-11-01: 剔除 rejected — 历史遗留终态已并入 cancelled 显示 (2026-09-15
    决策, 服务端读路径映射), 不再单列 chip / 看板列. 注意 selectedStatuses 的
    数据域仍是 11 态全集 (含 rejected), 两份清单别混用. */
const visibleStatuses = computed<TaskStatus[]>(() =>
  effectiveStatusGroup.value === 'active' ? ACTIVE_STATUSES
    : effectiveStatusGroup.value === 'terminal' ? TERMINAL_STATUSES.filter((s) => s !== 'rejected')
    : ALL_STATUSES.filter((s) => s !== 'rejected'),
);

/** R59+: 当前 viewport 缺省视图模式 — H5 = cards (避免 kanban 在窄屏被挤),
    桌面 = kanban. matchMedia 是 sync API, 在 viewMode / setViewMode / taskDetailHref
    三处共用保写盘逻辑跟 computed 双向一致. */
function currentDefaultMode(): ViewMode {
  return typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 1023px)').matches
    ? 'cards'
    : 'kanban';
}

/** R48: 视图模式 — URL ?mode= 持久化, 缺省按 viewport 走 (R59+): H5 = cards
    (避免 kanban 列在窄屏挤压成竖直单字), 桌面 = kanban (R58.5 看板优先).
    matchMedia 是 sync API, 在 route.query 变化时实时查当前 viewport. */
const viewMode = computed<ViewMode>(() => {
  const v = route.query.mode;
  if (v === 'cards' || v === 'chat' || v === 'list' || v === 'kanban' || v === 'category') return v;
  return currentDefaultMode();
});

/** R221→R248: 生效的 statusGroup — 原 chat 模式缺省 'all' 特判已并入统一记忆
    模型 (URL 显式 > 记忆 > 'all', 见 statusGroup), chat 与其余视图同口径:
    点宏写记忆生效, 再点已亮宏重置回该组全集. 保留 export 名不变, 避免散布
    引用逐处改名. */
const effectiveStatusGroup = computed<StatusGroup>(() => statusGroup.value);

/** searchText 即时写 URL (满足 R14 "保留筛选 query 进 URL"). fetch 走防抖. */
const searchText = computed<string>({
  get: () => String(route.query.q || ''),
  set: (v: string) => updateQuery({ q: v || undefined }),
});

/** 防抖搜索值 (200ms, 与 Next 版 R114 debounce 同口径). 触发 fetch. */
const debouncedSearch = ref<string>(searchText.value);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchText, (v) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    debouncedSearch.value = v;
  }, 200);
});

/** model 筛选 (服务端精确匹配, R114 第二轮). URL ?model= 缺省 = 空. */
const modelFilter = computed<string>({
  get: () => String(route.query.model || ''),
  set: (v: string) => updateQuery({ model: v || undefined }),
});

/** Select 组件要 string | null, 这里做 '' ↔ null 适配. */
const modelSelect = computed<string | null>({
  get: () => modelFilter.value || null,
  set: (v: string | null) => { modelFilter.value = v || ''; },
});

/** tag 筛选 (服务端精确匹配 tags 数组任一项). URL ?tag= 缺省 = 空. */
const tagFilter = computed<string>({
  get: () => String(route.query.tag || ''),
  set: (v: string) => updateQuery({ tag: v || undefined }),
});
const tagSelect = computed<string | null>({
  get: () => tagFilter.value || null,
  set: (v: string | null) => { tagFilter.value = v || ''; },
});

/** includeDeleted (含软删). URL ?includeDeleted=true 缺省 = false. */
const showDeleted = computed<boolean>({
  get: () => route.query.includeDeleted === 'true',
  set: (v: boolean) => updateQuery({ includeDeleted: v ? 'true' : undefined }),
});

/** 当前页 (1-indexed). URL ?page= 缺省 = 1. 切换筛选时强制回 1. */
const currentPage = computed<number>({
  get: () => {
    const n = Number(route.query.page || 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  },
  set: (v: number) => updateQuery({ page: v > 1 ? String(v) : undefined }),
});

/** 每页大小. URL ?pageSize= 缺省 = 50 (与 Next board-client 默认 limit 一致). */
const pageSize = computed<number>({
  get: () => {
    const n = Number(route.query.pageSize || 50);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50;
  },
  set: (v: number) => updateQuery({ pageSize: v !== 50 ? String(v) : undefined }),
});

/** 把 patch 合并进 URL query (delete undefined 字段保 URL 干净). router.replace
    不入 history, 避免筛选变化污染浏览器后退栈. */
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

/** 飞书 R244 (damo): 「活跃/历史」从 VersionDetailView chrome 挪进状态 chip 行
    头部, 语义从「切段加载开关」改成**状态分组快捷键** (chip 宏, 镜像 GlobalBoard
    R236 setStatusGroup): 点「活跃」= 全选 7 个活跃态 + 反选全部终态; R248 加
    「全部」宏 = 11 态全集并成为缺省组.
    实现 (R248 统一记忆模型) = 写持久化记忆 (下次裸链接恢复, 见
    board-status-group.ts) + 清 statuses param (回落该组全集默认) + 剥
    statusGroup param (缺省 = 记忆, URL 保持干净 — R235 mode 同款套路).
    重复点击同一组也重置 — 从组内自定义子集一键回全集. 同时把 page 重置到 1.
    chat 模式特判已删 (R221/R244 语义并入记忆模型, 行为等价).
    2026-11-01 (damo): 「全部」宏升级为 toggle — 已是全选态再点 = 全不选
    (?statuses= 真空态), 之后再点单个 chip 即「只看该状态」, 免去逐个点掉
    其余状态的麻烦; 再点「全部」回全集, 行为对称. 「活跃/历史」保持原语义
    (重复点击 = 回组全集). */
function setStatusGroup(g: StatusGroup): void {
  const wasAllOn = g === 'all' && statusSetEq(selectedStatuses.value, ALL_STATUSES);
  writeBoardStatusGroup(statusGroupKey.value, g);
  if (wasAllOn) {
    updateQuery({ statusGroup: undefined, statuses: '', page: undefined });
    return;
  }
  updateQuery({ statusGroup: undefined, statuses: undefined, page: undefined });
}

/** 选择集比较: 大小相等 + 逐个包含 = 集合相等 (给 preset 亮灯用, 镜像 GlobalBoard
    R236 statusSetEq). */
function statusSetEq(a: Set<TaskStatus>, list: readonly TaskStatus[]): boolean {
  if (a.size !== list.length) return false;
  return list.every((s) => a.has(s));
}

/** 飞书 R244 + R248: 当前选择恰好等于某组全集 → 对应宏按钮亮灯. 版本页缺省
    (无 ?statuses=) 即 statusGroup 对应组全集 → 缺省亮对应宏 (记忆缺省 'all'
    时亮「全部」); 组内自定义子集 → 都不亮 (按钮语义 = 一键回到该组全集).
    chat 特判已删 — 记忆模型下 selectedStatuses 缺省回落已覆盖原语义. */
const allPresetOn = computed<boolean>(() => statusSetEq(selectedStatuses.value, ALL_STATUSES));
const activePresetOn = computed<boolean>(() => statusSetEq(selectedStatuses.value, ACTIVE_STATUSES));
const terminalPresetOn = computed<boolean>(() => statusSetEq(selectedStatuses.value, TERMINAL_STATUSES));

/** R58.5/R59+: 切视图模式 (kanban / cards / list / chat). URL ?mode= 持久化; 当
    mode 等于当前 viewport 缺省 (H5=cards / 桌面=kanban) 时移除 param 保 URL
    干净, 否则写. 写盘逻辑跟 viewMode computed 双向一致 — 否则 H5 用户点
    kanban 后 URL 缺省走 cards, viewMode 即时回 cards, 出现「点了 kanban
    但还是 cards」的假死感 (用户反馈触发). 之前硬编码 m === 'kanban' ? undefined
    : m — 当时默认 kanban 写死没问题; H5 默认改成 cards 后必须动态跟 viewport. */
function setViewMode(m: ViewMode): void {
  if (viewMode.value === m) return;
  updateQuery({ mode: m === currentDefaultMode() ? undefined : m });
}

/* R58.5: task 卡片 router-link 跳转时把当前 BoardPage 状态写到 URL query.
   用户反馈「点击卡片没有带条件」: 之前只带 mode → 详情页跳回时丢失状态.
   把全部非默认筛选写进 task URL query → 后退/刷新/详情页内主动跳回都能
   恢复. 详情页 /tasks/{id} 不读这些 query, 无副作用. */
function taskDetailHref(taskId: string): { path: string; query: Record<string, string> } {
  const next: Record<string, string> = {};
  if (viewMode.value !== currentDefaultMode()) next.mode = viewMode.value;
  // R248: 非缺省组才写 — 缺省 = 持久化记忆 (无记忆 = 'all'), 跳回时走记忆恢复.
  if (statusGroup.value !== (readBoardStatusGroup(statusGroupKey.value) ?? 'all')) {
    next.statusGroup = statusGroup.value;
  }
  if (debouncedSearch.value) next.q = debouncedSearch.value;
  if (modelFilter.value) next.model = modelFilter.value;
  if (tagFilter.value) next.tag = tagFilter.value;
  if (showDeleted.value) next.includeDeleted = 'true';
  return { path: `/tasks/${taskId}`, query: next };
}

/** chip toggle 单一 status. 全选 → 不写 URL; 部分选 → 写逗号分隔列表;
    全不选 → 写 '' (真空态, 读回 = 空 Set, 列表空).
    2026-11-01: 全选判定改为「与当前组缺省全集 (11 态数据域) 集合相等」—
    chip 显示集已剔除 rejected (10 态), 若仍比 visibleStatuses 长度, 反选 1 个
    chip 时 next.size(10) === visible(10) 误判全选 → param 被清 → 取消勾选失效. */
function toggleStatus(s: TaskStatus): void {
  const next = new Set(selectedStatuses.value);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  const defaultSet = effectiveStatusGroup.value === 'active' ? ACTIVE_STATUSES
    : effectiveStatusGroup.value === 'terminal' ? TERMINAL_STATUSES
    : ALL_STATUSES;
  const allSelected = statusSetEq(next, defaultSet);
  updateQuery({ statuses: allSelected ? undefined : Array.from(next).join(','), page: undefined });
}

/* ------------------------------------------------------------------ */
/*  Data fetching                                                      */
/* ------------------------------------------------------------------ */

const tasks = ref<TaskTrimmed[]>([]);
const total = ref<number>(0);
const hasMore = ref<boolean>(false);
const loading = ref<boolean>(false);
const loadingMore = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

/* R51 (B105) — 删除二次确认. 镜像 master board-client.tsx:782-806. 删除按钮
   触发只设 modelState, 真正 DELETE 走 confirmDeleteTask, 失败 toast.error,
   成功后本地 patch deleted_at (与 master 同款乐观更新, 不依赖刷新). */
const toast = useToast();
const deleteConfirm = ref<{ taskId: string; taskTitle: string; status?: TaskStatus } | null>(null);

/* R232 Round4 (damo 10-10): 「+」聊天式快速创建弹窗 — 所有创建入口 (FAB /
   空态 CTA) 就地弹对话窗 (项目/版本可切换 + 输入指令即发送启动), 不再跳
   /tasks/new 表单页. 创建成功 SSE 自动插行, 这里再兜底 refresh 一次. */
const quickCreateOpen = ref(false);
function onQuickCreated(): void {
  refresh();
}

/* R51 (B093) — 状态 chip 行拖拽重排. 镜像 master board-client.tsx:1163-1207.
   HTML5 原生 drag/drop, dataTransfer 传 tag id, drop 时 splice 重排.
   columnOrder 持久化到 localStorage, key 含 project/version (unversioned
   走 -unversioned 后缀), 跨 session 保留用户偏好. */
const draggingChip = ref<TaskStatus | null>(null);
const dragOverChip = ref<TaskStatus | null>(null);

/** R51 (B095) — 同步配置. 镜像 master board-client.tsx:1211-1262 + useBoardConfig.
   syncLevel 决定 chipOrder 等偏好的 localStorage key 范围:
     - scope   (不同步) = 当前 projectId + mode/versionId 单 scope 存
     - project (弱同步) = 整个 projectId 共享, 跨 mode/version
     - account (强同步) = 跨 project 共享, key = ao-board-column-order-account
   与 master scope/project/account 三级 1:1 对应. */
type SyncLevel = 'scope' | 'project' | 'account';
const syncLevel = ref<SyncLevel>('scope');
const showSyncMenu = ref<boolean>(false);
const syncMenuRef = ref<HTMLElement | null>(null);

const SYNC_META = computed<Record<SyncLevel, { label: string; hint: string }>>(() => ({
  scope: { label: t('tasks.board.syncScopeLabel'), hint: t('tasks.board.syncScopeHint') },
  project: { label: t('tasks.board.syncProjectLabel'), hint: t('tasks.board.syncProjectHint') },
  account: { label: t('tasks.board.syncAccountLabel'), hint: t('tasks.board.syncAccountHint') },
}));

const SYNC_KEY = 'ao-board-sync-level';

function loadSyncLevel(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw === 'scope' || raw === 'project' || raw === 'account') {
      syncLevel.value = raw;
    }
  } catch { /* ignore */ }
}

function setSyncLevel(level: SyncLevel): void {
  syncLevel.value = level;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(SYNC_KEY, level); } catch { /* ignore */ }
  }
  // 关菜单
  showSyncMenu.value = false;
  // 重新解析 chipOrderKey → 触发 watch loadChipOrder.
  // 简单做法: 直接调用 loadChipOrder(). 反正 watcher 也会跟, 多调一次无害.
  loadChipOrder();
}

/** localStorage key — syncLevel 决定范围, scope 模式按 projectId + mode/version
   拆 key. project 模式按 projectId 拆 key. account 模式全平台共享. */
const chipOrderKey = computed<string>(() => {
  if (syncLevel.value === 'account') return 'ao-board-column-order-account';
  if (syncLevel.value === 'project') return `ao-board-column-order-${projectId.value || 'global'}`;
  return `ao-board-column-order-${projectId.value || 'global'}-${mode.value === 'unversioned' ? 'unversioned' : versionId.value || 'unknown'}`;
});

/** R248: statusGroup 记忆 key — 与 chipOrder 同一套 syncLevel 三级范围, 命名
   独立 (ao-board-status-group-*) 避免与 column-order 相互覆盖. */
const statusGroupKey = computed<string>(() => {
  if (syncLevel.value === 'account') return 'ao-board-status-group-account';
  if (syncLevel.value === 'project') return `ao-board-status-group-${projectId.value || 'global'}`;
  return `ao-board-status-group-${projectId.value || 'global'}-${mode.value === 'unversioned' ? 'unversioned' : versionId.value || 'unknown'}`;
});

/** 当前 chip 顺序. 缺省 = visibleStatuses 顺序 (即 ACTIVE / TERMINAL 数组
   顺序, 与 master BOARD_ACTIVE_STATUSES / BOARD_TERMINAL_STATUSES 一致).
   用户拖拽后写入 localStorage, 挂载时读回. */
const chipOrder = ref<TaskStatus[]>([]);
function loadChipOrder(): void {
  const fallback = visibleStatuses.value;
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
    // 过滤掉不在 visibleStatuses 的 status (避免 stale 残留), 然后追加任何
    // 漏掉的 (保持 visibleStatuses 完整覆盖).
    const valid = new Set(visibleStatuses.value);
    const filtered = parsed.filter((s: unknown): s is TaskStatus =>
      typeof s === 'string' && valid.has(s as TaskStatus),
    );
    const have = new Set(filtered);
    const missing = visibleStatuses.value.filter((s) => !have.has(s));
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
    // localStorage 满了 / 拒绝 (隐私模式) → 静默, 下次再试.
  }
}

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

/** R51 (B095) — 同步菜单 click-outside 关闭. 镜像 master board-client.tsx:492-501
   syncMenuRef + mousedown listener. unmount 自动 cleanup. */
function onDocMouseDown(e: MouseEvent): void {
  if (!showSyncMenu.value) return;
  const root = syncMenuRef.value;
  if (root && !root.contains(e.target as Node)) {
    showSyncMenu.value = false;
  }
}

/** 拼 /api/tasks/page query string. statusGroup 必填 (R14 红线 "必填 front").
    R221: chat 模式发 'all' — 会话列表含失败/完成会话. */
function buildParams(): URLSearchParams {
  const p = new URLSearchParams();
  p.set('statusGroup', effectiveStatusGroup.value);
  if (mode.value === 'version' && projectId.value) {
    p.set('project', projectId.value);
    if (versionId.value) p.set('version', versionId.value);
  } else if (mode.value === 'unversioned' && projectId.value) {
    // R29: 镜像 Next.js /[projectId]/unversioned — 只发 project + unversioned=true,
    // 不发 version (后端要求 unversioned=true 必带 project, 否则 400, 见 master
    // src/app/api/tasks/page/route.ts:67).
    p.set('project', projectId.value);
    p.set('unversioned', 'true');
  }
  if (showDeleted.value) p.set('includeDeleted', 'true');
  if (debouncedSearch.value) p.set('q', debouncedSearch.value);
  if (modelFilter.value) p.set('model', modelFilter.value);
  if (tagFilter.value) p.set('tag', tagFilter.value);
  p.set('limit', String(pageSize.value));
  p.set('offset', String((currentPage.value - 1) * pageSize.value));
  return p;
}

/* ------------------------------------------------------------------ */
/*  R165: 常驻 + 后台同步 + 条件拉取                                    */
/* ------------------------------------------------------------------ */

/** 当前页窗口对应的 ETag (服务端指纹). 探针带着它去问"变了吗", 没变回 304 空响应. */
const pageEtag = ref<string | null>(null);

/** 快照 key = 筛选条件 (不含分页). 分页不参与: 只给第一页做快照, 用户手动翻到
    第 3 页刷新后回到第 1 页是合理预期, 而把 12 页都缓存起来没意义. */
function snapshotKey(): string {
  const p = buildParams();
  p.delete('offset');
  return `board:${p.toString()}`;
}

/** 拉当前页 + 记 ETag. reset=false (loadMore) 时 offset 非 0, 不写快照. */
async function loadPage(reset: boolean): Promise<void> {
  // R165 phase2: 驻留在别的路由上时跳过 (SSE 未知 task 触发的 refetch 会用
  // 失真的 buildParams 把缓存数据换成别人的). 漏掉的增量由切回时的 probeNow 补.
  if (route.path !== instancePath) return;
  // 飞书 R244: category 模式 = CategoryBoardView 自拉数据, BoardPage 的
  // statusGroup 分页拉取无消费方 — 早退省一次 /api/tasks/page 请求.
  if (viewMode.value === 'category') return;
  // 2026-11-01: 真空态 (全不选) — 无可展示数据, 清本地残留 + 早退省一次请求
  // (否则拉全组数据再被客户端过滤成 0 条, 且 total 残留全集数字与空列表矛盾).
  if (selectedStatuses.value.size === 0) {
    tasks.value = [];
    total.value = 0;
    hasMore.value = false;
    pageEtag.value = null;
    loading.value = false;
    loadingMore.value = false;
    retrying.value = false;
    return;
  }
  if (reset) {
    loading.value = true;
    error.value = null;
  } else {
    loadingMore.value = true;
  }
  try {
    // 用 getIfChanged(null etag) 而不是 get: 两者都发无 INM 的普通 GET, 但
    // 前者顺带把响应的 ETag 收下来 (后台探针要靠它做条件拉取).
    const res = await getIfChanged<TasksPageResponse>(
      `/api/tasks/page?${buildParams().toString()}`,
      null,
    );
    const data = res.data;
    if (res.etag) pageEtag.value = res.etag;
    if (!data) return; // 理论上带 null etag 不会 304; 兜底别把已有数据清空
    const items = Array.isArray(data?.items) ? data.items : [];
    tasks.value = reset ? items : [...tasks.value, ...items];
    total.value = typeof data?.total === 'number' ? data.total : items.length;
    hasMore.value = !!data?.hasMore;
    if (reset && currentPage.value === 1) {
      saveSnapshot(snapshotKey(), { items, total: total.value, hasMore: hasMore.value }, pageEtag.value);
    }
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      error.value = e.message || t('tasks.board.errRequestFailed', { status: e.status });
    } else if (e instanceof Error) {
      error.value = t('tasks.board.errNetwork', { msg: e.message });
    } else {
      error.value = t('tasks.board.loadFailed');
    }
    if (!reset) {
      // loadMore 失败时不追加, 但 currentPage 已 +1, 回退避免空指针
      currentPage.value = Math.max(1, currentPage.value - 1);
    }
  } finally {
    loading.value = false;
    loadingMore.value = false;
    retrying.value = false;
  }
}

/** 条件拉取探针: 带 ETag 问一次, 没变 (304) 就什么都不做, 变了才换数据.
 *  ⚠️ 静默替换, **不进 loading** —— 用户看的是正在看的页面, 后台校准不该把
 *  满屏卡片换成骨架屏. 真失败也不弹错误条 (抛给后台同步器记 state), 否则一个
 *  后台探针失败能把人正在看的东西糊掉. */
async function checkIfChanged(): Promise<boolean> {
  // R165 phase2: 本实例被 keep-alive 驻留、路由已走到别的页面时跳过探针.
  // 此时 route.params 已不是本实例的 (例如停在 /global 上), buildParams() 会
  // 退化成 global 参数 —— 探的是别人的数据集, 更糟的是 fingerprint 差异会触发
  // 用错误参数 refetch, 把缓存里这块看板的数据悄悄换成全局数据. capture
  // route.path 于 setup (:key="route.path" 保证实例与 path 一一对应, 不漂).
  if (route.path !== instancePath) return false;
  // 2026-11-01: 真空态 (全不选) — 探针不跑, 否则 pageEtag 已清, 普通 GET 拉回
  // 全集数据写进 total, 出现「共 N 条 + 空列表」的矛盾显示.
  if (selectedStatuses.value.size === 0) return false;
  const res = await getIfChanged<TasksPageResponse>(
    `/api/tasks/page?${buildParams().toString()}`,
    pageEtag.value,
  );
  if (res.etag) pageEtag.value = res.etag;
  if (!res.changed || !res.data) return false;
  const items = Array.isArray(res.data.items) ? res.data.items : [];
  tasks.value = items;
  total.value = typeof res.data.total === 'number' ? res.data.total : items.length;
  hasMore.value = !!res.data.hasMore;
  if (currentPage.value === 1) {
    saveSnapshot(snapshotKey(), { items, total: total.value, hasMore: hasMore.value }, pageEtag.value);
  }
  return true;
}

/** 挂到全局后台同步器: tab 切走 / 浏览器不聚焦时也每分钟探一次.
 *  key 取「路由身份」(mode + project + version) 而不是当前筛选 —— 同一实例
 *  生命周期内 route.params 不会变, 换筛选属于同一块看板, 不该换数据源;
 *  反过来两个 tab 各开一个版本时 key 必须不同, 否则后注册的顶掉先注册的. */
const syncKey = `board-sync:${mode.value}:${projectId.value}:${versionId.value}`;
useBackgroundSync({ key: syncKey, check: checkIfChanged });

/** 本实例创建时的路由 path. R165 phase2: keep-alive 下实例比路由活得久,
 *  后台探针必须只在「路由仍在自己 path 上」时才跑 (见 checkIfChanged). */
const instancePath = route.path;

/** keep-alive 下切回 tab 时 onMounted 不重跑, 必须靠 onActivated 探一次.
 *  放后台期间的变化在切回瞬间就补上, 用户看到的是"点开就是最新的". */
onActivated(() => {
  void probeNow(syncKey);
});

/** 首屏先用快照渲染 (无骨架屏), 再由上面的 onMounted/探针校准.
 *  快照只是临时代: 校准请求带同一个 ETag 发出, 没变就一个 304 收工.
 *  ⚠️ 必须在 setup 里同步跑 (不是 onMounted) —— 否则首帧渲染的是"空列表"分支,
 *  用户会先看到一瞬"暂无任务"再被数据替换, 反而比重载更晃. */
function hydrateFromSnapshot(): boolean {
  const snap = readSnapshot<{ items: TaskTrimmed[]; total: number; hasMore: boolean }>(
    snapshotKey(),
  );
  if (!snap || !Array.isArray(snap.data?.items)) return false;
  tasks.value = snap.data.items;
  total.value = snap.data.total ?? snap.data.items.length;
  hasMore.value = !!snap.data.hasMore;
  pageEtag.value = snap.etag;
  return true;
}
const hydratedFromSnapshot = hydrateFromSnapshot();

function refresh(): void {
  void loadPage(true);
}

function loadMore(): void {
  if (loadingMore.value || !hasMore.value) return;
  currentPage.value = currentPage.value + 1;
  void loadPage(false);
}

function onRetry(): void {
  retrying.value = true;
  void loadPage(true);
}

function onPageSizeChange(next: number): void {
  // R58 修复: 直接调 updateQuery 合并 pageSize + page=undefined 一次写, 不要
  // 走 computed setter. setter 内部调 updateQuery 会读 route.query, 而
  // router.replace 是 async (microtask), 两次连续写会读到 stale route.query,
  // 后一次覆盖前一次的 pageSize=20 → 切换后 URL 实际不带 pageSize, 刷新就回
  // 默认 50. 合并成单次 updateQuery 避免竞态.
  updateQuery({
    pageSize: next !== 50 ? String(next) : undefined,
    page: undefined,
  });
  void loadPage(true);
}

/** R48: 看板拖拽改 status 后, 父组件 reload 当前页拿到新 status/updated_at.
    走 loadPage(true) 而非 refreshAll — BoardPage 没 refreshAll 方法, 等价行为. */
function onKanbanUpdated(_taskId: string, _newStatus: TaskStatus): void {
  void loadPage(true);
}

/* R51 (B105) — 删除流程. 与 master board-client.tsx:782-806 同款两步:
   点击删除按钮 → 设 deleteConfirm 触发 dialog → 用户点确认才走 DELETE.
   R164 追加: deleteConfirm 带 status — 非终态任务先 cancel 再删 (见 confirmDeleteTask). */
function onDeleteClick(taskId: string, taskTitle: string, e: Event, status?: TaskStatus): void {
  e.preventDefault();
  e.stopPropagation();
  deleteConfirm.value = { taskId, taskTitle, status };
}

async function confirmDeleteTask(): Promise<void> {
  const target = deleteConfirm.value;
  deleteConfirm.value = null;
  if (!target) return;
  // R164 追加 (damo): 非终态任务直接删时先 cancel — cancelTask 会把内存队列
  // dequeue 干净 + 释放 slot, 否则队列残留死键、DB status 停在 queued 语义混乱
  // (「显示已删除却挂着排队中」). cancel 尽力而为: 失败 (状态已变/权限) 不阻断删除.
  const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'queued', 'running', 'paused', 'reviewing', 'verifying', 'await_user'];
  if (target.status && ACTIVE_STATUSES.includes(target.status)) {
    try { await post<void>(`/api/tasks/${target.taskId}/cancel`); } catch { /* 尽力 cancel, 失败继续删 */ }
  }
  try {
    await del<void>(`/api/tasks/${target.taskId}`);
    toast.success(t('tasks.board.deletedToast', { title: target.taskTitle }));
    // 乐观更新: 本地 patch deleted_at, 让卡片立刻显示「已删除」标签, 不依赖刷新.
    const now = new Date().toISOString();
    tasks.value = tasks.value.map((t) =>
      t.id === target.taskId ? { ...t, deleted_at: now } : t,
    );
  } catch (e: unknown) {
    const msg = e instanceof HttpError
      ? (e.message || `HTTP ${e.status}`)
      : e instanceof Error ? e.message : t('tasks.board.unknownError');
    toast.error(t('tasks.board.deleteFailed', { msg }));
  }
}

function cancelDeleteTask(): void {
  deleteConfirm.value = null;
}

/* R55.4 (B100) — 恢复任务. 镜像 master board-client.tsx:808-823.
   已删除任务卡片 ↩ 按钮 → POST /api/tasks/{id}/restore → 乐观更新 deleted_at=null.
   删除按钮的位置拿这个 ↩ 当「反向」, 在已删除任务上替位 (与 master card HTML 形态一致).
   防止冒泡同删除按钮: preventDefault + stopPropagation. */
async function onRestoreClick(taskId: string, taskTitle: string, e: Event): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  try {
    await post<void>(`/api/tasks/${taskId}/restore`);
    toast.success(t('tasks.board.restoredToast', { title: taskTitle }));
    tasks.value = tasks.value.map((t) =>
      t.id === taskId ? { ...t, deleted_at: null } : t,
    );
  } catch (e: unknown) {
    const msg = e instanceof HttpError
      ? (e.message || `HTTP ${e.status}`)
      : e instanceof Error ? e.message : t('tasks.board.unknownError');
    toast.error(t('tasks.board.restoreFailed', { msg }));
  }
}

/* R58: 列表模式复用 GlobalBoard 同款 STATUS_BUTTONS + runAction 模式.
   镜像 src/views/GlobalBoard.vue:222-243 (STATUS_BUTTONS) + 631-657
   (runAction) + 704-714 (handleListAction), 但 patchTask 改本地
   tasks[] (单数组, 不是 activeTasks+terminalTasks 双数组).

   - delete 已存在 (confirmDeleteTask), 这里走 dialog 不再重复.
   - restore 已存在 (onRestoreClick), deleted task 在列表模式独立按钮,
     走 onRestoreClick 不在这里调.
   - refine 走三段 ConfirmDialog (master tdc.tsx:2992-3082 同款 — 收一条
     可选 message). 弹窗状态 refineDialog + refineMessage.
   - 失败处理: HttpError toast 报错, 不抛. */

interface ListActionBtn {
  key: string;
  label: string;
  tone: 'primary' | 'danger' | 'normal';
}

/** i18n (W3a): computed 包一层让语言切换时按钮 label 即时刷新; 「取消」复用 common.cancel. */
const STATUS_BUTTONS = computed<Record<TaskStatus, ListActionBtn[]>>(() => ({
  // R164 追加 (damo): pending/queued 也给「取消 + 删除」— 派发洪水时在列表上
  // 直接止血, 不用进详情页/改库. 后端 DELETE 无状态限制; queued 软删后
  // schedule() 出队 `!task -> continue` 自然跳过 (task-scheduler.ts).
  pending:   [{ key: 'start', label: t('tasks.board.btnStart'), tone: 'primary' }, { key: 'cancel', label: t('common.cancel'), tone: 'danger' }, { key: 'delete', label: t('tasks.board.btnDelete'), tone: 'danger' }],
  queued:    [{ key: 'start', label: t('tasks.board.btnStart'), tone: 'primary' }, { key: 'cancel', label: t('common.cancel'), tone: 'danger' }, { key: 'delete', label: t('tasks.board.btnDelete'), tone: 'danger' }],
  running:   [{ key: 'pause', label: t('tasks.board.btnPause'), tone: 'normal' }, { key: 'cancel', label: t('common.cancel'), tone: 'danger' }],
  paused:    [{ key: 'resume', label: t('tasks.board.btnResume'), tone: 'primary' }, { key: 'cancel', label: t('common.cancel'), tone: 'danger' }],
  reviewing: [
    { key: 'approve', label: t('tasks.board.btnApprove'), tone: 'primary' },
    { key: 'refine', label: t('tasks.board.btnRefine'), tone: 'primary' },
    { key: 'restart', label: t('tasks.board.btnRestart'), tone: 'danger' },
    { key: 'cancel', label: t('common.cancel'), tone: 'danger' },
  ],
  verifying: [{ key: 'cancel', label: t('common.cancel'), tone: 'danger' }],
  await_user: [
    { key: 'approve', label: t('tasks.board.btnApprove'), tone: 'primary' },
    { key: 'unawait', label: t('tasks.board.btnUnawait'), tone: 'primary' },
    { key: 'cancel', label: t('common.cancel'), tone: 'danger' },
  ],
  completed: [{ key: 'delete', label: t('tasks.board.btnDelete'), tone: 'danger' }],
  failed:    [{ key: 'start', label: t('tasks.board.btnRetry'), tone: 'primary' }, { key: 'delete', label: t('tasks.board.btnDelete'), tone: 'danger' }],
  rejected:  [{ key: 'start', label: t('tasks.board.btnRedo'), tone: 'primary' }, { key: 'delete', label: t('tasks.board.btnDelete'), tone: 'danger' }],
  cancelled: [{ key: 'start', label: t('tasks.board.btnRestartTask'), tone: 'primary' }, { key: 'delete', label: t('tasks.board.btnDelete'), tone: 'danger' }],
}));

/** R58: 列表模式行内 action 通用执行 — 与 GlobalBoard runAction 形态同款.
    单一 endpoint = POST /api/tasks/[id]/<action>, body 可选 (refine 带
    message, 其他无 body). 成功 → patchTask 本地状态; 失败 → toast.
    start 排队提示与 GlobalBoard 同款 (后端 status='queued' 时弹 warn). */
async function runListAction(taskId: string, action: string, body?: Record<string, unknown>): Promise<void> {
  try {
    const data = await post<{ status?: TaskStatus }>(`/api/tasks/${taskId}/${action}`, body);
    if (action === 'start' && data?.status === 'queued') {
      toast.warn(t('tasks.board.queuedToast'));
    } else if (data?.status) {
      tasks.value = tasks.value.map((t) =>
        t.id === taskId ? { ...t, status: data.status as TaskStatus, updated_at: new Date().toISOString() } : t,
      );
    }
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      toast.error(t('tasks.board.actionFailedMsg', { action, msg: e.message || `HTTP ${e.status}` }));
    } else if (e instanceof Error) {
      toast.error(t('tasks.board.errNetworkToast', { msg: e.message }));
    } else {
      toast.error(t('tasks.board.actionFailed', { action }));
    }
  }
}

/** R58: refine 走三段 dialog — 收一条可选 message. delete 走 deleteConfirm
    dialog (confirmDeleteTask). 其他 action 直接走 runListAction. */
function handleListAction(task: TaskTrimmed, action: string): void {
  if (action === 'delete') {
    onDeleteClick(task.id, task.title, new Event('click'), task.status);
    return;
  }
  if (action === 'refine') {
    refineDialog.value = { taskId: task.id, taskTitle: task.title };
    refineMessage.value = '';
    return;
  }
  void runListAction(task.id, action);
}

/* R58: refine 弹窗状态. 与 GlobalBoard refineDialog 同款. */
const refineDialog = ref<{ taskId: string; taskTitle: string } | null>(null);
const refineMessage = ref<string>('');

async function submitRefine(): Promise<void> {
  const ctx = refineDialog.value;
  refineDialog.value = null;
  if (!ctx) return;
  const msg = refineMessage.value.trim();
  await runListAction(ctx.taskId, 'refine', msg ? { message: msg } : undefined);
  refineMessage.value = '';
}

function cancelRefine(): void {
  refineDialog.value = null;
  refineMessage.value = '';
}

/** R51 (B102) — DecisionBanner onResolved 回调. 本地 patch tasks[i].awaiting_markers
   把对应 decision 标 resolved_at/resolved_label, banner 二次 render 时
   parseAwaitingDecisions 仍可能返回它 (但 DecisionBanner 自己 resolvedMap 已
   标 ✓ 显示) — 等下次 /api/tasks/page 拉取或 SSE 推 patch 替换为服务端真值. */
function onDecisionResolved(taskId: string, decisionId: string, selectedLabel: string): void {
  tasks.value = tasks.value.map((t) =>
    t.id === taskId
      ? {
          ...t,
          awaiting_markers: patchDecisionResolved(t.awaiting_markers, decisionId, selectedLabel),
        }
      : t,
  );
}

/* R55.5 (B088) — 项目级 SSE 实时 patch. 镜像 master board-client.tsx:609-688.
   订阅 /api/projects/{projectId}/events (composable 单例 + 引用计数避免同域名额占满,
   全局 /api/events 在 GlobalBoard 已挂, 项目级独立一条). 仅在 mode ∈
   {version, unversioned} 挂, global 模式没有 projectId 跳过.
   status_change: 按方向分流 patch (active↔active / active↔terminal /
     terminal terminal); cost: 原地 patch; 未知 task 仅 refetch 当前
     statusGroup 集合不整体 refetch (R54 fix 收益保护). */
const TERMINAL_STATUS_NAMES = new Set<TaskStatus>(TERMINAL_STATUSES);

function isTerminalStatus(s: TaskStatus): boolean {
  return TERMINAL_STATUS_NAMES.has(s);
}

function onProjectEvent(event: GlobalEvent): void {
  if (event.type === 'status_change' && typeof event.task_id === 'string' && typeof event.to === 'string') {
    const id = event.task_id;
    const toStatus = event.to as TaskStatus;
    const toIsTerminal = isTerminalStatus(toStatus);
    const idx = tasks.value.findIndex((t) => t.id === id);
    if (idx === -1) {
      // 未知 task: 按目标方向只 refetch 当前 statusGroup ('all' 时两方向都重拉).
      if (toIsTerminal) {
        if (effectiveStatusGroup.value !== 'active') void loadPage(true);
      } else {
        if (effectiveStatusGroup.value !== 'terminal') void loadPage(true);
      }
      return;
    }
    const currentStatus = tasks.value[idx].status;
    const fromIsTerminal = isTerminalStatus(currentStatus);
    if (fromIsTerminal && toIsTerminal) {
      // terminal → terminal: 原地 patch (但本视图可能 filter 走丢了, 不强求可见).
      tasks.value = tasks.value.map((t) =>
        t.id === id ? { ...t, status: toStatus, updated_at: new Date().toISOString() } : t,
      );
    } else if (!fromIsTerminal && !toIsTerminal) {
      // active → active: 原地 patch.
      tasks.value = tasks.value.map((t) =>
        t.id === id ? { ...t, status: toStatus, updated_at: new Date().toISOString() } : t,
      );
    } else if (effectiveStatusGroup.value === 'all') {
      // R221: 全状态视图 (chat 会话列表) — 跨段原地 patch, 行不移除.
      // 会话失败/完成只在列表里变状态 chip, 不从会话列表消失.
      tasks.value = tasks.value.map((t) =>
        t.id === id ? { ...t, status: toStatus, updated_at: new Date().toISOString() } : t,
      );
    } else if (!fromIsTerminal && toIsTerminal) {
      // active → terminal: 移除 (本视图 statusGroup 不再含它, 等下次 terminal 切再拉).
      tasks.value = tasks.value.filter((t) => t.id !== id);
    } else {
      // terminal → active: 不在本集合, 让下次 statusGroup=active 切换自然拉.
    }
    return;
  }

  if (event.type === 'cost' && typeof event.task_id === 'string' && typeof event.cost_usd === 'number') {
    const id = event.task_id;
    const cost = event.cost_usd;
    tasks.value = tasks.value.map((t) =>
      t.id === id ? { ...t, cost_usd: cost } : t,
    );
  }
  // 其他事件类型未知, 静默忽略.
}

/** 只有 projectId 非空 (version/unversioned 模式) 才挂 SSE, 否则跳过 (空串不建流).
    R233: 传响应式 computed 而非 .value 快照 —— 本组件被 keep-alive 复用实例,
    切项目时 url 变化, composable 自动迁移订阅 (旧流还名额 + 新流建立);
    keep-alive 切走 tab 时 onDeactivated 断流, 还 HTTP/1.1 每域 6 个并发名额. */
const sseUrl = computed<string>(() =>
  projectId.value ? `/api/projects/${projectId.value}/events` : '',
);
useTaskEventSource(sseUrl, onProjectEvent, () => {
  // R245: SSE 断线窗口内 status_change / cost 事件永久丢失 (服务端无
  // Last-Event-ID 回放), 原地 patch 的卡片会僵死 — 重连时整页重拉兜底.
  // loadPage 自带驻留路由 guard, 非当前看板时跳过.
  void loadPage(true);
});

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 客户端 status 多选过滤. server 已按 statusGroup + q/model/tag 收窄, 这里
    只剔掉用户主动去勾选的 status chip. */
const filteredTasks = computed<TaskTrimmed[]>(() => {
  const sel = selectedStatuses.value;
  return tasks.value.filter((t) => sel.has(t.status));
});

/** model 下拉候选 — 从当前已加载 task 聚合. 空数据时仅 "全部模型" 占位. */
const modelOptions = computed<{ value: string; label: string }[]>(() => {
  const m = new Set<string>();
  for (const t of tasks.value) if (t.model) m.add(t.model);
  const list = Array.from(m).sort();
  return [{ value: '', label: t('tasks.board.allModels') }, ...list.map((x) => ({ value: x, label: x }))];
});

/** tag 下拉候选 — 解析 tags JSON 数组聚合. */
const tagOptions = computed<{ value: string; label: string }[]>(() => {
  const tags = new Set<string>();
  for (const t of tasks.value) {
    if (!t.tags) continue;
    try {
      const arr = JSON.parse(t.tags);
      if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string') tags.add(x);
    } catch {
      // ignore malformed tag JSON
    }
  }
  const list = Array.from(tags).sort();
  return [{ value: '', label: t('tasks.board.allTags') }, ...list.map((x) => ({ value: x, label: x }))];
});

/** 页面标题. global 模式 = "全局看板"; unversioned 模式 = "未挂版本任务";
    version 模式 = "版本看板". */
const pageTitle = computed<string>(() => {
  if (mode.value === 'global') return t('tasks.board.titleGlobal');
  if (mode.value === 'unversioned') return t('tasks.board.titleUnversioned');
  return t('tasks.board.titleVersion');
});

/** 副标题 (空 = 不渲染). global 模式: 跨项目跨版本汇总. unversioned 模式:
    包装视图 ProjectUnversioned.vue 已渲染项目名 + 副标题, 这里保持空避免重复. */
const pageSubtitle = computed<string>(() =>
  mode.value === 'global' ? t('tasks.board.subtitleGlobal') : '',
);

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

/** 格式化 updated_at (ISO → MM-DD HH:mm). 与 Next formatUpdatedAt 同口径.
   第二参数 _trigger 是 useTick 注入的响应式依赖, 让模板调用本函数时建立
   对 tick 的依赖, 60s 后 Vue 自动重渲. 内部不使用, 仅用于触发. */
function formatUpdatedAt(iso: string, _trigger?: number): string {
  // R205: 用 parseDbTime 当 UTC 处理 (GlobalBoard R56-B18 同款口径). 旧
  // new Date(iso) 把 SQLite UTC 时间当本地时间, CST 显示偏早 8h.
  const d = parseDbTime(iso);
  if (!d) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 解析 tags JSON. 失败或非数组 → []. */
function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** R51 (B102) — 解析 awaiting_markers 抽 decision type. 镜像 master
   board-client.tsx:174-184: type=decision 走 DecisionBanner, 不进 chip 队列.
   解析失败 / 非数组 → []. */
function parseAwaitingDecisions(awaitingMarkersJson: string | null): ParsedDecision[] {
  if (!awaitingMarkersJson) return [];
  try {
    const parsed = JSON.parse(awaitingMarkersJson) as Array<{
      type?: string;
      decision_id?: string;
      question?: string;
      options?: Array<{ label: string; description?: string }>;
      recommended?: string;
      recommended_reason?: string;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m) =>
          m.type === 'decision' &&
          typeof m.decision_id === 'string' &&
          Array.isArray(m.options),
      )
      .map((m) => ({
        decisionId: m.decision_id as string,
        question: m.question || t('tasks.board.noQuestion'),
        options: (m.options || []).filter(
          (o): o is { label: string; description?: string } =>
            !!o && typeof o.label === 'string',
        ),
        recommended: typeof m.recommended === 'string' ? m.recommended : undefined,
        recommendedReason:
          typeof m.recommended_reason === 'string' ? m.recommended_reason : undefined,
      }));
  } catch {
    return [];
  }
}

/** R51 (B102) — decision resolved 后本地 patch awaiting_markers, 给 banner
   标注 resolved_at/resolved_label. 与 master board-client.tsx:996-1027 同款. */
function patchDecisionResolved(
  markersJson: string | null,
  decisionId: string,
  selectedLabel: string,
): string | null {
  if (!markersJson) return markersJson;
  try {
    const arr = JSON.parse(markersJson);
    if (!Array.isArray(arr)) return markersJson;
    const next = arr.map((m: { decision_id?: string; resolved_at?: string }) => {
      if (m && m.decision_id === decisionId && !m.resolved_at) {
        return {
          ...m,
          resolved_at: new Date().toISOString(),
          resolved_label: selectedLabel,
        };
      }
      return m;
    });
    return JSON.stringify(next);
  } catch {
    return markersJson;
  }
}

/* ------------------------------------------------------------------ */
/*  Watchers & lifecycle                                               */
/* ------------------------------------------------------------------ */

/** 筛选条件变化 → 重拉第一页. offset 受 currentPage 影响, 一并触发.
    注意: URL 变化本身触发当前所有 computed 重算; 这里 watch 是 "触发副作用"
    的钩子, 不参与状态计算. */
watch(
  [effectiveStatusGroup, debouncedSearch, modelFilter, tagFilter, showDeleted, pageSize],
  () => {
    void loadPage(true);
  },
);

/** R51 (B093) — chipOrder scope (projectId/versionId/mode) 变化 → 重读
   localStorage. 例如用户从 unversioned 切到 version 应分别持久化偏好.
   statusGroup 也在依赖里: chipOrderKey 不含 statusGroup (活跃/历史/全部共享
   一份自定义顺序; 组记忆单独存 statusGroupKey, R248), 但 chipOrder
   fallback/过滤基于当前组 visibleStatuses —— 切组不重读会把另一组的 status
   集合留在 chipOrder 里, kanban 分桶时非当前组 status 的任务全被静默丢弃
   (表现为全列空「暂无任务」). */
watch(
  [() => chipOrderKey.value, effectiveStatusGroup],
  () => {
    loadChipOrder();
  },
);

onMounted(() => {
  loadSyncLevel();
  loadChipOrder();
  // R165: 有快照就先渲染快照 (无骨架屏), 再静默校准; 没快照才走带骨架屏的
  // 首次全量拉. 校准走 checkIfChanged 而不是 loadPage —— 后台动作不该把用户
  // 正在看的内容糊成 loading; 校准失败时快照仍然显示, 不比"什么都没有"差.
  if (hydratedFromSnapshot) {
    void checkIfChanged().catch(() => undefined);
  } else {
    void loadPage(true);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('mousedown', onDocMouseDown);
  }
  ensureResourcePolling();
});

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousedown', onDocMouseDown);
  }
  releaseResourcePolling();
});

/* R232: 任务资源轮询 — 本组件在 keep-alive 里, onActivated 切回 / onDeactivated
   切走必须配对 acquire/release, 否则驻留的后台 tab 会一直空轮询. 幂等 flag 防
   mounted+activated 双触发导致 refCount 泄漏. */
let resPollingAcquired = false;
function ensureResourcePolling(): void {
  if (!resPollingAcquired) {
    acquireTaskResourcesPolling();
    resPollingAcquired = true;
  }
}
function releaseResourcePolling(): void {
  if (resPollingAcquired) {
    releaseTaskResourcesPolling();
    resPollingAcquired = false;
  }
}
onActivated(ensureResourcePolling);
onDeactivated(releaseResourcePolling);

/* R51 (B104) — URL ?taskId 跳转. 镜像 master board-client.tsx:454-459.
   Mount 时读 route.query.taskId, 如有且当前模式非 chat → router.replace
   跳 /tasks/{id}. chat 模式时 ChatView 自己接 initialTaskId (R53 B351),
   不要在外层把它推到 /tasks/{id}.
   只在初次 mount 跑一次 (空 deps), 不监听后续 URL 变化 (用户已在 /tasks/
   详情页回退, 不要再被自己推到详情页). */
onMounted(() => {
  if (viewMode.value === 'chat') return;
  const urlTaskId = route.query.taskId;
  if (typeof urlTaskId === 'string' && urlTaskId) {
    void router.replace(`/tasks/${urlTaskId}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Chat view integration (R53.3 + R53.5 + R53.6 + B351 + B366 + B367)  */
/* ------------------------------------------------------------------ */

/** B351 — chat 模式 ?taskId deep-link. 同 R51.5 模式但反向: chat 模式下不让
   外层把 taskId 推走, 而是传给 ChatView initialTaskId. */
const chatInitialTaskId = computed<string | null>(() => {
  if (viewMode.value !== 'chat') return null;
  const t = route.query.taskId;
  return typeof t === 'string' && t ? t : null;
});

/** chat 视图传入的 project/version meta. URL 锁死场景下 chat pill 切 version
   会触发 router.push 跳新版本 URL, 而不是改全局 filter. */
const chatProjectMeta = computed<{ id: string; name: string } | null>(() => {
  if (!projectId.value) return null;
  return { id: projectId.value, name: rootProps.projectName ?? '' };
});

const chatVersionMeta = computed<{ id: string; name: string } | null>(() => {
  if (!versionId.value) return null;
  return { id: versionId.value, name: rootProps.versionName ?? '' };
});

const chatProjectNames = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  if (projectId.value) m[projectId.value] = rootProps.projectName ?? '';
  return m;
});

const chatVersionNames = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  if (versionId.value) m[versionId.value] = rootProps.versionName ?? '';
  return m;
});

/** B367 — ChatView 新建 task. 转成 TaskTrimmed 形状, 按 status 落到对应数组. */
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

const TERMINAL_STATUS_SET = new Set<TaskStatus>(['completed', 'failed', 'rejected', 'cancelled']);

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
    project_id: task.project_id ?? (projectId.value || null),
    version_id: task.version_id ?? (versionId.value || null),
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

function onChatTaskCreated(task: ChatTaskPayload): void {
  const trimmed = taskToTrimmed(task);
  if (TERMINAL_STATUS_SET.has(trimmed.status)) {
    /* BoardPage 单 statusGroup + loadPage 模式, terminal 不在视图但需要一致性
       refetch — 这里走 loadPage(true) 兜底 (master board-client.tsx 同款:
       把新 task 塞入 setTerminalTasks, 后续 SSE / refresh 覆盖). */
    void loadPage(true);
  } else {
    tasks.value = [trimmed, ...tasks.value];
    total.value = total.value + 1;
  }
}

/* R217v7: topHeaderOpen 状态机已删 — board-header 行整个移除 (见模板注释).
   chrome 折叠唯一入口 = VersionDetailView vd-chrome-toggle, key
   chat-top-header-open-v1 留给 GlobalBoard 各管各. */
</script>

<template>
  <div class="board-page">
    <!-- R217v7 (damo): board-header 整行删除 — R58.5 之后这行只剩一个
         chrome-toggle 按钮, 且它 toggles 的 topHeaderOpen 只门控它自己和
         FAB (收起自己 = 「自己还占用一行」). 真正的 chrome 折叠 (vd header
         + board-filter) 走 VersionDetailView 的 vd-chrome-toggle, 折叠态有
         vd-chrome-fab 在面包屑末尾兜底展开, 本组件不再持有第二份 toggle.
         topHeaderOpen 状态机 + chat-top-header-open-v1 持久化一并移除
         (GlobalBoard 同名 key 各管各, 不受影响). -->

    <!-- Filter bar: status chips + model/tag/search/showDeleted. R58 chromeCollapsed
         时整块折叠, board 区直接占满. 飞书 R244: category 模式整行藏 — 过滤条件
         对自包含的 CategoryBoardView 全部无效, 显示 = 「点了没反应」假死感. -->
    <div v-if="!rootProps.chromeCollapsed && viewMode !== 'category'" class="board-filter">
      <div class="filter-row">
        <span class="filter-label">{{ t('tasks.board.filterStatusLabel') }}</span>
        <!-- 飞书 R244 (damo) + R248: 全部/活跃/历史 = 状态分组快捷键 (chip 宏) —
             镜像 GlobalBoard R236: 点「活跃」= 全选 7 个活跃态 + 反选全部终态;
             点「全部」= 11 态全集 (双段同拉, damo: 默认全部). 位置 = 状态 chip 行
             头部 (标签前面). 亮灯判据 = 当前 chip 选择恰等于该组全集; 组内自定义
             子集时都不亮 (语义 = 一键回全集). 复用 .board-segmented/.seg-btn
             既有样式 (R58.5 保留, 模板此前无消费者, 此处回归使用). -->
        <div class="board-segmented" role="tablist" :aria-label="t('tasks.board.statusGroupAria')">
          <button
            type="button"
            role="tab"
            :aria-selected="allPresetOn"
            :class="['seg-btn', { 'seg-btn-active': allPresetOn }]"
            :title="allPresetOn ? t('tasks.board.allMacroToggleTitle') : t('tasks.board.allMacroTitle')"
            @click="setStatusGroup('all')"
          >
            {{ t('tasks.board.groupAll') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activePresetOn"
            :class="['seg-btn', { 'seg-btn-active': activePresetOn }]"
            @click="setStatusGroup('active')"
          >
            {{ t('tasks.board.groupActive') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="terminalPresetOn"
            :class="['seg-btn', { 'seg-btn-active': terminalPresetOn }]"
            @click="setStatusGroup('terminal')"
          >
            {{ t('tasks.board.groupHistory') }}
          </button>
        </div>
        <!-- R51 (B093): status chip 拖拽重排 — 镜像 master board-client.tsx:1163-1207.
             chipOrder 持久化到 localStorage, 用户拖完即写. dragging/dragover 视觉
             反馈同 master (ring 标 + opacity). -->
        <button
          v-for="s in chipOrder"
          :key="s"
          type="button"
          :class="[
            'status-chip',
            STATUS_COLORS[s] || 'status-default',
            { 'status-chip-on': selectedStatuses.has(s), 'status-chip-off': !selectedStatuses.has(s) },
            { 'status-chip-dragging': draggingChip === s },
            { 'status-chip-dragover': dragOverChip === s && draggingChip && draggingChip !== s },
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
          {{ STATUS_LABELS[s] || s }}
        </button>

        <!-- R51 (B095): 同步配置齿轮按钮 + 下拉菜单 — 镜像 master board-client.tsx:1209-1263.
             3 radio: 不同步 (scope) / 弱同步 (project) / 强同步 (account).
             持久化到 localStorage ao-board-sync-level. click-outside 自动关. -->
        <div ref="syncMenuRef" class="sync-menu-root">
          <button
            type="button"
            class="sync-menu-trigger"
            :title="t('tasks.board.syncSettingsTitle')"
            :aria-expanded="showSyncMenu"
            @click="showSyncMenu = !showSyncMenu"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
              <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.533 1.533 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
            </svg>
          </button>
          <div v-if="showSyncMenu" class="sync-menu">
            <div class="sync-menu-title">{{ t('tasks.board.syncLevelTitle') }}</div>
            <label
              v-for="(meta, lvl) in SYNC_META"
              :key="lvl"
              :class="['sync-menu-item', { 'sync-menu-item-on': syncLevel === lvl }]"
            >
              <Radio
                name="syncLevel"
                :value="lvl"
                :model-value="syncLevel"
                @update:model-value="(v) => setSyncLevel(v as SyncLevel)"
              />
              <span class="sync-menu-text">
                <span class="sync-menu-label">{{ meta.label }}</span>
                <span class="sync-menu-hint">{{ meta.hint }}</span>
              </span>
            </label>
          </div>
        </div>
      </div>

      <div class="filter-row filter-row-second">
        <Select
          v-model="modelSelect"
          :options="modelOptions"
          :placeholder="t('tasks.board.allModels')"
          class-name="filter-select"
        />
        <Select
          v-model="tagSelect"
          :options="tagOptions"
          :placeholder="t('tasks.board.allTags')"
          class-name="filter-select"
        />
        <div class="filter-search">
          <Input
            v-model="searchText"
            :placeholder="t('tasks.board.searchPlaceholder')"
            clearable
          />
        </div>
        <label class="filter-deleted">
          <Checkbox
            :model-value="showDeleted"
            @update:model-value="(v: boolean) => (showDeleted = v)"
          />
          <span>{{ t('tasks.board.showDeleted') }}</span>
        </label>
      </div>
    </div>

    <!-- Body: loading / error / empty / cards -->
    <div class="board-body">
      <!-- 飞书 R244: 分类视图 — 放链首 (在 BoardPage 自己的 loading/error/empty
           之前), category 模式完全绕过 BoardPage 内容区, 零闪烁. 组件自包含
           (自拉 pin-lists + 全量任务), 不吃上方 filter. -->
      <CategoryBoardView v-if="viewMode === 'category'" />

      <!-- Initial loading -->
      <div v-else-if="loading && tasks.length === 0" class="board-loading">
        <Loading size="lg" />
        <p class="board-loading-text">{{ t('tasks.board.loading') }}</p>
      </div>

      <!-- Error (with retry) -->
      <ErrorView
        v-else-if="error"
        :title="t('tasks.board.loadFailed')"
        :description="error"
        variant="error"
        :retrying="retrying"
        @retry="onRetry"
      />

      <!-- Empty (R13). R59+: 用 wrapper 包住 Empty, wrapper 自身 flex:1
           撑满 board-body. Empty 在 wrapper 里保持默认行为 (display:
           flex column + justify-content:center + width:100%), 自然占满
           wrapper 全宽, 内容 (svg + title + desc + .empty-action) 默认居
           中. .empty-action 的 margin-top:auto 来自 Empty 内部 CSS 选择器
           (Empty.vue 自带 — 不需要 :deep() 命中 Empty 组件根), 把 action
           推到 wrapper 底部, 跟下方 .board-pagination 上沿连一起.
           不靠 :deep(.empty-state) 改 Empty 自身 flex — :deep() 命中 child
           组件根在某些 Vue 编译路径下不可靠, 之前 wrapper + :deep() 让
           board-body 整体塌到 16px (用户反馈). 现在 wrapper 撑高度, Empty
           内容靠 Empty 自身 CSS 自然铺, 不打 Empty 内部样式. -->
      <div v-else-if="filteredTasks.length === 0" class="board-empty-wrap">
        <Empty
          :title="tasks.length === 0
            ? (viewMode === 'chat' ? t('tasks.board.emptyChat')
              : statusGroup === 'active' ? t('tasks.board.emptyActive')
              : statusGroup === 'terminal' ? t('tasks.board.emptyHistory') : t('tasks.board.emptyAll'))
            : t('tasks.board.emptyFiltered')"
          :description="tasks.length === 0
            ? t('tasks.board.emptyCreateHint')
            : t('tasks.board.emptyFilterHint')"
          illustration="inbox"
        >
          <button
            v-if="tasks.length === 0"
            type="button"
            class="btn btn-primary empty-cta"
            @click="quickCreateOpen = true"
          >
            + {{ t('tasks.board.newTask') }}
          </button>
        </Empty>
      </div>

      <!-- Cards grid (R14 原始) -->
      <div v-else-if="viewMode === 'cards'" class="board-grid">
        <article
          v-for="task in filteredTasks"
          :key="task.id"
          :class="['task-card', { 'task-card-deleted': !!task.deleted_at }]"
        >
          <!-- R51 (B105): 右上角删除按钮 — 镜像 master board-client.tsx:903-910.
               仅未删除任务显示; 已删除任务位 R55.4 (B100) 替为 ↩ 恢复按钮.
               prevent+stop 防止冒泡到 router-link. -->
          <button
            v-if="!task.deleted_at"
            type="button"
            class="task-card-delete"
            :title="t('tasks.board.deleteTaskTitle')"
            @click="(e: Event) => onDeleteClick(task.id, task.title, e, task.status)"
          >
            🗑
          </button>
          <button
            v-else
            type="button"
            class="task-card-restore"
            :title="t('tasks.board.restoreDeletedTitle')"
            @click="(e: Event) => onRestoreClick(task.id, task.title, e)"
          >
            ↩
          </button>
          <div class="task-card-top">
            <span :class="['status-badge', STATUS_COLORS[task.status] || 'status-default']">
              {{ STATUS_LABELS[task.status] || task.status }}
            </span>
            <QueuedReasonHint :status="task.status" :reason="task.queued_reason" />
            <span v-if="task.priority > 0" class="task-priority">P{{ task.priority }}</span>
            <span v-if="task.schedule_id" class="task-schedule" :title="t('tasks.board.scheduledTitle')">
              {{ t('tasks.board.scheduledBadge') }}
            </span>
            <span v-if="task.type" :class="['task-type', TYPE_CHIP[task.type] || 'type-default']">
              {{ TYPE_LABELS[task.type] || task.type }}
            </span>
            <span v-if="task.deleted_at" class="task-deleted-badge">{{ t('tasks.board.deletedBadge') }}</span>
          </div>

          <h3 :class="['task-title', { 'task-title-strike': !!task.deleted_at }]">
            <router-link :to="taskDetailHref(task.id)" class="task-title-link">
              {{ task.title }}
            </router-link>
          </h3>

          <!-- R51 (B102): DecisionBanner — awaiting_markers 中 type=decision 走这里.
               镜像 master board-client.tsx:985-1031. onResolved 后本地 patch
               awaiting_markers 标 resolved, banner 自然消失. -->
          <DecisionBanner
            v-if="!task.deleted_at"
            :task-id="task.id"
            :decisions="parseAwaitingDecisions(task.awaiting_markers)"
            :on-resolved="(decisionId, label) => onDecisionResolved(task.id, decisionId, label)"
          />

          <p class="task-prompt">{{ task.prompt_preview.slice(0, 120) }}</p>

          <div v-if="parseTags(task.tags).length > 0" class="task-tags">
            <span
              v-for="tag in parseTags(task.tags)"
              :key="tag"
              class="task-tag"
            >
              {{ tag }}
            </span>
          </div>

          <div class="task-meta">
            <span class="task-model">{{ task.resolved_model || task.model || '(default)' }}</span>
            <span v-if="task.cost_usd != null" class="task-cost">
              ${{ task.cost_usd.toFixed(4) }}
            </span>
            <span class="task-time">{{ formatUpdatedAt(task.updated_at, tick) }}</span>
            <!-- R232: 运行中任务的实时 CPU/内存徽章 (有 /proc 采样数据才渲染). -->
            <TaskResourceBadge
              v-if="taskResources[task.id]"
              :sample="taskResources[task.id]"
              :warn="(taskResources[task.id]?.cpuPercent ?? 0) > 80 || (taskResources[task.id]?.memPercent ?? 0) > 50"
              class="task-resource-badge"
            />
          </div>
        </article>
      </div>

      <!-- Kanban view (R48) -->
      <KanbanBoard
        v-else-if="viewMode === 'kanban'"
        :tasks="filteredTasks"
        :column-order="chipOrder"
        :selected-statuses="selectedStatuses"
        :resources="taskResources"
        @updated="onKanbanUpdated"
      />

      <!-- R58 列表模式: 紧凑 <table> 渲染, 镜像 GlobalBoard gb-list-table 但省
           项目/版本列 (BoardPage 多是 project/version 锁死的, 与 cards 视图
           字段不对齐; 没现成 projectNameById / versionNameById map).
           行级 click 去掉, 只点 title link / 操作按钮跳详情.
           分页同 cards 模式共用 Pagination 控件 (R12). -->
      <div v-else-if="viewMode === 'list'" class="board-list-wrap">
        <div class="board-list-table-wrap">
          <table class="board-list-table">
            <thead>
              <tr>
                <th class="board-list-th-title">{{ t('tasks.board.thTitle') }}</th>
                <th class="board-list-th-status">{{ t('tasks.board.thStatus') }}</th>
                <th class="board-list-th-type">{{ t('tasks.board.thType') }}</th>
                <th class="board-list-th-tags">{{ t('tasks.board.thTags') }}</th>
                <th class="board-list-th-time">{{ t('tasks.board.thUpdatedAt') }}</th>
                <th class="board-list-th-actions">{{ t('tasks.board.thActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="task in filteredTasks"
                :key="task.id"
                :class="{ 'board-list-row-deleted': !!task.deleted_at }"
                class="board-list-row"
              >
                <td class="board-list-td-title">
                  <router-link
                    :to="taskDetailHref(task.id)"
                    class="board-list-title-link"
                    :title="task.title"
                  >{{ task.title }}</router-link>
                  <span v-if="task.priority > 0" class="board-list-priority">P{{ task.priority }}</span>
                </td>
                <td class="board-list-td-status">
                  <span :class="['status-chip', STATUS_COLORS[task.status] || 'status-default']">
                    {{ STATUS_LABELS[task.status] || task.status }}
                  </span>
                  <QueuedReasonHint :status="task.status" :reason="task.queued_reason" />
                  <!-- R232: 运行中任务资源徽章 -->
                  <TaskResourceBadge
                    v-if="taskResources[task.id]"
                    :sample="taskResources[task.id]"
                    :warn="(taskResources[task.id]?.cpuPercent ?? 0) > 80 || (taskResources[task.id]?.memPercent ?? 0) > 50"
                    class="board-list-resource-badge"
                  />
                </td>
                <td class="board-list-td-type">
                  <span
                    v-if="task.type"
                    :class="['task-type', TYPE_CHIP[task.type] || 'type-default']"
                  >{{ TYPE_LABELS[task.type] || task.type }}</span>
                </td>
                <td class="board-list-td-tags">
                  <span
                    v-for="tag in parseTags(task.tags).slice(0, 3)"
                    :key="tag"
                    class="task-tag"
                    :title="parseTags(task.tags).join(', ')"
                  >{{ tag }}</span>
                </td>
                <td class="board-list-td-time">{{ formatUpdatedAt(task.updated_at, tick) }}</td>
                <td class="board-list-td-actions">
                  <div class="board-list-action-row">
                    <template v-if="task.deleted_at">
                      <button
                        type="button"
                        class="board-list-action-btn board-list-action-primary"
                        :title="t('tasks.board.restoreDeletedTitle')"
                        @click="(e: Event) => onRestoreClick(task.id, task.title, e)"
                      >{{ t('tasks.board.btnRestore') }}</button>
                    </template>
                    <template v-else>
                      <button
                        v-for="btn in (STATUS_BUTTONS[task.status] || [])"
                        :key="btn.key"
                        type="button"
                        :class="[
                          'board-list-action-btn',
                          btn.tone === 'primary' ? 'board-list-action-primary'
                            : btn.tone === 'danger' ? 'board-list-action-danger'
                            : 'board-list-action-normal',
                        ]"
                        :title="btn.label"
                        @click.stop="handleListAction(task, btn.key)"
                      >{{ btn.label }}</button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Chat view (R53.3: 4 模式 — cards/kanban/chat/list). R58 透传 chromeCollapsed
         强制折叠 cv-pill + cv-task-header, 让 chat 区贴 viewport 顶. -->
      <ChatView
        v-else-if="viewMode === 'chat'"
        :tasks="filteredTasks"
        :project="chatProjectMeta"
        :version="chatVersionMeta"
        :project-names="chatProjectNames"
        :version-names="chatVersionNames"
        :initial-task-id="chatInitialTaskId"
        @created="onChatTaskCreated"
      />

      <!-- Pagination + load more (R12) — cards + list + kanban 模式共用
         (参考 GlobalBoard .gb-cards-pagination / .gb-list-pagination /
         .gb-kanban-pagination 三模式都有分页; 之前 BoardPage 只有 cards/
         list, kanban 没分页 — 用户反馈「board-body 要参考 gb-body 的实
         现, gb-body 底下分页」). kanban 模式分页: 11 个状态列各列内
         滚动由 .kb-col-body overflow-y:auto 接管, 但当前页码/总条数跨
         段切换需要分页条. chat 模式仍不带分页 (chat 自带滚动).

         R59+: tasks.length === 0 时也保留分页 (force-show) — 不让 board-
         body 在无数据态塌成 Empty + 整片空白的一行. 用户反馈触发.

         R59+: 分页拿出 board-body — 用户反馈「把分页拿出board-body」.
         之前分页在 board-body 内, sticky bottom:0 在 board-body 滚动上下文,
         但 board-body 自身高度塌缩时空态分页表现不稳. 拿到 board-body
         外 (作为 board-page 直接子, 跟 board-body 平级) 后, sticky
         bottom:0 走 board-page 滚动上下文, board-page height:100% +
         overflow:hidden 兜底, 分页始终贴 viewport 底. margin-top:auto
         在 board-page flex column 里把分页推到底. -->
    </div>

    <!-- Pagination (拿出版本) — board-page 直接子, 跟 board-body 平级 -->
    <div v-if="(viewMode === 'cards' || viewMode === 'list' || viewMode === 'kanban') && !loading && !error" class="board-pagination">
      <Pagination
        :model-value="currentPage"
        :page-size="pageSize"
        :total="total"
        :page-size-options="[10, 20, 50, 100, 200]"
        :force-show="tasks.length === 0"
        @update:model-value="(p: number) => { currentPage = p; void loadPage(true); }"
        @update:page-size="onPageSizeChange"
      />
      <div v-if="viewMode === 'cards' && hasMore" class="board-loadmore">
        <button
          type="button"
          class="btn"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? t('tasks.board.loading') : t('tasks.board.loadMore', { loaded: tasks.length, total }) }}
        </button>
      </div>
    </div>

    <!-- R51 (B105): 删除确认 dialog. 镜像 master board-client.tsx:1455-1464.
         触发条件: deleteConfirm 非 null (用户点删除按钮). 确认 → confirmDeleteTask,
         取消或 ESC/backdrop → cancelDeleteTask. -->
    <ConfirmDialog
      :open="!!deleteConfirm"
      :title="t('tasks.board.deleteTaskTitle')"
      :message="deleteConfirm ? t('tasks.board.deleteConfirmMsg', { title: deleteConfirm.taskTitle }) : ''"
      :confirm-text="t('tasks.board.btnDelete')"
      :cancel-text="t('common.cancel')"
      type="danger"
      @confirm="confirmDeleteTask"
      @cancel="cancelDeleteTask"
    />

    <!-- R58 列表模式 refine dialog — GlobalBoard gb-refine-body 同款.
         ConfirmDialog 不支持 default slot, 这里用 Modal + Textarea 自建. -->
    <Modal
      :model-value="!!refineDialog"
      :title="t('tasks.board.refineTitle')"
      size="sm"
      @update:model-value="(v: boolean) => { if (!v) cancelRefine(); }"
    >
      <div class="board-refine-body">
        <i18n-t keypath="tasks.board.refineHint" tag="p" class="board-refine-hint" scope="global">
          <template #title>
            <strong>{{ refineDialog?.taskTitle }}</strong>
          </template>
        </i18n-t>
        <Textarea
          v-model="refineMessage"
          :rows="4"
          :placeholder="t('tasks.board.refinePlaceholder')"
          class-name="board-refine-textarea"
        />
      </div>
      <template #footer>
        <Button variant="secondary" @click="cancelRefine">{{ t('common.cancel') }}</Button>
        <Button variant="primary" @click="submitRefine">{{ t('tasks.board.refineSubmit') }}</Button>
      </template>
    </Modal>

    <!-- R232 Round4 (damo 10-10): 聊天式快速创建弹窗 — 预选当前项目/版本,
         可切换; 发送即 createTask + start. -->
    <TaskQuickCreate
      v-model="quickCreateOpen"
      :initial-project-id="projectId"
      :initial-version-id="versionId"
      @created="onQuickCreated"
    />

    <!-- R232 追加 v2 (damo 10-10): 常驻创建入口. Round4 改: 点击开聊天式弹窗
         (不再跳 /tasks/new); chrome 折叠态也常显 — 折叠只收 chrome, 创建是
         主动作不该跟着消失. -->
    <button
      type="button"
      class="board-fab-new"
      :title="t('tasks.board.newTask')"
      :aria-label="t('tasks.board.newTask')"
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

.board-page {
  display: flex;
  flex-direction: column;
  /* R217v7: position:relative 原为 .board-chrome-fab absolute 锚点, FAB 已删;
     保留 relative 无害, 防其他绝对定位子元素漂到 viewport. */
  position: relative;
  /* R59+: height 100% + flex:1 撑满父容器. 之前只 height:100% 在父不是
     flex column / 父 height 不确定时, board-page 撑不开. 加 flex:1 兜底
     任何 flex column 父 (VersionDetailView .board-card flex:1 + flex column,
     ProjectUnversioned .project-unversioned flex column min-height:100%,
     等等) 让 board-page 都撑满. 配合 board-body flex:1 1 0 + min-height
     兜底, 整链: parent → board-page → board-body → 分页 (flex-shrink:0 +
     sticky bottom:0) 末端固定在 viewport 底. */
  height: 100%;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
  color: var(--color-text);
}

/* R217v7: board-header 整行已删 (含 chrome-toggle / FAB / topHeaderOpen
   状态机) — 真正的 chrome 折叠走 VersionDetailView vd-chrome-toggle.
   .board-segmented 保留 (仍在模板使用). */

/* R58.5: Segmented switch (active/terminal) — 对齐 GlobalBoard .gb-view-switcher
   风格: 圆角 8px + 2px padding + 6px gap + 14×14 SVG. 旧版是 border 内嵌式
   (border-left 分隔符), 加 icon 后空间挤; 改成跟 GlobalBoard 同款独立 btn
   + active 蓝底白字, 视觉一致. */
.board-segmented {
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

.seg-btn {
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

.seg-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.seg-icon svg {
  width: 14px;
  height: 14px;
}
@media (max-width: 1023px) {
  .seg-label {
    display: none;
  }
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

/* R58.5: 视图模式切换 — 对齐 GlobalBoard .gb-view-switcher 同款.
   旧 .view-btn + .view-btn { border-left } 内嵌分隔符换成独立 btn + 圆角 6px. */
.board-view-switcher {
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

.view-btn {
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

.view-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.view-icon svg {
  width: 14px;
  height: 14px;
}
@media (max-width: 1023px) {
  .view-label {
    display: none;
  }
}

.view-btn:hover {
  background: var(--color-bg-hover, #f3f4f6);
}

.view-btn-active {
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-weight: 500;
}

.view-btn-active:hover {
  background: var(--color-primary-hover, #1d4ed8);
  color: #fff;
}

/* R217v7: .board-chrome-toggle / .board-chrome-fab CSS 已随 board-header
   行一并删除 (模板无引用). */

/* ------------------------------------------------------------------ */
/*  Filter bar                                                         */
/* ------------------------------------------------------------------ */

.board-filter {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 24px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

/* R232 追加 v2: filter-row-second 窄屏换行防挤爆. */
@media (max-width: 1023px) {
  .filter-row-second {
    flex-wrap: wrap;
  }
}

/* R232 追加 v2: 常驻创建 FAB — 右下角圆钮, 跳 /tasks/new. */
.board-fab-new {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: none;
  background: var(--color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-md);
  cursor: pointer;
  z-index: 40;
  transition: transform 0.12s, box-shadow 0.12s;
}

.board-fab-new:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg, var(--shadow-md));
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.filter-row-second {
  gap: 12px;
}

.filter-label {
  font-size: 13px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.filter-select {
  width: 180px;
  flex-shrink: 0;
}

.filter-search {
  flex: 1;
  min-width: 220px;
  max-width: 380px;
}

.filter-deleted {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

/* ------------------------------------------------------------------ */
/*  Status chips                                                       */
/* ------------------------------------------------------------------ */

.status-chip {
  padding: 4px 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, text-decoration 0.15s;
}

.status-chip-off {
  opacity: 0.4;
  text-decoration: line-through;
}

.status-chip-on:hover,
.status-chip-off:hover {
  opacity: 1;
}

/* R51 (B093): 拖拽视觉反馈. 镜像 master board-client.tsx:1201-1203.
   dragging = opacity 0.5, dragover = amber ring 2px. */
.status-chip-dragging {
  opacity: 0.5;
}

.status-chip-dragover {
  box-shadow: 0 0 0 2px var(--tw-amber-500);
}

/* R51 (B095): 同步配置齿轮按钮 + 下拉菜单. 镜像 master board-client.tsx:1212-1261
   风格, 但简化 (Tailwind 替换为 scoped CSS). */
.sync-menu-root {
  position: relative;
  margin-left: auto;
}

.sync-menu-trigger {
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

.sync-menu-trigger:hover {
  background: var(--color-bg);
  color: var(--color-text);
}

.sync-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  width: 224px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.08));
  z-index: 50;
  padding: 4px 0;
}

.sync-menu-title {
  padding: 6px 12px 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
}

.sync-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.sync-menu-item:hover {
  background: var(--color-bg);
}

.sync-menu-item-on {
  background: var(--color-bg);
}

.sync-menu-radio {
  margin: 0;
  accent-color: var(--color-primary);
}

.sync-menu-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.sync-menu-label {
  font-size: 13px;
  color: var(--color-text);
}

.sync-menu-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 状态色 — 用本文件 scoped 类, 不引 Tailwind palette. */
.status-pending    { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.status-queued     { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.status-running    { background: var(--tw-sky-100); color: var(--tw-sky-700); }
.status-paused     { background: var(--tw-yellow-100); color: var(--tw-yellow-800); }
.status-reviewing  { background: var(--tw-purple-100); color: var(--tw-purple-800); }
.status-verifying  { background: var(--tw-violet-100); color: var(--tw-violet-800); }
.status-await-user { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.status-completed  { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.status-failed     { background: var(--tw-red-100); color: var(--tw-red-800); }
.status-rejected   { background: var(--tw-orange-50); color: var(--tw-orange-700); }
.status-cancelled  { background: var(--tw-gray-100); color: var(--tw-gray-500); }
.status-default    { background: var(--tw-gray-100); color: var(--tw-gray-700); }

/* ------------------------------------------------------------------ */
/*  Body                                                               */
/* ------------------------------------------------------------------ */

.board-body {
  /* R58: flex:1 + min-height 让 board-body 在 board-page (height:100%,
     overflow:hidden) 里能正确收缩 + 撑满. overflow: auto (横竖都接管) 让
     列表 table 的 thead sticky 上下文落在 board-body (overflow-y: auto
     才能 escape 到外层), 同时支持 table 横向超出时的横向滚动. 4 个 view
     mode (cards / list / kanban / chat) 共用同一个滚动容器.

     R58.5+: padding 改 16 24 0 (跟 GlobalBoard .gb-body 同款) — 之前 0 24
     是为了修 list thead sticky 间隙 (board-body padding-top 0 → sticky thead
     贴物理顶). 现在换思路: board-body padding-top:16 + list-wrap 自己
     padding-top:0 让 thead sticky top:0 仍贴物理顶 (sticky 上下文是
     board-body content top, padding box 是 padding-top:0). 用户反馈
     「状态任务列表容器高度, 看板模式, 内容高度, 分页都要参考 gb-body」:
     gb-body padding: 16 24 0, BoardPage 对齐.

     R58.5+: 加 display:flex + flex-direction:column (跟 GlobalBoard .gb-body
     同款) — 这是 .board-pagination sticky bottom:0 + margin 推底生效的前提.

     R59+: 拿掉 flex 后塌到 16px 的根因排查 — 之前 flex:1 1 0 + min-height:0
     让 board-body 在 wrapper + :deep(.empty-state) flex:1 循环依赖下被
     压到 padding-top 的 16px. 改 min-height:400 (拍板默认, 不够再说) 让
     board-body 至少有 400px 高度, 循环依赖塌也塌不到这里, .empty-action
     margin-top:24 (固定值, 不靠 auto) 让 "+新建任务" 按钮在 desc 下方
     24px, 整体走自然高度铺, 不再依赖 auto / 循环 sizing. */
  flex: 1 1 0;
  min-height: 400px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: auto;
  /* R59+: padding 改 16 24 16 — 用户反馈「board-body padding-bottom +16」.
     之前 16 24 0 (无 padding-bottom), 现在加 padding-bottom 16 让分页
     (margin-top 撤掉后) 跟 board-body content 底之间有 16px 间距. 视觉
     间距从分页 margin-top:16 (之前) 转到 board-body padding-bottom:16
     (现在), 实际间距不变, 但跟 sticky bottom:0 + 内容滚动更好搭配
     (board-body 自己管内部 padding, 不靠分页 margin 推). */
  padding: 16px 24px 16px;
}

/* R58: pagination sticky 底部, 用户滚动表格/卡片/看板/聊天时, 分页始终可
   见. 背景 elevated + 上边框 = 视觉分隔.

   R58.5: 跟 GlobalBoard 5 个分页容器同款 — margin-left/right -24px 抵消
   .board-body padding (24) 让背景延伸 viewport 边; padding-left/right 40px
   让内容距 viewport 边 16px (24-(-24)=0 后再 padding 40 → 距左边 40, 距
   viewport 边 40-padding 抵消 margin = 距 16px). margin-top:auto 是关键修复:
   之前只有 8px 顶 margin, 内容少时 sticky 自然位置靠近 viewport 顶,
   上滑分页跟着滑走. margin-top:auto 在 board-body flex column 里吸收剩余
   空间, 把 sticky 推到 board-body 物理底. */
.board-pagination {
  position: sticky;
  bottom: 0;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* padding 0 40 — 上下 0 让分页条贴 board-page 物理底 (sticky bottom:0
     自然贴 viewport 底), 左右 40 让分页文字距 viewport 边 16px. 用户
     反馈不要 padding. */
  padding: 0 40px;
  /* R59+: margin 从 16px -24px 0 改 0 0 0 — 用户反馈「分页 margin-top
     去掉」. 之前 margin-top 16 给分页上方 16px 间距, 撤掉后分页紧贴
     board-body content 底. 视觉间距交给 board-body padding-bottom:16
     接管 (board-body 现在 padding 16 24 16 — top 16, h 24, b 16). */
  margin: 0;
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
  z-index: 1;
}

.board-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 64px 16px;
  color: var(--color-text-muted);
}

.board-loading-text {
  margin: 0;
  font-size: 14px;
}

/* ------------------------------------------------------------------ */
/*  Empty CTA                                                          */
/* ------------------------------------------------------------------ */

/* R59+: board-body 不再 flex:1 1 0 (用户反馈拿掉 flex 后塌成 16px 的
   根因消除), .board-empty-wrap 也不 flex:1 1 0 — 父 (board-body) 是
   自然高度, wrapper 也是自然高度, Empty 在 wrapper 里自然铺. Empty 内
   部 svg + title + desc + .empty-action 自然堆, .empty-action 用
   :deep() 改 margin-top:auto 让 "+新建任务" 按钮贴 Empty (= wrapper)
   底部, 紧贴下方 .board-pagination 上沿 (分页 margin-top:8px 留呼吸).

   R59+: 空态内容空间加大 — 用户反馈「不是文字大, 空间大」. 不动字号
   (Empty 默认 16/13 已可读), 加 :deep() 拉 padding/illust margin/title
   margin, 让 illustration + title + desc 之间有更多呼吸, 整体视觉更
   舒展. 不动 Empty.vue 全局 — :deep() 只命中 board-empty-wrap 内的
   Empty 实例, 不影响 Requirements/Templates 等其他视图. */
.board-empty-wrap {
  display: flex;
  flex-direction: column;
}

.board-empty-wrap :deep(.empty-state) {
  padding: 72px 24px;
}

.board-empty-wrap :deep(.empty-illust) {
  margin-bottom: 40px;
}

.board-empty-wrap :deep(.empty-title) {
  margin-bottom: 16px;
}

.board-empty-wrap :deep(.empty-action) {
  /* R59+: 用户反馈「+新建任务 margin-top」+「下方加margin」. margin-top
     24 让按钮在 desc 下方固定 24px, margin-bottom 12 让按钮跟下方
     .board-pagination 之间有 12px 视觉呼吸 (分页 margin-top 16 配合出
     28px 总间距). 不依赖 auto 推底, 走自然高度铺. */
  margin: 24px 0 12px;
}

.empty-cta {
  text-decoration: none;
}

.empty-cta:hover {
  text-decoration: none;
}

/* ------------------------------------------------------------------ */
/*  Task cards grid                                                    */
/* ------------------------------------------------------------------ */

.board-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  /* R58.5+: padding-top 0 — board-body 自带 padding-top 16px (跟 GlobalBoard
     .gb-body 同款), 这里不需要再给 16, 否则叠加成 32. 跟 .board-list-wrap
     同步处理. */
  padding-top: 0;
}

.task-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  position: relative; /* R51 (B105) — 锚点 for .task-card-delete 绝对定位 */
  transition: box-shadow 0.15s, border-color 0.15s;
}

.task-card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
}

.task-card-deleted {
  opacity: 0.6;
  border-color: var(--tw-red-200);
}

.task-card-deleted:hover {
  opacity: 1;
}

/* R51 (B105): 卡片右上角删除按钮 — 镜像 master board-client.tsx:905-910 样式.
   默认隐形, hover 卡片时浮现, 避免抢眼. */
.task-card-delete {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  font-size: 14px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.task-card:hover .task-card-delete {
  opacity: 1;
}

.task-card-delete:hover {
  background: var(--tw-red-100);
  color: var(--tw-red-700);
}

/* R55.4 (B100): 卡片右上角恢复按钮 — 与删除按钮同位置,
   仅已删除任务显示. 镜像 master board-client.tsx:897 ↩. */
.task-card-restore {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  font-size: 14px;
  cursor: pointer;
  opacity: 1;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.task-card-restore:hover {
  background: var(--tw-green-100);
  color: var(--tw-green-800);
}

.task-card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.status-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}

.task-priority {
  font-size: 11px;
  color: var(--tw-orange-600);
  font-weight: 500;
}

.task-schedule {
  font-size: 11px;
  color: var(--color-text-muted);
}

.task-type {
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: var(--radius);
  font-size: 11px;
  font-weight: 500;
}

.type-design  { color: var(--tw-pink-700); background: var(--tw-pink-100); }
.type-dev     { color: var(--tw-blue-700); background: var(--tw-blue-100); }
.type-test    { color: var(--tw-violet-700); background: var(--tw-violet-100); }
.type-deploy  { color: var(--tw-emerald-700); background: var(--tw-emerald-100); }
.type-default { color: var(--color-text-muted); background: var(--color-bg); }

.task-deleted-badge {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--tw-red-100);
  color: var(--tw-red-700);
  font-size: 11px;
  font-weight: 500;
}

.task-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--color-text);
}

.task-title-strike {
  text-decoration: line-through;
}

.task-title-link {
  color: inherit;
  text-decoration: none;
}

.task-title-link:hover {
  color: var(--color-primary);
}

.task-prompt {
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

.task-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.task-tag {
  padding: 1px 7px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 11px;
  color: var(--color-text-muted);
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: auto;
}

.task-model {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-cost {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  flex-shrink: 0;
}

.task-time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/*  Pagination + load more                                            */
/* ------------------------------------------------------------------ */

/* .board-pagination 在 R58 提到上方 sticky 样式 (height 控制段). 旧版
   margin-top:20px 删掉, sticky 容器自带 padding. */

.board-loadmore {
  display: flex;
  justify-content: center;
}

/* ------------------------------------------------------------------ */
/*  R58 list view — 紧凑 <table> 渲染. 视觉对齐 GlobalBoard gb-list-table. */
/* ------------------------------------------------------------------ */

.board-list-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* R58.5+: padding-top 0 — board-body 自带 padding-top 16px (跟 GlobalBoard
     .gb-body 同款), 这里不需要再给 16. thead sticky top:0 贴 board-body
     content 顶 (padding-top:16 之下), sticky 时 thead 与 board-body 物理顶
     之间有 16px 视觉呼吸 (= 跟 GlobalBoard gb-list-table 同款行为: gb-body
     padding-top 16 + wrap padding-top 0, thead sticky 同样贴 content top).
     wrap 自己 padding-top 0 让列表第一行直接贴 thead 下沿. */
  padding-top: 0;
}

.board-list-table-wrap {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  /* R58: 不再设 overflow — 让 board-body 的 overflow: auto 接管横竖滚动.
     table-wrap 自身不再是 scroll container, thead sticky 上下文升到
     board-body, top:0 粘到 board-body 顶部. 列多导致横向溢出时, 用户
     在 board-body 上横滑 (不再需要嵌套双滚动条). */
}

.board-list-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.board-list-table thead {
  background: var(--color-bg-elevated);
  position: sticky;
  top: 0;
  z-index: 1;
}
.board-list-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
  /* R58: 让 th 背景也填实, 否则 thead sticky 时 td 上滚透过 th 之间的
     缝隙漏出底下的行内容. */
  background: var(--color-bg-elevated);
}
.board-list-th-title { width: 30%; }
.board-list-th-status { width: 12%; }
.board-list-th-type { width: 10%; }
.board-list-th-tags { width: 18%; }
.board-list-th-time { width: 14%; }
.board-list-th-actions { width: 10%; min-width: 80px; }

.board-list-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  vertical-align: middle;
}
.board-list-table tbody tr {
  cursor: pointer;
}
.board-list-table tbody tr:hover {
  background: var(--color-bg);
}
.board-list-table tbody tr:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
.board-list-row-deleted {
  opacity: 0.6;
}

.board-list-td-title {
  max-width: 360px;
}
/* R232: 资源徽章落位 — cards 视图推到 meta 行最右; list 视图跟状态 chip 并排留缝. */
.task-resource-badge {
  margin-left: auto;
}
.board-list-td-status .task-resource-badge {
  margin-left: 6px;
}
.board-list-title-link {
  color: var(--color-text);
  text-decoration: none;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.board-list-title-link:hover {
  color: var(--color-primary);
}
.board-list-priority {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--tw-amber-100);
  color: var(--tw-amber-800);
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
}

.board-list-td-tags {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}
.board-list-td-time {
  color: var(--color-text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.board-list-td-actions {
  text-align: right;
}
.board-list-action-row {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
}
.board-list-action-btn {
  display: inline-block;
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 11px;
  color: var(--color-text);
  text-decoration: none;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.board-list-action-primary {
  color: var(--color-primary);
  border-color: var(--color-primary);
}
.board-list-action-primary:hover {
  background: var(--color-primary);
  color: #fff;
}
.board-list-action-danger {
  color: var(--tw-red-600);
  border-color: var(--tw-red-300);
}
.board-list-action-danger:hover {
  background: var(--tw-red-600-solid);
  color: #fff;
  border-color: var(--tw-red-600);
}
.board-list-action-normal:hover {
  background: var(--color-bg);
  color: var(--color-primary);
}

/* ------------------------------------------------------------------ */
/*  R58 refine dialog — GlobalBoard gb-refine-body 同款                */
/* ------------------------------------------------------------------ */

.board-refine-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.board-refine-hint {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.5;
}
</style>