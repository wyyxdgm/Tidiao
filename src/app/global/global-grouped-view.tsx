"use client";

// 功能: /global 按项目分组视图 — 看板式横向排列, 一列 = 一个项目, 列内是该项目的任务卡片
//   (按 updated_at desc 来自 global-board 的 filteredTasks).
// 关注点:
//   - 横向布局参考 [projectId]/[versionId]/kanban-view.tsx 的容器模式:
//     flex overflow-x-auto + 列宽 320px + 列身内部 overflow-y-auto.
//   - 列 key = project_id (或 "__unassigned__" 兜底未挂项目的任务).
//   - 列头 = 项目名 + 该项目任务计数 + 可跳转 /[projectId]?mode=list 链接
//     (R122 第四轮修: 默认跳列表视图, grouped 在单 project 上下文无意义).
//   - 列内卡片 = 精简版 (标题 + 状态 chip + 时间 + 跳转), 不复用 renderTaskCard.
//     鼠标 hover 显示 result_preview / prompt_preview 提示 (R122 第六轮 #2).
//   - 列内滚动: max-h 跟随视口, 每列独立 overflow-y-auto (避免单列任务把整页拖长).
//   - 分页: 按"项目数"分页 (R122 第六轮 #4), 每页 N 个项目列. Pagination 通过
//     children render prop 提供 pageItems, grouped view 渲染当前页的列.
//   - 不挂 SSE (分组视图用户主动刷新心智).
//   - 不展开/折叠 — 全部显示, 横向滚动浏览.

import { useMemo } from "react";
import Link from "next/link";
import {
  STATUS_LABELS, STATUS_COLORS, TYPE_LABELS, TYPE_COLORS,
} from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useTick } from "@/lib/hooks/use-tick";
import Pagination from "@/components/Pagination";
import type { TaskTrimmed } from "@/lib/runtime/types";

function formatUpdatedAt(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return "";
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${M}-${D} ${h}:${m}`;
}

// 卡片 hover 提示: 优先 result_preview (大模型最后输出), 缺失则用 prompt_preview,
// 再缺用 title. R122 第六轮 #2 — "表格 hover 能否显示 result".
function buildHoverTooltip(task: TaskTrimmed): string {
  const result = (task as { result_preview?: string | null }).result_preview;
  const prompt = (task as { prompt_preview?: string | null }).prompt_preview;
  const text = (result && result.trim()) || (prompt && prompt.trim()) || task.title;
  return text.slice(0, 300);
}

interface GlobalGroupedViewProps {
  tasks: TaskTrimmed[];
  projects: { id: string; name: string }[];
  projectNames: Record<string, string>;
  versionNames: Record<string, string>;
}

interface Bucket {
  key: string;
  label: string;
  isUnassigned: boolean;
  tasks: TaskTrimmed[];
}

export default function GlobalGroupedView({
  tasks,
  projects,
  projectNames,
  versionNames,
}: GlobalGroupedViewProps) {
  // 按 project_id 分桶. 未挂项目的任务归 "__unassigned__" 单独一列, 不丢数据.
  // 列排序: 有项目的按项目名升序 (中文 localeCompare); 未分类列放最右.
  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, TaskTrimmed[]>();
    for (const t of tasks) {
      const k = t.project_id || "__unassigned__";
      const arr = map.get(k);
      if (arr) arr.push(t);
      else map.set(k, [t]);
    }
    const arr: Bucket[] = Array.from(map.entries()).map(([key, ts]) => ({
      key,
      label: key === "__unassigned__" ? "未分类" : (projectNames[key] || key.slice(0, 8)),
      isUnassigned: key === "__unassigned__",
      tasks: ts,
    }));
    arr.sort((a, b) => {
      if (a.isUnassigned) return 1;
      if (b.isUnassigned) return -1;
      return a.label.localeCompare(b.label, "zh-CN");
    });
    return arr;
  }, [tasks, projectNames]);

  // 抑制未用警告 (projects 保留 prop, 便于未来加列头跳项目页).
  void projects;

  // R161: 每 60s 强制 re-render 让任务时间显示自动刷新 (分钟级精度足够).
  useTick(60_000);

  if (tasks.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="text-4xl mb-3">📭</div>
        <p className="text-gray-500 text-sm">没有匹配筛选条件的任务</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 px-6 py-4">
      <Pagination
        items={buckets}
        pageSizeOptions={[5, 10, 20, 50]}
        paramKey={{ page: "page", size: "pageSize" }}
      >
        {({ pageItems }) => (
          <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
            <div className="flex gap-4 h-full">
              {(pageItems as Bucket[]).map((bucket) => (
                <section
                  key={bucket.key}
                  className="w-[320px] flex-shrink-0 bg-gray-50 rounded-lg border border-gray-200 flex flex-col h-full"
                >
                  <header className="px-3 py-2.5 border-b border-gray-200 bg-white rounded-t-lg flex items-center justify-between sticky top-0 z-10">
                    {bucket.isUnassigned ? (
                      <span className="font-medium text-gray-900 truncate" title="未挂项目的任务">
                        {bucket.label}
                      </span>
                    ) : (
                      <Link
                        href={`/${bucket.key}?mode=list`}
                        className="font-medium text-gray-900 hover:text-blue-600 truncate"
                        title={`跳转到 ${bucket.label} (列表视图)`}
                      >
                        {bucket.label}
                      </Link>
                    )}
                    <span className="ml-2 text-xs text-gray-500 shrink-0">
                      {bucket.tasks.length}
                    </span>
                  </header>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {bucket.tasks.map((task) => {
                      const isDeleted = !!task.deleted_at;
                      const hoverText = buildHoverTooltip(task);
                      return (
                        <Link
                          key={task.id}
                          href={`/tasks/${task.id}`}
                          title={hoverText}
                          className={`block bg-white rounded border border-gray-200 p-2.5 hover:border-blue-300 hover:shadow-sm transition-all ${
                            isDeleted ? "opacity-60" : ""
                          }`}
                        >
                          <h4 className={`text-sm font-medium text-gray-900 line-clamp-2 mb-1.5 ${isDeleted ? "line-through" : ""}`}>
                            {task.title}
                          </h4>
                          <div className="flex items-center gap-1 flex-wrap text-xs">
                            <span
                              className={`px-1.5 py-0.5 rounded-full ${
                                STATUS_COLORS[task.status as keyof typeof STATUS_COLORS] || "bg-gray-100"
                              }`}
                            >
                              {STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || task.status}
                            </span>
                            {task.type && (
                              <span
                                className={`px-1.5 py-0.5 rounded-full border ${
                                  TYPE_COLORS[task.type] || "bg-gray-50 text-gray-500 border-gray-200"
                                }`}
                              >
                                {TYPE_LABELS[task.type] || task.type}
                              </span>
                            )}
                            {task.priority > 0 && (
                              <span className="text-orange-500">P{task.priority}</span>
                            )}
                          </div>
                          <div className="flex items-center justify-between mt-1.5 text-xs text-gray-400">
                            <span className="truncate">
                              {task.version_id ? versionNames[task.version_id] || "?" : "—"}
                            </span>
                            <span className="shrink-0 ml-2">{formatUpdatedAt(task.updated_at)}</span>
                          </div>
                        </Link>
                      );
                    })}
                    {bucket.tasks.length === 0 && (
                      <p className="text-center text-xs text-gray-400 py-6">该列无任务</p>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </Pagination>
    </div>
  );
}
