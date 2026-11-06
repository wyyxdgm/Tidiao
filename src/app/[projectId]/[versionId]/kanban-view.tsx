"use client";

// Kanban board view — columns driven by selected statuses and column order.
// Each status = one column. Column headers are draggable for reordering.
//
// 移动端 (< md, 768px): 状态 tab 条 + 单列视图, 避免横滑多列 + 280px 列宽灾难.
//   - mobileStatusTab 默认选中第一个可见 status;
//   - 切换 tab 只显示该 status 的 task 列表;
//   - 拖拽 (HTML5 drag) 在触摸不触发, pre-existing 限制, **不变** 也不加重.
// 桌面端 (>= md): 多列横滑 (兼容现状).
//   - per-column cap = 50, 超出的折叠成 "展开更多 (N)" 按钮 (Phase 4 落地);
//     调用 onLoadMoreTerminal 加载下一页后客户端按 status 切片.
//   - 全部加载完后, 按钮消失, 列底不再有折叠.

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { STATUS_LABELS, STATUS_COLORS, TYPE_LABELS, TYPE_COLORS, VALID_STATUS_TRANSITIONS, getStatusDragAction, BOARD_TERMINAL_STATUSES, canDeleteTask } from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useTick } from "@/lib/hooks/use-tick";
import type { TaskTrimmed } from "@/lib/runtime/types";
import { computeCrossColumnDrop } from "./kanban-drop-position";
import { getRequirementChipMeta } from "@/lib/runtime/requirement-chip";
import TaskByChip from "@/components/TaskByChip";
import TaskStatusChip from "@/components/TaskStatusChip";
import AwaitingReasonChip from "@/components/AwaitingReasonChip";

const TERMINAL_STATUS_SET = new Set<string>(BOARD_TERMINAL_STATUSES);
// 每列最多展示 50 张卡片. 超出折叠, 等用户点 "展开更多" 加载下一页再补.
const COLUMN_CAP = 50;

