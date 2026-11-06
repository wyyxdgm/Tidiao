// 功能: 身份切换场景的整页跳转 —— 登录 / 注册 / 切账号 / 登出 / 会话失效后跳转统一走这里.
//
// 关注点: SPA 用 hash 路由 (createWebHashHistory), `location.href = '/#/xxx'`
// 赋值在 path 不变、仅 hash 变化时浏览器**不会重载页面** (只触发 hashchange
// 软导航). 后果: pinia store (projects 项目列表 / versions 缓存 / tags 页签)
// 与 keep-alive 组件缓存全部残留上一个账号的数据, projects.load() 又因
// `projects.length > 0` 早退永不重拉 —— 切账号后侧栏还显示旧账号的项目
// (2026-10-26 实证). 这里赋值后显式 reload 强制全新页面: 所有内存态清零,
// router beforeEach 重新 checkSession, store 从新 cookie 冷启动.
// 目标 URL 与当前相同时 href 赋值是 no-op, reload 照常兜底.
export function hardNavigate(url: string): void {
  const target = new URL(url, window.location.origin).href;
  if (window.location.href !== target) {
    window.location.href = target;
  }
  window.location.reload();
}
