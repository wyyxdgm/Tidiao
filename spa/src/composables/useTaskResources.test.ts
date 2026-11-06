// 任务资源轮询单例 (R234 自适应节拍版) 的契约.
//
// 关注点:
//   - 节拍自适应: 样本含运行中任务 (pids 非空) → 3s; 空闲 → 10s;
//   - SSE 补采: /api/events status_change 去抖 1s 触发一次采样 (起跑徽章 ≤1s 跟上);
//   - 引用计数: 多消费者共享一个循环, 归零停摆且不再排下一拍;
//   - 隐藏停摆分支依赖 document (node 无), 浏览器内生效, 这里不测.
//
// node 环境: fetch 层 mock @/api/http 的 get; EventSource 换成 fake
// (useTaskResources 经 createEventSourceSubscription 间接 new EventSource).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  taskResources,
  acquireTaskResourcesPolling,
  releaseTaskResourcesPolling,
  __resetTaskResources,
  POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  EVENT_NUDGE_DEBOUNCE_MS,
} from './useTaskResources';
import { __resetUseTaskEventSource } from './useTaskEventSource';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/http', () => ({
  get: getMock,
}));

/** 最小 EventSource 替身 — 只需 constructor(url) / close() / 可赋 onmessage. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

/** 构造 GET /api/tasks/resources 响应体. running=有运行中任务 (pids 非空). */
function sampleBody(running: boolean) {
  return {
    tasks: running
      ? {
          t1: {
            pids: [1],
            cpuPercent: 5,
            hostCpuPercent: 1,
            memRssMB: 10,
            memPercent: 1,
            sampledAt: 0,
          },
        }
      : {},
    titles: {},
    host: null,
    count: running ? 1 : 0,
  };
}

beforeEach(() => {
  __resetTaskResources();
  __resetUseTaskEventSource();
  getMock.mockReset();
  FakeEventSource.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  __resetTaskResources();
  __resetUseTaskEventSource();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useTaskResources 自适应节拍', () => {
  it('空闲 (无 pids) → 首采后 10s 才第二拍 (3s 处不采)', async () => {
    getMock.mockResolvedValue(sampleBody(false));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - POLL_INTERVAL_MS);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('有运行中任务 → 3s 节拍, 样本写入 taskResources', async () => {
    getMock.mockResolvedValue(sampleBody(true));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(taskResources.value.t1?.pids).toEqual([1]);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('运行→空闲 自动降速: 慢拍从下一次调度生效', async () => {
    getMock
      .mockResolvedValueOnce(sampleBody(true))
      .mockResolvedValue(sampleBody(false));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // t=3s 运行节拍
    expect(getMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // t=6s 已转空闲节拍, 不采
    expect(getMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS - POLL_INTERVAL_MS); // t=13s
    expect(getMock).toHaveBeenCalledTimes(3);
  });
});

describe('useTaskResources SSE 补采', () => {
  it('status_change 事件 → 去抖 1s 后补采一次', async () => {
    getMock.mockResolvedValue(sampleBody(false));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(1);

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    expect(es.url).toBe('/api/events');
    es.onmessage!({ data: JSON.stringify({ type: 'status_change', to: 'running' }) });
    await vi.advanceTimersByTimeAsync(EVENT_NUDGE_DEBOUNCE_MS);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('非 status_change 事件不触发补采', async () => {
    getMock.mockResolvedValue(sampleBody(false));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.onmessage!({ data: JSON.stringify({ type: 'cost', cost_usd: 1 }) });
    await vi.advanceTimersByTimeAsync(EVENT_NUDGE_DEBOUNCE_MS * 3);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('事件突发合并: 多条 status_change 只补采一次', async () => {
    getMock.mockResolvedValue(sampleBody(false));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.onmessage!({ data: JSON.stringify({ type: 'status_change', to: 'running' }) });
    await vi.advanceTimersByTimeAsync(200);
    es.onmessage!({ data: JSON.stringify({ type: 'status_change', to: 'reviewing' }) });
    await vi.advanceTimersByTimeAsync(EVENT_NUDGE_DEBOUNCE_MS);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});

describe('useTaskResources 生命周期', () => {
  it('release 归零 → 停摆不再采样, 数据清空', async () => {
    getMock.mockResolvedValue(sampleBody(false));
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);
    releaseTaskResourcesPolling();

    await vi.advanceTimersByTimeAsync(IDLE_POLL_INTERVAL_MS * 3);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(taskResources.value).toEqual({});
  });

  it('多消费者共享单循环: 1 拍 1 采, 全部释放才停', async () => {
    getMock.mockResolvedValue(sampleBody(true));
    acquireTaskResourcesPolling();
    acquireTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getMock).toHaveBeenCalledTimes(2); // 单循环, 不是 2 采

    releaseTaskResourcesPolling();
    releaseTaskResourcesPolling();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(getMock).toHaveBeenCalledTimes(2); // 归零停摆
  });
});
