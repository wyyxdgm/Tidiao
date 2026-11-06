<script setup lang="ts">
/* 功能: 日期/时间选择 — 封装原生 <input type="datetime-local">. v-model 受控字符串值
   (YYYY-MM-DDTHH:mm 格式, 与原生 datetime-local 一致); 支持 min/max 边界; placeholder
   走原生支持的格式提示.

   关注点:
   - 渲染原生 <input type="datetime-local"> 保 a11y (浏览器原生 picker / 键盘导航
     / 移动端原生 wheel 全免费); 不引第三方日期库 (dayjs / date-fns / luxon 都不引,
     体积换不到本组件能用到的高级功能).
   - 与 Input.vue 共享 error/hint 接口: error prop 接受 string | undefined, 联动
     HttpError.fieldErrors 同款 (string = 字段错, undefined = 无错).
   - min/max 透传给原生 input — 浏览器的 picker 会自动禁用越界日期. 校验失败
     时 onChange 也会拿到空字符串, 由调用方决定兜底逻辑.
   - step: 默认 60 (分钟精度); 调用方可传 step=1 (秒精度) / step=300 (5 分钟粒度)
     / step=3600 (整点). 与原生 step 语义一致.
   - 样式与 Input.vue 同款 (gray 描边 + 蓝聚焦 + 错误红描边); datalist 等
     扩展属性通过 fallthrough 自动传递.
   - 空值语义: v-model = '' 表示"未选", 与 Input.vue 一致 (空串 = 已清空). */
import { computed } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** v-model 值. 字符串 = 'YYYY-MM-DDTHH:mm' (原生 datetime-local 格式); 空串 = 未选. */
  modelValue: string;
  /** 占位符. 原生 datetime-local 不支持 placeholder, 这里通过 aria-label + CSS ::after
      模拟占位效果 (Safari/Chrome 在空值时显示灰色提示). */
  placeholder?: string;
  /** 禁用. */
  disabled?: boolean;
  /** 只读. */
  readonly?: boolean;
  /** 最早可选时间. 原生 min 属性. */
  min?: string;
  /** 最晚可选时间. 原生 max 属性. */
  max?: string;
  /** 步长 (秒). 默认 60 (分钟精度). */
  step?: number;
  /** 错误提示. string = 字段错; undefined = 无错. */
  error?: string;
  /** 非错误态辅助文字 (灰色 hint). */
  hint?: string;
  /** HTML id; 用于外层 <label :for="...">. */
  id?: string;
  /** 自定义类名 (透传到 wrapper). */
  className?: string;
  /** aria-label (原生 datetime-local placeholder 不可靠, 屏幕阅读需要 aria). */
  ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  disabled: false,
  readonly: false,
  min: undefined,
  max: undefined,
  step: 60,
  error: undefined,
  hint: '',
  id: undefined,
  className: '',
  ariaLabel: undefined,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'blur', evt: FocusEvent): void;
  (e: 'focus', evt: FocusEvent): void;
}>();

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

const hasError = computed(() => typeof props.error === 'string' && props.error.length > 0);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  emit('update:modelValue', v);
}
</script>

<template>
  <div
    :class="['dt-wrap', className, { 'dt-disabled': disabled, 'dt-row-error': hasError }]"
  >
    <div class="dt-row">
      <input
        :id="id"
        :value="modelValue"
        type="datetime-local"
        :min="min"
        :max="max"
        :step="step"
        :disabled="disabled"
        :readonly="readonly"
        :placeholder="placeholder"
        :aria-label="ariaLabel"
        :aria-invalid="hasError || undefined"
        :aria-describedby="hasError ? `${id}-err` : hint ? `${id}-hint` : undefined"
        class="dt-native"
        @input="onInput"
        @blur="(e) => emit('blur', e)"
        @focus="(e) => emit('focus', e)"
      />
    </div>

    <!-- 错误提示 (红色) — 优先于 hint. -->
    <div v-if="hasError" :id="id ? `${id}-err` : undefined" class="dt-err-text">
      {{ error }}
    </div>
    <!-- 普通 hint (灰色) — 仅在无 error 时显示. -->
    <div v-else-if="hint" :id="id ? `${id}-hint` : undefined" class="dt-hint-text">
      {{ hint }}
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.dt-wrap {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.dt-disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/*  Row (input 容器)                                                    */
/* ------------------------------------------------------------------ */
.dt-row {
  display: flex;
  align-items: center;
  width: 100%;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.dt-row:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
/* 错误态: 红色描边 + 红色聚焦环 (替代默认蓝色) */
.dt-row-error {
  border-color: var(--color-danger);
}
.dt-row-error:focus-within {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.15);
}

/* 原生 input — 透明背景 + 自适应宽度, 视觉由 .dt-row 控制. */
.dt-native {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
}
.dt-native::placeholder {
  color: var(--color-text-muted);
}

/* ------------------------------------------------------------------ */
/*  Hint / Error text                                                  */
/* ------------------------------------------------------------------ */
.dt-err-text {
  font-size: 12px;
  color: var(--color-danger);
}
.dt-hint-text {
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>