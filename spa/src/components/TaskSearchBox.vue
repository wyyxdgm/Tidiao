<script setup lang="ts">
/* 功能: 顶栏全局任务搜索框 (飞书 R180) — 按 task id / 名称 / 状态 / 标签搜索,
   下拉列出结果, 回车或点击跳 task 详情页. 挂在 AppHeader 用户区左侧.

   关注点:
   - 输入防抖 250ms 才发请求; 连续输入时只认最后一次响应 (reqSeq 竞态丢弃).
   - 后端 GET /api/tasks?search= 走 listTasks LIKE 匹配, owner 隔离由鉴权保证.
   - 飞书 R209: 下拉每行展示任务所属项目 / 版本 (后端 search 场景 LEFT JOIN 取真名,
     project_name / version_name). 无归属 (legacy unassigned) 时该副行不渲染.
   - 移动端 (≤1023px) 隐藏 — header 44px 已被 hamburger + brand + 账号区挤满,
     H5 下任务查找走各看板自带筛选 (TaskFilters), 不在顶栏塞第二套.
   - dropdown 不用 Teleport: header 无 overflow-hidden (与 AccountSwitcher 的
     sidebar 场景不同), absolute 挂在 wrapper 内即可, 还能跟着输入框宽度走.
   - name="task-search" + autocomplete="off" (飞书 R210): 裸 input 无 autocomplete
     token 时 Chrome autofill 启发式会按页面上下文猜字段 — settings 页有
     type=email 字段, 刷新后邮箱被自动填进搜索框. 非凭据字段 Chrome 尊重 off. */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { searchTasks, STATUS_LABELS, type TaskSearchHit, type TaskStatus } from '@/api/tasks';

const router = useRouter();

const keyword = ref('');
// 输入框 DOM ref — 清空后把焦点送回输入框 (R180 迭代).
const inputRef = ref<HTMLInputElement | null>(null);
const open = ref(false);
const loading = ref(false);
const error = ref(false);
const results = ref<TaskSearchHit[]>([]);
const highlight = ref(0);

/** 防抖定时器 + 请求序号 — 输入变化时递增, 响应回来时序号不匹配则丢弃. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let reqSeq = 0;

/** 状态圆点配色 — 活动态彩色, 终态灰/红/绿区分. 与 TaskStatusChip 视觉口径一致. */
const STATUS_DOT: Record<TaskStatus, string> = {
  pending: 'var(--tw-gray-400)',
  queued: 'var(--tw-gray-500)',
  running: 'var(--tw-blue-500)',
  paused: 'var(--tw-amber-500)',
  reviewing: 'var(--tw-violet-500)',
  verifying: 'var(--tw-cyan-500)',
  await_user: 'var(--tw-orange-500)',
  completed: 'var(--tw-green-500)',
  failed: 'var(--tw-red-500)',
  rejected: 'var(--tw-gray-400)',
  cancelled: 'var(--tw-gray-300)',
};

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

async function runSearch(): Promise<void> {
  const kw = keyword.value.trim();
  if (!kw) {
    results.value = [];
    error.value = false;
    open.value = false;
    return;
  }
  loading.value = true;
  error.value = false;
  const seq = ++reqSeq;
  try {
    const hits = await searchTasks(kw);
    if (seq !== reqSeq) return; // 已有更新的输入, 本响应作废
    results.value = hits;
    highlight.value = 0;
    open.value = true;
  } catch {
    if (seq !== reqSeq) return;
    // 失败保留旧结果不清空 (避免输入中下拉闪空), 仅提示
    error.value = true;
    open.value = true;
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

watch(keyword, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 250);
});

function jump(hit: TaskSearchHit): void {
  open.value = false;
  keyword.value = ''; // 清关键词: 跳走后再回来不残留旧搜索
  results.value = [];
  router.push({ name: 'task-detail', params: { taskId: hit.id } });
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    open.value = false;
    return;
  }
  if (!open.value || results.value.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlight.value = (highlight.value + 1) % results.value.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlight.value =
      (highlight.value - 1 + results.value.length) % results.value.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = results.value[highlight.value];
    if (hit) jump(hit);
  }
}

function onDocMousedown(e: MouseEvent): void {
  if (!open.value) return;
  if ((e.target as Element).closest?.('.task-search-wrap')) return;
  open.value = false;
}

