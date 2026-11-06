<script setup lang="ts">
/* 功能: 标准分页组件 — model-value=currentPage (1-indexed) + pageSize/total props
   + 每页大小切换 + 跳转指定页. v-model 双向同步当前页, pageSize 变化通过
   update:pageSize 上抛 (父组件负责持久化, 通常配合 watch + 后端 query).

   关注点:
   - 与 Next.js Pagination.tsx 的核心差异 (拍板, R12 §6 披露):
       Next 版走 URL ?page=&pageSize= 持久化 + children render prop 提供当前页切片.
       Vue 版走 v-model + props, 不耦合路由, 调用方拿数据后自己 slice.
       理由: Vue 组件 API 更直接, 不强制把 URL 作为单一真相; 任务清单 R12
       字面要求 "model-value=currentPage；pageSize, total props" = 按 props 模型走.
   - 总页数 = max(1, ceil(total / pageSize)). total=0 时返回 null (无数据不分页).
   - 当前页越界 (page total > totalPages) → 修正为 totalPages, 同时 emit
     update:modelValue 通知父组件 (用 nextTick 防止 emit 在 props 同步路径上
     造成无限循环).
   - 跳转 input 受控: Enter / blur 提交, 非法 (≤0 / > totalPages / NaN)
     时还原为当前 page (与禁用按钮语义一致).
   - 每页大小切换: 仅 emit update:pageSize, 不主动 emit update:modelValue —
     page reset 交由父组件 (例 GlobalBoard onPageSizeChange 设
     currentPage.value=1 → URL 写回 → Pagination 从 modelValue prop 自动同步).
     早期版本这里主动 emit modelValue(1) 引发并发 race (见 onPageSizeChange
     内部注释 R56-B19).
   - totalPages 变化 (后端换 pageSize 后总页数变了) → 当前页若超出, 自动
     emit 修正; 用 watch 触发.
   - 样式对齐 Next Pagination.tsx: gray 边框 + hover 蓝边, compact 数字按钮.
   - 每页大小走 R58 抽出的封装组件 @/components/Select (R64 立规: 禁原生
     <select>). Select 的 v-model = string | null, 这里 pageSize 是 number,
     内部 pageSizeSelectValue 桥接 (string ↔ number), 对外 update:pageSize
     仍 emit number 不破坏调用方契约.
   - 不引外部依赖, 原生 <button> + <input type=number>. */
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Select, { type SelectOption } from '@/components/Select.vue';

const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** 当前页 (1-indexed). v-model 受控. */
  modelValue: number;
  /** 每页大小. */
  pageSize: number;
  /** 总条数. 0 = 默认不渲染; forceShow=true 时仍渲染 (board-body 无数据时
     保留底部分页占位, 否则整块塌成 Empty 一行 — 用户反馈触发). */
  total: number;
  /** 每页大小选项. 默认 [10, 20, 50, 100]. 第一项 = 默认 pageSize. */
  pageSizeOptions?: number[];
  /** 禁用整个分页条 (灰态, 不响应交互). */
  disabled?: boolean;
  /** 自定义类名 (透传到容器). */
  className?: string;
  /** 强制渲染 (即使 total=0). 默认 false 保持原行为. 与 disabled 互不影响:
     total=0 + forceShow=true → 渲染但所有翻页按钮 disabled, pageSize select
     仍可点 (改了会触发 update:pageSize 让父组件 reload). */
  forceShow?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  pageSizeOptions: () => [10, 20, 50, 100],
  disabled: false,
  className: '',
  forceShow: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', page: number): void;
  (e: 'update:pageSize', size: number): void;
}>();

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

/** total=0 默认不渲染; forceShow=true 时强制渲染 (board-body 无数据时保留底
    部分页占位). 总页数在 total=0 时显示为 1 (兜底, 让按钮 disabled 有意义). */
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

/** 当前页 (clamp 到合法范围). 给 UI 用的真实值, 不直接当 emit 值. */
const page = computed(() => Math.min(Math.max(1, props.modelValue || 1), totalPages.value));

/** 跳转 input 受控值. 与 page 解耦, 输入时不立即 emit. */
const pageInput = ref(String(page.value));

