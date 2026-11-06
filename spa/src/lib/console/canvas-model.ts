/* 功能: 任务画布总控制台 (R177) 的纯逻辑层 — 把 tasks + requirements 行流
   分区 (近期聚焦/等我处理/排队/归档) + 派生紧急×重要坐标 + 四象限归类 +
   顶部指标聚合. 不依赖 Vue / api 层 (入参用本地结构类型), 供
   ConsoleCanvas.vue 适配后调用, 单测直接跑 node 环境.

   关注点:
   - 紧急度是派生启发式 (waiting > running > paused > queued > 按 age 衰减),
     不是字段 — P3 若 requirements/tasks 加显式 urgency 字段, 只改
     deriveUrgency 一个函数, 分区/象限逻辑不动.
   - importance 归一化假设 priority 值域 0-3 (DB 无 CHECK, 高值容错 clamp).
   - bucketTask 的优先级: awaiting_owner_review > status 终态判定, 即
     reviewing/await_user 但同时标了 owner review 的任务归 "等我处理".
   - 时区: updatedAt 用 Date.parse, 非法/缺省值按 age=0 处理 (不抛错,
     画布缺数据降级显示, 与 Requirements.vue 芯片静默兜底同款).
   - i18n (W4.5b): 用户可见 label (四象限名 / headline) 走 locale — 非 setup
     环境用 i18n.global; 单测默认 locale zh-CN, zh 文案与原硬编码一致. */
import { i18n } from '@/i18n';

/** 画布四区 (F2): focus=近期聚焦 / waiting=等我处理 / queued=排队 / archive=归档. */
export type CanvasZone = 'focus' | 'waiting' | 'queued' | 'archive';

/** 四象限 key (F3): q1=紧急且重要 / q2=重要不紧急 / q3=紧急不重要 / q4=其他. */
export type QuadrantKey = 'q1' | 'q2' | 'q3' | 'q4';

/** i18n (W4.5b): 值为 locale key (misc.console.quadrant.*), 渲染走 t(). */
export const QUADRANT_LABELS: Record<QuadrantKey, string> = {
  q1: 'misc.console.quadrant.q1',
  q2: 'misc.console.quadrant.q2',
  q3: 'misc.console.quadrant.q3',
  q4: 'misc.console.quadrant.q4',
};

/** 活跃 task status (R177 分区依据; 终态 = completed/failed/rejected/cancelled). */
export const TERMINAL_TASK_STATUSES = [
  'completed',
  'failed',
  'rejected',
  'cancelled',
] as const;

/** requirement 开放态 = 还没结案 (done/closed 之外). */
export const TERMINAL_REQUIREMENT_STATUSES = ['done', 'closed'] as const;

/** 未完结且需要 damo 介入的 requirement 状态 (O 列四态对齐). */
export const WAITING_REQUIREMENT_STATUSES = [
  'awaiting_reply',
  'has_suggestion',
  'blocked',
] as const;

/** task 输入 (视图层从 /api/tasks 行适配; 字段可选防脏数据). */
export interface CanvasTaskInput {
  id: string;
  title: string;
  status: string;
  priority?: number | null;
  /** ISO 时间串; 缺省按 "刚刚" 处理. */
  updatedAt?: string | null;
  requirementId?: string | null;
  awaitingOwnerReview?: boolean | null;
}

/** requirement 输入 (视图层从 /api/requirements items 适配). */
export interface CanvasRequirementInput {
  id: string;
  title: string;
  status: string;
  priority?: number | null;
  updatedAt?: string | null;
}

/** 四象限节点: 一个开放需求点 (聚合其挂载任务) 或一个无主的活跃任务. */
export interface QuadrantNode {
  kind: 'requirement' | 'task';
  id: string;
  title: string;
  /** 0-1, x 轴 (越右越紧急). */
  urgency: number;
  /** 0-1, y 轴 (越上越重要). */
  importance: number;
  quadrant: QuadrantKey;
  /** kind=requirement 时 = 其下非终态 task 数. */
  activeTaskCount: number;
  status: string;
  /** R191: 最后更新时间 (ISO 串透传, 视图 tooltip 用). */
  updatedAt?: string | null;
}

export interface CanvasZoneStat {
  focus: number;
  waiting: number;
  queued: number;
  archived: number;
  openRequirements: number;
}

