<script setup lang="ts">
/* 功能: 任务详情视图 — 完整镜像 Next.js /tasks/[id] (R22 范围). 由以下区段组合:
   - TaskHeader: breadcrumb + 标题编辑 + awaiting markers + 收藏 + 元信息 + 超时编辑
   - LifecycleActions: 11 种状态下的操作按钮 (启动/暂停/取消/审核/重派等)
   - text cards: prompt/result/error/description
   - TaskTranscript: 历史 + SSE 实时流
   - TaskPendingApprovals: 工具审批 (由 SSE 注入)
   - TaskPendingDialogs: 用户提问 (由 SSE 注入)
   - TaskMessageInput: 发送消息 + 文件上传 + auto-approve + 高级设置
   - TaskEvaluationBar: 完成后的评分 (1-5 + note + 历史)
   - TaskDetailsPanel: 父任务 / 派发上游 / 依赖 / 需求点关联
   - ForkBoundary: 在 transcript 中间插入 fork 分隔线 (按 forked_at 时间戳)

   关注点:
   - 状态/上下文/成本/超时剩余由 SSE 实时推送刷新, 不再轮询.
   - pendingApprovals / pendingDialogs 由 SSE 事件累加; emit resolved 后清理.
   - 列表 5 项不渲染容器 (与 master tdc.tsx 一致).
   - 与 R19 兼容: status 11 个枚举 + 同款 STATUS_LABELS/STATUS_COLORS. */
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, patch, HttpError, isHttpError } from '@/api/http';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import Loading from '@/components/Loading.vue';
import TaskHeader from '@/components/TaskHeader.vue';
import TaskMetaRow from '@/components/TaskMetaRow.vue';
import LifecycleActions from '@/components/LifecycleActions.vue';
import { listPinLists, addPinListItem } from '@/api/pin-lists';
import ResumeModal from '@/components/ResumeModal.vue';
import TaskPendingApprovals from '@/components/TaskPendingApprovals.vue';
import TaskPendingDialogs from '@/components/TaskPendingDialogs.vue';
import TaskMessageInput from '@/components/TaskMessageInput.vue';
import TaskEvaluationBar from '@/components/TaskEvaluationBar.vue';
import TaskStatusBar from '@/components/TaskStatusBar.vue';
import TaskResourceBadge from '@/components/TaskResourceBadge.vue';
import RightDock from '@/components/RightDock.vue';
import ForkModal from '@/components/ForkModal.vue';
import { restoreTask } from '@/api/tasks';
import { createTaskStreamSubscription } from '@/composables/useTaskStream';
import {
  taskResources,
  acquireTaskResourcesPolling,
  releaseTaskResourcesPolling,
} from '@/composables/useTaskResources';
import { useToast } from '@/composables/useToast';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { useTagsStore } from '@/stores/tags';
import { safeRouteParam } from '@/lib/safe-route-param';
import { formatProjectItemTitle } from '@/lib/format-tab-title';

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

interface DepTaskRef {
  id: string;
  title: string;
  status: string;
}

interface RequirementRef {
  id: string;
  title: string;
  status: string;
}

interface TaskDetail {
  idea_id?: string | null;
  node_id?: string | null;
  work_class?: string | null;
  id: string;
  title: string;
  description: string | null;
  prompt: string;
  result: string | null;
  error: string | null;
  status: TaskStatus;
  priority: number;
  type: string | null;
  model: string | null;
  resolved_model: string | null;
  effort: string | null;
  max_turns: number | null;
  tags: string | null;
  project_id: string | null;
  version_id: string | null;
  owner_id: string | null;
  cost_usd: number | null;
  /** R239: 任务模型成本系数 (GET /api/tasks/[id] 现算, 基准未设/没配价 → 缺省) */
  cost_coefficient?: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  deleted_at: string | null;
  depends_on_ids?: string[];
  dependent_task_ids?: string[];
  dispatched_task_ids?: string[];
  dispatched_by_task_id?: string | null;
  session_id?: string | null;
  parent_session_id?: string | null;
  forked_from_session_id?: string | null;
  cwd?: string | null;
  /** R242: DB 全列返回 (getTaskById SELECT *), 前端类型此前漏声明. */
  allowed_tools?: string | null;
  auto_approve?: number;
  awaiting_owner_review?: number;
  awaiting_markers?: string | null;
  awaiting_reason?: string | null;
  /** v531 续: 排队原因 (getTaskById SELECT * 全列自动带), 详情页头部显示. */
  queued_reason?: string | null;
  requirement_id?: string | null;
  context_tokens?: number | null;
  context_max?: number | null;
  schedule_id?: string | null;
  preflight_result?: string | null;
  metadata?: string | null;
  base_commit?: string | null;
  head_commit?: string | null;
  /** 收尾预热产物直读 (R200 预热 + 详情接口直带) — 信息面板「总结」模块数据源. */
  card_summary?: { what: string; why: string; at?: string } | null;
  result_layers?: { brief: string; details: string[]; next?: string; result_len?: number } | null;
  queued_order?: number | null;
  requirement_status?: string | null;
  latest_checkpoint_status?: string | null;
  /* v517 (R196) — task 完成度自报字段 */
  progress?: number | null;
  progress_source?: string | null;
  progress_note?: string | null;
  progress_updated_at?: string | null;
  /* R22 新增 — 服务端 in 详情响应的字段 */
  depends_on_tasks?: DepTaskRef[];
  dependent_tasks?: DepTaskRef[];
  parent_task?: DepTaskRef | null;
  dispatcher_task?: DepTaskRef | null;
  dispatched_tasks?: DepTaskRef[];
  requirement_link?: RequirementRef | null;
  requirement_siblings?: DepTaskRef[];
  forked_at?: string | null;
  project_name?: string | null;
  version_name?: string | null;
  is_favorite?: boolean;
  timeout_minutes?: number | null;
}

interface PendingApproval {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface UserDialogQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multi_select: boolean;
}

interface PendingDialog {
  requestId: string;
  dialogKind: string;
  questions: UserDialogQuestion[];
  stale?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Route + base state                                                 */
/* ------------------------------------------------------------------ */

const route = useRoute();
const router = useRouter();
// R198 fix: keep-alive 复用本组件时切到非 task 路由, route.params.taskId 变
// undefined — String(undefined)="undefined" 曾被拼进 /api/tasks/${taskId}
// 造成高频 404. 缺参回空串 (falsy), watch/loadTask/startStream 各自 guard 跳过.
const taskId = computed<string>(() => safeRouteParam(route.params.taskId));
const tags = useTagsStore();

/** 任务详情 tab 标题: 「项目(≤8)-任务(≤12)」, 走 R59 统一截断规则. 后端
 *  /api/tasks/:id 已带 project_name, 不必再发一次项目请求. 未挂项目走
 *  「未分类」兜底, 任务标题空走「未命名」. */

const task = ref<TaskDetail | null>(null);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);
const retrying = ref<boolean>(false);

/** 任务标题或项目名变化时同步到 tab. applyTitle 内部尊重 customTitle
 *  (用户手动重命名优先, 自动标题不会覆盖). 必须在 task 声明后注册 —
 *  watch 的 getter 在 setup 阶段就会被同步调用一次建立依赖追踪, 提前
 *  引用 task 会撞 TDZ. */
watch(
  () =>
    task.value
      ? { title: task.value.title, project: task.value.project_name }
      : null,
  (next) => {
    if (!next) return;
    tags.applyTitle(
      route.path,
      formatProjectItemTitle(next.project, next.title),
    );
  },
);

// R74 fix: keep-alive 重新激活时再写一次标题. 结构修复 (applyTitle 设
// customTitle=true) 已经挡住切回时 meta 覆盖; 此处只兜一种边界 — 任务
// 首次加载未完成就切走, 切回时 task.value 已就绪但 watch 的 source 引用
// 没变 (依赖未触发), 标题没升级. 幂等, 重复写同一个标题无副作用.
// R228: keep-alive 切走必须关 SSE —— EventSource 是 HTTP/1.1 长连接, 内网
// 直连 IP:13000 (非 HTTP/2) 每域只有 6 个并发名额, 后台 tab 的 SSE 不关会
// 把名额吃光, 之后所有 fetch (含发消息 POST) 在浏览器排队无限 pending
// (2026-10-09 实证: tasks/page / health / message 全部转圈卡死).
let taskStreamWasDeactivated = false;
onDeactivated(() => {
  taskStreamWasDeactivated = true;
  stopStream();
});
onActivated(() => {
  if (!task.value) return;
  tags.applyTitle(
    route.path,
    formatProjectItemTitle(task.value.project_name, task.value.title),
  );
  // R228: 后台期间 SSE 已被 onDeactivated 关闭, 切回重开 (首次 mount 触发的
  // onActivated 跳过 —— loadTask→startStream 已覆盖).
  if (taskStreamWasDeactivated) {
    taskStreamWasDeactivated = false;
    startStream();
  }
});

const liveCost = ref<number | null>(null);
const liveContext = ref<{ tokens: number; max: number } | null>(null);
const liveStatus = ref<TaskStatus | null>(null);
const pendingApprovals = ref<PendingApproval[]>([]);
const pendingDialogs = ref<PendingDialog[]>([]);

/* ------------------------------------------------------------------ */
/*  Timeout countdown                                                  */
/* ------------------------------------------------------------------ */

const timeoutRemainingMs = ref<number | null>(null);
const timeoutTotalMs = ref<number | null>(null);
let timeoutTimer: ReturnType<typeof setInterval> | null = null;

