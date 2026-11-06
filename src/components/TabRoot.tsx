"use client";

// 功能: 飞书 AO-DEV R123 — 标签页根容器. 在 layout.tsx 包住 children,
//   提供 TabStoreProvider, 在 <main> 顶部渲染 TabStrip, 并通过 capture-phase
//   click 拦截器把所有内部导航转换为 openTab() 调用 — 这样左侧栏 / 页面内
//   的链接都不会直接走浏览器跳转, 而是开新 tab 或激活已存在的 tab。
// 关注点:
//   1. capture-phase 拦截在 Next.js <Link> bubble handler 之前触发; 我们调用
//      e.preventDefault() 后 Link 看到 defaultPrevented=true 就提前 return,
//   所以本拦截器是唯一的导航入口, 不会双 push.
//   2. 跳过规则: modifier 键 (Cmd/Ctrl/Shift/Alt) — 让浏览器开新 tab;
//      外链 / mailto: / tel: / target=_blank / download — 让浏览器原行为;
//      仅 hash (#frag) — 让浏览器原行为; 全屏页 (/, /login, /register) —
//      虽然不进 tab store, 但点击这些链接应正常跳转, 不被拦截.
//   3. TabStrip 仅在 pathname 不属于全屏页时显示, 避免与登录页冲突.

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  TabStoreProvider,
  useTabStore,
  isFullPagePath,
} from "@/lib/tabs/store";
import TabStrip from "@/components/TabStrip";

export default function TabRoot({ children }: { children: ReactNode }) {
  return (
    <TabStoreProvider>
      <TabRootInner>{children}</TabRootInner>
    </TabStoreProvider>
  );
}

function TabRootInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { openTab } = useTabStore();
  const fullPage = isFullPagePath(pathname);

  // 全局 capture-phase click 拦截: 抓 <a> 点击, 命中规则时调 openTab() + preventDefault.
  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; // 只处理左键
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 修饰键 = 浏览器开新 tab

      const target = e.target as HTMLElement | null;
      if (!target) return;
      const anchor = target.closest("a");
      if (!anchor) return;

      // 原生行为例外
      const hrefAttr = anchor.getAttribute("href");
      if (!hrefAttr) return;
      if (hrefAttr.startsWith("#")) return; // 纯 hash 跳转
      if (anchor.target === "_blank") return;
      if (anchor.hasAttribute("download")) return;
      if (
        hrefAttr.startsWith("mailto:") ||
        hrefAttr.startsWith("tel:") ||
        hrefAttr.startsWith("javascript:")
      ) {
        return;
      }

      // 跨域外链: 让浏览器处理 (本应用不会跨域跳, 这是兜底).
      try {
        const url = new URL(hrefAttr, window.location.href);
        if (url.origin !== window.location.origin) return;
      } catch {
        return; // href 解析失败, 让它原行为
      }

      // 拦截, 调用 openTab (它内部会用 router.push).
      e.preventDefault();
      openTab(hrefAttr);
    }

    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [openTab]);

  // 全屏页 (/, /login, /register) 不渲染 TabStrip — 这些路径没有左侧栏,
  // 把 tab strip 也藏起来保持视觉一致 (与 NavSidebar 同源判断).
  if (fullPage) return <>{children}</>;

  return (
    <div className="flex flex-col h-full min-h-0">
      <TabStrip />
      <div className="flex-1 min-w-0 min-h-0">{children}</div>
    </div>
  );
}