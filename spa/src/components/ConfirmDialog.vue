<script lang="ts">
/* ------------------------------------------------------------------ */
/*  Imperative API (useConfirm composable + top-level confirm())       */
/* ------------------------------------------------------------------ */
/* 功能: 命令式 confirm() — 业务里大多数确认是「点一下 → 拿 boolean」,
   维护组件 open/message/title 状态累. 这里 lazy mount 一个 Host 到 body,
   调用 confirm() 返回 Promise<boolean>. 模块级 reactive state 单例
   (类似 ToastHost 共享一个 pinia store, 但 inline 更省一个文件).
   关注点:
   - mountHost 用 createApp(HostComponent) 渲染到 body 上的 <div>.
     HostComponent 是 defineComponent + render function (不用 SFC <template>),
     避免 self-import 循环. 样式 class 与下面 <style> 的 confirm-* 同前缀.
   - 上一次未 resolve 的 confirm 被新一次调用挤掉时, 旧 resolver 给 false
     (视为取消) — 与浏览器原生 confirm() 行为一致.
   - 顶层 confirm() 是 useConfirm().confirm 的简化别名, 调用者不必每次
     写 const { confirm } = useConfirm(). */
import { createApp, defineComponent, h, reactive, type App as VueApp } from 'vue';
import Modal from './Modal.vue';
import Button from './Button.vue';

export type ConfirmType = 'danger' | 'warning' | 'info';

export interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  type?: ConfirmType;
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  type: ConfirmType;
  resolver: ((value: boolean) => void) | null;
}

const GLYPH: Record<ConfirmType, string> = {
  danger: '!',
  warning: '!',
  info: 'i',
};

// Module-scope singleton: survives across composable calls; cleared on
// resolver fires. One host per app.
const state = reactive<ConfirmState>({
  open: false,
  title: '',
  message: '',
  confirmText: '确认',
  cancelText: '取消',
  type: 'info',
  resolver: null,
});

function onConfirm(): void {
  if (!state.resolver) return;
  const resolve = state.resolver;
  state.resolver = null;
  state.open = false;
  resolve(true);
}

function onCancel(): void {
  if (!state.resolver) return;
  const resolve = state.resolver;
  state.resolver = null;
  state.open = false;
  resolve(false);
}

// Internal host rendered via createApp (not SFC <template>) so the host
// tree isn't wrapped in scoped data-attribute isolation — styles in the
// <style> block below target the class names here directly.
const HostComponent = defineComponent({
  name: 'ConfirmDialogHost',
  setup() {
    return () =>
      h(
        Modal,
        {
          modelValue: state.open,
          title: state.title,
          size: 'sm',
          closable: true,
          'onUpdate:modelValue': (v: boolean) => {
            if (!v) onCancel();
          },
        },
        {
          default: () =>
            h('div', { class: 'confirm-body' }, [
              h('div', { class: ['confirm-icon', `confirm-icon-${state.type}`] }, [
                h('span', { class: 'confirm-glyph' }, GLYPH[state.type]),
              ]),
              h('div', { class: 'confirm-message' }, state.message),
            ]),
          footer: () =>
            h('div', { class: 'confirm-footer' }, [
              h(
                Button,
                { variant: 'secondary', onClick: onCancel },
                () => state.cancelText,
              ),
              h(
                Button,
                {
                  variant: state.type === 'danger' ? 'danger' : 'primary',
                  onClick: onConfirm,
                  ref: 'confirmBtn',
                },
                () => state.confirmText,
              ),
            ]),
        },
      );
  },
});

let mountedApp: VueApp | null = null;
let mountRoot: HTMLDivElement | null = null;

function mountHost(): void {
  if (mountedApp) return;
  mountRoot = document.createElement('div');
  document.body.appendChild(mountRoot);
  mountedApp = createApp(HostComponent);
  mountedApp.mount(mountRoot);
}

function runConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  mountHost();
  // Replace any in-flight confirm with cancellation (matches native
  // window.confirm() reentrancy: new prompt supersedes old, old is
  // implicitly dismissed).
  if (state.resolver) {
    const prev = state.resolver;
    state.resolver = null;
    prev(false);
  }
  state.title = options.title ?? '';
  state.message = message;
  state.confirmText = options.confirmText ?? '确认';
  state.cancelText = options.cancelText ?? '取消';
  state.type = options.type ?? 'info';
  state.open = true;
  return new Promise<boolean>((resolve) => {
    state.resolver = resolve;
  });
}

