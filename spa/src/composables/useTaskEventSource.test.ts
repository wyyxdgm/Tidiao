// SSE 订阅单例 composable (R233 keep-alive 感知改造) 的核心契约.
//
// 关注点:
//   - 同 url 多订阅共享一条 EventSource (引用计数), 末个 detach 才 close
//     —— 防重复连接吃光 HTTP/1.1 每域 6 个并发名额 (R228/R233 卡死根因);
//   - detach 幂等; 空 url 不建流 (new EventSource('') 会请求当前页面);
//   - 响应式 url 变化 + attach = 迁移订阅: 旧流还名额 + 新流建立
//     (BoardPage keep-alive 复用实例切项目的场景);
//   - onmessage JSON 分发 + 脏数据静默.
//
// node 环境 (无 DOM): 只测核心 createEventSourceSubscription —— vue 生命周期
// 包装 (useTaskEventSource) 是薄封装, 依赖组件实例, 不在此测. 每用例
// __resetUseTaskEventSource() 清模块单例表.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ref } from 'vue';
import {
  createEventSourceSubscription,
  __resetUseTaskEventSource,
  __setPageHidden,
} from './useTaskEventSource';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  __resetUseTaskEventSource();
  MockEventSource.instances = [];
  fetchMock.mockReset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  __resetUseTaskEventSource();
  vi.unstubAllGlobals();
});

describe('createEventSourceSubscription', () => {
  it('同 url 两订阅共享一条连接, 末个 detach 才 close', () => {
    const a = createEventSourceSubscription('/api/events', () => {});
    const b = createEventSourceSubscription('/api/events', () => {});
    a.attach();
    b.attach();
    expect(MockEventSource.instances).toHaveLength(1);

    a.detach(); // 还剩 b 持有 → 连接不关
    expect(MockEventSource.instances[0].closed).toBe(false);

    b.detach(); // 末个释放 → 关
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it('detach 幂等, 重复 detach 不把别人的计数减穿', () => {
    const a = createEventSourceSubscription('/api/events', () => {});
    const b = createEventSourceSubscription('/api/events', () => {});
    a.attach();
    b.attach();
    a.detach();
    a.detach(); // 幂等 no-op
    expect(MockEventSource.instances[0].closed).toBe(false);
    // a 重新 attach 还能正常工作 (状态没被减穿)
    a.attach();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('不同 url 各开一条连接', () => {
    const a = createEventSourceSubscription('/api/events', () => {});
    const b = createEventSourceSubscription('/api/projects/p1/events', () => {});
    a.attach();
    b.attach();
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances.map((e) => e.url).sort()).toEqual([
      '/api/events',
      '/api/projects/p1/events',
    ]);
  });

  it('空 url 不建流 (guard new EventSource("") 垃圾请求)', () => {
    const sub = createEventSourceSubscription('', () => {});
    sub.attach();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(sub.currentUrl()).toBe('');
  });

  it('url getter 变化 + attach = 迁移: 旧流 close + 新流建立', () => {
    const projectId = ref('p1');
    const sub = createEventSourceSubscription(
      () => (projectId.value ? `/api/projects/${projectId.value}/events` : ''),
      () => {},
    );
    sub.attach();
    expect(sub.currentUrl()).toBe('/api/projects/p1/events');

    projectId.value = 'p2';
    sub.attach(); // 模拟 useTaskEventSource 的 url watch 回调
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true); // 旧流还名额
    expect(MockEventSource.instances[1].closed).toBe(false);
    expect(MockEventSource.instances[1].url).toBe('/api/projects/p2/events');
  });

  it('getter 变为空串 + attach = 只释放不建流 (缺参跳过订阅)', () => {
    const projectId = ref('p1');
    const sub = createEventSourceSubscription(
      () => (projectId.value ? `/api/projects/${projectId.value}/events` : ''),
      () => {},
    );
    sub.attach();
    projectId.value = '';
    sub.attach();
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(sub.currentUrl()).toBe('');
  });

  it('onmessage JSON 分发给 onEvent, 脏数据静默不炸', () => {
    const seen: unknown[] = [];
    const sub = createEventSourceSubscription('/api/events', (e) => seen.push(e));
    sub.attach();
    const es = MockEventSource.instances[0];

    es.onmessage?.({ data: JSON.stringify({ type: 'status_change', to: 'running' }) });
    es.onmessage?.({ data: 'not-json' }); // 脏数据: 静默
    es.onmessage?.({ data: JSON.stringify({ type: 'cost', cost_usd: 0.5 }) });

    expect(seen).toHaveLength(2);
    expect((seen[0] as { to: string }).to).toBe('running');
    expect((seen[1] as { cost_usd: number }).cost_usd).toBe(0.5);
  });

  it('多消费者同 url: 事件广播给所有 listener', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const a = createEventSourceSubscription('/api/events', (e) => seenA.push(e.type));
    const b = createEventSourceSubscription('/api/events', (e) => seenB.push(e.type));
    a.attach();
    b.attach();

    MockEventSource.instances[0].onmessage?.({ data: '{"type":"x"}' });
    expect(seenA).toEqual(['x']);
    expect(seenB).toEqual(['x']);
  });

  // R241: 跨 Chrome tab 连接名额回收 — 页面隐藏挂起全部连接, 恢复可见重建.
  it('页面隐藏挂起全部连接, 恢复可见重建并继续分发事件', () => {
    const seen: string[] = [];
    const a = createEventSourceSubscription('/api/events', (e) => seen.push(e.type));
    a.attach();
    expect(MockEventSource.instances).toHaveLength(1);

    __setPageHidden(true);
    expect(MockEventSource.instances[0].closed).toBe(true);

    __setPageHidden(false);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].closed).toBe(false);

    // 重建后的连接继续分发事件
    MockEventSource.instances[1].onmessage?.({ data: '{"type":"resume"}' });
    expect(seen).toEqual(['resume']);
  });

  it('隐藏期间新建订阅不建流, 恢复可见时补建', () => {
    __setPageHidden(true);
    const a = createEventSourceSubscription('/api/events', () => {});
    a.attach();
    expect(MockEventSource.instances).toHaveLength(0);

    __setPageHidden(false);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].closed).toBe(false);
  });

  it('回归 R241: 末个 detach 后重 attach 拿到的是新连接 (旧版 entry 残留 map 复用已 close 的 es)', () => {
    const a = createEventSourceSubscription('/api/events', () => {});
    a.attach();
    a.detach();
    a.attach();
    // 旧版 bug: streams.delete('') no-op → 残留 entry 被复用, 实例数停在 1 且已 close
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances[1].closed).toBe(false);
  });
});

