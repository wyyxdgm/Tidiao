<script setup lang="ts">
/* 功能: 通用单选按钮. 通常嵌在 RadioGroup 内使用 (v-model=单值); 单独使用也可
   (v-model=boolean 时 = toggle button 语义, 但典型用法是 in-group).
   用原生 <input type="radio"> 渲染保 a11y (键盘箭头切换 / 屏幕阅读 / 焦点环全部免费);
   自定义视觉圆点用 ::after 画.
   关注点:
   - provide/inject 注入 key —— group 内子 Radio 自动走 group 状态, 不需要
     用户手写 v-model.
   - group 内子 Radio 通过 value 字段标识自己; 选中判定 = group.modelValue === this.value.
   - labelPosition='right' 是默认 (标签在控件后); 'left' 用于对齐.
   - disabled 在 group 级透传, 子级显式 disabled 也保留 (OR 关系).
   - name 同 group 自动生成, 浏览器原生根据 name 互斥 + 方向键切换 (单选组的核心机制).
   - standalone 用法保留: v-model=boolean (勾/未勾 toggle 语义). */
import { computed, inject } from 'vue';
import { RadioGroupKey, type RadioGroupContext } from './RadioGroup.vue';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export type RadioValue = string | number | boolean;

interface Props {
  /** group 内: 唯一标识这个 radio 的值. */
  value: RadioValue;
  /** v-model. group 内 = 此 prop 被忽略, 值由 group 通过 inject 提供.
      standalone (无 group) = boolean (勾/未勾 toggle 语义). */
  modelValue?: RadioValue | boolean;
  /** 标签文本. 不传 = 无文字 label, 仅渲染圆点. */
  label?: string;
  /** 标签位置. 'right' (默认) = label 在 radio 右侧; 'left' = label 在左侧 (对齐用). */
  labelPosition?: 'left' | 'right';
  /** 禁用. */
  disabled?: boolean;
  /** 原生 name. 不传 = group 自动生成 group-<uuid>; standalone 自动生成独立 name. */
  name?: string;
  /** 自定义类名. */
  className?: string;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: false,
  label: '',
  labelPosition: 'right',
  disabled: false,
  name: undefined,
  className: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', val: RadioValue): void;
  (e: 'change', val: RadioValue): void;
}>();

/* ------------------------------------------------------------------ */
/*  Group detection                                                    */
/* ------------------------------------------------------------------ */

const group = inject<RadioGroupContext | undefined>(RadioGroupKey, undefined);

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** 是否在 group 内. 决定 v-model 走法. */
const inGroup = computed(() => group !== undefined);

/** 当前是否选中. group 内: modelValue === this.value; standalone: boolean modelValue. */
const isChecked = computed<boolean>(() => {
  if (group) {
    return group.modelValue === props.value;
  }
  return Boolean(props.modelValue);
});

/** 当前是否禁用. */
const isDisabled = computed<boolean>(() => props.disabled || (group?.disabled ?? false));

/** 实际用于 <input> 的 name. group 优先 (同组 name 让浏览器原生互斥 + 方向键切换). */
const inputName = computed<string>(() => {
  if (group) return group.name;
  if (props.name) return props.name;
  return `rd-${Math.random().toString(36).slice(2, 10)}`;
});

const isLabelLeft = computed(() => props.labelPosition === 'left');

/** 勾选态标志. 用于 wrapper :class 触发 .rd-checked CSS. */
const isCheckedClass = computed(() => isChecked.value);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onChange(): void {
  if (group) {
    // group 模式: 写 group.modelValue = this.value.
    group.update(props.value);
    emit('change', props.value);
    return;
  }
  // standalone: toggle 语义. emit 反向值.
  const next = !props.modelValue;
  emit('update:modelValue', next);
  emit('change', next);
}
</script>

<template>
  <label
    :class="[
      'rd-wrap',
      {
        'rd-wrap-label-left': isLabelLeft,
        'rd-wrap-disabled': isDisabled,
        'rd-checked': isCheckedClass,
      },
      className,
    ]"
  >
    <input
      type="radio"
      class="rd-native"
      :name="inputName"
      :checked="isChecked"
      :disabled="isDisabled"
      :value="value"
      @change="onChange"
    />
    <span class="rd-dot" aria-hidden="true" />
    <span v-if="label" class="rd-label">{{ label }}</span>
  </label>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.rd-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 14px;
  color: var(--color-text);
  line-height: 1.4;
}
.rd-wrap-label-left {
  flex-direction: row-reverse;
}
.rd-wrap-disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* ------------------------------------------------------------------ */
/*  Native <input> (visually hidden)                                   */
/* ------------------------------------------------------------------ */
.rd-native {
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
/*  Visual circle (drawn via label > .rd-dot)                          */
/* ------------------------------------------------------------------ */
.rd-dot {
  position: relative;
  display: inline-block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 1.5px solid var(--color-border-strong);
  border-radius: 50%;
  background: var(--color-bg-elevated);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.rd-wrap:hover:not(.rd-wrap-disabled) .rd-dot {
  border-color: var(--color-primary);
}
/* 焦点态: 原生 input:focus-visible + 相邻 .rd-dot 画圈. */
.rd-native:focus-visible + .rd-dot {
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25);
  border-color: var(--color-primary);
}
/* 选中态: 外环变蓝, 中心填充实心圆点. */
.rd-checked .rd-dot {
  border-color: var(--color-primary);
}
.rd-checked .rd-dot::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  transform: translate(-50%, -50%);
}

/* ------------------------------------------------------------------ */
/*  Label                                                              */
/* ------------------------------------------------------------------ */
.rd-label {
  white-space: nowrap;
}
</style>