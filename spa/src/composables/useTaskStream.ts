// 功能: 任务流 SSE 共享订阅 — 同一 /api/tasks/{id}/stream url 多消费者共享一条
//   EventSource (引用计数, 末个释放关连接) + 无限重连 (指数退避 3s→30s 封顶 /
//   401 探测关停) + 断线恢复回调 (onReconnect) + 共享连接态 (reactive registry,
//   UI 直接读).
//
// R234 后续项: TaskDetailView 自己开一条流 + 内嵌 TaskTranscript 又开一条同
//   url 流 = 同页 2 条长连接占 HTTP/1.1 每域 6 个并发名额; 收口到 hub 后同页
//   1 条. ChatView (看板聊天模式) 同 url 家族, 一并收口 —— 任务详情页 + 看板
//   聊天模式同开一个任务时也去重.
//
// 关注点:
//   - 重连语义: onerror 时 readyState CLOSED = 服务端一次性 close (401/404/500),
//     探测 /api/user/me——401 关停 (state='closed', router guard 跳登录接管),
//     非 401 走重连; CONNECTING = 临时断开, 直接排重连. 重连 = 显式 close +
//     退避后重建 (EventSource 原生自动重连无法干预 401 "不再重连" 语义).
//   - R256 无限重连: 原 20 次上限在公网隧道抖动 >60s 时把流打进 closed 永久
//     停更 (状态卡在断线瞬间, "任务跑完了还显示运行中" 实证根因). 改为无限
//     重连 + 指数退避 3s→30s 封顶, onopen 归零. 401 仍一次性关停 (避免登录
//     过期无限打转). 退避封顶 30s: 单连接探活成本可忽略, 不再设总次数上限.
//   - R256 onReconnect: 断线后重新连上 (error → onopen) 时广播, 首次建连不
//     触发. 消费方在此重拉数据校准断线窗口内丢的事件 (状态只走 SSE 推送,
//     不补 = 前端状态永久 stale); onerror 置位, onopen 清位并广播 —— 同
//     useTaskEventSource 语义.
//   - attach 幂等, url 支持响应式 (Ref / getter): 切任务时调用方在自己的
//     watch 里重新 attach, core 内部自动 detach 旧 url 再 attach 新 url.
//   - 末个消费者 detach 即销毁 entry (关流 + 清 timer + 摘 registry) —— 重进
//     页面拿全新重试状态, 不残留半死 entry.
//   - state 存 reactive registry (url 键), 消费方用 taskStreamState() 取
//     computed; entry 销毁时删键, computed 自然回落 'idle'.
//   - listeners 回调各自持有 (详情页更新审批/对话弹窗, transcript 拼消息流,
//     互不干扰, 事件各取所需 —— 原先两条连接各收一份, 现在一条连接 fan-out,
//     语义等价).
//   - 'history' 重放语义不变: 服务端连接建立时回放 DB 事件, 断线重连后详情页
//     据此重建未应答弹窗 + 校准状态 (transcript 静默跳过消息, 走 loadHistory).

import { computed, reactive, type Ref } from 'vue';

export type TaskStreamConnState = 'idle' | 'connecting' | 'connected' | 'closed';

/** 重连退避 (R256): 指数退避 3s 起, 每次失败翻倍, 封顶 30s; onopen 归零.
 *  无总次数上限 —— 公网隧道抖动 >60s 是常态 (lanproxy 60s 空闲断连 + nginx
 *  抖动实证), 有限次重连会让流永久停更. */
export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_DELAY_MAX_MS = 30_000;
/** @deprecated R256: 20 次上限已移除 (无限重连), 保留导出仅为旧导入兼容. */
export const MAX_RETRY_COUNT = Infinity;

/** SSE 流事件载荷 (JSON), 各消费方自行取所需字段. */
export type TaskStreamEvent = { type?: string } & Record<string, unknown>;
type Listener = (e: TaskStreamEvent) => void;

/** url → 连接态 (reactive, UI 经 taskStreamState 读). */
const streamStates = reactive<Record<string, { state: TaskStreamConnState; retryCount: number }>>({});

interface Entry {
  es: EventSource | null;
  count: number;
  listeners: Set<Listener>;
  /** R256: 断线恢复回调 (error → onopen 时广播, 首次建连不触发). */
  reconnectListeners: Set<() => void>;
  /** R256: onerror 置位, onopen 消费并广播后清位. */
  reconnecting: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  state: TaskStreamConnState;
  /** 页面隐藏挂起态 (R241): 连接已关还名额, 恢复可见时按 count>0 重建. */
  suspended: boolean;
}

