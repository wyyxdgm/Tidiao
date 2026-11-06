<script setup lang="ts">
/* 功能: 需求点状态进程条 (R78 W3 §4.1 (1)). 完整镜像 master
   src/app/requirements/[id]/status-stepper.tsx.
   关注点:
   - server component, 纯渲染 (无交互; 切换状态走 RequirementStatusFlow dropdown).
   - pending → done 主轴, 中间态环 (has_suggestion/awaiting_reply/blocked) 都用蓝/紫/橙区分.
   - closed 单独一行, 不与 done 共线. */

import type { RequirementStatus } from '@/api/requirements';

interface Props {
  current: RequirementStatus;
}
const props = defineProps<Props>();

/** 主流程顺序 (pending → done) — 中间态不进主轴. */
const MAIN_FLOW: RequirementStatus[] = ['pending', 'done'];
const INTERMEDIATE: RequirementStatus[] = [
  'has_suggestion',
  'awaiting_reply',
  'blocked',
];

const STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: '未开始',
  done: '已完成',
  awaiting_reply: '等回复',
  has_suggestion: '有建议',
  blocked: '需拍板',
  closed: '已关闭',
};

const INTERMEDIATE_COLOR: Record<RequirementStatus, string> = {
  pending: '',
  done: '',
  closed: '',
  has_suggestion: 'bg-purple-100 text-purple-700 border-purple-300',
  awaiting_reply: 'bg-blue-100 text-blue-700 border-blue-300',
  blocked: 'bg-orange-100 text-orange-700 border-orange-300',
};
</script>

<template>
  <!-- closed 单独显示, 不参与主流程 -->
  <div
    v-if="current === 'closed'"
    class="bg-white rounded-lg shadow p-4 mb-6"
  >
    <div class="flex items-center gap-2 text-sm">
      <span class="inline-block w-2.5 h-2.5 rounded-full bg-gray-400"></span>
      <span class="text-gray-500 font-medium">已关闭</span>
      <span class="text-xs text-gray-400 ml-2">软删, 后续可改回其他状态</span>
    </div>
  </div>

  <div
    v-else
    class="bg-white rounded-lg shadow p-4 mb-6"
  >
    <div class="flex items-center gap-3 flex-wrap">
      <template
        v-for="(s, i) in MAIN_FLOW"
        :key="s"
      >
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2">
            <span
              :class="[
                'inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold border-2',
                current === s
                  ? 'bg-blue-600 text-white border-blue-600'
                  : MAIN_FLOW.indexOf(current) >= i
                    ? 'bg-blue-50 text-blue-700 border-blue-300'
                    : 'bg-gray-50 text-gray-400 border-gray-200',
              ]"
            >
              {{ MAIN_FLOW.indexOf(current) >= i ? '✓' : i + 1 }}
            </span>
            <span
              :class="[
                'text-sm',
                current === s
                  ? 'font-semibold text-gray-900'
                  : MAIN_FLOW.indexOf(current) >= i
                    ? 'text-gray-700'
                    : 'text-gray-400',
              ]"
            >
              {{ STATUS_LABEL[s] }}
            </span>
          </div>
          <span
            v-if="i < MAIN_FLOW.length - 1"
            :class="[
              'h-0.5 w-8',
              MAIN_FLOW.indexOf(current) >= i ? 'bg-blue-300' : 'bg-gray-200',
            ]"
          ></span>
        </div>
      </template>
      <div
        v-if="INTERMEDIATE.includes(current)"
        class="flex items-center gap-2 ml-2 pl-3 border-l border-gray-200"
      >
        <span class="text-xs text-gray-400">当前:</span>
        <span
          :class="[
            'text-xs px-2 py-0.5 rounded-full border',
            INTERMEDIATE_COLOR[current],
          ]"
        >
          {{ STATUS_LABEL[current] }}
        </span>
      </div>
    </div>
  </div>
</template>