function startTimeoutTicker(): void {
  if (timeoutTimer) clearInterval(timeoutTimer);
  timeoutTimer = setInterval(() => {
    if (!task.value?.started_at || !task.value.timeout_minutes) {
      timeoutRemainingMs.value = null;
      timeoutTotalMs.value = null;
      return;
    }
    const startedMs = new Date(task.value.started_at).getTime();
    const totalMs = task.value.timeout_minutes * 60_000;
    const elapsed = Date.now() - startedMs;
    timeoutTotalMs.value = totalMs;
    timeoutRemainingMs.value = Math.max(0, totalMs - elapsed);
  }, 1000);
}

function stopTimeoutTicker(): void {
  if (timeoutTimer) {
    clearInterval(timeoutTimer);
    timeoutTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/*  SSE stream                                                         */
/* ------------------------------------------------------------------ */

/* R234 后续项: 任务流共享订阅 —— 本页头部的流处理与内嵌 TaskTranscript 原先
   各开一条同 url 长连接 (双倍占 HTTP/1.1 每域 6 个并发名额), 收口到共享 hub
   后同页一条. R256: 无限重连 + 断线恢复 (onReconnect) → 静默重拉 task 校准
   状态 —— 状态只走 SSE 推送, 断线窗口内漏掉的 status_change 不补 = 前端状态
   永久 stale ("跑完了还显示运行中" 实证根因, 后端 DB 其实早已翻状态). */
const taskStreamSub = createTaskStreamSubscription(
  () => (taskId.value ? `/api/tasks/${taskId.value}/stream` : ''),
  (ev) => handleStreamEvent(ev),
  () => scheduleSilentRefresh(),
);

function startStream(): void {
  taskStreamSub.attach();
}

function stopStream(): void {
  taskStreamSub.detach();
}

function handleStreamEvent(ev: any): void {
  switch (ev?.type) {
    case 'status_change':
      // R56-C2: 后端 status_change 事件字段是 `to`(不是 `status`),
      // 老 SPA 读 ev.status = 永远 undefined → liveStatus 卡在初始值
      // (=task.value.status, 比如 reviewing=待审核), 不会随状态变化更新.
      // master 端 task-detail-client.tsx:1253 走的是 event.to. 对齐.
      if (typeof ev.to === 'string') liveStatus.value = ev.to as TaskStatus;
      break;
    case 'cost':
      if (typeof ev.cost_usd === 'number') liveCost.value = ev.cost_usd;
      break;
    case 'context':
    case 'context_update':
      if (typeof ev.context_tokens === 'number') {
        liveContext.value = {
          tokens: ev.context_tokens,
          max: ev.context_max ?? liveContext.value?.max ?? 0,
        };
      }
      break;
    case 'tool_approval_request':
      pendingApprovals.value = [
        ...pendingApprovals.value,
        {
          requestId: ev.request_id ?? ev.toolUseId ?? `req-${Date.now()}`,
          toolName: ev.tool_name ?? ev.toolName ?? 'unknown',
          toolInput: ev.tool_input ?? ev.toolInput ?? {},
        },
      ];
      break;
    case 'tool_approval_response':
      pendingApprovals.value = pendingApprovals.value.filter(
        (a) => a.requestId !== ev.request_id,
      );
      break;
    case 'user_dialog_request': {
      // 去重: SSE 断线重连 (EventSource 自动重 GET stream) 会重新回放全部
      // history + 实时流, 同一 request_id 不能重复入列 (master tdc.tsx:1372 同款).
      const reqId = ev.request_id ?? `dlg-${Date.now()}`;
      if (!pendingDialogs.value.some((d) => d.requestId === reqId)) {
        pendingDialogs.value = [
          ...pendingDialogs.value,
          {
            requestId: reqId,
            dialogKind: ev.dialog_kind ?? 'question',
            questions: ev.questions ?? [],
            stale: ev.stale === true,
          },
        ];
      }
      break;
    }
    case 'user_dialog_response':
    case 'user_dialog_timeout':
      pendingDialogs.value = pendingDialogs.value.filter(
        (d) => d.requestId !== ev.request_id,
      );
      break;
    case 'history': {
      /* history 回放: 后端 stream 连接时把 DB 事件以 {type:'history',
         event_type, data(JSON 字符串)} 批量重发 (stream/route.ts:62). master
         tdc.tsx:1456 据此在刷新/后开页面后重建未应答的提问弹窗 (标 stale —
         服务端重启后 SDK promise 可能已丢, 提交可能无效). SPA 之前缺这段 →
         刷新后 pendingDialogs 永远为空, agent 提问卡死无 UI. */
      if (!ev.data) break;
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        break;
      }
      if (ev.event_type === 'user_dialog_request' && data.questions) {
        const reqId = data.request_id || `replay-${data.tool_use_id || Math.random()}`;
        if (!pendingDialogs.value.some((d) => d.requestId === reqId)) {
          pendingDialogs.value = [
            ...pendingDialogs.value,
            {
              requestId: reqId,
              dialogKind: data.dialog_kind ?? 'question',
              questions: data.questions,
              stale: true,
            },
          ];
        }
      }
      if (
        (ev.event_type === 'user_dialog_response' || ev.event_type === 'user_dialog_timeout') &&
        data.request_id
      ) {
        pendingDialogs.value = pendingDialogs.value.filter(
          (d) => d.requestId !== data.request_id,
        );
      }
      /* 历史 request 后任务已进终态 (含 reviewing) → 清残留, 不再弹旧问题
         (master tdc.tsx:1557 同款). */
      if (
        ev.event_type === 'status_change' &&
        ['completed', 'failed', 'cancelled', 'reviewing'].includes(data.to)
      ) {
        pendingDialogs.value = [];
      }
      /* R256: history 回放里最后一条 status_change 的 `to` 就是当前真状态 —
         断线重连 / 后开页面时用它校准 liveStatus. 之前只消费 user_dialog_*,
         状态只认实时 status_change 事件 → 断线窗口内翻的状态前端永远看不到
         ("跑完了还显示运行中" 实证根因). from===to 的合成 anchor (running→
         running, 只带 timeout_ms) 不覆盖 liveStatus 之外还有初值兜底, 无害. */
      if (ev.event_type === 'status_change' && typeof data.to === 'string') {
        liveStatus.value = data.to as TaskStatus;
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

const status = computed<TaskStatus>(() => liveStatus.value ?? task.value?.status ?? 'pending');
const cost = computed<number | null>(() => liveCost.value ?? task.value?.cost_usd ?? null);
const contextTokens = computed<number | null>(
  () => liveContext.value?.tokens ?? task.value?.context_tokens ?? null,
);
const contextMax = computed<number | null>(
  () => liveContext.value?.max ?? task.value?.context_max ?? null,
);

const tagsList = computed<string[]>(() => {
  if (!task.value?.tags) return [];
  try {
    const arr = JSON.parse(task.value.tags);
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
});

const isDeleted = computed<boolean>(() => !!task.value?.deleted_at);

/* ------------------------------------------------------------------ */
/*  R52.9 (B251): ResumeModal 触发态. LifecycleActions 'paused' 状态点
     ▶ 恢复执行 时 emit('open-resume'), 父级监听后弹窗.               */
/* ------------------------------------------------------------------ */

const resumeOpen = ref<boolean>(false);

function onOpenResume(): void {
  resumeOpen.value = true;
}

function onResumeClose(): void {
  resumeOpen.value = false;
}

/** Resume 成功后 SSE 会推 status_change 事件自动刷状态; 此处主要
    用来 optimistic UI 立即同步. */
function onResumed(newStatus: string): void {
  liveStatus.value = newStatus as TaskStatus;
  if (task.value) task.value.status = newStatus as TaskStatus;
  resumeOpen.value = false;
}

/* ------------------------------------------------------------------ */
/*  B262: 跟踪 input form 像素高度, 传给 TaskPendingDialogs 做避让       */
/* ------------------------------------------------------------------ */

const inputFormHeight = ref<number>(0);

function onInputFormHeight(h: number): void {
  inputFormHeight.value = h;
}

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

/* R56-B2.2: text-cards (Prompt/Result/Error/Description) 删除 — master tdc.tsx
   主列无此 block. master 的做法:
   - prompt 由 use-task-stream 注成首条 user 消息进 transcript (line 994)
   - result 走 transcript 空态 fallback (line 2571-2591, messages.length===0 时)
   SPA 旧版把 4 张 card 摆在 transcript 上方 → 把消息流挤到屏幕外,
   与 master 1:1 偏离. 状态相关字段 (status / model / context) 走 TaskStatusBar. */

/* ------------------------------------------------------------------ */
/*  Data fetch                                                         */
/* ------------------------------------------------------------------ */

async function loadTask(): Promise<void> {
  if (!taskId.value) return; // R198 fix: 无有效 taskId 不发请求
  loading.value = true;
  error.value = null;
  try {
    const data = await get<TaskDetail>(`/api/tasks/${taskId.value}`);
    task.value = data;
    liveStatus.value = data.status;
    liveCost.value = data.cost_usd;
    liveContext.value =
      data.context_tokens != null
        ? { tokens: data.context_tokens, max: data.context_max ?? 0 }
        : null;
    startTimeoutTicker();
    startStream();
  } catch (e: unknown) {
    if (e instanceof HttpError) {
      error.value = e.message || `请求失败 (HTTP ${e.status})`;
    } else if (e instanceof Error) {
      error.value = `网络异常: ${e.message}`;
    } else {
      error.value = '加载失败';
    }
    task.value = null;
  } finally {
    loading.value = false;
    retrying.value = false;
  }
}

function retry(): void {
  retrying.value = true;
  void loadTask();
}

/* ------------------------------------------------------------------ */
/*  Lifecycle hooks                                                    */
/* ------------------------------------------------------------------ */

// R75 fix: 任务 A tab 切到任务 B tab 时 keep-alive 复用同一组件实例,
// onMounted 不重跑, 必须显式 watch taskId 触发 loadTask. immediate=true
// 替代 onMounted 首次加载 (避免 mount + watch 重复拉同一 taskId 的浪费).
// task.value=null 让 <Loading/> 立刻接管, 避免 HTTP 完成前的几百ms 内
// view 仍显示旧任务数据 (切 task → 看到旧 A → 突然变 B 的错觉).
watch(taskId, () => {
  if (!taskId.value) return; // R198 fix: 切走时 param 为空, 不发请求
  task.value = null;
  void loadTask();
}, { immediate: true });

onUnmounted(() => {
  stopTimeoutTicker();
  stopStream();
  if (silentRefreshTimer) clearTimeout(silentRefreshTimer);
  releaseResourcePolling();
  releaseFallbackPolling();
});

/* R232: 本任务资源徽章 — 详情页挂进全局轮询单例 (keep-alive 切走时释放,
   切回重挂, 幂等 flag 防 onActivated 首挂双触发泄漏 refCount). */
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
ensureResourcePolling();
onDeactivated(() => releaseResourcePolling());
onActivated(() => ensureResourcePolling());
const taskResourceSample = computed(
  () => (taskId.value ? taskResources.value[taskId.value] ?? null : null),
);
const taskResourceWarn = computed(
  () =>
    (taskResourceSample.value?.cpuPercent ?? 0) > 80 ||
    (taskResourceSample.value?.memPercent ?? 0) > 50,
);

/* ------------------------------------------------------------------ */
/*  Event handlers                                                     */
/* ------------------------------------------------------------------ */

function onStatusChanged(newStatus: string): void {
  /* R230: LifecycleActions 删除成功 emit 'deleted' 哨兵 (非 TaskStatus) —
     任务已软删, 停在本页只会显示僵尸详情 → 退回上一页, 无历史则回首页. */
  if (newStatus === 'deleted') {
    if (window.history.length > 1) router.back();
    else void router.replace('/');
    return;
  }
  liveStatus.value = newStatus as TaskStatus;
  if (task.value) task.value.status = newStatus as TaskStatus;
  // 收尾预热产物 (干啥/有啥用 + 分层总结) 由后端在 reviewing 落库后 fire-and-forget
  // 生成 (active-session warmResultLayersForTask / warmCardSummaryForTask), LLM 跑完
  // 才写进 metadata. 用户停在页面上时 task payload 里还没有 → 延迟一次静默刷新把
  // 总结拉进来. 不发 SSE 新事件 / 不轮询 (简洁优先, 真有盯着等的强需求再升级).
  if (newStatus === 'reviewing' || newStatus === 'completed') scheduleSilentRefresh();
}

/** 25s 后单次静默刷新 task (不转 loading 不动 SSE 流); 期间切走任务/卸载则放弃. */
const SUMMARY_WARM_LATENCY_MS = 25_000;
let silentRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSilentRefresh(): void {
  if (silentRefreshTimer) clearTimeout(silentRefreshTimer);
  const targetTaskId = taskId.value;
  silentRefreshTimer = setTimeout(() => {
    silentRefreshTimer = null;
    if (!targetTaskId || taskId.value !== targetTaskId) return; // 已切走
    void (async () => {
      try {
        const data = await get<TaskDetail>(`/api/tasks/${targetTaskId}`);
        if (taskId.value !== targetTaskId) return; // 竞态: 响应回来时已切走
        task.value = data;
        liveStatus.value = data.status;
      } catch {
        /* 静默 — 下次进页面/刷新自然拿到 */
      }
    })();
  }, SUMMARY_WARM_LATENCY_MS);
}

/* R256: 非终态兜底轮询 — SSE 是唯一状态通道的单一故障点 (断线窗口内漏掉的
   status_change 不补 = 状态卡断线瞬间的值). onReconnect 校准覆盖「断线后恢复」,
   这里覆盖「SSE 已死但页面还开着」的所有残余场景 (401 关停 / 即将断未断 /
   重连进行中). 终态停表 — 终态不会再变, 轮询纯浪费. 单次 fetch 极轻
   (~2KB, 详情页本来就要拉的数据), 45s 一次对 SQLite 无感. */
const FALLBACK_POLL_MS = 45_000;
let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;

function ensureFallbackPolling(): void {
  if (fallbackPollTimer) return;
  fallbackPollTimer = setInterval(() => {
    const targetTaskId = taskId.value;
    if (!targetTaskId) return;
    const s = liveStatus.value ?? task.value?.status;
    if (s && ['completed', 'failed', 'cancelled', 'rejected'].includes(s)) return; // 终态停表
    void (async () => {
      try {
        const data = await get<TaskDetail>(`/api/tasks/${targetTaskId}`);
        if (taskId.value !== targetTaskId) return; // 竞态: 已切走
        task.value = data;
        liveStatus.value = data.status;
        liveCost.value = data.cost_usd;
        liveContext.value =
          data.context_tokens != null
            ? { tokens: data.context_tokens, max: data.context_max ?? 0 }
            : null;
      } catch {
        /* 静默 — 下一拍自动重试 */
      }
    })();
  }, FALLBACK_POLL_MS);
}

function releaseFallbackPolling(): void {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

/* R256: 兜底轮询生命周期 — keep-alive 切走释放, 切回重挂 (后台 tab 不占
   请求配额, 切回时 onReconnect/SSE 已覆盖实时性, 轮询只是校准兜底).
   ⚠️ 必须放在函数声明之后: setup 顶层直接调用, 放声明前 = TDZ 崩溃
   (Cannot access 'le' before initialization, 2026-11-03 部署实证). */
ensureFallbackPolling();
onDeactivated(() => releaseFallbackPolling());
onActivated(() => ensureFallbackPolling());

function onTitleUpdated(title: string): void {
  if (task.value) task.value.title = title;
}

/* ---- v517 (R196): task 完成度自报 — 显示 + 人工核实修正 ---- */

const taskProgressEditing = ref(false);
const taskProgressSaving = ref(false);
const taskProgressValue = ref<string>('');
const taskProgressNote = ref<string>('');

function openTaskProgressEdit(): void {
  taskProgressEditing.value = true;
  taskProgressValue.value =
    task.value?.progress === null || task.value?.progress === undefined
      ? ''
      : String(task.value.progress);
  taskProgressNote.value = task.value?.progress_note ?? '';
}

/** PATCH /api/tasks/[id] {progress, progress_note} — 后端固定 progress_source='manual'. */
async function saveTaskProgress(): Promise<void> {
  if (!task.value || taskProgressSaving.value) return;
  const raw = taskProgressValue.value.trim();
  const value = raw === '' ? null : Number(raw);
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
    toast.error('完成度需为 0-100 整数');
    return;
  }
  taskProgressSaving.value = true;
  try {
    await patch<void>(`/api/tasks/${task.value.id}`, {
      progress: value,
      progress_note: taskProgressNote.value.trim() || null,
    });
    task.value.progress = value;
    task.value.progress_note = taskProgressNote.value.trim() || null;
    task.value.progress_source = 'manual';
    taskProgressEditing.value = false;
    toast.success(value === null ? '已清空完成度' : `完成度已更新为 ${value}%`);
  } catch (e: unknown) {
    toast.error(isHttpError(e) ? e.message : '保存失败');
  } finally {
    taskProgressSaving.value = false;
  }
}

function onFavoriteChanged(fav: boolean): void {
  if (task.value) task.value.is_favorite = fav;
}

function onTimeoutUpdated(minutes: number | null): void {
  if (task.value) task.value.timeout_minutes = minutes;
  startTimeoutTicker();
}

function onApprovalResolved(requestId: string): void {
  pendingApprovals.value = pendingApprovals.value.filter((a) => a.requestId !== requestId);
}

function onDialogResolved(requestId: string): void {
  pendingDialogs.value = pendingDialogs.value.filter((d) => d.requestId !== requestId);
}

/* R56-A3.5 (C5): 顶部 fork-banner 黄卡片已删除, 改 inline 插入 transcript.
   showForkBoundary / formatForkTime 不再需要. */

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  B243: 主区 ↔ 右侧 dock 之间的水平拖拽手柄 (持久化 task-right-dock-width-v1) */
/* ------------------------------------------------------------------ */
/* R56-B12: 对齐 master next (tdc.tsx:740-796 / 3011-3019 / 384-408):
   - 常量改为 280/800/480
   - 持久化 key 改为 task-right-dock-width-v1 (跟 master 同名, 便于将来 swap)
   - 补 touchstart + touchmove + touchend 触屏支持 (touchAction:none 防横滑)
   - DOM 改用 1px 瘦线 + hover/active 蓝, 移除 margin+border-radius+默认 4% 灰底 */

const DOCK_MIN_W = 280;
const DOCK_MAX_W = 800;
const DOCK_DEFAULT_W = 480;

function loadDockWidth(): number {
  try {
    const raw = localStorage.getItem('task-right-dock-width-v1');
    if (raw == null) return DOCK_DEFAULT_W;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DOCK_DEFAULT_W;
    return Math.max(DOCK_MIN_W, Math.min(DOCK_MAX_W, n));
  } catch {
    return DOCK_DEFAULT_W;
  }
}

const dockWidth = ref<number>(loadDockWidth());

/** 拖拽手柄的统一入口 — mouse + touch 共用. touchmove 用 { passive: false }
    才能 preventDefault 阻止页面横滑 (master tdc.tsx:745-785 同款). */
function startDockDrag(ev: MouseEvent | TouchEvent): void {
  ev.preventDefault();
  const startX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX;
  const startW = dockWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const onMove = (e: MouseEvent | TouchEvent): void => {
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    // 向左拖 = dock 加宽 (startX - clientX > 0).
    const next = Math.max(
      DOCK_MIN_W,
      Math.min(DOCK_MAX_W, startW + (startX - cx)),
    );
    dockWidth.value = next;
  };
  const onUp = (): void => {
    try {
      localStorage.setItem('task-right-dock-width-v1', String(dockWidth.value));
    } catch {
      /* 静默 */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
}

/* ------------------------------------------------------------------ */
/*  R56-A3.2 (C3): TaskStatusBar 状态 — 搜索条 / 评分条 / dock 4 面板    */
/*  折叠态 / dock 整体收展 / 显示模式循环. 由 TaskStatusBar 工具栏 emit */
/*  触发, TaskDetailView 持有 source of truth (master tdc.tsx 同款).     */
/* ------------------------------------------------------------------ */

const searchOpen = ref<boolean>(false);
const searchQuery = ref<string>('');

const evalOpen = ref<boolean>(false);

/** Dock 4 面板 accordion 折叠态 (master use-dock-state 简化版 —
    只保留 collapsed bits, 不保留 height map; R37 起 height 由 CSS flex 自动分).
    R56-A4.5: 持久化到 localStorage `task-right-dock-v1` (master `useDockState` 同款),
    accordion 默认 details 展开、其他折叠. */
const DOCK_STATE_KEY = 'task-right-dock-v1';

type DockPanels = Record<'details' | 'timeline' | 'checkpoints' | 'commits', boolean>;
const DEFAULT_DOCK_PANELS: DockPanels = {
  details: false,
  timeline: true,
  checkpoints: true,
  commits: true,
};

function loadDockPanels(): DockPanels {
  try {
    const raw = localStorage.getItem(DOCK_STATE_KEY);
    if (!raw) return { ...DEFAULT_DOCK_PANELS };
    const parsed = JSON.parse(raw) as Partial<DockPanels> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_DOCK_PANELS };
    return {
      details: typeof parsed.details === 'boolean' ? parsed.details : DEFAULT_DOCK_PANELS.details,
      timeline: typeof parsed.timeline === 'boolean' ? parsed.timeline : DEFAULT_DOCK_PANELS.timeline,
      checkpoints: typeof parsed.checkpoints === 'boolean' ? parsed.checkpoints : DEFAULT_DOCK_PANELS.checkpoints,
      commits: typeof parsed.commits === 'boolean' ? parsed.commits : DEFAULT_DOCK_PANELS.commits,
    };
  } catch {
    /* 静默 */
  }
  return { ...DEFAULT_DOCK_PANELS };
}

const dockPanelsCollapsed = ref<DockPanels>(loadDockPanels());

watch(dockPanelsCollapsed, (next) => {
  try {
    localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(next));
  } catch {
    /* 静默 */
  }
}, { deep: true });

/** Dock 整体收/展 — 收起时所有面板不可见, 工具栏按钮显示 ◧ 面板.
    持久化 key = task-right-dock-collapsed-v1 (master useDockCollapsed 同款). */
const DOCK_COLLAPSED_KEY = 'task-right-dock-collapsed-v1';
function loadDockCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(DOCK_COLLAPSED_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* 静默 */
  }
  return false;
}
const dockCollapsed = ref<boolean>(loadDockCollapsed());
watch(dockCollapsed, (v) => {
  try {
    localStorage.setItem(DOCK_COLLAPSED_KEY, String(v));
  } catch {
    /* 静默 */
  }
});

/** R59+: ≤900px dock 浮层打开时, ESC 关闭 (跟 ProjectSidebar drawer 同款). */
function onDockEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !dockCollapsed.value) {
    dockCollapsed.value = true;
  }
}
onMounted(() => document.addEventListener('keydown', onDockEsc));
onUnmounted(() => document.removeEventListener('keydown', onDockEsc));

/** 显示模式 — 三态循环 text-only → all → expanded → text-only.
    持久化到 localStorage (key: task-display-mode-v1, master 同款). */
type DisplayMode = 'text-only' | 'all' | 'expanded';
const DISPLAY_MODE_KEY = 'task-display-mode-v1';
const DISPLAY_MODES: DisplayMode[] = ['text-only', 'all', 'expanded'];
const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  'text-only': '纯文本',
  all: '标准',
  expanded: '详情',
};
const DISPLAY_MODE_ICONS: Record<DisplayMode, string> = {
  'text-only': 'lines',
  all: 'list',
  expanded: 'expand-list',
};

function loadDisplayMode(): DisplayMode {
  try {
    const raw = localStorage.getItem(DISPLAY_MODE_KEY);
    if (raw && (DISPLAY_MODES as string[]).includes(raw)) return raw as DisplayMode;
  } catch {
    /* 静默 */
  }
  return 'all';
}

const displayMode = ref<DisplayMode>(loadDisplayMode());

watch(displayMode, (m) => {
  try {
    localStorage.setItem(DISPLAY_MODE_KEY, m);
  } catch {
    /* 静默 */
  }
});

/** R59: TaskHeader 折叠 — 跟 ChatView cv-task-header 一致, 让对话/transcript
    直接贴顶. 持久化 key = task-header-collapsed-v1. 默认展开 (跟 master
    task-detail-client.tsx 行为对齐). */
const HEADER_COLLAPSED_KEY = 'task-header-collapsed-v1';
function loadHeaderCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(HEADER_COLLAPSED_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* 静默 */
  }
  return false;
}
const headerCollapsed = ref<boolean>(loadHeaderCollapsed());
watch(headerCollapsed, (v) => {
  try {
    localStorage.setItem(HEADER_COLLAPSED_KEY, String(v));
  } catch {
    /* 静默 */
  }
});

function toggleHeader(): void {
  headerCollapsed.value = !headerCollapsed.value;
}

function cycleDisplayMode(): void {
  const idx = DISPLAY_MODES.indexOf(displayMode.value);
  displayMode.value = DISPLAY_MODES[(idx + 1) % DISPLAY_MODES.length];
}

/* ------------------------------------------------------------------ */
/*  StatusBar emit handlers                                             */
/* ------------------------------------------------------------------ */

function onToggleDockPanel(panel: 'details' | 'timeline' | 'checkpoints' | 'commits'): void {
  // Accordion: 展开这个 panel 自动折叠其他 3 个 (master use-dock-state 同款).
  const willExpand = dockPanelsCollapsed.value[panel];
  const next: Record<typeof panel, boolean> = {
    details: true,
    timeline: true,
    checkpoints: true,
    commits: true,
  };
  next[panel] = !willExpand;
  dockPanelsCollapsed.value = next;
}

function onToggleDockCollapsed(): void {
  dockCollapsed.value = !dockCollapsed.value;
}

/** R59+: dock 内联 style — 桌面态挂 dockWidth (用户拖拽 280-800px) + minWidth,
   移动端 ≤900px 走 CSS .side-col drawer 规则 (width: min(360px, 90vw)),
   这里返回空对象避免内联 style 跟 CSS 抢.
   R236: 断口判断改走 useMediaQuery 响应式 ref — 原来直接在 computed 里查
   matchMedia, 它不是响应式依赖, 桌面→H5 (或反向) resize 后永远不重算:
   正向残留 inline min-width 把 480px 抽屉顶出 390px 屏 (damo 1011 实证),
   反向抽屉拿不到 width 整条 stretch. media query 里另有 !important 兜底. */
const isNarrowViewport = useMediaQuery('(max-width: 900px)');
const dockInlineStyle = computed<Record<string, string>>(() => {
  if (isNarrowViewport.value) {
    return {};
  }
  return {
    width: `${dockWidth.value}px`,
    minWidth: `${dockWidth.value}px`,
  } as Record<string, string>;
});

function onToggleSearch(): void {
  searchOpen.value = !searchOpen.value;
}

function onClearSearch(): void {
  searchOpen.value = false;
  searchQuery.value = '';
}

function onToggleEval(): void {
  evalOpen.value = !evalOpen.value;
}

/* R56-A4.1: 状态栏 📋 触发 session-level fork — 复用 R52 ForkModal,
   调 setSessionHead() 走 session 末尾 fork 模式 (不传 upToMessageId). */
const forkModalRef = ref<InstanceType<typeof ForkModal> | null>(null);
const forkOpen = ref<boolean>(false);

function onOpenFork(): void {
  forkOpen.value = true;
  void nextTick(() => {
    forkModalRef.value?.setSessionHead();
  });
}

function onForkModalClose(): void {
  forkOpen.value = false;
}

function onForked(newTaskId: string): void {
  forkOpen.value = false;
  // 跳到新 task — 用 hash 路由 (#/tasks/<id>) 简化处理.
  window.location.href = `#/tasks/${newTaskId}`;
}

/** R56-A3.3 (C1): RightDock checkpoints 面板的 Fork from here 按钮触发.
    走 master 同款 onForkFromCheckpoint (调 setForkForm); SPA 暂无 session-level
    fork modal, 占位弹窗同 onOpenFork. */
function onForkFromCheckpoint(_checkpointId: number): void {
  onOpenFork();
}

/** R56-A3.3: RightDock checkpoints 面板「Fork from here」按钮可见性 — 与
    TaskStatusBar 的 session_id_available 同口径. */
const isForkableStatus = computed<boolean>(() =>
  ['paused', 'reviewing', 'rejected', 'await_user', 'completed', 'failed', 'cancelled'].includes(status.value),
);

/* ------------------------------------------------------------------ */
/*  R56-A4.11: deleted banner — 红色顶条 + 恢复按钮 (master tdc.tsx:2330)   */
/* ------------------------------------------------------------------ */

const toast = useToast();

// idea-canvas P1 (docs/plans/idea-canvas.md): 「放入列表」+ 构思徽章.
//   懒加载: 首次点开菜单才拉 /api/pin-lists (详情页高频打开, 别每次都带一个请求).
const pinLists = ref<Array<{ id: string; title: string; items: Array<{ id: string }>; }>>([]);
const showListMenu = ref(false);
const listMenuLoaded = ref(false);
/** 分类下拉定位 — position:fixed + 开菜单瞬间取按钮视口坐标 (2026-11-04 damo
    反馈: 手机分辨率下菜单被 .tsb-row 的 overflow-x:auto 滚动容器裁进边界里,
    PC ≥640px 该容器 overflow:visible 才没事). fixed 不受祖先 overflow 裁剪,
    桌面/手机同一条路径. */
const tdListBtn = ref<HTMLButtonElement | null>(null);
const tdListMenuStyle = ref<Record<string, string>>({});
async function toggleListMenu() {
  showListMenu.value = !showListMenu.value;
  if (showListMenu.value) {
    const r = tdListBtn.value?.getBoundingClientRect();
    if (r) {
      // 贴屏幕右缘时菜单左移夹取 (菜单 min-width 160 + 边距), 8px 屏边距兜底
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 180));
      tdListMenuStyle.value = { left: `${left}px`, top: `${r.bottom + 6}px` };
    }
  }
  if (showListMenu.value && !listMenuLoaded.value) {
    const d = await listPinLists();
    pinLists.value = d.lists;
    listMenuLoaded.value = true;
  }
}
async function putIntoList(list: { id: string; title: string }) {
  try {
    await addPinListItem(list.id, { ref_type: 'task', ref_id: task.value!.id, added_by: 'damo' });
    toast.success(`已放入「${list.title}」`);
    showListMenu.value = false;
  } catch (err: any) {
    toast.error(err?.body?.code === 'ALREADY_IN_LIST' ? '已在这个列表里' : (err?.message ?? '放入失败'));
  }
}
const restoring = ref<boolean>(false);

