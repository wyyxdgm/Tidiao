import { describe, expect, it } from 'vitest';
import {
  buildTaskSegments,
  MAX_TASK_SEGS,
  segDash,
  SEG_COLORS,
  SEG_OVERFLOW_COLOR,
  type TaskResourceLike,
} from './host-task-segments';

function sample(partial: Partial<TaskResourceLike>): TaskResourceLike {
  return { pids: [1], hostCpuPercent: 0, memPercent: 0, ...partial };
}

describe('buildTaskSegments', () => {
  it('无运行中任务 → 空段', () => {
    expect(buildTaskSegments({ a: sample({ pids: [] , hostCpuPercent: 50 }) }, {}, (s) => s.hostCpuPercent)).toEqual([]);
    expect(buildTaskSegments({}, {}, (s) => s.hostCpuPercent)).toEqual([]);
  });

  it('值为 0 的任务跳过', () => {
    const segs = buildTaskSegments(
      { a: sample({ hostCpuPercent: 0 }), b: sample({ hostCpuPercent: 10 }) },
      {},
      (s) => s.hostCpuPercent,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].id).toBe('b');
  });

  it('按 taskId 字典序累积 start, 颜色按序取', () => {
    const segs = buildTaskSegments(
      {
        b: sample({ hostCpuPercent: 20 }),
        a: sample({ hostCpuPercent: 10 }),
      },
      { a: '任务A', b: '任务B' },
      (s) => s.hostCpuPercent,
    );
    expect(segs.map((s) => s.id)).toEqual(['a', 'b']);
    expect(segs[0]).toMatchObject({ label: '任务A', value: 10, start: 0, color: SEG_COLORS[0] });
    expect(segs[1]).toMatchObject({ label: '任务B', value: 20, start: 10, color: SEG_COLORS[1] });
  });

  it('无 title 用 taskId 前 8 位', () => {
    const segs = buildTaskSegments(
      { 'abcdef12-3456': sample({ memPercent: 5 }) },
      {},
      (s) => s.memPercent,
    );
    expect(segs[0].label).toBe('abcdef12');
  });

  it(`超过 ${MAX_TASK_SEGS} 段合并为「其他 N 个」中性段`, () => {
    const samples: Record<string, TaskResourceLike> = {};
    for (let i = 0; i < MAX_TASK_SEGS + 2; i++) {
      samples[`t${i}`] = sample({ hostCpuPercent: 1 });
    }
    const segs = buildTaskSegments(samples, {}, (s) => s.hostCpuPercent);
    expect(segs).toHaveLength(MAX_TASK_SEGS + 1);
    const last = segs[segs.length - 1];
    expect(last).toMatchObject({ id: '__overflow__', label: '其他 2 个', value: 2, color: SEG_OVERFLOW_COLOR });
    expect(last.start).toBe(MAX_TASK_SEGS * 1);
  });

  it('累积超 100 提前截断', () => {
    const segs = buildTaskSegments(
      {
        a: sample({ hostCpuPercent: 80 }),
        b: sample({ hostCpuPercent: 50 }),
        c: sample({ hostCpuPercent: 50 }),
      },
      {},
      (s) => s.hostCpuPercent,
    );
    expect(segs.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('value clamp 到 0-100', () => {
    const segs = buildTaskSegments(
      { a: sample({ hostCpuPercent: 250 }) },
      {},
      (s) => s.hostCpuPercent,
    );
    expect(segs[0].value).toBe(100);
  });
});

describe('segDash', () => {
  const r = 32;
  const c = 2 * Math.PI * r;

  it('dash 长度 = value% 周长减缝隙, offset 前移到 start', () => {
    const { dasharray, dashoffset } = segDash({ id: 'x', label: '', value: 10, start: 20, color: '' }, r);
    const len = ((10 - 0.6) / 100) * c;
    expect(dasharray).toBe(`${len} ${c - len}`);
    expect(dashoffset).toBe(`${(-(20 + 0.3) / 100) * c}`);
  });

  it('value 低于缝隙时长 度兜底 0.2%', () => {
    const { dasharray } = segDash({ id: 'x', label: '', value: 0.1, start: 0, color: '' }, r);
    expect(dasharray.startsWith(`${(0.2 / 100) * c} `)).toBe(true);
  });
});