/**
 * Composable form — mirrors useToast() shape. Safe to call multiple times;
 * returns the same singleton API each time.
 */
export function useConfirm(): {
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
} {
  return { confirm: runConfirm };
}

/**
 * Top-level convenience — `import { confirm } from '@/components/ConfirmDialog.vue'`
 * and call directly. Functionally identical to useConfirm().confirm.
 */
export function confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  return runConfirm(message, options);
}
</script>

<script setup lang="ts">
/* ------------------------------------------------------------------ */
/*  Declarative API (<ConfirmDialog :open :title :message @confirm     */
/*  @cancel />) — same shape as Next src/components/ConfirmDialog.tsx */
/* ------------------------------------------------------------------ */
/* 功能: 声明式 ConfirmDialog 组件. 与 Next 版 API 一致: open + title +
   message (字符串/可换 default slot) + onConfirm/onCancel. 命令式场景
   用上方 useConfirm() / confirm(). */
/* 关注点:
   - Modal 已处理 Teleport/ESC/backdrop-click/body-lock — 这里只关心内容.
     ESC + backdrop + ×按钮 都触发 cancel 事件 (匹配 Next onCancel).
   - type=danger 时确认按钮走 danger variant, 其余走 primary.
   - 模板样式与命令式 host 共享 <style> 段的 confirm-* class (两者都从
     同一 SFC 编译, scoped 哈希会作用于 <template> 但样式对 host 内的
     h() 元素失效 — 所以本 SFC 用非 scoped <style> + 命名空间前缀). */
import { computed } from 'vue';
// Modal 与 Button 由上方 <script> 块顶层 import, 此处可直接引用
// (同 SFC 内 <script> 顶层 binding 对 <script setup> 可见).
interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: ConfirmType;
}

const props = withDefaults(defineProps<Props>(), {
  confirmText: '确认',
  cancelText: '取消',
  type: 'info',
});

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const GLYPH_DECL: Record<ConfirmType, string> = {
  danger: '!',
  warning: '!',
  info: 'i',
};

const iconClass = computed(() => `confirm-icon-${props.type}`);
const confirmVariant = computed(() =>
  props.type === 'danger' ? 'danger' : 'primary',
);
</script>

<template>
  <Modal
    :model-value="open"
    :title="title"
    size="sm"
    @update:model-value="(v: boolean) => { if (!v) emit('cancel'); }"
  >
    <div class="confirm-body">
      <div :class="['confirm-icon', iconClass]">
        <span class="confirm-glyph">{{ GLYPH_DECL[type] }}</span>
      </div>
      <!-- R56-A4.8 (P1-1): 默认 slot — caller 可注入自定义 body (select/input).
           旧用法 :message=string 仍走 fallback. -->
      <div v-if="$slots.default" class="confirm-message confirm-message-slot">
        <slot />
      </div>
      <div v-else class="confirm-message">{{ message }}</div>
    </div>
    <template #footer>
      <div class="confirm-footer">
        <Button variant="secondary" @click="emit('cancel')">
          {{ cancelText }}
        </Button>
        <Button :variant="confirmVariant" @click="emit('confirm')">
          {{ confirmText }}
        </Button>
      </div>
    </template>
  </Modal>
</template>

<style>
/* 非 scoped: 命令式 host (createApp + h() 渲染) 不带 SFC scoped data-attr,
   样式会失效. 这里样式用 confirm-* 前缀命名空间隔离, 与现有 Modal/Vue等
   不冲突 (Modal 自有 modal-* 前缀). */
.confirm-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 4px 0 8px;
}
.confirm-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  margin-bottom: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700;
  font-size: 22px;
  line-height: 1;
  color: #fff;
  flex-shrink: 0;
}
.confirm-icon-danger {
  background: var(--color-danger);
}
.confirm-icon-warning {
  background: var(--color-warn);
}
.confirm-icon-info {
  background: var(--color-primary);
}
.confirm-glyph {
  display: inline-block;
  /* 微调 baseline: 字符 'i'/'!' 在圆形里略偏上, 这里下沉 1px 让居中更准 */
  position: relative;
  top: -1px;
}
.confirm-message {
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  max-width: 100%;
}
.confirm-message-slot {
  width: 100%;
  text-align: left;
}
.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>