async function onRestoreTask(): Promise<void> {
  if (restoring.value) return;
  restoring.value = true;
  try {
    await restoreTask(task.value?.id ?? '');
    // 乐观更新本地 deleted_at 为 null, 让 banner 立刻消失.
    if (task.value) task.value.deleted_at = null;
    toast.success('已恢复任务');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '恢复失败';
    toast.error(msg);
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="task-detail">
    <div v-if="loading && !task" class="state-block">
      <Loading size="lg" label="加载任务详情" />
      <p class="state-text muted">加载中…</p>
    </div>

    <ErrorView
      v-else-if="error"
      title="加载任务失败"
      :description="error"
      variant="error"
      :retrying="retrying"
      @retry="retry"
    />

    <Empty
      v-else-if="!task"
      illustration="doc"
      title="任务不存在"
      description="该任务可能已被删除,或当前用户无权访问"
      size="md"
    />

    <div v-else class="task-detail-row">
      <div class="content">
        <!-- R250 (damo: 「普通任务视图按钮挤在一起, 聊天模式能一排过去」):
             content 改两段式 — 全宽头部区 (banner/header/进度/状态栏/资源/构思/
             评分) + 下方主体行 (.td-content-body = main-col + handle + dock).
             之前 TaskStatusBar 塞在被 dock 挤窄的 main-col (1440 屏仅 712px),
             一行按钮自然宽 ~726px 放不下, tsb-toolbar 整块 wrap 到第二行孤零零
             挤在右边; ChatView 的状态栏横跨 chat 列 + dock 总宽 (920px) 所以
             一排放得下. 现在与 ChatView 同构, 状态栏横跨全宽. -->
        <!-- R56-A4.11: deleted banner — 红色顶条 + 恢复按钮 (master tdc.tsx:2330) -->
        <div v-if="isDeleted" class="td-deleted-banner">
          <span class="td-deleted-banner-text">🗑 此任务已删除</span>
          <button
            type="button"
            class="td-deleted-banner-btn"
            :disabled="restoring"
            @click="onRestoreTask"
          >{{ restoring ? '恢复中…' : '恢复任务' }}</button>
        </div>

        <!-- R59: TaskHeader 折叠 (跟 ChatView cv-task-header 一致) —
             展开态 header + 折叠按钮 (右上角 absolute, 不挡 TaskHeader 自带按钮);
             折叠态 thin strip 大按钮「展开信息」+ ▲, catch-22 规避. -->
        <div v-if="!headerCollapsed" class="td-header-wrap">
          <TaskHeader
            :task-id="task.id"
            :title="task.title"
            :status="status"
            :type="task.type"
            :priority="task.priority"
            :is-deleted="isDeleted"
            :model="task.model"
            :resolved-model="task.resolved_model"
            :effort="task.effort"
            :max-turns="task.max_turns"
            :cost-usd="cost"
            :cost-coefficient="task.cost_coefficient ?? null"
            :context-tokens="contextTokens"
            :context-max="contextMax"
            :created-at="task.created_at"
            :started-at="task.started_at"
            :awaiting-markers="task.awaiting_markers"
            :awaiting-owner-review="task.awaiting_owner_review ?? 0"
            :queued-reason="task.queued_reason"
            :favorite="task.is_favorite ?? false"
            :project-name="task.project_name"
            :version-name="task.version_name"
            :project-id="task.project_id"
            :version-id="task.version_id"
            :parent-title="task.parent_task?.title"
            :timeout-anchor="task.started_at"
            :timeout-remaining-ms="timeoutRemainingMs"
            :timeout-total-ms="timeoutTotalMs"
            :timeout-override-minutes="task.timeout_minutes"
            :default-timeout-minutes="60"
            @title-updated="onTitleUpdated"
            @favorite-changed="onFavoriteChanged"
            @timeout-updated="onTimeoutUpdated"
          />
          <button
            type="button"
            class="td-header-fold-btn"
            :title="'折叠标题栏'"
            aria-label="折叠标题栏"
            @click="toggleHeader"
          >
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>

        <!-- 折叠态 thin strip — 左侧保留任务标题 (用户反馈「收起能保留标题吗」),
             右侧「展开信息」按钮. catch-22 规避. -->
        <div v-else class="td-header-collapsed">
          <router-link :to="`/tasks/${task.id}`" class="td-collapsed-title-link">
            <span class="td-collapsed-title-text">{{ task.title }}</span>
          </router-link>
          <button
            type="button"
            class="td-fold-strip-btn"
            :title="'展开标题栏'"
            aria-label="展开标题栏"
            @click="toggleHeader"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" class="td-fold-strip-icon">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
            <span>展开信息</span>
          </button>
        </div>

        <!-- v517 (R196): task 完成度自报行 — agent 每轮经 API 自报, 人可在此核实修正. -->
        <div v-if="task.progress !== null && task.progress !== undefined || taskProgressEditing" class="td-progress-row">
          <div class="td-progress-bar-wrap">
            <div class="td-progress-bar" :style="{ width: `${task.progress ?? 0}%` }" />
          </div>
          <span class="td-progress-pct">{{ task.progress ?? 0 }}%</span>
          <span
            v-if="task.progress_note"
            class="td-progress-note"
            :title="`${task.progress_note} (${task.progress_source ?? ''} · ${task.progress_updated_at ?? ''})`"
          >{{ task.progress_note }}</span>
          <span v-else class="td-progress-note td-progress-note-empty">无依据说明</span>
          <button
            type="button"
            class="td-progress-edit-btn"
            @click="taskProgressEditing ? taskProgressEditing = false : openTaskProgressEdit()"
          >{{ taskProgressEditing ? '收起' : '修正' }}</button>
          <div v-if="taskProgressEditing" class="td-progress-form">
            <input
              v-model="taskProgressValue"
              type="number"
              min="0"
              max="100"
              class="td-progress-input"
              placeholder="0-100"
            />
            <input
              v-model="taskProgressNote"
              type="text"
              class="td-progress-input td-progress-input-note"
              placeholder="依据 (可选)"
            />
            <button
              type="button"
              class="td-progress-save-btn"
              :disabled="taskProgressSaving"
              @click="saveTaskProgress"
            >{{ taskProgressSaving ? '保存中…' : '保存' }}</button>
          </div>
        </div>

        <!-- R56-A3.2 (C3): TaskStatusBar 状态行 — 状态点/字/chip + 工具栏.
             动作按钮槽位复用现有 LifecycleActions (start/pause/cancel/
             approve/refine/restart/await/unawait/delete + ResumeModal 触发),
             与 master tdc.tsx:1997-2166 一一对应. -->
        <TaskStatusBar
          :task-id="task.id"
          :status="status"
          :task-type="task.type"
          :deleted-at="task.deleted_at"
          :awaiting-owner-review="!!task.awaiting_owner_review"
          :project-id="task.project_id"
          :version-id="task.version_id"
          :dock-open="{
            details: !dockPanelsCollapsed.details,
            timeline: !dockPanelsCollapsed.timeline,
            checkpoints: !dockPanelsCollapsed.checkpoints,
            commits: !dockPanelsCollapsed.commits,
          }"
          :dock-collapsed="dockCollapsed"
          :search-open="searchOpen"
          :search-query="searchQuery"
          :eval-open="evalOpen"
          :display-mode-mode="displayMode"
          :display-mode-label="DISPLAY_MODE_LABELS[displayMode]"
          :display-mode-icon="DISPLAY_MODE_ICONS[displayMode]"
          @toggle-dock-collapsed="onToggleDockCollapsed"
          @toggle-search="onToggleSearch"
          @clear-search="onClearSearch"
          @toggle-eval="onToggleEval"
          @open-fork="onOpenFork"
          @cycle-display-mode="cycleDisplayMode"
        >
          <template #actions>
            <LifecycleActions
              :task-id="task.id"
              :status="status"
              :awaiting-owner-review="!!task.awaiting_owner_review"
              @changed="onStatusChanged"
              @open-resume="onOpenResume"
            />
            <!-- idea-canvas P1: 🗂 分类 (原「放入列表」, damo 1012: 改名 + 挪进
                 状态栏按钮排, 不再独占一行挤压聊天区). -->
            <div class="td-list-put">
              <button ref="tdListBtn" class="td-list-btn" @click="toggleListMenu">🗂 分类</button>
              <div v-if="showListMenu" class="td-list-menu" :style="tdListMenuStyle">
                <div v-for="l in pinLists" :key="l.id" class="td-list-opt" @click="putIntoList(l)">{{ l.title }}</div>
                <div v-if="pinLists.length === 0" class="td-list-empty">还没有分类 — 去全局看板「分类」视图建一个</div>
              </div>
            </div>
          </template>
        </TaskStatusBar>

        <!-- R232: 运行中任务的实时 CPU/内存 — 状态行下大号徽章 (非终态 + 有 /proc
             采样才渲染; 进程退出后采样消失, 徽章自动隐藏). -->
        <div v-if="taskResourceSample" class="td-resource-row">
          <TaskResourceBadge :sample="taskResourceSample" :warn="taskResourceWarn" />
          <span class="td-resource-hint">进程树实时占用 (2s 采样)</span>
        </div>

        <!-- idea-canvas P1: 构思徽章 (docs/plans/idea-canvas.md §6). 分类按钮已
             挪进 TaskStatusBar actions 槽 — 本行只在任务真挂了构思时才渲染. -->
        <div v-if="task.idea_id" class="td-idea-row">
          <button class="td-idea-badge" title="这个任务挂在某个构思下" @click="router.push('/ideas')">💡 构思画布</button>
        </div>

        <!-- R56-A4.3: 评分条 amber-50 区 (evalOpen toggle 控制显隐,
             仅 completed/rejected 状态可评分). R250: 从 main-col 提到全宽头部区
             (ChatView cv-evalbar-row 同构 — cv-body 之外全宽一行). -->
        <TaskEvaluationBar
          v-if="evalOpen && (status === 'completed' || status === 'rejected')"
          :task-id="task.id"
        />

        <!-- R250: 全宽头部区到此为止 — 主体行 (.td-content-body) 开始:
             main-col (approvals/dialogs/transcript/input/modal) + 拖拽手柄 +
             RightDock. dock 不再挤压状态栏, 状态栏横跨全宽 (聊天模式同款). -->
        <div class="td-content-body">
      <div class="main-col">

        <!-- R56-A4.9 (P1-2): 主列「基础信息」meta-card 删除.
             master tdc.tsx 主列无此 meta-card: 状态走 TaskStatusBar + TaskMetaRow
             + RightDock 详情面板 (cwd/project/version/tags/preflight/session 全在
             RightDock 元信息子面板), 状态重复 3 次的体验问题收敛. -->

        <!-- R56-B2.2: text-cards 整段删除 — 见上方 script 段 banner. -->

        <!-- Pending approvals + dialogs (SSE-driven) -->
        <TaskPendingApprovals
          :task-id="task.id"
          :approvals="pendingApprovals"
          @resolved="onApprovalResolved"
        />
        <TaskPendingDialogs
          :task-id="task.id"
          :dialogs="pendingDialogs"
          :input-form-height="inputFormHeight"
          @resolved="onDialogResolved"
        />

        <!-- R56-A3.5 (C5): 顶部 fork-banner 黄卡片删除, 改在 transcript 消息流
             中按 forked_at 时间戳插入 inline ForkBoundary (master tdc.tsx:3160
             + MessageForkBoundary.vue 同款). -->

        <!-- R56-A3.4 (C4): 搜索条 (searchOpen + searchQuery) 由父级 TaskStatusBar
             🔍 toggle 控制, v-model 双向绑定 searchQuery. -->
        <TaskTranscriptEmbed
          :task-id="task.id"
          :forked-at="task.forked_at ?? null"
          :parent-task="task.parent_task ?? null"
          :parent-title="task.title"
          :parent-prompt="task.prompt"
          :parent-max-turns="task.max_turns"
          :context-tokens="contextTokens"
          :search-open="searchOpen"
          :search-query="searchQuery"
          :display-mode="displayMode"
          :project-id="task.project_id"
          :task-result="task.result"
          :task-error="task.error"
          @update:search-query="(q: string) => (searchQuery = q)"
        />

        <!-- Message input -->
        <TaskMessageInput
          :task-id="task.id"
          :status="status"
          :disabled="isDeleted"
          :disabled-reason="isDeleted ? '任务已删除' : ''"
          :initial-auto-approve="!!task.auto_approve"
          :initial-model="task.model"
          :initial-effort="task.effort"
          :initial-max-turns="task.max_turns"
          :context-project-id="task.project_id"
          :context-version-id="task.version_id"
          :context-model="task.model"
          :context-effort="task.effort"
          @input-form-height="onInputFormHeight"
        />

        <!-- R52.9 (B251): Resume 弹窗 — 仅 paused 状态可触发, 但 modal
             自己不判 status, 由父级 visibility gate. -->
        <ResumeModal
          v-if="resumeOpen && status === 'paused'"
          :task-id="task.id"
          :current-auto-approve="task.auto_approve ?? null"
          :current-max-turns="task.max_turns"
          @close="onResumeClose"
          @resumed="onResumed"
        />

        <!-- R56-A4.1: session-level ForkModal — 状态栏 📋 按钮触发,
             走 session 末尾 fork (master ForkFormModal mode="head" 同款). -->
        <ForkModal
          v-if="forkOpen"
          ref="forkModalRef"
          :task-id="task.id"
          :parent-title="task.title"
          :parent-prompt="task.prompt"
          :parent-max-turns="task.max_turns"
          :context-tokens="contextTokens"
          :compact-threshold="180000"
          @close="onForkModalClose"
          @forked="onForked"
        />

        <!-- R56-B3.2: 主列底部 timeline-card + commits-card 删除 —
             master 主列只有 transcript + input, 时间线/Commits 走 RightDock
             详情/时间线/Checkpoints/Commits 4 面板 (master tdc.tsx:2049+2076
             + RightDock.vue:119-123 同款). 这里保留只会让主列被挤窄,
             且与 dock 重复展示. -->
      </div>
      <!-- /main-col -->

      <!-- R56-B12 fix: 主区 ↔ dock 拖拽手柄. 必须在 main 和 side 之间 (master
           tdc.tsx:3011 DOM 顺序 = main → handle → side), 否则 handle 会落在
           viewport 边缘, 看起来「这条边 hover 不会拖动」= 用户鼠标准确命中
           的「边」其实是 dock 自己的边框, handle 跑到 viewport 边缘去了. -->
      <div
        class="dock-resize-handle"
        title="拖拽调整右侧 dock 宽度"
        @mousedown="startDockDrag"
        @touchstart="startDockDrag"
      />

      <!-- R59: ≤900px RightDock drawer backdrop — 半透明遮罩, 点击关闭
           (跟 ProjectSidebar drawer 同款: 用户反馈「右侧 dock 在 h5 模式下
           挡住主题页面,用不了功能」). -->
      <div
        v-if="!dockCollapsed"
        class="dock-backdrop"
        @click="onToggleDockCollapsed"
        aria-hidden="true"
      ></div>

      <!-- R56-A3.3 (C1): RightDock 4 面板 — 替换旧 TaskDetailsPanel (仅关联任务).
           详情 / 时间线 / Checkpoints / Commits accordion; 折叠态由父级 (本组件)
           持有, 通过 :collapsed 传入; onToggle 调 onToggleDockPanel 走 accordion
           逻辑. session-level fork modal 留 R56-A4 接, onForkFromCheckpoint 占位.

           R59+: ≤900px 走 drawer overlay — side-col 改 position:fixed + transform,
           不占 main-col 宽度 (用户反馈 H5 上 main-col 被挤成负数看不见内容). -->
      <div
        v-show="!dockCollapsed"
        class="side-col"
        :class="{ 'side-col--drawer-open': !dockCollapsed }"
        :style="dockInlineStyle"
      >
        <!-- R59+: drawer 关闭按钮 (sticky 在 dock 顶部) — H5 上用户能直观
             找到关闭入口, 不用回 TaskStatusBar 找面板 toggle. 标题行
             「信息面板」 + × 关闭按钮 (用户反馈「顶部加一个标题行, 刚好
             把 x 的按钮放标题行右侧」). -->
        <div class="dock-drawer-header">
          <h2 class="dock-drawer-title">信息面板</h2>
          <button
            type="button"
            class="dock-drawer-close"
            title="关闭信息面板"
            aria-label="关闭信息面板"
            @click="onToggleDockCollapsed"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" aria-hidden="true">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </button>
        </div>
        <RightDock
          :task-id="task.id"
          :task="{
            id: task.id,
            title: task.title,
            prompt: task.prompt,
            status: task.status,
            // R242: 与 TaskHeader resolvedModelLabel 同口径 — resolved 优先, 显示实际跑的模型
            model: task.resolved_model ?? task.model ?? null,
            effort: task.effort ?? null,
            max_turns: task.max_turns ?? null,
            created_at: task.created_at ?? null,
            started_at: task.started_at ?? null,
            completed_at: task.completed_at ?? null,
            cwd: task.cwd ?? null,
            allowed_tools: task.allowed_tools ?? null,
            tags: task.tags ?? null,
            project_id: task.project_id,
            version_id: task.version_id,
            session_id: task.session_id ?? null,
            result: task.result,
            error: task.error,
            preflight_result: task.preflight_result ?? null,
            requirement_id: task.requirement_id ?? null,
            base_commit: task.base_commit ?? null,
            head_commit: task.head_commit ?? null,
            card_summary: task.card_summary ?? null,
            result_layers: task.result_layers ?? null,
          }"
          :parent-task="task.parent_task ?? null"
          :dispatcher-task="task.dispatcher_task ?? null"
          :dispatched-tasks="task.dispatched_tasks ?? []"
          :depends-on-tasks="task.depends_on_tasks ?? []"
          :dependent-tasks="task.dependent_tasks ?? []"
          :requirement-link="task.requirement_link ?? null"
          :requirement-siblings="task.requirement_siblings ?? []"
          :collapsed="dockPanelsCollapsed"
          :session-id-available="isForkableStatus"
          :context-tokens="contextTokens"
          :context-max="contextMax"
          :timeout-remaining-ms="timeoutRemainingMs"
          :timeout-total-ms="timeoutTotalMs"
          :cost-usd="cost"
          :cost-coefficient="task.cost_coefficient ?? null"
          @toggle="onToggleDockPanel"
          @fork-from-checkpoint="onForkFromCheckpoint"
        />
      </div>
      </div>
      <!-- /td-content-body (R250) -->
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, h, type PropType } from 'vue';
import TaskTranscript from '@/components/TaskTranscript.vue';
/* TaskTranscriptEmbed: 包裹层, 用于把
   搜索条 (父级 TaskStatusBar 🔍 控制) 转 v-model 到子组件,
   以及把 inline ForkBoundary 所需 forked_at + parent_task 透传到 transcript. */
