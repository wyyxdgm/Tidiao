// hard-navigate.ts 单元测试. root vitest (node, 无 jsdom) — stub window 后
// 动态 import (vi.resetModules 保证每个用例拿到干净的模块状态).
// 核心回归保护: hash 路由下 location.href 赋值仅变 hash 不重载页面, 这里锁死
// 「必须调 reload」行为 —— 谁把它改回裸 href 赋值, 测试就红.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface StubResult {
  setHref: (url: string) => void;
  reloadSpy: ReturnType<typeof vi.fn>;
}

function stubWindow(initialHref: string): StubResult {
  const state = { href: initialHref };
  const reloadSpy = vi.fn();
  (globalThis as any).window = {
    location: {
      get href() {
        return state.href;
      },
      set href(v: string) {
        state.href = v;
      },
      get origin() {
        return new URL(state.href).origin;
      },
      reload: reloadSpy,
    },
  };
  return { setHref: (u: string) => (state.href = u), reloadSpy };
}

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as any).window;
});

describe('hardNavigate', () => {
  it('目标 hash 不同于当前 → 更新 href 并 reload', async () => {
    const { reloadSpy } = stubWindow('http://localhost:13000/#/login');
    const { hardNavigate } = await import('./hard-navigate');
    hardNavigate('/#/');
    expect((globalThis as any).window.location.href).toBe('http://localhost:13000/#/');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('目标与当前相同 (href 赋值本会是 no-op) → 仍 reload 兜底', async () => {
    const { reloadSpy } = stubWindow('http://localhost:13000/#/');
    const { hardNavigate } = await import('./hard-navigate');
    hardNavigate('/#/');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('相对路径按当前 origin 解析', async () => {
    stubWindow('http://localhost:13000/#/projects/p1');
    const { hardNavigate } = await import('./hard-navigate');
    hardNavigate('/#/login');
    expect((globalThis as any).window.location.href).toBe('http://localhost:13000/#/login');
  });

  it('绝对 URL 目标也支持', async () => {
    stubWindow('http://localhost:13000/#/a');
    const { hardNavigate } = await import('./hard-navigate');
    hardNavigate('http://other.example.com/#/b');
    expect((globalThis as any).window.location.href).toBe('http://other.example.com/#/b');
  });
});
