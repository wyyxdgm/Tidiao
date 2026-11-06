<script setup lang="ts">
/* 功能: 通用错误态. 红色 SVG 图标 + 错误标题/说明 + retry 按钮 (emit retry).
   对应 Next 端裸渲染 `toastError("加载失败")` 弹完即逝的替代实现 —— 提供
   持久化错误面板, 让用户看到完整上下文 + 一键重试入口.
   关注点:
   - 默认走 "error" 变体 (红); 显式 variant="warning" 走黄色 (网络/超时类).
   - retry 按钮默认显示 + 自动 emit; 调用方可传 :showRetry=false 禁用 (如
     鉴权失败跳登录场景, 重试无意义).
   - retrying=true 时按钮 disabled + 显示 R11 Spinner (lg 档) —— 父组件
     触发重试后异步置 true, 完成后置 false. */
import { computed } from 'vue';
import Loading from './Loading.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ErrorVariant = 'error' | 'warning';

interface Props {
  /** 错误标题. 必填, 一句话说清错误类型 (如 "加载失败" / "网络异常"). */
  title: string;
  /** 详细说明. 可选, 给用户/工程师看的上下文 (建议 ≤ 200 字). */
  description?: string;
  /** 视觉变体. error=红 (默认) / warning=黄 (网络/超时/可恢复). */
  variant?: ErrorVariant;
  /** 是否显示重试按钮. 默认 true; 鉴权类不可重试错误传 false. */
  showRetry?: boolean;
  /** 重试中状态. true 时按钮 disabled + Spinner. 父组件异步 retry 时设置. */
  retrying?: boolean;
  /** 重试按钮文案. 默认 "重试". */
  retryLabel?: string;
  /** 视觉尺寸. sm=列表行内 / md=默认卡片 / lg=整页错误. */
  size?: 'sm' | 'md' | 'lg';
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  variant: 'error',
  showRetry: true,
  retrying: false,
  retryLabel: '重试',
  size: 'md',
});

const emit = defineEmits<{
  (e: 'retry'): void;
}>();

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

const PALETTE: Record<ErrorVariant, { illust: string; bg: string; border: string; text: string }> = {
  error:   { illust: 'var(--tw-red-600)', bg: 'var(--tw-red-50)', border: 'var(--tw-red-200)', text: 'var(--tw-red-800)' },  // red-600/50/200/800
  warning: { illust: 'var(--tw-amber-600)', bg: 'var(--tw-amber-50)', border: 'var(--tw-amber-200)', text: 'var(--tw-amber-800)' },  // amber-600/50/200/800
};

const SIZE_PADDING: Record<NonNullable<Props['size']>, string> = {
  sm: 'py-6',
  md: 'py-12',
  lg: 'py-20',
};
const SIZE_TITLE: Record<NonNullable<Props['size']>, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};
const SIZE_ICON_PX: Record<NonNullable<Props['size']>, number> = {
  sm: 32,
  md: 56,
  lg: 80,
};

const palette = computed(() => PALETTE[props.variant]);
const padding = computed(() => SIZE_PADDING[props.size]);
const titleClass = computed(() => SIZE_TITLE[props.size]);
const iconPx = computed(() => SIZE_ICON_PX[props.size]);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onRetry(): void {
  if (props.retrying) return;
  emit('retry');
}
</script>

<template>
  <div
    class="error-view"
    :class="[padding, `error-view-${variant}`]"
    role="alert"
  >
    <svg
      class="error-icon"
      :width="iconPx"
      :height="iconPx"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <!-- 圆形 + 感叹号 —— 通用错误图标, error/warning 通用. -->
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
    <p class="error-title" :class="titleClass">{{ title }}</p>
    <p v-if="description" class="error-desc">{{ description }}</p>
    <div v-if="showRetry" class="error-action">
      <button
        type="button"
        class="error-retry-btn"
        :disabled="retrying"
        :aria-busy="retrying || undefined"
        @click="onRetry"
      >
        <Loading v-if="retrying" size="sm" color="currentColor" />
        <span>{{ retrying ? '重试中…' : retryLabel }}</span>
      </button>
      <slot />
    </div>
    <div v-else class="error-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Base                                                               */
/* ------------------------------------------------------------------ */
.error-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  width: 100%;
  border-radius: var(--radius);
}

/* variant 走 scoped 类 + CSS 变量调色, 不引 Tailwind palette 类.
   这样组件可以脱离全局 main.css 的颜色变量独立工作. */
.error-view-error {
  background: var(--tw-red-50);
  border: 1px solid var(--tw-red-200);
}
.error-view-warning {
  background: var(--tw-amber-50);
  border: 1px solid var(--tw-amber-200);
}

.error-icon {
  margin-bottom: 12px;
}
.error-view-error .error-icon { color: var(--tw-red-600); }
.error-view-warning .error-icon { color: var(--tw-amber-600); }

.error-title {
  margin: 0;
  font-weight: 600;
  color: var(--tw-gray-900);
}
.error-view-error .error-title { color: var(--tw-red-800); }
.error-view-warning .error-title { color: var(--tw-amber-800); }

.error-desc {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--tw-gray-500);
  max-width: 480px;
  white-space: pre-wrap;
  word-break: break-word;
}

.error-action {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
}

.error-retry-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 16px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  /* R59+: error-retry-btn 34 → 30, 跟 Button.vue 默认同档 (用户反馈
   「还有28的」之后扫尾所有偏小一截的按钮). 之前 34 是 R59+ 给错误
   状态按钮视觉重一点用的, 现在全系统统一 30px 优先. */
  min-height: 30px;
  user-select: none;
}
.error-retry-btn:hover:not(:disabled) {
  background: var(--color-primary-hover, #1d4ed8);
}
.error-retry-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
}
.error-retry-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