export const TaskTranscriptEmbed = defineComponent({
  name: 'TaskTranscriptEmbed',
  props: {
    taskId: { type: String, required: true },
    forkedAt: { type: String as PropType<string | null>, default: null },
    parentTask: {
      type: Object as PropType<{ id: string; title: string; status: string } | null>,
      default: null,
    },
    parentTitle: { type: String, default: '' },
    parentPrompt: { type: String, default: '' },
    parentMaxTurns: { type: Number as PropType<number | null>, default: null },
    contextTokens: { type: Number as PropType<number | null>, default: null },
    searchOpen: { type: Boolean, default: false },
    searchQuery: { type: String, default: '' },
    displayMode: {
      type: String as PropType<'text-only' | 'all' | 'expanded'>,
      default: 'all',
    },
    projectId: { type: String as PropType<string | null>, default: null },
    /** R56-B2.4: master tdc.tsx:2571-2591 同款 — result/error 在没有 messages 时透传. */
    taskResult: { type: String as PropType<string | null>, default: null },
    taskError: { type: String as PropType<string | null>, default: null },
  },
  emits: ['update:searchQuery'],
  setup(props, { emit }) {
    return () =>
      h(TaskTranscript, {
        taskId: props.taskId,
        forkedAt: props.forkedAt,
        parentTask: props.parentTask,
        parentTitle: props.parentTitle,
        parentPrompt: props.parentPrompt,
        parentMaxTurns: props.parentMaxTurns,
        contextTokens: props.contextTokens,
        searchOpen: props.searchOpen,
        searchQuery: props.searchQuery,
        displayMode: props.displayMode,
        projectId: props.projectId,
        taskResult: props.taskResult,
        taskError: props.taskError,
        'onUpdate:searchQuery': (q: string) => emit('update:searchQuery', q),
      });
  },
});
</script>

