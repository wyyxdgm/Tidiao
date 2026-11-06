<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useTagsStore } from '@/stores/tags';
import { displayProjectName } from '@/lib/project-display';
import Modal from '@/components/Modal.vue';
import Button from '@/components/Button.vue';

const tags = useTagsStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const items = computed(() => tags.visited);

/* ------------------------------------------------------------------ */
/*  激活 tab 自动滚动定位 (R173): tab 多时激活的可能被折进横向滚动
    隐藏区, 用户切 tab 后看不到当前在哪. route.path 变化 (切 tab / 新开
    / 关闭后 fallback) → 等 DOM 更新后把 .tag.active 滚进可视区.
    block:'nearest' = 垂直方向已在可视区就不动, 不会连带页面竖向滚动.   */
/* ------------------------------------------------------------------ */

const scrollerRef = ref<HTMLElement | null>(null);

function scrollActiveIntoView(behavior: ScrollBehavior = 'smooth'): void {
  const el = scrollerRef.value?.querySelector('.tag.active');
  el?.scrollIntoView({ behavior, inline: 'nearest', block: 'nearest' });
}

watch(
  () => route.path,
  () => void nextTick(() => scrollActiveIntoView()),
);

// 首次挂载 (含刷新后持久化列表恢复): 直接定位, 不做平滑动画.
onMounted(() => void nextTick(() => scrollActiveIntoView('auto')));

function isActive(path: string) {
  return route.path === path;
}

/** R57: 切到目标 tab 时还原其 query 快照, 没快照按裸 path 推. */
function pushWithQuery(tag: { query?: Record<string, string> } | undefined, path: string): void {
  if (tag?.query && Object.keys(tag.query).length > 0) {
    void router.push({ path, query: tag.query });
  } else {
    void router.push(path);
  }
}

/** bulk 操作后, 当前 active 落到被关区间时跳到保留的目标. */
function syncAfterBulk(targetPath: string): void {
  const target = tags.visited.find((t) => t.path === targetPath);
  pushWithQuery(target, targetPath);
}

function onClick(path: string) {
  if (path === route.path) return;
  const tag = tags.visited.find((t) => t.path === path);
  tags.activate(path);
  pushWithQuery(tag, path);
}

function onClose(e: MouseEvent, path: string) {
  e.stopPropagation();
  const idx = tags.visited.findIndex((t) => t.path === path);
  const wasActive = route.path === path;
  tags.close(path);
  if (wasActive) {
    const next = tags.visited[idx - 1] || tags.visited[idx] || tags.visited[0];
    if (next) pushWithQuery(next, next.path);
    else void router.push('/');
  }
  closeMenu();
}

/* ------------------------------------------------------------------ */
/*  Right-click context menu (replaces the old window.prompt() hack).  */
/*  Menu state lives in a single reactive record — null = hidden.       */
/* ------------------------------------------------------------------ */

interface MenuState {
  path: string;
  // Cursor position, clamped against viewport on render.
  x: number;
  y: number;
}

const menu = ref<MenuState | null>(null);

function onContextMenu(e: MouseEvent, path: string): void {
  e.preventDefault();
  // First open the menu at the right-clicked tab so close*/rename ops target it.
  tags.activate(path);
  menu.value = {
    path,
    x: e.clientX,
    y: e.clientY,
  };
}

/* ------------------------------------------------------------------ */
/*  `⋯` overflow button — H5 / 触屏端没有右键事件, 在右上角放一个 ⋯
    按钮作为菜单入口, 复用同一个 menu/menuCtx/handlers, 目标 tab = 当前
    active tab (让用户能操作当前页). 桌面端保留右键菜单, 互不干扰.    */
/* ------------------------------------------------------------------ */

const overflowRef = ref<HTMLButtonElement | null>(null);

/** `⋯` 按钮点击 — 锚到按钮下方 (top:buttonRect.bottom, left:buttonRect.right - W).
    复用 menu.value / menuCtx 的同一套状态机, 桌面右键 0 改动.
    二次点击 toggle 关闭 (跟原生右键二次打开/关闭行为一致). */
