<script setup lang="ts">
/* 功能: 全局看板第五视图「分类」(idea-canvas 列表升级, damo 1012 交互定稿) —
   未分类池 + 自建分类卡片, 任务拖拽入列/跨列搬移/拖回未分类, 分类 CRUD,
   任务删除自动出列 (v524 级联 + missing 灰条兜底), data 扩展字段 chips 渲染。
   全程 AI 可读写 (ao pinlist 同一套 API)。

   关注点:
   - 数据自拉: GET /api/tasks?limit=500 (裸数组, 已滤软删) + GET /api/pin-lists。
     未分类 = 任务全集 − 已入列任务 (按 ref_id 差集)。
   - 拖拽 = 原生 HTML5 DnD (draggable + dataTransfer 带 taskId), drop 落到
     分类卡/未分类池; 跨列表拖 = 先摘旧列再入新列 (mv 语义, added_by=damo)。
   - 任务删除自动出列: db 层 deleteTask 级联清 pin_list_items (v521 红线补丁);
     本视图对 missing 条目渲染灰条 + 「清掉」按钮兜底 (历史脏数据)。
   - idea/node 条目只读渲染 (带徽标), 不参与任务拖拽。
   - 列表 CRUD: 新建(内联)/改名(双击)/删除(两次点击确认, 只摘条目不动任务)。 */

import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
  listPinLists,
  createPinList,
  updatePinList,
  deletePinList,
  addPinListItem,
  removePinListItem,
  reorderPinLists,
  reorderPinListItems,
  type PinListWithItems,
} from '@/api/pin-lists';
import { useToast } from '@/composables/useToast';
import { get } from '@/api/http';

const router = useRouter();
const route = useRoute();
const toast = useToast();
const { t } = useI18n();

/* 全局筛选接入 (damo 1013 反馈: category 视图不吃 URL 筛选标签):
   statusFilter = GlobalBoard chip 行选中集, search = q 防抖词。
   只影响展示 (未分类池 + 列内任务卡), 不动 pin 关系; missing 灰条
   不受筛选 (清理入口), idea/node 条目不参与任务筛选。
   R31 (damo 1013): projectId = URL ?project= 项目作用域 (GlobalBoard
   projectSelect 透传) — 项目内「列表」入口只看该项目任务, 未分类池与
   分类内条目都按项目过滤; 全局入口不带 = 全项目, 行为不变。 */
const props = defineProps<{
  statusFilter?: Set<string>;
  search?: string;
  projectId?: string | null;
}>();

/** 全局筛选判定: 状态不在选中集 / 标题不含搜索词 → 隐藏。未传 props = 不过滤。 */
function matchFilter(status: string | null, title: string): boolean {
  if (props.statusFilter && !props.statusFilter.has(status ?? '')) return false;
  const q = (props.search ?? '').trim().toLowerCase();
  if (q && !title.toLowerCase().includes(q)) return false;
  return true;
}
/** 列内条目可见性: 任务条目吃筛选 (含 R31 项目作用域), missing 灰条与 idea/node 恒显。 */
function itemVisible(i: { ref_type: string; ref_id: string; missing: boolean; status: string | null; title: string }): boolean {
  if (i.ref_type !== 'task' || i.missing) return true;
  if (!matchFilter(i.status, i.title)) return false;
  if (props.projectId && itemProjectId(i.ref_id) !== props.projectId) return false;
  return true;
}

interface TaskLite {
  id: string;
  title: string;
  status: string;
  project_id: string | null;
}

const tasks = ref<TaskLite[]>([]);
const projectNames = ref<Map<string, string>>(new Map());
const lists = ref<PinListWithItems[]>([]);
const loading = ref(true);