<style scoped>
/* R56-A3.1 (C2): master `flex h-full min-h-0` 全宽容器 — 取代旧版 max-width
   1200px 卡片. 主列 + dock + 拖拽手柄一排铺满 viewport, 子元素 min-h-0
   让消息流 flex 撑开. loading/error/empty 走居中 stack, 不挡 flex 行. */
.task-detail {
  display: flex;
  height: 100%;
  min-height: 0;
  width: 100%;
  flex-direction: column;
}

.task-detail-row {
  display: flex;
  height: 100%;
  min-height: 0;
  width: 100%;
}

/* R232: 资源徽章行 — 状态栏下方细条, 徽章 + 口径提示. */
.td-resource-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}
.td-resource-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

/* R56-A4.11: deleted banner — 红色顶条 + 恢复按钮 (master tdc.tsx:2330 同款). */
.td-deleted-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--tw-red-200);
  background: var(--tw-red-50);
  font-size: 13px;
}
.td-deleted-banner-text {
  color: var(--tw-red-700);
  font-weight: 500;
}
.td-deleted-banner-btn {
  background: var(--tw-blue-600-solid);
  color: #fff;
  border: 0;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
.td-deleted-banner-btn:hover:not(:disabled) {
  background: var(--tw-blue-700-solid);
}
.td-deleted-banner-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
}

