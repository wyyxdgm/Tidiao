<script setup lang="ts">
import { useToastStore, type ToastVariant } from '@/stores/toast';

const store = useToastStore();

/** Compact Unicode glyph per variant — keeps the host self-contained
 *  without pulling an icon library (mirrors Next version's "no deps"). */
const SYMBOL: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  warn: '!',
  info: 'i',
};
</script>

<template>
  <!-- Teleport to body so z-index isn't trapped inside a transformed
       ancestor (e.g. a keep-alive cached view). aria-live announces
       new toasts to screen readers without stealing focus. -->
  <Teleport to="body">
    <div class="toast-host" aria-live="polite" aria-atomic="false">
      <transition-group name="toast" tag="div" class="toast-stack">
        <div
          v-for="t in store.toasts"
          :key="t.id"
          class="toast-item"
          :class="`toast-${t.variant}`"
          role="status"
        >
          <span class="toast-symbol" aria-hidden="true">{{ SYMBOL[t.variant] }}</span>
          <span class="toast-message">{{ t.message }}</span>
          <button
            type="button"
            class="toast-close"
            aria-label="关闭"
            @click="store.dismiss(t.id)"
          >×</button>
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  pointer-events: none;
}
.toast-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}
.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 280px;
  max-width: 360px;
  padding: 10px 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-left-width: 4px;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: 13px;
  line-height: 1.4;
}
.toast-success { border-left-color: var(--color-success); }
.toast-error   { border-left-color: var(--color-danger); }
.toast-warn    { border-left-color: var(--color-warn); }
.toast-info    { border-left-color: var(--color-primary); }
.toast-symbol {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  flex-shrink: 0;
  color: #fff;
  margin-top: 1px;
}
.toast-success .toast-symbol { background: var(--color-success); }
.toast-error   .toast-symbol { background: var(--color-danger); }
.toast-warn    .toast-symbol { background: var(--color-warn); }
.toast-info    .toast-symbol { background: var(--color-primary); }
.toast-message {
  flex: 1;
  color: var(--color-text);
  word-break: break-word;
  padding-top: 2px;
}
.toast-close {
  background: transparent;
  border: 0;
  padding: 0;
  width: 18px;
  height: 18px;
  font-size: 16px;
  line-height: 1;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  margin-top: 1px;
}
.toast-close:hover { color: var(--color-text); }

/* Enter/leave animation: slide-from-right + fade. */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
</style>