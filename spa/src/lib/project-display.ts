// 功能: 「未分类」系统项目的显示层映射 (W4.5c) — 后端自动建的系统项目名是
//   DB 数据 (src/lib/db/projects.ts UNCATEGORIZED_NAME = '未分类', 不改 DB),
//   渲染层统一走 displayProjectName: 名字命中时显示 locale 文案
//   (zh=未分类 / en=Uncategorized), 其余原样返回.
// 关注点: 只做显示映射, 不过滤 / 不改写数据 — 过滤逻辑 (ProjectSidebar
//   isProjectEmpty) 仍按原始 DB 名比较, 用导出的 UNCATEGORIZED_NAME.
import { i18n } from '@/i18n';

/** 与后端 UNCATEGORIZED_NAME 对齐 (协议值, 不翻译). */
export const UNCATEGORIZED_NAME = '未分类';

/** 项目名显示映射 — 唯一入口, 所有渲染项目名的 UI 都走这里. */
export function displayProjectName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return n;
  return n === UNCATEGORIZED_NAME ? i18n.global.t('common.uncategorizedProject') : n;
}
