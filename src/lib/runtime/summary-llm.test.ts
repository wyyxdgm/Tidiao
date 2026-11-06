import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../db/tasks';

/* R200 turn2: 统一 summary LLM 链单测 —
   1. resolveSummaryLlmChain: 系统配置 + fallback_ids → 任务链 → env, 去重/跳死跳
   2. runSummaryLlmTurn: 鉴权失败文本 / null 自动跳下一跳, 全链失败返 null */

vi.mock('../db/settings', () => ({
  getSetting: vi.fn(),
}));
vi.mock('../db/llm-configs', () => ({
  getLlmConfigById: vi.fn(),
  parseFallbackIds: vi.fn((raw: string | null) => {
    try {
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }),
  resolveLlmConfig: vi.fn(),
}));
vi.mock('../crypto', () => ({
  decrypt: vi.fn(() => 'decrypted-key'),
}));
vi.mock('./llm-summarize', () => ({
  runSingleTurnLlm: vi.fn(),
}));

import { getSetting } from '../db/settings';
import { getLlmConfigById, resolveLlmConfig } from '../db/llm-configs';
import { decrypt } from '../crypto';
import { runSingleTurnLlm } from './llm-summarize';
import { resolveSummaryLlmChain, runSummaryLlmTurn } from './summary-llm';

const getSettingMock = vi.mocked(getSetting);
const getLlmConfigByIdMock = vi.mocked(getLlmConfigById);
const resolveLlmConfigMock = vi.mocked(resolveLlmConfig);
const decryptMock = vi.mocked(decrypt);
const runSingleTurnLlmMock = vi.mocked(runSingleTurnLlm);

function task(): Task {
  return { id: 't1', model: 'task-model', owner_id: 'u1', project_id: 'p1' } as unknown as Task;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_MODEL;
});

describe('resolveSummaryLlmChain', () => {
  it('系统 summary 配置 + fallback_ids → 任务链 → env, 来源标注正确', () => {
    getSettingMock.mockReturnValue('cfg-a');
    getLlmConfigByIdMock.mockImplementation((id: string) => {
      if (id === 'cfg-a') return { id, model: 'glm-5.3-flash', base_url: 'https://bigmodel/x', api_key_encrypted: 'e', api_key_iv: 'i', api_key_tag: 't', fallback_ids: JSON.stringify(['cfg-b']) } as never;
      if (id === 'cfg-b') return { id, model: 'glm-air', base_url: 'https://bigmodel/x', api_key_encrypted: 'e2', api_key_iv: 'i2', api_key_tag: 't2', fallback_ids: null } as never;
      return null;
    });
    resolveLlmConfigMock.mockReturnValue({ model: 'task-model', api_key: 'tk', base_url: 'https://task/x' } as never);

    const chain = resolveSummaryLlmChain(task());
    expect(chain).toHaveLength(4);
    expect(chain[0]).toMatchObject({ model: 'glm-5.3-flash', source: 'summary_config' });
    expect(chain[1]?.source).toContain('fallback:');
    expect(chain[1]).toMatchObject({ model: 'glm-air' });
    expect(chain[2]).toMatchObject({ model: 'task-model', source: 'task_chain' });
    expect(chain[3]).toMatchObject({ source: 'env' });
    // 解密已发生 (summary 配置的 key)
    expect(decryptMock).toHaveBeenCalled();
  });

  it('summary 配置被删 / 键缺失 → 跳过该层, 链仍含 task_chain + env', () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'task-model' } as never);
    // env 配 distinct key/base, 否则与 task_chain 同 model+key+base 会被去重掉
    process.env.ANTHROPIC_API_KEY = 'env-key';
    process.env.ANTHROPIC_BASE_URL = 'https://env.example';
    const chain = resolveSummaryLlmChain(task());
    expect(chain.map((e) => e.source)).toEqual(['task_chain', 'env']);
  });

  it('同 model+key+base 去重 (任务链与 env 相同配置只留一跳)', () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'm1', api_key: 'k', base_url: 'https://x' } as never);
    process.env.ANTHROPIC_API_KEY = 'k';
    process.env.ANTHROPIC_BASE_URL = 'https://x';
    delete process.env.ANTHROPIC_MODEL;
    const chain = resolveSummaryLlmChain(task());
    // env 跳 model 为空 (非 bigmodel) → 被 filter; 即便相同, task_chain 也只一条 m1
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ model: 'm1', source: 'task_chain' });
  });

  it('bigmodel base → env 兜底模型名映射 glm-5.3', () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'glm-5.3' } as never);
    process.env.ANTHROPIC_API_KEY = 'k';
    process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
    const chain = resolveSummaryLlmChain(task());
    // task_chain 与 env (glm-5.3, 同 base? 不同 key) — env 跳保留 glm-5.3
    expect(chain.some((e) => e.source === 'env' && e.model === 'glm-5.3')).toBe(true);
  });
});

