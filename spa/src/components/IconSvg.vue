<script setup lang="ts">
/* 功能: 自定义 SVG 图标组件, 替代系统 emoji.
   关注点:
   - 10 种图标 (play/pause/check/refresh/x/trash/fork/lines/list/expand-list) 全部走 stroke 或 fill currentColor,
     跟 Button 文字色绑, primary/secondary/danger/ghost 切 variant 自动跟着换色.
   - viewBox 14×14 统一, width/height 直接挂 SVG 属性 (不用 scoped CSS,
     之前测出来 scoped class 在 Fragment 渲染下不总能命中, SVG 默认
     300×150 会把按钮挤爆). 不传 name 或 name 不识别 = 渲染空 (兜底).
   - 14×14 viewBox + 12px 渲染尺寸, 视觉跟之前 emoji 等大. */
defineProps<{ name: string }>();
</script>

<template>
  <svg
    v-if="name === 'play'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="currentColor"
    aria-hidden="true"
    class="icon-svg"
  >
    <path d="M3.5 2 L11.5 7 L3.5 12 Z" />
  </svg>
  <svg
    v-else-if="name === 'pause'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="currentColor"
    aria-hidden="true"
    class="icon-svg"
  >
    <rect x="3.5" y="2" width="2.5" height="10" rx="0.5" />
    <rect x="8" y="2" width="2.5" height="10" rx="0.5" />
  </svg>
  <svg
    v-else-if="name === 'check'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" />
  </svg>
  <svg
    v-else-if="name === 'refresh'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <path d="M11.8 6.5 A5 5 0 1 0 7 11.5" />
    <polyline points="11.8 1.5 11.8 6.5 6.8 6.5" />
  </svg>
  <svg
    v-else-if="name === 'x'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <path d="M3.5 3.5 L10.5 10.5" />
    <path d="M10.5 3.5 L3.5 10.5" />
  </svg>
  <svg
    v-else-if="name === 'trash'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <path d="M3 4 H11" />
    <path d="M4.5 4 L5 12 H9 L9.5 4" />
    <path d="M5.5 4 V2.7 H8.5 V4" />
  </svg>
  <svg
    v-else-if="name === 'fork'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <!-- git fork/branch 语义: 1 个源节点 + 2 个分支节点 + 2 条连线 (1 横 1 斜) -->
    <circle cx="3" cy="3.5" r="1.6" />
    <circle cx="11" cy="3.5" r="1.6" />
    <circle cx="11" cy="10.5" r="1.6" />
    <line x1="3" y1="3.5" x2="11" y2="3.5" />
    <line x1="3" y1="3.5" x2="11" y2="10.5" />
  </svg>
  <svg
    v-else-if="name === 'lines'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <!-- display mode text-only: 3 条横线, 最后一行短 (模拟段落结尾) -->
    <line x1="3" y1="4" x2="11" y2="4" />
    <line x1="3" y1="7" x2="11" y2="7" />
    <line x1="3" y1="10" x2="9" y2="10" />
  </svg>
  <svg
    v-else-if="name === 'list'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <!-- display mode all (标准): 1 细 + 1 粗 — 信息密度中档 -->
    <line x1="3" y1="5" x2="11" y2="5" stroke-width="1.5" />
    <line x1="3" y1="9" x2="11" y2="9" stroke-width="3" />
  </svg>
  <svg
    v-else-if="name === 'expand-list'"
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke-linecap="round"
    aria-hidden="true"
    class="icon-svg"
  >
    <!-- display mode expanded (详情): 1 细 + 2 粗 — 2 粗线 1 黄 1 浅灰
         (黄=主内容高亮, 浅灰=次级/补充, 视觉一主一次). 细线沿用 currentColor
         跟父按钮色绑. R206: 色值走主题变量 (var() 在 SVG 属性里不生效,
         必须写 style 属性形式), 暗色下随 [data-theme] 变量自动适配. -->
    <line x1="3" y1="4" x2="11" y2="4" stroke="currentColor" stroke-width="1.5" />
    <line x1="3" y1="7.5" x2="11" y2="7.5" style="stroke: var(--tw-amber-500)" stroke-width="3" />
    <line x1="3" y1="10.5" x2="11" y2="10.5" style="stroke: var(--tw-slate-300)" stroke-width="3" />
  </svg>
</template>

<style scoped>
.icon-svg {
  flex-shrink: 0;
  display: inline-block;
  vertical-align: -1px;
}
</style>