// sessionStorage 快照缓存的契约 (R165 "点开就能直接看").
//
// 为什么这层要测: 快照是**绕过服务端直接渲染**的东西. 一旦它把脏数据/超限/
// 错 key 的内容放出去, 用户看到的是过期看板且没有任何报错. 三条红线:
//   1. 读侧对任何坏数据都必须降级成 miss (白屏比闪一下严重得多);
//   2. 超大条目不能写 —— sessionStorage 写失败是静默的, 塞爆了会让后面所有
//      快照都写不进去 (雪崩);
//   3. 命中要续命, 否则常用看板会被 LRU 第一个淘汰.
//
// 测试环境没有 jsdom, 这里手搓一个 Map 背书的 sessionStorage 替身 —— 正好把
// "写失败静默" 这条真实行为也逼出来 (替身可以模拟 quota 异常).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  saveSnapshot,
  readSnapshot,
  dropSnapshot,
  clearSnapshots,
} from './snapshot-cache';

class FakeStorage {
  map = new Map<string, string>();
  failNextSet = false;
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('QuotaExceededError');
    }
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

let store: FakeStorage;

beforeEach(() => {
  store = new FakeStorage();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = store;
});

afterEach(() => {
  delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  vi.useRealTimers();
});

describe('snapshot-cache: roundtrip', () => {
  it('returns what was saved, with its etag', () => {
    saveSnapshot('board:a', { items: [1, 2], total: 2 }, 'W/"x"');
    const hit = readSnapshot<{ items: number[]; total: number }>('board:a');
    expect(hit).not.toBeNull();
    expect(hit!.data.items).toEqual([1, 2]);
    expect(hit!.etag).toBe('W/"x"');
  });

  it('misses on an unknown key', () => {
    expect(readSnapshot('board:nope')).toBeNull();
  });

  it('namespaces keys so it cannot collide with app storage', () => {
    saveSnapshot('board:a', 1, null);
    expect([...store.map.keys()]).toEqual(['snapshot-v1:board:a']);
  });
});

describe('snapshot-cache: dirty data degrades to miss', () => {
  it('treats unparseable JSON as a miss and drops it', () => {
    store.setItem('snapshot-v1:board:a', '{not json');
    expect(readSnapshot('board:a')).toBeNull();
    expect(store.map.has('snapshot-v1:board:a')).toBe(false);
  });

  it('treats a JSON value with no data field as a miss', () => {
    store.setItem('snapshot-v1:board:a', '{"etag":"W/\\"x\\""}');
    expect(readSnapshot('board:a')).toBeNull();
  });

  it('survives a storage whose getItem throws', () => {
    const boom = {
      get length() {
        return 0;
      },
      key: () => null,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = boom;
    expect(readSnapshot('board:a')).toBeNull();
  });
});

describe('snapshot-cache: capacity', () => {
  it('refuses an oversized entry instead of writing it', () => {
    // 512KB 上限. 造一条 600KB 的 payload.
    saveSnapshot('board:huge', { blob: 'x'.repeat(600 * 1024) }, null);
    expect(store.map.has('snapshot-v1:board:huge')).toBe(false);
  });

  it('keeps at most 12 entries, evicting least-recently-used first', () => {
    for (let i = 0; i < 15; i++) {
      // 让 lastUsed 严格递增, 免得同毫秒写入时排序不稳定.
      vi.setSystemTime(new Date(1_700_000_000_000 + i * 1000));
      saveSnapshot(`board:${i}`, { i }, null);
    }
    const keys = [...store.map.keys()];
    expect(keys.length).toBeLessThanOrEqual(12);
    // 最老的 3 条被淘汰, 最近的留下.
    expect(store.map.has('snapshot-v1:board:0')).toBe(false);
    expect(store.map.has('snapshot-v1:board:14')).toBe(true);
  });

  it('reading an entry renews it so it survives the next eviction round', () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    saveSnapshot('board:hot', { hot: true }, null);
    for (let i = 0; i < 11; i++) {
      vi.setSystemTime(new Date(1_700_000_001_000 + i * 1000));
      saveSnapshot(`board:cold${i}`, { i }, null);
    }
    vi.setSystemTime(new Date(1_700_000_100_000));
    expect(readSnapshot('board:hot')).not.toBeNull(); // 续命
    vi.setSystemTime(new Date(1_700_000_200_000));
    saveSnapshot('board:newcomer', {}, null);

    expect(readSnapshot('board:hot')).not.toBeNull();
    expect(readSnapshot('board:newcomer')).not.toBeNull();
    // 没被读过的冷条目该被淘汰
    expect(readSnapshot('board:cold0')).toBeNull();
  });

  it('a failed write does not throw into the caller', () => {
    store.failNextSet = true;
    expect(() => saveSnapshot('board:a', { x: 1 }, null)).not.toThrow();
  });
});

describe('snapshot-cache: eviction', () => {
  it('dropSnapshot removes only the named key', () => {
    saveSnapshot('board:a', 1, null);
    saveSnapshot('board:b', 2, null);
    dropSnapshot('board:a');
    expect(readSnapshot('board:a')).toBeNull();
    expect(readSnapshot('board:b')).not.toBeNull();
  });

  it('clearSnapshots leaves foreign storage keys alone', () => {
    saveSnapshot('board:a', 1, null);
    store.setItem('tab-list-v1', '[]');
    clearSnapshots();
    expect(store.map.has('tab-list-v1')).toBe(true);
    expect(store.map.has('snapshot-v1:board:a')).toBe(false);
  });
});
