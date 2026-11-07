// 功能: 按浏览器访问入口判定实例身份, 产出跟随界面语言 (zh-CN/en-US) 的页面 title
//   (R193 起按入口区分; 2026-10-25 damo 拍板格式 提调（env）; 2026-11-07 接入 i18n —
//   标题随语言切换实时重算, 一套代码双语兼容, 不分站点)。
// 关注点: 一份 SPA dist 服务多实例 (deploy 只 build 一次, mac/air 实例各用各的 checkout),
//   无法在 build 时按实例注入, 只能运行时按 location 判断。
//   覆盖入口: 公网域名 (经 pulu nginx, 浏览器 port=443) + WSL 直连 13001 (dev) / 13000 (wsl LAN IP)。
//   localhost:13000 在 mac/wsl 各机本机都是 13000, 客户端无法区分 → 落默认。
//   air 实例 checkout 在旧版 (无本逻辑), 其域名入口的 title 由 pulu nginx sub_filter 兜底改写
//   (只改初始 HTML, JS 挂载后仍以本模块为准)。
//   新增实例域名入口时在 instanceEnvTag 追加, 并同步 docs/claude-config/docs/env-capabilities.md 口径。
import { locales, getLang, type Lang } from '@/i18n';

export type InstanceEnv = 'dev' | 'mac' | 'air' | 'pulu' | 'wsl';

// 实例标识 tag 全部 ASCII, 与语言无关 — zh/en 共用同一 tag。
export function instanceEnvTag(hostname: string, port: string): InstanceEnv | null {
  if (port === '13001' || hostname === 'dev.example.com') return 'dev';
  if (hostname === 'mac.example.com') return 'mac';
  if (hostname === 'air.example.com') return 'air';
  if (hostname === 'ao.example.com') return 'pulu';
  if (hostname === 'dao.example.com' || hostname === '192.0.2.50') return 'wsl';
  return null;
}

// 产品名单源 = locales/<lang>/header.json 的 brand (zh=提调 / en=Tidiao);
// locales 缺 key 时回落硬编码, 不抛错。
function brandOf(lang: Lang): string {
  const m = locales[lang] as { header?: { brand?: string } } | undefined;
  return m?.header?.brand ?? (lang === 'en-US' ? 'Tidiao' : '提调');
}

// 功能: 组装指定语言的完整 title: zh=提调（dev）(全角括号) / en=Tidiao (dev) (半角括号);
//   无 tag → 产品名 (zh 默认保留双语「提调（Tidiao）」旧格式)。
export function pageTitle(lang: Lang, hostname: string, port: string): string {
  const tag = instanceEnvTag(hostname, port);
  const brand = brandOf(lang);
  if (lang === 'en-US') return tag ? `${brand} (${tag})` : brand;
  return tag ? `${brand}（${tag}）` : `${brand}（Tidiao）`;
}

// 功能: 按当前语言写 document.title + <html lang>。main.ts 启动时调一次,
//   并 watch(getLang) — 语言切换 (LangToggle / Settings) 即时重算。
export function applyInstanceTitle(): void {
  const lang = getLang();
  document.title = pageTitle(lang, location.hostname, location.port);
  document.documentElement.lang = lang;
}
