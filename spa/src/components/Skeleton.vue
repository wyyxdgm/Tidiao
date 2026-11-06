<script setup lang="ts">
/* 功能: 骨架屏占位. background 渐变 + animation 实现 shimmer 效果,
   可配 width/height (支持 px / % / 任意 CSS 长度). 用于加载首屏前的占位.
   关注点:
   - 渐变方向水平 (to right) —— 中文页面阅读方向, 视觉习惯横向扫.
   - 动画 1.4s 循环 + ease-in-out —— 与主流 UI 库 (MUI / Ant Design / Chakra) 默认值对齐, 不显呆滞.
   - width/height 默认值给常见行内文字 / 段落占位 —— 父组件不传也能直接用.
   - 自定义形状 (圆形头像 / 圆角按钮) 用 round=true, height 仍然受控. */
import { computed } from 'vue';

interface Props {
  /** 宽度. 任意 CSS 长度 (px / % / rem). 默认 '100%' —— 跟父容器宽度走. */
  width?: string;
  /** 高度. 任意 CSS 长度. 默认 '14px' —— 接近一行正文高度. */
  height?: string;
  /** 圆角. true = 50% 圆形 (头像/图标), false = 跟全局 --radius 一致 (矩形文字行). */
  round?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  width: '100%',
  height: '14px',
  round: false,
});

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

const borderRadius = computed(() => (props.round ? '50%' : 'var(--radius)'));
</script>

<template>
  <span
    class="skeleton"
    :class="{ 'skeleton-round': round }"
    :style="{
      width,
      height,
      borderRadius,
    }"
    aria-hidden="true"
  />
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Base                                                               */
/* ------------------------------------------------------------------ */
.skeleton {
  display: inline-block;
  vertical-align: middle;
  background: linear-gradient(
    90deg,
    rgba(229, 231, 235, 0.4) 0%,
    rgba(229, 231, 235, 0.85) 50%,
    rgba(229, 231, 235, 0.4) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}
</style>