function openMenuFromOverflow(): void {
  const btn = overflowRef.value;
  if (!btn) return;
  // 已开 → 关闭 (toggle). 桌面右键二次触发不会关, 但 ⋯ 按钮是 click 语义,
  // 二次点击必须 toggle, 符合移动端 toolbar 预期.
  if (menu.value) {
    closeMenu();
    return;
  }
  const rect = btn.getBoundingClientRect();
  // 用当前 active tab 作为目标, 没 active 就用第一个 visited (兜底).
  const targetPath =
    tags.visited.find((t) => route.path === t.path)?.path ??
    tags.visited[0]?.path ??
    route.path;
  menu.value = {
    path: targetPath,
    x: rect.right - 180, // menuStyle 默认 W=180, 右对齐到按钮右下
    y: rect.bottom + 4,
  };
}

function closeMenu(): void {
  menu.value = null;
}

/** Clamp x/y so the menu never spills off the right/bottom edge. */
const menuStyle = computed(() => {
  const m = menu.value;
  if (!m) return {};
  // Approximate menu size — actual DOM ref is more accurate but this avoids
  // a layout reflow on every render.
  const W = 180;
  const H = 240;
  const maxX = window.innerWidth - W - 4;
  const maxY = window.innerHeight - H - 4;
  return {
    left: `${Math.min(m.x, Math.max(4, maxX))}px`,
    top: `${Math.min(m.y, Math.max(4, maxY))}px`,
  };
});

/** Context menu item visibility — items that don't apply are hidden, not
 *  disabled, so the menu height shrinks to fit the available ops. */
const menuCtx = computed(() => {
  const m = menu.value;
  if (!m) return null;
  const idx = tags.visited.findIndex((t) => t.path === m.path);
  const tab = tags.visited[idx];
  if (!tab) return null;
  const isPinned = tab.closable === false;
  // After idx there's at least one closable tab to right? Pinned don't count.
  const hasRight = tags.visited
    .slice(idx + 1)
    .some((t) => t.closable !== false);
  // Before idx there's at least one closable tab to left?
  const hasLeft = tags.visited
    .slice(0, idx)
    .some((t) => t.closable !== false);
  const closableCount = tags.visited.filter((t) => t.closable !== false).length;
  return {
    path: m.path,
    isPinned,
    hasRight,
    hasLeft,
    canCloseAll: closableCount > 0,
  };
});

function menuCloseOne(): void {
  if (!menu.value) return;
  onClose(new MouseEvent('click'), menu.value.path);
}
function menuCloseOthers(): void {
  if (!menu.value) return;
  const p = menu.value.path;
  tags.closeOthers(p);
  syncAfterBulk(p);
  closeMenu();
}
function menuCloseLeft(): void {
  if (!menu.value) return;
  const p = menu.value.path;
  tags.closeLeft(p);
  syncAfterBulk(p);
  closeMenu();
}
function menuCloseRight(): void {
  if (!menu.value) return;
  const p = menu.value.path;
  tags.closeRight(p);
  syncAfterBulk(p);
  closeMenu();
}
function menuCloseAll(): void {
  tags.closeAll();
  if (tags.visited.length) syncAfterBulk(tags.visited[0].path);
  else void router.push('/');
  closeMenu();
}

/* ------------------------------------------------------------------ */
/*  Rename — uses Modal.vue (no native prompt per R64 rule).           */
/* ------------------------------------------------------------------ */

const renameState = reactive<{ open: boolean; path: string | null; draft: string }>({
  open: false,
  path: null,
  draft: '',
});

function menuRename(): void {
  if (!menu.value) return;
  const tab = tags.visited.find((t) => t.path === menu.value!.path);
  if (!tab) return;
  renameState.path = tab.path;
  renameState.draft = tab.title;
  renameState.open = true;
  closeMenu();
}

function confirmRename(): void {
  if (renameState.path) tags.rename(renameState.path, renameState.draft);
  renameState.open = false;
  renameState.path = null;
}

function cancelRename(): void {
  renameState.open = false;
  renameState.path = null;
}

/* ------------------------------------------------------------------ */
/*  Pin toggle — single op, no dialog.                                 */
/* ------------------------------------------------------------------ */

function menuTogglePin(): void {
  if (!menu.value) return;
  tags.togglePin(menu.value.path);
  closeMenu();
}

