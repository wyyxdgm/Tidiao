<script setup lang="ts">
/* 功能: 口径徽标 — Next 端 inline ScopeBadge 的 1:1 SPA 实现.
   「自述字段的可视化」, 与积压面板的同款样式保持视觉一致.
   关注点:
   - 跟 backlog 那块同源 — 缺这块徽标, 切到「仅某用户」时人可能误以为显示的还是全平台数据.
   - 颜色规则来自 Next page.tsx ScopeBadge: scope=all 紫, scope=owner 蓝, scope=mine 灰.
   - i18n (W4b): 文案 key 落 residual.scopeBadge (W4b 新建 residual 域 —
     projects.json 正被并行 W4a 波次占用, 避免同文件冲突). */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
  /** 后端自述 scope. */
  scope: 'mine' | 'all' | 'owner';
  /** 当前 owner 对应 email (admin 切到 scope=owner 时显示「仅 <email>」). */
  ownerEmail: string | null;
}

const props = defineProps<Props>();

const { t } = useI18n();

const meta = computed<{ label: string; cls: string }>(() => {
  if (props.scope === 'all') {
    return { label: t('residual.scopeBadge.all'), cls: 'bg-purple-100 text-purple-700' };
  }
  if (props.scope === 'owner') {
    return {
      label: props.ownerEmail
        ? t('residual.scopeBadge.ownerEmail', { email: props.ownerEmail })
        : t('residual.scopeBadge.owner'),
      cls: 'bg-blue-100 text-blue-700',
    };
  }
  return { label: t('residual.scopeBadge.mine'), cls: 'bg-gray-100 text-gray-600' };
});
</script>

<template>
  <span class="ml-2 text-xs px-1.5 py-0.5 rounded align-middle" :class="meta.cls">
    {{ meta.label }}
  </span>
</template>
