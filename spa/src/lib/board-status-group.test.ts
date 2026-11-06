// board-status-group.ts 单元测试 (R248). 运行环境 = node, 无 jsdom — 镜像
// board-mode.test.ts 手动 stub localStorage 后动态 import (模块级缓存在 import
// 时初始化).
import { describe, it, expect, beforeEach, vi } from 'vitest';

function stubStorage(stored?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(stored ?? {}));
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
  return store;
}

function stubBrokenStorage() {
  (globalThis as any).localStorage = {
    getItem: () => {
      throw new Error('unavailable');
    },
    setItem: () => {
      throw new Error('unavailable');
    },
    removeItem: () => {
      throw new Error('unavailable');
    },
  };
}

async function load() {
  vi.resetModules();
  return await import('./board-status-group');
}

beforeEach(() => {
  delete (globalThis as any).localStorage;
});

describe('R248 board status group persistence', () => {
  it('无记忆 → readBoardStatusGroup() = null (调用方回落缺省 all)', async () => {
    stubStorage();
    const m = await load();
    expect(m.readBoardStatusGroup('k1')).toBeNull();
  });

  it("记忆 'terminal' → 读回 'terminal'", async () => {
    stubStorage({ k1: 'terminal' });
    const m = await load();
    expect(m.readBoardStatusGroup('k1')).toBe('terminal');
  });

  it('记忆值非法 → 当作无记忆 (null), 不回落成野值', async () => {
    stubStorage({ k1: 'bogus' });
    const m = await load();
    expect(m.readBoardStatusGroup('k1')).toBeNull();
  });

  it("writeBoardStatusGroup 写内存 + localStorage ('all' 也合法)", async () => {
    const store = stubStorage();
    const m = await load();
    m.writeBoardStatusGroup('k1', 'all');
    expect(m.readBoardStatusGroup('k1')).toBe('all');
    expect(store.get('k1')).toBe('all');
  });

  it('多 key 隔离 — scope 与 account 互不串', async () => {
    stubStorage();
    const m = await load();
    m.writeBoardStatusGroup('k-scope', 'active');
    m.writeBoardStatusGroup('k-account', 'terminal');
    expect(m.readBoardStatusGroup('k-scope')).toBe('active');
    expect(m.readBoardStatusGroup('k-account')).toBe('terminal');
  });

  it('写后重新 import (模拟刷新) 仍能读回', async () => {
    stubStorage();
    const m1 = await load();
    m1.writeBoardStatusGroup('k1', 'terminal');
    const m2 = await load();
    expect(m2.readBoardStatusGroup('k1')).toBe('terminal');
  });

  it('localStorage 不可用 → 读 null, 写静默降级 (会话内存仍生效)', async () => {
    stubBrokenStorage();
    const m = await load();
    expect(m.readBoardStatusGroup('k1')).toBeNull();
    m.writeBoardStatusGroup('k1', 'all');
    expect(m.readBoardStatusGroup('k1')).toBe('all');
  });
});
