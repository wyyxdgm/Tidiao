import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCardSummary, warmCardSummaryForTask } from './card-summary-store';
import type { Task } from '../db/tasks';

/* 1007 卡片摘要两级来源单测: ensureCardSummary 顺序 (pending 闸 → cache → LLM)
   + 同任务进程内去重 + warm 入口永不 throw */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    result: 'x'.repeat(500),
    metadata: null,
    ...overrides,
  } as Task;
}

vi.mock('../db/tasks', () => ({
  getTaskById: vi.fn(),
  mutateTaskMetadata: vi.fn((id, fn) => {
    fn({});
    return true;
  }),
}));
vi.mock('./card-summary-llm', () => ({
  generateCardSummary: vi.fn(),
}));

import { getTaskById, mutateTaskMetadata } from '../db/tasks';
import { generateCardSummary } from './card-summary-llm';

describe('ensureCardSummary 两级顺序', () => {
  beforeEach(() => {
    vi.mocked(generateCardSummary).mockReset();
    vi.mocked(mutateTaskMetadata).mockClear();
  });

  it('result 为空 (非终态) → source:pending, 不调 LLM 不写缓存 (迭代 9 闸门)', async () => {
    const t = task({ result: null });
    const r = await ensureCardSummary(t);
    expect(r.source).toBe('pending');
    expect(r.summary).toBeNull();
    expect(generateCardSummary).not.toHaveBeenCalled();
    expect(mutateTaskMetadata).not.toHaveBeenCalled();
  });

  it('缓存命中直接返回, 不调 LLM', async () => {
    const t = task({
      metadata: JSON.stringify({
        card_summary_v6: { what: '干啥缓存', why: '有啥用缓存', result_len: 500, at: '' },
      }),
    });
    const r = await ensureCardSummary(t);
    expect(r.source).toBe('cache');
    expect(r.summary?.why).toBe('有啥用缓存');
    expect(generateCardSummary).not.toHaveBeenCalled();
  });

  it('result_len 与当前 result 不匹配 (任务重跑过) → 缓存判废重算 (1010 对齐 layers 防陈旧口径)', async () => {
    vi.mocked(generateCardSummary).mockResolvedValue({
      summary: { what: '新干啥', why: '新有啥用' },
      model: 'm',
    });
    const t = task({
      metadata: JSON.stringify({
        card_summary_v6: { what: '旧干啥', why: '旧有啥用', result_len: 499, at: '' },
      }),
    });
    const r = await ensureCardSummary(t);
    expect(r.source).toBe('llm');
    expect(r.summary?.what).toBe('新干啥');
    expect(generateCardSummary).toHaveBeenCalledTimes(1);
  });

  it('旧 v5 缓存 (无 result_len 字段) → 一律判废重算 (v6 bump)', async () => {
    vi.mocked(generateCardSummary).mockResolvedValue({
      summary: { what: '新干啥', why: '新有啥用' },
      model: 'm',
    });
    const t = task({
      metadata: JSON.stringify({
        card_summary_v5: { what: 'v5干啥', why: 'v5有啥用', at: '' },
      }),
    });
    const r = await ensureCardSummary(t);
    expect(r.source).toBe('llm');
    expect(r.summary?.what).toBe('新干啥');
  });

  it('LLM 成功 → 写缓存返回', async () => {
    vi.mocked(generateCardSummary).mockResolvedValue({
      summary: { what: '新干啥', why: '新有啥用' },
      model: 'm',
    });
    const r = await ensureCardSummary(task());
    expect(r.source).toBe('llm');
    expect(r.summary?.what).toBe('新干啥');
    expect(mutateTaskMetadata).toHaveBeenCalledWith('t1', expect.any(Function));
  });

  it('LLM 失败 → source:failed 不写缓存', async () => {
    vi.mocked(generateCardSummary).mockResolvedValue({ summary: null, model: 'm' });
    const r = await ensureCardSummary(task());
    expect(r.source).toBe('failed');
    expect(r.summary).toBeNull();
    expect(mutateTaskMetadata).not.toHaveBeenCalled();
  });

  it('同任务并发调用进程内去重 (只跑一次 LLM)', async () => {
    vi.mocked(generateCardSummary).mockResolvedValue({
      summary: { what: '干啥', why: '有啥用' },
      model: 'm',
    });
    const t = task();
    const [a, b] = await Promise.all([ensureCardSummary(t), ensureCardSummary(t)]);
    expect(a.source).toBe('llm');
    expect(b.source).toBe('llm');
    expect(generateCardSummary).toHaveBeenCalledTimes(1);
  });

  it('warm 入口: 任务不存在 / getTaskById throw 都不向外抛', async () => {
    vi.mocked(getTaskById).mockReturnValue(null as never);
    expect(() => warmCardSummaryForTask('nope')).not.toThrow();
    vi.mocked(getTaskById).mockImplementation(() => {
      throw new Error('db down');
    });
    expect(() => warmCardSummaryForTask('t1')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // 让内部 async 吞掉异常
  });
});
