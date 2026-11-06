<!-- 功能: 排队原因提示 (v531) — 任务 status=queued 且调度器写了排队原因时,
     在状态徽章旁显示一行橙色小字 (同项目互斥 / 并发满 / 内存闸门 / DAG 依赖 /
     用户上限), hover 显示全文. 调度器挡出队时写入, 出队即清 → 组件随字段消失.
     关注点: 纯展示组件, 不拉数据; reason 长 (如"同项目已有 1 个任务在运行…"),
     CSS ellipsis 截断防挤爆卡片 chip 行, 全文走 title. -->
<script setup lang="ts">
defineProps<{
  status: string;
  reason: string | null | undefined;
}>();
</script>

<template>
  <span
    v-if="status === 'queued' && reason"
    class="queued-reason-hint"
    :title="reason"
  >⏳ {{ reason }}</span>
</template>

<style>
.queued-reason-hint {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  font-size: 11px;
  line-height: 16px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 4px;
  padding: 0 6px;
}
</style>
