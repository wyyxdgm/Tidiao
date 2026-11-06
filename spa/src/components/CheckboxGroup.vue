<script lang="ts">
/* ESM exports 必须放在独立 <script> 块 — Vue 3.x 不允许 <script setup> 内 export,
   编译器会报 "cannot contain ES module exports". 本块只导出子 Checkbox.vue 需要
   的 CheckboxGroupContext 类型 + CheckboxGroupKey (R10 已就位, R23 build 验证
   时被发现并补修复). */
import type { InjectionKey } from 'vue';

/** 子 Checkbox 可识别的 group 上下文. */
export interface CheckboxGroupContext {
  modelValue: Array<string | number | boolean>;
  update: (vals: Array<string | number | boolean>) => void;
  disabled: boolean;
  name: string;
}

export type CheckboxGroupValue = string | number | boolean;

/** Symbol 作为 injection key, 避免与页面其他 provide 重名冲突. */
export const CheckboxGroupKey: InjectionKey<CheckboxGroupContext> = Symbol('CheckboxGroup') as InjectionKey<CheckboxGroupContext>;
</script>

<script setup lang="ts">
/* 功能: 复选框组. 子 Checkbox 通过 provide/inject 自动接入; v-model=Array<value>.
   关注点:
   - 单独文件 (而非合并到 Checkbox.vue) —— Vue SFC 一个文件只允许一个 <script setup>
     defineProps 块; 两个组件分两个文件是最清晰方案.
   - inject key 用 Symbol 避免命名冲突, 并通过 named export 让 Checkbox.vue 直接 import.
   - 子 Checkbox 仍各自持有 value, group 只是协调 v-model; disabled / name 由 group
     提供但子级可覆盖 (disabled OR 关系; name group 优先).
   - 不渲染额外结构, 只 <slot /> 透传. 视觉间隔由子组件自己负责. */
import { provide } from 'vue';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** v-model. 当前选中的 value 列表; 空数组 = 全未选. */
  modelValue: Array<string | number | boolean>;
  /** 整组 disabled. 子 Checkbox 的 disabled 仍生效 (OR 关系). */
  disabled?: boolean;
  /** 自定义类名 (透传到 wrapper). */
  className?: string;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  className: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', vals: Array<string | number | boolean>): void;
  (e: 'change', vals: Array<string | number | boolean>): void;
}>();

/* ------------------------------------------------------------------ */
/*  Group name (auto-generated)                                        */
/* ------------------------------------------------------------------ */

const groupName = `cbgroup-${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------------ */
/*  Provide to children                                                */
/* ------------------------------------------------------------------ */

provide(CheckboxGroupKey, {
  get modelValue() {
    return props.modelValue;
  },
  update(vals: CheckboxGroupValue[]) {
    emit('update:modelValue', vals);
    emit('change', vals);
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
      'checkbox-group',
      { 'checkbox-group-disabled': disabled },
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
.checkbox-group {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.checkbox-group-disabled {
  opacity: 0.6;
  pointer-events: none;
}
</style>