/* ------------------------------------------------------------------ */
/*  持久化开关 (R59): tab bar 右侧按钮. ON 时刷新保留 visited[], OFF 时  */
/*  刷新丢, 老列表也清掉. 默认 OFF (跟用户原话「否则就刷新丢」对齐).       */
/* ------------------------------------------------------------------ */

const persistEnabled = computed<boolean>(() => tags.persistEnabled);

function togglePersist(): void {
  tags.setPersist(!persistEnabled.value);
  closeMenu();
}

/* ------------------------------------------------------------------ */
/*  Document-level click/escape to dismiss the menu.                   */
/* ------------------------------------------------------------------ */

function onDocClick(e: MouseEvent): void {
  if (!menu.value) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.tag-context-menu')) return;
  if (target?.closest('.tag')) return; // click on another tab — it'll open its own menu
  if (target?.closest('.tag-overflow')) return; // ⋯ 按钮: 它自己刚触发了 openMenuFromOverflow, 不应被 doc-click 吞掉关菜单
  closeMenu();
}

function onDocKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (renameState.open) return; // Modal handles its own ESC
    closeMenu();
  }
}

document.addEventListener('click', onDocClick);
document.addEventListener('keydown', onDocKey);
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <div class="tags-view">
    <div ref="scrollerRef" class="tags-scroll">
      <div
        v-for="tg in items"
        :key="tg.name"
        class="tag"
        :class="{ active: isActive(tg.path), pinned: tg.closable === false }"
        @click="onClick(tg.path)"
        @contextmenu="onContextMenu($event, tg.path)"
      >
        <span v-if="tg.closable === false" class="tag-pin" :aria-label="t('components.tags.pinned')">📌</span>
        <!-- i18n (W4.5a): titleKey 存在走 locale (语言切换即时跟新), title 作 zh 兜底 -->
        <span class="tag-title">{{ tg.titleKey ? t(tg.titleKey) : displayProjectName(tg.title) }}</span>
        <button
          v-if="tg.closable !== false"
          class="tag-close"
          :aria-label="t('components.tags.closeTab')"
          @click="onClose($event, tg.path)"
        >
          ×
        </button>
      </div>
      <div v-if="!items.length" class="empty-tag">{{ t('components.tags.empty') }}</div>
    </div>

    <!-- ⋯ 菜单按钮 (移动端/H5 入口, 桌面右键仍可用). 放在 tags-scroll
         右侧, 不跟着 tab 列表滚动. 复用 menuCtx/handlers (桌面右键共用
         同一套菜单项), 仅触发位置不同. -->
    <button
      ref="overflowRef"
      class="tag-overflow"
      :title="t('components.tags.menuAria')"
      :aria-label="t('components.tags.menuAria')"
      :disabled="!items.length"
      @click="openMenuFromOverflow"
    >
      ⋯
    </button>

    <!-- 持久化开关: 放在 tags-scroll 右侧, 不跟着 tab 列表滚动. 状态色
         区分 on/off, 点击翻转 + 立刻落 localStorage. -->
    <button
      class="persist-toggle"
      :class="{ 'persist-toggle--on': persistEnabled }"
      :title="persistEnabled ? t('components.tags.persistOffTitle') : t('components.tags.persistOnTitle')"
      :aria-pressed="persistEnabled"
      @click="togglePersist"
    >
      <span class="persist-icon">{{ persistEnabled ? '●' : '○' }}</span>
    </button>

    <!-- Right-click context menu. Position fixed so it overlays everything
         regardless of scroll. Visibility tied to menuState; menuStyle handles
         viewport clamping. -->
    <div
      v-if="menu && menuCtx"
      class="tag-context-menu"
      :style="menuStyle"
      role="menu"
      @click.stop
    >
      <button class="ctx-item" :disabled="menuCtx.isPinned" @click="menuCloseOne">
        {{ t('components.tags.close') }}
      </button>
      <button class="ctx-item" @click="menuCloseOthers">{{ t('components.tags.closeOthers') }}</button>
      <button class="ctx-item" :disabled="!menuCtx.hasLeft" @click="menuCloseLeft">
        {{ t('components.tags.closeLeft') }}
      </button>
      <button class="ctx-item" :disabled="!menuCtx.hasRight" @click="menuCloseRight">
        {{ t('components.tags.closeRight') }}
      </button>
      <div class="ctx-sep" />
      <button class="ctx-item" @click="menuRename">{{ t('components.tags.rename') }}</button>
      <button class="ctx-item" @click="menuTogglePin">
        {{ menuCtx.isPinned ? t('components.tags.unpin') : t('components.tags.pin') }}
      </button>
      <div class="ctx-sep" />
      <button class="ctx-item ctx-item--danger" :disabled="!menuCtx.canCloseAll" @click="menuCloseAll">
        {{ t('components.tags.closeAll') }}
      </button>
    </div>

    <!-- Rename dialog. Uses Modal per R64 (no native prompt). ESC + backdrop
         handled by Modal itself. -->
    <Modal
      v-model="renameState.open"
      :title="t('components.tags.renameTab')"
      size="sm"
      @close="cancelRename"
    >
      <form class="rename-form" @submit.prevent="confirmRename">
        <input
          v-model="renameState.draft"
          class="rename-input"
          :placeholder="t('components.tags.newTitlePlaceholder')"
          maxlength="60"
          autofocus
        />
      </form>
      <template #footer>
        <Button variant="ghost" @click="cancelRename">{{ t('common.cancel') }}</Button>
        <Button variant="primary" :disabled="!renameState.draft.trim()" @click="confirmRename">
          {{ t('components.tags.ok') }}
        </Button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.tags-view {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 8px;
  background: var(--tw-gray-100);
  border-bottom: 1px solid var(--color-border);
  overflow: visible; /* allow context menu to overflow the bar */
  position: relative;
}
.tags-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  height: 100%;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--color-text-muted);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  user-select: none;
}
.tag:hover {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}
.tag.active {
  background: var(--color-bg-elevated);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.tag.pinned {
  background: var(--tw-amber-50);
  border-color: var(--tw-amber-300);
}
.tag-pin {
  font-size: 11px;
  line-height: 1;
}
.tag-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  color: inherit;
  padding: 0;
}
.tag-close:hover {
  background: rgba(0, 0, 0, 0.08);
}
.empty-tag {
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 0 6px;
}

