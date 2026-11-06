"use client";

// 功能: 项目/版本看板 — active 任务永远全量 + SSE 实时, terminal 任务按需分页
// + 客户端虚拟滚动. 数据流走 /api/tasks/page 端点 (TaskTrimmed 精简投影 + 信封),
// RSC payload 从 MB 级降到 KB 级.
//
// 关注点:
//   - 状态按 active (pending/queued/running/paused/reviewing) / terminal
//     (completed/failed/rejected/cancelled) 分流: active 用户实际盯着看 (<20),
//     terminal 是 300+ 历史包袱, 走分页.
//   - SSE handler 按 event.to 分四路:
//       a) active → terminal: 从 activeTasks 删除, prepend 到 terminalTasks
//          (活窗口语义: 新完成的永远在顶端; page1 已满时最老的被挤出可见窗口,
//          下次 refreshTerminal 还会拉回来).
//       b) terminal → active: 反向, 从 terminalTasks 删除, prepend 到 activeTasks.
//       c) active → active: 原地 patch status + updated_at.
//       d) 未知 task (没在内存里): 只 refetch event.to 对应的那一个集合, **不**两个
//          都 refetch (避免本次改造的核心收益被实时路径吃回去).
//     cost 事件: 两个数组都尝试原地 patch; 不在内存里静默丢弃, 下次 loadMore
//     或 refetch 会补上.
//   - 不触发 debounced full refetch — 旧实现每次都拉全量, 改造的核心收益被它吃掉.
//   - 筛选 (status / model / tag / search / showDeleted) 全在客户端 useMemo 过滤,
//     配合 activeTasks + terminalTasks 拼接; scopedStats 用 terminalTotal (来自
//     信封) 而不是 terminalTasks.length, 状态栏数字才能反映"还有 N 条未加载".
//   - 字段替换: prompt → prompt_preview; result → result_preview (前 150);
//     error → error_preview (前 200). SSE patch 后 prompt_preview 始终是字符串
//     (DB 层 COALESCE 兜空), .slice() 不会崩.
//   - ChatView 拿到的仍是 TaskTrimmed[]; chat-task-list 的 prompt.slice(0,60)
//     已改为 prompt_preview.slice(0,60).

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { STATUS_LABELS, STATUS_COLORS, ALL_STATUSES, TYPE_LABELS, TYPE_COLORS, DELETED_TAG, KANBAN_COLUMNS, VALID_DRAG_TRANSITIONS, getDragAction, BOARD_ACTIVE_STATUSES, BOARD_TERMINAL_STATUSES, canDeleteTask, getVisibleStatuses } from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useTick } from "@/lib/hooks/use-tick";
import { computeTaskMove } from "./board-task-move";
import { copyToClipboard } from "@/lib/clipboard";
import { useBoardConfig } from "@/lib/hooks/use-board-config";
import type { BoardViewMode } from "@/lib/hooks/use-board-config";
import ConfirmDialog from "@/components/ConfirmDialog";
import Select from "@/components/Select";
import ViewSwitcher from "@/components/ViewSwitcher";
import VirtualizedCards from "@/components/VirtualizedCards";
import { useToastActions } from "@/components/Toast";
import KanbanView from "./kanban-view";
import ChatView from "./chat-view";
import GlobalListView from "@/app/global/global-list-view";
import TaskByChip from "@/components/TaskByChip";
import TaskStatusChip from "@/components/TaskStatusChip";
import AwaitingReasonChip from "@/components/AwaitingReasonChip";
import type { TaskTrimmed, Task } from "@/lib/runtime/types";
import { matchesTaskSearch } from "@/lib/runtime/task-search";
import { getRequirementChipMeta } from "@/lib/runtime/requirement-chip";

const ACTIVE_STATUS_SET = new Set<string>(BOARD_ACTIVE_STATUSES);
const TERMINAL_STATUS_SET = new Set<string>(BOARD_TERMINAL_STATUSES);

// ChatView 新建 task 后只回全字段 Task. Board 把它收下, 转成 TaskTrimmed 形状
// (preview = DB 层 SUBSTR 的同口径本地版), 按 status 落到对应数组. preview 字段
// 这里算一次, 后续 SSE patch / refresh 会拿服务端真值覆盖 (保持一致).
function previewSlice(text: string | null | undefined, len: number): string {
  if (!text) return "";
  return text.length > len ? text.slice(text.length - len) : text;
}

function taskToTrimmed(t: Task): TaskTrimmed {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    prompt_preview: previewSlice(t.prompt, 150),
    result_preview: previewSlice(t.result, 150),
    error_preview: previewSlice(t.error, 200),
    status: t.status,
    priority: t.priority,
    type: t.type,
    model: t.model,
    resolved_model: t.resolved_model,
    tags: t.tags,
    project_id: t.project_id,
    version_id: t.version_id,
    owner_id: t.owner_id,
    deleted_at: t.deleted_at,
    cost_usd: t.cost_usd,
    updated_at: t.updated_at,
    auto_approve: t.auto_approve,
    auto_complete: t.auto_complete ?? 0, // v528 (波 2.5): 本地构造无服务端列值, 默认 0
    context_tokens: t.context_tokens,
    context_max: t.context_max,
    awaiting_owner_review: t.awaiting_owner_review ?? 0,
    awaiting_markers: t.awaiting_markers ?? null, // v61+R39: JSON 数组 (来自 <awaiting type="..."/> 多 marker). null = 无 marker, 老数据回退到 awaiting_owner_review.
    dispatched_by_task_id: t.dispatched_by_task_id ?? null, // v32+R39: 派发方 task id, 非空时显示 [by]<短id> 角标 (Q2).
    // R94: 新建 task 没有服务端 LEFT JOIN 派生值, 默认 null → chip 不渲染. 下一次
    //   /api/tasks/page 拉取 (或 SSE 全量 refetch) 会带回服务端真值.
    requirement_status: null,
    // R109: 同 R94 口径 — 新建/本地 patch task 还没有服务端 cp JOIN 结果, 默认 null.
    //   下一次 SSE 全量 refetch 走 listTasksPage 拉回真值. UI 走 TaskStatusChip 4 色.
    latest_checkpoint_status: null,
    // R112 续 (v129): reviewing 子终态标签. 新建/本地 patch task 默认 null, 下次 SSE
    //   refetch 走 listTasksPage 拉回真值. UI 走 AwaitingReasonChip (待实施蓝 / 待部署紫 /
    //   待<自定义>灰).
    awaiting_reason: null,
    // v510: 拖拽手动排序 — 新建 task 默认 null (未排过 = 系统默认序 updated_at
    //   desc). 拖拽后由 POST /api/tasks/queue-order 写库, 下次 /api/tasks/page
    //   refetch 拉回 (SSE 不覆盖这个字段).
    queued_order: t.queued_order ?? null,
    queued_reason: t.queued_reason ?? null,
    // R99: schedule_id 来自服务端 DB 字段 (Task 已带), 本地新建 task 不带 (默认 null).
    //   下一次 SSE refetch 会拉回真值, UI 据此渲染「定时」chip.
    schedule_id: t.schedule_id ?? null,
  };
}

