"use client";

// Left panel for Chat view — task list sorted by update time, WeChat-like.

import { STATUS_LABELS, STATUS_DOT, TYPE_LABELS } from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useTick } from "@/lib/hooks/use-tick";
import type { TaskTrimmed } from "@/lib/runtime/types";
import { getRequirementChipMeta } from "@/lib/runtime/requirement-chip";
import TaskStatusChip from "@/components/TaskStatusChip";

interface ChatTaskListProps {
  tasks: TaskTrimmed[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  // Scope labels — 让 chat 列表每条 task 显示所属项目/版本
  // 单项目 caller 也传 (一致:全部 task 同 project 也照样显示)
  projectNames?: Record<string, string>;
  versionNames?: Record<string, string>;
}

function formatRelativeTime(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return "";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${M}-${D} ${h}:${m}`;
}

export default function ChatTaskList({ tasks, selectedTaskId, onSelectTask, onNewTask, projectNames, versionNames }: ChatTaskListProps) {
  // R161: 每 60s 强制 re-render 让任务时间显示自动刷新 (分钟级精度足够).
  useTick(60_000);

  const sorted = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <div className="flex flex-col h-full">
      {/* New chat button */}
      <div className="p-3 border-b border-gray-200">
        <button
          onClick={onNewTask}
          className="w-full px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center justify-center gap-2"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
          </svg>
          新建聊天
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm">暂无任务</div>
        )}
        {sorted.map((task) => {
          const isSelected = task.id === selectedTaskId;
          const dotClass = STATUS_DOT[task.status] || "bg-gray-400";
          // R94: 关联需求点 chip — 仅 reviewing 时显示 (3 个中间态之一). 与标题同行, 不截断标题.
          const reqChip = getRequirementChipMeta(task);
          return (
            <button
              key={task.id}
              onClick={() => onSelectTask(task.id)}
              className={`
                w-full text-left px-3 py-3 border-b border-gray-100 transition-colors
                ${isSelected
                  ? "bg-blue-50 border-l-2 border-l-blue-500"
                  : "hover:bg-gray-50 border-l-2 border-l-transparent"
                }
              `}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
                <span className={`text-sm truncate flex-1 ${isSelected ? "font-medium text-gray-900" : "text-gray-800"}`}>
                  {task.title}
                </span>
                {/* R99+R103: 由定时任务派发的 task 在「任务状态」同一行显示「定时」标签.
                    判据 task.schedule_id 非空 (覆盖 cron + once 两种 schedule_type).
                    R103: 弱化样式 — 由 indigo chip 改为纯灰文字注释, 不抢 status badge 视觉. */}
                {task.schedule_id && (
                  <span
                    className="inline-flex items-center text-[10px] shrink-0 text-gray-400"
                    title="由定时任务派发 (cron / once)"
                  >
                    定时
                  </span>
                )}
                {reqChip && (
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] shrink-0 ${reqChip.color}`}
                    title={reqChip.title}
                  >
                    {reqChip.label}
                  </span>
                )}
                {/* R109 续 (v129): chat 视图左侧任务列表补 sub-status chip —
                    与 board/kanban/global/requirements 4 视图同口径, 数据源
                    task.latest_checkpoint_status (listTasksPage 已带). 组件
                    自身 null 时不渲染, 不需外层条件. */}
                <TaskStatusChip status={task.latest_checkpoint_status} />
                <span className="text-xs text-gray-400 shrink-0">
                  {formatRelativeTime(task.updated_at)}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-4">
                <span className="text-xs text-gray-400 truncate flex-1">
                  {task.prompt_preview.slice(0, 60)}
                </span>
                {task.type && (
                  <span className="text-xs text-gray-400 shrink-0">
                    {TYPE_LABELS[task.type] || task.type}
                  </span>
                )}
              </div>
              {projectNames && task.project_id && (
                <div className="text-[11px] text-gray-400 truncate pl-4 mt-0.5">
                  <span>{projectNames[task.project_id] || "?"}</span>
                  {task.version_id && versionNames && (
                    <>
                      <span className="mx-1">›</span>
                      <span>{versionNames[task.version_id] || "?"}</span>
                    </>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
