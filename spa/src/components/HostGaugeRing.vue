<script setup lang="ts">
/* 功能: 顶栏主机状态圈 + 宝塔式四环 popover (R235, 仅管理员) —
   顶栏形态三选一 (popover 底部切换, localStorage 记忆):
   - 单环 (默认): 迷你环, 弧长/颜色 = 负载/CPU/内存/磁盘 四项中最差项;
     环内形态随「环内」配置四档 (damo 1026): 无数字 (26px) / 仅数字 (29px) /
     数字+% (34px) / 进度条 (最差项 mini bar, 复用横条行样式);
   - 四环常驻: 迷你环 ×4, 环内文字三档 (无数字/仅数字/数字+%, damo 1011);
   - 横条: 微进度条 (负载/CPU/内存/磁盘 + 行尾 %, 2 列布局, 指标可选), 即当年被毙的
     4 行方案作为第三形态回归 (damo 1011 「再加4条线类型」).
   任一形态点击弹 popover, 内放 4 个 76px 宝塔式圈圈 + 明细行.
   窄屏强制替身 (damo 1026): ≤350px 才强制单环 (原 ≤767px 全手机强制过激,
   iPad/大屏手机被迫只看一个环); matchMedia 驱动 (替代旧 CSS @media 硬切,
   JS 侧还需驱动 popover「环内」选项行).
   显示指标自由组合 (popover 底部 chips, damo 1011): 至少留 1 个; 单环 =
   所选指标最差项, 四环/横条 = 只渲染所选, popover 恒显全 4 项.
   数据复用 useTaskResources 单例轮询 (3s / 空闲 10s), 纯展示零新请求.
   阈值: <70 绿 / 70-90 琥珀 / ≥90 红; 负载可 >100 (过载), 弧长/条宽 clamp
   100 显示、数字保留真实值.
   关注点: popover Teleport body + fixed 定位 + click-outside/Esc 关闭
   (对齐 AccountSwitcher dropdown 模式); 磁盘 statfs 不可用 → null →
   该项灰显 '--', 不报错. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { HostResourceSummary } from '@/composables/useTaskResources';
import { taskResources, taskResourceTitles } from '@/composables/useTaskResources';
import { backendHealthy } from '@/composables/useBackendHealth';
import { buildTaskSegments, segDash, type TaskSeg } from '@/lib/host-task-segments';

const props = defineProps<{ host: HostResourceSummary }>();

const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<{ top: string; left: string } | null>(null);

const PANEL_W = 396;
const PANEL_H_EST = 224;

/** 顶栏形态持久化: 'single' | 'quad' | 'bars'. 非法值回落 single. */
const MODE_KEY = 'hgr-header-mode';
function loadMode(): 'single' | 'quad' | 'bars' {
  const v = localStorage.getItem(MODE_KEY);
  return v === 'quad' || v === 'bars' ? v : 'single';
}
const mode = ref<'single' | 'quad' | 'bars'>(loadMode());
/** 环内形态 (damo 1011 三档 + damo 1026 进度条档): 'none' 无数字 / 'num'
    仅数字 / 'pct' 数字+% / 'bar' 进度条 (仅单环形态消费, 四环回落 none 渲染).
    旧单键 hgr-ring-pct ('0') 迁移为 'none'. */
type RingText = 'none' | 'num' | 'pct' | 'bar';
const TEXT_KEY = 'hgr-ring-text';
function loadRingText(): RingText {
  const v = localStorage.getItem(TEXT_KEY);
  if (v === 'none' || v === 'num' || v === 'pct' || v === 'bar') return v;
  return localStorage.getItem('hgr-ring-pct') === '0' ? 'none' : 'pct';
}
const ringText = ref<RingText>(loadRingText());

/** 窄屏强制替身判据 (damo 1026「350px 才强制成单个圈圈」): ≤350px 时四环/
    横条藏、渲染单环替身; 原阈值 767px 把 iPad/大屏手机也压成单环, 过激.
    matchMedia 响应式 (替代旧 CSS @media 硬切) — popover「环内」选项行
    (单环态多「进度条」档) 也靠它切. */
