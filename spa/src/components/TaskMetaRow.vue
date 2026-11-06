<script setup lang="ts">
/* 功能: 渲染任务元信息行 (模型/强度/最大轮次/创建时间/上下文占用/超时剩余/成本).
   关注点: 上下文占用配色 (≥85% 红 / ≥60% 橙 / 其它灰), 超时剩余配色 (<1min 红 /
   <5min 橙 / 其它灰). 配色阈值与 master TaskMetaRow 完全一致 (R22 镜像). */
import { computed } from 'vue';
import { parseDbTime } from '@/lib/datetime';

interface Props {
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  createdAt?: string | null;
  contextTokens?: number | null;
  contextMax?: number | null;
  cost?: number | null;
  /** R239: 本任务模型相对基准模型的成本系数 (null=未设基准/没配价, 不显示后缀) */
  costCoefficient?: number | null;
  timeoutRemainingMs?: number | null;
  timeoutTotalMs?: number | null;
}
const props = defineProps<Props>();

/* ------------------------------------------------------------------ */
/*  Format helpers                                                     */
/* ------------------------------------------------------------------ */

function formatCreatedAt(iso: string | null): string {
  if (!iso) return '';
  // R205: parseDbTime 当 UTC 处理, 旧 new Date(iso) 在 CST 偏早 8h.
  const d = parseDbTime(iso);
  if (!d) return iso;
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

/* H:MM:SS or MM:SS — 小时位 0 时省掉. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

/* ------------------------------------------------------------------ */
/*  Derived                                                            */
/* ------------------------------------------------------------------ */

const ctxPct = computed<number | null>(() => {
  if (props.contextTokens == null || !props.contextMax || props.contextMax <= 0) return null;
  return Math.round((props.contextTokens / props.contextMax) * 100);
});

const ctxColor = computed<string>(() => {
  const pct = ctxPct.value;
  if (pct == null) return 'meta-neutral';
  if (pct >= 85) return 'meta-danger';
  if (pct >= 60) return 'meta-warn';
  return 'meta-neutral';
});

const timeoutColor = computed<string>(() => {
  if (props.timeoutRemainingMs == null) return 'meta-neutral';
  if (props.timeoutRemainingMs < 60_000) return 'meta-danger';
  if (props.timeoutRemainingMs < 5 * 60_000) return 'meta-warn';
  return 'meta-neutral';
});

const timeoutTooltip = computed<string>(() => {
  if (props.timeoutRemainingMs == null) return '';
  if (props.timeoutTotalMs) {
    return `总超时 ${Math.round(props.timeoutTotalMs / 60_000)} 分钟（剩余时间到点会暂停任务）`;
  }
  return '剩余时间到点会暂停任务';
});

const ctxText = computed<string>(() => {
  if (props.contextTokens == null || props.contextTokens <= 0) return '';
  const used = formatTokenCount(props.contextTokens);
  const max = props.contextMax ? ` / ${formatTokenCount(props.contextMax)}` : '';
  const pct = ctxPct.value != null ? ` (${ctxPct.value}%)` : '';
  return `${used}${max}${pct}`;
});
</script>

<template>
  <div class="task-meta-row">
    <span class="meta-item">
      模型: <strong>{{ model || '默认' }}</strong>
    </span>
    <span v-if="effort" class="meta-item">强度: {{ effort }}</span>
    <span v-if="maxTurns" class="meta-item">最大轮次: {{ maxTurns }}</span>
    <span v-if="createdAt" class="meta-item">
      创建: <strong>{{ formatCreatedAt(createdAt) }}</strong>
    </span>
    <span
      v-if="ctxText"
      class="meta-item"
      :class="ctxColor"
      title="任务停止时的上下文占用（据此判断是否需要 fork/压缩后继续）"
    >
      上下文: {{ ctxText }}
    </span>
    <span
      v-if="timeoutRemainingMs != null"
      class="meta-item"
      :class="timeoutColor"
      :title="timeoutTooltip"
    >
      剩余: {{ formatRemaining(timeoutRemainingMs) }}
    </span>
    <span
      v-if="cost != null && cost > 0"
      class="meta-item"
      :title="costCoefficient != null
        ? `本任务模型成本系数 ×${costCoefficient.toFixed(2)}（相对平台基准模型；金额按配置单价折算）`
        : '按任务模型配置的单价折算（cost_source=priced 时精确，其余为折中价估算）'"
    >💰 ${{ cost.toFixed(3) }}<template v-if="costCoefficient != null">（×{{ costCoefficient.toFixed(2) }}）</template></span>
  </div>
</template>

<style scoped>
.task-meta-row {
  display: flex;
  gap: 14px;
  font-size: 12.5px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}
.meta-item strong {
  color: var(--color-text);
  font-weight: 500;
}
.meta-danger {
  color: var(--tw-red-700);
}
.meta-warn {
  color: var(--tw-orange-700);
}
.meta-neutral {
  color: var(--color-text-muted);
}
</style>