/** modelValue / totalPages 变化 → 同步 pageInput; 越界时 emit 修正. */
watch(
  [() => props.modelValue, totalPages],
  ([_modelValue, newTotalPages], [oldModelValue, oldTotalPages]) => {
    // 1) 同步 input 显示
    pageInput.value = String(page.value);
    // 2) 越界修正 (避免 page=5 但 totalPages=3 → 渲染白页).
    if (props.modelValue !== page.value && props.modelValue > 0) {
      const isInitial = oldModelValue === undefined;
      // 跨边界变化时 emit, 避免初次挂载 + props 初始化形成竞态.
      if (!isInitial && oldTotalPages !== newTotalPages) {
        nextTick(() => emit('update:modelValue', page.value));
      } else if (props.modelValue > newTotalPages) {
        // 首次挂载就超界 (服务端返回空但 page=1 默认?), 立即修正.
        nextTick(() => emit('update:modelValue', page.value));
      }
    }
  },
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

/** 跳页 input 提交 (Enter + blur 共用). 非法值还原. */
function commitPageInput(): void {
  const n = parseInt(pageInput.value, 10);
  if (!Number.isFinite(n) || n < 1 || n > totalPages.value) {
    pageInput.value = String(page.value);
    return;
  }
  if (n !== page.value) {
    emit('update:modelValue', n);
  }
}

function goToPage(next: number): void {
  if (props.disabled) return;
  const clamped = Math.min(Math.max(1, next), totalPages.value);
  if (clamped !== props.modelValue) {
    emit('update:modelValue', clamped);
  }
}

/** total=0 默认不渲染; forceShow=true 时强制渲染 (board-body 无数据时
    保留底部分页占位, 视觉锚点不断). */
const shouldRender = computed(() => props.total > 0 || props.forceShow);

/* ------------------------------------------------------------------ */
/*  R58 page size Select 桥接 — string ↔ number                       */
/* ------------------------------------------------------------------ */

/** Select 组件的 options: {value: '20', label: '20'}[]. 每页大小场景下
    label = 数字本身即可 (没有「20 条/页」语义扩展). */
const pageSizeSelectOptions = computed<SelectOption[]>(() =>
  props.pageSizeOptions.map((n) => ({ value: String(n), label: String(n) })),
);

/** Select 的 v-model 是 string | null. pageSize 是 number, 这里包一层
    computed 做适配: get 时把 number 转 string, set 时把 string 解析回
    number 并 emit update:pageSize (保留对外契约). */
const pageSizeSelectValue = computed<string | null>({
  get: () => String(props.pageSize),
  set: (v) => {
    if (props.disabled) return;
    if (v === null) return; // Select clearable=null 时也会传 null, 我们不接 null 语义
    const next = parseInt(v, 10);
    if (!Number.isFinite(next) || next === props.pageSize) return;
    // R56-B19: 只 emit update:pageSize, 不主动 emit update:modelValue(1).
    // 早期版本这里同时 emit modelValue, 跟父组件 onPageSizeChange (设
    // currentPage.value=1) 形成双 loadTerminal 并发 race: 一个用旧 pageSize
    // (limit=50), 一个用新 pageSize (limit=20), 旧的那个网络响应后到会
    // 覆盖新结果 → 用户看到 50 条 → 报 "选 20 无效". 父组件已经负责 reset
    // currentPage, 这里再 emit 是冗余且引入 race. 单一入口更可预测.
    emit('update:pageSize', next);
  },
});
</script>

<template>
  <div
    v-if="shouldRender"
    :class="['pagination', { 'pagination-disabled': disabled }, className]"
    role="navigation"
    :aria-label="t('components.pagination.navAria')"
  >
    <!-- 左: 总数 + 每页数量 -->
    <div class="pagination-left">
      <span class="pagination-total">
        {{ t('components.pagination.total') }}<span class="pagination-total-num">{{ total }}</span>{{ t('components.pagination.totalUnit') }}
      </span>
      <div class="pagination-size">
        <span>{{ t('components.pagination.perPage') }}</span>
        <Select
          v-model="pageSizeSelectValue"
          :options="pageSizeSelectOptions"
          :disabled="disabled"
          class-name="pagination-size-select"
          :aria-label="t('components.pagination.perPageAria')"
        />
      </div>
    </div>

    <!-- 右: 跳页按钮组 -->
    <div class="pagination-right">
      <button
        type="button"
        :disabled="disabled || page <= 1"
        class="pagination-btn"
        :title="t('components.pagination.first')"
        :aria-label="t('components.pagination.first')"
        @click="goToPage(1)"
      >
        «
      </button>
      <button
        type="button"
        :disabled="disabled || page <= 1"
        class="pagination-btn"
        :title="t('components.pagination.prev')"
        :aria-label="t('components.pagination.prev')"
        @click="goToPage(page - 1)"
      >
        ‹
      </button>
      <span class="pagination-jump">
        <input
          v-model="pageInput"
          type="number"
          :min="1"
          :max="totalPages"
          :disabled="disabled"
          class="pagination-jump-input"
          :aria-label="t('components.pagination.jumpAria')"
          @blur="commitPageInput"
          @keydown="(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitPageInput();
              (e.target as HTMLInputElement).blur();
            }
          }"
        />
        <span class="pagination-divider">/</span>
        <span class="pagination-total-pages">{{ totalPages }}</span>
      </span>
      <button
        type="button"
        :disabled="disabled || page >= totalPages"
        class="pagination-btn"
        :title="t('components.pagination.next')"
        :aria-label="t('components.pagination.next')"
        @click="goToPage(page + 1)"
      >
        ›
      </button>
      <button
        type="button"
        :disabled="disabled || page >= totalPages"
        class="pagination-btn"
        :title="t('components.pagination.last')"
        :aria-label="t('components.pagination.last')"
        @click="goToPage(totalPages)"
      >
        »
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/*  Container                                                          */
/* ------------------------------------------------------------------ */
.pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  /* R58.5: 改用 padding-block 单独控制上下, 不影响左右 — 之前 padding: 12px 0
     + !important 会把容器 padding 横向 24px 也覆盖, 导致分页条贴页面边缘.
     padding-block 只控制 block 方向 (上下), inline (左右) 由父容器
     padding 控制. */
  padding-block: 12px;
  font-size: 14px;
  color: var(--color-text-muted, #6b7280);
}

