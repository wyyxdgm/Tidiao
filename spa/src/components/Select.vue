<script setup lang="ts">
/* 功能: 通用下拉选择 — 真实自定义 dropdown (button + ul), v-model 受控
   string|null, options: {label,value}[], placeholder + disabled + clearable +
   filterable. 视觉 + 行为对齐 Next.js Select.tsx (button trigger / 方向自适应 /
   点击外部关闭 / Escape 关闭 / 键盘导航 / chevron 旋转).

   关注点:
   - 与 Next.js Select.tsx 同款架构 (button + ul): 之前用原生 <select> +
     appearance:none, dropdown 弹出仍是 OS 原生 picker; 真自定义后才算"自定义
     组件". 键盘 a11y 自己实现 (ArrowUp/Down/Enter/Escape/Home/End), 原生 select
     行为我们用 WAI-ARIA listbox 模式重做.
   - 方向自适应: 打开时根据视口底部空间 (window.innerHeight - rect.bottom)
     判定 down vs up; 滚动/resize 时重算. 与 Next.js 同款.
   - 点击外部 + Escape 关闭; scrollIntoView 把选中项滚到可视区.
   - v-model 类型 = string | null, null = 未选 (placeholder 显示).
     clearable=true 时显示 ✕ 按钮, 点 → emit null.
   - filterable 默认 true (R241): 面板顶部加 input 实时过滤 options; 选项 ≤5 时
     自动隐藏输入框 (少选项键盘/点击已够快, 输入框纯噪声). 显式
     :filterable="false" 可关闭. 选中后输入框保留过滤词 (便于连续过滤),
     不像旧版自动清. 连续过滤场景下保留更顺手.
   - 输入框必须在绝对定位面板内 (2026-11-02): 之前放 trigger 上方文档流里,
     打开下拉即插入 30px, 把 toolbar / 表单行撑到近两行高 (damo 实测反馈).
     挪进面板后打开关闭零布局位移. */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  /** v-model 值. null = 未选 (显示 placeholder). */
  modelValue: string | null;
  /** 选项. {label, value} 结构, value 唯一. */
  options: SelectOption[];
  /** 未选时显示的提示文字. */
  placeholder?: string;
  /** 禁用. */
  disabled?: boolean;
  /** 是否可清空. true 时显示 ✕ 按钮. */
  clearable?: boolean;
  /** 是否可过滤. 默认 true (选项 ≤ FILTER_MIN_OPTIONS 时输入框自动隐藏);
      显式传 false 关闭. */
  filterable?: boolean;
  /** 自定义类名 (透传到 wrapper). */
  className?: string;
}

