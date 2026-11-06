/** 纯函数: 给定用户偏好 + 当前路由 project, 决定项目是否展开.
 *  镜像 master NavigationTree.tsx:resolveProjectExpanded (R59).
 *
 *  - 用户偏好 (userPref[id]) 优先: 一旦用户 toggle 过, 以用户选择为准,
 *    auto-expand 不会再覆盖 (避免 "页面激活态下菜单收不起来" 回归).
 *  - 没动过的项目: 当前路由命中时自动展开, 其余折叠. */
export function resolveProjectExpanded(
  userPref: Record<string, boolean>,
  projectId: string,
  effectiveProjectId: string | null,
): boolean {
  if (Object.prototype.hasOwnProperty.call(userPref, projectId)) {
    return userPref[projectId];
  }
  return projectId === effectiveProjectId;
}
