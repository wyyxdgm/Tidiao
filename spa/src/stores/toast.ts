import { defineStore } from 'pinia';
import { ref } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Toast severity levels. Kept short names matching Next version. */
export type ToastVariant = 'info' | 'success' | 'error' | 'warn';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

export interface ToastOptions {
  variant?: ToastVariant;
  /** ms before auto-dismiss. 0 / undefined = default. Negative = no auto-dismiss. */
  duration?: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Default auto-dismiss window (ms). */
export const TOAST_DEFAULT_DURATION = 3000;

/** Hard cap on simultaneously-visible toasts; oldest FIFO-evicted. */
export const TOAST_MAX_VISIBLE = 5;

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

/**
 * Toast queue store. Auto-dismiss timers live in module-scope `timers`
 * keyed by toast id — they survive HMR but get cleared on store.dispose
 * (Pinia handles on app teardown).
 */
export const useToastStore = defineStore('toast', () => {
  const toasts = ref<ToastItem[]>([]);

  let nextId = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Remove toast by id; cancel its pending dismiss timer. */
  function dismiss(id: number): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
    const idx = toasts.value.findIndex((x) => x.id === id);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }

  /** Cancel every timer + clear queue (e.g. on logout). */
  function clear(): void {
    for (const h of timers.values()) clearTimeout(h);
    timers.clear();
    toasts.value = [];
  }

  /** Append a toast; returns its id. FIFO-evicts oldest if over cap. */
  function push(message: string, opts: ToastOptions = {}): number {
    const variant: ToastVariant = opts.variant ?? 'info';
    const duration = opts.duration ?? TOAST_DEFAULT_DURATION;
    const id = ++nextId;

    // Overflow policy: when at cap, drop oldest until there's room. Cancel
    // their timers so they don't fire after removal (and so we don't leak
    // handles if the user holds the page open through many toasts).
    while (toasts.value.length >= TOAST_MAX_VISIBLE) {
      const dropped = toasts.value.shift();
      if (!dropped) break;
      const h = timers.get(dropped.id);
      if (h !== undefined) {
        clearTimeout(h);
        timers.delete(dropped.id);
      }
    }

    toasts.value.push({ id, message, variant });

    if (duration > 0) {
      const handle = setTimeout(() => dismiss(id), duration);
      timers.set(id, handle);
    }
    return id;
  }

  return { toasts, push, dismiss, clear };
});