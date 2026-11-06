/** R59: tab 标题统一截断规则. 全项目 ≤8 字 (project name),
 *  任务/版本 ≤12 字 (item name), 拼成 "{项目}-{item}".
 *  缺名走 fallback (避免 tab 显示空字符串).
 *
 *  入口只在路由组件 watch 里调 — 不写 localStorage, 不进 store,
 *  纯展示层格式化. applyTitle 内部已尊重 customTitle, 截断后的临时
 *  标题不会覆盖用户手动重命名.
 *  i18n (W4.5b): fallback 文案走 locale (非 setup 环境用 i18n.global);
 *  项目名先过 displayProjectName (「未分类」系统项目显示映射, W4.5c). */
import { i18n } from '@/i18n';
import { displayProjectName } from '@/lib/project-display';

export function formatTabPart(
  name: string | null | undefined,
  max: number,
  fallback: string,
): string {
  const sliced = (name ?? '').slice(0, max).trim();
  return sliced || fallback;
}

export function formatProjectTitle(name: string | null | undefined): string {
  return formatTabPart(displayProjectName(name), 8, i18n.global.t('misc.tab.untitledProject'));
}

export function formatProjectItemTitle(
  projectName: string | null | undefined,
  itemName: string | null | undefined,
): string {
  const p = displayProjectName(projectName);
  return `${formatTabPart(p, 8, i18n.global.t('common.uncategorizedProject'))}-${formatTabPart(itemName, 12, i18n.global.t('misc.tab.untitled'))}`;
}

/** 项目前缀 + 静态标签 (例如「未挂版本任务」/「项目看板」/「Wiki」).
 *  item 名是路由 meta 写死的, 不进 localStorage, 不需要截断 — 用户能
 *  从路由 meta 看出这是什么视图. */
export function formatProjectWithLabel(
  projectName: string | null | undefined,
  label: string,
): string {
  return `${formatProjectTitle(projectName)}-${label}`;
}
