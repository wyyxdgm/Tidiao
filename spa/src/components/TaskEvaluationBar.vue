<script setup lang="ts">
/* 功能: 任务评分条 — 1-5 分 + note + 历史评分列表. 镜像 master tdc.tsx:2270-2327
   评分条 inline 形态 (amber-50 一行, 评分按钮 + note + 提交 + 历史).

   R56-A4.3: 从独立 section/card 搬到状态栏下方 amber-50 横条; 不再接受
   status prop, 由父级 (TaskDetailView) 在 evalOpen=true + (completed|rejected)
   时才挂载本组件. UI 极简化 — 一行 flex-wrap.

   关注点:
   - 仅 completed / 历史 rejected 状态可评分 (前端按状态判断, 后端再兜底);
     父级控制挂载避免本组件再判 status.
   - POST /api/tasks/[id]/evaluate body {score, note}; GET /api/tasks/[id]/evals 拉历史.
   - 乐观更新评分历史, 失败回滚. */
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post, HttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';

const toast = useToast();
const { t } = useI18n();

interface EvalRecord {
  id: string | number;
  score: number;
  note: string | null;
  created_at: string;
  evaluator_id?: string | null;
}

interface Props {
  taskId: string;
}
const props = defineProps<Props>();

const evals = ref<EvalRecord[]>([]);
const myScore = ref<number>(0);
const myNote = ref<string>('');
const submitting = ref<boolean>(false);
const loadingHistory = ref<boolean>(false);

async function loadHistory(): Promise<void> {
  loadingHistory.value = true;
  try {
    const data = await get<{ evals?: EvalRecord[] } | EvalRecord[]>(
      `/api/tasks/${props.taskId}/evals`,
    );
    evals.value = Array.isArray(data) ? data : (data?.evals ?? []);
  } catch (e) {
    if (!(e instanceof HttpError)) {
      evals.value = [];
    }
  } finally {
    loadingHistory.value = false;
  }
}

onMounted(() => {
  void loadHistory();
});

const avg = (): string => {
  if (evals.value.length === 0) return '0';
  const sum = evals.value.reduce((s, e) => s + e.score, 0);
  return (sum / evals.value.length).toFixed(2);
};

function setScore(n: number): void {
  myScore.value = myScore.value === n ? 0 : n;
}

async function submit(): Promise<void> {
  if (myScore.value < 1 || submitting.value) return;
  submitting.value = true;
  const temp: EvalRecord = {
    id: `temp-${Date.now()}`,
    score: myScore.value,
    note: myNote.value.trim() || null,
    created_at: new Date().toISOString(),
  };
  evals.value = [temp, ...evals.value];
  try {
    await post(`/api/tasks/${props.taskId}/evaluate`, {
      score: myScore.value,
      note: myNote.value.trim() || null,
    });
    myScore.value = 0;
    myNote.value = '';
    await loadHistory();
  } catch (e) {
    evals.value = evals.value.filter((x) => x.id !== temp.id);
    if (e instanceof HttpError) toast.error(t('tasks.eval.submitFailedMsg', { msg: e.message }));
    else toast.error(t('tasks.eval.submitFailed'));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!-- R56-A4.3: amber-50 横条 (master tdc.tsx:2270-2327 1:1). flex-wrap 一行,
       评分按钮 + note input + 提交按钮 + 历史展开 (details/summary). -->
  <div class="td-eval-bar">
    <span class="td-eval-count">{{ t('tasks.eval.count', { n: evals.length }) }}</span>
    <span v-if="evals.length > 0" class="td-eval-avg">avg {{ avg() }}</span>
    <button
      v-for="n in 5"
      :key="n"
      type="button"
      class="td-eval-star"
      :class="{ 'td-eval-star-active': myScore === n }"
      :disabled="submitting"
      :title="t('tasks.eval.starTitle', { n })"
      @click="setScore(n)"
    >{{ n }}★</button>
    <input
      v-model="myNote"
      type="text"
      class="td-eval-note"
      :placeholder="t('tasks.eval.notePlaceholder')"
      :disabled="submitting"
    />
    <button
      type="button"
      class="td-eval-submit"
      :disabled="myScore < 1 || submitting"
      @click="submit"
    >{{ submitting ? t('tasks.eval.submitting') : t('tasks.eval.submit') }}</button>
    <details v-if="evals.length > 0" class="td-eval-hist-wrap">
      <summary class="td-eval-hist-toggle">{{ t('tasks.eval.history') }}</summary>
      <ul class="td-eval-hist">
        <li
          v-for="e in evals"
          :key="e.id"
          class="td-eval-hist-item"
        >
          <span class="td-eval-hist-meta">{{ e.created_at }}</span>
          <span class="td-eval-hist-score">{{ e.score }}★</span>
          <span v-if="e.note" class="td-eval-hist-note">{{ e.note }}</span>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
/* R56-A4.3: amber-50 横条样式 (master tdc.tsx:2271-2327 同款). */
.td-eval-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(254, 243, 199, 0.5);
  font-size: 12px;
}
@media (min-width: 640px) {
  .td-eval-bar {
    gap: 8px;
    padding: 6px 16px;
  }
}

.td-eval-count {
  font-weight: 500;
  color: var(--tw-gray-700);
}
.td-eval-avg {
  color: var(--tw-gray-600);
}

.td-eval-star {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--tw-gray-300);
  background: var(--color-bg-elevated);
  color: var(--tw-gray-600);
  cursor: pointer;
}
.td-eval-star:hover:not(:disabled) {
  background: var(--tw-amber-100);
}
.td-eval-star-active {
  background: var(--tw-amber-500-solid);
  color: #fff;
  border-color: var(--tw-amber-500);
}
.td-eval-star:disabled {
  cursor: not-allowed;
}

.td-eval-note {
  flex: 1;
  min-width: 160px;
  max-width: 28rem;
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 4px;
  background: var(--color-bg-elevated);
}

.td-eval-submit {
  font-size: 12px;
  padding: 4px 12px;
  background: var(--tw-blue-600-solid);
  color: #fff;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.td-eval-submit:hover:not(:disabled) {
  background: var(--tw-blue-700-solid);
}
.td-eval-submit:disabled {
  background: var(--tw-gray-300);
  cursor: not-allowed;
}

.td-eval-hist-wrap {
  position: relative;
  margin-left: 8px;
}
.td-eval-hist-toggle {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--tw-gray-500);
  list-style: none;
}
.td-eval-hist-toggle::-webkit-details-marker {
  display: none;
}
.td-eval-hist {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 10;
  margin-top: 4px;
  width: 18rem;
  max-height: 10rem;
  overflow-y: auto;
  padding: 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--tw-gray-300);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  list-style: none;
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.td-eval-hist-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--tw-gray-100);
}
.td-eval-hist-item:last-child {
  border-bottom: 0;
}
.td-eval-hist-meta {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--tw-gray-500);
}
.td-eval-hist-score {
  font-weight: 500;
}
.td-eval-hist-note {
  flex: 1;
  color: var(--tw-gray-600);
}
</style>