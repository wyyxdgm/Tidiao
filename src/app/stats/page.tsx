"use client";

// R122 / T1.2: /stats 页面退化为 tab 容器, 本期只上线 "用量统计" tab.
// 后 3 个 tab (dimensions / requirements / periodic) 二期实施, 当前显示占位.

import { Suspense } from "react";
import Link from "next/link";
import Tabs from "@/components/Tabs";
import UsageTab from "./tabs/usage";
import DimensionsTab from "./tabs/dimensions";
import RequirementsTab from "./tabs/requirements";
import PeriodicTab from "./tabs/periodic";

export default function StatsPage() {
  return (
    // 🆕 飞书 R139 第二批: 右滚修复 — 同 schedules/runners 套路.
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <Link href="/" className="text-gray-600 hover:text-gray-900 text-sm">
          ← 返回
        </Link>
        <h1 className="text-xl font-semibold mt-2">统计看板</h1>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-5xl w-full mx-auto px-6 py-6">
        <Suspense fallback={<div className="text-gray-400">加载中...</div>}>
          <Tabs
            tabs={[
              { id: "usage", label: "用量统计", render: () => <UsageTab /> },
              { id: "dimensions", label: "维度分析", render: () => <DimensionsTab /> },
              { id: "requirements", label: "需求分析", render: () => <RequirementsTab /> },
              { id: "periodic", label: "周期统计", render: () => <PeriodicTab /> },
            ]}
          />
        </Suspense>
      </main>
    </div>
  );
}