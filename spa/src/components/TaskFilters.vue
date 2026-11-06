<script setup lang="ts">
/* 功能: 任务筛选条 — 项目多选 + 状态多选 (chip) + 搜索框 三种筛选组合.
   单文件组件, 内部维护 FilterState (projects / statuses / search), 通过 v-model 双向
   绑定给父组件. 父组件按需把 FilterState 持久化 (URL query / localStorage / 父级
   store). 与 R14 BoardPage "URL 即真相" 口径一致: 父组件拿到 v-model 后写
   router.replace, watch URL 触发 fetch —— 组件本身不耦合 router.

   关注点 (R16 边界):
   - 只做 "项目 + 状态 + 搜索" 三件套, 不画蛇添足 model/tag/showDeleted —
     这三项在 R14 BoardPage 中已稳定, 本组件不强合并; 后续如需统一, 单独 task 接入.
   - 项目多选: 走 CheckboxGroup + value=project.id 方案, 自动注入 group 状态;
     受 BoardPage / 别的视图给 options 后才能渲染 (空数组 = 不显示项目栏).
   - 状态多选: 走 chip button + aria-pressed, 与 R14 BoardPage status chip
     同视觉 (rounded pill + 浅 bg + 较深 text + low-saturation); click toggle.
   - 搜索框: 走 R8 Input + clearable, placeholder 由父组件传 (看板视图用
     "搜索标题、指令、结果、ID...", 全局视图可换为 "搜索 task..." 等).
   - 不挂 SSE / 不做拖拽 / 不内嵌右键菜单. 这是纯展示+交互组件, 没有副作用.
   - v-model Set/Array 兼容性: 内部每次变更都构造新 Set/Array 实例 (避免父组件
     reactivity 失效); 父组件 watch modelValue 即可.
   - 与 R14 BoardPage 联动: 父组件拿到 modelValue 后按 URL query 命名空间
     写入 (?projects=id1,id2 / ?statuses=active 集合 / ?q=xxx); BoardPage 已
     有的 watch [statusGroup, debouncedSearch, modelFilter, tagFilter, showDeleted, pageSize]
     只需扩到包含 selectedProjects 即可 (后续 task, 不在 R16 范围内). */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Checkbox from '@/components/Checkbox.vue';
import CheckboxGroup from '@/components/CheckboxGroup.vue';
import Input from '@/components/Input.vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** 任务状态 11 个 — 与 master TaskStatus 对齐 (R131 加入 await_user). */
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'reviewing'
  | 'verifying'
  | 'await_user'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

/** 项目选项. id 唯一 (UUID), label 显示名 (项目名). */
export interface ProjectOption {
  id: string;
  label: string;
}

/** 筛选状态对象 — v-model 双向绑定.
    始终为完整状态: projects 全未选 = []; statuses 全未选 = [];
    "全选" 判定由父组件根据 visibleStatuses.length 对比决定. */
export interface FilterState {
  /** 选中项目 id 列表. [] = 无项目筛选. */
  projects: string[];
  /** 选中 status 列表 (来自 visibleStatuses 子集). [] = 无 status 筛选. */
  statuses: TaskStatus[];
  /** 搜索文本. '' = 无搜索. */
  search: string;
}

interface Props {
  /** v-model 筛选状态. 必传, 由父组件提供初始值. */
  modelValue: FilterState;
  /** 项目选项. 长度 0 = 不显示项目栏 (适用 version board 单项目场景). */
  projectOptions: ProjectOption[];
  /** 当前可见的 status 集合 (active 7 / terminal 4). 决定 chip 渲染数量
      与 "全选" 判定. */
  visibleStatuses: TaskStatus[];
  /** status 中文标签映射. 不传 status 时走原值. */
  statusLabels?: Partial<Record<TaskStatus, string>>;
  /** status chip class 映射 (组件作用域内). 不传 = 走默认浅灰. */
  statusColors?: Partial<Record<TaskStatus, string>>;
  /** 搜索框 placeholder. 缺省 = "搜索...". */
  searchPlaceholder?: string;
  /** 是否显示项目栏. 默认 true (projectOptions.length > 0 才生效). */
  showProject?: boolean;
  /** 是否显示状态栏. 默认 true. */
  showStatus?: boolean;
  /** 禁用整组件. */
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  statusLabels: () => ({}),
  statusColors: () => ({}),
  searchPlaceholder: undefined,
  showProject: true,
  showStatus: true,
  disabled: false,
});

// i18n: searchPlaceholder 未传时兜底走当前语言 (调用方传入值优先).
const { t } = useI18n();
const searchPlaceholderText = computed(
  () => props.searchPlaceholder ?? t('tasks.filters.searchPlaceholder'),
);

const emit = defineEmits<{
  /** v-model 更新 (整个 FilterState 替换). */
  (e: 'update:modelValue', value: FilterState): void;
}>();

