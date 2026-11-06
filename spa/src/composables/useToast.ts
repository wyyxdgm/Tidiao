import { useToastStore } from '@/stores/toast';
import type { ToastOptions } from '@/stores/toast';

/* ------------------------------------------------------------------ */
/*  useToast                                                           */
/* ------------------------------------------------------------------ */

export interface ToastApi {
  /** Low-level: push with full options (variant + duration). */
  show: (message: string, opts?: ToastOptions) => number;
  success: (message: string, duration?: number) => number;
  error: (message: string, duration?: number) => number;
  warn: (message: string, duration?: number) => number;
  info: (message: string, duration?: number) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

/**
 * Convenience composable mirroring Next `useToastActions()`. Returns a
 * stable API bound to the singleton Pinia store — safe to call from any
 * component, multiple times, without re-subscribing.
 */
export function useToast(): ToastApi {
  const store = useToastStore();
  return {
    show: (msg, opts) => store.push(msg, opts),
    success: (msg, duration) =>
      store.push(msg, { variant: 'success', duration }),
    error: (msg, duration) =>
      store.push(msg, { variant: 'error', duration }),
    warn: (msg, duration) => store.push(msg, { variant: 'warn', duration }),
    info: (msg, duration) => store.push(msg, { variant: 'info', duration }),
    dismiss: (id) => store.dismiss(id),
    clear: () => store.clear(),
  };
}