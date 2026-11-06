// 功能: vue-i18n 入口 — locale 按语言目录组织 (locales/<lang>/<domain>.json), import.meta.glob
//   构建期自动收集合并; 语言偏好持久化 localStorage (tidiao-lang), 默认 zh-CN.
// 关注点: fallbackLocale = zh-CN — en-US 缺 key 时回落中文不报错; 新增语言 = 加
//   locales/<lang>/ 目录即可, 不改本文件; 新增文案必须 zh/en 两份同步 (i18n.test.ts
//   的 key 集合一致性测试兜底).
import type { WritableComputedRef } from 'vue';
import { createI18n } from 'vue-i18n';
import type { I18nOptions } from 'vue-i18n';

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

// 关注点: messages 来自 glob 合并的宽泛 Record, 直接传会撞 createI18n 的 schema 泛型
//   推导 (要求已知语言键) — 断言成 I18nOptions 放宽, key 一致性由 i18n.test.ts 兜底.
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initialLang(),
  fallbackLocale: 'zh-CN',
  messages: locales,
} as I18nOptions);

// 关注点: legacy:false 下 i18n.global.locale 的类型随 messages 宽泛化会推导成 string,
//   实际运行时是 WritableComputedRef — 这里显式断言一次, get/set 都走它 (保持响应性).
const localeRef = i18n.global.locale as unknown as WritableComputedRef<Lang>;

export function getLang(): Lang {
  return localeRef.value;
}

export function setLang(lang: Lang): void {
  localeRef.value = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 同上, 持久化失败不影响本次切换.
  }
}
