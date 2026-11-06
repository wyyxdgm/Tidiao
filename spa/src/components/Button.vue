<script setup lang="ts">
/* 功能: 通用按钮. 渲染 HTML <button> (非 div) 保 a11y; 4 variant + 2 size + loading 自动 disabled+Spinner.
   关注点:
   - loading=true 时 disabled 自动跟随 (即便父组件没传), 且拦截 click (避免表单重复提交).
   - type 默认 "button" 而非浏览器默认 "submit" —— 表单外使用不会误触发表单提交;
     需要 submit 时父组件显式传 :type="'submit'".
   - 用 <span class="spinner"> 而非第三方 icon, 自包含、无依赖.
   - 点击事件不强制阻止, 由父组件决定 —— 仅当 loading 时屏蔽. */
import { computed } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** mini = 26.5px 档, 用于 tsb-row 等密集排, 跟 .tsb-tbtn/.tsb-link 同高.
    sm/md = 30px 档, 系统主操作 / 顶部 icon-btn 同档. */
export type ButtonSize = 'sm' | 'md' | 'mini';

interface Props {
  /** 视觉风格. primary=主操作 (蓝填充) / secondary=次操作 (灰描边) / ghost=文字按钮 (无背景) / danger=危险 (红填充). */
  variant?: ButtonVariant;
  /** 尺寸. sm/md = 30px (跟 AccountSwitcher .avatar-btn / TaskHeader .icon-btn /
     Pagination .pagination-btn 等顶部 30×30 图标/头像按钮同档). mini = 26.5px
     (跟 .tsb-tbtn/.tsb-link 同档, 用于 tsb-row 等密集横向排). 旧 size="sm"|"md"
     调用无需改 — 新加 mini 不影响现有调用点. */
  size?: ButtonSize;
  /** 原生 button type. 默认 "button" 防误提交; 表单提交显式传 "submit". */
  type?: 'button' | 'submit' | 'reset';
  /** 禁用. 接受任何原因 (表单未填 / 权限不足 / 外部状态). */
  disabled?: boolean;
  /** 加载中. true 时自动 disabled + 显示 Spinner + 屏蔽 click; 文本保留 (而不是清空) 让用户知道在做什么. */
  loading?: boolean;
  /** block = 100% 宽度. 用于移动端主操作或对话框底部主按钮. */
  block?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'secondary',
  size: 'md',
  type: 'button',
  disabled: false,
  loading: false,
  block: false,
});

const emit = defineEmits<{
  (e: 'click', evt: MouseEvent): void;
}>();

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** loading 时强制 disabled (即便父组件未传) —— loading 期间按钮不应被二次触发. */
const isDisabled = computed(() => props.disabled || props.loading);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onClick(evt: MouseEvent): void {
  if (isDisabled.value) {
    // loading 或 disabled 时屏蔽 click, 避免重复提交.
    evt.preventDefault();
    evt.stopImmediatePropagation();
    return;
  }
  emit('click', evt);
}
</script>

<template>
  <button
    :type="type"
    :disabled="isDisabled"
    :class="[
      'btn',
      `btn-${variant}`,
      `btn-size-${size}`,
      { 'btn-block': block, 'btn-loading': loading },
    ]"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <span v-if="loading" class="btn-spinner" aria-hidden="true" />
    <span class="btn-content" :class="{ 'btn-content-loading': loading }">
      <slot />
    </span>
  </button>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Base (overrides .btn in main.css to give us scoped control)        */
/* ------------------------------------------------------------------ */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font-weight: 500;
  line-height: 1.2;
  /* R59+: 默认 align-self: flex-start — 防止 flex column 父容器 (align-items:
     stretch 默认) 把按钮横向拉成 full-width, 变「扁」条 (实测 TaskNew
     .form 内 Button 被拉伸到 736x24, 用户反馈「不管是否 H5 都感觉这个
     按钮好扁」). 显式 flex-start 锁死 content-width. block=true 时改
     .btn-block 拉满, 互不冲突. */
  align-self: flex-start;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
  user-select: none;
  /* R59+: 系统按钮统一 30px 档 — 跟 AccountSwitcher .avatar-btn /
     TaskHeader .icon-btn / Pagination .pagination-btn / GlobalBoard
     .gb-sync-menu-trigger 等顶部 30×30 图标/头像按钮同档 (用户反馈
     「新建项目 26, 其他按钮 30. 高度」不齐). 之前默认 30px (4px 10px /
     12px) 比 30px 头像/图标矮 4px, header-meta 跟顶部导航对比明显
     不齐. 现在 min-height 30 + padding 4×10 / font 12, 视觉齐.
     primary 区分靠颜色 + weight 600, 不靠高度. */
  padding: 4px 10px;
  font-size: 12px;
  min-height: 30px;
}
.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
}
.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* ------------------------------------------------------------------ */
/*  Sizes                                                              */
/* ------------------------------------------------------------------ */
/* size=sm/md → 30px 档 (系统主操作 / 顶部 icon-btn 同高, 全局统一).
   size=mini → 26.5px 档 (跟 tsb-row 内的 .tsb-tbtn/.tsb-link 同高, 密集横向排).
   主次靠 color/weight, 不靠高度. sm/md 类保留是后向兼容, ~30+ 处现有调用无需逐个改. */
.btn-size-sm,
.btn-size-md {
  padding: 4px 10px;
  font-size: 12px;
  min-height: 30px;
}
.btn-size-mini {
  padding: 3px 10px;
  font-size: 11px;
  min-height: 26.5px;
}

/* ------------------------------------------------------------------ */
/*  Variants                                                           */
/* ------------------------------------------------------------------ */
/* primary: 主操作 —— 蓝填充白字. 尺寸继承 .btn (30px), 区分靠背景色 +
   font-weight 600. */
.btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
  font-weight: 600;
}
.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}
.btn-primary:active:not(:disabled) {
  background: var(--color-primary-hover);
  transform: translateY(0.5px);
}

/* secondary: 次操作 —— 白底灰描边 (默认). hover 切到主色描边. */
.btn-secondary {
  background: var(--color-bg-elevated);
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.btn-secondary:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* ghost: 文字按钮 —— 无背景无边框, hover 轻底色. 用于工具栏 / 表格行内操作. */
.btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--color-text-muted);
}
.btn-ghost:hover:not(:disabled) {
  background: var(--color-bg);
  color: var(--color-text);
}

/* danger: 危险操作 —— 红填充白字. */
.btn-danger {
  background: var(--color-danger);
  border-color: var(--color-danger);
  color: #fff;
}
.btn-danger:hover:not(:disabled) {
  background: var(--tw-red-700-solid);
  border-color: var(--tw-red-700);
}

/* ------------------------------------------------------------------ */
/*  Block (full width)                                                 */
/* ------------------------------------------------------------------ */
.btn-block {
  display: flex;
  width: 100%;
}

/* ------------------------------------------------------------------ */
/*  Loading                                                            */
/* ------------------------------------------------------------------ */
.btn-loading {
  cursor: progress;
}
.btn-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: btn-spin 0.6s linear infinite;
  flex-shrink: 0;
}
.btn-content-loading {
  opacity: 0.85;
}

@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
