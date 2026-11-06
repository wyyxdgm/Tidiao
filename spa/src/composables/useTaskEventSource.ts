// 功能: 全局 SSE 订阅 composable — Vue 3 1:1 复刻 master
//   src/lib/use-global-event-source.ts.
//
// 模块级单例: 同一 url 共享一条 EventSource + 引用计数 + 回调集合.
// 同一全局事件流被 GlobalBoard / BoardPage / ProjectSidebar 等共享一条长连接,
// 避免重复订阅占满浏览器 HTTP/1.1 同域并发名额 (每域 6 个).
//
// R233 keep-alive 感知 (2026-10-10):
//   - 旧版清理只挂 onBeforeUnmount —— keep-alive 缓存的组件切走不卸载, 引用
//     计数只增不减, 后台 tab 的 SSE 长连接永不还名额. R228 已实证: 名额被
//     吃光后所有 fetch (含发消息 POST) 在浏览器排队无限 pending, 页面「点了
//     不反应」. R228 当时逐组件手修 4 处 (TaskDetail / Chat / Transcript /
//     Schedules), 漏了走本 composable 的 BoardPage —— 本版在 composable 层
//     统一收口: onDeactivated 断流还名额, onActivated 重连.
//   - url 支持响应式 (Ref / getter): BoardPage 是 keep-alive 复用实例, 切
//     项目时旧版传 .value 快照 = 订阅停留在首个项目的事件流不迁移. 现在监
//     听 url 变化自动 detach 旧流 + attach 新流.
//
// R241 跨 Chrome tab 挂起 + detach 残留修复 (2026-10-12):
//   - R233 的 keep-alive 钩子管不到「同一浏览器开 N 个平台 tab」: 每个 tab 的
//     ProjectSidebar (keep-alive 外) 永久持一条 /api/events, N≥6 吃光每域 6 个
//     名额 → 新 tab 连 HTML 文档都拿不到连接, 无限 pending. 现在监听
//     visibilitychange: 页面隐藏挂起全部连接, 恢复可见按 count>0 重建.
//   - 修复 detach(): 旧版先清 currentUrl 再 streams.delete(currentUrl), 删的是
//     streams[''] no-op, 已 close 的 entry 残留 map → 重新 attach 复用死连接
//     永不重连 (侧栏/看板「静默停更」根因).
//
// R245 重连回调 (2026-10-15):
//   - 服务端 /api/events 无 Last-Event-ID 回放, SSE 断线窗口 (服务器重启 /
//     网络抖动 / 浏览器 tab 挂起) 内的 status_change 事件永久丢失 — 只挂
//     「收到事件才刷」的消费方 (侧栏徽章 / 看板卡片) 状态僵死, 手动刷新才恢复.
//   - 现在 onerror 置 reconnecting, onopen 且置位时广播 onReconnect 回调
//     (首次建连不触发); 挂起恢复重建视同重连. 订阅方在回调里强刷本地数据
//     (侧栏 counts / 看板两段), 兜住断线窗口丢事件.
//
// 关注点:
//   - onEvent 用 closure 直接捕获调用方 setup 的响应式 ref, 不需要 cbRef: Vue
//     setup() 在每个组件实例只跑一次, 函数引用稳定.
//   - onerror 探测 401 (session 过期), 主动关闭避免 EventSource 默认无限重连,
//     交由 router guard 跳登录页 (与 master 同款).
//   - parse 失败静默 (与 master use-global-event-source.ts:39 同款), 单条脏数据
//     不应阻断整条流.
//   - url 为空串不建流 (new EventSource('') 会解析为当前页面 url 产生垃圾
//     请求), 调用方 (BoardPage) 用它表达「projectId 缺参, 跳过订阅」.
//   - 核心订阅逻辑抽成 createEventSourceSubscription (不依赖组件实例, node
//     环境 vitest 可直测); useTaskEventSource 只做 vue 生命周期包装
//     (onActivated/onDeactivated/onBeforeUnmount + url watch).

import { onActivated, onBeforeUnmount, onDeactivated, watch, type Ref } from 'vue';

/** SSE 推送事件 (服务端 emitEvent 出来的 AgentEvent 形状, 字段集合见
 *  src/lib/runtime/types.ts AgentEvent 联合 + StatusChangeEvent / CostEvent). */
