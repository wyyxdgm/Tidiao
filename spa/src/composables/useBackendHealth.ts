// 功能: 后台健康轮询单例 — 定时 GET /api/health, 维护 healthy + lastCheckedAt.
// 多组件引用共享同一定时器 (模块级 state), MainLayout 挂 BackendBreathDot 即生效.
// 关注点: 裸 fetch 不走 api/http (那里 401 会触发 token refresh 副作用);
// 健康→异常立即亮红灯 (醒目是需求), 异常→恢复用短间隔 (5s) 快速回绿;
// 页面隐藏时 (document.hidden) 暂停轮询省开销, 可见时立即补一次;
// typeof document 守卫对齐 useBackgroundSync (node 测试环境无 document).
import { ref } from 'vue';

export const backendHealthy = ref<boolean | null>(null); // null = 尚未探测
export const lastCheckedAt = ref<Date | null>(null);

export const OK_INTERVAL_MS = 30_000;
export const RETRY_INTERVAL_MS = 5_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

async function probe(): Promise<void> {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    backendHealthy.value = res.ok;
  } catch {
    backendHealthy.value = false;
  }
  lastCheckedAt.value = new Date();
  schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (typeof document !== 'undefined' && document.hidden) return; // 可见时 visibilitychange 再起
  timer = setTimeout(
    probe,
    backendHealthy.value ? OK_INTERVAL_MS : RETRY_INTERVAL_MS,
  );
}

// 页面重新可见时立即补探测 (hidden 期间 schedule 停摆)
function onVisibilityChange(): void {
  if (!document.hidden) probe();
}

export function startBackendHealthProbe(): void {
  if (started) return;
  started = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  void probe();
}

/** 测试专用: 清定时器 + 重置单例 state, 用例间隔离. */
export function __resetBackendHealth(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  backendHealthy.value = null;
  lastCheckedAt.value = null;
}
