<script lang="ts">
/* R56-B25: <script setup> 不允许 ES module exports (vuejs/rfcs#227).
   子 Radio.vue 还要 import { RadioGroupKey, type RadioGroupContext } 拿这个
   injection key, 所以 type/interface/const 拆到独立的普通 <script> 块 ——
   Vue 编译器对普通 <script> 块原样保留 ES module exports, setup 块仍可直接
   引用这些 bindings (RFC 227: 两个 <script> 共存时 setup 自动可见). */
import type { InjectionKey } from 'vue';

export type RadioGroupValue = string | number | boolean;

export interface RadioGroupContext {
  modelValue: RadioGroupValue;
  update: (val: RadioGroupValue) => void;
  disabled: boolean;
  name: string;
}

export const RadioGroupKey: InjectionKey<RadioGroupContext> = Symbol('RadioGroup') as InjectionKey<RadioGroupContext>;
</script>

<script setup lang="ts">
/* 功能: 单选按钮组. 子 Radio 通过 provide/inject 自动接入; v-model=单值.
   关注点:
   - 单独文件 (而非合并到 Radio.vue) —— Vue SFC 一个文件只允许一个 <script setup>
     defineProps 块; 两个组件分两个文件是最清晰方案.
   - inject key 用 Symbol 避免命名冲突, 并通过 named export 让 Radio.vue 直接 import.
   - name 由 group 自动生成 —— 浏览器原生根据 name 互斥 + 方向键切换
     (单选组的核心机制); 子 Radio 不需要手动设置 name.
   - disabled 在 group 级透传. */
import { provide } from 'vue';

interface Props {
  /** v-model. 当前选中的 value; 初始为空字符串 / null / 0 都算未选. */
  modelValue: RadioGroupValue;
  /** 整组 disabled. */
  disabled?: boolean;
  /** 自定义类名. */
  className?: string;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  className: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', val: RadioGroupValue): void;
  (e: 'change', val: RadioGroupValue): void;
}>();

/* ------------------------------------------------------------------ */
/*  Group name (auto-generated)                                        */
/* ------------------------------------------------------------------ */

const groupName = `rdgroup-${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------------ */
/*  Provide to children                                                */
/* ------------------------------------------------------------------ */

provide(RadioGroupKey, {
  get modelValue() {
    return props.modelValue;
  },
  update(val: RadioGroupValue) {
    emit('update:modelValue', val);
    emit('change', val);
  },
  get disabled() {
    return props.disabled;
  },
  name: groupName,
});
</script>

<template>
  <div
    :class="[
      'radio-group',
      { 'radio-group-disabled': disabled },
      className,
    ]"
  >
    <slot />
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.radio-group {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.radio-group-disabled {
  opacity: 0.6;
  pointer-events: none;
}
</style>