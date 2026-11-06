// 按 timestamp 二分插入到数组; 新 item 放在现有等时间戳之后 (stable sort, SDK 顺序保留).
//
// 关注 bug R155 (damo 2026-09-20): DB event message 的 timestamp 透传之前,
//   前端 messageTimestamp 拿不到 timestamp → undefined → 原实现 `?? 0` 让 item
//   ts = 0. SDK uuid v7 反算 ms 都是 1.7T+, 二分时 0 永远最小 → DB event 排到
//   第一位 ("直接触发发送。我看看" 跑到 prompt 前面).
//
// 修法: 兜底改 Number.MAX_SAFE_INTEGER — 没时间戳的消息排到末尾. 与后端
//   agent-runtime.ts tsOf 的 event-? 兜底方向一致 (都是 MAX_SAFE_INTEGER).
//
// 抽到独立文件 = 便于 vitest 单测 (React 组件本身需要 jsdom, 项目未配).

export type WithTimestamp = {
  timestamp?: number;
};

// Insert into a timestamp-ordered array, stable for ties (new item placed
// after existing equal-timestamp entries so SDK message order is preserved).
export function insertByTimestamp<T extends WithTimestamp>(
  arr: T[],
  item: T,
): void {
  const ts = item.timestamp ?? Number.MAX_SAFE_INTEGER;
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid].timestamp ?? Number.MAX_SAFE_INTEGER) <= ts) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
}