/* ------------------------------------------------------------------ */
/*  Internal state (mirror modelValue, mutated via emit)               */
/* ------------------------------------------------------------------ */

/** 本地镜像. 用 ref 而不是直接绑 props.modelValue 是为了: 父组件可以传 Set /
    Array 任意形态, 这里统一处理; 同时确保 emit 时构造新引用避免父 reactive 失效. */
const localProjects = ref<string[]>([...props.modelValue.projects]);
const localStatuses = ref<TaskStatus[]>([...props.modelValue.statuses]);
const localSearch = ref<string>(props.modelValue.search);

/** 父组件外部 modelValue 变化时同步本地 (e.g. URL query 改变 → 父更新 → 同步). */
watch(
  () => props.modelValue,
  (next) => {
    localProjects.value = [...next.projects];
    localStatuses.value = [...next.statuses];
    localSearch.value = next.search;
  },
  { deep: false },
);

/** emit helper — 一次性发整个 FilterState, 避免父组件 v-model 接三个不同 prop
    时顺序错位. 每次都构造新对象保证引用变化触发 reactivity. */
function emitUpdate(): void {
  emit('update:modelValue', {
    projects: [...localProjects.value],
    statuses: [...localStatuses.value],
    search: localSearch.value,
  });
}

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

/** 项目栏是否渲染: showProject && projectOptions.length > 0. */
const renderProject = computed<boolean>(() =>
  props.showProject && props.projectOptions.length > 0,
);

/** 状态栏是否渲染: showStatus && visibleStatuses.length > 0. */
const renderStatus = computed<boolean>(() =>
  props.showStatus && props.visibleStatuses.length > 0,
);

/** CheckboxGroup v-model 适配: localProjects 是 string[], 直接传入即可
    (CheckboxGroup 接受 Array<string | number | boolean>). */
const projectsModel = computed<string[]>({
  get: () => localProjects.value,
  set: (v: Array<string | number | boolean>) => {
    localProjects.value = v.filter((x): x is string => typeof x === 'string');
    emitUpdate();
  },
});

/** status 全选判定. localStatuses.length === visibleStatuses.length 时认为
    全选 (与 R14 BoardPage "全选不写 URL" 行为一致 —— 但本组件把决策权留给父组件,
    始终发完整数组). */
const allStatusesSelected = computed<boolean>(
  () => localStatuses.value.length === props.visibleStatuses.length,
);

/** status chip 渲染 — 自带 status, 走 statusColors + statusLabels. */
const statusChips = computed<Array<{ status: TaskStatus; label: string; className: string }>>(
  () => props.visibleStatuses.map((s) => ({
    status: s,
    label: props.statusLabels[s] || s,
    className: props.statusColors[s] || 'tf-status-default',
  })),
);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

/** chip toggle. 已有则删, 没有则加. */
function toggleStatus(s: TaskStatus): void {
  const cur = localStatuses.value;
  const has = cur.includes(s);
  localStatuses.value = has ? cur.filter((x) => x !== s) : [...cur, s];
  emitUpdate();
}

/** "全选 / 全不选" 切换按钮. */
function toggleAllStatuses(): void {
  if (allStatusesSelected.value) {
    localStatuses.value = [];
  } else {
    localStatuses.value = [...props.visibleStatuses];
  }
  emitUpdate();
}

/** 搜索框输入. Input 内部已 emit update:modelValue (string), 这里 wrap 一层
    走 emitUpdate() 保持单一出口. */
function onSearchInput(v: string): void {
  localSearch.value = v;
  emitUpdate();
}

/** "清除全部筛选" — 一键回到空状态. */
function clearAll(): void {
  localProjects.value = [];
  localStatuses.value = [];
  localSearch.value = '';
  emitUpdate();
}

/** 是否处于 "有筛选" 状态 (决定清空按钮是否显示). */
const hasAnyFilter = computed<boolean>(() =>
  localProjects.value.length > 0 ||
  localStatuses.value.length > 0 ||
  localSearch.value.length > 0,
);
</script>

