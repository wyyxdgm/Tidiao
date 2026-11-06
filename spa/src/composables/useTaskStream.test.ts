// 任务流 SSE 共享订阅 (R234 后续项) 的契约.
//
// 关注点:
//   - 同 url 多消费者共享一条 EventSource, 末个释放才销毁;
//   - R256 无限重连: 临时断开指数退避 3s→30s 封顶, 无总次数上限;
//   - 401: probe /api/user/me 命中 → closed 不再重连; 非 401 → 照常重连;
//   - R256 onReconnect: error → onopen 广播 (首次建连不触发), detach 清理;
//   - attach 幂等 + url 迁移;
//   - 连接态 reactive registry: taskStreamState computed 跟随, entry 销毁回落 idle.
//
// node 环境: EventSource 换 fake (readyState 可控), fetch 换 mock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTaskStreamSubscription,
  taskStreamState,
  __resetTaskStream,
  __setPageHidden,
  RECONNECT_DELAY_MS,
  RECONNECT_DELAY_MAX_MS,
} from './useTaskStream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = FakeEventSource.CONNECTING;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  __resetTaskStream();
  FakeEventSource.instances = [];
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  __resetTaskStream();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useTaskStream 共享与生命周期', () => {
  it('两个消费者同 url → 只开一条连接, 消息 fan-out 给双方', () => {
    const got1: string[] = [];
    const got2: string[] = [];
    const s1 = createTaskStreamSubscription('/api/tasks/t1/stream', (e) => got1.push(String(e.type)));
    const s2 = createTaskStreamSubscription('/api/tasks/t1/stream', (e) => got2.push(String(e.type)));
    s1.attach();
    s2.attach();

    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0];
    es.onmessage!({ data: JSON.stringify({ type: 'status_change', to: 'running' }) });
    expect(got1).toEqual(['status_change']);
    expect(got2).toEqual(['status_change']);

    s1.detach();
    expect(es.closed).toBe(false); // 还有一个消费者
    s2.detach();
    expect(es.closed).toBe(true); // 末个释放销毁
  });

  it('不同 url 各开一条连接', () => {
    const s1 = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    const s2 = createTaskStreamSubscription('/api/tasks/t2/stream', () => {});
    s1.attach();
    s2.attach();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('attach 幂等; url 变化后 attach 自动迁移 (旧关新开)', () => {
    let id = 't1';
    const sub = createTaskStreamSubscription(() => `/api/tasks/${id}/stream`, () => {});
    sub.attach();
    const first = FakeEventSource.instances[0];
    sub.attach(); // 同 url no-op
    expect(FakeEventSource.instances).toHaveLength(1);

    id = 't2';
    sub.attach();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe('/api/tasks/t2/stream');
  });

  it('url 为空串 attach = 不建流且旧流还名额', () => {
    let id = 't1';
    const sub = createTaskStreamSubscription(() => (id ? `/api/tasks/${id}/stream` : ''), () => {});
    sub.attach();
    expect(FakeEventSource.instances).toHaveLength(1);
    id = '';
    sub.attach();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(sub.currentUrl()).toBe('');
  });
});

describe('useTaskStream 连接态', () => {
  it('connecting → connected → detached 后回落 idle', async () => {
    let id: string | null = 't1';
    const urlOf = () => (id ? `/api/tasks/${id}/stream` : '');
    const { state, retryCount } = taskStreamState(urlOf);
    const sub = createTaskStreamSubscription(urlOf, () => {});
    expect(state.value).toBe('idle');

    sub.attach();
    expect(state.value).toBe('connecting');
    FakeEventSource.instances[0].onopen!();
    expect(state.value).toBe('connected');

    id = null;
    sub.attach(); // url 变空 → detach (entry 销毁)
    expect(state.value).toBe('idle');
    expect(retryCount.value).toBe(0);
  });

  it('onmessage 解析失败静默不炸 listeners', () => {
    const got: unknown[] = [];
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', (e) => got.push(e));
    sub.attach();
    const es = FakeEventSource.instances[0];
    es.onmessage!({ data: 'not-json' });
    es.onmessage!({ data: JSON.stringify({ type: 'ok' }) });
    expect(got).toHaveLength(1);
    expect((got[0] as { type?: string }).type).toBe('ok');
  });
});