const entries = new Map<string, Entry>();

/** 当前页面隐藏态 — 挂起期间新建的订阅不建流, 恢复可见时统一补建. */
let pageHidden = false;

function syncState(url: string, entry: Entry): void {
  streamStates[url] = { state: entry.state, retryCount: entry.retryCount };
}

function clearReconnectTimer(entry: Entry): void {
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
}

function destroyEntry(url: string, entry: Entry): void {
  clearReconnectTimer(entry);
  if (entry.es) {
    entry.es.close();
    entry.es = null;
  }
  entries.delete(url);
  delete streamStates[url];
}

function openStream(url: string, entry: Entry): void {
  clearReconnectTimer(entry);
  if (entry.es) {
    entry.es.close();
    entry.es = null;
  }
  entry.state = 'connecting';
  syncState(url, entry);
  let es: EventSource;
  try {
    es = new EventSource(url);
  } catch {
    // 构造失败 (极少见, 浏览器不支持等) — 直接 closed, 不重连.
    entry.state = 'closed';
    syncState(url, entry);
    return;
  }
  entry.es = es;

  es.onopen = (): void => {
    entry.retryCount = 0;
    entry.state = 'connected';
    syncState(url, entry);
    // R256: 断线后重新连上 → 广播恢复事件, 让消费方重拉数据校准断线窗口.
    // 首次建连 (reconnecting 未置位) 不触发.
    if (entry.reconnecting) {
      entry.reconnecting = false;
      entry.reconnectListeners.forEach((cb) => cb());
    }
  };

  es.onmessage = (ev: MessageEvent<string>): void => {
    try {
      const event = JSON.parse(ev.data) as TaskStreamEvent;
      entry.listeners.forEach((cb) => cb(event));
    } catch {
      // 解析失败静默, 不阻断整条流.
    }
  };

  es.onerror = (): void => {
    // entry 已被销毁 (末个消费者 detach) — 静默返回, 不碰已删状态.
    if (entries.get(url) !== entry) return;
    entry.reconnecting = true; // R256: 断线, 待重连; 连上后 onopen 广播恢复
    const closed = es.readyState === (typeof EventSource !== 'undefined' ? EventSource.CLOSED : 2);
    es.close();
    entry.es = null;

    if (closed) {
      // 401 探测: 服务端 SSE 401 时响应体是 JSON, onerror 触发; 保险起见
      // probe 一次 /api/user/me, 401 = session 过期, 关停交 router guard.
      void fetch('/api/user/me', { credentials: 'include' })
        .then((r) => {
          if (entries.get(url) !== entry) return; // probe 期间被 detach
          if (r.status === 401) {
            entry.state = 'closed';
            syncState(url, entry);
            return;
          }
          scheduleReconnect(url, entry);
        })
        .catch(() => {
          if (entries.get(url) !== entry) return;
          scheduleReconnect(url, entry);
        });
    } else {
      // readyState CONNECTING: 临时断开, 直接排重连 (不打 /api/user/me,
      // 避免每次网络抖动都 probe).
      scheduleReconnect(url, entry);
    }
  };
}

function scheduleReconnect(url: string, entry: Entry): void {
  if (entry.state === 'closed') return;
  // R256: 指数退避 3s→30s 封顶, 无总次数上限. retryCount 只用于退避计算
  // (和 UI 显示), 不再触发 closed —— 公网隧道抖动 >60s 是常态, 有限次重连
  // 曾把流打进 closed 永久停更 ("跑完了还显示运行中" 实证根因).
  entry.retryCount++;
  entry.state = 'connecting';
  const delay = Math.min(RECONNECT_DELAY_MS * 2 ** (entry.retryCount - 1), RECONNECT_DELAY_MAX_MS);
  syncState(url, entry);
  entry.retryTimer = setTimeout(() => openStream(url, entry), delay);
}

/** 订阅 url: 静态串, 或响应式 (Ref / getter). attach 时按最新 url 建订. */
export type TaskStreamUrlInput = string | Ref<string> | (() => string);

/** 清空模块级单例表 (测试专用, 生产勿调 —— 会硬关所有在用连接). */
export function __resetTaskStream(): void {
  entries.forEach((entry, url) => destroyEntry(url, entry));
  pageHidden = false;
}