// placeholder 保持可选 (props 接口不变); 未传时兜底走 t() (不再写死中文).
const props = withDefaults(defineProps<Props>(), {
  placeholder: undefined,
  disabled: false,
  clearable: false,
  filterable: true,
  className: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void;
  /** 选项变更后触发 (与 update:modelValue 同帧; 给父组件做副作用/校验用). */
  (e: 'change', value: string | null): void;
}>();

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** 当前选中的 option. */
const selectedOption = computed<SelectOption | undefined>(() =>
  props.options.find((o) => o.value === props.modelValue),
);

/** trigger 上显示的文字. 选中 → label; 未选 → placeholder (灰色, 未传走 t() 兜底). */
const displayLabel = computed<string>(() =>
  selectedOption.value ? selectedOption.value.label : (props.placeholder ?? t('common.selectPlaceholder')),
);

/* ------------------------------------------------------------------ */
/*  Open / close state + direction                                     */
/* ------------------------------------------------------------------ */

const open = ref(false);
/** 打开方向: 'down' (默认) / 'up' (底部空间不够时翻到上方). */
const direction = ref<'down' | 'up'>('down');

/** 底部空间 < 此阈值 → 翻向上. 与 Next.js Select.tsx:DROPDOWN_NEEDED=248 同口径
    (max-h-60 = 240px + 8px gap); filterable 输入框在面板内再占 ~34px, 打开时动态加上. */
const DROPDOWN_NEEDED = 248;
const FILTER_ROW_HEIGHT = 34;

function recomputeDirection(): void {
  const el = triggerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const needed = DROPDOWN_NEEDED + (showFilter.value ? FILTER_ROW_HEIGHT : 0);
  direction.value = spaceBelow < needed ? 'up' : 'down';
}

/* ------------------------------------------------------------------ */
/*  Filter state                                                       */
/* ------------------------------------------------------------------ */

const filterInput = ref('');

/** 选项数 ≤ 此值时不显示过滤输入框 (少选项键盘/点击已够快, 输入框纯噪声).
    注意判据用原始 options.length 而非 filteredOptions —— 过滤后变少不应
    把输入框藏掉, 否则输入一个词框就消失, 行为诡异. */
const FILTER_MIN_OPTIONS = 6;

/** 过滤输入框是否渲染 (R241: filterable 默认开, 少选项自动隐藏). */
const showFilter = computed<boolean>(
  () => props.filterable && props.options.length >= FILTER_MIN_OPTIONS,
);

/** 过滤后的 options (不区分大小写). 空过滤词 = 全部. */
const filteredOptions = computed<SelectOption[]>(() => {
  const q = filterInput.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

/** 当前高亮的 option 索引 (键盘导航用). -1 = 无. */
const highlightedIndex = ref<number>(-1);

/** modelValue 变化时, 把高亮同步到当前选项. */
watch(
  () => props.modelValue,
  () => {
    highlightedIndex.value = filteredOptions.value.findIndex(
      (o) => o.value === props.modelValue,
    );
  },
  { immediate: true },
);

/** filterInput 变化时, 高亮跳到第一个匹配项 (便于 Enter 直选). */
watch(filterInput, () => {
  if (filteredOptions.value.length > 0) highlightedIndex.value = 0;
  else highlightedIndex.value = -1;
});

/* ------------------------------------------------------------------ */
/*  Refs                                                               */
/* ------------------------------------------------------------------ */

const wrapperRef = ref<HTMLDivElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLUListElement | null>(null);
const filterInputRef = ref<HTMLInputElement | null>(null);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function toggleOpen(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

function close(): void {
  open.value = false;
  // 关掉时清过滤词, 跟打开新一次的干净状态对齐.
  filterInput.value = '';
}

function selectOption(opt: SelectOption): void {
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  close();
  // 选中后焦点回到 trigger (符合 WAI-ARIA listbox 模式).
  triggerRef.value?.focus();
}

function clearValue(e: MouseEvent): void {
  e.stopPropagation();
  if (props.disabled) return;
  emit('update:modelValue', null);
  emit('change', null);
}

/** trigger 的键盘事件 — 方向键 / Enter / Escape / Home / End. */
function onTriggerKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  // 关闭态: ArrowDown / Enter / Space 打开 dropdown.
  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open.value = true;
    }
    return;
  }
  // 打开态的键盘导航.
  const list = filteredOptions.value;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      highlightedIndex.value = Math.min(highlightedIndex.value + 1, list.length - 1);
      scrollHighlightedIntoView();
      break;
    case 'ArrowUp':
      e.preventDefault();
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, 0);
      scrollHighlightedIntoView();
      break;
    case 'Home':
      e.preventDefault();
      highlightedIndex.value = 0;
      scrollHighlightedIntoView();
      break;
    case 'End':
      e.preventDefault();
      highlightedIndex.value = list.length - 1;
      scrollHighlightedIntoView();
      break;
    case 'Enter':
      e.preventDefault();
      if (highlightedIndex.value >= 0 && highlightedIndex.value < list.length) {
        selectOption(list[highlightedIndex.value]);
      }
      break;
    case 'Escape':
      e.preventDefault();
      close();
      triggerRef.value?.focus();
      break;
    case 'Tab':
      close();
      break;
  }
}

/** dropdown 内部的键盘事件 — filterable 模式下 input 也会触发 keydown, 在这里再转一次. */
function onListKeydown(e: KeyboardEvent): void {
  onTriggerKeydown(e);
}

