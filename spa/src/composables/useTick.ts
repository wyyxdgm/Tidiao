/* 功能: 每 N 毫秒强制一次 re-render — 让 task 列表的 updated_at 时间显示
   (例如 "MM-DD HH:MM") 在用户长时间停留时自动刷新, 不用手动 reload.

   关注点:
   - 只是 force re-render, 不持有 Date 状态 — 调用方 formatUpdatedAt 用
     Date / parseDbTime, 重 render 时自动取新值.
   - 默认 60s = 分钟级精度 (与 master useTick 同口径).
   - 卸载清理: clearInterval 防内存泄漏 (onBeforeUnmount 在 setup 顶层
     注册, 与 onMounted 同生命周期阶段). */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export function useTick(intervalMs: number = 60_000): Ref<number> {
  const tick = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  onMounted(() => {
    if (intervalMs <= 0) return;
    timer = setInterval(() => {
      tick.value = (tick.value + 1) % 1_000_000;
    }, intervalMs);
  });

  onBeforeUnmount(() => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });

  return tick;
}