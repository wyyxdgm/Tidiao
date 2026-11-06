<!-- 功能: 任务资源徽章 (R232) — 运行中任务的 CPU / 内存实时占用.
     纯展示: 数据由父级 (useTaskResources 单例轮询) 传入, sample 为空不渲染.
     关注点:
     - cpuPercent 是单核口径 (可 >100, 进程树多进程合计); hostCpuPercent 是
       全机口径. 主显示用单核口径 (agent 干活强度直觉), title 里给两种口径 + pids.
     - 样式同 .tsb-tbtn 色系 (灰边框 pill, 数字用 mono), 不引 Tailwind.
     - R243: min-width 钉住常态宽度 + 内容居中 — CPU/mem 数值每 2s 采样呼吸
       (实测 160.5↔185px) 会让 auto 布局的列表表格整表重排 (右列每 2s 跳 ~9px).
       185 = 实测极值 "CPU 127.4% · 1024.9MB (54.2%)" 的自然宽; mem>10GB 等超宽
       场景罕见且一旦出现即稳定, 不构成抖动源. -->
<script setup lang="ts">
import { computed } from 'vue';
import type { TaskResourceSample } from '@/composables/useTaskResources';

interface Props {
  sample: TaskResourceSample | null;
  /** 是否高负载警示 (CPU>80% 或 内存>50%) — 亮橙底提醒. */
  warn?: boolean;
}

const props = withDefaults(defineProps<Props>(), { warn: false });

const visible = computed(() => !!props.sample);
const cpu = computed(() => props.sample?.cpuPercent ?? 0);
const mem = computed(() => props.sample?.memRssMB ?? 0);
const memPct = computed(() => props.sample?.memPercent ?? 0);

const title = computed(() => {
  if (!props.sample) return '';
  const s = props.sample;
  return [
    `进程数 ${s.pids.length} (pid ${s.pids.slice(0, 5).join(',')}${s.pids.length > 5 ? '…' : ''})`,
    `CPU ${s.cpuPercent}% (单核口径, 全机口径 ${s.hostCpuPercent}%)`,
    `内存 ${s.memRssMB}MB (占全机 ${s.memPercent}%)`,
    `采样 ${new Date(s.sampledAt).toLocaleTimeString()}`,
  ].join('\n');
});

const warnStyle = computed(() =>
  props.warn
    ? { color: 'var(--tw-orange-700)', background: 'var(--tw-orange-50)', borderColor: 'var(--tw-orange-300)' }
    : { color: 'var(--tw-sky-700)', background: 'var(--tw-sky-50)', borderColor: 'var(--tw-sky-200)' },
);
</script>

<template>
  <span v-if="visible" class="trb-root" :title="title" :style="warnStyle">
    <span class="trb-seg">CPU {{ cpu }}%</span>
    <span class="trb-divider">·</span>
    <span class="trb-seg">{{ mem }}MB ({{ memPct }}%)</span>
  </span>
</template>

<style scoped>
.trb-root {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 9999px;
  border: 1px solid transparent;
  white-space: nowrap;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  cursor: default;
  /* R243: 钉住宽度防采样呼吸推挤布局 (依据见文件头注释). */
  min-width: 185px;
  justify-content: center;
}
.trb-divider {
  opacity: 0.5;
}
</style>