.state-text {
  margin: 0;
  font-size: 13px;
}

.muted {
  color: var(--color-text-muted);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}

/* R56-A3.1 (C2): master `flex` 替代 grid. 父级 .task-detail-row 给 flex 行定高度.
   R250: content 改 flex column 两段式 — 全宽头部区 (banner/header/进度/状态栏/
   资源/构思/评分) 在上, .td-content-body (main-col + handle + dock) 在下.
   之前状态栏塞在被 dock 挤窄的 main-col 里, 按钮排 wrap 成两行 (damo 反馈
   「按钮挤在一起」); ChatView 同构布局状态栏横跨全宽一排放得下. */
.content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  width: 100%;
  /* 头部行间距 — 与原 main-col gap 同档, 重排不改变视觉节奏 */
  gap: 12px;
}

/* R250: 主体行 — main-col (transcript/input) + handle + RightDock 并排,
   撑 content 剩余高度; 头部区高度由内容决定, 不参与挤压主体. */
.td-content-body {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
}

.main-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  flex: 1;
}

/* R61: 变 flex column — dock-drawer-header (信息面板标题行) 现在 PC 也常驻,
   它跟 RightDock (.rd-root height:100%) 是兄弟节点, block 布局下 rd-root
   100% + header 高度会溢出 dock 一截. flex column + header flex-shrink:0
   让 rd-root 收缩填剩余高度. */
