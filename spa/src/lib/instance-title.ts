// 功能: 按浏览器访问入口判定实例身份, 返回完整页面 title (R193 起按入口区分; 2026-10-25 damo 拍板格式 提调（env）)。
// 关注点: 一份 SPA dist 服务多实例 (deploy.sh 只 build 一次, mac/air 实例各用各的 checkout),
//   无法在 build 时按实例注入, 只能运行时按 location 判断。
//   覆盖入口: 公网域名 (经 pulu nginx, 浏览器 port=443) + WSL 直连 13001 (dev) / 13000 (wsl LAN IP)。
//   localhost:13000 在 mac/wsl 各机本机都是 13000, 客户端无法区分 → 落默认 提调（Tidiao）。
//   air 实例 checkout 在旧版 (无本逻辑), 其域名入口的 title 由 pulu nginx sub_filter 兜底改写。
//   新增实例域名入口时在此表追加, 并同步 docs/claude-config/docs/env-capabilities.md 口径。
export function instanceTitle(hostname: string, port: string): string {
  if (port === '13001' || hostname === 'dev.example.com') return '提调（dev）';
  if (hostname === 'mac.example.com') return '提调（mac）';
  if (hostname === 'air.example.com') return '提调（air）';
  if (hostname === 'ao.example.com') return '提调（pulu）';
  if (hostname === 'dao.example.com' || hostname === '192.0.2.50') return '提调（wsl）';
  return '提调（Tidiao）';
}
