import type { Metadata, Viewport } from "next";
import "./globals.css";
import NavSidebar from "@/components/NavSidebar";
import AuthGuard from "@/components/AuthGuard";
import ToastProvider from "@/components/Toast";
import TabRoot from "@/components/TabRoot";
import { getPageTitle } from "@/lib/runtime/page-title";

// 标题按环境区分: pulu 不动, prod 加 [PROD], dev 加 [DEV] (飞书 AO-DEV R26).
// 飞书 AO-DEV R146: 补 og:image / twitter card, 共享链接时不再裸奔.
export function generateMetadata(): Metadata {
  return {
    title: getPageTitle(),
    description: "管理 Claude Code Agent 任务队列",
    openGraph: {
      title: getPageTitle(),
      description: "管理 Claude Code Agent 任务队列",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: getPageTitle(),
      description: "管理 Claude Code Agent 任务队列",
    },
  };
}

// viewportFit: "cover" 使 env(safe-area-inset-*) 在 iPhone notch 设备上返回非零值；
// 固定元素（汉堡按钮、抽屉关闭）据此避开状态栏/灵动岛。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" className="h-full">
      <body className="h-full bg-gray-50 text-gray-900 antialiased">
        <ToastProvider>
          <AuthGuard />
          {/* R122 第七轮: 根容器 min-h-screen → h-screen overflow-hidden.
              旧版 min-h-screen 只设下限, 内容超 100vh 时整页撑高 → body 滚动.
              改成 h-screen 后内容在 main 内部各自滚动, 整体页面永不滚. */}
          <div className="flex h-screen overflow-hidden">
            <NavSidebar />
            {/* 飞书 AO-DEV R123: tab 容器, 包住右侧内容, 顶部显示已打开 tab + 拦截内链开新 tab */}
            <main className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
              <TabRoot>{children}</TabRoot>
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}