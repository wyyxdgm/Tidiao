<script setup lang="ts">
/* 功能: 表单输入框 — v-model 受控字符串值, prefix/suffix slot 可挂图标或单位,
   error 态红色边框 + 下方 hint 文字; 联动 HttpError.fieldErrors 时 error prop 直接
   接后端字段错 (字符串 = 该字段有错, 空/undefined = 无错).

   关注点:
   - 渲染原生 <input> 保 a11y; type 默认 text, 支持 text/password/email/number/url/tel/search.
   - 与 R3 HttpError 联动: error prop 接受 string | undefined, 直接 = getFieldError(err, name)
     的返回值. 无需在组件内做 instanceof 判断, 适配逻辑下沉到调用方 (与 LoginView 一致).
   - prefix/suffix 走 scoped slot —— 调用方放图标 (👁 / 🔍 / 单位 "元") 或别的; 不限制内容.
   - clearable=true 时显示 ✕ 按钮, emit update:modelValue='' (空串 = 已清空语义, 不传 null,
     因为 HTML <input> 值就是字符串). 与 R9 Select.vue 的 null 语义有意区分: input 是字
     段型, 空串是合法状态 (""). 调用方若想区分"未填写"可用 v-model='' + required 自行处理.
   - disabled 时禁用整控件 (含 prefix/suffix 按钮 + clear).
   - 样式对齐 Next tasks/new/page.tsx 表单 input 视觉 (gray 描边 + 蓝聚焦 + 错误红描边). */
import { computed, ref } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** v-model 值. 字符串类型; 空串 = 已清空 / 未填. */
  modelValue: string;
  /** 原生 input type. 默认 text. */
  type?: 'text' | 'password' | 'email' | 'number' | 'url' | 'tel' | 'search';
  /** 占位符. */
  placeholder?: string;
  /** 禁用. */
  disabled?: boolean;
  /** 只读. */
  readonly?: boolean;
  /** 是否可清空. true 时显示 ✕ 按钮 (value 非空 + 非 disabled). */
  clearable?: boolean;
  /** 错误提示. string = 该字段有错 (红色边框 + 下方红字); undefined = 无错.
      直接接 getFieldError(err, name) 的返回值即可. */
  error?: string;
  /** 非错误态的辅助文字 (灰色 hint, 在输入框下方). 与 error 互斥. */
  hint?: string;
  /** HTML id; 用于外层 <label :for="...">. */
  id?: string;
  /** 自定义类名 (透传到 wrapper). */
  className?: string;
  /** 原生 list 属性 (与 <datalist> 配对, 浏览器自动补全建议). */
  list?: string;
  /** 原生 autocomplete 属性 (e.g. 'username' / 'current-password' / 'email'). */
  autocomplete?: string;
  /** 原生 min 属性 (number / date 等类型生效). */
  min?: string | number;
  /** 原生 max 属性 (number / date 等类型生效). */
  max?: string | number;
  /** 原生 step 属性 (number 类型生效). */
  step?: string | number;
}

const props = withDefaults(defineProps<Props>(), {
  type: 'text',
  placeholder: '',
  disabled: false,
  readonly: false,
  clearable: false,
  error: undefined,
  hint: '',
  id: undefined,
  className: '',
  list: undefined,
  autocomplete: undefined,
  min: undefined,
  max: undefined,
  step: undefined,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'blur', evt: FocusEvent): void;
  (e: 'focus', evt: FocusEvent): void;
}>();

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** 是否显示清空按钮: clearable + 非 disabled + 非 readonly + value 非空. */
const showClear = computed(() =>
  props.clearable && !props.disabled && !props.readonly && props.modelValue.length > 0,
);

/** 错误状态. 有 error 字符串 → 红描边 + 红 hint. */
const hasError = computed(() => typeof props.error === 'string' && props.error.length > 0);

/** 内部 input 元素的 ref —— 用于 expose focus() (R46 dep 搜索等场景需要父组件主动聚焦). */
const innerInputRef = ref<HTMLInputElement | null>(null);

/* ------------------------------------------------------------------ */
/*  Exposed methods                                                    */
/* ------------------------------------------------------------------ */

/** 主动聚焦内部 input. 让父组件 depInputRef.value?.focus() 这样的用法成立 (Vue 组件
    ref 默认拿到实例, 不直接是 DOM 节点; 通过 expose 把方法透出去). */
function focus(): void {
  innerInputRef.value?.focus();
}

defineExpose({ focus });

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  emit('update:modelValue', target.value);
}

function clearValue(): void {
  if (props.disabled || props.readonly) return;
  emit('update:modelValue', '');
}
</script>

