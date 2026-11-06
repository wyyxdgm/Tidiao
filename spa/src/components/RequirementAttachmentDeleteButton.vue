<script setup lang="ts">
/* 功能: 需求点详情页附件删除按钮 (R71). 完整镜像 master
   src/app/requirements/[id]/requirement-attachment-delete-button.tsx.
   关注点:
   - 调 DELETE /api/attachments/[id] (通用端点, polymorphic — 不区分 task / requirement).
     后端 owner 校验保证跨 owner 删不了.
   - 删后 emit('deleted') 让父级 refresh 列表 (SPA 不用 router.refresh,
     父级回调更直接).
   - R64 红线: 用 ConfirmDialog (type=danger) 二次确认 + Toast 提示. */

import { ref } from 'vue';
import { deleteAttachment } from '@/api/requirements';
import { HttpError } from '@/api/http';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { useToast } from '@/composables/useToast';

interface Props {
  attachmentId: string;
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'deleted', id: string): void;
}>();

const toast = useToast();
const confirmOpen = ref<boolean>(false);
const pending = ref<boolean>(false);

async function handleDelete(): Promise<void> {
  confirmOpen.value = false;
  pending.value = true;
  try {
    const result = await deleteAttachment(props.attachmentId);
    if (!result.ok) {
      toast.error(`删除失败: ${result.error ?? 'unknown'}`);
      return;
    }
    toast.success('附件已删除');
    emit('deleted', props.attachmentId);
  } catch (err: unknown) {
    const msg =
      err instanceof HttpError
        ? `${err.message} (HTTP ${err.status})`
        : err instanceof Error
          ? err.message
          : String(err);
    toast.error(`删除失败: ${msg}`);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    :disabled="pending"
    :title="'删除附件'"
    class="text-xs text-gray-400 hover:text-red-600 px-2 py-1 rounded disabled:opacity-50"
    @click="() => (confirmOpen = true)"
  >
    {{ pending ? '删除中…' : '删除' }}
  </button>
  <ConfirmDialog
    :open="confirmOpen"
    title="删除附件"
    message="确认删除这个附件？文件本身也会一起删除。"
    confirm-text="删除"
    cancel-text="取消"
    type="danger"
    @confirm="handleDelete"
    @cancel="() => (confirmOpen = false)"
  />
</template>
