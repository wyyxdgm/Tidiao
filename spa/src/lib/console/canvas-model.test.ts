/* 功能: canvas-model 纯逻辑单测 — 分区 / 象限派生 / 聚合 / 文案.
   关注点: 全部纯函数 + now 注入, 不 mock fetch / DB. */

import { describe, expect, it } from 'vitest';
import {
  buildCanvasModel,
  buildHeadline,
  bucketTask,
  classifyQuadrant,
  deriveImportance,
  deriveRequirementUrgency,
  deriveUrgency,
  type CanvasRequirementInput,
  type CanvasTaskInput,
} from './canvas-model';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const daysAgo = (d: number) =>
  new Date(NOW - d * 86_400_000).toISOString();

const task = (over: Partial<CanvasTaskInput>): CanvasTaskInput => ({
  id: 't1',
  title: 'T',
  status: 'running',
  ...over,
});

describe('bucketTask', () => {
  it.each([
    ['running', 'focus'],
    ['verifying', 'focus'],
    ['queued', 'queued'],
    ['pending', 'queued'],
    ['await_user', 'waiting'],
    ['reviewing', 'waiting'],
    ['paused', 'waiting'],
    ['completed', 'archive'],
    ['cancelled', 'archive'],
  ] as const)('%s → %s', (status, zone) => {
    expect(bucketTask(task({ status }))).toBe(zone);
  });

  it('awaiting_owner_review 压过 running (等我拍板最优先)', () => {
    expect(
      bucketTask(task({ status: 'running', awaitingOwnerReview: true })),
    ).toBe('waiting');
  });

  it('未知开放态兜底 focus (多显示不漏显示)', () => {
    expect(bucketTask(task({ status: 'warp_speed' }))).toBe('focus');
  });
});

describe('deriveUrgency / deriveImportance', () => {
  it('等拍板 = 1.0, running = 0.7, paused = 0.5, queued = 0.35', () => {
    expect(deriveUrgency(task({ status: 'await_user' }), NOW)).toBe(1);
    expect(deriveUrgency(task({ status: 'running' }), NOW)).toBe(0.7);
    expect(deriveUrgency(task({ status: 'paused' }), NOW)).toBe(0.5);
    expect(deriveUrgency(task({ status: 'queued' }), NOW)).toBe(0.35);
  });

  it('无状态命中按 age 衰减: 7 天饱和 0.6', () => {
    expect(
      deriveRequirementUrgency(
        { id: 'r1', title: 'R', status: 'pending', updatedAt: daysAgo(7) },
        NOW,
      ),
    ).toBeCloseTo(0.6, 5);
  });

  it('awaiting_reply requirement = 1.0 (O 列四态对齐)', () => {
    expect(
      deriveRequirementUrgency(
        { id: 'r', title: 'R', status: 'awaiting_reply' },
        NOW,
      ),
    ).toBe(1);
  });

  it('importance: priority 3 → 1, 0 → 0.15 clamp, 缺省 1 → ~0.33', () => {
    expect(deriveImportance(3)).toBe(1);
    expect(deriveImportance(0)).toBe(0.15);
    expect(deriveImportance(null)).toBeCloseTo(0.3333, 3);
    expect(deriveImportance(99)).toBe(1);
  });
});

describe('classifyQuadrant', () => {
  it('四象限阈值 0.6 / 0.55', () => {
    expect(classifyQuadrant(1, 1)).toBe('q1');
    expect(classifyQuadrant(0.35, 1)).toBe('q2');
    expect(classifyQuadrant(1, 0.2)).toBe('q3');
    expect(classifyQuadrant(0.2, 0.2)).toBe('q4');
  });
});

describe('buildCanvasModel', () => {
  const tasks: CanvasTaskInput[] = [
    task({ id: 'a', status: 'running', updatedAt: daysAgo(0), requirementId: 'r1' }),
    task({ id: 'b', status: 'queued', updatedAt: daysAgo(1) }),
    task({ id: 'c', status: 'reviewing', updatedAt: daysAgo(2) }),
    task({ id: 'd', status: 'completed', updatedAt: daysAgo(3) }),
    task({ id: 'e', status: 'completed', updatedAt: daysAgo(4), requirementId: 'r1' }),
  ];
  const reqs: CanvasRequirementInput[] = [
    { id: 'r1', title: '画布', status: 'pending', priority: 3, updatedAt: daysAgo(0) },
    { id: 'r2', title: '等回复', status: 'awaiting_reply', priority: 1 },
    { id: 'r3', title: '已结案', status: 'done' },
  ];

  it('分区计数 + 归档只计数', () => {
    const m = buildCanvasModel(tasks, reqs, NOW);
    expect(m.stats.focus).toBe(1);
    expect(m.stats.queued).toBe(1);
    expect(m.stats.waiting).toBe(2); // reviewing task + awaiting_reply req
    expect(m.stats.archived).toBe(2);
    expect(m.stats.openRequirements).toBe(2);
  });

  it('象限节点: 开放 req 聚合活跃 task 数, 终态 task 不计入', () => {
    const m = buildCanvasModel(tasks, reqs, NOW);
    const r1 = m.quadrantNodes.find((n) => n.id === 'r1')!;
    expect(r1.kind).toBe('requirement');
    expect(r1.activeTaskCount).toBe(1); // running 挂 r1; completed 不算
    // r1 priority 3 → importance 1; pending 且 updated 刚刚 → age-based 低紧急
    expect(r1.importance).toBe(1);
    expect(r1.quadrant).toBe('q2');
  });

  it('无主活跃 task 独立成节点; 挂开放 req 的 task 不重复出现', () => {
    const m = buildCanvasModel(tasks, reqs, NOW);
    const ids = m.quadrantNodes.map((n) => n.id).sort();
    expect(ids).toEqual(['b', 'c', 'r1', 'r2']);
  });

  it('节点透传 updatedAt (R191 tooltip + R199 可见时间层, 缺失 = 看不出多老像插队)', () => {
    const m = buildCanvasModel(tasks, reqs, NOW);
    const r1 = m.quadrantNodes.find((n) => n.id === 'r1')!;
    expect(r1.updatedAt).toBe(daysAgo(0)); // requirement 节点
    const b = m.quadrantNodes.find((n) => n.id === 'b')!;
    expect(b.updatedAt).toBe(daysAgo(1)); // 无主 task 节点
    expect(m.quadrantNodes.find((n) => n.id === 'r2')!.updatedAt ?? null).toBeNull();
  });

  it('headline 反映分区 (F5 文案)', () => {
    const m = buildCanvasModel(tasks, reqs, NOW);
    expect(m.headline).toBe('1 个在跑 · 2 个等你 · 1 个排队');
    expect(buildHeadline({
      focus: 0, waiting: 0, queued: 0, archived: 0, openRequirements: 0,
    })).toBe('全部清空 · 喝口水');
  });
});
