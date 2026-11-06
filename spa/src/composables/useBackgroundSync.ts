// 功能: 全局后台同步器 (R165) —— 页面**切走 / 浏览器不聚焦**时也按节拍探一次数据,
//   变了才拉全量 (条件 GET + ETag), 没变就只花一个空响应. 用户切回该 tab 时数据
//   已经是新的, 直接渲染, 不再出现"每次进来都要重新加载".
//
// 关注点:
//   - 模块级单例: 整个 SPA 共用一个 setInterval, 10 个 tab 也只 1 个定时器.
//     每个 source 自己去重 (in-flight 不重入) + unregister 时从表里摘掉.
//   - 触发时机 3 种: ① 节拍到点 (默认 60s) ② window focus ③ 页面从后台切回
//     (visibilitychange). ② ③ 是"立刻", 让用户切回来时不用等下一个整分钟.
//   - ⚠️ 不用 document.hidden 停摆: 用户要的就是"我没打开它也在更新". 浏览器
//     对隐藏标签页的定时器有节流 (≥1 次/分钟), 与我们的 60s 天然对齐, 不额外处理.
//   - 单个 source 抛错不打断其他 source (各自 try/catch), 错误挂到 state 上给 UI
//     显示, 下一拍自动重试 —— 后台同步不该因为一次网络抖动就永久停掉.
//   - check() 内部自己管 ETag 与 304; 这里只负责"什么时候调".

import { computed, onBeforeUnmount, ref } from 'vue';

/** 单个数据源的运行态 — 供页面渲染"数据新鲜度"提示 (上次同步 / 有新数据 / 出错). */
export interface SourceState {
  /** 最近一次成功探完的时间戳 (ms). null = 从未成功. */
  lastSyncedAt: number | null;
  /** 上次探到真有变化 (服务端回 200 而非 304). */
  changedAt: number | null;
  /** 最近一次错误信息; 下一次成功自动清空. */
  error: string | null;
}

export interface BackgroundSource {
  /** 唯一 key — 同一 key 重复注册视为替换 (重挂载安全). */
  key: string;
  /** 探一次, 返回"数据是否真的变了" (条件 GET 拿到 200 = 变了, 304 = 没变).
   *  抛错会被捕获并记到 state.error, 不外溢到调用方. */
  check: () => Promise<boolean>;
  /** 是否跟随 focus / visibilitychange 立即探. 默认 true.
   *  置 false 的场景: 探针本身很贵 (全量列表), 或页面在用户看不见的路由上. */
  eagerOnFocus?: boolean;
}

/** 默认节拍 60s. 依据: 用户明确要"分钟级的持续更新", 且浏览器对隐藏标签页
 *  的定时器节流下限也是 1 分钟 —— 再密只是徒增请求. */
export const DEFAULT_SYNC_INTERVAL_MS = 60_000;

const sources = new Map<string, BackgroundSource>();
const inflight = new Set<string>();
const states = ref<Record<string, SourceState>>({});

let timer: ReturnType<typeof setInterval> | null = null;
let listenersBound = false;

function readState(key: string): SourceState {
  return states.value[key] ?? { lastSyncedAt: null, changedAt: null, error: null };
}

function patchState(key: string, patch: Partial<SourceState>): void {
  states.value = { ...states.value, [key]: { ...readState(key), ...patch } };
}

/** 探一个 source. 返回是否真的跑了 (in-flight 去重命中则 false). */
async function probe(src: BackgroundSource): Promise<boolean> {
  if (inflight.has(src.key)) return false;
  inflight.add(src.key);
  try {
    const changed = await src.check();
    patchState(src.key, {
      lastSyncedAt: Date.now(),
      changedAt: changed ? Date.now() : readState(src.key).changedAt,
      error: null,
    });
  } catch (e: unknown) {
    patchState(src.key, {
      error: e instanceof Error ? e.message : '后台同步失败',
    });
  } finally {
    inflight.delete(src.key);
  }
  return true;
}

/** 探一轮所有 source. 串行而不是 Promise.all: 后台轮询请求都很轻, 串行天然
 *  避免多个探针同时打到同一个 SQLite 连接上. */
export async function probeAll(): Promise<void> {
  for (const src of [...sources.values()]) {
    await probe(src);
  }
}

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void probeAll();
  }, DEFAULT_SYNC_INTERVAL_MS);
}

function bindListeners(): void {
  if (listenersBound || typeof window === 'undefined') return;
  listenersBound = true;
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onVisibility);
}

function unbindListeners(): void {
  if (!listenersBound || typeof window === 'undefined') return;
  listenersBound = false;
  window.removeEventListener('focus', onWake);
  document.removeEventListener('visibilitychange', onVisibility);
}

function onWake(): void {
  for (const src of sources.values()) {
    if (src.eagerOnFocus === false) continue;
    void probe(src);
  }
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return;
  onWake();
}

/** 注册一个后台数据源. 在 setup() 里调; 组件卸载自动摘除 (onBeforeUnmount).
 *  重复注册同一 key = 替换旧实现, 不会起两个定时器也不会重复探. */
export function useBackgroundSync(src: BackgroundSource): void {
  sources.set(src.key, src);
  ensureTimer();
  bindListeners();

  onBeforeUnmount(() => {
    // 只删自己这一份: 若 key 已被同 key 的新实例接管, 别把新实例踢掉.
    if (sources.get(src.key) === src) sources.delete(src.key);
    if (sources.size === 0) {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      unbindListeners();
    }
  });
}

/** 读某数据源的运行态 (响应式). 没注册过返回全 null 的初值.
 *  ⚠️ 必须是 computed 而不是 ref 快照 —— 快照只在调用那一刻求值一次, 之后
 *  后台同步更新了 state, 页面上的"上次更新"提示永远不会变. */
export function useBackgroundSyncState(key: string) {
  return computed<SourceState>(
    () => states.value[key] ?? { lastSyncedAt: null, changedAt: null, error: null },
  );
}

/** 立刻探一次指定 key (页面自己决定时机, 例如 tab 被激活时). */
export async function probeNow(key: string): Promise<boolean> {
  const src = sources.get(key);
  if (!src) return false;
  return probe(src);
}

/** 仅供测试: 清空注册表 + 停表. 生产代码不要调. */
export function __resetBackgroundSync(): void {
  sources.clear();
  inflight.clear();
  states.value = {};
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  unbindListeners();
}