const narrowMq = window.matchMedia('(max-width: 350px)');
const isNarrow = ref(narrowMq.matches);
function onMqChange(e: MediaQueryListEvent): void {
  isNarrow.value = e.matches;
}
/** 单环形态生效 = 用户选「单环」或窄屏强制替身. */
const showSingleForm = computed(() => mode.value === 'single' || isNarrow.value);

/** 顶部显示哪些指标 (damo 1011「自由组合」): 子集至少留 1 个 (防头部入口消失).
    单环 = 所选指标的最差项; 四环/横条 = 只渲染所选; popover 大圈恒显全 4 项. */
type MetricKey = 'load' | 'cpu' | 'mem' | 'disk';
const METRICS_KEY = 'hgr-metrics';
const ALL_METRICS: MetricKey[] = ['load', 'cpu', 'mem', 'disk'];
function loadMetrics(): MetricKey[] {
  try {
    const arr = JSON.parse(localStorage.getItem(METRICS_KEY) || '[]');
    const valid = Array.isArray(arr)
      ? arr.filter((k: string): k is MetricKey => ALL_METRICS.includes(k as MetricKey))
      : [];
    return valid.length > 0 ? valid : [...ALL_METRICS];
  } catch {
    return [...ALL_METRICS];
  }
}
const metricKeys = ref<MetricKey[]>(loadMetrics());
function toggleMetric(k: MetricKey): void {
  const i = metricKeys.value.indexOf(k);
  if (i >= 0) {
    if (metricKeys.value.length === 1) return; // 至少留 1 个
    metricKeys.value = metricKeys.value.filter((x) => x !== k);
  } else {
    metricKeys.value = [...metricKeys.value, k];
  }
}
watch([mode, ringText, metricKeys], ([m, t, mk]) => {
  try {
    localStorage.setItem(MODE_KEY, m);
    localStorage.setItem(TEXT_KEY, t);
    localStorage.setItem(METRICS_KEY, JSON.stringify(mk));
  } catch {
    /* 写入失败 (隐私模式等) → 不记忆, 会话内仍生效 */
  }
});

/** 顶部渲染用: 按 metricKeys 过滤后的环数据. */
const selectedGauges = computed(() => gauges.value.filter((g) => metricKeys.value.includes(g.key as MetricKey)));

/** 状态色: <70 绿 / 70-90 琥珀 / ≥90 红 (四指标统一). */
function statusColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return '#10b981';
}

function dashFor(pct: number, r: number): string {
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  return `${(clamped / 100) * c} ${c}`;
}

