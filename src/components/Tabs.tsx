"use client";

// 通用 tab 容器 —— URL ?<param>=<id> 持久化选中态, 支持默认 tab 兜底.
// 用法:
//   <Tabs tabs={[
//     { id: "usage", label: "用量统计", render: () => <UsageTab /> },
//     { id: "dimensions", label: "维度分析", render: () => <DimensionsTab /> },
//   ]} />
// 关注点:
//   1. useSearchParams 必须包在 Suspense 内, 否则 Next.js 静态生成会失败 (这里在 page.tsx 包).
//   2. 未知 id (URL 被人手改坏) 自动回退到第一个 tab, 不抛错.
//   3. 点击切换 = push 而不是 replace, 保留历史栈, 用户可后退回上一个 tab.

import { useRouter, useSearchParams, usePathname } from "next/navigation";

export interface TabDef {
  id: string;
  label: string;
  render: () => React.ReactNode;
}

interface TabsProps {
  tabs: TabDef[];
  paramName?: string;
}

export default function Tabs({ tabs, paramName = "tab" }: TabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const fromUrl = searchParams.get(paramName);
  const current = tabs.find((t) => t.id === fromUrl) ?? tabs[0];

  const select = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, id);
    router.push(`${pathname}?${params.toString()}`);
  };

  if (!current) {
    return (
      <div className="text-sm text-gray-400">无 tab 可显示</div>
    );
  }

  return (
    <div>
      <div className="border-b border-gray-200 flex gap-1" role="tablist">
        {tabs.map((t) => {
          const active = t.id === current.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => select(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="mt-6">{current.render()}</div>
    </div>
  );
}