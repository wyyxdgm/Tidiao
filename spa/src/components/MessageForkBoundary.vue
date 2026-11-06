<script setup lang="ts">
/* 功能: Fork 分隔线 — 插入 transcript 消息列表中 (master tdc.tsx:3092-3149
   ForkBoundary 同款). 蓝色横线 + 「Fork 起点 — 以下为本会话内容」pill +
   「上方继承自 <父任务> #<id>」+ 复制链接按钮.

   关注点:
   - 仅 client-side 渲染, window 安全.
   - copyToClipboard 走 navigator.clipboard, 失败静默. */
import { ref } from 'vue';

interface Props {
  parentTask: {
    id: string;
    title: string;
    status: string;
  } | null;
}

const props = defineProps<Props>();

const copied = ref<boolean>(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyLink(): Promise<void> {
  if (!props.parentTask) return;
  const url = `${window.location.origin}/#/tasks/${props.parentTask.id}`;
  try {
    await navigator.clipboard.writeText(url);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    /* 静默 */
  }
}
</script>

<template>
  <div v-if="parentTask" class="mfb-root">
    <div class="mfb-row">
      <div class="mfb-line" />
      <div class="mfb-pill">
        <span>🔀</span>
        <span>Fork 起点 — 以下为本会话内容</span>
      </div>
      <div class="mfb-line" />
    </div>
    <div class="mfb-footer">
      <span>上方继承自</span>
      <a class="mfb-link" :href="`/#/tasks/${parentTask.id}`" :title="parentTask.title">
        {{ parentTask.title }}
      </a>
      <a class="mfb-link mfb-link-id" :href="`/#/tasks/${parentTask.id}`" :title="parentTask.id">
        #{{ parentTask.id.slice(0, 8) }}
      </a>
      <button
        type="button"
        class="mfb-copy"
        :title="copied ? '已复制' : '复制任务链接'"
        @click="copyLink"
      >
        <svg
          v-if="!copied"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          class="mfb-icon"
        >
          <path d="M7 3.5A1.5 1.5 0 018.5 2h5A1.5 1.5 0 0115 3.5v9A1.5 1.5 0 0113.5 14h-5A1.5 1.5 0 017 12.5v-9z" />
          <path d="M3.5 6A1.5 1.5 0 002 7.5v9A1.5 1.5 0 003.5 18h9a1.5 1.5 0 001.5-1.5V7.5A1.5 1.5 0 0012.5 6h-9z" opacity="0.3" />
        </svg>
        <svg
          v-else
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          class="mfb-icon mfb-icon-check"
        >
          <path
            fill-rule="evenodd"
            d="M16.704 4.153a.75.75 0 011.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mfb-root {
  margin: 12px 0;
}

.mfb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.mfb-line {
  flex: 1;
  height: 1px;
  background: var(--tw-blue-300);
}

.mfb-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--tw-blue-700);
  background: var(--tw-blue-50);
  padding: 4px 12px;
  border-radius: 9999px;
  border: 1px solid var(--tw-blue-200);
  font-weight: 500;
  flex-shrink: 0;
}

.mfb-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 11px;
  color: var(--tw-blue-500);
}

.mfb-link {
  color: var(--tw-blue-700);
  text-decoration: none;
  font-weight: 500;
}
.mfb-link:hover {
  text-decoration: underline;
}

.mfb-link-id {
  color: var(--tw-blue-400);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.mfb-link-id:hover {
  color: var(--tw-blue-600);
}

.mfb-copy {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 0;
  color: var(--tw-blue-300);
  cursor: pointer;
  padding: 2px;
  transition: color 0.12s;
}
.mfb-copy:hover {
  color: var(--tw-blue-500);
}

.mfb-icon {
  width: 12px;
  height: 12px;
}

.mfb-icon-check {
  color: var(--tw-emerald-500);
}
</style>
