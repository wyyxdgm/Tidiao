"use client";

// 功能: 每 N 毫秒触发一次 re-render — 用于让 task 列表的「X 分钟前」「MM-DD HH:MM」
//   时间显示随时间过去自动刷新 (R161: 时间不刷新需手动 reload 页面才更新).
// 关注点:
//   - 只是 force re-render, 不持有 Date 状态 — 调用方现成的 formatRelativeTime /
//     formatUpdatedAt 内部用 Date.now() 或 parseDbTime, 重 render 时自动用新值.
//   - 默认 60s 与「分钟级精度」(R161) 对齐; 调用方需更细粒度可传 intervalMs.
//   - 卸载清理: clearInterval 防内存泄漏.
//   - 多组件挂载: 每个组件各持一个 interval, 不会共享 — 6 个 task 列表组件共用同一
//     60s 周期, 总开销忽略不计 (一秒钟的 setTimeout 调度).

import { useEffect, useState } from "react";

export function useTick(intervalMs: number = 60_000): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => {
      setTick((x) => (x + 1) % 1_000_000);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