export interface GlobalEvent {
  type: string;
  task_id?: string;
  to?: string;
  from?: string;
  cost_usd?: number;
  [key: string]: unknown;
}

type Listener = (e: GlobalEvent) => void;

interface Entry {
  url: string;
  es: EventSource | null;
  count: number;
  listeners: Set<Listener>;
  /** 重连回调 (R245): 断线窗口内事件永久丢失 (服务端无 Last-Event-ID 回放),
   *  订阅方在真重连时据此强刷本地数据. */
  reconnectListeners: Set<() => void>;
  /** 页面隐藏挂起态: 连接已关 (名额还给连接池), 恢复可见时按 count>0 重建. */
  suspended: boolean;
  /** 断线待重连标记: onerror 置位 (含挂起恢复重建), onopen 且已置位 = 真重连,
   *  通知全部 reconnectListeners 后清位. 首次建连不置位 → 不触发回调. */
  reconnecting: boolean;
}

/** 订阅 url: 静态串, 或响应式 (Ref / getter). 响应式 url 变化时自动迁移订阅. */
export type EventSourceUrlInput = string | Ref<string> | (() => string);

const streams = new Map<string, Entry>();

/** 当前页面隐藏态 — 挂起期间新建的订阅不建流, 恢复可见时统一补建. */
let pageHidden = false;

/** 清空模块级单例表 (测试专用, 生产勿调 —— 会硬关所有在用连接). */
export function __resetUseTaskEventSource(): void {
  streams.forEach((entry) => entry.es?.close());
  streams.clear();
  pageHidden = false;
}

export interface EventSourceSubscription {
  /** 按当前 url 建立订阅 (幂等: 已订阅同一 url 时 no-op; url 变了则先迁移). */
  attach: () => void;
  /** 释放本订阅 (引用计数 -1, 末个释放者关连接). 幂等. */
  detach: () => void;
  /** 当前已订阅的 url (未订阅 = 空串). */
  currentUrl: () => string;
}

// 功能: 为 entry 建一条 EventSource 长连接并挂 message/error 处理 (attach 与
//       可见性恢复共用; 抽出来是为了挂起/重建不重复内联创建逻辑).
// R245 重连探测: EventSource 断线后浏览器自动用同一实例重连并重触发 onopen,
//   没有原生「重连成功」事件 — 用 reconnecting 标记区分「首次 onopen」与
//   「error 后 onopen」, 只对后者广播 reconnectListeners (订阅方强刷数据).
function openEntry(url: string, entry: Entry): void {
  const es = new EventSource(url);
  es.onopen = () => {
    if (!entry.reconnecting) return; // 首次建连, 不算重连
    entry.reconnecting = false;
    entry.reconnectListeners.forEach((cb) => cb());
  };
  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as GlobalEvent;
      entry.listeners.forEach((cb) => cb(event));
    } catch {
      // 解析失败静默, 不阻断整条流.
    }
  };
  es.onerror = () => {
    entry.reconnecting = true; // 断线, 待重连; 浏览器同实例自动重连后 onopen 触发广播
    // session 过期时服务端返 401, EventSource 默认无限重连.
    // 探测一次, 401 则关闭连接, 交由上层 (router guard) 跳登录页.
    fetch('/api/user/me', { credentials: 'include' })
      .then((r) => {
        if (r.status === 401) {
          es.close();
          streams.delete(url);
        }
      })
      .catch(() => {});
  };
  entry.es = es;
}

/** 核心: 创建一个 SSE 订阅 (单例 Map + 引用计数, 不依赖组件实例).
 *
 *  attach/detach 幂等可重复调用 —— 调用方用它映射任意生命周期语义
 *  (vue 钩子 / keep-alive 激活态 / 手动开关). */
