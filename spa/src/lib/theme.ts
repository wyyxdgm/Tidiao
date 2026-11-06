// 功能: R206 主题偏好 (深色 / 浅色 / 随系统). 单一真相源 = localStorage 'ao_theme',
//   解析结果写到 <html data-theme="light|dark">, 驱动 theme-vars.css 的变量覆盖.
// 关注点:
//   - 'system' 不直接写进 DOM — 先按 prefers-color-scheme 解析成具体 light/dark 再写,
//     这样 CSS 只需 :root + :root[data-theme='dark'] 两套, 免去重复的 @media 变量表.
//   - matchMedia 监听常驻 (仅在 preference==='system' 时影响结果), 系统切换主题即时跟随.
//   - localStorage / matchMedia 在隐私模式 / 老浏览器 / 测试环境可能缺失 → 一律静默降级
//     (主题功能不可用不应阻断应用). 与 recent-accounts.ts 同款容错口径.
//   - 首屏防闪: index.html 内联脚本先按 localStorage 落一次 data-theme, 这里 initTheme()
//     再接管 (幂等), 避免深色用户首帧白闪.
import { computed, ref } from 'vue';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key for the persisted preference. */
export const THEME_STORAGE_KEY = 'ao_theme';

const media: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/** 读持久化偏好; 非法 / 缺失 → 'system'. */
function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage 不可用 → 默认随系统 */
  }
  return 'system';
}

const preference = ref<ThemePreference>(readStored());
const systemDark = ref<boolean>(media?.matches ?? false);

/** 解析后的实际主题 (system → 看 matchMedia). */
const resolved = computed<ResolvedTheme>(() =>
  preference.value === 'system' ? (systemDark.value ? 'dark' : 'light') : preference.value,
);

/** 把解析后的主题落到 <html>: data-theme + color-scheme (原生控件/滚动条跟随). */
function applyToDom(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved.value);
  root.style.colorScheme = resolved.value;
}

/** 启动: 应用当前偏好 + 挂系统主题监听. main.ts 调一次; 幂等. */
export function initTheme(): void {
  applyToDom();
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('change', (e) => {
      systemDark.value = e.matches;
      applyToDom();
    });
  }
}

/** 设置偏好: 写 localStorage (静默失败) + 立即应用. */
export function setThemePreference(next: ThemePreference): void {
  preference.value = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* 静默: 本次会话仍然生效, 只是刷新后丢失 */
  }
  applyToDom();
}

/** 循环: light → dark → system → light. */
export function cycleTheme(): void {
  const order: ThemePreference[] = ['light', 'dark', 'system'];
  const idx = order.indexOf(preference.value);
  setThemePreference(order[(idx + 1) % order.length]);
}

/** 组件用: 响应式读偏好 + 解析结果 + 写方法. */
export function useTheme() {
  return { preference, resolved, setThemePreference, cycleTheme };
}