const newListTitle = ref('');
const renamingId = ref<string | null>(null);
const renamingTitle = ref('');
const removingId = ref<string | null>(null);
const dragTaskId = ref<string | null>(null);
const dragOverList = ref<string | null>(null);
const dragOverUnassigned = ref(false);
// R245: 任务列表内排序 — 插入位置 (视觉 index, 对全条目序列) + 所在列表。
const dragOverIdx = ref<number | null>(null);
const dragOverIdxList = ref<string | null>(null);
// R245: 分类面板左右拖动 — 把手触发 (dragstart 绑在 grip 上), 拖动中显边缘插入线。
const dragListId = ref<string | null>(null);
const dragListEdge = ref<{ listId: string; side: 'before' | 'after' } | null>(null);

const STATUS_DOT: Record<string, string> = {
  pending: '#94a3b8', queued: '#38bdf8', running: '#34d399', reviewing: '#fbbf24',
  'awaiting_owner_review': '#f59e0b', completed: '#10b981', failed: '#f87171',
  cancelled: '#6b7280', paused: '#a78bfa',
};

async function refresh() {
  loading.value = true;
  try {
    const [listsRes, tasksRes, projectsRes] = await Promise.all([
      listPinLists(),
      get<{ length: number } & TaskLite[]>('/api/tasks?limit=500'),
      get<{ projects: Array<{ id: string; name: string }> }>('/api/projects'),
    ]);
    lists.value = listsRes.lists;
    tasks.value = tasksRes as unknown as TaskLite[];
    projectNames.value = new Map(projectsRes.projects.map((p) => [p.id, p.name]));
  } finally {
    loading.value = false;
  }
}

/** R31: 项目作用域任务集 — 带 ?project= 只留该项目任务; 不带 = 全量 (行为不变)。 */
const scopedTasks = computed<TaskLite[]>(() =>
  props.projectId ? tasks.value.filter((t) => t.project_id === props.projectId) : tasks.value,
);

/** 条目归属项目 — ref_id 反查任务 project_id (查全量, 归属不随作用域变); 任务已删/非任务 = null。 */
function itemProjectId(refId: string): string | null {
  return tasks.value.find((t) => t.id === refId)?.project_id ?? null;
}

/** 已入列的 task id 集合 (未分类 = 全集差集)。 */
const pinnedTaskIds = computed<Set<string>>(() => {
  const s = new Set<string>();
  for (const l of lists.value) {
    for (const i of l.items) {
      if (i.ref_type === 'task' && !i.missing) s.add(i.ref_id);
    }
  }
  return s;
});

const unassignedPoolAll = computed<TaskLite[]>(() =>
  scopedTasks.value.filter((t) => !pinnedTaskIds.value.has(t.id)),
);
const unassignedTasks = computed<TaskLite[]>(() =>
  unassignedPoolAll.value.filter((t) => matchFilter(t.status, t.title)),
);

function pinnedCount(taskId: string): number {
  let n = 0;
  for (const l of lists.value) {
    for (const i of l.items) {
      if (i.ref_type === 'task' && i.ref_id === taskId && !i.missing) n++;
    }
  }
  return n;
}

function projectName(id: string | null): string {
  return (id && projectNames.value.get(id)) || '';
}

