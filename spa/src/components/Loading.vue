<script setup lang="ts">
/* 功能: 通用加载指示器. CSS border-spinner (不依赖第三方 icon 库),
   3 档尺寸 (sm/md/lg) + color prop. 对应 Next 内联 SVG ButtonSpinner 的替代实现.
   关注点:
   - 纯 CSS 实现 + aria-hidden=true —— 装饰元素不打扰 SR.
   - color 默认 currentColor, 跟着父元素文字色走 (放进 Button / primary / danger 背景时不用手动改).
   - 显式 color 入参时走 prop 控制 —— 用于脱离文字色的场景 (如全屏 loading overlay). */
import { computed } from 'vue';

export type SpinnerSize = 'sm' | 'md' | 'lg';

interface Props {
  /** 视觉尺寸. sm=12px (嵌入按钮/行内) / md=16px (默认, 通用) / lg=24px (全屏加载/空状态). */
  size?: SpinnerSize;
  /** 颜色. 默认 'currentColor' —— 跟随父元素 color, 适配大多数场景.
     显式传值时走 CSS color 字符串 (如 'var(--tw-blue-600)' / 'var(--color-primary)' / 'white'). */
  color?: string;
  /** 可选 a11y label. 提供时屏幕阅读器会播报; 默认隐藏 (装饰元素). */
  label?: string;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  color: 'currentColor',
  label: '',
});

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** 尺寸映射到 px. 与 Button.vue 的 .btn-spinner (12px) 视觉对齐. */
const SIZE_PX: Record<SpinnerSize, number> = {
  sm: 12,
  md: 16,
  lg: 24,
};

const sizePx = computed(() => SIZE_PX[props.size]);
/** 边框粗细按比例缩放, 保持视觉重量一致. */
const borderPx = computed(() => Math.max(2, Math.round(sizePx.value / 8)));
</script>

<template>
  <span
    class="loading-spinner"
    :class="`loading-spinner-${size}`"
    :style="{
      width: `${sizePx}px`,
      height: `${sizePx}px`,
      borderWidth: `${borderPx}px`,
      color: color,
    }"
    role="status"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Base                                                               */
/* ------------------------------------------------------------------ */
.loading-spinner {
  display: inline-block;
  border-style: solid;
  border-color: currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: loading-spin 0.7s linear infinite;
  flex-shrink: 0;
  vertical-align: middle;
  /* 默认无障碍角色由 role="status" 承担, 但纯装饰时 role 也保留避免被某些 SR 视为文字. */
}

@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
