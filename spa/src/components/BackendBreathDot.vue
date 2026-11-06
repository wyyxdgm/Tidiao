<script setup lang="ts">
/* 功能: 后台状态呼吸点 — 挂在 AppHeader 标题旁, 绿色呼吸 = 后台可用, 红色 = 不可用.
   R185 (AO-DEV): 需求是「服务后台不可用就变红灯」的常驻可视信号.
   R185 迭代 (damo 10-05): 原挂在视口右缘中间, damo 反馈「应该在左上角标题
   Agent Orchestrator SPA 旁边」→ 移入 AppHeader brand 之后, inline 随 header 排布.
   关注点:
   - 探测逻辑全在 useBackendHealth 单例, 本组件纯展示 + 负责启动探测.
   - flex-shrink:0 窄屏时优先压缩 brand 文字, 点本身不被压没.
   - pointer-events 保留 (title tooltip 可悬停).
   - prefers-reduced-motion 时呼吸动画降级为静态点 (可访问性).
   - healthy=null (尚未探测) 显示灰色, 探测一次后 (≤5s) 即有真实状态. */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  backendHealthy,
  lastCheckedAt,
  startBackendHealthProbe,
} from '@/composables/useBackendHealth';

startBackendHealthProbe();

const { t } = useI18n();

const stateClass = computed(() =>
  backendHealthy.value === false
    ? 'breath-dot--down'
    : backendHealthy.value === true
      ? 'breath-dot--ok'
      : 'breath-dot--unknown',
);

const title = computed(() => {
  if (backendHealthy.value === true) {
    return t('components.breath.ok', { t: lastCheckedAt.value?.toLocaleTimeString() ?? '' });
  }
  if (backendHealthy.value === false) {
    return t('components.breath.down', { t: lastCheckedAt.value?.toLocaleTimeString() ?? '' });
  }
  return t('components.breath.unknown');
});
</script>

<template>
  <div class="breath-dot" :class="stateClass" :title="title" aria-live="polite">
    <span class="breath-dot__core" />
    <span class="breath-dot__halo" />
  </div>
</template>

<style scoped>
.breath-dot {
  position: relative;
  width: 14px;
  height: 14px;
  margin-left: 8px;
  flex-shrink: 0;
  pointer-events: auto;
  cursor: default;
}
.breath-dot__core,
.breath-dot__halo {
  position: absolute;
  inset: 3px;
  border-radius: 9999px;
}
.breath-dot__halo {
  inset: 0;
  opacity: 0.45;
}
.breath-dot--ok .breath-dot__core,
.breath-dot--ok .breath-dot__halo {
  background: var(--color-success, #16a34a);
}
.breath-dot--down .breath-dot__core,
.breath-dot--down .breath-dot__halo {
  background: var(--color-danger, #dc2626);
}
.breath-dot--unknown .breath-dot__core,
.breath-dot--unknown .breath-dot__halo {
  background: var(--tw-gray-400);
}
/* 呼吸: halo 放大淡出, core 轻微缩放. 红灯常亮不呼吸 (告警态要醒目, 不闪烁) */
.breath-dot--ok .breath-dot__halo {
  animation: breath-halo 2.4s ease-in-out infinite;
}
.breath-dot--ok .breath-dot__core {
  animation: breath-core 2.4s ease-in-out infinite;
}
@keyframes breath-halo {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.45;
  }
  50% {
    transform: scale(1.55);
    opacity: 0.12;
  }
}
@keyframes breath-core {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(0.82);
  }
}
@media (prefers-reduced-motion: reduce) {
  .breath-dot--ok .breath-dot__halo,
  .breath-dot--ok .breath-dot__core {
    animation: none;
  }
}
</style>