describe('useTaskStream 重连', () => {
  it('临时断开 (CONNECTING) → 3s 后重建, retryCount 递增, onopen 归零', async () => {
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    const { state, retryCount } = taskStreamState('/api/tasks/t1/stream');
    sub.attach();
    const es1 = FakeEventSource.instances[0];
    es1.onopen!();
    expect(state.value).toBe('connected');

    es1.readyState = FakeEventSource.CONNECTING;
    es1.onerror!();
    expect(state.value).toBe('connecting');
    expect(retryCount.value).toBe(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(es1.closed).toBe(true);

    FakeEventSource.instances[1].onopen!();
    expect(state.value).toBe('connected');
    expect(retryCount.value).toBe(0);
  });

  it('R256: 无限重连 — 连续失败多次仍重建, 退避指数增长到 30s 封顶, 不再 closed', async () => {
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    const { state, retryCount } = taskStreamState('/api/tasks/t1/stream');
    sub.attach();
    FakeEventSource.instances[0].onopen!();

    // 连续 25 次失败 (超过原 20 次上限) — 每次都重建; 退避 3s*2^(n-1) 封顶 30s
    for (let i = 1; i <= 25; i++) {
      const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
      es.readyState = FakeEventSource.CONNECTING;
      es.onerror!();
      expect(retryCount.value).toBe(i);
      await vi.advanceTimersByTimeAsync(
        Math.min(RECONNECT_DELAY_MS * 2 ** (i - 1), RECONNECT_DELAY_MAX_MS),
      );
      expect(FakeEventSource.instances).toHaveLength(i + 1); // 首发 + i 次重建
    }
    // 退避已封顶: 再失败几次仍不放弃, 永不 closed (除非 401)
    for (let i = 0; i < 3; i++) {
      const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
      es.readyState = FakeEventSource.CONNECTING;
      es.onerror!();
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MAX_MS);
    }
    expect(state.value).toBe('connecting');

    // 成功连上 → retryCount 归零
    FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen!();
    expect(state.value).toBe('connected');
    expect(retryCount.value).toBe(0);
  });

  it('R256 onReconnect: error → 重建连上时广播; 首次建连不广播; detach 清理', async () => {
    const reconnected = vi.fn();
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {}, reconnected);
    sub.attach();
    // 首次建连成功: 不广播
    FakeEventSource.instances[0].onopen!();
    expect(reconnected).not.toHaveBeenCalled();

    // 断开 → 重建 → 连上: 广播一次
    FakeEventSource.instances[0].readyState = FakeEventSource.CONNECTING;
    FakeEventSource.instances[0].onerror!();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    FakeEventSource.instances[1].onopen!();
    expect(reconnected).toHaveBeenCalledTimes(1);

    // detach 清理: 后续恢复不再广播
    sub.detach();
    const s2 = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    s2.attach();
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    es.onopen!(); // 新订阅首次建连
    es.readyState = FakeEventSource.CONNECTING;
    es.onerror!();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen!();
    expect(reconnected).toHaveBeenCalledTimes(1); // 未增
  });

  it('重连成功后收到事件正常分发 (重连路径不破坏 fan-out)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    sub.attach();
    const es1 = FakeEventSource.instances[0];
    es1.readyState = FakeEventSource.CLOSED;
    es1.onerror!();

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledWith('/api/user/me', { credentials: 'include' });
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('重连成功后收到事件正常分发 (重连路径不破坏 fan-out)', async () => {
    const got: string[] = [];
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', (e) => got.push(String(e.type)));
    sub.attach();
    FakeEventSource.instances[0].onopen!();
    FakeEventSource.instances[0].readyState = FakeEventSource.CONNECTING;
    FakeEventSource.instances[0].onerror!();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    FakeEventSource.instances[1].onopen!();
    FakeEventSource.instances[1].onmessage!({ data: JSON.stringify({ type: 'status_change', to: 'reviewing' }) });
    expect(got).toEqual(['status_change']);
  });

  it('probe 401 → closed, 不再重连', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    const { state } = taskStreamState('/api/tasks/t1/stream');
    sub.attach();
    const es1 = FakeEventSource.instances[0];
    es1.readyState = FakeEventSource.CLOSED;
    es1.onerror!();

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 5);
    expect(state.value).toBe('closed');
    expect(FakeEventSource.instances).toHaveLength(1); // 没有重建
  });

  it('末个消费者 detach 后, pending 重连 timer 不再触发生命', async () => {
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    sub.attach();
    const es = FakeEventSource.instances[0];
    es.readyState = FakeEventSource.CONNECTING;
    es.onerror!(); // 排了 3s 重连
    sub.detach(); // 立即全撤

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1); // 没有重建
  });

  // R241: 跨 Chrome tab 连接名额回收 — 页面隐藏挂起任务流, 恢复可见重建.
  it('页面隐藏挂起任务流 (含 pending 重连 timer), 恢复可见重建', async () => {
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    sub.attach();
    expect(FakeEventSource.instances).toHaveLength(1);

    // 挂起要连重连 timer 一起撤: 排上重连后立刻隐藏, timer 不许再把连接建回来
    const es0 = FakeEventSource.instances[0];
    es0.readyState = FakeEventSource.CONNECTING;
    es0.onerror!();
    __setPageHidden(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(es0.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1); // timer 被清, 没有重建

    __setPageHidden(false);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });

  it('隐藏期间 attach 不建流, 恢复可见时补建', () => {
    __setPageHidden(true);
    const sub = createTaskStreamSubscription('/api/tasks/t1/stream', () => {});
    sub.attach();
    expect(FakeEventSource.instances).toHaveLength(0);

    __setPageHidden(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);
  });
});
