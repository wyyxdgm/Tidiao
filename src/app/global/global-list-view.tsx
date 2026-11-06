"use client";

// 功能: /global 列表视图 — 表格形态, 支持分页 + 行内跳转 + 操作按钮.
// 关注点:
//   - 数据源直接接收 global-board 的 filteredTasks (已合 active+terminal + 全筛选),
//     不再独立 fetch — 复用筛选条 (project/version/model/tag/search/showDeleted/favorite).
//   - 分页: pageSize/page/pageItems 由 <Pagination> 通过 children render prop 提供,
//     单一真相, 杜绝 list view 与 Pagination 各自算 pageSize 漂移 (R122 第三轮 #4).
//   - 行内操作: STATUS_BUTTONS 状态→按钮映射, 覆盖所有状态应有的操作. reviewing
//     三连击: 完成(approve) / 驳回(reject, 必填 feedback) / 清空重来(restart).
//   - 表格定高 + 分页 fixed bottom: 容器用 flex-col + max-h-[calc(100vh-X)] + 表格
//     flex-1 + overflow-y-auto, 分页 sticky 底部 (R122 第三轮 #5).
//   - 操作调 /api/tasks/{id}/{action}, 失败 toast. 成功乐观更新由 global-board 监听
//     SSE 或 refreshAll 接管, 此处不直接 patch 数组 (避免双源).
//   - SSE 不挂 (列表心智 = 看历史, 实时刷新会跳行); 切回 cards/kanban 自动重连.

import { useState, useCallback } from "react";
import Link from "next/link";
import {
  STATUS_LABELS, STATUS_COLORS, TYPE_LABELS, TYPE_COLORS,
  BOARD_ACTIVE_STATUSES, BOARD_TERMINAL_STATUSES,
  canDeleteTask,
} from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useTick } from "@/lib/hooks/use-tick";
import { useToastActions } from "@/components/Toast";
import Pagination from "@/components/Pagination";
import ConfirmDialog from "@/components/ConfirmDialog";
import TaskStatusChip from "@/components/TaskStatusChip";
import type { TaskTrimmed } from "@/lib/runtime/types";

const ACTIVE_STATUS_SET = new Set<string>(BOARD_ACTIVE_STATUSES);
const TERMINAL_STATUS_SET = new Set<string>(BOARD_TERMINAL_STATUSES);