.side-col {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.main-col {
  border-right: 1px solid rgba(209, 213, 219, 1); /* gray-300 — 跟 handle 中线形成复合双线 */
}

/* R56-B12: 主区 ↔ dock 拖拽手柄 — 必须在 main 和 side 之间 (DOM 顺序),
   否则会被推到 viewport 边缘, 用户鼠标准确命中的「边」其实是 dock 边框.

   方案 (master 配色 + 强化可见):
   - 8px 透明热区 (cursor: col-resize 整片可拖, 容错性好)
   - 1px gray-400 左边线常驻可见 (master w-1 太浅, gray-200 跟背景同色被淹没,
     改 gray-400 明显深一档, 不破坏「细线」语义)
   - hover 转 blue-400 半透明背景 + blue-500 边线 (master 同款配色)
   - active 转 blue-600 边线 (master 同款更深)
   - main-col 加 border-right 1px gray-300, 形成「聊天 | 1px 灰线 | handle | dock」
     复合双线分区 (跟 master tdc.tsx 一样简洁, 不靠加额外背景色) */
.dock-resize-handle {
  width: 8px;
  align-self: stretch;
  cursor: col-resize;
  pointer-events: auto;
  background: transparent;
  border-left: 1px solid rgba(156, 163, 175, 1); /* gray-400 (常驻可见分隔线) */
  transition: background 0.15s, border-color 0.15s;
  touch-action: none;
}
.dock-resize-handle:hover {
  background: rgba(96, 165, 250, 0.15); /* blue-400 半透明 — 热区提示 */
  border-left-color: rgba(59, 130, 246, 1); /* blue-500 */
}
.dock-resize-handle:active {
  background: rgba(96, 165, 250, 0.3);
  border-left-color: rgba(37, 99, 235, 1); /* blue-600 */
}

.card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  box-shadow: var(--shadow-sm);
}

.section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.error-title {
  color: var(--tw-red-800);
}

.meta-grid {
  margin: 0;
  display: grid;
  grid-template-columns: 96px 1fr;
  row-gap: 6px;
  column-gap: 12px;
  font-size: 13px;
}
.meta-grid dt {
  text-align: right;
  font-weight: 400;
}
.meta-grid dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  word-break: break-all;
}
.meta-value {
  color: var(--color-text);
}

.tag-chip {
  padding: 1px 7px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 11px;
  color: var(--color-text-muted);
}

