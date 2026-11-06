// 功能: vue-i18n 入口 — locale 按语言目录组织 (locales/<lang>/<domain>.json), import.meta.glob
//   构建期自动收集合并; 语言偏好持久化 localStorage (tidiao-lang), 默认 zh-CN.
// 关注点: fallbackLocale = zh-CN — en-US 缺 key 时回落中文不报错; 新增语言 = 加
//   locales/<lang>/ 目录即可, 不改本文件; 新增文案必须 zh/en 两份同步 (i18n.test.ts
//   的 key 集合一致性测试兜底).
import { createI18n } from 'vue-i18n';

export const SUPPORTED_LANGS = ['zh-CN', 'en-US'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

const STORAGE_KEY = 'tidiao-lang';

// eager glob: './locales/zh-CN/login.json' → messages['zh-CN'] 里合并其 default 导出.
const files = import.meta.glob('./locales/*/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>;
export const locales: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(files)) {
  const m = path.match(/\.\/locales\/([^/]+)\/[^/]+\.json$/);
  if (!m) continue;
  const lang = m[1]!;
  (locales[lang] ??= {});
  Object.assign(locales[lang], mod.default);
}

function initialLang(): Lang {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // SSR / 隐私模式 localStorage 不可访问时静默走默认语言.
  }
  if (saved && (SUPPORTED_LANGS as readonly string[]).includes(saved)) return saved as Lang;
  return 'zh-CN';
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initialLang(),
  fallbackLocale: 'zh-CN',
  messages: locales,
});

export function getLang(): Lang {
  return i18n.global.locale.value as Lang;
}

export function setLang(lang: Lang): void {
  i18n.global.locale.value = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 同上, 持久化失败不影响本次切换.
  }
}
