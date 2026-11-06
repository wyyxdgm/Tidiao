// 功能: 主机资源环「任务分段」纯逻辑 (R237) — 把运行中任务的 CPU/内存占用
//       折算成环上的叠加弧段 (0-100 同口径, 依序累积).
// 关注点:
// - 排序按 taskId 字典序 — 固定顺序让颜色在两次采样间不跳变 (按值排序会
//   导致相邻两拍颜色互换, 视觉闪烁).
// - 超过 MAX 段合并为一枚中性色「其他 N 个」段, 防小环上颜色数爆炸.
// - value ≤ 0 的任务跳过 (画了也看不见); 累积超过 100 停止 (clamp).
export interface TaskResourceLike {
  pids: number[];
  hostCpuPercent: number;
  memPercent: number;
}

export interface TaskSeg {
  id: string;
  label: string;
  /** 占全机 % (0-100, 已 clamp). */
  value: number;
  /** 弧段起始位置 (百分点, 0 = 环顶). */
  start: number;
  color: string;
}

/** 任务弧段色 — 冷色近邻族 (蓝→天蓝→青→靛), 细微区分不刺眼 (damo 1011
    「不用五颜六色」). 超量合并段用中性灰蓝. */
export const SEG_COLORS = ['#2563eb', '#0ea5e9', '#14b8a6', '#818cf8', '#06b6d4', '#60a5fa'];
export const SEG_OVERFLOW_COLOR = '#94a3b8';

/** 最多单独画的段数; 之后的任务合并成一枚「其他」段. */
export const MAX_TASK_SEGS = 6;

export function buildTaskSegments(
  samples: Record<string, TaskResourceLike>,
  titles: Record<string, string>,
  pick: (s: TaskResourceLike) => number,
): TaskSeg[] {
  const entries = Object.entries(samples)
    .filter(([, s]) => s.pids.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const segs: TaskSeg[] = [];
  let acc = 0;
  let overflowValue = 0;
  let overflowCount = 0;
  for (const [id, s] of entries) {
    const v = Math.max(0, Math.min(100, pick(s)));
    if (v <= 0) continue;
    if (segs.length >= MAX_TASK_SEGS) {
      overflowValue += v;
      overflowCount++;
      continue;
    }
    segs.push({
      id,
      label: titles[id] || id.slice(0, 8),
      value: v,
      start: acc,
      color: SEG_COLORS[segs.length],
    });
    acc += v;
    if (acc >= 100) return segs;
  }
  if (overflowCount > 0) {
    segs.push({
      id: '__overflow__',
      label: `其他 ${overflowCount} 个`,
      value: Math.min(overflowValue, 100 - acc),
      start: acc,
      color: SEG_OVERFLOW_COLOR,
    });
  }
  return segs;
}

/** 弧段 dash 参数 — 与底环同路径同起点 (rotate -90°), dashoffset 前移到
    start 处; 段间留 GAP 个百分点缝隙, 长度下限保 0.2% 可见. */
const SEG_GAP_PCT = 0.6;

export function segDash(seg: TaskSeg, r: number): { dasharray: string; dashoffset: string } {
  const c = 2 * Math.PI * r;
  const len = Math.max(0.2, seg.value - SEG_GAP_PCT);
  const start = seg.start + SEG_GAP_PCT / 2;
  return {
    dasharray: `${(len / 100) * c} ${c - (len / 100) * c}`,
    dashoffset: `${(-start / 100) * c}`,
  };
}