// R245: 断线重连回调 — SSE 断线窗口内事件永久丢失 (服务端无 Last-Event-ID
// 回放), 订阅方靠 onReconnect 强刷本地数据. 契约:
//   - 首次建连 onopen 不触发 (避免页面加载时每个消费方多打一次全量接口);
//   - 仅「error 之后重新 onopen」触发, 且每次重连只触发一次;
//   - 页面隐藏挂起后恢复重建视同重连 (挂起窗口事件已丢).
describe('R245 重连回调 (onReconnect)', () => {
  it('首次建连 onopen 不触发 onReconnect', () => {
    const onReconnect = vi.fn();
    const a = createEventSourceSubscription('/api/events', () => {}, onReconnect);
    a.attach();
    MockEventSource.instances[0].onopen?.();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('error 后重新 onopen 触发 onReconnect; 每次 error 只触发一次', () => {
    fetchMock.mockResolvedValue({ status: 200 }); // onerror 内探测 401 用, 200 = 正常断线
    const onReconnect = vi.fn();
    const a = createEventSourceSubscription('/api/events', () => {}, onReconnect);
    a.attach();
    const es = MockEventSource.instances[0];

    // 模拟浏览器同实例自动重连: error → 重连成功 onopen
    es.onerror?.();
    es.onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // 同一次重连后再次 onopen (连接正常期间不会发生, 防御性) 不重复触发
    es.onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // 第二次断线重连再触发一次
    es.onerror?.();
    es.onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('多消费者同 url: 重连广播给所有带回调的订阅方', () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const ra = vi.fn();
    const rb = vi.fn();
    const a = createEventSourceSubscription('/api/events', () => {}, ra);
    const b = createEventSourceSubscription('/api/events', () => {}, rb);
    const c = createEventSourceSubscription('/api/events', () => {}); // 无回调, 不受影响
    a.attach();
    b.attach();
    c.attach();

    MockEventSource.instances[0].onerror?.();
    MockEventSource.instances[0].onopen?.();
    expect(ra).toHaveBeenCalledTimes(1);
    expect(rb).toHaveBeenCalledTimes(1);
  });

  it('detach 后重连不再通知已释放的订阅方', () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const ra = vi.fn();
    const a = createEventSourceSubscription('/api/events', () => {}, ra);
    a.attach();
    a.detach();

    const b = createEventSourceSubscription('/api/events', () => {});
    b.attach();
    MockEventSource.instances[1].onerror?.();
    MockEventSource.instances[1].onopen?.();
    expect(ra).not.toHaveBeenCalled();
  });

  it('页面隐藏挂起后恢复重建视同重连, 触发 onReconnect', () => {
    const onReconnect = vi.fn();
    const a = createEventSourceSubscription('/api/events', () => {}, onReconnect);
    a.attach();

    __setPageHidden(true);
    __setPageHidden(false);
    // 恢复时连接重建, onopen (新实例) 触发广播
    MockEventSource.instances[1].onopen?.();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
