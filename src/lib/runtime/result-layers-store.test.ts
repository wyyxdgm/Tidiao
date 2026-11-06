import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureResultLayers } from './result-layers-store';
import type { Task } from '../db/tasks';

/* R200 结果分层两级来源单测 (turn2: checkpoints 组装层撤除):
   ensureResultLayers 两级顺序 (cache → LLM) + 同任务进程内去重 */

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
vi.mock('./result-layers-llm', () => ({
  generateResultLayers: vi.fn(),
}));

import { getTaskById, mutateTaskMetadata } from '../db/tasks';
import { generateResultLayers } from './result-layers-llm';

describe('ensureResultLayers 两级顺序', () => {
  beforeEach(() => {
    vi.mocked(generateResultLayers).mockReset();
    vi.mocked(mutateTaskMetadata).mockClear();
  });

  it('缓存命中直接返回, 不调 LLM', async () => {
    const t = task({
      metadata: JSON.stringify({
        result_layers_v3: { brief: '缓存概览', details: ['a', 'b'], result_len: 500, at: '', src: 'llm' },
      }),
    });
    const r = await ensureResultLayers(t);
    expect(r.source).toBe('cache');
    expect(r.layers?.brief).toBe('缓存概览');
    expect(generateResultLayers).not.toHaveBeenCalled();
  });

  it('旧 checkpoints 源缓存 (src!=="llm") 视为无效 → 重走 LLM', async () => {
    const t = task({
      metadata: JSON.stringify({
        result_layers_v3: { brief: '旧', details: ['a', 'b'], result_len: 500, at: '', src: 'checkpoints' },
      }),
    });
    vi.mocked(generateResultLayers).mockResolvedValue({
      layers: { brief: '新概览', details: ['一', '二'], next: '' },
      model: 'm',
    });
    const r = await ensureResultLayers(t);
    expect(r.source).toBe('llm');
    expect(r.layers?.brief).toBe('新概览');
    expect(generateResultLayers).toHaveBeenCalledTimes(1);
  });

  it('缓存 result_len 不匹配 (任务重跑) → 失效, 走 LLM 并写回缓存', async () => {
    const t = task({
      metadata: JSON.stringify({
        result_layers_v3: { brief: '旧', details: ['a', 'b'], result_len: 999, at: '', src: 'llm' },
      }),
    });
    vi.mocked(generateResultLayers).mockResolvedValue({
      layers: { brief: '新概览', details: ['一', '二'], next: '' },
      model: 'm',
    });
    const r = await ensureResultLayers(t);
    expect(r.source).toBe('llm');
    expect(r.layers?.src).toBe('llm');
    const { mutateTaskMetadata } = await import('../db/tasks');
    expect(mutateTaskMetadata).toHaveBeenCalledWith('t1', expect.any(Function));
  });

  it('LLM 失败 → source:failed 不写缓存', async () => {
    vi.mocked(generateResultLayers).mockResolvedValue({ layers: null, model: 'm' });
    const t = task();
    const r = await ensureResultLayers(t);
    expect(r.source).toBe('failed');
    expect(r.layers).toBeNull();
    const { mutateTaskMetadata } = await import('../db/tasks');
    expect(mutateTaskMetadata).not.toHaveBeenCalled();
  });

  it('同任务并发调用进程内去重 (只跑一次 LLM)', async () => {
    vi.mocked(generateResultLayers).mockResolvedValue({
      layers: { brief: '概览', details: ['一', '二'], next: '' },
      model: 'm',
    });
    const t = task();
    const [a, b] = await Promise.all([ensureResultLayers(t), ensureResultLayers(t)]);
    expect(a.source).toBe('llm');
    expect(b.source).toBe('llm');
    expect(generateResultLayers).toHaveBeenCalledTimes(1);
  });
});
