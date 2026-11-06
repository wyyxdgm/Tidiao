import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow better-sqlite3 native module
  serverExternalPackages: ["better-sqlite3"],
  // dev mode 下 192.0.2.50 (WSL 内网) 直连的 cross-origin 警告：
  // 默认 Next 16 dev 拒绝跨源访问 _next 资源（webpack-hmr / fonts），
  // WSL 上跑 next dev 必须显式列出这台 IP。
  // 加上 ao-prod.wsl / ao-dev.wsl 后，浏览器走 WSL nginx 反代（80 端口）
  // 用这两个 host 访问时 HMR WebSocket 才不被 dev server 当跨源拒绝。
  // 用 .wsl 后缀不用 .local 是避开 macOS mDNS（RFC 6762 把 .local 保留给 mDNS，
  // 即使 hosts 已绑 IP，mDNSResponder 仍可能尝试多播解析，有边角问题）。
  allowedDevOrigins: ["192.0.2.50", "localhost", "127.0.0.1", "ao-prod.wsl", "ao-dev.wsl", "dev.example.com"],
  experimental: {
    // Next 16 buffers request bodies for the middleware/proxy layer up to this
    // size (default 10MB); anything larger is truncated, which corrupts
    // multipart parsing in the attachments upload route. 12MB gives headroom
    // above the route's own 10MB MAX_SIZE so a full 10MB file + multipart
    // framing parses intact; the route still rejects >10MB files with 413 via
    // a Content-Length pre-check + file.size check.
    proxyClientMaxBodySize: 12 * 1024 * 1024,
  },
  // R59+ integration: SPA 由 src/app/route.ts (根 GET) 出 public/index.html。
  // 不用 rewrites(): Next.js 16 rewrites destination → /index.html 在 app router
  // + middleware 存在时不达预期 (实测 middleware 把 /index.html 当非公开路径
  // 重定向到 /login, 即使 pathname 是 rewrite 后的)。route handler 是唯一稳的
  // 走法 —— 绕过 layout.tsx 的 NavSidebar/TabRoot React 包裹。
};

export default nextConfig;