export interface CanvasModel {
  stats: CanvasZoneStat;
  /** 近期聚焦 (running/verifying 按 updatedAt 倒序, 截前 focusLimit 条). */
  focusTasks: CanvasTaskInput[];
  /** 等我处理: task (await_user/reviewing/paused/owner_review) + requirement
   *  (awaiting_reply/has_suggestion/blocked), 各按 updatedAt 倒序. */
  waitingTasks: CanvasTaskInput[];
  waitingRequirements: CanvasRequirementInput[];
  queuedTasks: CanvasTaskInput[];
  quadrantNodes: QuadrantNode[];
  /** 顶部一句话状态 (F5 文案规范: 动词短语, 不长篇). */
  headline: string;
}

const FOCUS_STATUSES = new Set(['running', 'verifying']);
const WAITING_TASK_STATUSES = new Set([
  'await_user',
  'reviewing',
  'paused',
]);
const QUEUED_TASK_STATUSES = new Set(['pending', 'queued']);

/** task → 四区. awaiting_owner_review 最优先 (即使 running 也算等我拍板). */
export function bucketTask(task: CanvasTaskInput): CanvasZone {
  if (TERMINAL_TASK_STATUSES.includes(task.status as any)) return 'archive';
  if (task.awaitingOwnerReview) return 'waiting';
  if (WAITING_TASK_STATUSES.has(task.status)) return 'waiting';
  if (FOCUS_STATUSES.has(task.status)) return 'focus';
  if (QUEUED_TASK_STATUSES.has(task.status)) return 'queued';
  // 未知开放态 (未来新增 status) 兜底归聚焦, 宁可多显示不漏显示.
  return 'focus';
}

/** requirement → 开放与否 + 是否等我. */
export function bucketRequirementOpen(req: CanvasRequirementInput): boolean {
  return !TERMINAL_REQUIREMENT_STATUSES.includes(req.status as any);
}

export function isWaitingRequirement(req: CanvasRequirementInput): boolean {
  return (WAITING_REQUIREMENT_STATUSES as readonly string[]).includes(
    req.status,
  );
}

function parseAgeDays(updatedAt: string | null | undefined, now: number): number {
  if (!updatedAt) return 0;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / 86_400_000);
}

/**
 * task 紧急度 (x 轴, 0-1): 等拍板 1.0 > 跑着 0.7 > 暂停 0.5 > 排队 0.35 >
 * 其余按 age 衰减 (7 天饱和到 0.6, 下限 0.15).
 * 与 requirement 版拆开 (两类型都有 status, 结构分派不可靠 — 单测实证踩过).
 */
export function deriveUrgency(
  input: CanvasTaskInput,
  now: number,
): number {
  const ageBased = ageBasedUrgency(input.updatedAt, now);
  if (input.awaitingOwnerReview) return 1;
  if (WAITING_TASK_STATUSES.has(input.status)) {
    return input.status === 'paused' ? 0.5 : 1;
  }
  if (FOCUS_STATUSES.has(input.status)) return 0.7;
  if (QUEUED_TASK_STATUSES.has(input.status)) return 0.35;
  return ageBased;
}

/** requirement 紧急度: 等回复/有建议/卡住 = 1.0, 其余 age 衰减. */
export function deriveRequirementUrgency(
  input: CanvasRequirementInput,
  now: number,
): number {
  if (isWaitingRequirement(input)) return 1;
  return ageBasedUrgency(input.updatedAt, now);
}

function ageBasedUrgency(
  updatedAt: string | null | undefined,
  now: number,
): number {
  const age = parseAgeDays(updatedAt, now);
  return Math.min(0.6, 0.15 + (age / 7) * 0.45);
}

/** 重要度 (y 轴, 0-1): priority (0-3+) 归一化, 缺省 1 → 0.33. */
export function deriveImportance(priority: number | null | undefined): number {
  const p = typeof priority === 'number' && Number.isFinite(priority)
    ? priority
    : 1;
  return Math.max(0.15, Math.min(1, p / 3));
}

/** 紧急/重要双阈值 → 象限. 阈值取 0.6/0.55 (排队 0.35 落 "少操心", 合理). */
export function classifyQuadrant(
  urgency: number,
  importance: number,
): QuadrantKey {
  const urgent = urgency >= 0.6;
  const important = importance >= 0.55;
  if (urgent && important) return 'q1';
  if (!urgent && important) return 'q2';
  if (urgent && !important) return 'q3';
  return 'q4';
}