/** R180 迭代 (damo「支持一下清空」): × 一键清空 — 关键词/结果/下拉全清 + 焦点回输入框. */
function clearInput(): void {
  keyword.value = '';
  results.value = [];
  error.value = false;
  open.value = false;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  inputRef.value?.focus();
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown);
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <div class="task-search-wrap">
    <span class="search-icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
        <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.47 4.03l4.25 4.25a1 1 0 01-1.414 1.414l-4.25-4.25A6 6 0 012 8z" clip-rule="evenodd" />
      </svg>
    </span>
    <input
      ref="inputRef"
      v-model="keyword"
      type="text"
      name="task-search"
      autocomplete="off"
      class="search-input"
      :class="{ 'has-clear': keyword }"
      placeholder="搜索任务 (ID / 名称 / 状态)"
      aria-label="全局搜索任务"
      @focus="keyword.trim() && results.length > 0 && (open = true)"
      @keydown="onKeydown"
    />
    <!-- R180 迭代: 有输入时显示 × 一键清空 -->
    <button
      v-if="keyword"
      type="button"
      class="clear-btn"
      aria-label="清空搜索"
      title="清空"
      @mousedown.prevent
      @click="clearInput"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden="true">
        <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
      </svg>
    </button>
    <div v-if="open" class="search-dropdown" role="listbox">
      <div v-if="loading" class="hint">搜索中…</div>
      <div v-else-if="error" class="hint">搜索失败，稍后再试</div>
      <div v-else-if="results.length === 0" class="hint">无匹配任务</div>
      <template v-else>
        <button
          v-for="(hit, i) in results"
          :key="hit.id"
          type="button"
          class="hit-row"
          :class="{ highlighted: i === highlight }"
          role="option"
          :aria-selected="i === highlight"
          @mouseenter="highlight = i"
          @click="jump(hit)"
        >
          <span class="dot" :style="{ background: STATUS_DOT[hit.status] ?? 'var(--tw-gray-400)' }"></span>
          <span class="hit-main">
            <span class="hit-title" :title="hit.title">{{ hit.title }}</span>
            <!-- 飞书 R209: 展示任务所属项目 / 版本, 让同名任务一眼可分. 无归属则不占位. -->
            <span
              v-if="hit.project_name || hit.version_name"
              class="hit-scope"
              :title="[hit.project_name, hit.version_name].filter(Boolean).join(' · ')"
            >
              <span v-if="hit.project_name" class="hit-project">{{ hit.project_name }}</span>
              <span v-if="hit.project_name && hit.version_name" class="hit-sep">·</span>
              <span v-if="hit.version_name" class="hit-version">{{ hit.version_name }}</span>
            </span>
          </span>
          <span class="hit-meta">
            <span class="hit-status">{{ STATUS_LABELS[hit.status] ?? hit.status }}</span>
            <span class="hit-id" :title="hit.id">{{ shortId(hit.id) }}</span>
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.task-search-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin-right: 10px;
}
.search-icon {
  position: absolute;
  left: 8px;
  display: inline-flex;
  color: var(--color-text-muted);
  pointer-events: none;
}
.search-input {
  /* R232 Round5: 230→200 (damo R232: 「搜索输入框…差不多200px宽」) — 给顶栏
     左侧资源小块让位, 也符合「更不需要这么长」的原话. */
  width: 200px;
  height: 28px;
  padding: 0 10px 0 26px;
  font-size: 13px;
  font-family: inherit;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius, 6px);
  outline: none;
  transition: border-color 0.15s, width 0.15s;
}
.search-input:focus {
  border-color: var(--color-primary);
}
.search-input::placeholder {
  color: var(--color-text-muted);
}
/* R180 迭代: 有输入时右侧留出 × 按钮位, 防文字压在按钮下 */
.search-input.has-clear {
  padding-right: 24px;
}
.clear-btn {
  position: absolute;
  right: 2px; /* wrap 右缘 = 输入框右缘, 内缩 2px 让 × 落在框内右缘 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.clear-btn:hover {
  background: var(--tw-gray-200);
  color: var(--color-text);
}

/* dropdown: 挂在 wrapper 内 absolute — header 无 overflow-hidden, 不会被切 */
.search-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 380px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  z-index: 80; /* header 自身 z=70, dropdown 需压过页面内容 */
  padding: 4px 0;
}
.hint {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.hit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.hit-row:hover,
.hit-row.highlighted {
  background: var(--tw-gray-100);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.hit-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.hit-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 飞书 R209: 项目 / 版本 副行 — 弱化色 + 小字号, 长名 ellipsis (title 属性给全文) */
.hit-scope {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-project,
.hit-version {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-project {
  flex-shrink: 0;
  max-width: 60%;
}
.hit-version {
  flex-shrink: 1;
}
.hit-sep {
  flex-shrink: 0;
}
.hit-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.hit-status {
  font-size: 11px;
  color: var(--color-text-muted);
}
.hit-id {
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* R180 移动端隐藏 — header 44px 无余量, H5 走各看板 TaskFilters 筛选 */
@media (max-width: 1023px) {
  .task-search-wrap {
    display: none;
  }
}
</style>