function pctOf(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/** 四环数据 (宝塔顺序: 负载/CPU/内存/磁盘). disk null → 灰显占位. */
const gauges = computed(() => {
  const h = props.host;
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  const load1 = (h.loadPercent * h.cpuCores) / 100;
  const base = [
    {
      key: 'load',
      label: '负载',
      pct: h.loadPercent,
      text: `${Math.round(h.loadPercent)}%`,
      detail: `${load1.toFixed(2)} / ${h.cpuCores}核`,
    },
    {
      key: 'cpu',
      label: 'CPU',
      pct: h.cpuUsedPercent,
      text: `${Math.round(h.cpuUsedPercent)}%`,
      detail: `共 ${h.cpuCores} 核`,
    },
    {
      key: 'mem',
      label: '内存',
      pct: pctOf(h.memUsedMB, h.memTotalMB),
      text: `${Math.round(pctOf(h.memUsedMB, h.memTotalMB))}%`,
      detail: `${gb(h.memUsedMB)} / ${gb(h.memTotalMB)} GB`,
    },
  ];
  const rows = base.map((g) => ({
    ...g,
    color: statusColor(g.pct),
    dash: dashFor(g.pct, 32),
  }));
  if (h.disk) {
    rows.push({
      key: 'disk',
      label: '磁盘',
      pct: h.disk.usedPercent,
      text: `${Math.round(h.disk.usedPercent)}%`,
      detail: `${h.disk.usedGB} / ${h.disk.totalGB} GB`,
      color: statusColor(h.disk.usedPercent),
      dash: dashFor(h.disk.usedPercent, 32),
    });
  } else {
    rows.push({
      key: 'disk',
      label: '磁盘',
      pct: 0,
      text: '--',
      detail: '不可用',
      color: '#9ca3af',
      dash: dashFor(0, 32),
    });
  }
  return rows;
});

/** 单环显示项 = 所选指标中最差项 (弧长/颜色/环内数字/进度条同源). */
const worstGauge = computed(() => {
  let w = selectedGauges.value[0];
  for (const g of selectedGauges.value) if (g.pct > w.pct) w = g;
  return w;
});
/** trigger 弧长 = 所选指标中最差值 (负载 clamp 100). */
const worstPct = computed(() => worstGauge.value?.pct ?? 0);

/* R237 (damo 1011): 任务分段 — CPU/内存环上叠加每个运行中任务的占用弧段.
   同一 0-100 口径依序累积 (负载/磁盘不分段: 负载是系统级导出量, 磁盘无
   进程归属). 单环模式在所显指标为 cpu/mem 时同样叠加. 数据复用
   useTaskResources 单例 (零新请求), 排序/配色/缝隙逻辑在
   lib/host-task-segments.ts (纯函数, 9 条单测). */
const cpuSegs = computed(() =>
  buildTaskSegments(taskResources.value, taskResourceTitles.value, (s) => s.hostCpuPercent),
);
const memSegs = computed(() =>
  buildTaskSegments(taskResources.value, taskResourceTitles.value, (s) => s.memPercent),
);
function segsOf(key: string): TaskSeg[] {
  if (key === 'cpu') return cpuSegs.value;
  if (key === 'mem') return memSegs.value;
  return [];
}
/** 单环模式所显指标 key (最差项) — 决定单环是否叠分段. */
const worstKey = computed<string | null>(() => worstGauge.value?.key ?? null);
/** 分段弧段 hover 文案. */
function segTip(seg: TaskSeg, metricLabel: string): string {
  return `任务「${seg.label}」· ${metricLabel} ${seg.value.toFixed(1)}% (全机口径)`;
}
/** 后台断开时环置灰 (damo 1011「把连接状态体现在圈圈上」): host 数据停更,
    灰环 = 死数据警示; 呼吸点保留管「连接」语义, 两者不混. */
const off = computed(() => backendHealthy.value === false);

const triggerTip = computed(() => {
  const head = off.value ? '后台断开 (数据已停更) · ' : '';
  return (
    head +
    `主机: 负载 ${Math.round(props.host.loadPercent)}% · CPU ${Math.round(
      props.host.cpuUsedPercent,
    )}% · 内存 ${Math.round(pctOf(props.host.memUsedMB, props.host.memTotalMB))}% · 磁盘 ${
      props.host.disk ? `${Math.round(props.host.disk.usedPercent)}%` : '--'
    } (点击看宝塔式四环)`
  );
});

/** 横条块宽/填充自适应 (damo 1011「2个指标以下缩回来」+「两条变成四条的宽度」):
    根因 = CSS 里 grid-auto-flow:column + 显式 2 行, 2 项时两根条同落左列
    上下排、右列整列空 → 看着是 260px 装了两条. 故 ≤2 项切 row flow 并缩宽:
    1 项单列 150px / 2 项双列 216px 并排铺满; ≥3 项回落 CSS 默认 (column
    flow 2 行, 260px). */
const barsStyle = computed(() => {
  const n = selectedGauges.value.length;
  if (n <= 1) return { width: '150px', gridTemplateColumns: '1fr', gridAutoFlow: 'row' };
  if (n === 2) return { width: '216px', gridAutoFlow: 'row' };
  return {};
});

/** 迷你环尺寸三档, 随环内文字自动微调 (damo 1011): 无数字 26 / 仅数字
    29 / 数字+% 34 (damo 1011「字和圈连在一起」→ % 档加回 34 给字串留空).
    同一 viewBox 34 等比缩放 — 小档描边视觉更细. 单环/四环共用.
    「进度条」档不渲染环 → effRingText 回落 none 档尺寸 (仅四环态兜底). */
const RING_SIZE: Record<'none' | 'num' | 'pct', number> = { none: 26, num: 29, pct: 34 };
/** 环渲染用的有效文字档: 'bar' 只被单环进度条消费, 环一律按 none 画. */
const effRingText = computed<'none' | 'num' | 'pct'>(() =>
  ringText.value === 'bar' ? 'none' : ringText.value,
);
const ringSize = computed(() => RING_SIZE[effRingText.value]);

/** 「环内」选项行: 单环形态 (含窄屏替身) 多「进度条」档 (damo 1026);
    四环态维持三档; 横条形态本身就是进度条, 该行不显示. */
const RING_TEXT_OPTS: { v: RingText; label: string }[] = [
  { v: 'none', label: '无数字' },
  { v: 'num', label: '仅数字' },
  { v: 'pct', label: '数字+%' },
  { v: 'bar', label: '进度条' },
];
const ringTextOpts = computed(() => (showSingleForm.value ? RING_TEXT_OPTS : RING_TEXT_OPTS.slice(0, 3)));

function recomputePosition(): void {
  const el = triggerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 弹层宽响应式 (H5): 手机上钳到 vw-16, 四环 wrap 成 2×2 高度涨 → 估算跟调.
  const pw = Math.min(PANEL_W, vw - 16);
  const hEst = vw < 480 ? 340 : PANEL_H_EST;
  // trigger 下方 6px; 下方放不下 → 翻转到 trigger 上方.
  let top = rect.bottom + 6;
  if (top + hEst + 8 > vh) top = Math.max(8, rect.top - hEst - 6);
  // 右对齐 trigger.right, 双向 clamp 留 8px 边距.
  let left = rect.right - pw;
  left = Math.max(8, Math.min(left, vw - pw - 8));
  panelStyle.value = { top: `${top}px`, left: `${left}px` };
}

function onDocClick(e: MouseEvent): void {
  const t = e.target as Node;
  if (panelRef.value?.contains(t) || triggerRef.value?.contains(t)) return;
  open.value = false;
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false;
}
/** resize 跟随 (damo 1011「resize 后面板还在老位置」): 打开期间视口变化重算位置. */
function onResize(): void {
  if (open.value) recomputePosition();
}

function toggle(): void {
  open.value = !open.value;
}

/** 四环常驻模式的单环 tooltip. */
function quadTip(g: { label: string; pct: number; detail: string }): string {
  return `${g.label} ${Math.round(g.pct)}% · ${g.detail} (点击看明细)`;
}

watch(open, (v) => {
  if (v) {
    recomputePosition();
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onResize);
  } else {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onResize);
  }
});
onMounted(() => narrowMq.addEventListener('change', onMqChange));
onBeforeUnmount(() => {
  narrowMq.removeEventListener('change', onMqChange);
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div ref="triggerRef" class="hgr-root" :class="{ 'hgr-off': off }">
    <!-- 单环形态 (选「单环」或窄屏 ≤350px 强制替身, damo 1026) — 环内四档:
         无数字 26 / 仅数字 29 / 数字+% 34 (同 viewBox 等比缩放) / 进度条
         (最差项 mini bar). R237: 所显指标为 CPU/内存时叠任务分段弧. -->
    <button
      v-if="showSingleForm && ringText === 'bar'"
      type="button"
      class="hgr-trigger hgr-single-bar"
      :title="triggerTip"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="hgr-bar-k">{{ worstGauge?.label }}</span>
      <div class="hgr-bar-track">
        <div
          class="hgr-bar-fill"
          :style="{ width: `${Math.min(100, worstGauge?.pct ?? 0)}%`, background: worstGauge?.color }"
        />
      </div>
      <span class="hgr-bar-v">{{ Math.round(worstGauge?.pct ?? 0) }}%</span>
    </button>
    <button
      v-else-if="showSingleForm"
      type="button"
      class="hgr-trigger"
      :title="triggerTip"
      :aria-expanded="open"
      @click="toggle"
    >
      <svg :width="ringSize" :height="ringSize" viewBox="0 0 34 34" aria-hidden="true">
        <circle class="hgr-track" cx="17" cy="17" r="13" />
        <circle
          class="hgr-quad-arc"
          cx="17"
          cy="17"
          r="13"
          :stroke="statusColor(worstPct)"
          :stroke-dasharray="dashFor(worstPct, 13)"
        />
        <circle
          v-for="seg in segsOf(worstKey ?? '')"
          :key="seg.id"
          class="hgr-seg-arc hgr-seg-arc-q"
          cx="17"
          cy="17"
          r="13"
          :stroke="seg.color"
          :stroke-dasharray="segDash(seg, 13).dasharray"
          :stroke-dashoffset="segDash(seg, 13).dashoffset"
        ><title>{{ segTip(seg, worstKey === 'mem' ? '内存' : 'CPU') }}</title></circle>
      </svg>
      <span v-if="effRingText !== 'none'" class="hgr-quad-num" :style="{ color: statusColor(worstPct) }">
        <template v-if="effRingText === 'pct'">{{ Math.round(worstPct) }}<span class="hgr-pct-sign">%</span></template>
        <template v-else>{{ Math.round(worstPct) }}</template>
      </span>
    </button>
    <!-- 四环常驻模式: 迷你环 ×N (所选指标), 环内文字三档 (「进度条」档回落无数字);
         窄屏 ≤350px 藏 (强制替身接管). 点击任一环弹 popover. -->
    <div v-if="mode === 'quad' && !isNarrow" class="hgr-quad">
      <button
        v-for="g in selectedGauges"
        :key="g.key"
        type="button"
        class="hgr-quad-btn"
        :title="quadTip(g)"
        @click="toggle"
      >
        <svg :width="ringSize" :height="ringSize" viewBox="0 0 34 34" aria-hidden="true">
          <circle class="hgr-track" cx="17" cy="17" r="13" />
          <circle
            class="hgr-quad-arc"
            cx="17"
            cy="17"
            r="13"
            :stroke="g.color"
            :stroke-dasharray="dashFor(g.pct, 13)"
          />
          <!-- R237: CPU/内存环叠任务分段弧 (负载/磁盘不分段, segsOf 返回空). -->
          <circle
            v-for="seg in segsOf(g.key)"
            :key="seg.id"
            class="hgr-seg-arc hgr-seg-arc-q"
            cx="17"
            cy="17"
            r="13"
            :stroke="seg.color"
            :stroke-dasharray="segDash(seg, 13).dasharray"
            :stroke-dashoffset="segDash(seg, 13).dashoffset"
          ><title>{{ segTip(seg, g.label) }}</title></circle>
        </svg>
        <span v-if="effRingText !== 'none'" class="hgr-quad-num" :style="{ color: g.color }">
          <template v-if="effRingText === 'pct'">{{ Math.round(g.pct) }}<span class="hgr-pct-sign">%</span></template>
          <template v-else>{{ Math.round(g.pct) }}</template>
        </span>
      </button>
    </div>
    <!-- 横条模式: 微进度条 2 列 (负载/CPU 左, 内存/磁盘 右, 按所选指标), 宽随指标数自适应;
         窄屏 ≤350px 藏 (强制替身接管). 点击弹 popover. -->
    <div v-if="mode === 'bars' && !isNarrow" class="hgr-bars" :style="barsStyle">
      <div v-for="g in selectedGauges" :key="g.key" class="hgr-bar-row" :title="quadTip(g)" @click="toggle">
        <span class="hgr-bar-k">{{ g.label }}</span>
        <div class="hgr-bar-track">
          <div
            class="hgr-bar-fill"
            :style="{ width: `${Math.min(100, g.pct)}%`, background: g.color }"
          />
        </div>
        <span class="hgr-bar-v">{{ Math.round(g.pct) }}%</span>
      </div>
    </div>
    <Teleport to="body">
      <div v-if="open" ref="panelRef" class="hgr-panel" :style="panelStyle" @click.stop>
        <div v-for="g in gauges" :key="g.key" class="hgr-gauge">
          <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
            <circle class="hgr-track" cx="38" cy="38" r="32" />
            <circle class="hgr-arc" cx="38" cy="38" r="32" :stroke="g.color" :stroke-dasharray="g.dash" />
            <!-- R237: CPU/内存大环叠任务分段弧, hover 段看任务名. -->
            <circle
              v-for="seg in segsOf(g.key)"
              :key="seg.id"
              class="hgr-seg-arc"
              cx="38"
              cy="38"
              r="32"
              :stroke="seg.color"
              :stroke-dasharray="segDash(seg, 32).dasharray"
              :stroke-dashoffset="segDash(seg, 32).dashoffset"
            ><title>{{ segTip(seg, g.label) }}</title></circle>
          </svg>
          <span class="hgr-num" :style="{ color: g.color }">{{ g.text }}</span>
          <span class="hgr-label">{{ g.label }}</span>
          <span class="hgr-detail">{{ g.detail }}</span>
        </div>
        <!-- 顶栏形态 / 环内文字 / 显示指标 切换, localStorage 记忆.
             指标至少留 1 个 (toggleMetric 守卫), 防头部入口消失. -->
        <div class="hgr-foot">
          <span class="hgr-foot-label">指标</span>
          <div class="hgr-chips">
            <button
              v-for="g in gauges"
              :key="g.key"
              type="button"
              :class="['hgr-chip', metricKeys.includes(g.key as MetricKey) && 'hgr-chip-on']"
              :title="metricKeys.includes(g.key as MetricKey) ? '点击隐藏' : '点击显示'"
              @click="toggleMetric(g.key as MetricKey)"
            >{{ g.label }}</button>
          </div>
        </div>
        <div class="hgr-foot">
          <span class="hgr-foot-label">顶栏形态</span>
          <div class="hgr-seg">
            <button
              type="button"
              :class="['hgr-seg-btn', mode === 'single' && 'hgr-seg-active']"
              @click="mode = 'single'"
            >单环</button>
            <button
              type="button"
              :class="['hgr-seg-btn', mode === 'quad' && 'hgr-seg-active']"
              @click="mode = 'quad'"
            >四环</button>
            <button
              type="button"
              :class="['hgr-seg-btn', mode === 'bars' && 'hgr-seg-active']"
              @click="mode = 'bars'"
            >横条</button>
          </div>
          <!-- 环内: 单环形态 (含窄屏替身) 四档 (多「进度条」), 四环态三档;
               横条形态不显示 (本身就是进度条). -->
          <template v-if="showSingleForm || (mode === 'quad' && !isNarrow)">
            <span class="hgr-foot-label">环内</span>
            <div class="hgr-seg">
              <button
                v-for="opt in ringTextOpts"
                :key="opt.v"
                type="button"
                :class="['hgr-seg-btn', ringText === opt.v && 'hgr-seg-active']"
                @click="ringText = opt.v"
              >{{ opt.label }}</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.hgr-root {
  flex-shrink: 0;
  margin-right: 8px;
}
/* 后台断开: 环置灰 (数据停更, 灰 = 别信); popover 不受影响仍可开. */
.hgr-off {
  opacity: 0.4;
  filter: grayscale(1);
}
/* 四环常驻模式: 4 个 34px 环排一行, 占位 ≈ 156px. 描边 3 (damo 1011:
   「小环细一点点/别挤在一起」— 3.5→3 + 间距 5→6). */
.hgr-quad {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 横条模式: 2 列布局 (damo 1011「左右拆分」) — 左列 负载/CPU (算力), 右列
   内存/磁盘 (存储), grid column-flow 填充. 高 2×5+3+8 ≈ 21px, 宽 260px. */
.hgr-bars {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto auto;
  grid-auto-flow: column; /* 列优先填充: 负载,CPU 落左列; 内存,磁盘 落右列 */
  gap: 3px 10px;
  width: 260px;
  padding: 3px 8px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
}
.hgr-bar-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.hgr-bar-k {
  flex-shrink: 0;
  width: 26px;
  font-size: 10px;
  line-height: 1.2;
  color: var(--color-text-muted);
}
.hgr-bar-track {
  flex: 1;
  height: 5px;
  border-radius: 999px;
  background: var(--tw-gray-100);
  overflow: hidden;
}
.hgr-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s;
}
.hgr-bar-v {
  flex-shrink: 0;
  width: 28px;
  text-align: right;
  font-size: 10px;
  line-height: 1.2;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.hgr-quad-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-radius: 50%;
}
.hgr-quad-arc {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 17px 17px;
  transition: stroke-dasharray 0.4s;
}
.hgr-quad-num {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
/* 数字+% 档: 数字 9.5px 不再缩 (damo 1011「字不好再小」), % 符号单独
   0.8 倍 — 单位符号小一号的常规排版手法, 字串变短, 环内不再贴边. */
.hgr-pct-sign {
  font-size: 0.8em;
}
/* popover 底部设置行 (指标 / 顶栏形态 / 环内, 共 2-3 行). */
.hgr-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
}
.hgr-foot-label {
  font-size: 11px;
  color: var(--color-text-muted);
}
/* 指标开关 chips: 亮 = 显示, 灰 = 隐藏. */
.hgr-chips {
  display: flex;
  gap: 6px;
}
.hgr-chip {
  padding: 2px 10px;
  font-size: 11px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 999px;
}
.hgr-chip-on {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}
.hgr-seg {
  display: flex;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.hgr-seg-btn {
  padding: 2px 10px;
  font-size: 11px;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.hgr-seg-btn + .hgr-seg-btn {
  border-left: 1px solid var(--color-border);
}
.hgr-seg-active {
  background: var(--color-primary);
  color: #fff;
}
.hgr-trigger {
  position: relative; /* 环内数字 span (absolute inset-0) 的定位基准 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-radius: 50%;
}
/* 单环「进度条」档 (damo 1026): 最差项 mini bar (标签+条+%), 复用横条行样式,
   外框对齐 .hgr-bars 盒 (边框+底色), 宽随内容自撑. */
.hgr-single-bar {
  gap: 5px;
  min-width: 128px;
  padding: 3px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  background: var(--color-bg-elevated);
}
.hgr-track {
  fill: none;
  stroke: var(--color-border);
  stroke-width: 3;
}
.hgr-arc {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 13px 13px;
  transition: stroke-dasharray 0.4s;
}
/* R237: 任务分段弧 — 叠在底弧同路径上 (同宽 + butt 端帽, 段间缝隙由
   segDash 的 dash 参数管, 不用 stroke 间距). 默认 origin = 单环 26px;
   四环 34 / 弹窗大圈 76 走配套类覆盖 origin + 线宽. */
.hgr-seg-arc {
  fill: none;
  stroke-width: 3;
  stroke-linecap: butt;
  transform: rotate(-90deg);
  transform-origin: 13px 13px;
  transition: stroke-dasharray 0.4s, stroke-dashoffset 0.4s;
}
.hgr-seg-arc-q {
  transform-origin: 17px 17px;
}
.hgr-gauge .hgr-seg-arc {
  stroke-width: 7;
  transform-origin: 38px 38px;
}
.hgr-panel {
  position: fixed;
  z-index: 80; /* header (70) 之上, 与 AccountSwitcher dropdown 同层逻辑 */
  display: flex;
  flex-wrap: wrap; /* 4 环一行, 形态切换行 .hgr-foot 换行居底 */
  gap: 8px;
  /* 396 = 4×86 环 + 3×8 间距 + 20 padding + 8 余量; 372 时内容区只有 352,
     第 4 个环被 flex-wrap 折行 (damo 1011 实证「有一个被挤到底下」).
     H5 钳到 vw-16 (recomputePosition 同步), 四环 wrap 成 2×2. */
  width: min(396px, calc(100vw - 16px));
  padding: 12px 10px 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}
.hgr-gauge {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 86px;
}
.hgr-gauge svg {
  display: block;
}
.hgr-gauge .hgr-track {
  stroke-width: 7;
}
.hgr-gauge .hgr-arc {
  stroke-width: 7;
  transform: rotate(-90deg);
  transform-origin: 38px 38px;
  transition: stroke-dasharray 0.4s;
}
.hgr-num {
  position: absolute;
  top: 29px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.hgr-label {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text);
}
.hgr-detail {
  margin-top: 1px;
  font-size: 10px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 窄屏强制替身 (damo 1026): ≤350px 四环/横条藏、渲染单环替身 — 由 script 的
   matchMedia('(max-width: 350px)') 驱动 (isNarrow), 不再用 CSS @media 硬切
   (JS 侧还要据此切 popover「环内」选项行, 两处口径必须同源). */
</style>