/* ------------------------------------------------------------------ */
/*  持久化开关                                                         */
/* ------------------------------------------------------------------ */

.persist-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 4px 8px;
  font-size: 12px;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: none;
}

/* ------------------------------------------------------------------ */
/*  ⋯ overflow 按钮 (H5/触屏入口, 跟 .persist-toggle 同风格)            */
/* ------------------------------------------------------------------ */

.tag-overflow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 8px;
  padding: 0 8px;
  height: 26px; /* 跟 .tag 视觉对齐 (4+4 padding + 18 字号 ≈ 26) */
  font-size: 18px;
  line-height: 1;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  cursor: pointer;
  flex-shrink: 0;
  user-select: none;
  letter-spacing: 1px; /* ⋯⋯⋯ 三个点视觉更聚合 */
}
.tag-overflow:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.tag-overflow:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.persist-toggle:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.persist-toggle--on {
  background: var(--tw-emerald-50);
  border-color: var(--tw-emerald-300);
  color: var(--tw-emerald-700);
}
.persist-toggle--on:hover {
  background: var(--tw-emerald-100);
}
.persist-icon {
  font-size: 12px;
  line-height: 1;
}

/* ------------------------------------------------------------------ */
/*  Context menu                                                       */
/* ------------------------------------------------------------------ */

.tag-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  padding: 4px;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--color-text);
}
.ctx-item:hover:not(:disabled) {
  background: var(--color-bg-hover, #f3f4f6);
}
.ctx-item:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
  opacity: 0.5;
}
.ctx-item--danger {
  color: var(--color-danger, #dc2626);
}
.ctx-sep {
  height: 1px;
  background: var(--color-border);
  margin: 4px 6px;
}

/* ------------------------------------------------------------------ */
/*  Rename form                                                        */
/* ------------------------------------------------------------------ */

.rename-form {
  padding: 4px 0;
}
.rename-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 14px;
  outline: none;
}
.rename-input:focus {
  border-color: var(--color-primary);
}
</style>
