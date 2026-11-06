<script setup lang="ts">
/* 功能: R127 §3.2 — 看板决策 banner. 解析 awaiting_markers 中的 decision 项,
   渲染 question + 选项按钮 + 推荐项标 + 子进度条. 点击 →
   POST /api/tasks/{id}/resolve-decision body={decision_id, selected_label}.

   关注点:
   - 本组件只关心「展示 + 决策调用」, 状态本地 setState (resolvedMap). 调用
     成功后 onResolved 回调, 父组件负责 patch awaiting_markers 让 banner 消失.
   - 镜像 master src/app/[projectId]/[versionId]/board-client.tsx:251-357
     DecisionBanner, props / emit 形态保持 1:1 对等, 业务可两边互换.
   - pending 状态防止重复点击. 失败 toast.error, 成功 toast.success. */
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { post, HttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';

export interface DecisionOption {
  label: string;
  description?: string;
}

export interface ParsedDecision {
  decisionId: string;
  question: string;
  options: DecisionOption[];
  recommended?: string;
  recommendedReason?: string;
}

interface Props {
  taskId: string;
  decisions: ParsedDecision[];
  /** resolve 成功后回调. 父组件应本地 patch awaiting_markers (resolved_at +
     resolved_label), 让 banner 自然消失. */
  onResolved?: (decisionId: string, selectedLabel: string) => void;
}

const props = defineProps<Props>();

const toast = useToast();
const { t } = useI18n();
const pending = ref<string | null>(null);
const resolvedMap = ref<Record<string, { label: string; at: string }>>({});

async function handleResolve(decisionId: string, label: string, e: Event): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  if (pending.value) return;
  pending.value = decisionId;
  try {
    const res = await post<{ ok?: boolean }>(
      `/api/tasks/${props.taskId}/resolve-decision`,
      { decision_id: decisionId, selected_label: label },
    );
    if (!res || !res.ok) {
      toast.error(t('tasks.decision.errRejected'));
      return;
    }
    const now = new Date().toISOString();
    resolvedMap.value = { ...resolvedMap.value, [decisionId]: { label, at: now } };
    if (props.onResolved) props.onResolved(decisionId, label);
    toast.success(t('tasks.decision.selectedToast', { label }));
  } catch (err: unknown) {
    const msg = err instanceof HttpError
      ? (err.message || `HTTP ${err.status}`)
      : err instanceof Error ? err.message : t('common.unknownError');
    toast.error(t('tasks.decision.errFailed', { msg }));
  } finally {
    pending.value = null;
  }
}
</script>

<template>
  <!-- R56-B4.9: 根 div 加 v-if 防御 — 没 decision 时整块不挂载, 否则 .decision-banner
       CSS 1px #fde68a 边框 + #fffbeb 背景会渲染出"空黄色条" (damo 反馈 "任务列表里边的
       任务项每项都有一条黄色条"). Next.js 那边 board-client.tsx:979-981 早就判
       decisions.length === 0 return null, SPA 调用方 (BoardPage.vue:1309) 只判
       !t.deleted_at 没判 length, 等于把"空 banner 不挂"的责任推给组件自身 → 修这里.
       也省去父组件每张卡片调用 parseAwaitingDecisions 时机无关的语义负担. -->
  <div v-if="decisions.length > 0" class="decision-banner">
    <div
      v-for="(d, idx) in decisions"
      :key="d.decisionId"
      :class="['decision-row', { 'decision-row-divider': idx > 0 }]"
    >
      <div class="decision-head">
        <div class="decision-question">{{ d.question }}</div>
        <div v-if="decisions.length > 1" class="decision-progress">
          {{ t('tasks.decision.progress', { done: Object.keys(resolvedMap).length, total: decisions.length }) }}
        </div>
      </div>
      <div class="decision-options">
        <button
          v-for="opt in d.options"
          :key="opt.label"
          type="button"
          :class="[
            'decision-option',
            {
              'decision-option-resolved': resolvedMap[d.decisionId]?.label === opt.label,
              'decision-option-recommended':
                d.recommended === opt.label && resolvedMap[d.decisionId]?.label !== opt.label,
              'decision-option-disabled': !!pending || !!resolvedMap[d.decisionId],
            },
          ]"
          :title="opt.description ? `${opt.label} — ${opt.description}` : opt.label"
          :disabled="!!pending || !!resolvedMap[d.decisionId]"
          @click="(e: Event) => handleResolve(d.decisionId, opt.label, e)"
        >
          <span>{{ resolvedMap[d.decisionId]?.label === opt.label ? '✓' : opt.label }}</span>
          <span
            v-if="d.recommended === opt.label && resolvedMap[d.decisionId]?.label !== opt.label"
            class="decision-tag"
          >{{ t('tasks.decision.recommended') }}</span>
          <span
            v-if="resolvedMap[d.decisionId]?.label === opt.label"
            class="decision-tag"
          >{{ t('tasks.decision.resolved') }}</span>
        </button>
      </div>
      <div
        v-if="d.recommendedReason && !resolvedMap[d.decisionId]"
        class="decision-reason"
      >
        {{ t('tasks.decision.reason') }}{{ d.recommendedReason }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.decision-banner {
  margin: 4px 0 8px;
  padding: 8px 10px;
  border: 1px solid var(--tw-amber-200);
  border-radius: var(--radius-md);
  background: var(--tw-amber-50);
}

.decision-row-divider {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--tw-amber-200);
}

.decision-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.decision-question {
  font-size: 12px;
  font-weight: 500;
  color: var(--tw-amber-800);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.decision-progress {
  font-size: 10px;
  color: var(--tw-amber-700);
  flex-shrink: 0;
}

.decision-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.decision-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  border: 1px solid var(--tw-amber-200);
  background: var(--color-bg-elevated);
  color: var(--tw-amber-800);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.decision-option:hover:not(:disabled) {
  background: var(--tw-amber-100);
}

.decision-option-recommended {
  background: var(--tw-amber-100);
  border-color: var(--tw-amber-500);
  color: var(--tw-amber-800);
  font-weight: 500;
}

.decision-option-resolved {
  background: var(--tw-emerald-100);
  border-color: var(--tw-emerald-300);
  color: var(--tw-emerald-800);
  cursor: default;
}

.decision-option-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.decision-tag {
  font-size: 10px;
  opacity: 0.8;
}

.decision-reason {
  margin-top: 4px;
  font-size: 11px;
  color: var(--tw-amber-700);
  font-style: italic;
  opacity: 0.85;
}
</style>