interface KanbanViewProps {
  tasks: TaskTrimmed[];
  selectedStatuses: Set<string>;
  columnOrder: string[];
  onColumnOrderChange: (order: string[]) => void;
  onStatusChange: (taskId: string, action: string) => void;
  onDelete: (taskId: string, taskTitle: string, e: React.MouseEvent) => void;
  onRestore: (taskId: string, e: React.MouseEvent) => void;
  // v510: 看板手动排序 — 用户在同一列内上下拖动 task card. 拖完后 onReorder
  //   收 (colKey, 完整 taskId 数组新顺序). 父组件负责写 DB (POST /api/tasks/
  //   queue-order) + 通知调度器重排 + 本地 state patch. 若未传, 拖动功能
  //   退化为「无效果」(避免老 caller 静默丢意图).
  onReorder?: (colKey: string, orderedTaskIds: string[]) => void;
  // Optional scope labels — when provided, cards show project/version names so
  // the global board view can distinguish tasks across projects. Backward
  // compatible: existing version-scoped callers omit this.
  scopeLabels?: {
    projectNames: Record<string, string>;
    versionNames: Record<string, string>;
  };
  // 终端态分页信息 (Phase 4 用). 全局视图 (global-board) 传, 单版本视图也传.
  // 当某 terminal 列的"真实总数"超过此列已渲染数时, 列底显示"展开更多"按钮.
  terminalTotal?: number;
  terminalLoaded?: number;
  onLoadMoreTerminal?: () => void;
  isLoadingMore?: boolean;
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

// v510: 看板列内排序 — 优先 queued_order ASC NULLS LAST (用户拖拽过的),
//   没排过的回落到 updated_at DESC (与改造前一致). Array.prototype.sort 稳定,
//   tie-break = 入列顺序, 不会跳变. queued_order 都 NULL (用户没排过) 时
//   排序退化为纯 updated_at DESC, 行为与改造前 byte-identical.
function sortTasksForKanban(list: TaskTrimmed[]): TaskTrimmed[] {
  return [...list].sort((a, b) => {
    const ao = a.queued_order;
    const bo = b.queued_order;
    const aHas = ao !== null && ao !== undefined;
    const bHas = bo !== null && bo !== undefined;
    if (aHas && bHas) return ao - bo;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    // 都未排过 → 走 updated_at DESC; 解析到 ms 避免 SQLite/ISO 格式混淆
    // (R149, 与 chat-task-list 同款).
    return (parseDbTime(b.updated_at)?.getTime() ?? 0) - (parseDbTime(a.updated_at)?.getTime() ?? 0);
  });
}

// R84: 扩展 chip type — review→"需拍板" + 加 waiting_reply/suggestion/stuck 对应飞书 O 列四态子集。
// 与 board-client.tsx / task-header.tsx 的同名函数同款语义, 复刻一份因为三个组件
// 边界不同 (board 走 TaskTrimmed + DecisionBanner, task-header 走 Task, kanban 走
// TaskTrimmed 但只取 chips). 后续真要统一, 抽到 @/lib/awaiting-markers.ts 即可.
function parseAwaitingMarkers(
  awaitingMarkersJson: string | null,
  awaitingOwnerReview: number,
): Array<{ label: string; title: string; color: string }> {
  // R84: 加 waiting_reply / suggestion / stuck + 把 review label 改为"需拍板"
  //   对齐 R84 文案。颜色与现有 type 不撞，与 board-client TYPE_COLORS_R39 同源。
  const TYPE_META: Record<string, { color: string; cn: string }> = {
    review: { color: "bg-amber-100 text-amber-800 border-amber-200", cn: "需拍板" },
    choice: { color: "bg-blue-100 text-blue-800 border-blue-200", cn: "等选" },
    info: { color: "bg-gray-100 text-gray-700 border-gray-200", cn: "提示" },
    waiting_reply: { color: "bg-cyan-100 text-cyan-800 border-cyan-200", cn: "等回复" },
    suggestion: { color: "bg-emerald-100 text-emerald-800 border-emerald-200", cn: "有建议" },
    stuck: { color: "bg-red-100 text-red-800 border-red-200", cn: "卡住" },
  };
  if (awaitingMarkersJson) {
    try {
      const parsed = JSON.parse(awaitingMarkersJson) as Array<{ type?: string; desc?: string | null }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m) => {
          const t = (m.type || "review").toLowerCase();
          const meta = TYPE_META[t] || {
            color: "bg-purple-100 text-purple-800 border-purple-200",
            cn: t || "等拍板",
          };
          const descSnippet = m.desc ? ` · ${m.desc.slice(0, 20)}${m.desc.length > 20 ? "…" : ""}` : "";
          return {
            label: `${meta.cn}${descSnippet}`,
            title: m.desc ? `${t}: ${m.desc}` : `awaiting marker (type=${t})`,
            color: meta.color,
          };
        });
      }
    } catch {
      // 解析失败静默走回退 (上层 console.warn 已在 board-client 打)
    }
  }
  // R84: review label 同步改为"需拍板"对齐 R84 文案 (与 board-client 同源).
  if (awaitingOwnerReview === 1) {
    return [
      {
        label: "需拍板",
        title: "Agent 标了需拍板 — approve 会被拒, 需先调 POST /api/tasks/[id]/unset-awaiting-review",
        color: "bg-amber-100 text-amber-800 border-amber-200",
      },
    ];
  }
  return [];
}

