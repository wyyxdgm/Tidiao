/* 功能: 快速创建弹窗的「版本默认选中」判定 (纯函数, 可测).
   优先级: 外部预选 (props.initialVersionId, 在列表中才生效) → 项目当前版本
   (projects.current_version_id, 在列表中才生效) → 列表第一个 → '' (不挂版本).

   关注点: 默认版本的权威源是 projects.current_version_id, 不是 versions[].is_current
   —— versions 表没有 is_current 列 (R56-B22 在 ProjectSidebar 已踩过同款坑),
   该字段在 API 返回里永远是 undefined, 拿它判定 = 永远 fallback 到第一个版本. */

export interface VersionPickEntry {
  id: string;
}

export interface VersionPickOptions {
  /** 外部预选版本 id (项目看板/版本详情场景传当前路由版本). 不在列表中则忽略. */
  preferVersionId?: string | null;
  /** 项目当前版本 id (projects.current_version_id). 不在列表中则忽略. */
  currentVersionId?: string | null;
}

/** 从版本列表里选出弹窗默认选中的版本 id. 列表空 → '' (「不挂版本」哨兵). */
export function pickDefaultVersionId(
  versions: VersionPickEntry[],
  opts: VersionPickOptions = {},
): string {
  if (opts.preferVersionId && versions.some((v) => v.id === opts.preferVersionId)) {
    return opts.preferVersionId;
  }
  if (opts.currentVersionId && versions.some((v) => v.id === opts.currentVersionId)) {
    return opts.currentVersionId;
  }
  return versions[0]?.id ?? '';
}