// ---- 拖拽 ----
function onDragStart(e: DragEvent, taskId: string) {
  dragTaskId.value = taskId;
  e.dataTransfer?.setData('text/plain', taskId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragEnd() {
  dragTaskId.value = null;
  dragOverList.value = null;
  dragOverUnassigned.value = false;
  dragOverIdx.value = null;
  dragOverIdxList.value = null;
}
/** R245: dragover 任务卡 — 算鼠标在上/下半 → 插入线显示在该卡前/后。 */
function onTaskDragOver(list: PinListWithItems, idx: number, e: DragEvent) {
  if (!dragTaskId.value) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  dragOverIdxList.value = list.id;
  dragOverIdx.value = before ? idx : idx + 1;
}
/** R245: dragover 列表空白区 — 插入线落到末尾 (preventDefault 允许 drop)。 */
function onBodyDragOver(list: PinListWithItems, e: DragEvent) {
  if (!dragTaskId.value) return;
  e.preventDefault();
  dragOverIdxList.value = list.id;
  dragOverIdx.value = list.items.length;
}
/** R245: 插入线显隐 — before = 插入点==idx; after = 插入点==idx+1 且 idx 是末条目。 */
function dropEdgeBefore(list: PinListWithItems, idx: number): boolean {
  return dragOverIdxList.value === list.id && dragOverIdx.value === idx;
}
function dropEdgeAfter(list: PinListWithItems, idx: number): boolean {
  return dragOverIdxList.value === list.id
    && dragOverIdx.value === idx + 1
    && idx === list.items.length - 1;
}
/** R245: 列表 drop 分流 — 拖分类 → 面板重排; 拖任务 → 入列/排序。 */
function onDropListZone(list: PinListWithItems, e: DragEvent) {
  if (dragListId.value) {
    void onListDrop(list, e);
    return;
  }
  const taskId = dragTaskId.value ?? (e.dataTransfer?.getData('text/plain') || '').replace(/^list:/, '');
  dragOverList.value = null;
  dragOverUnassigned.value = false;
  const at = dragOverIdxList.value === list.id ? dragOverIdx.value : null;
  dragOverIdx.value = null;
  dragOverIdxList.value = null;
  if (!taskId || taskId.startsWith('list:')) return;
  void moveTo(list, taskId, at);
}
function onDropUnassigned(e: DragEvent) {
  e.preventDefault();
  const taskId = e.dataTransfer?.getData('text/plain') || dragTaskId.value;
  dragOverUnassigned.value = false;
  dragOverIdx.value = null;
  dragOverIdxList.value = null;
  if (!taskId) return;
  void removeFromAll(taskId);
}

// ---- R245: 分类面板左右拖动 (把手触发, 未分类池固定最前不参与) ----
function onListDragStart(e: DragEvent, listId: string) {
  dragListId.value = listId;
  e.dataTransfer?.setData('text/plain', `list:${listId}`);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onListDragOver(list: PinListWithItems, e: DragEvent) {
  if (!dragListId.value || dragListId.value === list.id) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  dragListEdge.value = { listId: list.id, side };
}
function onListDragEnd() {
  dragListId.value = null;
  dragListEdge.value = null;
}
/** 拖分类落点: 乐观重排 lists + PUT /api/pin-lists 持久化完整顺序。 */
async function onListDrop(targetList: PinListWithItems, e: DragEvent) {
  e.preventDefault();
  const fromList = dragListId.value;
  const edge = dragListEdge.value;
  dragListId.value = null;
  dragListEdge.value = null;
  if (!fromList || !edge || fromList === edge.listId) return;
  const moved = lists.value.find((l) => l.id === fromList);
  if (!moved) return;
  const rest = lists.value.filter((l) => l.id !== fromList);
  const tIdx = rest.findIndex((l) => l.id === edge.listId);
  if (tIdx < 0) return;
  rest.splice(edge.side === 'before' ? tIdx : tIdx + 1, 0, moved);
  lists.value = rest;
  try {
    await reorderPinLists(rest.map((l, i) => ({ id: l.id, sort_key: i + 1 })));
    toast.success(t('tasks.category.orderSaved'));
  } catch (err: any) {
    toast.error(err?.message ?? t('tasks.category.saveOrderFailed'));
    await refresh();
  }
}

/** 摘掉某任务在所有列表里的条目 (拖回未分类)。 */
async function removeFromAll(taskId: string) {
  let removed = 0;
  for (const l of lists.value) {
    for (const i of l.items) {
      if (i.ref_type === 'task' && i.ref_id === taskId && !i.missing) {
        await removePinListItem(i.id);
        removed++;
      }
    }
  }
  if (removed > 0) toast.success(t('tasks.category.removedFromN', { n: removed }));
  else toast.info(t('tasks.category.notInAnyList'));
  await refresh();
}

/** 拖入目标列表: 已在其它列表先摘 (mv 语义), 再放入。
 *  R245: insertIdx = 视觉插入位置 (全条目 index) — 落位后整组 reorder 持久化;
 *  同列表 = 纯排序 (不重发 add); null = 追加到末尾 (旧行为)。 */
async function moveTo(list: PinListWithItems, taskId: string, insertIdx: number | null = null) {
  const existing = list.items.find((i) => i.ref_type === 'task' && i.ref_id === taskId && !i.missing);

  // 同列表: 排序场景 — 摘出 → 插到新位 → 整组 reorder
  if (existing) {
    if (insertIdx == null) {
      toast.info(t('tasks.category.alreadyInList'));
      return;
    }
    const arr = [...list.items];
    const oldIdx = arr.indexOf(existing);
    arr.splice(oldIdx, 1);
    let at = insertIdx;
    if (oldIdx < insertIdx) at -= 1;
    at = Math.max(0, Math.min(at, arr.length));
    if (at === oldIdx) return; // 插回原位 = 没动
    arr.splice(at, 0, existing);
    try {
      await reorderPinListItems(list.id, arr.map((i) => i.id));
      toast.success(t('tasks.category.orderSaved'));
      await refresh();
    } catch (err: any) {
      toast.error(err?.message ?? t('tasks.category.saveOrderFailed'));
      await refresh();
    }
    return;
  }

  try {
    // 先摘旧列 (mv 语义: 一个任务同时只在一个分类)
    for (const l of lists.value) {
      if (l.id === list.id) continue;
      for (const i of l.items) {
        if (i.ref_type === 'task' && i.ref_id === taskId && !i.missing) {
          await removePinListItem(i.id);
        }
      }
    }
    const addedRaw = await addPinListItem(list.id, { ref_type: 'task', ref_id: taskId, added_by: 'damo' });
    // 补齐 with-ref 展示字段 (插入排序要用完整条目对象)
    const tk = tasks.value.find((x) => x.id === taskId);
    const added = { ...addedRaw, title: tk?.title ?? '', status: tk?.status ?? null, missing: false };
    if (insertIdx != null && insertIdx < list.items.length) {
      // 插到指定位置: 构造完整新顺序 (add 默认 append, 这里 reorder 校正)
      const arr = [...list.items];
      arr.splice(Math.max(0, insertIdx), 0, added);
      await reorderPinListItems(list.id, arr.map((i) => i.id));
    }
    toast.success(t('tasks.detail.putIntoList', { title: list.title }));
    await refresh();
  } catch (err: any) {
    toast.error(err?.body?.code === 'ALREADY_IN_LIST' ? t('tasks.category.alreadyInList') : (err?.message ?? t('tasks.detail.putFailed')));
    await refresh();
  }
}

// ---- 分类 CRUD ----
async function createCategory() {
  const title = newListTitle.value.trim();
  if (!title) return;
  await createPinList(title);
  newListTitle.value = '';
  toast.success(t('tasks.category.created', { title }));
  await refresh();
}
function startRename(l: PinListWithItems) {
  renamingId.value = l.id;
  renamingTitle.value = l.title;
}
async function commitRename(l: PinListWithItems) {
  renamingId.value = null;
  const t = renamingTitle.value.trim();
  if (!t || t === l.title) return;
  const u = await updatePinList(l.id, { title: t });
  l.title = u.title;
}
async function removeCategory(l: PinListWithItems) {
  if (removingId.value !== l.id) {
    removingId.value = l.id;
    return;
  }
  removingId.value = null;
  await deletePinList(l.id);
  lists.value = lists.value.filter((x) => x.id !== l.id);
  toast.success(t('tasks.category.deleted', { title: l.title }));
}
async function cleanMissing(l: PinListWithItems, itemId: string) {
  await removePinListItem(itemId);
  l.items = l.items.filter((i) => i.id !== itemId);
}

function openTask(id: string) {
  router.push(`/tasks/${id}`);
}

/** R31: 清掉项目作用域 → 回全局视角 (剥 URL ?project=, GlobalBoard projectSelect 同步失效)。 */
function clearScope() {
  router.replace({ query: { ...route.query, project: undefined } });
}

/** item.data 按 list.data_schema 渲染 chips (title 优先, URL 变链接)。 */
function dataChips(list: PinListWithItems, item: { data: string | null }): Array<{ key: string; label: string; value: string; isUrl: boolean }> {
  if (!item.data) return [];
  let props: Record<string, { title?: string }> = {};
  try {
    const s = JSON.parse(list.data_schema ?? '{}');
    props = s.properties ?? {};
  } catch { /* schema 坏了按无渲染 */ }
  try {
    const d = JSON.parse(item.data);
    const keys = Object.keys(props).length ? [...Object.keys(props), ...Object.keys(d).filter((k) => !props[k])] : Object.keys(d);
    return keys
      .filter((k) => d[k] !== undefined && d[k] !== null && d[k] !== '')
      .map((k) => {
        const v = String(d[k]);
        return { key: k, label: props[k]?.title ?? k, value: v, isUrl: /^https?:\/\//.test(v) };
      });
  } catch {
    return [];
  }
}

onMounted(refresh);
</script>

<template>
  <div class="cat-view">
    <div class="cat-toolbar">
      <!-- R31: 项目作用域 chip — 从项目内「列表」入口进来时提示当前过滤, 点 ✕ 回全局 -->
      <button
        v-if="projectId"
        class="cat-scope-chip"
        :title="t('tasks.category.scopeChipTitle')"
        @click="clearScope"
      >
        📁 {{ projectName(projectId) || t('tasks.category.thisProject') }} <span class="cat-scope-x">✕</span>
      </button>
      <span class="cat-hint">{{ t('tasks.category.hint') }}</span>
      <input
        v-model="newListTitle" class="cat-new-input" :placeholder="t('tasks.category.newListPlaceholder')"
        @keydown.enter="createCategory"
      />
      <button class="cat-btn primary" :disabled="!newListTitle.trim()" @click="createCategory">{{ t('tasks.category.newListBtn') }}</button>
    </div>

    <div class="cat-board">
      <!-- 未分类池 (固定最前, 不参与分类排序) -->
      <div
        class="cat-list unassigned"
        :class="{ 'drag-over': dragOverUnassigned }"
        @dragover.prevent="dragOverUnassigned = true"
        @dragleave="dragOverUnassigned = false"
        @drop.prevent="onDropUnassigned"
      >
        <div class="cat-list-head">
          <span>📥 {{ t('tasks.category.unassigned') }}</span>
          <span class="cat-count">{{ unassignedTasks.length }}</span>
        </div>
        <div class="cat-list-body">
          <div
            v-for="t in unassignedTasks" :key="t.id"
            class="cat-task"
            draggable="true"
            @dragstart="onDragStart($event, t.id)"
            @dragend="onDragEnd"
            @click="openTask(t.id)"
          >
            <div class="cat-task-top">
              <span class="cat-dot" :style="{ background: STATUS_DOT[t.status] ?? '#94a3b8' }" />
              <span v-if="projectName(t.project_id)" class="cat-task-proj">{{ projectName(t.project_id) }}</span>
            </div>
            <span class="cat-task-title">{{ t.title }}</span>
          </div>
          <div v-if="unassignedTasks.length === 0" class="cat-empty">
            {{ unassignedPoolAll.length > 0 ? t('tasks.category.emptyFiltered') : t('tasks.category.allGrouped') }}
          </div>
        </div>
      </div>

      <!-- 自建分类卡片: 把手左右拖动排序 (R245), 任务卡上下插入线排序 -->
      <div
        v-for="l in lists" :key="l.id"
        class="cat-list"
        :class="{
          'drag-over': dragOverList === l.id,
          dragging: dragListId === l.id,
          'edge-before': dragListEdge?.listId === l.id && dragListEdge.side === 'before',
          'edge-after': dragListEdge?.listId === l.id && dragListEdge.side === 'after',
        }"
        @dragover="onListDragOver(l, $event)"
        @drop.prevent="onDropListZone(l, $event)"
      >
        <div class="cat-list-head">
          <span
            class="cat-list-grip" :title="t('tasks.category.gripTitle')"
            draggable="true"
            @dragstart="onListDragStart($event, l.id)"
            @dragend="onListDragEnd"
          >⠿</span>
          <input
            v-if="renamingId === l.id" v-model="renamingTitle" class="cat-rename"
            @keydown.enter="commitRename(l)" @blur="commitRename(l)"
          />
          <template v-else>
            <span class="cat-list-title" @dblclick="startRename(l)">{{ l.title }}</span>
            <span class="cat-count">{{ l.items.filter(itemVisible).length }}</span>
          </template>
          <span class="cat-ops">
            <button :title="t('tasks.category.rename')" @click.stop="startRename(l)">✏</button>
            <button :title="removingId === l.id ? t('tasks.category.clickAgainToDelete') : t('tasks.category.deleteList')" :class="{ confirm: removingId === l.id }" @click.stop="removeCategory(l)">🗑</button>
          </span>
        </div>
        <div class="cat-list-body" @dragover="onBodyDragOver(l, $event)">
          <template v-for="(i, idx) in l.items" :key="i.id">
            <!-- 任务条目: 可拖出 / 列表内上下排序 (可见性统一走 itemVisible — 含 R31 项目作用域) -->
            <div
              v-if="i.ref_type === 'task'"
              v-show="itemVisible(i)"
              class="cat-task"
              :class="{
                missing: i.missing,
                'drop-before': dropEdgeBefore(l, idx),
                'drop-after': dropEdgeAfter(l, idx),
              }"
              :draggable="!i.missing"
              @dragstart="onDragStart($event, i.ref_id)"
              @dragend="onDragEnd"
              @dragover="onTaskDragOver(l, idx, $event)"
              @click="!i.missing && openTask(i.ref_id)"
            >
              <div class="cat-task-top">
                <span class="cat-dot" :style="{ background: STATUS_DOT[i.status ?? ''] ?? '#94a3b8' }" />
                <button v-if="i.missing" class="cat-clean" :title="t('tasks.category.cleanMissing')" @click.stop="cleanMissing(l, i.id)">✕</button>
              </div>
              <span class="cat-task-title">{{ i.title }}</span>
              <div v-if="dataChips(l, i).length" class="cat-task-chips">
                <span
                  v-for="chip in dataChips(l, i)" :key="chip.key" class="cat-chip"
                  :title="chip.value"
                >
                  <a v-if="chip.isUrl" :href="chip.value" target="_blank" rel="noopener" @click.stop>{{ chip.label }} ↗</a>
                  <template v-else>{{ chip.label }}: {{ chip.value }}</template>
                </span>
              </div>
            </div>
            <!-- idea/node 条目: 只读徽标 -->
            <div v-else class="cat-task ro">
              <div class="cat-task-top">
                <span class="cat-badge">{{ i.ref_type === 'idea' ? '💡' : '▸' }}</span>
              </div>
              <span class="cat-task-title">{{ i.title }}</span>
            </div>
          </template>
          <div v-if="l.items.length === 0" class="cat-empty">{{ t('tasks.category.dropHere') }}</div>
        </div>
      </div>

      <div v-if="loading" class="cat-loading">{{ t('common.loading') }}</div>
    </div>
  </div>
</template>


<style scoped>
.cat-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.cat-toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 16px; }
/* R31: 项目作用域 chip (点击 ✕ 回全局视角) */
.cat-scope-chip { display: inline-flex; align-items: center; gap: 5px; background: rgba(79, 70, 229, .18); border: 1px solid rgba(129, 140, 248, .45); color: #c7d2fe; border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; flex-shrink: 0; }
.cat-scope-chip:hover { background: rgba(79, 70, 229, .3); }
.cat-scope-x { color: #a5b4fc; font-size: 11px; }
.cat-hint { font-size: 12px; color: #64748b; flex: 1; }
.cat-new-input { width: 200px; background: #0f172a; border: 1px solid var(--border, #1f2937); color: inherit; border-radius: 8px; padding: 6px 10px; font-size: 13px; }
.cat-btn { border: 1px solid var(--border, #1f2937); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.cat-btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.cat-btn:disabled { opacity: .45; cursor: not-allowed; }
.cat-board { flex: 1; overflow: auto; display: flex; gap: 14px; align-items: flex-start; padding: 4px 16px 16px; }
.cat-list { width: 300px; flex-shrink: 0; background: rgba(30, 41, 59, .4); border: 1px solid var(--border, #1f2937); border-radius: 12px; display: flex; flex-direction: column; max-height: 100%; }
.cat-list.unassigned { background: rgba(15, 23, 42, .6); border-style: dashed; }
.cat-list.drag-over, .cat-list.unassigned.drag-over { border-color: #818cf8; background: rgba(79, 70, 229, .12); }
.cat-list-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px 6px; font-weight: 600; font-size: 13px; }
.cat-list-grip { cursor: grab; color: #475569; font-size: 15px; line-height: 1; user-select: none; flex-shrink: 0; }
.cat-list-grip:hover { color: #94a3b8; }
.cat-list.dragging { opacity: .4; }
/* R245: 分类面板左右拖动插入线 (参考 kanban 卡片 box-shadow 手法) */
.cat-list.edge-before { box-shadow: -3px 0 0 0 #818cf8; }
.cat-list.edge-after { box-shadow: 3px 0 0 0 #818cf8; }
.cat-list-title { cursor: text; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat-count { color: #64748b; font-weight: 400; font-size: 12px; }
.cat-ops { margin-left: auto; flex-shrink: 0; }
.cat-ops button { background: none; border: 0; color: #64748b; cursor: pointer; font-size: 11px; padding: 0 2px; }
.cat-ops button.confirm { color: #f87171; }
.cat-rename { width: 130px; flex: 1; background: #0f172a; border: 1px solid #334155; color: inherit; border-radius: 4px; font-size: 12px; padding: 1px 5px; }
.cat-list-body { overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 6px; min-height: 60px; }
/* R245: 任务卡片放大 (参考看板卡片) — 上行状态点/项目名, 标题 2 行, chips 底部 wrap */
.cat-task { display: flex; flex-direction: column; align-items: stretch; gap: 4px; background: rgba(15, 23, 42, .85); border: 1px solid rgba(51, 65, 85, .6); border-radius: 8px; padding: 9px 11px; font-size: 13px; cursor: grab; }
.cat-task:hover { border-color: #475569; }
.cat-task.missing { opacity: .4; }
.cat-task.ro { cursor: default; }
.cat-task.drop-before { box-shadow: 0 -2px 0 0 #818cf8; }
.cat-task.drop-after { box-shadow: 0 2px 0 0 #818cf8; }
.cat-task-top { display: flex; align-items: center; gap: 6px; }
.cat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.cat-task-title { font-size: 13px; font-weight: 500; line-height: 1.4; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.cat-task-proj { margin-left: auto; color: #64748b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat-task-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.cat-chip { background: rgba(99, 102, 241, .15); border-radius: 4px; padding: 0 5px; font-size: 10px; color: #c7d2fe; }
.cat-chip a { color: #93c5fd; text-decoration: none; }
.cat-clean { background: none; border: 0; color: #f87171; cursor: pointer; font-size: 11px; }
.cat-badge { flex-shrink: 0; }
.cat-empty { text-align: center; color: #475569; font-size: 11px; padding: 14px 0; }
.cat-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #94a3b8; }
</style>
