<script setup lang="ts">
/* 功能: 任务指标紧凑 chips — 模型 / 上下文占用 / 成本, 单行内联小字显示.
   用于聊天模式面包屑行尾等窄空间场景 (详情页完整指标行走 TaskMetaRow).
   关注点: 上下文占用配色阈值与 TaskMetaRow 一致 (≥85% 红 / ≥60% 橙 / 其它灰);
   无数据的 chip 整个隐藏 (v-if), 不留空壳; 容器 white-space:nowrap, 溢出由
   父级 flex 布局裁决 (本组件不自行截断). */
import { computed } from 'vue';

interface Props {
  model?: string | null;
  contextTokens?: number | null;
  contextMax?: number | null;
  cost?: number | null;
}
const props = withDefaults(defineProps<Props>(), {
  model: null,
  contextTokens: null,
  contextMax: null,
  cost: null,
});

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

const modelLabel = computed<string>(() => props.model || '默认');

const ctxPct = computed<number | null>(() => {
  if (props.contextTokens == null || props.contextTokens <= 0) return null;
  if (!props.contextMax || props.contextMax <= 0) return null;
  return Math.round((props.contextTokens / props.contextMax) * 100);
});

const ctxColor = computed<string>(() => {
  const pct = ctxPct.value;
  if (pct == null) return 'tmc-neutral';
  if (pct >= 85) return 'tmc-danger';
  if (pct >= 60) return 'tmc-warn';
  return 'tmc-neutral';
});

const ctxText = computed<string>(() => {
  if (props.contextTokens == null || props.contextTokens <= 0) return '';
  const used = formatTokenCount(props.contextTokens);
  const max = props.contextMax ? `/${formatTokenCount(props.contextMax)}` : '';
  const pct = ctxPct.value != null ? ` (${ctxPct.value}%)` : '';
  return `${used}${max}${pct}`;
});

const costText = computed<string | null>(() =>
  props.cost != null && props.cost > 0 ? `$${props.cost.toFixed(3)}` : null,
);
</script>

<template>
  <span class="tmc-root">
    <span class="tmc-chip" :title="`模型: ${modelLabel}`">{{ modelLabel }}</span>
    <span
      v-if="ctxText"
      class="tmc-chip"
      :class="ctxColor"
      title="任务停止时的上下文占用（据此判断是否需要 fork/压缩后继续）"
    >{{ ctxText }}</span>
    <span v-if="costText" class="tmc-chip" :title="`累计成本 ${costText}`">{{ costText }}</span>
  </span>
</template>

<style scoped>
.tmc-root {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-text-muted, #6b7280);
  line-height: 1;
}
/* chip 间「·」分隔 — 首chip不带, 由后一个 chip 的 ::before 画. */
.tmc-chip + .tmc-chip::before {
  content: '·';
  margin: 0 5px;
  color: var(--color-text-muted, #9ca3af);
  opacity: 0.6;
}
.tmc-danger {
  color: var(--tw-red-600, #dc2626);
}
.tmc-warn {
  color: var(--tw-orange-600, #ea580c);
}
.tmc-neutral {
  color: inherit;
}
</style>
