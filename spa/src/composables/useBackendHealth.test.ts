// 后台健康轮询单例 (R185) 的契约.
//
// 关注点:
//   - 探测成功 (res.ok) → healthy=true, 失败 (网络错/非 2xx) → healthy=false;
//   - 健康节拍 30s, 异常后重试节拍缩短到 5s (快速回绿);
//   - 单例: start 多次只起一个循环 (组件多挂载不翻倍);
//   - fetch 抛错不逃逸 (红灯, 不炸调度循环).
//
// node 环境: 无 document —— 走 typeof 守卫 (hidden 停摆分支在浏览器内生效,
// 这里不测). 每用例 __resetBackendHealth() 清单例.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  backendHealthy,
  startBackendHealthProbe,
  __resetBackendHealth,
  OK_INTERVAL_MS,
  RETRY_INTERVAL_MS,
} from './useBackendHealth';

const fetchMock = vi.fn();

beforeEach(() => {
  __resetBackendHealth();
  fetchMock.mockReset(); // 模块级 vi.fn, 计数必须每用例清零
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  __resetBackendHealth();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useBackendHealth', () => {
  it('初始态 = null (尚未探测)', () => {
    expect(backendHealthy.value).toBeNull();
  });

  it('探测成功 → healthy=true, 之后按 30s 健康节拍', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    startBackendHealthProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(backendHealthy.value).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('非 2xx → healthy=false, 5s 短节拍重试', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"x"}', { status: 500 }),
    );
    startBackendHealthProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(backendHealthy.value).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetch 抛网络错 → 红灯且调度循环不炸', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    startBackendHealthProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(backendHealthy.value).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('单例: start 多次只起一个探测循环', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    startBackendHealthProbe();
    startBackendHealthProbe();
    startBackendHealthProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OK_INTERVAL_MS * 3);
    // 1 (首探) + 3 (三次节拍) = 4, 翻倍会是 8
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('恢复: 失败后下一次成功 → healthy 回 true', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    startBackendHealthProbe();
    await vi.advanceTimersByTimeAsync(0);
    expect(backendHealthy.value).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    expect(backendHealthy.value).toBe(true);
  });
});
