<script setup lang="ts">
/* 功能: 多行文本输入 — v-model 受控字符串值, autosize + maxlength 可选,
   error 态红色边框 + 下方 hint 文字. 与 Input.vue 共享 error/hint 接口, 联动
   HttpError.fieldErrors 同款 (string = 字段错, undefined = 无错).

   关注点:
   - 渲染原生 <textarea> 保 a11y; 不引第三方 autosize 库, 用手写高度跟随策略 (见下).
   - autosize: 监听 modelValue 变化, 动态调整 height = scrollHeight + 上下 padding (CSS
     box-sizing:border-box + overflow:hidden), minHeight 由 rows 决定. rows 不传时
     默认 4 行高 (与 Next tasks/new/page.tsx 的 h-40 一致 = 10 行 visual, 我们用
     rows=4 行高作为更克制的默认; 调用方需要更长可传 rows=10).
   - maxlength 限长, 同时在右下角显示 "已输入 / 上限" 计数 (可选, showCount=true);
     超出不报错 (HTML maxlength 已经物理阻止输入), 仅提示已达上限.
   - resize: vertical (允许用户手动拉高, 但不拉宽 — 与 Next h-40 固定 + 不能调 略有差异,
     这里让用户能调, 因为 SPA 表单场景里高度随内容变化是用户期望; 注释披露).
   - 样式与 Input.vue 完全一致: gray 描边 + 蓝聚焦 + 错误红描边. */
import { computed, nextTick, ref, watch } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** v-model 值. */
  modelValue: string;
  /** 占位符. */
  placeholder?: string;
  /** 禁用. */
  disabled?: boolean;
  /** 只读. */
  readonly?: boolean;
  /** 最小行数 (决定初始高度). */
  rows?: number;
  /** 自动撑高. true 时输入内容变多 textarea 自动加高. */
  autosize?: boolean;
  /** 最大字符数. 传值时启用 HTML maxlength + 计数提示 (若 showCount=true). */
  maxlength?: number;
  /** 是否显示计数提示 (右下角 "n/max"). */
  showCount?: boolean;
  /** 错误提示. string = 该字段有错; undefined = 无错. */
  error?: string;
  /** 非错误态的辅助文字. */
  hint?: string;
  /** HTML id. */
  id?: string;
  /** 自定义类名. */
  className?: string;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  disabled: false,
  readonly: false,
  rows: 4,
  autosize: false,
  maxlength: undefined,
  showCount: false,
  error: undefined,
  hint: '',
  id: undefined,
  className: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'blur', evt: FocusEvent): void;
  (e: 'focus', evt: FocusEvent): void;
}>();

/* ------------------------------------------------------------------ */
/*  Refs & derived state                                              */
/* ------------------------------------------------------------------ */

const textareaRef = ref<HTMLTextAreaElement | null>(null);

const hasError = computed(() => typeof props.error === 'string' && props.error.length > 0);

const countText = computed(() => {
  if (!props.showCount) return '';
  const cur = props.modelValue.length;
  return props.maxlength !== undefined ? `${cur} / ${props.maxlength}` : `${cur}`;
});

/* ------------------------------------------------------------------ */
/*  Autosize                                                           */
/* ------------------------------------------------------------------ */

/** 高度跟随. 重置到 auto 是为了让 scrollHeight 重新测量 (否则高度只增不减).
   关注点: 必须在 nextTick 里等 DOM 更新完; 否则 scrollHeight 拿的是旧值. */
async function adjustHeight(): Promise<void> {
  const el = textareaRef.value;
  if (!el || !props.autosize) return;
  await nextTick();
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** modelValue 变化时调一次. */
watch(
  () => props.modelValue,
  () => {
    void adjustHeight();
  },
);

/** autosize 切换 / mounted: 等下一帧再算. */
watch(
  () => props.autosize,
  () => {
    void adjustHeight();
  },
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onInput(e: Event): void {
  const target = e.target as HTMLTextAreaElement;
  emit('update:modelValue', target.value);
}
</script>

<template>
  <div :class="['textarea-wrap', { 'textarea-disabled': disabled }, className]">
    <div :class="['textarea-row', { 'textarea-row-error': hasError }]">
      <textarea
        :id="id"
        ref="textareaRef"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :rows="rows"
        :maxlength="maxlength"
        class="textarea-native"
        :aria-invalid="hasError || undefined"
        :aria-describedby="hasError ? `${id}-err` : hint ? `${id}-hint` : undefined"
        @input="onInput"
        @blur="(e) => emit('blur', e)"
        @focus="(e) => emit('focus', e)"
      />
    </div>

    <!-- 错误提示 (红色) — 优先于 hint. -->
    <div v-if="hasError" :id="id ? `${id}-err` : undefined" class="textarea-err-text">
      {{ error }}
    </div>
    <!-- 普通 hint (灰色) — 仅在无 error 时显示. -->
    <div v-else-if="hint" :id="id ? `${id}-hint` : undefined" class="textarea-hint-text">
      <span>{{ hint }}</span>
      <span v-if="showCount" class="textarea-count">{{ countText }}</span>
    </div>
    <!-- 无 hint 但启用了 showCount: 计数放最末. -->
    <div v-else-if="showCount" class="textarea-hint-text textarea-count-only">
      {{ countText }}
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.textarea-wrap {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.textarea-disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/*  Row (textarea wrapper)                                             */
/* ------------------------------------------------------------------ */
.textarea-row {
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.textarea-row:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.textarea-row-error {
  border-color: var(--color-danger);
}
.textarea-row-error:focus-within {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.15);
}

/* ------------------------------------------------------------------ */
/*  Native textarea                                                    */
/* ------------------------------------------------------------------ */
.textarea-native {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text);
  resize: vertical;
  /* min-height 与 rows 默认 4 行高对齐, 不让高度塌陷到 1 行. */
  min-height: calc(1.5em * 4 + 14px);
  box-sizing: border-box;
  overflow: auto;
}
.textarea-native::placeholder {
  color: var(--color-text-muted);
}
.textarea-native:disabled {
  cursor: not-allowed;
}

/* ------------------------------------------------------------------ */
/*  Hint / error / count                                               */
/* ------------------------------------------------------------------ */
.textarea-err-text {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-danger);
}
.textarea-hint-text {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
.textarea-count {
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.textarea-count-only {
  justify-content: flex-end;
}
</style>