describe('runSummaryLlmTurn', () => {
  it('鉴权失败文本 → 自动跳下一跳, 下一跳成功即返回', async () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'dead-model', api_key: 'dead' } as never);
    process.env.ANTHROPIC_API_KEY = 'ok';
    runSingleTurnLlmMock
      .mockResolvedValueOnce('Failed to authenticate API key: 401')
      .mockResolvedValueOnce('好的输出');
    const { raw, model } = await runSummaryLlmTurn('sys', 'user', task());
    expect(raw).toBe('好的输出');
    expect(runSingleTurnLlmMock).toHaveBeenCalledTimes(2);
    // 第二跳用 env key + env 模型 (chain[1].model 由 env 决定, 这里无 base → task 模型)
    expect(model).toBeTruthy();
  });

  it('1007: 「Not logged in」失败文本 (配额死形态) → 同样跳下一跳, 不当合法输出', async () => {
    // ao-prod 实证: ark 配置月配额爆掉 (AccountQuotaExceeded) 时 SDK 吐
    // 「Not logged in · Please run /login」—— 旧正则不认 → 链停在死跳, 全站 summary 失败.
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'dead-model', api_key: 'dead' } as never);
    process.env.ANTHROPIC_API_KEY = 'ok';
    runSingleTurnLlmMock
      .mockResolvedValueOnce('Not logged in · Please run /login')
      .mockResolvedValueOnce('好的输出');
    const { raw } = await runSummaryLlmTurn('sys', 'user', task());
    expect(raw).toBe('好的输出');
    expect(runSingleTurnLlmMock).toHaveBeenCalledTimes(2);
  });

  it('每跳 env 覆盖带 AUTH_TOKEN:undefined (剔除残留占位, 与任务主路径对齐)', async () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'm', api_key: 'k' } as never);
    runSingleTurnLlmMock.mockResolvedValue('ok');
    await runSummaryLlmTurn('sys', 'user', task());
    const envArg = runSingleTurnLlmMock.mock.calls[0][3] as Record<string, string | undefined>;
    expect(envArg.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect('ANTHROPIC_AUTH_TOKEN' in envArg).toBe(true);
  });

  it('null 返回 (SDK 异常) → 跳下一跳; 全链失败 → raw=null', async () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'm' } as never);
    runSingleTurnLlmMock.mockResolvedValue(null);
    const { raw } = await runSummaryLlmTurn('sys', 'user', task());
    expect(raw).toBeNull();
  });

  it('systemPrompt 拼进 prompt (runSingleTurnLlm 第二参)', async () => {
    getSettingMock.mockReturnValue('');
    resolveLlmConfigMock.mockReturnValue({ model: 'm' } as never);
    runSingleTurnLlmMock.mockResolvedValue('ok');
    await runSummaryLlmTurn('SYSTEM-部分', 'USER-部分', task());
    const promptArg = runSingleTurnLlmMock.mock.calls[0][1] as string;
    expect(promptArg).toContain('SYSTEM-部分');
    expect(promptArg).toContain('USER-部分');
    // 每跳强制模型名跟配置走
    const modelArg = runSingleTurnLlmMock.mock.calls[0][2] as string;
    expect(modelArg).toBe('m');
  });
});