function formatUpdatedAt(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return "";
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${M}-${D} ${h}:${m}`;
}

// v61+R39: 解析 awaiting_markers JSON + awaiting_owner_review 回退, 返回角标渲染列表.
// 设计: markers 非空优先, 每个 marker 渲染一个角标按 type 分色; markers 为空但
//   awaiting_owner_review=1 时 (老数据 / v56 marker 翻译路径), 回退到单"等拍板"角标
//   保证不丢失视觉信号. 解析失败 → 走 awaiting_owner_review 回退, console.warn.
//   类型颜色映射: review=amber (等拍板), choice=blue (等选), info=gray (提示),
//   其他=purple (未知 type 也展示, 不静默吞). 角标文字: type + 可选 desc 第一段
//   (20 字符截断 + 省略号).
//   R127 §3.2: 同时抽出 decision marker 单独返回 (decisionId/question/options/
//   recommended/recommendedReason) — board-client 渲染 DecisionBanner 一键决策
//   卡片, 不再混在 chip 里. 普通 review/choice/info 还是走 chip.
type ParsedDecision = {
  decisionId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  recommended?: string;
  recommendedReason?: string;
};

function parseAwaitingMarkers(
  awaitingMarkersJson: string | null,
  awaitingOwnerReview: number,
): {
  chips: Array<{ label: string; title: string; color: string }>;
  decisions: ParsedDecision[];
} {
  // R84: 加 waiting_reply / suggestion / stuck 三个 type，对应飞书 O 列四态里的
  //   「等回复 / 有建议 / 卡住」+ 把 review label 从「等拍板」改成「需拍板」对齐 R84
  //   文案。颜色与现有四态（amber/blue/gray/purple）不撞，damo 一眼能区分。
  const TYPE_COLORS_R39: Record<string, { color: string; cn: string }> = {
    review: { color: "bg-amber-100 text-amber-800 border-amber-200", cn: "需拍板" },
    choice: { color: "bg-blue-100 text-blue-800 border-blue-200", cn: "等选" },
    info: { color: "bg-gray-100 text-gray-700 border-gray-200", cn: "提示" },
    waiting_reply: { color: "bg-cyan-100 text-cyan-800 border-cyan-200", cn: "等回复" },
    suggestion: { color: "bg-emerald-100 text-emerald-800 border-emerald-200", cn: "有建议" },
    stuck: { color: "bg-red-100 text-red-800 border-red-200", cn: "卡住" },
  };
  const chips: Array<{ label: string; title: string; color: string }> = [];
  const decisions: ParsedDecision[] = [];
  if (awaitingMarkersJson) {
    try {
      const parsed = JSON.parse(awaitingMarkersJson) as Array<{
        type?: string;
        desc?: string | null;
        decision_id?: string;
        question?: string;
        options?: Array<{ label: string; description?: string }>;
        recommended?: string;
        recommended_reason?: string;
      }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const m of parsed) {
          // R127 §3.2: decision type 走 DecisionBanner (下方), 不进 chip 队列
          if (m.type === "decision" && m.decision_id && Array.isArray(m.options)) {
            decisions.push({
              decisionId: m.decision_id,
              question: m.question || m.desc || "(无 question)",
              options: m.options,
              recommended: m.recommended,
              recommendedReason: m.recommended_reason,
            });
            continue;
          }
          const t = (m.type || "review").toLowerCase();
          const meta = TYPE_COLORS_R39[t] || {
            color: "bg-purple-100 text-purple-800 border-purple-200",
            cn: t || "等拍板",
          };
          const descSnippet = m.desc ? ` · ${m.desc.slice(0, 20)}${m.desc.length > 20 ? "…" : ""}` : "";
          chips.push({
            label: `${meta.cn}${descSnippet}`,
            title: m.desc ? `${t}: ${m.desc}` : `awaiting marker (type=${t})`,
            color: meta.color,
          });
        }
        if (chips.length > 0 || decisions.length > 0) {
          return { chips, decisions };
        }
      }
    } catch (err) {
      console.warn("[board] awaiting_markers JSON 解析失败, 回退 awaiting_owner_review:", (err as Error).message);
    }
  }
  // 回退路径: 老数据 / v56 marker (只设 awaiting_owner_review=1 没写 markers 列)
  if (awaitingOwnerReview === 1) {
    return {
      chips: [
        {
          label: "等拍板",
          title: "Agent 标了等拍板 — approve 会被拒, 需先调 POST /unset-awaiting-review",
          color: "bg-amber-100 text-amber-800 border-amber-200",
        },
      ],
      decisions: [],
    };
  }
  return { chips: [], decisions: [] };
}

const EMPTY_STATS: Record<string, number> = {
  pending: 0,
  queued: 0,
  running: 0,
  paused: 0,
  reviewing: 0,
  completed: 0,
  failed: 0,
  rejected: 0,
  cancelled: 0,
};

const SCHEDULER_TASK_COLORS = [
  "bg-blue-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-fuchsia-500",
  "bg-indigo-500",
];

function taskColor(taskId: string) {
  const hash = Array.from(taskId).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return SCHEDULER_TASK_COLORS[hash % SCHEDULER_TASK_COLORS.length];
}

// R127 §3.2: 看板决策 banner. 解析 awaiting_markers 已抽好的 decision 数组, 每条
//   渲染: question + 选项按钮 + 推荐项标 (推荐) + hover 全选项 + 子进度条.
//   点击 → POST /api/tasks/{id}/resolve-decision, 成功后 onResolved 回调 + toast.
//   不再 resolve 后用 router.refresh 拉全表 (实测 board 大时成本高), 改为调用方
//   本地乐观更新 awaiting_markers (resolved_at/resolved_label), banner 自然消失.
function DecisionBanner({
  taskId,
  decisions,
  onResolved,
}: {
  taskId: string;
  decisions: ParsedDecision[];
  onResolved: (decisionId: string, selectedLabel: string) => void;
}) {
  const { error: toastError, success: toastSuccess } = useToastActions();
  const [pending, setPending] = useState<string | null>(null);
  // 已 resolved 的决策 (本地状态, 用来灰显 + 标 ✓).
  const [resolvedMap, setResolvedMap] = useState<Record<string, { label: string; at: string }>>({});

  const handleResolve = useCallback(
    async (decisionId: string, label: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (pending) return;
      setPending(decisionId);
      try {
        const res = await fetch(`/api/tasks/${taskId}/resolve-decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision_id: decisionId, selected_label: label }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "unknown" }));
          toastError(`决策失败: ${err.error || res.status}`);
          return;
        }
        const now = new Date().toISOString();
        setResolvedMap((prev) => ({ ...prev, [decisionId]: { label, at: now } }));
        onResolved(decisionId, label);
        toastSuccess(`已选 ${label}`);
      } catch (err) {
        toastError(`Network error: ${(err as Error).message}`);
      } finally {
        setPending(null);
      }
    },
    [pending, taskId, onResolved, toastError, toastSuccess],
  );

  return (
    <div className="mt-1 mb-2 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2">
      {decisions.map((d, idx) => {
        const resolved = resolvedMap[d.decisionId];
        const total = decisions.length;
        const done = Object.keys(resolvedMap).length;
        return (
          <div key={d.decisionId} className={idx > 0 ? "mt-2 pt-2 border-t border-amber-200/60" : ""}>
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <div className="text-xs font-medium text-amber-900 line-clamp-2">{d.question}</div>
              <div className="text-[10px] text-amber-700 shrink-0">
                {total > 1 ? `${done}/${total} 已选` : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {d.options.map((opt) => {
                const isRecommended = d.recommended === opt.label;
                const isResolved = resolved?.label === opt.label;
                const isDisabled = !!pending || !!resolved;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={(e) => handleResolve(d.decisionId, opt.label, e)}
                    disabled={isDisabled}
                    title={
                      opt.description
                        ? `${opt.label} — ${opt.description}`
                        : opt.label
                    }
                    className={[
                      "inline-flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors",
                      isResolved
                        ? "bg-green-100 border-green-300 text-green-800 cursor-default"
                        : isDisabled
                        ? "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
                        : isRecommended
                        ? "bg-amber-100 border-amber-400 text-amber-900 hover:bg-amber-200"
                        : "bg-white border-amber-200 text-amber-800 hover:bg-amber-50",
                    ].join(" ")}
                  >
                    <span>{isResolved ? "✓" : opt.label}</span>
                    {isRecommended && !isResolved && (
                      <span className="text-[10px] text-amber-700">(推荐)</span>
                    )}
                    {isResolved && resolved && (
                      <span className="text-[10px] text-green-700">已选</span>
                    )}
                  </button>
                );
              })}
            </div>
            {d.recommendedReason && !resolved && (
              <div className="text-[10px] text-amber-700/80 mt-1 italic">
                推荐理由: {d.recommendedReason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function BoardClient({
  tasks: initialTasks,
  project,
  version,
  // 🆕 DAG P3 收尾 (2026-09-21): L1 平台开关 (app_settings.verification_globally_enabled).
  //   server page.tsx 读 resolveVerificationGloballyEnabled() 后传入. 关 = 永不进
  //   verifying, UI 配套也不渲染. 默认 false (与 B5 拍板一致, byte-identical).
  globallyEnabled,
}: {
  tasks: TaskTrimmed[];
  project: { id: string; name: string; description: string | null; cwd: string | null };
  version: { id: string; name: string; feishu_url: string | null; feishu_sheet: string | null; cwd: string | null; sync_strategy?: "weak" | "strong" | "manual" } | null;
  globallyEnabled: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error: toastError, success: toastSuccess } = useToastActions();
  // R161: 每 60s 强制 re-render 让任务时间显示自动刷新 (分钟级精度足够).
  useTick(60_000);
  // 把 RSC 的 initialTasks 按 status 拆到两个数组 — active 全量进, terminal 仅第
  // 一页进 (initialTasks 只到 limit 那么多, 后续靠 loadMoreTerminal). 这只是初始
  // 状态, 后续 SSE / fetch 接管.
  const initialSplit = useMemo(() => {
    const a: TaskTrimmed[] = [];
    const t: TaskTrimmed[] = [];
    for (const task of initialTasks) {
      (TERMINAL_STATUS_SET.has(task.status) ? t : a).push(task);
    }
    return { active: a, terminal: t };
  }, [initialTasks]);

  const [activeTasks, setActiveTasks] = useState<TaskTrimmed[]>(initialSplit.active);
  const [terminalTasks, setTerminalTasks] = useState<TaskTrimmed[]>(initialSplit.terminal);
  const [terminalTotal, setTerminalTotal] = useState<number>(initialTasks.length - initialSplit.active.length);
  const [terminalHasMore, setTerminalHasMore] = useState<boolean>(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const scopeKey = version ? `${project.id}:${version.id}` : `${project.id}:unversioned`;

  // ===== Chat 模式下顶部 header 折叠/展开 (R126) =====
  // 旧实现 chat 模式下整块 header (项目面包屑 + project/version 名 + ViewSwitcher +
  // 新建/Wiki/需求点 入口) 被隐藏 (effectiveViewMode !== "chat" 守卫). 用户反馈
  // 想拿回这个块 (里面有 ViewSwitcher/新建 快捷入口),但也要可收起来腾出聊天空间.
  // 默认展开 (= "拿回来"), 用户可点 ChatView 顶部 pill 行末尾的 chevron 开关收起,
  // 偏好持久化到 localStorage. 全 chat 视图共用一个 key (不按 scope 分),
  // 与 chat-list-width / chat-new-prompt-input-height-v1 模式一致.
  const TOP_HEADER_OPEN_KEY = "chat-top-header-open-v1";
  const [topHeaderOpen, setTopHeaderOpen] = useState<boolean>(true);
  const [topHeaderMounted, setTopHeaderMounted] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TOP_HEADER_OPEN_KEY);
      if (raw === "0") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTopHeaderOpen(false);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTopHeaderMounted(true);
  }, []);
  useEffect(() => {
    if (!topHeaderMounted) return;
    try { localStorage.setItem(TOP_HEADER_OPEN_KEY, topHeaderOpen ? "1" : "0"); } catch {}
  }, [topHeaderOpen, topHeaderMounted]);
  const handleToggleTopHeader = useCallback(() => {
    setTopHeaderOpen((v) => !v);
  }, []);

  // 面包屑末尾的短 ID（project/version）点击复制当前页面 URL。
  const handleCopyUrl = useCallback(async () => {
    try {
      await copyToClipboard(window.location.href);
      toastSuccess("已复制链接");
    } catch (err: any) {
      toastError(`复制失败: ${err.message}`);
    }
  }, [toastSuccess, toastError]);
  const {
    viewMode, setViewMode,
    selectedStatuses, toggleStatus, setSelectedStatuses,
    columnOrder, setColumnOrder,
    syncLevel, setSyncLevel,
  } = useBoardConfig(scopeKey, { showVerifying: globallyEnabled });

  // URL params override localStorage: ?mode=cards|kanban|chat takes priority
  // R51 子 bug #2: 不再 setViewMode(urlMode) 写回 localStorage.
  //   旧逻辑会让 "用 chat 链接打开 → 进版本页 (无 ?mode=chat) → 仍按 chat 渲染"
  //   因为 localStorage 被污染. 现改为: URL 只是临时入口, 不污染用户偏好.
  //   用户主动切走 ViewSwitcher → handleViewModeChange 才写库.
  const urlMode = searchParams.get("mode") as BoardViewMode | null;
  const urlTaskId = searchParams.get("taskId");
  const effectiveViewMode: BoardViewMode =
    urlMode && ["cards", "kanban", "chat", "list", "grouped"].includes(urlMode) ? urlMode : viewMode;

  // URL taskId: in chat mode → select task; in cards/kanban → navigate to task detail
  useEffect(() => {
    if (!urlTaskId) return;
    if (effectiveViewMode !== "chat") {
      router.replace(`/tasks/${urlTaskId}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When switching view mode via ViewSwitcher, also clean up URL params
  const handleViewModeChange = useCallback((mode: BoardViewMode) => {
    setViewMode(mode);
    if (urlMode || urlTaskId) {
      router.replace(window.location.pathname);
    }
  }, [setViewMode, urlMode, urlTaskId, router]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchResult, setBatchResult] = useState<{ success: number; failed: number } | null>(null);
  // 🆕 DAG P3 收尾 (2026-09-21): 按 L1 平台开关过滤 verifying — 开关关时筛
  //   选条不渲染该状态 (筛选/拖列/默认选中都跟它走, 见 getVisibleStatuses).
  const allStatuses = getVisibleStatuses(globallyEnabled);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [searchText, setSearchText] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchText), 200);
    return () => clearTimeout(timer);
  }, [searchText]);

  const [showDeleted, setShowDeleted] = useState(false);
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [draggingTag, setDraggingTag] = useState<string | null>(null);
  const [dragOverTag, setDragOverTag] = useState<string | null>(null);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close sync menu on outside click
  useEffect(() => {
    if (!showSyncMenu) return;
    const handler = (e: MouseEvent) => {
      if (syncMenuRef.current && !syncMenuRef.current.contains(e.target as Node)) {
        setShowSyncMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSyncMenu]);

  // Delete confirm dialog state (独立的删除确认, 与 Feishu 同步无关, 保留)
  const [deleteConfirm, setDeleteConfirm] = useState<{ taskId: string; taskTitle: string } | null>(null);


  // Refs: 让 SSE handler 读"当前"state (避免 stale closure), refreshTasks 回调
  // 不被 showDeleted / version 频繁刷新.
  const activeTasksRef = useRef(activeTasks);
  useEffect(() => { activeTasksRef.current = activeTasks; }, [activeTasks]);
  const terminalTasksRef = useRef(terminalTasks);
  useEffect(() => { terminalTasksRef.current = terminalTasks; }, [terminalTasks]);
  const showDeletedRef = useRef(showDeleted);
  useEffect(() => { showDeletedRef.current = showDeleted; }, [showDeleted]);
  const initialTasksRef = useRef(initialTasks);
  useEffect(() => { initialTasksRef.current = initialTasks; }, [initialTasks]);

  // 拼接 /api/tasks/page 的 query string (project + version 或 unversioned).
  const buildScopeQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (version) {
      params.set("project", project.id);
      params.set("version", version.id);
    } else {
      params.set("project", project.id);
      params.set("unversioned", "true");
    }
    if (showDeletedRef.current) params.set("includeDeleted", "true");
    // R114 (后台搜索): 把 debouncedSearch 透传给服务端 — 非空时服务端 LIKE 已收窄,
    // 客户端 matchesTaskSearch 退化为 no-op (结果一致, 双层冗余无害, 但少一次内存过滤).
    if (debouncedSearch) params.set("q", debouncedSearch);
    // R114 第二轮 (筛选全走后端): model + tag 也透传给服务端 —
    // 服务端精确匹配, 客户端 filterPredicate 退化为 no-op (与 q 同模板).
    if (selectedModel) params.set("model", selectedModel);
    if (selectedTag) params.set("tag", selectedTag);
    return params.toString();
  }, [project.id, version, debouncedSearch, selectedModel, selectedTag]);

  // 拉 active 集合 (永远全量, 不到 limit 也会全部返回).
  const refreshActive = useCallback(async () => {
    const qs = buildScopeQuery();
    qs.split("&").forEach(p => {});
    // 用 URLSearchParams 拼一次, 避免手动 & 拼接.
    const params = new URLSearchParams(qs);
    params.set("statusGroup", "active");
    params.set("limit", "200"); // active 通常 <20, 200 足够; 防 SSE 大量 pending 边界
    try {
      const res = await fetch(`/api/tasks/page?${params.toString()}`);
      const data = await res.json();
      setActiveTasks(Array.isArray(data.items) ? data.items : []);
    } catch {
      // SSE 频繁触发, swallow; 下次会再试.
    }
  }, [buildScopeQuery]);

  // 拉 terminal 集合 (分页). reset=true 替换 page1, reset=false append 后续页.
  const refreshTerminal = useCallback(async (offset = 0, reset = true) => {
    const params = new URLSearchParams();
    if (version) {
      params.set("project", project.id);
      params.set("version", version.id);
    } else {
      params.set("project", project.id);
      params.set("unversioned", "true");
    }
    params.set("statusGroup", "terminal");
    if (showDeletedRef.current) params.set("includeDeleted", "true");
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (selectedModel) params.set("model", selectedModel);
    if (selectedTag) params.set("tag", selectedTag);
    params.set("limit", "50");
    params.set("offset", String(offset));
    try {
      const res = await fetch(`/api/tasks/page?${params.toString()}`);
      const data = await res.json();
      const items: TaskTrimmed[] = Array.isArray(data.items) ? data.items : [];
      setTerminalTasks(prev => reset ? items : [...prev, ...items]);
      setTerminalTotal(typeof data.total === "number" ? data.total : items.length);
      setTerminalHasMore(!!data.hasMore);
    } catch {
      // ignore
    }
  }, [project.id, version, debouncedSearch, selectedModel, selectedTag]);

  const loadMoreTerminal = useCallback(async () => {
    if (isLoadingMore || !terminalHasMore) return;
    setIsLoadingMore(true);
    try {
      await refreshTerminal(terminalTasks.length, false);
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, terminalHasMore, terminalTasks.length, refreshTerminal]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshActive(), refreshTerminal(0, true)]);
  }, [refreshActive, refreshTerminal]);

  // Refresh on navigation / scope change.
  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Re-fetch (with/without deleted) when the deleted filter toggles.
  useEffect(() => {
    refreshAll();
  }, [showDeleted, refreshAll]);

  // SSE: 状态变更按方向分流 patch, 成本地成本事件. 已知 task → 原地 patch / 跨数
  // 组移动; 未知 task → 只 refetch event.to 对应的那一个集合 (避免本次改造的
  // 收益被实时路径吃回去). 不再用 debouncedRefresh 全量 refetch.
  useEffect(() => {
    const es = new EventSource(`/api/projects/${project.id}/events`);
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "status_change" && event.task_id && event.to) {
          const id = event.task_id;
          const toStatus = event.to;
          const toIsTerminal = TERMINAL_STATUS_SET.has(toStatus);
          const inActive = activeTasksRef.current.some((t) => t.id === id);
          const inTerminal = terminalTasksRef.current.some((t) => t.id === id);

          if (!inActive && !inTerminal) {
            // 未知 task: 按目标方向只 refetch 一个集合, 不整体 refetch.
            if (toIsTerminal) refreshTerminal(0, true);
            else refreshActive();
            return;
          }

          // 已知 task: 按方向移动
          // R118: 4 个分支都要去重 — 输入端可能 task 同时存在于 active+terminal
          //   (SSE handler 与 runAction 之间存在竞争窗口 — refs 滞后 useEffect 一次
          //   render, 旧实现分支只动主数组导致残留, 看板视图渲染两张相同卡片).
          if (inTerminal && toIsTerminal) {
            // terminal → terminal (例如 reviewing → completed)
            setTerminalTasks(prev => prev.map(t =>
              t.id === id
                ? { ...t, status: toStatus, updated_at: new Date().toISOString() }
                : t
            ));
            setActiveTasks(prev => prev.filter(t => t.id !== id));
          } else if (inActive && !toIsTerminal) {
            // active → active (例如 running → paused)
            setActiveTasks(prev => prev.map(t =>
              t.id === id
                ? { ...t, status: toStatus, updated_at: new Date().toISOString() }
                : t
            ));
            setTerminalTasks(prev => prev.filter(t => t.id !== id));
          } else if (inActive && toIsTerminal) {
            // active → terminal: 从 active 删除, prepend 到 terminal 头部
            const moved = activeTasksRef.current.find(t => t.id === id);
            if (moved) {
              const patched: TaskTrimmed = { ...moved, status: toStatus, updated_at: new Date().toISOString() };
              setActiveTasks(prev => prev.filter(t => t.id !== id));
              setTerminalTasks(prev => [patched, ...prev.filter(t => t.id !== id)]);
              setTerminalTotal(prev => prev + 1);
            }
          } else if (inTerminal && !toIsTerminal) {
            // terminal → active (rejected → running, etc.): 反向
            const moved = terminalTasksRef.current.find(t => t.id === id);
            if (moved) {
              const patched: TaskTrimmed = { ...moved, status: toStatus, updated_at: new Date().toISOString() };
              setTerminalTasks(prev => prev.filter(t => t.id !== id));
              setActiveTasks(prev => [patched, ...prev.filter(t => t.id !== id)]);
              setTerminalTotal(prev => Math.max(0, prev - 1));
            }
          }
          return;
        }

        if (event.type === "cost" && event.task_id && typeof event.cost_usd === "number") {
          const id = event.task_id;
          // 两个数组都尝试原地 patch; 不在内存里就静默丢 (下次 loadMore / refetch 补)
          setActiveTasks(prev => prev.some(t => t.id === id)
            ? prev.map(t => t.id === id ? { ...t, cost_usd: event.cost_usd } : t)
            : prev
          );
          setTerminalTasks(prev => prev.some(t => t.id === id)
            ? prev.map(t => t.id === id ? { ...t, cost_usd: event.cost_usd } : t)
            : prev
          );
        }
      } catch {}
    };
    return () => { es.close(); };
  }, [project.id, refreshActive, refreshTerminal]);

  const modelOptions = useMemo(() => {
    const models = new Set<string>();
    [...activeTasks, ...terminalTasks].forEach((t) => { if (t.model) models.add(t.model); });
    return Array.from(models).sort();
  }, [activeTasks, terminalTasks]);

  const tagOptions = useMemo(() => {
    const tags = new Set<string>();
    [...activeTasks, ...terminalTasks].forEach((t) => {
      if (t.tags) {
        try { JSON.parse(t.tags).forEach((tag: string) => tags.add(tag)); } catch {}
      }
    });
    return Array.from(tags).sort();
  }, [activeTasks, terminalTasks]);

  // 筛选 useMemo 分别对 active / terminal 跑, 避免 spread 重建数组每次 render.
  const filterPredicate = useCallback((t: TaskTrimmed) => {
    if (t.deleted_at && !showDeleted) return false;
    if (!selectedStatuses.has(t.status)) return false;
    if (selectedModel && t.model !== selectedModel) return false;
    if (selectedTag) {
      let taskTags: string[] = [];
      try { taskTags = t.tags ? JSON.parse(t.tags) : []; } catch { taskTags = []; }
      if (!taskTags.includes(selectedTag)) return false;
    }
    if (debouncedSearch) {
      if (!matchesTaskSearch(t, debouncedSearch)) return false;
    }
    return true;
  }, [selectedStatuses, selectedModel, selectedTag, debouncedSearch, showDeleted]);

  const filteredActive = useMemo(
    () => activeTasks.filter(filterPredicate),
    [activeTasks, filterPredicate]
  );
  const filteredTerminal = useMemo(
    () => terminalTasks.filter(filterPredicate),
    [terminalTasks, filterPredicate]
  );
  // 拼接: 这里 spread 一次是必要的 (active + terminal 顺序固定 active 在前),
  // useMemo 只在两个数组引用变化时重算.
  const filteredTasks = useMemo(
    () => [...filteredActive, ...filteredTerminal],
    [filteredActive, filteredTerminal]
  );

  // Task actions
  const { warning: toastWarning } = useToastActions();
  const runAction = useCallback(async (taskId: string, action: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/${action}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`Action ${action} failed: ${err.error}`);
        return;
      }
      // Optimistic update: read the new status from the response and update local state.
      // 4 种方向 (active↔active / active↔terminal 跨组 / terminal 内) 与 SSE handler
      // 同口径 — 抽到 board-task-move.ts 纯函数, R54 修复点:
      // 原版无条件从 activeTasks 删 + 仅当新 status 是 terminal 才补回 terminalTasks,
      // 导致 active→active 拖拽 (queued→running / paused→running) task 消失.
      const data = await res.json().catch(() => null);
      if (data?.status) {
        // R54 N 列: 拖到「运行中」若并发已满, 后端真返 status=queued, 卡片会停在
        // 「排队中」列(状态如实, R54 fix 保证了), 但用户可能以为拖了没反应。
        // 起一个 warning toast 提示「已排队, 并发已满」, 别用 alert (damo R54 回复原话:
        // 「可以toast,好看的,别alert」). 只 start action 才会出 queued, pause/resume
        // 不会, 所以只在这一个 action 上判断, 避免对其它动作误触发。
        if (action === "start" && data.status === "queued") {
          toastWarning("已加入排队, 并发已满, 等槽位空闲后自动运行");
        }
        const now = new Date().toISOString();
        const result = computeTaskMove(
          activeTasksRef.current,
          terminalTasksRef.current,
          taskId,
          data.status,
          now,
        );
        if (result.totalDelta !== 0) {
          setTerminalTotal(prev => Math.max(0, prev + result.totalDelta));
        }
        // 数组内容实际没变就不触发 setState, 避免无意义的 re-render.
        if (result.active !== activeTasksRef.current) setActiveTasks(result.active);
        if (result.terminal !== terminalTasksRef.current) setTerminalTasks(result.terminal);
      }
    } catch (err) {
      toastError(`Network error: ${(err as Error).message}`);
    }
  }, []);

  const handleDeleteTask = useCallback(async (taskId: string, taskTitle: string, e: React.MouseEvent) => {
    e.preventDefault(); // prevent Link navigation
    e.stopPropagation();
    setDeleteConfirm({ taskId, taskTitle });
  }, []);

  const confirmDeleteTask = useCallback(async () => {
    if (!deleteConfirm) return;
    const taskId = deleteConfirm.taskId;
    setDeleteConfirm(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`删除失败: ${err.error}`);
        return;
      }
      // Update local state — set deleted_at on whichever array holds it
      const now = new Date().toISOString();
      setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, deleted_at: now } : t));
      setTerminalTasks(prev => prev.map(t => t.id === taskId ? { ...t, deleted_at: now } : t));
    } catch (err) {
      toastError(`Network error: ${(err as Error).message}`);
    }
  }, [deleteConfirm]);

  const handleRestoreTask = useCallback(async (taskId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const res = await fetch(`/api/tasks/${taskId}/restore`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`恢复失败: ${err.error}`);
        return;
      }
      setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, deleted_at: null } : t));
      setTerminalTasks(prev => prev.map(t => t.id === taskId ? { ...t, deleted_at: null } : t));
    } catch (err) {
      toastError(`Network error: ${(err as Error).message}`);
    }
  }, []);

  // v510: 看板拖拽手动排序 — KanbanView 同列内拖动收 (colKey, orderedTaskIds).
  //   一次性给目标列可见 task 写连续 queued_order (10/20/30…), POST 后:
  //     1. server scheduler 即时按新顺序排队列, 下次 dispatch 立刻生效
  //     2. 本地 setTasks 立即 patch queued_order, 不等 SSE 回推 (SSE 不覆盖
  //        此字段, 避免 patch 风暴; 真正持久的 refetch 由下次 listTasksPage 兜底)
  //   失败路径: 网络/4xx → toastError, 客户端 revert 拖拽 (把 card 移回原位
  //     via 再次 setTasks 用原顺序).
  const handleKanbanReorder = useCallback(async (colKey: string, orderedTaskIds: string[]) => {
    // 拍下当前快照, 失败时回滚
    const before = activeTasksRef.current.filter((t) => t.status === colKey);
    const beforeOrderById = new Map(before.map((t, idx) => [t.id, before[idx].queued_order]));
    const desiredOrderById = new Map<string, number>();
    const orderPayload = orderedTaskIds.map((id, idx) => {
      const order = (idx + 1) * 10; // 10/20/30… 留空位给将来插入
      desiredOrderById.set(id, order);
      return { id, order };
    });

    // 乐观更新 — 立即用 computed order 渲染, 用户拖完即见效.
    const patchOrder = (
      prev: TaskTrimmed[],
    ): TaskTrimmed[] =>
      prev.map((t) =>
        desiredOrderById.has(t.id) ? { ...t, queued_order: desiredOrderById.get(t.id) ?? null } : t,
      );
    setActiveTasks(patchOrder);

    try {
      const res = await fetch("/api/tasks/queue-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders: orderPayload }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`排序失败: ${err.error}`);
        // 回滚: 把这一列的 queued_order 改回原值
        setActiveTasks((prev) =>
          prev.map((t) => {
            const oldOrder = beforeOrderById.get(t.id);
            return oldOrder !== undefined ? { ...t, queued_order: oldOrder } : t;
          }),
        );
      }
    } catch (err) {
      toastError(`Network error: ${(err as Error).message}`);
      // 回滚同失败路径
      setActiveTasks((prev) =>
        prev.map((t) => {
          const oldOrder = beforeOrderById.get(t.id);
          return oldOrder !== undefined ? { ...t, queued_order: oldOrder } : t;
        }),
      );
    }
  }, []);

  // 卡片渲染 (active 用响应式 grid, terminal 用虚拟滚动, 但 DOM 一致).
  // 两个区块共用, 避免两边 CSS 漂移. 依赖 handleRestoreTask / handleDeleteTask,
  // 故放在它们定义之后.
  const renderTaskCard = useCallback((task: TaskTrimmed) => {
    const isDeleted = !!task.deleted_at;
    const isTerminal = TERMINAL_STATUS_SET.has(task.status);
    return (
      <div
        className={`relative bg-white rounded-lg border p-4 hover:shadow-md transition-all group ${
          isDeleted
            ? "border-red-200 opacity-60 hover:opacity-100"
            : "border-gray-200 hover:border-blue-300"
        }`}
      >
        {isDeleted ? (
          <button
            onClick={(e) => handleRestoreTask(task.id, e)}
            className="absolute top-2 right-2 p-1 rounded text-xs text-blue-500 hover:text-blue-700 hover:bg-blue-50 opacity-0 group-hover:opacity-100 transition-opacity"
            title="恢复任务"
          >
            ↩
          </button>
        ) : canDeleteTask(task.status, task.deleted_at) ? (
          <button
            onClick={(e) => handleDeleteTask(task.id, task.title, e)}
            className="absolute top-2 right-2 p-1 rounded text-xs text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
            title="删除任务"
          >
            🗑
          </button>
        ) : null}
        <Link href={`/tasks/${task.id}`} className="block">
          <div className="flex items-start gap-2 mb-2">
            <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[task.status as keyof typeof STATUS_COLORS] || "bg-gray-100"}`}>
              {STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || task.status}
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
            {/* v61+R39: 多类型 awaiting marker 角标. 优先读 awaiting_markers (新格式),
                缺省时回退 awaiting_owner_review (兼容老数据, 显示单"等拍板"). marker 颜色
                按 type 分: review=amber 等拍板, choice=blue 等选, info=gray 提示, 未知 type
                紫色兜底. 多 marker 全显, 不聚合 (damo 拍板要尽量发挥空间).
                R127 §3.2: decision type 走 DecisionBanner 不进 chip 队列. */}
            {(() => {
              const parsed = parseAwaitingMarkers(task.awaiting_markers, task.awaiting_owner_review);
              return parsed.chips.map((m, idx) => (
                <span
                  key={idx}
                  className={`px-2 py-0.5 rounded-full text-xs border ${m.color}`}
                  title={m.title}
                >
                  {m.label}
                </span>
              ));
            })()}
            {/* R94: 关联需求 chip — reviewing + 上游需求中间态时显示. 与 awaiting_markers
                chip 视觉一致 (pill + border), 但语义是「需求点 status」而非「任务 marker」. */}
            {(() => {
              const rc = getRequirementChipMeta(task);
              if (!rc) return null;
              return (
                <span
                  className={`px-2 py-0.5 rounded-full text-xs border ${rc.color}`}
                  title={rc.title}
                >
                  {rc.label}
                </span>
              );
            })()}
            {/* R108 T3: [by]<短id> chip 抽公共组件 (4 视图共用). 父组件只在
                task.dispatched_by_task_id 非空时挂载, 组件本身不做空值短路. */}
            {task.dispatched_by_task_id && (
              <TaskByChip dispatchedByTaskId={task.dispatched_by_task_id} />
            )}
            {/* R109: sub-status chip — 4 视图统一接入. 父组件只在
                task.latest_checkpoint_status 非空时挂载, 组件本身也做 null 短路 (双保险). */}
            {task.latest_checkpoint_status && (
              <TaskStatusChip status={task.latest_checkpoint_status} />
            )}
            {/* R112 续 (v129): reviewing 子终态标签 chip — 与 TaskByChip / TaskStatusChip
                同位置并排. awaiting_reason 非空时挂载 (reviewing + waiting on 子 task). */}
            {task.awaiting_reason && (
              <AwaitingReasonChip reason={task.awaiting_reason} />
            )}
            {isDeleted && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-600">已删除</span>
            )}
            {task.type && (
              <span className={`px-2 py-0.5 rounded-full text-xs border ${TYPE_COLORS[task.type] || "bg-gray-50 text-gray-500 border-gray-200"}`}>
                {TYPE_LABELS[task.type] || task.type}
              </span>
            )}
            {task.priority > 0 && (
              <span className="text-xs text-orange-500">P{task.priority}</span>
            )}
          </div>
          {/* R127 §3.2: DecisionBanner — awaiting type="decision" 一键决策. 必须在 Link 内部
              用 stopPropagation + preventDefault 拦点击, 否则点按钮会跳 /tasks/{id}. 状态本地
              setState, 成功后 router.refresh() 拉新 server props (awaiting_markers 列会被
              task 行的 SSE 事件 / 下次 load 推到, 但 banner 本身先本地关掉, 避免等刷新). */}
          {(() => {
            const parsed = parseAwaitingMarkers(task.awaiting_markers, task.awaiting_owner_review);
            if (parsed.decisions.length === 0) return null;
            return (
              <DecisionBanner
                taskId={task.id}
                decisions={parsed.decisions}
                onResolved={(decisionId, label) => {
                  // 本地乐观更新: 改 task.awaiting_markers 把那条 decision 标 resolved.
                  // 走 setActiveTasks / setTerminalTasks 同步两端 (banner 跨 active/terminal).
                  const patchMarkers = (markers: string | null): string | null => {
                    if (!markers) return markers;
                    try {
                      const arr = JSON.parse(markers);
                      if (!Array.isArray(arr)) return markers;
                      const next = arr.map((m: any) =>
                        m && m.decision_id === decisionId
                          ? { ...m, resolved_at: new Date().toISOString(), resolved_label: label }
                          : m,
                      );
                      return JSON.stringify(next);
                    } catch {
                      return markers;
                    }
                  };
                  setActiveTasks((prev) =>
                    prev.map((t) =>
                      t.id === task.id
                        ? { ...t, awaiting_markers: patchMarkers(t.awaiting_markers) }
                        : t,
                    ),
                  );
                  setTerminalTasks((prev) =>
                    prev.map((t) =>
                      t.id === task.id
                        ? { ...t, awaiting_markers: patchMarkers(t.awaiting_markers) }
                        : t,
                    ),
                  );
                }}
              />
            );
          })()}
          <h3 className={`font-medium text-gray-900 line-clamp-2 mb-1 ${isDeleted ? "line-through" : ""}`}>{task.title}</h3>
          <p className="text-xs text-gray-500 line-clamp-2 mb-2">{task.prompt_preview.slice(0, 100)}</p>
          <div className="flex items-center justify-between text-xs text-gray-400">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{task.resolved_model || task.model || "(default)"}</span>
              {task.cost_usd != null && (
                <span className="font-mono shrink-0">${task.cost_usd.toFixed(4)}</span>
              )}
            </div>
            <span className="shrink-0 ml-2">{formatUpdatedAt(task.updated_at)}</span>
          </div>
        </Link>
      </div>
    );
  }, [handleRestoreTask, handleDeleteTask]);

  const allSelected = filteredTasks.length > 0 && filteredTasks.every((t) => selectedIds.has(t.id));

  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredTasks.map((t) => t.id)));
  };

  const toggleSelect = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  // scopedStats 用 total (来自信封) 而非当前 loaded 数量, 让用户看到"还有 N 条
  // 未加载" — active 全量加载, terminal 已知 total 但只展示已加载的.
  const scopedStats = useMemo(() => {
    const counts = { ...EMPTY_STATS };
    activeTasks.forEach((task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
    });
    // terminal 已加载的累加, 未加载的用信封 total 减去 loaded 估算 (但 status 不可分,
    // 这里只展示已加载的 status 分布). total 仍传给状态栏的"全部"展示.
    terminalTasks.forEach((task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
    });
    return counts;
  }, [activeTasks, terminalTasks]);

  const scopeName = version?.name || "其他任务";
  const newTaskHref = version
    ? `/tasks/new?project=${project.id}&version=${version.id}`
    : `/tasks/new?project=${project.id}`;

  return (
    // 🆕 飞书 R139 第三批: 右滚修复 — board 视图结构复杂 (chat/cards/kanban 三态 + 条件 header/filter),
    //   不易整体包 flex-col, 直接给根 div 加 overflow-y-auto + 改 h-full 自滚.
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Header with project + version context — chat 模式下按 R126 可折叠:
          cards/kanban 模式始终显示 (用于切换回 chat 时的锚点). chat 模式下默认
          展开 (= "拿回来"), 通过 pill 行末尾 chevron 开关可收起, 偏好持久化到
          localStorage (key = chat-top-header-open-v1). 桌面态也保留 (chat-view
          的 pill 在窄主内容区也显示但与面包屑并存不冲突). */}
      {(effectiveViewMode !== "chat" || topHeaderOpen) && (
      <header className={`bg-white border-b border-gray-200 px-3 py-2 sm:px-6 sm:py-4`}>
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
          <Link href="/" className="hover:text-blue-600">项目</Link>
          <span>›</span>
          <Link href={`/${project.id}`} className="hover:text-blue-600">{project.name}</Link>
          <span>›</span>
          <span className="text-gray-700 font-medium">{scopeName}</span>
          {version && (
            <button
              type="button"
              onClick={handleCopyUrl}
              className="ml-2 text-xs text-gray-400 hover:text-gray-600 cursor-pointer transition-colors"
              title="复制当前页面链接"
            >
              ({project.id.slice(0, 8)}…/{version.id.slice(0, 8)}…)
            </button>
          )}
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">
            {project.name} / {scopeName}
          </h1>
          <div className="flex items-center gap-3">
            <ViewSwitcher mode={effectiveViewMode} onChange={handleViewModeChange} />
            <Link
              href={newTaskHref}
              className="hidden sm:inline-flex px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              + 新建 Task
            </Link>
            <Link
              href={newTaskHref}
              className="sm:hidden inline-flex items-center justify-center w-9 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              title="新建 Task"
            >
              +
            </Link>
            <Link
              href={version ? `/${project.id}/wiki?version=${version.id}` : `/${project.id}/wiki`}
              className="hidden sm:inline-flex px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
              title="项目 Wiki"
            >
              📖 Wiki
            </Link>
            <Link
              href={version
                ? `/${project.id}/${version.id}/requirements`
                : `/${project.id}/unversioned/requirements`}
              className="hidden sm:inline-flex px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
              title="需求点管理"
            >
              📋 需求点
            </Link>
          </div>
        </div>
        {(version?.cwd || project.cwd) && (
          <div className="mt-2 text-xs text-gray-500 font-mono">
            cwd: {version?.cwd || project.cwd}
            {!version?.cwd && <span className="ml-2 not-italic font-sans text-gray-400">(继承自项目)</span>}
          </div>
        )}
      </header>
      )}

      {/* Filter bar — hidden in Chat view */}
      {effectiveViewMode !== "chat" && (
        <div className="bg-white border-b border-gray-200 px-6 py-3 space-y-3">
          {/* Row 1: Status tags with counts (draggable for reordering) + sync config */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-500 shrink-0">状态</span>
            {columnOrder.map((status) => (
              <button
                key={status}
                onClick={() => toggleStatus(status)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/status-tag", status);
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingTag(status);
                }}
                onDragEnd={() => setDraggingTag(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (draggingTag && draggingTag !== status) {
                    setDragOverTag(status);
                  }
                }}
                onDragLeave={() => setDragOverTag(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggingTag && draggingTag !== status) {
                    const newOrder = [...columnOrder];
                    const fromIdx = newOrder.indexOf(draggingTag);
                    const toIdx = newOrder.indexOf(status);
                    if (fromIdx >= 0 && toIdx >= 0) {
                      newOrder.splice(fromIdx, 1);
                      newOrder.splice(toIdx, 0, draggingTag);
                      setColumnOrder(newOrder);
                    }
                  }
                  setDraggingTag(null);
                  setDragOverTag(null);
                }}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors select-none ${
                  selectedStatuses.has(status)
                    ? `${STATUS_COLORS[status] || "bg-gray-100"} ring-1 ring-current/20`
                    : "bg-gray-50 text-gray-300 line-through"
                } ${draggingTag === status ? "opacity-50" : ""} ${
                  dragOverTag === status && draggingTag ? "ring-2 ring-amber-400" : ""
                }`}
              >
                {STATUS_LABELS[status]} {(scopedStats[status] as number) > 0 && <span className="opacity-70">{scopedStats[status] as number}</span>}
              </button>
            ))}
            {/* Sync config dropdown */}
            <div className="relative ml-auto" ref={syncMenuRef}>
              <button
                onClick={() => setShowSyncMenu(!showSyncMenu)}
                className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                title="同步配置"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                </svg>
              </button>
              {showSyncMenu && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg border border-gray-200 shadow-lg z-50 py-2">
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-medium">配置同步级别</div>
                  <label className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="syncLevel"
                      checked={syncLevel === "scope"}
                      onChange={() => setSyncLevel("scope")}
                      className="text-blue-600"
                    />
                    <div>
                      <div className="text-sm text-gray-700">仅当前版本</div>
                      <div className="text-xs text-gray-400">配置仅应用于此版本</div>
                    </div>
                  </label>
                  <label className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="syncLevel"
                      checked={syncLevel === "project"}
                      onChange={() => setSyncLevel("project")}
                      className="text-blue-600"
                    />
                    <div>
                      <div className="text-sm text-gray-700">同步项目</div>
                      <div className="text-xs text-gray-400">该项目下所有版本使用相同配置</div>
                    </div>
                  </label>
                  <label className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="radio"
                      name="syncLevel"
                      checked={syncLevel === "account"}
                      onChange={() => setSyncLevel("account")}
                      className="text-blue-600"
                    />
                    <div>
                      <div className="text-sm text-gray-700">同步账号</div>
                      <div className="text-xs text-gray-400">所有项目使用相同配置</div>
                    </div>
                  </label>
                </div>
              )}
            </div>
          </div>
          {/* Row 2: Model, Tag, Search */}
          <div className="flex items-center gap-3 flex-wrap">
            <Select
              value={selectedModel}
              onChange={setSelectedModel}
              options={[{ value: "", label: "全部模型" }, ...modelOptions.map((m) => ({ value: m, label: m }))]}
              className="w-36"
            />
            <Select
              value={selectedTag}
              onChange={setSelectedTag}
              options={[{ value: "", label: "全部标签" }, ...tagOptions.map((t) => ({ value: t, label: t }))]}
              className="w-36"
            />
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜索标题、指令、结果、标签、ID..."
                className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-1.5 text-sm text-gray-700 bg-white"
              />
            </div>
            <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => setShowDeleted(e.target.checked)}
                className="rounded border-gray-300"
              />
              显示已删除
            </label>
          </div>
        </div>
      )}

      {/* View content */}
      {effectiveViewMode === "cards" && (
        <>
          {/* Empty state */}
          {filteredTasks.length === 0 && (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-gray-500 text-sm">
                {activeTasks.length === 0 && terminalTasks.length === 0
                  ? `${scopeName}暂无 task`
                  : "没有匹配筛选条件的 task"}
              </p>
            </div>
          )}

          {/* Task cards grid — 分两段: active (响应式 grid, 通常 <20), terminal (虚拟滚动, 300+). */}
          {filteredTasks.length > 0 && (
            <div className="px-6 py-4 space-y-6">
              {/* Active 段: 全量加载, 保留多列响应式 grid */}
              {filteredActive.length > 0 && (
                <section>
                  <h2 className="text-sm font-medium text-gray-500 mb-2">
                    活跃 <span className="opacity-60">({filteredActive.length})</span>
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {filteredActive.map((task) => (
                      <div key={task.id}>{renderTaskCard(task)}</div>
                    ))}
                  </div>
                </section>
              )}

              {/* Terminal 段: 虚拟滚动 — 接受单列强制 (与 @tanstack/react-virtual 兼容) */}
              {filteredTerminal.length > 0 && (
                <section>
                  <h2 className="text-sm font-medium text-gray-500 mb-2">
                    历史 <span className="opacity-60">({terminalTotal})</span>
                  </h2>
                  <VirtualizedCards
                    items={filteredTerminal}
                    getKey={(t) => t.id}
                    renderItem={(task) => renderTaskCard(task)}
                  />
                  {terminalHasMore && (
                    <div className="mt-3 flex justify-center">
                      <button
                        onClick={loadMoreTerminal}
                        disabled={isLoadingMore}
                        className="px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                      >
                        {isLoadingMore
                          ? "加载中..."
                          : `加载更多 (已加载 ${terminalTasks.length} / 共 ${terminalTotal})`}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </>
      )}

      {effectiveViewMode === "kanban" && (
        <KanbanView
          tasks={filteredTasks}
          selectedStatuses={selectedStatuses}
          columnOrder={columnOrder}
          onColumnOrderChange={setColumnOrder}
          onStatusChange={runAction}
          onDelete={handleDeleteTask}
          onRestore={handleRestoreTask}
          // v510: 看板同列拖动手动排序 — 一次性写连续 queued_order (10/20/30…)
          //   给目标列可见 task, 然后 setTasks 本地立即生效 (不等 SSE 回推:
          //   queued_order 不在 SSE patch 列表里). scheduler 已在 server 端
          //   即时按新顺序重排, 下次 dispatch 自然生效.
          onReorder={handleKanbanReorder}
          terminalTotal={terminalTotal}
          terminalLoaded={terminalTasks.length}
          onLoadMoreTerminal={loadMoreTerminal}
          isLoadingMore={isLoadingMore}
        />
      )}

      {effectiveViewMode === "chat" && (
        <ChatView
          tasks={filteredTasks}
          project={project}
          version={version}
          projectNames={{ [project.id]: project.name }}
          versionNames={version ? { [version.id]: version.name } : {}}
          allowSwitchProject={false}
          onScopeChange={(projectId, versionId) => {
            // URL 锁死场景下, 切换 version → 跳转新版本 URL
            if (versionId && versionId !== version?.id) {
              router.push(`/${projectId}/${versionId}?mode=chat`);
            }
          }}
          onTaskCreated={(task) => {
            // ChatView 新建 task. 转成 TaskTrimmed 形状, 按 status 落到对应数组.
            // preview 字段用本地 slice 算 (与 DB SUBSTR 同口径), SSE / refresh 后续覆盖.
            const trimmed = taskToTrimmed(task);
            if (TERMINAL_STATUS_SET.has(trimmed.status)) {
              setTerminalTasks(prev => [trimmed, ...prev]);
              setTerminalTotal(prev => prev + 1);
            } else {
              setActiveTasks(prev => [trimmed, ...prev]);
            }
          }}
          initialTaskId={urlTaskId}
          // R51+R126 第二轮: 之前把 ViewSwitcher 通过 prop 注入 ChatView pill 行
          // 是因为 R51 时 chat 模式整块 header 隐藏, ViewSwitcher 跟着没了. R126
          // 把 header 拿回来后, 上方 header 自带 ViewSwitcher, pill 行末尾再渲染
          // 一份 = 冗余. 停传 viewSwitcher, pill 行末尾只剩新增的 chevron 开关.
          // 全平台只一份 ViewSwitcher (在 header 里), 各模式一致.
          // R126: 顶部 header 折叠/展开开关 (上方的"项目面包屑 + 视图切换 + 快捷
          // 入口"那块). ChatView 只在两 prop 同时存在时渲染开关按钮 (避免影响
          // global-board 等始终展示 header 的 caller). 状态在 board-client 这边
          // 持有, 与 localStorage 同步.
          topHeaderVisible={topHeaderOpen}
          onToggleTopHeader={handleToggleTopHeader}
        />
      )}

      {effectiveViewMode === "list" && (
        <GlobalListView
          tasks={filteredTasks}
          projects={[]}
          projectNames={{ [project.id]: project.name }}
          versionNames={version ? { [version.id]: version.name } : {}}
        />
      )}

      {/* grouped 在单 project+version 上下文无意义 (只有一个项目/版本分不出组).
          退化为 cards 提示, 引导用户到 /global 看跨项目分组视图. */}
      {effectiveViewMode === "grouped" && (
        <div className="px-6 py-12 text-center">
          <div className="text-4xl mb-3">📁</div>
          <p className="text-gray-700 mb-2">按项目分组视图仅在 /global 跨项目上下文有意义</p>
          <p className="text-gray-500 text-sm mb-4">单 project+version 下请使用「列表」「卡片」或「看板」视图</p>
          <Link
            href="/global?mode=grouped"
            className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            前往 /global 按项目分组
          </Link>
        </div>
      )}

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="删除任务"
        message={`确定删除「${deleteConfirm?.taskTitle || ""}」？删除后可通过「显示已删除」恢复。`}
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={confirmDeleteTask}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}