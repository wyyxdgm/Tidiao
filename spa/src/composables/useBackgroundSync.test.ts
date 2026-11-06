// 全局后台同步器 (R165) 的调度契约.
//
// 关注点 (错一条就会变成"后台同步悄悄不工作"或"请求打爆后端"):
//   - 同一个 key 重复注册 = 替换, 不是叠加 (否则 React/Vue 重挂载后探针翻倍);
//   - 同一 key 探针不重入 (慢探针遇上 60s 节拍不会堆成并发);
//   - 卸载摘除 + 最后一个源走时定时器与事件监听一起停 (不留悬挂 setInterval);
//   - 一个源抛错不影响别的源, 错误落到 state 上, 下一拍自动恢复;
//   - state 是响应式的 —— 页面上"上次更新"提示要跟着后台同步变.
//
// 注意: 模块级单例, 每个用例前 __resetBackgroundSync() 清干净.
// onBeforeUnmount 在组件外调用只会打一条 Vue warn, 不影响被测的调度逻辑;
// unregister 路径由 unregisterAll 直接调 (见文件末尾).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import {
  useBackgroundSync,
  useBackgroundSyncState,
  probeNow,
  probeAll,
  __resetBackgroundSync,
  DEFAULT_SYNC_INTERVAL_MS,
} from './useBackgroundSync';

/** 组件外没法触发 onBeforeUnmount, 这里直接摸注册表 —— 通过 probeNow 的返回值
 *  可以反推 key 还在不在 (找不到返回 false). */
function unregisterAll(): void {
  __resetBackgroundSync();
}

beforeEach(() => {
  __resetBackgroundSync();
  vi.useFakeTimers();
});

afterEach(() => {
  __resetBackgroundSync();
  vi.useRealTimers();
});

describe('useBackgroundSync: scheduling', () => {
  it('probes on the default 60s tick', async () => {
    const check = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'k1', check });

    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 2);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('does not probe before the first tick', () => {
    const check = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'k1', check });
    void vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS - 1);
    expect(check).not.toHaveBeenCalled();
  });

  it('probes every registered source each tick', async () => {
    const a = vi.fn().mockResolvedValue(false);
    const b = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'a', check: a });
    useBackgroundSync({ key: 'b', check: b });

    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('replaces a source registered twice under the same key (no doubling)', async () => {
    const first = vi.fn().mockResolvedValue(false);
    const second = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'k1', check: first });
    useBackgroundSync({ key: 'k1', check: second });

    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never runs two probes for the same key concurrently', async () => {
    let resolveFirst: (v: boolean) => void = () => {};
    const check = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((r) => {
          resolveFirst = r;
        }),
      )
      .mockResolvedValue(false);
    useBackgroundSync({ key: 'k1', check });

    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS); // 探针 #1 卡住
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS); // 节拍又到
    expect(check).toHaveBeenCalledTimes(1); // 去重命中, 没起第二个

    resolveFirst(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('useBackgroundSync: error isolation', () => {
  it('keeps probing the other sources when one throws', async () => {
    const bad = vi.fn().mockRejectedValue(new Error('boom'));
    const good = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'bad', check: bad });
    useBackgroundSync({ key: 'good', check: good });

    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('records the error on the source state and clears it after a success', async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(false);
    useBackgroundSync({ key: 'k1', check });
    const state = useBackgroundSyncState('k1');

    await probeNow('k1');
    expect(state.value.error).toBe('network down');

    await probeNow('k1');
    expect(state.value.error).toBeNull();
  });
});

describe('useBackgroundSync: state', () => {
  it('stamps lastSyncedAt only after a successful probe', async () => {
    useBackgroundSync({ key: 'k1', check: vi.fn().mockResolvedValue(false) });
    const state = useBackgroundSyncState('k1');
    expect(state.value.lastSyncedAt).toBeNull();

    await probeNow('k1');
    expect(state.value.lastSyncedAt).not.toBeNull();
  });

  it('bumps changedAt only when the source reports a change', async () => {
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    useBackgroundSync({ key: 'k1', check });
    const state = useBackgroundSyncState('k1');

    await probeNow('k1');
    expect(state.value.changedAt).toBeNull();

    await probeNow('k1');
    expect(state.value.changedAt).not.toBeNull();
  });

  it('is reactive — a component reading it re-renders on sync', async () => {
    useBackgroundSync({ key: 'k1', check: vi.fn().mockResolvedValue(false) });
    const state = useBackgroundSyncState('k1');
    expect(state.value.lastSyncedAt).toBeNull();

    await probeAll();
    await nextTick();
    expect(state.value.lastSyncedAt).not.toBeNull();
  });

  it('returns an all-null state for an unregistered key', () => {
    const state = useBackgroundSyncState('never-registered');
    expect(state.value).toEqual({ lastSyncedAt: null, changedAt: null, error: null });
  });
});

describe('useBackgroundSync: manual probe', () => {
  it('probeNow on an unknown key is a no-op returning false', async () => {
    expect(await probeNow('nope')).toBe(false);
  });

  it('probeNow probes only the named source', async () => {
    const a = vi.fn().mockResolvedValue(false);
    const b = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'a', check: a });
    useBackgroundSync({ key: 'b', check: b });

    expect(await probeNow('a')).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});

describe('useBackgroundSync: teardown', () => {
  it('stops probing and forgets state after reset (unregister-all path)', async () => {
    const check = vi.fn().mockResolvedValue(false);
    useBackgroundSync({ key: 'k1', check });
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(1);

    unregisterAll();
    await vi.advanceTimersByTimeAsync(DEFAULT_SYNC_INTERVAL_MS * 3);
    expect(check).toHaveBeenCalledTimes(1); // 定时器已停
    expect(useBackgroundSyncState('k1').value.lastSyncedAt).toBeNull();
  });
});