<template>
  <div :class="['input-wrap', { 'input-disabled': disabled }, className]">
    <div :class="['input-row', { 'input-row-error': hasError }]">
      <!-- 前缀插槽 (图标 / 单位 / 标签). 无内容时不渲染 wrapper. -->
      <span v-if="$slots.prefix" class="input-affix input-affix-prefix">
        <slot name="prefix" />
      </span>

      <!-- 主控件: 原生 <input> 保 a11y. -->
      <input
        ref="innerInputRef"
        :id="id"
        :value="modelValue"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :list="list"
        :autocomplete="autocomplete"
        :min="min"
        :max="max"
        :step="step"
        :class="['input-native', { 'input-has-prefix': !!$slots.prefix, 'input-has-suffix': !!$slots.suffix || showClear }]"
        :aria-invalid="hasError || undefined"
        :aria-describedby="hasError ? `${id}-err` : hint ? `${id}-hint` : undefined"
        @input="onInput"
        @blur="(e) => emit('blur', e)"
        @focus="(e) => emit('focus', e)"
      />

      <!-- 清空按钮: 视觉对齐 Select.vue 的 ✕ 按钮, 同 gray 圆形. -->
      <button
        v-if="showClear"
        type="button"
        class="input-clear"
        aria-label="清空"
        @click="clearValue"
      >
        ×
      </button>

      <!-- 后缀插槽. clear 按钮存在时也保留后缀 (清空 + 后缀可共存). -->
      <span v-if="$slots.suffix" class="input-affix input-affix-suffix">
        <slot name="suffix" />
      </span>
    </div>

    <!-- 错误提示 (红色) — 优先于 hint. -->
    <div v-if="hasError" :id="id ? `${id}-err` : undefined" class="input-err-text">
      {{ error }}
    </div>
    <!-- 普通 hint (灰色) — 仅在无 error 时显示. -->
    <div v-else-if="hint" :id="id ? `${id}-hint` : undefined" class="input-hint-text">
      {{ hint }}
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.input-wrap {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.input-disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/*  Row (prefix + input + clear + suffix)                              */
/* ------------------------------------------------------------------ */
.input-row {
  display: flex;
  align-items: center;
  width: 100%;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.input-row:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
/* 错误态: 红色描边 + 红色聚焦环 (替代默认蓝色) */
.input-row-error {
  border-color: var(--color-danger);
}
.input-row-error:focus-within {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.15);
}

/* ------------------------------------------------------------------ */
/*  Native input                                                       */
/* ------------------------------------------------------------------ */
/* R59+: 统一 30px 档 — 跟 Button.vue 默认 + 顶部 30×30 头像/图标按钮
   (AccountSwitcher .avatar-btn / TaskHeader .icon-btn / Pagination
   .pagination-btn 等) 同档 (用户反馈「输入框也统一, 因为多数按钮和
   输入框会在一块」). 之前 padding 7×10 + font 14 + line-height 1.4
   ~35-36px 高, 比 Button 30px 高 5-6px, 同行错位. 现在 padding 4×10 /
   12px / 30px + box-sizing:border-box, 视觉齐. */
.input-native {
  flex: 1;
  min-width: 0;
  padding: 4px 10px;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 12px;
  line-height: 1.2;
  height: 30px;
  box-sizing: border-box;
  color: var(--color-text);
}
.input-native::placeholder {
  color: var(--color-text-muted);
}
.input-native:disabled {
  cursor: not-allowed;
}
/* 有 prefix/suffix 时缩进让出空间 (避免输入文字顶到图标上) */
.input-has-prefix {
  padding-left: 4px;
}
.input-has-suffix {
  padding-right: 4px;
}

/* ------------------------------------------------------------------ */
/*  Affix (prefix / suffix slot wrapper)                               */
/* ------------------------------------------------------------------ */
/* R59+: 跟 .input-native 同 12px 字体 (用户反馈「输入框也统一」). 之前 13px
   跟输入 14px 旧字体同档, 现在缩到 12 跟 Input 主体对齐. */
.input-affix {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  color: var(--color-text-muted);
  font-size: 12px;
  white-space: nowrap;
  user-select: none;
}
.input-affix-prefix {
  border-right: 1px solid var(--color-border);
}
.input-affix-suffix {
  border-left: 1px solid var(--color-border);
}

/* ------------------------------------------------------------------ */
/*  Clear button (✕)                                                  */
/* ------------------------------------------------------------------ */
.input-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 4px;
  border: 0;
  border-radius: 50%;
  background: var(--color-border);
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.input-clear:hover {
  background: var(--color-border-strong);
  color: var(--color-text);
}

/* ------------------------------------------------------------------ */
/*  Hint / error text                                                  */
/* ------------------------------------------------------------------ */
.input-err-text {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-danger);
}
.input-hint-text {
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
</style>
