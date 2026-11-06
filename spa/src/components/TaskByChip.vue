<script setup lang="ts">
/* 功能: 渲染 [by]<短id> chip — 标识本任务由哪个父任务派发 (dispatched_by_task_id).
   完整镜像 master src/components/TaskByChip.tsx.
   关注点:
   - 短 id 走 task.id.slice(0,8) 同款现有约定 (schedules-client.tsx 等).
   - 点击跳父 task — 父级若有 <Link href=/tasks/{id}>, 必须 stopPropagation 才能
     正确跳父任务 (否则冒泡到外层 Link 会跳自己). 详情页关联 task 行不是 <Link>
     卡片, 而是普通 <div>; 但保险起见仍 stopPropagation + preventDefault.
   - 用 <span> + useRouter().push() 而非 <a>: SPA hash 路由下 router.push 更直接,
     不会触发整页跳转.
   - a11y: role="link" + tabIndex + Enter/Space keydown.
   - 视觉与 master 一致: slate chip (border + text-xs + rounded-full). */

import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

interface Props {
  dispatchedByTaskId: string;
}
const props = defineProps<Props>();
const { t } = useI18n();

const router = useRouter();
const shortId = props.dispatchedByTaskId.slice(0, 8);
const target = `/tasks/${props.dispatchedByTaskId}`;

function go(e: MouseEvent | KeyboardEvent): void {
  e.stopPropagation();
  e.preventDefault();
  void router.push(target);
}
</script>

<template>
  <span
    role="link"
    tabindex="0"
    :data-href="target"
    :title="t('tasks.comp.dispatchedFromTitle', { id: dispatchedByTaskId })"
    class="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 hover:text-slate-900 cursor-pointer"
    @click="go"
    @keydown="
      (e) => {
        if (e.key === 'Enter' || e.key === ' ') go(e);
      }
    "
  >
    by {{ shortId }}
  </span>
</template>