const FOCUS_LIMIT = 8;

/**
 * 主入口: tasks + requirements 全量行 → 画布模型. 纯函数 (now 注入可测).
 * quadrantNodes = 开放 requirement 节点 (聚合挂载活跃 task) + 不挂开放
 * requirement 的非终态 task 节点 (任务树 F7 的 P1 形态: 需求点为父节点).
 */
export function buildCanvasModel(
  tasks: CanvasTaskInput[],
  requirements: CanvasRequirementInput[],
  now: number = Date.now(),
): CanvasModel {
  const openReqs = requirements.filter(bucketRequirementOpen);
  const openReqById = new Map(openReqs.map((r) => [r.id, r]));

  const focusTasks: CanvasTaskInput[] = [];
  const waitingTasks: CanvasTaskInput[] = [];
  const queuedTasks: CanvasTaskInput[] = [];
  let archived = 0;
  /** requirementId → 活跃 task 数 (给象限节点用). */
  const activeTaskCountByReq = new Map<string, number>();

  for (const t of tasks) {
    const zone = bucketTask(t);
    if (zone === 'archive') {
      archived += 1;
      continue;
    }
    if (t.requirementId && openReqById.has(t.requirementId)) {
      activeTaskCountByReq.set(
        t.requirementId,
        (activeTaskCountByReq.get(t.requirementId) ?? 0) + 1,
      );
    }
    if (zone === 'focus') focusTasks.push(t);
    else if (zone === 'waiting') waitingTasks.push(t);
    else queuedTasks.push(t);
  }

  const byUpdatedDesc = (
    a: { updatedAt?: string | null },
    b: { updatedAt?: string | null },
  ) =>
    (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0);
  focusTasks.sort(byUpdatedDesc);
  waitingTasks.sort(byUpdatedDesc);
  queuedTasks.sort(byUpdatedDesc);
  const waitingRequirements = openReqs
    .filter(isWaitingRequirement)
    .sort(byUpdatedDesc);

  const quadrantNodes: QuadrantNode[] = [];
  for (const r of openReqs) {
    const urgency = deriveRequirementUrgency(r, now);
    const importance = deriveImportance(r.priority);
    quadrantNodes.push({
      kind: 'requirement',
      id: r.id,
      title: r.title,
      urgency,
      importance,
      quadrant: classifyQuadrant(urgency, importance),
      activeTaskCount: activeTaskCountByReq.get(r.id) ?? 0,
      status: r.status,
      updatedAt: r.updatedAt ?? null,
    });
  }
  for (const t of tasks) {
    if (bucketTask(t) === 'archive') continue;
    if (t.requirementId && openReqById.has(t.requirementId)) continue;
    const urgency = deriveUrgency(t, now);
    const importance = deriveImportance(t.priority);
    quadrantNodes.push({
      kind: 'task',
      id: t.id,
      title: t.title,
      urgency,
      importance,
      quadrant: classifyQuadrant(urgency, importance),
      activeTaskCount: 0,
      status: t.status,
      updatedAt: t.updatedAt ?? null,
    });
  }

  const stats: CanvasZoneStat = {
    focus: focusTasks.length,
    waiting: waitingTasks.length + waitingRequirements.length,
    queued: queuedTasks.length,
    archived,
    openRequirements: openReqs.length,
  };

  return {
    stats,
    focusTasks: focusTasks.slice(0, FOCUS_LIMIT),
    waitingTasks,
    waitingRequirements,
    queuedTasks,
    quadrantNodes,
    headline: buildHeadline(stats),
  };
}

/** 顶部一句话 (F5): ≤24 字动词短语; 全空 = 「全部清空, 喝口水」.
    i18n (W4.5b): 文案走 locale (zh 文案与原硬编码一致, 单测不破). */
export function buildHeadline(stats: CanvasZoneStat): string {
  const parts: string[] = [];
  if (stats.focus) parts.push(i18n.global.t('misc.console.headlineFocus', { n: stats.focus }));
  if (stats.waiting) parts.push(i18n.global.t('misc.console.headlineWaiting', { n: stats.waiting }));
  if (stats.queued) parts.push(i18n.global.t('misc.console.headlineQueued', { n: stats.queued }));
  if (!parts.length) return i18n.global.t('misc.console.headlineClear');
  return parts.join(' · ');
}
