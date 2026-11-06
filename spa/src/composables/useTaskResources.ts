// 功能: 任务资源轮询单例 — 定时 GET /api/tasks/resources, 维护 taskId→资源样本 map.
// 多组件 (BoardPage / TaskDetailView / KanbanBoard / TaskCard) 引用共享同一定时器,
// 模块级 state 引用计数, 最后一个消费者释放才停轮询.
// 关注点:
// - 自适应节拍 (R234): 有运行中任务 (样本含 pids) 3s, 空闲降为 10s — 空闲时
//   徽章无数据可刷, 3s 常驻轮询纯占 HTTP/1.1 每域 6 个并发名额.
// - SSE 补采 (R234): 复用侧栏已开的 /api/events 全局流 (共享单例连接, 零新增
//   名额), status_change 去抖 1s 补采一次 — 任务刚起跑时徽章 ≤1s 跟上, 不吃
//   空闲长节拍的延迟.
// - 页面隐藏暂停, 可见立即补一次; setTimeout 链式调度 (对齐 useBackendHealth),
//   每拍结束后按最新样本算下一拍间隔.
// - 静默失败: 采样失败保留旧数据不清空 (watcher 看板不因一次网络抖动闪没), 连续
//   失败仅 console.warn 不弹错.
// - 数据老化: 服务端没命中进程的 task 不出现在响应里, 每次采样后把 map 收敛到
//   最新响应 (进程退出的 task 徽章自然消失).
// - host / titles 仅管理员有值 (服务端按 role 出), 普通用户恒 null/{}.
import { ref } from 'vue';
import { get } from '@/api/http';
import { createEventSourceSubscription } from './useTaskEventSource';

export interface TaskResourceSample {
  pids: number[];
  /** 单核口径 CPU %, 可 >100. */
  cpuPercent: number;
  /** 全机口径 CPU % = cpuPercent / 核心数. */
  hostCpuPercent: number;
  /** 进程树 RSS 合计 MB. */
  memRssMB: number;
  /** 占全机内存 %. */
  memPercent: number;
  sampledAt: number;
}

/** R232 追加: 系统级总览 (仅管理员). 与后端 HostResourceSummary 对齐. */
export interface HostResourceSummary {
  cpuCores: number;
  /** 全机 CPU 已用 % (所有进程), 0~100. */
  cpuUsedPercent: number;
  /** 平台任务合计 CPU % (全机口径). */
  taskCpuPercent: number;
  memTotalMB: number;
  memUsedMB: number;
  taskMemMB: number;
  /** 1 分钟负载 ÷ 核心数 ×100 (宝塔口径), 可 >100. */
  loadPercent: number;
  /** 根分区磁盘; 后端 statfs 不可用时 null. */
  disk: { totalGB: number; usedGB: number; usedPercent: number } | null;
  sampledAt: number;
}

interface ResourcesResponse {
  tasks: Record<string, TaskResourceSample>;
  titles?: Record<string, string>;
  host?: HostResourceSummary | null;
  count: number;
}

export const POLL_INTERVAL_MS = 3_000;
/** 空闲节拍: 样本里没有任何运行中任务时降频 (R234), 省常驻请求. */
export const IDLE_POLL_INTERVAL_MS = 10_000;
/** status_change 补采去抖: 事件突发合并成一次采样. */
export const EVENT_NUDGE_DEBOUNCE_MS = 1_000;

/** taskId → 最新资源样本. 模块级单例, 多组件共享. */
export const taskResources = ref<Record<string, TaskResourceSample>>({});

/** taskId → 标题 (看板顶部系统条 hover 用; 普通用户也有本人任务的). */
export const taskResourceTitles = ref<Record<string, string>>({});

/** 系统总览 (仅管理员, 其余恒 null). */
export const hostResourceSummary = ref<HostResourceSummary | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
let refCount = 0;
let inFlight = false;

async function sample(): Promise<void> {
  if (inFlight) return; // 上一轮还没回来不叠加 (慢网络下防堆积)
  inFlight = true;
  try {
    const data = await get<ResourcesResponse>('/api/tasks/resources');
    taskResources.value = data?.tasks ?? {};
    taskResourceTitles.value = data?.titles ?? {};
    hostResourceSummary.value = data?.host ?? null;
  } catch {
    // 静默: 轮询失败保留旧数据. 401 时 http.ts 已走 refresh+跳登录, 这里不用管.
  } finally {
    inFlight = false;
  }
  scheduleNext();
}

/** 样本里是否有运行中任务 (有进程 = 运行) — 决定下一拍快慢. */
function hasRunningTask(): boolean {
  return Object.values(taskResources.value).some((t) => t.pids.length > 0);
}

/** 链式调度下一拍 (对齐 useBackendHealth): 每次采样后按最新样本算间隔. */
function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (refCount === 0) return; // 消费者已全释放 (in-flight 尾巴), 不再排
  if (typeof document !== 'undefined' && document.hidden) return; // 可见时 visibilitychange 再起
  timer = setTimeout(
    () => void sample(),
    hasRunningTask() ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
  );
}

function onVisibilityChange(): void {
  if (!document.hidden) void sample();
}

/** status_change 补采订阅 — 复用侧栏已开的 /api/events 全局流 (单例共享连接,
 *  零新增名额), 任务起跑/状态翻转时去抖补采, 徽章延迟从「下一拍 (空闲最长
 *  10s)」收敛到 ≤1s. attach/detach 挂在 acquire/release 上, 与轮询同生命周期. */
const eventSub = createEventSourceSubscription('/api/events', (e) => {
  if (e.type === 'status_change') nudgeSample();
});

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

function nudgeSample(): void {
  if (refCount === 0) return;
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    if (refCount > 0 && !inFlight) void sample();
  }, EVENT_NUDGE_DEBOUNCE_MS);
}

/** 组件挂载时调: 引用计数 +1, 首次立即采样并起调度链. */
export function acquireTaskResourcesPolling(): void {
  refCount++;
  if (refCount === 1) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    eventSub.attach();
    void sample();
  }
}

/** 组件卸载时调: 引用计数 -1, 归零停调度链 + 摘 SSE 补采订阅. */
export function releaseTaskResourcesPolling(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    if (timer) clearTimeout(timer);
    timer = null;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = null;
    eventSub.detach();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    taskResources.value = {};
    taskResourceTitles.value = {};
    hostResourceSummary.value = null;
  }
}

/** 测试专用: 重置单例 state. */
export function __resetTaskResources(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = null;
  refCount = 0;
  inFlight = false;
  eventSub.detach();
  taskResources.value = {};
  taskResourceTitles.value = {};
  hostResourceSummary.value = null;
}