// 功能: 页面可见性切换时挂起/恢复全部任务流长连接 (R241, 与 useTaskEventSource
//       同款语义 — 跨 Chrome tab 回收 HTTP/1.1 每域 6 个并发名额).
// 关注点: 挂起要连重连 timer 一起清 (否则 3s 后又把连接建回来); 连接态置 idle,
//       UI (TaskDetailView/transcript 的连接指示) 在用户切回时自然显示重连过程.
export function __setPageHidden(hidden: boolean): void {
  pageHidden = hidden;
  entries.forEach((entry, url) => {
    if (entry.count <= 0) return;
    if (hidden) {
      entry.suspended = true;
      clearReconnectTimer(entry);
      if (entry.es) {
        entry.es.close();
        entry.es = null;
      }
      entry.state = 'idle';
      syncState(url, entry);
    } else if (entry.suspended) {
      entry.suspended = false;
      // closed (重连上限/401) 的流不自动复活, 等调用方显式 re-attach.
      if (entry.state !== 'closed') openStream(url, entry);
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    __setPageHidden(document.hidden);
  });
}

export interface TaskStreamSubscription {
  /** 按当前 url 建立订阅 (幂等: 已订阅同一 url 时 no-op; url 变了则先迁移). */
  attach: () => void;
  /** 释放本订阅 (引用计数 -1, 末个释放者销毁连接与状态). 幂等. */
  detach: () => void;
  /** 当前已订阅的 url (未订阅 = 空串). */
  currentUrl: () => string;
}

/** 核心: 创建一个任务流订阅 (单例 Map + 引用计数 + 无限重连, 不依赖组件
 *  实例, node 环境 vitest 可直测). attach/detach 幂等可重复调用 —— 调用方
 *  用它映射任意生命周期语义 (watch taskId / keep-alive 激活态 / 手动开关). */
export function createTaskStreamSubscription(
  urlInput: TaskStreamUrlInput,
  onEvent: Listener,
  onReconnect?: () => void,
): TaskStreamSubscription {
  let currentUrl = '';
  let subscribed = false;

  const resolveUrl = (): string => {
    if (typeof urlInput === 'string') return urlInput;
    if (typeof urlInput === 'function') return urlInput();
    return urlInput.value;
  };

  function attach(): void {
    const url = resolveUrl();
    if (!url) {
      detach(); // url 变空 = 缺参跳过订阅, 但旧流必须还名额
      return;
    }
    if (subscribed && currentUrl === url) return;
    detach();
    let entry = entries.get(url);
    if (!entry) {
      entry = { es: null, count: 0, listeners: new Set(), reconnectListeners: new Set(), reconnecting: false, retryTimer: null, retryCount: 0, state: 'idle', suspended: pageHidden };
      entries.set(url, entry);
    }
    entry.listeners.add(onEvent);
    if (onReconnect) entry.reconnectListeners.add(onReconnect);
    entry.count++;
    // 首个消费者, 或 entry 已 closed (401 关停) 后有人回来 = 全新重试.
    // 页面隐藏挂起态不建流 (R241: 名额已还给连接池), 恢复可见时统一重建.
    if ((entry.count === 1 || entry.state === 'closed') && !entry.suspended) {
      entry.retryCount = 0;
      openStream(url, entry);
    }
    currentUrl = url;
    subscribed = true;
  }

  function detach(): void {
    if (!subscribed) return;
    subscribed = false;
    const url = currentUrl;
    currentUrl = ''; // 释放即清空: currentUrl() 语义 = 当前已订阅的 url
    const entry = entries.get(url);
    if (!entry) return;
    entry.listeners.delete(onEvent);
    if (onReconnect) entry.reconnectListeners.delete(onReconnect);
    entry.count--;
    if (entry.count <= 0) destroyEntry(url, entry);
  }

  return { attach, detach, currentUrl: () => currentUrl };
}

/** 读某 url 的连接态 (响应式 computed). 未订阅 = idle / 0. */
export function taskStreamState(urlInput: TaskStreamUrlInput): {
  state: import('vue').ComputedRef<TaskStreamConnState>;
  retryCount: import('vue').ComputedRef<number>;
} {
  const resolve = (): string => {
    if (typeof urlInput === 'string') return urlInput;
    if (typeof urlInput === 'function') return urlInput();
    return urlInput.value;
  };
  return {
    state: computed<TaskStreamConnState>(() => streamStates[resolve()]?.state ?? 'idle'),
    retryCount: computed<number>(() => streamStates[resolve()]?.retryCount ?? 0),
  };
}
