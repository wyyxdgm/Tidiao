<script setup lang="ts">
/* 功能: R206 主题切换 — AppHeader 右侧小按钮 + 下拉三选一 (浅色 / 深色 / 随系统).
   偏好存 localStorage 'ao_theme' (见 lib/theme.ts), 立即生效, 刷新后保留.
   关注点:
   - 下拉用 <Teleport to="body"> + fixed 定位, 浮在 header 之上 (镜像 AccountSwitcher).
   - 点击 trigger / 菜单外 / Escape 关闭; 卸载时清监听.
   - 图标随当前「解析后」主题变化 (system 时按实际亮暗显示日/月). */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme, type ThemePreference } from '@/lib/theme';

const { preference, resolved, setThemePreference } = useTheme();
const { t } = useI18n();

const open = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const dropdownStyle = ref<{ top: string; left: string } | null>(null);

// label 走 t() 动态翻译 (语言切换即时生效).
const OPTIONS = computed<{ value: ThemePreference; label: string }[]>(() => [
  { value: 'light', label: t('common.themeLight') },
  { value: 'dark', label: t('common.themeDark') },
  { value: 'system', label: t('common.themeSystem') },
]);

const triggerTitle = computed(() => {
  const cur = OPTIONS.value.find((o) => o.value === preference.value)?.label ?? t('common.theme');
  return t('common.themeTitle', { name: cur });
});

function recomputePosition(): void {
  const el = triggerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const MENU_WIDTH = 128;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // 菜单高度 = 3 行 * 34 + padding 8 ≈ 110, 留余量 120.
  const menuHeight = 120;
  const top = vh - rect.bottom < menuHeight + 16
    ? Math.max(8, rect.bottom - menuHeight)
    : rect.bottom + 4;
  // 右对齐 trigger 右缘, 视口右溢出则左移.
  const desiredLeft = rect.right - MENU_WIDTH;
  const left = Math.max(8, Math.min(desiredLeft, vw - MENU_WIDTH - 8));
  dropdownStyle.value = { top: `${top}px`, left: `${left}px` };
}

function toggle(e: MouseEvent): void {
  e.stopPropagation();
  open.value = !open.value;
  if (open.value) recomputePosition();
}

function pick(v: ThemePreference): void {
  setThemePreference(v);
  open.value = false;
}

function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  const t = e.target as Node;
  if (triggerRef.value?.contains(t)) return;
  if (dropdownRef.value?.contains(t)) return;
  open.value = false;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', recomputePosition);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', recomputePosition);
});
</script>

<template>
  <div class="theme-toggle">
    <button
      ref="triggerRef"
      type="button"
      class="tt-btn"
      :title="triggerTitle"
      :aria-label="triggerTitle"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
    >
      <!-- 日 (浅色) -->
      <svg
        v-if="resolved === 'light'"
        viewBox="0 0 20 20"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="10" cy="10" r="3.6" />
        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" />
      </svg>
      <!-- 月 (深色) -->
      <svg
        v-else
        viewBox="0 0 20 20"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z" />
      </svg>
    </button>

    <Teleport to="body" :disabled="!open">
      <div
        v-if="open && dropdownStyle"
        ref="dropdownRef"
        class="tt-menu"
        :style="dropdownStyle"
        role="menu"
      >
        <button
          v-for="opt in OPTIONS"
          :key="opt.value"
          type="button"
          class="tt-item"
          :class="{ active: preference === opt.value }"
          role="menuitemradio"
          :aria-checked="preference === opt.value"
          @click="pick(opt.value)"
        >
          <span class="tt-check" aria-hidden="true">{{ preference === opt.value ? '✓' : '' }}</span>
          {{ opt.label }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.theme-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  /* R206 bug 反馈: 右缘与用户区(邮箱)零间距贴死 — 补 10px, 镜像 TaskSearchBox 的 margin-right 节奏. */
  margin-right: 10px;
}
.tt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.tt-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.tt-menu {
  position: fixed;
  z-index: 9999;
  width: 128px;
  padding: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.tt-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.tt-item:hover {
  background: var(--color-bg-hover);
}
.tt-item.active {
  color: var(--color-primary);
  font-weight: 600;
}
.tt-check {
  display: inline-block;
  width: 12px;
  font-size: 12px;
  flex-shrink: 0;
}
</style>