function formatUpdatedAt(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return "";
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${M}-${D} ${h}:${m}`;
}

// 状态 → 该状态行内可点的操作按钮 (R122 第三轮 #3: 全状态核对口径).
// - pending/queued: 启动 / 取消
// - running: 暂停 / 取消
// - paused: 恢复 / 取消
// - reviewing: 完成(approve) / 继续干(refine) / 清空重来(restart) / 取消
// - verifying: 取消 (自动跑, 仅允许终止)
// - await_user: 继续执行(unawait) / 完成(approve) / 取消
// - completed: 仅删除 (canDeleteTask 守门)
// - failed/rejected/cancelled: 重启(start) / 删除
// - 已删: 仅恢复
const STATUS_BUTTONS: Record<string, Array<{ key: string; label: string; tone?: "primary" | "danger" }>> = {
  pending:   [{ key: "start", label: "启动" }, { key: "cancel", label: "取消", tone: "danger" }],
  queued:    [{ key: "start", label: "启动" }, { key: "cancel", label: "取消", tone: "danger" }],
  running:   [{ key: "pause", label: "暂停" }, { key: "cancel", label: "取消", tone: "danger" }],
  paused:    [{ key: "resume", label: "恢复", tone: "primary" }, { key: "cancel", label: "取消", tone: "danger" }],
  reviewing: [
    { key: "approve", label: "完成", tone: "primary" },
    { key: "refine", label: "继续干", tone: "primary" },
    { key: "restart", label: "🔄 清空重来", tone: "danger" },
    { key: "cancel", label: "取消", tone: "danger" },
  ],
  verifying: [{ key: "cancel", label: "取消", tone: "danger" }],
  // 🆕 R131 (damo 2026-09-15): await_user 状态行内操作.
  await_user: [
    { key: "approve", label: "完成", tone: "primary" },
    { key: "unawait", label: "继续执行", tone: "primary" },
    { key: "cancel", label: "取消", tone: "danger" },
  ],
  completed: [{ key: "delete", label: "删除", tone: "danger" }],
  failed:    [{ key: "start", label: "重试", tone: "primary" }, { key: "delete", label: "删除", tone: "danger" }],
  // 历史兼容: rejected 状态保留"重做"按钮 (走 start 路径).
  rejected:  [{ key: "start", label: "重做", tone: "primary" }, { key: "delete", label: "删除", tone: "danger" }],
  cancelled: [{ key: "start", label: "重启", tone: "primary" }, { key: "delete", label: "删除", tone: "danger" }],
};

interface GlobalListViewProps {
  tasks: TaskTrimmed[];
  projects: { id: string; name: string }[];
  projectNames: Record<string, string>;
  versionNames: Record<string, string>;
}

export default function GlobalListView({
  tasks,
  projects,
  projectNames,
  versionNames,
}: GlobalListViewProps) {
  const { error: toastError, warning: toastWarning } = useToastActions();
  // R161: 每 60s 强制 re-render 让任务时间显示自动刷新 (分钟级精度足够).
  useTick(60_000);

  // 🆕 R131 (damo 2026-09-15): refine 弹框 state (替旧 reject).
  const [refineDialog, setRefineDialog] = useState<{ taskId: string; taskTitle: string } | null>(null);
  const [refineMessage, setRefineMessage] = useState("");

  // 行内操作. 走与 global-board 同源端点.
  // 不在本地 patch 数组; 依赖 SSE 或下次筛选触发 refresh.
  const runAction = useCallback(
    async (taskId: string, action: string, body?: Record<string, unknown>) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/${action}`, {
          method: "POST",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "unknown" }));
          toastError(`${action} 失败: ${err.error}`);
          return;
        }
        // start 在并发已满时后端真返 status=queued, 提示用户.
        if (action === "start") {
          const data = await res.json().catch(() => null);
          if (data?.status === "queued") {
            toastWarning("已加入排队, 并发已满, 等槽位空闲后自动运行");
          }
        }
      } catch (err: any) {
        toastError(`网络错误: ${err.message}`);
      }
    },
    [toastError, toastWarning],
  );

  // 🆕 R131: refine 弹框提交 (替旧 submitReject). message 可选.
  const submitRefine = useCallback(async () => {
    if (!refineDialog) return;
    await runAction(refineDialog.taskId, "refine", { message: refineMessage.trim() || undefined });
    setRefineDialog(null);
    setRefineMessage("");
  }, [refineDialog, refineMessage, runAction]);

  // 抑制未用警告 (projects prop 保留便于未来加项目级操作).
  void projects;

  if (tasks.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="text-4xl mb-3">📭</div>
        <p className="text-gray-500 text-sm">没有匹配筛选条件的任务</p>
      </div>
    );
  }

  // Pagination 用 children render prop 提供 pageItems — 单一真相, 杜绝
  // list view 内部重算 pageSize 与 Pagination 漂移 (R122 #4).
  return (
    <div className="flex flex-col flex-1 min-h-0 px-6 py-4">
      <Pagination items={tasks} pageSizeOptions={[10, 20, 50, 100]} paramKey={{ page: "page", size: "pageSize" }}>
        {({ pageItems }) => (
          <>
            {/* 表格区域 — flex-1 占满剩余空间, 内部 overflow 让长列表可滚 */}
            <div className="flex-1 min-h-0 bg-white rounded-lg border border-gray-200 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-gray-600 sticky top-0 z-10">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">标题</th>
                    <th className="text-left px-3 py-2 font-medium w-32">项目</th>
                    <th className="text-left px-3 py-2 font-medium w-28">版本</th>
                    <th className="text-left px-3 py-2 font-medium w-24">状态</th>
                    <th className="text-left px-3 py-2 font-medium w-20">类型</th>
                    <th className="text-left px-3 py-2 font-medium w-28">更新时间</th>
                    <th className="text-right px-3 py-2 font-medium min-w-[280px]">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((task) => {
                    const isDeleted = !!task.deleted_at;
                    const buttons = isDeleted
                      ? [{ key: "restore", label: "恢复", tone: "primary" as const }]
                      : STATUS_BUTTONS[task.status] || [];

                    return (
                      <tr
                        key={task.id}
                        className={`border-b border-gray-100 hover:bg-gray-50 ${
                          isDeleted ? "opacity-60" : ""
                        }`}
                      >
                        <td className="px-3 py-2 max-w-xs">
                          <Link
                            href={`/tasks/${task.id}`}
                            title={(() => {
                              // R122 第六轮 #2: hover 显示 result_preview (大模型最后输出),
                              // 缺失则用 prompt_preview, 再缺用 title. 截断 300 字避免悬停气泡过长.
                              const result = (task as { result_preview?: string | null }).result_preview;
                              const prompt = (task as { prompt_preview?: string | null }).prompt_preview;
                              const text = (result && result.trim()) || (prompt && prompt.trim()) || task.title;
                              return text.slice(0, 300);
                            })()}
                            className="text-gray-900 hover:text-blue-600 font-medium line-clamp-1"
                          >
                            {task.title}
                          </Link>
                          {task.priority > 0 && (
                            <span className="ml-1 text-xs text-orange-500">P{task.priority}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-600 truncate">
                          {task.project_id ? projectNames[task.project_id] || "?" : "-"}
                        </td>
                        <td className="px-3 py-2 text-gray-600 truncate">
                          {task.version_id ? versionNames[task.version_id] || "?" : "-"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs ${
                              STATUS_COLORS[task.status as keyof typeof STATUS_COLORS] || "bg-gray-100"
                            }`}
                          >
                            {STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || task.status}
                          </span>
                          {/* R109 续 (v129): 全局列表 (表格视图) 补 sub-status chip —
                              与 board/kanban/chat/requirements 同口径, 数据源
                              task.latest_checkpoint_status. 组件 null 时不渲染. */}
                          <TaskStatusChip status={task.latest_checkpoint_status} />
                        </td>
                        <td className="px-3 py-2">
                          {task.type && (
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs border ${
                                TYPE_COLORS[task.type] || "bg-gray-50 text-gray-500 border-gray-200"
                              }`}
                            >
                              {TYPE_LABELS[task.type] || task.type}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-500 text-xs">
                          {formatUpdatedAt(task.updated_at)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {/* R122 第六轮 #3: 移动端按钮被挤一列 — 操作列定 min-w + 按钮
                              whitespace-nowrap, 内容在 lg 以下自动换行. md 屏以下整列折行. */}
                          <div className="flex flex-wrap gap-1 justify-end lg:flex-nowrap lg:space-x-1">
                          {buttons.map((btn) => {
                            // 🆕 R131 (damo 2026-09-15): refine 取代 reject 弹框按钮.
                            if (btn.key === "refine") {
                              return (
                                <button
                                  key={btn.key}
                                  onClick={() => {
                                    setRefineDialog({ taskId: task.id, taskTitle: task.title });
                                    setRefineMessage("");
                                  }}
                                  className="px-2 py-0.5 text-xs border border-blue-300 text-blue-600 rounded hover:bg-blue-50"
                                  title="让 agent 接着干 (消息可选)"
                                >
                                  {btn.label}
                                </button>
                              );
                            }
                            const toneClass =
                              btn.tone === "danger"
                                ? "border-gray-300 hover:bg-red-50 hover:text-red-600"
                                : btn.tone === "primary"
                                ? "border-blue-300 text-blue-600 hover:bg-blue-50"
                                : "border-gray-300 hover:bg-gray-100";
                            return (
                              <button
                                key={btn.key}
                                onClick={() => {
                                  if (btn.key === "delete" && !canDeleteTask(task.status, task.deleted_at)) {
                                    toastError("无法删除此任务");
                                    return;
                                  }
                                  runAction(task.id, btn.key);
                                }}
                                className={`px-2 py-0.5 text-xs border rounded whitespace-nowrap ${toneClass}`}
                                title={`${btn.label}任务`}
                              >
                                {btn.label}
                              </button>
                            );
                          })}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Pagination>

      {/* 🆕 R131 (damo 2026-09-15): refine 弹框 (替旧 reject). message 可选. */}
      <ConfirmDialog
        open={!!refineDialog}
        title="让 agent 接着干"
        message={
          <div className="text-left">
            <p className="mb-2 text-sm text-gray-700">
              任务从 reviewing 切回 running，agent 会按新指示继续。消息可选。
            </p>
            <textarea
              value={refineMessage}
              onChange={(e) => setRefineMessage(e.target.value)}
              placeholder="(可选) 给 agent 的继续消息"
              rows={3}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
              autoFocus
            />
          </div>
        }
        confirmLabel="↻ 继续干"
        cancelLabel="取消"
        onConfirm={submitRefine}
        onCancel={() => {
          setRefineDialog(null);
          setRefineMessage("");
        }}
      />
    </div>
  );
}
