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

interface Props {
  /** 最新 checkpoint status 字符串 (原始值). null/undefined → 不渲染. */
  status: string | null | undefined;
}
const props = defineProps<Props>();

interface Tone {
  label: string;
  bg: string;
  text: string;
}

// 镜像 master src/lib/checkpoints/status-display.ts STATUS_MAP (键小写归一后查).
const TONE_MAP: Record<string, Tone> = {
  等回复: { label: '等回复', bg: 'bg-blue-100', text: 'text-blue-700' },
  有建议: { label: '有建议', bg: 'bg-purple-100', text: 'text-purple-700' },
  需拍板: { label: '需拍板', bg: 'bg-orange-100', text: 'text-orange-700' },
  卡住: { label: '卡住', bg: 'bg-red-100', text: 'text-red-700' },
  waiting: { label: '等回复', bg: 'bg-blue-100', text: 'text-blue-700' },
  suggestion: { label: '有建议', bg: 'bg-purple-100', text: 'text-purple-700' },
  decision: { label: '需拍板', bg: 'bg-orange-100', text: 'text-orange-700' },
  blocked: { label: '卡住', bg: 'bg-red-100', text: 'text-red-700' },
  // 自然措辞 alias (同 master)
  待拍板: { label: '需拍板', bg: 'bg-orange-100', text: 'text-orange-700' },
  请选择: { label: '请选择', bg: 'bg-orange-100', text: 'text-orange-700' },
};

const display = computed<Tone | null>(() => {
  if (!props.status) return null;
  return TONE_MAP[props.status.trim().toLowerCase()] ?? null;
});
</script>

<template>
  <span
    v-if="display"
    :title="`最新 checkpoint 子状态：${display.label}`"
    :class="[
      'px-2 py-0.5 rounded-full text-xs whitespace-nowrap',
      display.bg,
      display.text,
    ]"
  >
    {{ display.label }}
  </span>
</template>
