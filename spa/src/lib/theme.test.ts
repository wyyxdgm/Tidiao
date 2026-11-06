// theme.ts 单元测试. 运行环境 = root vitest (node, 无 jsdom), 故自行 stub
// window / document / localStorage 后在动态 import 时生效 (模块级代码在 import
// 时读取它们, 所以每个用例先 resetModules 再 import).
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface StubOptions {
  stored?: string;
  systemDark?: boolean;
}

function stubBrowser({ stored, systemDark = false }: StubOptions) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('ao_theme', stored);

  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const media = {
    matches: systemDark,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
    removeEventListener: () => {},
  };

  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as any).window = { matchMedia: () => media };
  const attrs: Record<string, string> = {};
  const htmlEl = { setAttribute: (k: string, v: string) => (attrs[k] = v), style: {} as any };
  // document 需带 createElement: Vue runtime-dom 在模块加载时会调
  // doc.createElement('template') (import theme → import 'vue' 触发).
  (globalThis as any).document = {
    documentElement: htmlEl,
    createElement: () => ({ style: {}, content: {}, setAttribute() {}, appendChild() {} }),
    createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    createTextNode: () => ({}),
    createComment: () => ({}),
  };

  return { store, listeners, attrs, media };
}

async function load() {
  vi.resetModules();
  return await import('./theme');
}

beforeEach(() => {
  // 清理上一条用例可能留下的全局 stub
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('theme preference resolution', () => {
  it("stored 'dark' → resolved dark", async () => {
    stubBrowser({ stored: 'dark' });
    const t = await load();
    t.initTheme();
    expect(t.useTheme().preference.value).toBe('dark');
    expect(t.useTheme().resolved.value).toBe('dark');
  });

  it("stored 'light' → resolved light 即使系统是深色", async () => {
    stubBrowser({ stored: 'light', systemDark: true });
    const t = await load();
    expect(t.useTheme().resolved.value).toBe('light');
  });

  it("无存储 + 系统深色 → preference system 解析为 dark", async () => {
    stubBrowser({ systemDark: true });
    const t = await load();
    expect(t.useTheme().preference.value).toBe('system');
    expect(t.useTheme().resolved.value).toBe('dark');
  });

  it('无存储 + 系统浅色 → 解析为 light', async () => {
    stubBrowser({ systemDark: false });
    const t = await load();
    expect(t.useTheme().resolved.value).toBe('light');
  });

  it('非法存储值 → 回退 system', async () => {
    stubBrowser({ stored: 'purple' });
    const t = await load();
    expect(t.useTheme().preference.value).toBe('system');
  });
});

describe('apply + persist', () => {
  it('initTheme 把 data-theme 写到 <html>', async () => {
    const env = stubBrowser({ stored: 'dark' });
    const t = await load();
    t.initTheme();
    expect(env.attrs['data-theme']).toBe('dark');
  });

  it('setThemePreference 持久化到 localStorage 并立即应用', async () => {
    const env = stubBrowser({ systemDark: false });
    const t = await load();
    t.setThemePreference('dark');
    expect(env.store.get('ao_theme')).toBe('dark');
    expect(t.useTheme().resolved.value).toBe('dark');
    expect(env.attrs['data-theme']).toBe('dark');
  });

  it('系统主题变化时 (preference=system) 即时跟随', async () => {
    const env = stubBrowser({ systemDark: false });
    const t = await load();
    t.initTheme();
    expect(t.useTheme().resolved.value).toBe('light');
    env.media.matches = true;
    env.listeners.forEach((cb) => cb({ matches: true }));
    expect(t.useTheme().resolved.value).toBe('dark');
    expect(env.attrs['data-theme']).toBe('dark');
  });

  it('preference≠system 时系统变化不影响解析结果', async () => {
    const env = stubBrowser({ stored: 'light' });
    const t = await load();
    t.initTheme();
    env.listeners.forEach((cb) => cb({ matches: true }));
    expect(t.useTheme().resolved.value).toBe('light');
  });
});

describe('cycleTheme', () => {
  it('light → dark → system → light', async () => {
    stubBrowser({ stored: 'light' });
    const t = await load();
    const { cycleTheme, useTheme } = t;
    expect(useTheme().preference.value).toBe('light');
    cycleTheme();
    expect(useTheme().preference.value).toBe('dark');
    cycleTheme();
    expect(useTheme().preference.value).toBe('system');
    cycleTheme();
    expect(useTheme().preference.value).toBe('light');
  });
});

describe('无浏览器环境 (SSR / node)', () => {
  it('import 不抛错, 静默降级', async () => {
    const t = await load();
    expect(t.useTheme().preference.value).toBe('system');
    expect(t.useTheme().resolved.value).toBe('light');
    expect(() => t.initTheme()).not.toThrow();
  });
});