.type-chip {
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

.priority-chip {
  font-size: 11px;
  color: var(--tw-orange-600);
  font-weight: 500;
}

.req-link {
  color: var(--color-primary, #3b82f6);
  text-decoration: none;
}
.req-link:hover {
  text-decoration: underline;
}

/* R56-B2.2: .text-cards / .text-block / .error-card / .error-text 删除 — 主列
   已无 text-card 节点. 失败态的红色提示走 transcript 内 error fallback (master
   tdc.tsx:2573 红条同款), 由 TaskTranscript.vue 在 messages 全部加载前的空态
   渲染一次. */

/* R56-A3.5 (C5): 顶部 fork-banner 样式已删除 — 由 inline MessageForkBoundary
   替代 (master tdc.tsx:3092-3149 同款蓝横线 + pill + 复制按钮). */

@media (max-width: 900px) {
  /* R59+: ≤900px 改 drawer overlay — side-col position:fixed + transform,
     不占 main-col 宽度. (R250 后 .content 桌面态本就是 flex column 两段式,
     原 media 里的 .content{flex-direction:column} 空转已删.) 480px dockWidth
     若仍内联占宽会把 main-col 挤成负数 — 跟 ProjectSidebar 同款 drawer 套路. */
  .side-col {
    position: fixed;
    top: 88px;        /* AppHeader 44 + TaskStatusBar 44 (H5 上都在) */
    right: 0;
    bottom: 0;
    /* R236: width/min-width 加 !important — 桌面拖拽残留的内联 style
         (width/minWidth = dockWidth, resize 到 H5 后 computed 不重算) 在
         CSS 优先级上压过普通 stylesheet 规则 (inline > sheet; min-width 又
         > width/max-width), 480px 抽屉在 390px 屏上 left=-90 整体出画,
         信息面板文字左右都被裁 (damo 1011 实证). !important sheet 规则压过
         非 important inline style, 且 media query 实时生效, 不依赖重挂载. */
    width: min(360px, 90vw) !important;
    min-width: 0 !important;
    max-width: 90vw;
    z-index: 60;      /* 同 sidebar drawer 一档 */
    transform: translateX(100%);
    transition: transform 0.25s ease;
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.08);
    background: var(--color-bg-elevated, #fff);
  }
  .side-col--drawer-open {
    transform: translateX(0);
  }
  /* 桌面态拖拽手柄在 H5 上藏 — drawer 不能拖.
     选择器必须是模板里真实用的 .dock-resize-handle, 之前写成不存在的
     .dock-resizer, 规则空转, H5 上留了一条 8px 灰线. */
  .dock-resize-handle {
    display: none;
  }
  /* R59 回归修复: backdrop 只在 H5 抽屉形态下存在.
     之前这条规则放在 media query 外面 (跟 master 的 `md:hidden` 不符),
     而模板里 backdrop 的 v-if 只看 !dockCollapsed — 桌面态 dock 默认就是展开的,
     于是整屏 (88px 以下) 被 30% 黑蒙层盖住, z-index 55 还压住 side-col
     (桌面 z-index auto), 点面板任何位置都打在蒙层上 → 点一下就收起.
     表现: 「PC 点面板 = 一片灰蒙层, 面板用不了」. */
  .dock-backdrop {
    position: fixed;
    top: 88px;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 55;
    animation: dock-backdrop-in 0.2s ease;
  }
}
@keyframes dock-backdrop-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* R59+: drawer 顶部标题行 — flex space-between, 标题「信息面板」左, × 关闭按钮右.
   R61: PC 也显示 (原 R59 只在 ≤900px 显示, PC 上收起 dock 没有 × 只能回状态栏
   找 toggle — 用户反馈「在 pc 上也显示吧」). 所以整段从 @media 里提出来. */
.dock-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg, #fff);
  flex-shrink: 0;
}
.dock-drawer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}
/* R59+: dock-drawer-close 28 → 30, 跟顶部 30×30 图标按钮同档 (用户反馈
 「还有28的」不齐). */
.dock-drawer-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--color-text-muted, #6b7280);
  width: 30px;
  height: 30px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  flex-shrink: 0;
}
.dock-drawer-close:hover {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text);
}

/* R59: TaskHeader 折叠 — 跟 ChatView cv-task-header 同款 (展开右上角 ▼,
   折叠 thin strip 「展开信息」按钮). */

.td-header-wrap {
  position: relative;
}

.td-header-fold-btn {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 4px;
  background: var(--color-bg-elevated, #fff);
  color: var(--color-text-muted, #6b7280);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.td-header-fold-btn:hover {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text, #111827);
  border-color: var(--tw-blue-300);
}
.td-header-fold-btn svg {
  width: 14px;
  height: 14px;
}

.td-header-collapsed {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg-elevated, #fff);
}

.td-collapsed-title-link {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  color: var(--color-text, #111827);
  overflow: hidden;
}
.td-collapsed-title-link:hover .td-collapsed-title-text {
  color: var(--color-primary, #2563eb);
  text-decoration: underline;
}
.td-collapsed-title-text {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-fold-strip-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 999px;
  background: var(--color-bg, #f9fafb);
  color: var(--color-text, #111827);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.td-fold-strip-btn:hover {
  background: var(--tw-indigo-100);
  border-color: var(--tw-blue-300);
  color: var(--color-primary, #1d4ed8);
}
.td-fold-strip-icon {
  width: 14px;
  height: 14px;
}

/* v517 (R196): task 完成度自报行 */
.td-progress-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; margin-bottom: 8px;
  background: var(--color-bg-subtle, #f9fafb);
  border: 1px solid var(--color-border, #e5e7eb); border-radius: 8px;
}
.td-progress-bar-wrap {
  flex: 0 0 140px; height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--color-border, #e5e7eb);
}
.td-progress-bar { height: 100%; background: var(--tw-blue-600-solid); border-radius: 3px; }
.td-progress-pct { font-size: 12px; font-weight: 600; color: var(--color-text, #111827); }
.td-progress-note {
  font-size: 11px; color: var(--color-text-muted, #6b7280);
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.td-progress-note-empty { opacity: 0.6; }
.td-progress-edit-btn {
  margin-left: auto; font-size: 11px; padding: 2px 8px;
  border: 1px solid var(--color-border, #d1d5db); border-radius: 6px;
  color: var(--color-text-muted, #4b5563); background: transparent; cursor: pointer;
}
.td-progress-edit-btn:hover { background: var(--color-bg, #f3f4f6); }
.td-progress-form { display: flex; gap: 6px; width: 100%; }
.td-progress-input {
  width: 90px; font-size: 12px; padding: 4px 8px;
  border: 1px solid var(--color-border, #d1d5db); border-radius: 6px;
}
.td-progress-input-note { flex: 1; width: auto; }
.td-progress-save-btn {
  font-size: 12px; padding: 4px 12px; border-radius: 6px; border: none;
  background: var(--tw-blue-600-solid); color: #fff; cursor: pointer;
}
.td-progress-save-btn:disabled { opacity: 0.5; }

/* v517 (R196): task 完成度自报行 */
.td-progress-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; margin-bottom: 8px;
  background: var(--color-bg-subtle, #f9fafb);
  border: 1px solid var(--color-border, #e5e7eb); border-radius: 8px;
}
.td-progress-bar-wrap {
  flex: 0 0 140px; height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--color-border, #e5e7eb);
}
.td-progress-bar { height: 100%; background: var(--tw-blue-600-solid); border-radius: 3px; }
.td-progress-pct { font-size: 12px; font-weight: 600; color: var(--color-text, #111827); }
.td-progress-note {
  font-size: 11px; color: var(--color-text-muted, #6b7280);
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.td-progress-note-empty { opacity: 0.6; }
.td-progress-edit-btn {
  margin-left: auto; font-size: 11px; padding: 2px 8px;
  border: 1px solid var(--color-border, #d1d5db); border-radius: 6px;
  color: var(--color-text-muted, #4b5563); background: transparent; cursor: pointer;
}
.td-progress-edit-btn:hover { background: var(--color-bg, #f3f4f6); }
.td-progress-form { display: flex; gap: 6px; width: 100%; }
.td-progress-input {
  width: 90px; font-size: 12px; padding: 4px 8px;
  border: 1px solid var(--color-border, #d1d5db); border-radius: 6px;
}
.td-progress-input-note { flex: 1; width: auto; }
.td-progress-save-btn {
  font-size: 12px; padding: 4px 12px; border-radius: 6px; border: none;
  background: var(--tw-blue-600-solid); color: #fff; cursor: pointer;
}
.td-progress-save-btn:disabled { opacity: 0.5; }
/* idea-canvas P1: 构思徽章 + 分类按钮 (在 TaskStatusBar actions 槽, 与删除同排).
   .td-list-btn 尺寸对齐 .tsb-tbtn (min-height 26.5px / radius 4px / 11px 字号),
   融进状态栏一排按钮. */
.td-idea-row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
.td-idea-badge { background: rgba(99, 102, 241, .16); border: 1px solid rgba(129, 140, 248, .45); color: #c7d2fe; border-radius: 8px; padding: 3px 10px; cursor: pointer; font-size: 12px; }
.td-list-put { position: relative; flex-shrink: 0; }
.td-list-btn { background: var(--color-bg-elevated); border: 1px solid var(--color-border, #1f2937); color: var(--color-text-muted, #cbd5e1); border-radius: 4px; padding: 3px 8px; min-height: 26.5px; cursor: pointer; font-size: 11px; }
.td-list-btn:hover { background: var(--tw-gray-50); }
/* position:fixed + :style 注入的 left/top (toggleListMenu 取按钮视口坐标) —
   不能用 absolute: 手机端 .tsb-row 是 overflow-x:auto 滚动容器, absolute 菜单
   会被裁进边界里 (2026-11-04 damo 反馈). fixed 不受祖先 overflow 裁剪. */
.td-list-menu { position: fixed; min-width: 160px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 4px; z-index: 30; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
.td-list-opt { padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; color: #e2e8f0; }
.td-list-opt:hover { background: rgba(99, 102, 241, .2); }
.td-list-empty { padding: 6px 10px; font-size: 12px; color: #64748b; }
</style>