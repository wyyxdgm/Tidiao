// 功能: Fork 自动压缩阈值 (localStorage 读写) - 父任务上下文超过此值时 Fork 弹窗自动勾选「压缩后继续」.
// 关注点: 纯客户端 (UI 偏好, 服务端不参与); SSR 时 typeof window guard; 默认 100000 (100k).

const STORAGE_KEY = "fork-compact-threshold";
const DEFAULT_THRESHOLD = 100000;

export const DEFAULT_COMPACT_THRESHOLD = DEFAULT_THRESHOLD;

// 功能: 读取 Fork 自动压缩阈值 (tokens), 非法值回退默认.
export function getCompactThreshold(): number {
  if (typeof window === "undefined") return DEFAULT_THRESHOLD;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_THRESHOLD;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

// 功能: 持久化 Fork 自动压缩阈值.
export function saveCompactThreshold(n: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // 隐身模式 / 配额满: 静默失败, 不影响功能
  }
}
