// board-mode.ts 单元测试 (R235). 运行环境 = node, 无 jsdom — 仿 theme.test.ts
// 自行 stub localStorage 后动态 import (模块级初始化在 import 时读 localStorage).
import { describe, it, expect, beforeEach, vi } from 'vitest';

function stubStorage(stored?: string) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('ao_global_mode', stored);
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
  return await import('./board-mode');
}

beforeEach(() => {
  delete (globalThis as any).localStorage;
});

describe('R235 global board mode persistence', () => {
  it('无缓存 → readGlobalBoardMode() = null (回落 viewport 缺省)', async () => {
    stubStorage();
    const m = await load();
    expect(m.readGlobalBoardMode()).toBeNull();
  });

  it("缓存 'list' → 读回 'list'", async () => {
    stubStorage('list');
    const m = await load();
    expect(m.readGlobalBoardMode()).toBe('list');
  });

  it('缓存值非法 → 当作无缓存 (null), 不回落成野值', async () => {
    stubStorage('bogus');
    const m = await load();
    expect(m.readGlobalBoardMode()).toBeNull();
  });

  it('writeGlobalBoardMode 写内存 + localStorage', async () => {
    const store = stubStorage();
    const m = await load();
    m.writeGlobalBoardMode('grouped');
    expect(m.readGlobalBoardMode()).toBe('grouped');
    expect(store.get('ao_global_mode')).toBe('grouped');
  });

  it('写后重新 import (模拟刷新) 仍能读回', async () => {
    stubStorage();
    const m1 = await load();
    m1.writeGlobalBoardMode('cards');
    const m2 = await load();
    expect(m2.readGlobalBoardMode()).toBe('cards');
  });

  it('localStorage 不可用 → 读 null, 写静默降级 (会话内存仍生效)', async () => {
    stubBrokenStorage();
    const m = await load();
    expect(m.readGlobalBoardMode()).toBeNull();
    m.writeGlobalBoardMode('kanban');
    expect(m.readGlobalBoardMode()).toBe('kanban');
  });
});