export default function KanbanView({
  tasks,
  selectedStatuses,
  columnOrder,
  onColumnOrderChange,
  onStatusChange,
  onDelete,
  onRestore,
  onReorder,
  scopeLabels,
  terminalTotal,
  terminalLoaded,
  onLoadMoreTerminal,
  isLoadingMore,
}: KanbanViewProps) {
  // R161: 每 60s 强制 re-render 让任务时间显示自动刷新 (分钟级精度足够).
  useTick(60_000);

  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);

  // v510: 同列内拖动排序 — draggingTaskId 当前拖动的 task; dragOverTaskId 是
  //   drop 位置参考 (排序入位: dragged 插到 dragOver 之前). 同列内有效, 跨列
  //   由 handleColDrop 接管 (那个走 status 切换).
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);
  const [dragOverColKey, setDragOverColKey] = useState<string | null>(null);

  // Column header drag state
  const [dragColKey, setDragColKey] = useState<string | null>(null);
  const [dragColOverKey, setDragColOverKey] = useState<string | null>(null);

  // Mobile detection: matchMedia(767px) 与 globals.css 的 input font-size 规则 / NavSidebar 的
  // md:hidden 用同一阈值. SSR 期间 mediaQuery 可能未定义, 给个 fallback.
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // 移动端状态 tab — 默认第一个可见 status. visibleColumns 变化时回到第一个
  // (例如用户关掉当前选中 status 时).
  // v510: 排序 — 优先 queued_order ASC NULLS LAST (用户拖拽过), 没排过
  //   的回落到 updated_at DESC. 这样「拖完一列」后整列都按用户顺序排;
  //   「没排过」的列按时间倒序 (与改造前一致).
  const visibleColumns = useMemo(() => {
    return columnOrder
      .filter((status) => selectedStatuses.has(status))
      .map((status) => ({
        key: status,
        label: STATUS_LABELS[status] || status,
        tasks: sortTasksForKanban(
          tasks.filter((t) => t.status === status),
        ),
      }));
  }, [columnOrder, selectedStatuses, tasks]);

  const [mobileStatusTab, setMobileStatusTab] = useState<string | null>(
    visibleColumns[0]?.key ?? null
  );
  // 选中的 status 被关掉时, 自动回退到第一个可见 status.
  useEffect(() => {
    if (mobileStatusTab && !visibleColumns.some((c) => c.key === mobileStatusTab)) {
      setMobileStatusTab(visibleColumns[0]?.key ?? null);
    } else if (!mobileStatusTab && visibleColumns.length > 0) {
      setMobileStatusTab(visibleColumns[0].key);
    }
  }, [visibleColumns, mobileStatusTab]);

  // 是否还有更多 terminal 任务未加载 (terminalLoaded 来自 Board 状态).
  // 任一 terminal 列未填满时, 全列底都给"展开更多"按钮.
  const terminalHasMore = !!terminalTotal && (terminalLoaded ?? 0) < terminalTotal;

  // --- Task drag-and-drop (between columns) ---

  const handleTaskDragStart = useCallback((e: React.DragEvent, taskId: string, sourceColKey: string) => {
    e.dataTransfer.setData("application/task", JSON.stringify({ taskId, sourceColKey }));
    e.dataTransfer.effectAllowed = "move";
    setDraggingTaskId(taskId);
  }, []);

  const handleTaskDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDragOverCol(null);
    setDragOverTaskId(null);
    setDragOverColKey(null);
  }, []);

  // v510: 同列内拖动 hover — 仅当拖动的是 task (不是 column header) 时
  //   接受 drop 反馈. 落在另一张 card 上 = 视觉提示「将插入到此位置」.
  //   跨列拖动由 handleColDragOver / handleColDrop 接管, 走 status 切换.
  const handleTaskItemDragOver = useCallback(
    (e: React.DragEvent, taskId: string, colKey: string) => {
      e.preventDefault();
      e.stopPropagation(); // 不冒泡到列, 避免列的 drop zone 也高亮
      if (!draggingTaskId || draggingTaskId === taskId) return;
      // 同列内才接管 — 跨列走列 drop (status 切换), 同一张 card 内拖自己
      // 不响应 (避免自己跟自己叠).
      setDragOverTaskId(taskId);
      setDragOverColKey(colKey);
    },
    [draggingTaskId],
  );

  const handleTaskItemDragLeave = useCallback((_e: React.DragEvent) => {
    // 只清自己的位置 — 鼠标从一个 card 移到另一个 card 时, 触发 dragleave
    //   + dragover, leave 先于 over, 不能无条件清. 简化: leave 时如果当前
    //   dragOverTaskId 还在, 延迟到下一次 dragover 决定. 这里直接清, 视觉
    //   上看到的是「拖到空白处 = 反馈消失」, 体验可接受.
    setDragOverTaskId(null);
  }, []);

  // v510 + R154: 同列内 drop = 仅插入排序; 跨列 drop (拖到某 card 上) =
  //   切 status + 插队到那张 card 之前. 列底空白 drop (dragOverTaskId === null)
  //   = 移到列尾 (跨列时也走列尾).
  //   与跨列 drop (handleColDrop) 互斥: 优先 card 级 drop, 没匹配才落回列级
  //   (列级只接受跨列). 视觉反馈仍由 handleTaskItemDragOver 给 (蓝色 ring =
  //   "将插入到此 card 之前"), drop 时按 sourceColKey 区分:
  //     - 同列 (sourceColKey === colKey): 仅调 onReorder, 行为与改造前一致
  //     - 跨列 (sourceColKey !== colKey): 调 onStatusChange (合法 transition 时)
  //       + onReorder. 顺序 = draggedId 插到 dragOverTaskId 之前.
  //   dataTransfer 在 drop 时仍可读 (handleColDrop 同款口径, line 304).
  const handleTaskItemDrop = useCallback(
    (e: React.DragEvent, colKey: string, orderedIdsInColumn: string[]) => {
      e.preventDefault();
      e.stopPropagation();
      const draggedId = draggingTaskId;
      const beforeId = dragOverTaskId;
      setDraggingTaskId(null);
      setDragOverTaskId(null);
      setDragOverColKey(null);
      if (!draggedId) return;

      // R154: drop 时读 sourceColKey, 区分跨列 vs 同列. dataTransfer 在 drop
      //   事件里仍可读 (HTML5 spec), handleColDrop 同款用法 line 304.
      let sourceColKey: string | null = null;
      try {
        const raw = e.dataTransfer.getData("application/task");
        if (raw) sourceColKey = JSON.parse(raw).sourceColKey ?? null;
      } catch {}

      const result = computeCrossColumnDrop({
        sourceColKey,
        targetColKey: colKey,
        draggedId,
        beforeTaskId: beforeId,
        targetColumnIds: orderedIdsInColumn,
      });
      if (result.newOrder.length === 0) return; // 兜底: draggedId 空 → noop
      if (result.crossColumn && result.action) {
        onStatusChange(draggedId, result.action);
      }
      onReorder?.(colKey, result.newOrder);
    },
    [draggingTaskId, dragOverTaskId, onReorder, onStatusChange],
  );

  const handleColDragOver = useCallback((e: React.DragEvent, colKey: string) => {
    e.preventDefault();
    // Only set drag-over if this is a task drag (not a column drag)
    if (dragColKey) return;
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(colKey);
  }, [dragColKey]);

  const handleColDragLeave = useCallback(() => {
    setDragOverCol(null);
  }, []);

  const handleColDrop = useCallback((e: React.DragEvent, targetColKey: string) => {
    e.preventDefault();
    setDragOverCol(null);
    setDraggingTaskId(null);

    try {
      const raw = e.dataTransfer.getData("application/task");
      if (!raw) return;
      const { taskId, sourceColKey } = JSON.parse(raw);

      if (sourceColKey === targetColKey) return;
      if (!VALID_STATUS_TRANSITIONS[sourceColKey]?.has(targetColKey)) return;

      const action = getStatusDragAction(sourceColKey, targetColKey);
      if (action) {
        onStatusChange(taskId, action);
      }
    } catch {}
  }, [onStatusChange]);

  // --- Column header drag-and-drop (reorder columns) ---

  const handleColHeaderDragStart = useCallback((e: React.DragEvent, colKey: string) => {
    e.dataTransfer.setData("application/column", colKey);
    e.dataTransfer.effectAllowed = "move";
    setDragColKey(colKey);
    setDragColOverKey(null);
  }, []);

  const handleColHeaderDragEnd = useCallback(() => {
    if (dragColKey && dragColOverKey && dragColKey !== dragColOverKey) {
      // Reorder: move dragColKey to where dragColOverKey is
      const newOrder = [...columnOrder];
      const fromIdx = newOrder.indexOf(dragColKey);
      const toIdx = newOrder.indexOf(dragColOverKey);
      if (fromIdx >= 0 && toIdx >= 0) {
        newOrder.splice(fromIdx, 1);
        newOrder.splice(toIdx, 0, dragColKey);
        onColumnOrderChange(newOrder);
      }
    }
    setDragColKey(null);
    setDragColOverKey(null);
  }, [dragColKey, dragColOverKey, columnOrder, onColumnOrderChange]);

  const handleColHeaderDragOver = useCallback((e: React.DragEvent, colKey: string) => {
    e.preventDefault();
    if (dragColKey && dragColKey !== colKey) {
      setDragColOverKey(colKey);
    }
  }, [dragColKey]);

  const handleColHeaderDragLeave = useCallback(() => {
    setDragColOverKey(null);
  }, []);

  // 渲染单张 kanban 卡片. desktop / mobile 共用.
  const renderKanbanCard = (task: TaskTrimmed) => {
    const canDelete = canDeleteTask(task.status, task.deleted_at);
    return (
      <div
        className={`group relative bg-white rounded-lg border p-3 cursor-grab active:cursor-grabbing hover:shadow-sm transition-all ${
          task.deleted_at ? "border-red-200 opacity-60" : "border-gray-200 hover:border-blue-300"
        }`}
      >
        {/* R105: 补删除按钮. running 中的 task 不能删 (避免中断 agent session),
            与 board-client / task-detail 同款护栏. 已删任务不显示 (父级 div 已置灰). */}
        {canDelete && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete(task.id, task.title, e);
            }}
            className="absolute top-2 right-2 p-1 rounded text-xs text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity z-10"
            title="删除任务"
          >
            🗑
          </button>
        )}
        <Link href={`/tasks/${task.id}`} className="block" draggable={false}>
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_COLORS[task.status] || "bg-gray-100"}`}>
              {STATUS_LABELS[task.status] || task.status}
            </span>
            {/* R99+R103: 定时任务派发的 task 标「定时」.
                R103: 弱化样式 — 由 indigo chip 改为纯灰文字注释, 不抢 status badge 视觉. */}
            {task.schedule_id && (
              <span
                className="text-xs text-gray-400"
                title="由定时任务派发 (cron / once)"
              >
                定时
              </span>
            )}
            {/* R57: awaiting marker chips — 等选/等拍板/提示. 之前只在卡片模式渲染,
                看板模式缺这块, 用户看不到 task 在等人拍板/选择. 复刻 board-client
                同款 (本仓三处同名函数, 后续真要统一再抽到 @/lib/awaiting-markers.ts). */}
            {parseAwaitingMarkers(task.awaiting_markers, task.awaiting_owner_review).map((m, idx) => (
              <span
                key={idx}
                className={`px-1.5 py-0.5 rounded text-xs border ${m.color}`}
                title={m.title}
              >
                {m.label}
              </span>
            ))}
            {/* R94: 关联需求 chip — 仅 reviewing 时显示. 与 awaiting_markers chip 是两套信号
                (上游需求 vs 任务自身 marker), 并存不合并. */}
            {(() => {
              const rc = getRequirementChipMeta(task);
              if (!rc) return null;
              return (
                <span
                  className={`px-1.5 py-0.5 rounded text-xs border ${rc.color}`}
                  title={rc.title}
                >
                  {rc.label}
                </span>
              );
            })()}
            {/* R108 T3: [by]<短id> chip — 与 board-client / global-board 同源. 父组件
                只在 task.dispatched_by_task_id 非空时挂载. */}
            {task.dispatched_by_task_id && (
              <TaskByChip dispatchedByTaskId={task.dispatched_by_task_id} />
            )}
            {/* R109: sub-status chip — 4 视图统一接入. 同 board-client 口径. */}
            {task.latest_checkpoint_status && (
              <TaskStatusChip status={task.latest_checkpoint_status} />
            )}
            {/* R112 续 (v129): reviewing 子终态标签. 同 board-client 口径. */}
            {task.awaiting_reason && (
              <AwaitingReasonChip reason={task.awaiting_reason} />
            )}
            {task.type && (
              <span className={`px-1.5 py-0.5 rounded text-xs border ${TYPE_COLORS[task.type] || ""}`}>
                {TYPE_LABELS[task.type] || task.type}
              </span>
            )}
            {task.priority > 0 && (
              <span className="text-xs text-orange-500">P{task.priority}</span>
            )}
          </div>
          {scopeLabels && task.project_id && (
            <div className="text-xs text-gray-400 truncate mb-0.5">
              <span>{scopeLabels.projectNames[task.project_id] || "?"}</span>
              {task.version_id && (
                <>
                  <span className="mx-1">›</span>
                  <span>{scopeLabels.versionNames[task.version_id] || "?"}</span>
                </>
              )}
            </div>
          )}
          <h4 className={`text-sm font-medium text-gray-900 line-clamp-2 ${task.deleted_at ? "line-through" : ""}`}>
            {task.title}
          </h4>
          <div className="flex items-center justify-between mt-2 text-xs text-gray-400">
            <span className="truncate">{task.resolved_model || task.model || "(default)"}</span>
            <span>{formatRelativeTime(task.updated_at)}</span>
          </div>
        </Link>
      </div>
    );
  };

  // 单列渲染: cap 50 + 展开更多. 移动端只渲染一列, 桌面端逐列调用.
  const renderColumnBody = (col: typeof visibleColumns[number]) => {
    const visibleTasks = col.tasks.slice(0, COLUMN_CAP);
    const hiddenCount = col.tasks.length - visibleTasks.length;
    const isTerminalCol = TERMINAL_STATUS_SET.has(col.key);
    // 仅当 (a) 列本身超 cap 且 (b) 是 terminal 列 且 (c) 还有更多未加载的 terminal 时
    // 显示"加载更多"按钮. 这样 terminal 列才有"翻页"语义; active 列 cap = 50 已经够.
    const showLoadMore = isTerminalCol && terminalHasMore && !!onLoadMoreTerminal;
    // v510: 拖到列内空白处 (card 之间空隙 / 列底空白) = 移到列尾. 完整 id
    //   列表传给 drop handler 算「去掉自身 → 追加到末尾」的新顺序. dragOverTaskId
    //   留 null 时即「drop 落空 = 移到列尾」语义.
    const orderedIdsInColumn = visibleTasks.map((t) => t.id);

    return (
      <>
        <div
          className="flex-1 overflow-y-auto px-2 pb-2 space-y-2"
          // 列底空白 drop 兜底 — 仅处理「同列内 task 拖到空白处 = 移到列尾」.
          //   跨列拖动不在这层拦截, 让事件冒泡到列 wrapper 的 onDrop (status 切换).
          //   判据: 从 dataTransfer 读 sourceColKey, 与本列 colKey 比, 同才接管.
          onDragOver={(e) => {
            if (!draggingTaskId) return;
            const raw = e.dataTransfer.getData("application/task");
            if (!raw) return;
            let sourceColKey: string | undefined;
            try { sourceColKey = JSON.parse(raw).sourceColKey; } catch {}
            if (sourceColKey !== col.key) return; // 跨列 → 不拦, 冒泡到列 wrapper
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => {
            if (!draggingTaskId) return;
            const raw = e.dataTransfer.getData("application/task");
            if (!raw) return;
            let sourceColKey: string | undefined;
            try { sourceColKey = JSON.parse(raw).sourceColKey; } catch {}
            if (sourceColKey !== col.key) return; // 跨列 → 让列 wrapper 的 onDrop 接
            e.preventDefault();
            e.stopPropagation();
            handleTaskItemDrop(e, col.key, orderedIdsInColumn);
          }}
        >
          {visibleTasks.map((task) => (
            <div
              key={task.id}
              draggable
              onDragStart={(e) => handleTaskDragStart(e, task.id, col.key)}
              onDragEnd={handleTaskDragEnd}
              onDragOver={(e) => handleTaskItemDragOver(e, task.id, col.key)}
              onDragLeave={handleTaskItemDragLeave}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTaskItemDrop(e, col.key, orderedIdsInColumn);
              }}
              className={`${
                draggingTaskId === task.id ? "opacity-50" : ""
              } ${
                // v510: 拖动参考位置 — 在拖到的 card 顶部画一道蓝色细线, 暗示
                //   「释放后将插入到此 card 之前」. 与 kanban 主流看板 UX 一致.
                draggingTaskId &&
                draggingTaskId !== task.id &&
                dragOverTaskId === task.id &&
                dragOverColKey === col.key
                  ? "ring-2 ring-blue-400 ring-offset-1 rounded-lg"
                  : ""
              }`}
            >
              {renderKanbanCard(task)}
            </div>
          ))}
          {col.tasks.length === 0 && (
            <div className="text-center py-6 text-xs text-gray-400">暂无</div>
          )}
        </div>
        {/* 列底 "展开更多" 按钮. 桌面+移动都生效. */}
        {(hiddenCount > 0 || showLoadMore) && (
          <div className="px-2 py-2 border-t border-gray-200">
            {hiddenCount > 0 && (
              <button
                onClick={onLoadMoreTerminal}
                disabled={isLoadingMore}
                className="w-full text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded py-1.5 disabled:opacity-50"
              >
                {isLoadingMore
                  ? "加载中..."
                  : `展开更多 (${hiddenCount}+ 加载下一页)`}
              </button>
            )}
            {!hiddenCount && showLoadMore && (
              <button
                onClick={onLoadMoreTerminal}
                disabled={isLoadingMore}
                className="w-full text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded py-1.5 disabled:opacity-50"
              >
                {isLoadingMore ? "加载中..." : "加载更多 (其他列还有未加载)"}
              </button>
            )}
          </div>
        )}
      </>
    );
  };

  // ── 移动端 (< md): 状态 tab + 单列 ──
  if (isMobile) {
    const activeMobileCol = visibleColumns.find((c) => c.key === mobileStatusTab) || visibleColumns[0];
    return (
      <div className="flex-1 flex flex-col">
        {/* 状态 tab 条 — overflow-x-auto + snap, 7 个 status 横向滚 */}
        <div className="border-b border-gray-200 bg-white">
          <div className="flex gap-1 px-3 py-2 overflow-x-auto snap-x">
            {visibleColumns.map((col) => (
              <button
                key={col.key}
                onClick={() => setMobileStatusTab(col.key)}
                className={`snap-start shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                  col.key === mobileStatusTab
                    ? `${STATUS_COLORS[col.key] || "bg-gray-100"} ring-1 ring-current/20`
                    : "bg-gray-50 text-gray-500 hover:bg-gray-100"
                }`}
              >
                {col.label} <span className="opacity-60">{col.tasks.length}</span>
              </button>
            ))}
          </div>
        </div>
        {/* 单列: 全宽, 不再横滑 */}
        <div className="flex-1 overflow-y-auto p-3">
          {activeMobileCol ? (
            <div className="space-y-2">
              {activeMobileCol.tasks.slice(0, COLUMN_CAP).map((task) => (
                <div key={task.id}>{renderKanbanCard(task)}</div>
              ))}
              {/* 列底: 加载更多 (与桌面列共用按钮) */}
              {(activeMobileCol.tasks.length > COLUMN_CAP || (TERMINAL_STATUS_SET.has(activeMobileCol.key) && terminalHasMore)) && onLoadMoreTerminal && (
                <button
                  onClick={onLoadMoreTerminal}
                  disabled={isLoadingMore}
                  className="w-full mt-3 px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  {isLoadingMore ? "加载中..." : `加载更多 (已加载 ${terminalLoaded ?? 0} / 共 ${terminalTotal ?? 0})`}
                </button>
              )}
              {activeMobileCol.tasks.length === 0 && (
                <div className="text-center py-12 text-sm text-gray-400">暂无</div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 text-sm text-gray-400">请选择状态</div>
          )}
        </div>
      </div>
    );
  }

  // ── 桌面端 (>= md): 横滑多列, 与 Phase 3 之前一致 ──
  return (
    <div className="flex-1 overflow-x-auto">
      <div className="flex gap-4 p-6 min-h-[calc(100vh-200px)]">
        {visibleColumns.map((col) => {
          const isDragOverTarget = dragOverCol === col.key && !dragColKey;
          const isColDragOver = dragColOverKey === col.key && !!dragColKey;
          const isColDragging = dragColKey === col.key;
          return (
            <div
              key={col.key}
              className={`
                flex-shrink-0 w-[280px] md:w-[300px] flex flex-col
                bg-gray-100 rounded-lg transition-all
                ${isDragOverTarget ? "ring-2 ring-blue-400 ring-dashed" : ""}
                ${isColDragOver ? "ring-2 ring-amber-400 ring-dashed" : ""}
                ${isColDragging ? "opacity-60" : ""}
              `}
              onDragOver={(e) => handleColDragOver(e, col.key)}
              onDragLeave={handleColDragLeave}
              onDrop={(e) => handleColDrop(e, col.key)}
            >
              {/* Column header — draggable for reordering */}
              <div
                draggable
                onDragStart={(e) => handleColHeaderDragStart(e, col.key)}
                onDragEnd={handleColHeaderDragEnd}
                onDragOver={(e) => handleColHeaderDragOver(e, col.key)}
                onDragLeave={handleColHeaderDragLeave}
                className="px-3 py-2.5 flex items-center justify-between cursor-grab active:cursor-grabbing select-none"
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 hover:text-gray-600" title="拖拽排序">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="text-sm font-medium text-gray-700">{col.label}</span>
                </div>
                <span className="text-xs text-gray-400 bg-white rounded-full px-2 py-0.5">
                  {col.tasks.length}
                </span>
              </div>

              {/* Column body (cap 50 + 展开更多) */}
              {renderColumnBody(col)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
