<script setup lang="ts">
/* 功能: 通用对话框. Teleport 到 body, 居中 + 遮罩 + ESC + body 锁滚动.
   关注点:
   - body 锁滚动用 module 级 counter, 支持嵌套 (A 打开时再开 B, B 关时不会误释放 A 的锁).
   - closable=false 时同时禁用 ESC / 关闭按钮 / 遮罩点击.
   - Transition 包裹 v-if, 关闭走 0.18s fade + scale 退场.
   - dialog 加 tabindex=-1 接收焦点 (键盘 a11y 基础), 但不做完整 focus trap
     —— R5 范围 = "基础对话框", 后续若要嵌套表单再加 trap. */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ModalSize = 'sm' | 'md' | 'lg';

interface Props {
  /** v-model 开关. */
  modelValue: boolean;
  /** 标题. 空字符串 = 不渲染标题栏 (仅显示关闭按钮靠 closable 决定). */
  title?: string;
  /** 宽度预设. sm=360 / md=520 / lg=720 (px, 受 maxWidth:92vw 约束). */
  size?: ModalSize;
  /** 是否允许关闭 (ESC / 关闭按钮 / 遮罩点击). 默认 true. */
  closable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  size: 'md',
  closable: true,
});

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  /** 关闭时触发 (与 update:modelValue=false 同帧发出). */
  (e: 'close'): void;
}>();

/* ------------------------------------------------------------------ */
/*  Width map                                                          */
/* ------------------------------------------------------------------ */

const SIZE_WIDTH: Record<ModalSize, string> = {
  sm: '360px',
  md: '520px',
  lg: '720px',
};

const widthStyle = computed(() => ({
  width: SIZE_WIDTH[props.size],
  maxWidth: '92vw',
}));

/* ------------------------------------------------------------------ */
/*  Body scroll lock (counter-based for nesting)                       */
/* ------------------------------------------------------------------ */

let lockCount = 0;
let savedBodyOverflow = '';

function lockBody(): void {
  if (lockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function unlockBody(): void {
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = savedBodyOverflow;
  }
}

/* ------------------------------------------------------------------ */
/*  Open / close                                                       */
/* ------------------------------------------------------------------ */

const dialogEl = ref<HTMLElement | null>(null);

function close(): void {
  if (!props.closable) return;
  emit('update:modelValue', false);
  emit('close');
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      lockBody();
      window.addEventListener('keydown', onKeyDown);
      // Move focus into dialog for screen readers / keyboard users.
      await nextTick();
      dialogEl.value?.focus();
    } else {
      unlockBody();
      window.removeEventListener('keydown', onKeyDown);
    }
  },
  { immediate: true },
);

// Defensive cleanup if the component is torn down while still open
// (e.g. parent unmounts mid-flight). If it was already closed, the
// watcher has already released — body overflow stays untouched.
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (props.modelValue) unlockBody();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="modelValue"
        class="modal-root"
        role="presentation"
        data-testid="modal-root"
      >
        <!-- Backdrop: click closes (if closable). -->
        <div
          class="modal-backdrop"
          aria-hidden="true"
          @click="close"
        />
        <!-- Dialog. Stop mousedown/click so backdrop doesn't receive them. -->
        <div
          ref="dialogEl"
          class="modal-dialog"
          :style="widthStyle"
          role="dialog"
          aria-modal="true"
          :aria-label="title || undefined"
          tabindex="-1"
          @mousedown.stop
          @click.stop
        >
          <header v-if="title || closable" class="modal-header">
            <h2 v-if="title" class="modal-title">{{ title }}</h2>
            <span v-else />
            <button
              v-if="closable"
              type="button"
              class="modal-close"
              :aria-label="t('common.close')"
              @click="close"
            >×</button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-root {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}
.modal-dialog {
  position: relative;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  max-height: 86vh;
  outline: none;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border);
}
.modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}
.modal-close {
  background: transparent;
  border: 0;
  font-size: 20px;
  line-height: 1;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 4px;
}
.modal-close:hover {
  color: var(--color-text);
}
.modal-body {
  padding: 18px;
  overflow-y: auto;
  flex: 1 1 auto;
}
.modal-footer {
  padding: 12px 18px;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Enter/leave: fade backdrop + slight rise/scale on dialog. */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-active .modal-dialog,
.modal-leave-active .modal-dialog {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-dialog,
.modal-leave-to .modal-dialog {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
</style>