.pagination-disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/*  Left: total + page size                                            */
/* ------------------------------------------------------------------ */
.pagination-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pagination-total-num {
  font-weight: 500;
  color: var(--color-text, #111827);
}

.pagination-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* R58: page size 改用封装 Select 组件, 原生 .pagination-size-select 样式去掉
   (Select 自带 .select-wrap / .select-trigger / .select-list 等全套样式).
   只保留 Select wrapper 宽度约束 + 用 :deep 调 trigger 高度对齐 jump input. */
.pagination-size-select {
  width: 78px;
  flex-shrink: 0;
}
/* Select 默认 trigger padding 7px / font 14px, 比同行的 .pagination-jump-input
   (padding 4px / font 13px) 高一截 → 视觉错位. 用 :deep 穿透 scoped 边界,
   跟 jump-input 同高 (height ≈ 28px). */
.pagination-size-select :deep(.select-trigger) {
  padding: 4px 8px;
  font-size: 13px;
}
.pagination-size-select :deep(.select-chevron) {
  width: 14px;
  height: 14px;
}

/* ------------------------------------------------------------------ */
/*  Right: page buttons + jump input                                   */
/* ------------------------------------------------------------------ */
.pagination-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pagination-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--color-border-strong, #d1d5db);
  border-radius: var(--radius, 4px);
  background: var(--color-bg-elevated, #fff);
  color: var(--color-text, #111827);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.pagination-btn:hover:not(:disabled) {
  background: var(--color-bg, #f9fafb);
  border-color: var(--color-primary, #2563eb);
  color: var(--color-primary, #2563eb);
}

.pagination-btn:focus-visible {
  outline: none;
  border-color: var(--color-primary, #2563eb);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25);
}

.pagination-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pagination-jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
}

.pagination-jump-input {
  width: 56px;
  padding: 4px 6px;
  border: 1px solid var(--color-border-strong, #d1d5db);
  border-radius: var(--radius, 4px);
  background: var(--color-bg-elevated, #fff);
  color: var(--color-text, #111827);
  font-size: 13px;
  text-align: center;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.pagination-jump-input:focus {
  border-color: var(--color-primary, #2563eb);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.pagination-jump-input:disabled {
  cursor: not-allowed;
  background: var(--color-bg, #f9fafb);
}

.pagination-divider {
  color: var(--color-border-strong, #d1d5db);
}

.pagination-total-pages {
  font-weight: 500;
  color: var(--color-text, #111827);
  min-width: 20px;
  text-align: center;
}
</style>