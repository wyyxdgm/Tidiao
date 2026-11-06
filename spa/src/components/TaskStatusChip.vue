<script setup lang="ts">
/* 功能: 渲染 4 色 sub-status chip — 标识任务最新 checkpoint 的子状态
   (等回复/有建议/需拍板/卡住 + 自然措辞 alias). 完整镜像 master
   src/lib/checkpoints/status-display.ts (damo 1007 对齐: 旧内联表只有
   awaiting_reply/has_suggestion 等 4 个键, 与 parser 实际产出的中文/规范
   英文值全对不上 → SPA 上 chip 静默丢失; 这里改为全量镜像 + alias).
   关注点:
   - status = null/空 → 组件返回 null 不渲染 (父级可省条件挂载).
   - master 加别名时本表要跟着加 (镜像关系, 无 import — SPA 独立构建).
   - 不挂 onClick / href, 纯展示. 父级若把 chip 嵌在 <Link> 内不需要 stopPropagation. */

import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
  /** 最新 checkpoint status 字符串 (原始值). null/undefined → 不渲染. */
  status: string | null | undefined;
}
const props = defineProps<Props>();
const { t } = useI18n();

interface Tone {
  // i18n: 键仍是后端产出的原始 status 值 (含中文值, 不可翻), label 走 locale key.
  labelKey: string;
  bg: string;
  text: string;
}

// 镜像 master src/lib/checkpoints/status-display.ts STATUS_MAP (键小写归一后查).
const TONE_MAP: Record<string, Tone> = {
  等回复: { labelKey: 'tasks.kanban.marker.waitingReply', bg: 'bg-blue-100', text: 'text-blue-700' },
  有建议: { labelKey: 'tasks.kanban.marker.suggestion', bg: 'bg-purple-100', text: 'text-purple-700' },
  需拍板: { labelKey: 'tasks.kanban.marker.review', bg: 'bg-orange-100', text: 'text-orange-700' },
  卡住: { labelKey: 'tasks.kanban.marker.stuck', bg: 'bg-red-100', text: 'text-red-700' },
  waiting: { labelKey: 'tasks.kanban.marker.waitingReply', bg: 'bg-blue-100', text: 'text-blue-700' },
  suggestion: { labelKey: 'tasks.kanban.marker.suggestion', bg: 'bg-purple-100', text: 'text-purple-700' },
  decision: { labelKey: 'tasks.kanban.marker.review', bg: 'bg-orange-100', text: 'text-orange-700' },
  blocked: { labelKey: 'tasks.kanban.marker.stuck', bg: 'bg-red-100', text: 'text-red-700' },
  // 自然措辞 alias (同 master)
  待拍板: { labelKey: 'tasks.kanban.marker.review', bg: 'bg-orange-100', text: 'text-orange-700' },
  请选择: { labelKey: 'tasks.chip.pleaseSelect', bg: 'bg-orange-100', text: 'text-orange-700' },
};

const display = computed<Tone | null>(() => {
  if (!props.status) return null;
  return TONE_MAP[props.status.trim().toLowerCase()] ?? null;
});

const displayLabel = computed<string | null>(() => (display.value ? t(display.value.labelKey) : null));
</script>

<template>
  <span
    v-if="display"
    :title="t('tasks.chip.latestSubStatus', { s: displayLabel ?? '' })"
    :class="[
      'px-2 py-0.5 rounded-full text-xs whitespace-nowrap',
      display.bg,
      display.text,
    ]"
  >
    {{ displayLabel }}
  </span>
</template>