export function createEventSourceSubscription(
  urlInput: EventSourceUrlInput,
  onEvent: (e: GlobalEvent) => void,
  onReconnect?: () => void,
): EventSourceSubscription {
  const listener: Listener = (e) => onEvent(e);
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
      detach(); // url 变空 = 缺参跳过订阅, 但旧流必须还名额 (不能挂着)
      return;
    }
    if (subscribed && currentUrl === url) return;
    detach();
    let entry = streams.get(url);
    if (!entry) {
      entry = { url, es: null, count: 0, listeners: new Set(), reconnectListeners: new Set(), suspended: pageHidden, reconnecting: false };
      streams.set(url, entry);
    }
    entry.listeners.add(listener);
    if (onReconnect) entry.reconnectListeners.add(onReconnect);
    entry.count++;
    // 挂起态 (页面隐藏) 不建流 — 名额已还给连接池, 恢复可见时统一补建.
    if (!entry.es && !entry.suspended) openEntry(url, entry);
    currentUrl = url;
    subscribed = true;
  }

  function detach(): void {
    if (!subscribed) return;
    subscribed = false;
    // 🔴 先取 url 再清 currentUrl: 下面 streams.delete 要用真实键.
    //     (旧版先清再用, delete('') 静默 no-op, 已 close 的 entry 残留 map,
    //     下次 attach 复用死连接永不重连 —— 2026-10-12 修复.)
    const url = currentUrl;
    currentUrl = '';
    const ent = streams.get(url);
    if (!ent) return;
    ent.listeners.delete(listener);
    if (onReconnect) ent.reconnectListeners.delete(onReconnect);
    ent.count--;
    if (ent.count <= 0) {
      ent.es?.close();
      streams.delete(url);
    }
  }

  return { attach, detach, currentUrl: () => currentUrl };
}

// 功能: 页面可见性切换时挂起/恢复全部 SSE 长连接 (跨 Chrome tab 版 R233 收口).
// 关注点: R228/R233 的 keep-alive 钩子只管 SPA 内部 tab 切换, 管不到「同一浏览器
//   开 N 个平台 tab」—— 每个 tab 一条 /api/events (ProjectSidebar 在 keep-alive
//   外, 永不释放), N≥6 时 HTTP/1.1 每域 6 个名额被吃光, 新 tab 连 HTML 文档都
//   拿不到连接, 页面无限 pending (2026-10-12 实证). 页面隐藏 = 用户看不到实时
//   流, 挂起不损功能; 恢复可见按 count>0 重建. 挂起期间丢掉的增量事件由调用方
//   的 getIfChanged 条件轮询兜底 (R165).
export function __setPageHidden(hidden: boolean): void {
  pageHidden = hidden;
  streams.forEach((entry, url) => {
    if (entry.count <= 0) return;
    if (hidden) {
      entry.suspended = true;
      entry.es?.close();
      entry.es = null;
    } else if (entry.suspended) {
      entry.suspended = false;
      if (!entry.es) {
        // R245: 挂起窗口内事件已丢, 恢复重建视同重连 — onopen 时广播订阅方强刷.
        entry.reconnecting = true;
        openEntry(url, entry);
      }
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    __setPageHidden(document.hidden);
  });
}

/** 订阅任意 url 的 SSE 流 (单例 + 引用计数 + keep-alive 感知). 多消费者共享
 *  一条 EventSource, 末个消费者释放才关闭连接. onEvent 收到每条解析后的事件.
 *  R245: onReconnect 可选 — 仅在「error 断线后重新 onopen」或「页面隐藏挂起
 *  后恢复重建」时触发 (首次建连不触发), 断线窗口内丢失的事件由订阅方在此强刷.
 *
 *  释放时机: 组件卸载 (onBeforeUnmount) 或 keep-alive 切走 (onDeactivated);
 *  keep-alive 切回 (onActivated) / url 变化时自动按最新 url 重连.
 *  调用方通常在 setup() 顶层调用. */
export function useTaskEventSource(
  urlInput: EventSourceUrlInput,
  onEvent: (e: GlobalEvent) => void,
  onReconnect?: () => void,
): void {
  const sub = createEventSourceSubscription(urlInput, onEvent, onReconnect);
  sub.attach();

  // paused = keep-alive 后台态: url 变化不建流 (省每域 6 个并发名额),
  // 切回时 onActivated 按最新 url 重连.
  let paused = false;

  // 响应式 url (Ref / getter): 变化时迁移订阅 (attach 幂等, url 变了自动
  // detach 旧流 + attach 新流). 静态 string 无需 watch.
  if (typeof urlInput !== 'string') {
    const dynamic = urlInput as Ref<string> | (() => string);
    watch(
      () => (typeof dynamic === 'function' ? dynamic() : dynamic.value),
      () => {
        if (!paused) sub.attach();
      },
    );
  }

  onDeactivated(() => {
    paused = true;
    sub.detach();
  });
  onActivated(() => {
    paused = false;
    sub.attach();
  });
  onBeforeUnmount(() => sub.detach());
}
