// R59+ integration: SPA 整合进 next-server, 根路径由本 route handler 出 SPA HTML。
//
// 为什么不走 rewrites() (/ → /index.html): Next.js 16 rewrites destination 到
// public/ 静态文件的路径在 app router + page 存在时不被应用, 仍走 app/page.tsx;
// 即使 app/page.tsx 删了, /index.html 走到 middleware 的非公开白名单会被重定向到
// /login。所以用 route handler: 绕过 layout.tsx 的 NavSidebar/TabRoot 等 React
// 包裹, 直接把 SPA 的 HTML (含 Vue mount 节点 + assets 引用) 原样吐回。
//
// 关注点:
//   - public/index.html 是 SPA build 产物 (spa/dist/index.html), deploy 时由
//     scripts/deploy.sh 的 push_spa_dist_to_target 推到 public/。dev 模式
//     缺文件 → 503 + 提示「先跑 cd spa && npm run build」。
//   - Content-Type 必须 text/html; charset=utf-8, 否则浏览器按二进制解析,
//     Vue mount 失败。
//   - 不缓存: hash 路由下所有路径都打到 /, 但 HTML 自身经常变 (asset hash 轮换)。
//   - middleware 会先跑 (pathname === "/" → public → 放行), 所以无 cookie 也能访问。
import fs from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const htmlPath = path.join(process.cwd(), 'public', 'index.html');
  let html: string;
  try {
    html = await fs.readFile(htmlPath, 'utf-8');
  } catch (e) {
    return new Response(
      `<h1>SPA not built</h1>
       <p>expected: <code>${htmlPath}</code></p>
       <p>Run <code>npm run build:spa</code> first (builds the Vue web UI into <code>public/</code>), then refresh this page.</p>
       <pre>${(e as Error).message}</pre>`,
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}