function scrollHighlightedIntoView(): void {
  void nextTick(() => {
    const list = listRef.value;
    if (!list || highlightedIndex.value < 0) return;
    const item = list.children[highlightedIndex.value] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  });
}

/* ------------------------------------------------------------------ */
/*  Open lifecycle: 重算方向 + scrollIntoView 选中项                  */
/* ------------------------------------------------------------------ */

watch(open, async (isOpen) => {
  if (!isOpen) return;
  recomputeDirection();
  // 把选中项滚到可视区 (与 Next.js Select.tsx 同款).
  await nextTick();
  const list = listRef.value;
  if (!list) return;
  const idx = filteredOptions.value.findIndex((o) => o.value === props.modelValue);
  if (idx >= 0) {
    highlightedIndex.value = idx;
    const item = list.children[idx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  } else {
    highlightedIndex.value = filteredOptions.value.length > 0 ? 0 : -1;
  }
  // filterable 模式打开时聚焦过滤输入框.
  if (showFilter.value) {
    await nextTick();
    filterInputRef.value?.focus();
  }
});

/* ------------------------------------------------------------------ */
/*  Click outside + global Escape handlers                              */
/* ------------------------------------------------------------------ */

function onDocumentMousedown(e: MouseEvent): void {
  if (!open.value) return;
  const wrap = wrapperRef.value;
  if (wrap && !wrap.contains(e.target as Node)) close();
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (open.value && e.key === 'Escape') {
    close();
    triggerRef.value?.focus();
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('resize', recomputeDirection);
  window.addEventListener('scroll', recomputeDirection, true);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('resize', recomputeDirection);
  window.removeEventListener('scroll', recomputeDirection, true);
});
</script>

<template>
  <div
    ref="wrapperRef"
    :class="['select-wrap', { 'select-disabled': disabled, 'select-open': open }, className]"
  >
    <!-- Filterable: 渲染过滤输入框. showFilter = filterable && 选项数达标.
         输入框与 trigger 视觉融合 (共享 border-radius, trigger 上圆角此时削平). -->
    <input
      v-if="showFilter && open"
      ref="filterInputRef"
      v-model="filterInput"
      type="text"
      class="select-filter"
      :placeholder="t('common.filterN', { n: options.length })"
      :disabled="disabled"
      autocomplete="off"
      @keydown="onListKeydown"
    />

    <!-- Trigger: button (不是原生 select). -->
    <button
      ref="triggerRef"
      type="button"
      :disabled="disabled"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      :class="[
        'select-trigger',
        { 'select-trigger-placeholder': !selectedOption && placeholder },
        { 'select-trigger-active': open },
      ]"
      @click="toggleOpen"
      @keydown="onTriggerKeydown"
    >
      <span class="select-trigger-label">{{ displayLabel }}</span>
      <!-- Chevron: SVG 而非字符 (字符渲染跨平台不一致). 与 Next 同款 chevron 旋转. -->
      <svg
        class="select-chevron"
        :class="{ 'select-chevron-open': open }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <!-- Clear button. 仅 clearable + 有值 + 非 disabled 时显示. -->
      <span
        v-if="clearable && modelValue !== null && !disabled"
        class="select-clear"
        role="button"
        tabindex="-1"
        :aria-label="t('common.clearSelect')"
        @click="clearValue"
      >×</span>
    </button>

    <!-- Dropdown panel: 绝对定位容器 = 过滤输入框 + listbox 都住里面.
         2026-11-02 修「打开下拉把宿主行撑高近两行」: 过滤输入框之前渲染在 trigger
         上方的正常文档流里, 打开即插进 30px, toolbar/modal 等密集布局被挤压;
         挪进面板后打开/关闭零布局位移 (面板不占流内空间). -->
    <div
      v-if="open && !disabled"
      :class="['select-panel', direction === 'up' ? 'select-panel-up' : 'select-panel-down']"
    >
      <!-- Filterable: 渲染过滤输入框. showFilter = filterable && 选项数达标. -->
      <input
        v-if="showFilter"
        ref="filterInputRef"
        v-model="filterInput"
        type="text"
        class="select-filter"
        :placeholder="t('common.filterN', { n: options.length })"
        :disabled="disabled"
        autocomplete="off"
        @keydown="onListKeydown"
      />

      <!-- Dropdown listbox. 用 <ul role="listbox"> + <li role="option">. -->
      <ul ref="listRef" role="listbox" :aria-label="displayLabel" class="select-list">
        <li
          v-for="(opt, idx) in filteredOptions"
          :key="opt.value"
          role="option"
          :aria-selected="opt.value === modelValue"
          :class="[
            'select-option',
            { 'select-option-selected': opt.value === modelValue },
            { 'select-option-highlighted': idx === highlightedIndex },
          ]"
          @click="selectOption(opt)"
          @mouseenter="highlightedIndex = idx"
        >
          {{ opt.label }}
        </li>
        <li v-if="filteredOptions.length === 0" class="select-option-empty" role="presentation">
          {{ t('common.noOptions') }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Wrapper                                                            */
/* ------------------------------------------------------------------ */
.select-wrap {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  width: 100%;
}
.select-disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/*  Dropdown panel (过滤输入框 + listbox 的共同绝对定位容器)            */
/* ------------------------------------------------------------------ */
.select-panel {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 50;
  padding: 4px;
  background: var(--color-bg-elevated, #fff);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.select-panel-down {
  top: 100%;
  margin-top: 4px;
}
.select-panel-up {
  bottom: 100%;
  margin-bottom: 4px;
}

/* ------------------------------------------------------------------ */
/*  Filter input (filterable 模式) — 面板顶部内嵌搜索框                 */
/* ------------------------------------------------------------------ */
/* R59+: 跟 trigger + Input + Button 同 30px 档 (用户反馈「输入框也统一」) */
.select-filter {
  width: 100%;
  padding: 4px 10px;
  height: 30px;
  box-sizing: border-box;
  margin-bottom: 4px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg);
  font-size: 12px;
  line-height: 1.2;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.select-filter:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

/* ------------------------------------------------------------------ */
/*  Trigger                                                            */
/* ------------------------------------------------------------------ */
/* R59+: 统一 30px 档 — 跟 Input + Button 同档 (用户反馈「输入框也统一,
   因为多数按钮和输入框会在一块」). 之前 padding 7×10 + font 14 +
   line-height 1.4 ~35-36px 高, 比 Button 30px 高 5-6px. 现在 4×10 /
   12px / 30px + box-sizing:border-box. */
.select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 4px 10px;
  height: 30px;
  box-sizing: border-box;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  background: var(--color-bg-elevated);
  font-size: 12px;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.select-trigger:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}
.select-trigger:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.select-trigger:disabled {
  background: var(--color-bg);
  cursor: not-allowed;
}
/* 选中态 (placeholder 显示时) 文字用 muted 色. */
.select-trigger-placeholder .select-trigger-label {
  color: var(--color-text-muted);
}

/* ------------------------------------------------------------------ */
/*  Trigger label + chevron + clear                                   */
/* ------------------------------------------------------------------ */
.select-trigger-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.select-chevron {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}
.select-chevron-open {
  transform: rotate(180deg);
}
.select-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 4px;
  border-radius: 50%;
  background: var(--color-border);
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.select-clear:hover {
  background: var(--color-border-strong);
  color: var(--color-text);
}

/* ------------------------------------------------------------------ */
/*  Dropdown listbox — 滚动区 (定位/边框已上移到 .select-panel)         */
/* ------------------------------------------------------------------ */
.select-list {
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */
.select-option {
  padding: 7px 10px;
  font-size: 14px;
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}
.select-option:hover,
.select-option-highlighted {
  background: var(--color-bg, #f3f4f6);
}
.select-option-selected {
  background: rgba(37, 99, 235, 0.08);
  color: var(--color-primary, #2563eb);
  font-weight: 500;
}
.select-option-empty {
  padding: 7px 10px;
  font-size: 14px;
  color: var(--color-text-muted);
  cursor: default;
}
</style>
