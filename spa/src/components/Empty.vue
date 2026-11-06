<script setup lang="ts">
/* 功能: 通用空状态. 内嵌 SVG 插画 + 文案 + 可选 CTA slot. 对应 Next 端裸渲染
   `<p>暂无数据</p>` 的替代实现 —— 提供视觉锚点 + 行动出口, 避免空态死页.
   关注点:
   - 插画走内嵌 SVG, 不引第三方 icon 库 (与项目 UI 风格 "不引重型组件库" 对齐).
   - size 三档对齐 R11 Spinner 的 sm/md/lg, 调用方一处记.
   - 默认 slot 提供 CTA 出口 (按钮/链接), 调用方决定动作; 没 slot 时不渲染占位. */
import { computed } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type EmptySize = 'sm' | 'md' | 'lg';

interface Props {
  /** 主标题. 必填 (空态必须告诉用户"为什么空 / 接下来能做什么"). */
  title: string;
  /** 副标题/说明文案. 可选, 一行简短解释或引导. */
  description?: string;
  /** 视觉尺寸. sm=列表行内 / md=默认卡片 / lg=整页空态 (如"暂无项目"). */
  size?: EmptySize;
  /** 装饰图标名. 选 'inbox' / 'search' / 'folder' / 'doc' / 'check'; 默认 'inbox'.
     每个名对应一个内嵌 SVG path —— 不抽 icon 库避免依赖膨胀. */
  illustration?: 'inbox' | 'search' | 'folder' | 'doc' | 'check';
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  size: 'md',
  illustration: 'inbox',
});

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** 三档尺寸映射到 SVG px 与 padding —— 对齐 R11 Spinner 视觉重量. */
const SIZE_PX: Record<EmptySize, number> = { sm: 48, md: 96, lg: 144 };
const SIZE_PADDING: Record<EmptySize, string> = {
  sm: 'py-6',
  md: 'py-12',
  lg: 'py-20',
};
const SIZE_TITLE: Record<EmptySize, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

const illustPx = computed(() => SIZE_PX[props.size]);
const padding = computed(() => SIZE_PADDING[props.size]);
const titleClass = computed(() => SIZE_TITLE[props.size]);

/* ------------------------------------------------------------------ */
/*  Illustrations                                                      */
/* ------------------------------------------------------------------ */

/* 用 inline path 而非 <use href="#id">: scoped 样式 + dev 工具调试时一目了然,
   避免一个全局 symbol pool 增加心智成本. 每个 path 都画在 24x24 viewBox 里,
   外层 wrapper 用 width/height 控制显示尺寸. */
const ILLUSTRATIONS: Record<NonNullable<Props['illustration']>, string> = {
  // 收件箱/空托盘 —— 默认, 通用空态
  inbox: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  // 放大镜 —— 搜索无结果
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  // 文件夹 —— 列表/目录为空
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  // 文档 —— 详情/记录为空
  doc: 'M14 3v5h5M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V8l-6-5zM9 13h6M9 17h6',
  // 勾 —— 全完成/无待办
  check: 'M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
};
const illustPath = computed(() => ILLUSTRATIONS[props.illustration]);

/** aria-hidden=true: 装饰插画不参与 SR; title 文本已传达"为什么空". */
</script>

<template>
  <div
    class="empty-state"
    :class="padding"
    role="status"
  >
    <svg
      class="empty-illust"
      :width="illustPx"
      :height="illustPx"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path :d="illustPath" />
    </svg>
    <p class="empty-title" :class="titleClass">{{ title }}</p>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Base                                                               */
/* ------------------------------------------------------------------ */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--color-text-muted, #6b7280);
  width: 100%;
}

.empty-illust {
  color: var(--color-text-faint, #d1d5db);
  margin-bottom: 12px;
}

.empty-title {
  margin: 0;
  font-weight: 500;
  color: var(--color-text, #111827);
}

.empty-desc {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--color-text-muted, #6b7280);
  max-width: 360px;
}

.empty-action {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