<template>
  <div :class="['tf-root', { 'tf-disabled': disabled }]">
    <!-- Row 1: 项目多选 (CheckboxGroup) -->
    <div v-if="renderProject" class="tf-row">
      <span class="tf-label">{{ t('tasks.filters.projectLabel') }}</span>
      <CheckboxGroup
        v-model="projectsModel"
        :disabled="disabled"
        class-name="tf-project-group"
      >
        <Checkbox
          v-for="opt in projectOptions"
          :key="opt.id"
          :value="opt.id"
          :label="opt.label"
          :disabled="disabled"
        />
      </CheckboxGroup>
    </div>

    <!-- Row 2: 状态多选 (chip) -->
    <div v-if="renderStatus" class="tf-row">
      <span class="tf-label">{{ t('tasks.filters.statusLabel') }}</span>
      <button
        type="button"
        :class="[
          'tf-status-chip',
          { 'tf-status-chip-all': allStatusesSelected },
        ]"
        :aria-pressed="allStatusesSelected"
        :disabled="disabled"
        @click="toggleAllStatuses"
      >
        {{ allStatusesSelected ? t('tasks.filters.selectAll') : t('tasks.filters.selectNone') }}
      </button>
      <button
        v-for="chip in statusChips"
        :key="chip.status"
        type="button"
        :class="[
          'tf-status-chip',
          chip.className,
          {
            'tf-status-chip-on': localStatuses.includes(chip.status),
            'tf-status-chip-off': !localStatuses.includes(chip.status),
          },
        ]"
        :aria-pressed="localStatuses.includes(chip.status)"
        :disabled="disabled"
        @click="toggleStatus(chip.status)"
      >
        {{ chip.label }}
      </button>
    </div>

    <!-- Row 3: 搜索 + 清空 -->
    <div class="tf-row tf-row-search">
      <div class="tf-search">
        <Input
          :model-value="localSearch"
          :placeholder="searchPlaceholderText"
          clearable
          :disabled="disabled"
          @update:model-value="onSearchInput"
        />
      </div>
      <button
        v-if="hasAnyFilter && !disabled"
        type="button"
        class="tf-clear-all"
        :aria-label="t('tasks.filters.clearAllAria')"
        @click="clearAll"
      >
        {{ t('tasks.filters.clearAll') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

.tf-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0;
}

.tf-disabled {
  opacity: 0.6;
  pointer-events: none;
}

.tf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tf-row-search {
  gap: 12px;
  align-items: center;
}

.tf-label {
  font-size: 13px;
  color: var(--color-text-muted, #6b7280);
  flex-shrink: 0;
  min-width: 32px;
}

/* ------------------------------------------------------------------ */
/*  Project group (CheckboxGroup wrap)                                 */
/* ------------------------------------------------------------------ */

.tf-project-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

/* ------------------------------------------------------------------ */
/*  Status chip — 与 BoardPage R14 scoped class 同源色系              */
/* ------------------------------------------------------------------ */

.tf-status-chip {
  padding: 4px 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, text-decoration 0.15s;
  background: var(--color-bg-elevated, #f9fafb);
  color: var(--color-text, #374151);
}

.tf-status-chip-all {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text-muted, #6b7280);
  border-color: var(--color-border, #e5e7eb);
}

.tf-status-chip-off {
  opacity: 0.4;
  text-decoration: line-through;
}

.tf-status-chip-on:hover,
.tf-status-chip-off:hover {
  opacity: 1;
}

.tf-status-chip:disabled {
  cursor: not-allowed;
}

/* 11 状态色 — 与 BoardPage R14 / TaskCard R15 scoped class 同源.
   不引 Tailwind palette, 保持项目统一风格. */
.tf-status-pending    { background: var(--tw-gray-100); color: var(--tw-gray-700); }
.tf-status-queued     { background: var(--tw-blue-100); color: var(--tw-blue-700); }
.tf-status-running    { background: var(--tw-sky-100); color: var(--tw-sky-700); }
.tf-status-paused     { background: var(--tw-yellow-100); color: var(--tw-yellow-800); }
.tf-status-reviewing  { background: var(--tw-purple-100); color: var(--tw-purple-800); }
.tf-status-verifying  { background: var(--tw-violet-100); color: var(--tw-violet-800); }
.tf-status-await-user { background: var(--tw-amber-100); color: var(--tw-amber-800); }
.tf-status-completed  { background: var(--tw-emerald-100); color: var(--tw-emerald-800); }
.tf-status-failed     { background: var(--tw-red-100); color: var(--tw-red-800); }
.tf-status-rejected   { background: var(--tw-orange-50); color: var(--tw-orange-700); }
.tf-status-cancelled  { background: var(--tw-gray-100); color: var(--tw-gray-500); }
.tf-status-default    { background: var(--tw-gray-100); color: var(--tw-gray-700); }

/* ------------------------------------------------------------------ */
/*  Search + clear                                                    */
/* ------------------------------------------------------------------ */

.tf-search {
  flex: 1;
  min-width: 220px;
  max-width: 380px;
}

.tf-clear-all {
  border: 1px solid var(--color-border, #e5e7eb);
  background: var(--color-bg-elevated, #ffffff);
  color: var(--color-text-muted, #6b7280);
  padding: 6px 12px;
  border-radius: var(--radius, 4px);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.tf-clear-all:hover {
  background: var(--color-bg, #f3f4f6);
  color: var(--color-text, #111827);
  border-color: var(--color-border-strong, #d1d5db);
}

.tf-clear-all:focus-visible {
  outline: 2px solid var(--color-primary, #2563eb);
  outline-offset: 1px;
}
</style>