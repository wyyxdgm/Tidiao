<script setup lang="ts">
/* 功能: 通用复选框. 单个 Checkbox = 单选 boolean; 多个 Checkbox 嵌在 CheckboxGroup 内
   自动变成多选 (v-model=Array). 用原生 <input type="checkbox"> 渲染保 a11y
   (键盘 Space 切换 / 屏幕阅读 / 焦点环全部免费); 自定义视觉盒子用 ::after 画钩.
   关注点:
   - provide/inject 注入 key —— group 内子 Checkbox 自动走 group 状态, 不需要
     用户手写 v-model. 同一个组件, 两种用法 (standalone / in-group) 由父级决定.
   - group 内子 Checkbox 通过 value 字段标识自己; group 的 v-model 是 value[].
   - labelPosition='right' 是默认 (标签在控件后 = 视觉/语义习惯一致: "复选框 [x] 同意条款");
     'left' 用于对齐标签列 (如表格行内).
   - indeterminate = 半选态 (常见于"全选/全不选"父级); 原生 input 的 indeterminate
     只能通过 DOM property 设置, 所以挂 ref + 同步 .indeterminate.
   - disabled 在 group 级透传, 子级显式 disabled 也保留 (OR 关系).
   - name 同 group 自动生成 (group-<uuid>, 避免与页面其他 radio 重名冲突). */
import { computed, inject, ref } from 'vue';
import { CheckboxGroupKey, type CheckboxGroupContext } from './CheckboxGroup.vue';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** v-model: standalone = boolean (勾/未勾); group 内 = 此 prop 被忽略,
      值由 group 通过 inject 提供. */
  modelValue?: boolean;
  /** group 内: 唯一标识这个 checkbox 的值; standalone 不需要. */
  value?: string | number | boolean;
  /** 标签文本. 不传 = 无文字 label, 仅渲染复选框 (可配合自定义 slot 内容). */
  label?: string;
  /** 标签位置. 'right' (默认) = label 在复选框右侧; 'left' = label 在左侧 (对齐用). */
  labelPosition?: 'left' | 'right';
  /** 禁用. 接受任何原因 (权限 / 表单未填). */
  disabled?: boolean;
  /** 半选态. 用于"全选"父级 = 部分子项被选场景. */
  indeterminate?: boolean;
  /** 原生 name. 不传 = group 自动生成 group-<uuid>; standalone 自动生成独立 name. */
  name?: string;
  /** 自定义类名 (透传到 wrapper). */
  className?: string;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  value: undefined,
  label: '',
  labelPosition: 'right',
  disabled: false,
  indeterminate: false,
  name: undefined,
  className: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', checked: boolean): void;
  (e: 'change', checked: boolean): void;
}>();

/* ------------------------------------------------------------------ */
/*  Group detection                                                    */
/* ------------------------------------------------------------------ */

const group = inject<CheckboxGroupContext | undefined>(CheckboxGroupKey, undefined);

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** 是否在 group 内. 决定 v-model 走法. */
const inGroup = computed(() => group !== undefined);

/** 当前勾选状态. group 内从 group.modelValue 推断; standalone 用自己的 modelValue. */
const isChecked = computed<boolean>(() => {
  if (group) {
    return group.modelValue.includes(props.value as never);
  }
  return props.modelValue;
});

/** 当前是否禁用. group 级 disabled OR 自带 disabled. */
const isDisabled = computed<boolean>(() => props.disabled || (group?.disabled ?? false));

/** 实际用于 <input> 的 name. group 内走 group.name; standalone 走自己的 name
    或生成独立 id (避免同名冲突). */
const inputName = computed<string>(() => {
  if (group) return group.name;
  if (props.name) return props.name;
  return `cb-${Math.random().toString(36).slice(2, 10)}`;
});

/** 用于 :class + 视觉对调. */
const isLabelLeft = computed(() => props.labelPosition === 'left');

/** 半选态标志. */
const isIndeterminate = computed(() => props.indeterminate);

/** 勾选态标志. indeterminate 优先级最高 (视觉上仍显示半选而非勾). */
const isCheckedClass = computed(() => isChecked.value && !props.indeterminate);

/* ------------------------------------------------------------------ */
/*  Imperative DOM handle (for indeterminate)                          */
/* ------------------------------------------------------------------ */

/** 原生 input ref —— indeterminate 必须通过 DOM property 设置,
    HTML 属性 indeterminate 只是初始值, 后续变更需要 .indeterminate = true. */
const inputRef = ref<HTMLInputElement | null>(null);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onChange(evt: Event): void {
  const target = evt.target as HTMLInputElement;
  const checked = target.checked;

  if (group) {
    // group 模式: 维护一个 value[]; toggle 当前 value.
    const current = group.modelValue;
    const next = checked
      ? [...current, props.value as never]
      : current.filter((v) => v !== props.value);
    group.update(next);
    // 单选 change 也照样 emit, 让父级有副作用钩子.
    emit('change', checked);
    return;
  }

  // standalone: 直接写回 v-model.
  emit('update:modelValue', checked);
  emit('change', checked);
}
</script>

<template>
  <label
    :class="[
      'cb-wrap',
      {
        'cb-wrap-label-left': isLabelLeft,
        'cb-wrap-disabled': isDisabled,
        'cb-checked': isCheckedClass,
        'cb-indeterminate': isIndeterminate,
      },
      className,
    ]"
  >
    <input
      ref="inputRef"
      type="checkbox"
      class="cb-native"
      :name="inputName"
      :checked="isChecked"
      :disabled="isDisabled"
      :indeterminate="indeterminate || undefined"
      @change="onChange"
    />
    <span class="cb-box" aria-hidden="true" />
    <span v-if="label" class="cb-label">{{ label }}</span>
  </label>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.cb-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 14px;
  color: var(--color-text);
  line-height: 1.4;
}
.cb-wrap-label-left {
  flex-direction: row-reverse;
}
.cb-wrap-disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* ------------------------------------------------------------------ */
/*  Native <input> (visually hidden, kept for a11y/focus/keyboard)     */
/* ------------------------------------------------------------------ */
.cb-native {
  /* 视觉盒子用 .cb-box 重画; 原生 input 仍然存在 (键盘 Space / 焦点环 / 屏幕阅读
     全部依靠它), 仅在视觉上"透明". */
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ------------------------------------------------------------------ */
/*  Visual box (drawn via label > .cb-box)                             */
/* ------------------------------------------------------------------ */
.cb-box {
  position: relative;
  display: inline-block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 1.5px solid var(--color-border-strong);
  border-radius: 3px;
  background: var(--color-bg-elevated);
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.cb-wrap:hover:not(.cb-wrap-disabled) .cb-box {
  border-color: var(--color-primary);
}
/* 焦点态: 原生 input:focus-visible + 相邻 .cb-box 画圈. */
.cb-native:focus-visible + .cb-box {
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25);
  border-color: var(--color-primary);
}
/* 勾选态 */
.cb-checked .cb-box,
.cb-indeterminate .cb-box {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.cb-checked .cb-box::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 9px;
  border-right: 2px solid #fff;
  border-bottom: 2px solid #fff;
  transform: translate(-50%, -65%) rotate(45deg);
}
/* 半选态: 横线代替钩 */
.cb-indeterminate .cb-box::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 9px;
  height: 0;
  border-bottom: 2px solid #fff;
  transform: translate(-50%, -50%);
}

/* ------------------------------------------------------------------ */
/*  Label                                                              */
/* ------------------------------------------------------------------ */
.cb-label {
  white-space: nowrap;
}
</style>