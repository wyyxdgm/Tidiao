"use client";

// 功能: 全局看板 - 跨项目跨版本展示所有任务, 支持项目/版本筛选和 cards/kanban/chat
// 三视图, 订阅 /api/events 实时更新. active/terminal 状态分流 + 精简投影,
// 性能改造版.
//
// / 关注点:
//   - scopeKey="global" 持久化独立的视图配置(不与单个项目版本混用)
//   - chat 视图的新建任务使用筛选栏选中的 project/version, 未选时 ChatView 内部 toast 提示
//   - cards/kanban 卡片显示项目/版本名以区分归属(用 projectNames/versionNames map)
//   - 订阅全局 SSE /api/events(替代项目级 SSE), emitEvent 转发 status_change/cost
//   - 版本下拉根据选中项目联动(选项目后只列该项目版本)
//   - 状态分流 + 精简投影: active 全量 + realtime, terminal 按需分页 (loadMoreTerminal)
//   - SSE handler 按 event.to 分流 (与 board-client.tsx 同口径): 跨数组移动 /
//     原地 patch / 单集合 refetch — 不再触发整数组 debounced refresh (那是改造
//     收益被吃回去的根源).
//   - ChatView 回调改成 onTaskCreated(task: Task) 单点 — Board 自己拆分状态到
//     active/terminal 数组.

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  STATUS_LABELS, STATUS_COLORS, TYPE_LABELS, TYPE_COLORS,
  BOARD_ACTIVE_STATUSES, BOARD_TERMINAL_STATUSES,
} from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import { useTick } from "@/lib/hooks/use-tick";
import { useBoardConfig } from "@/lib/hooks/use-board-config";
import type { BoardViewMode } from "@/lib/hooks/use-board-config";
import { useGlobalEventSource } from "@/lib/use-global-event-source";
import ConfirmDialog from "@/components/ConfirmDialog";
import Select from "@/components/Select";
import ViewSwitcher from "@/components/ViewSwitcher";
import VirtualizedCards from "@/components/VirtualizedCards";
import { useToastActions } from "@/components/Toast";
import KanbanView from "@/app/[projectId]/[versionId]/kanban-view";
import ChatView from "@/app/[projectId]/[versionId]/chat-view";
import { computeTaskMove } from "@/app/[projectId]/[versionId]/board-task-move";
import TaskByChip from "@/components/TaskByChip";
import TaskStatusChip from "@/components/TaskStatusChip";
import AwaitingReasonChip from "@/components/AwaitingReasonChip";
import GlobalListView from "./global-list-view";
import GlobalGroupedView from "./global-grouped-view";
import type { TaskTrimmed, Task } from "@/lib/runtime/types";
import { matchesTaskSearch } from "@/lib/runtime/task-search";
import { getRequirementChipMeta } from "@/lib/runtime/requirement-chip";

const ACTIVE_STATUS_SET = new Set<string>(BOARD_ACTIVE_STATUSES);
const TERMINAL_STATUS_SET = new Set<string>(BOARD_TERMINAL_STATUSES);

// R84: 解析 awaiting_markers + awaiting_owner_review 回退, 返回 chip 渲染列表.
// 与 board-client.tsx / kanban-view.tsx / task-header.tsx 同源（详见三处文件注释
// 关于「后续真要统一, 抽到 @/lib/awaiting-markers.ts 即可」的 TODO）。R84 要求
// global-board 也展示 chip，否则全局看板看不到 task 在等什么。DecisionBanner 不在这里
// 走（global-board 不挂决策按钮，与 board-client 边界不同）。
function parseAwaitingMarkers(
  awaitingMarkersJson: string | null,
  awaitingOwnerReview: number,
): Array<{ label: string; title: string; color: string }> {
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
            cn: t || "需拍板",
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
      // 解析失败静默走回退（与 board-client 同款容错）。
    }
  }
  if (awaitingOwnerReview === 1) {
    return [
      {
        label: "需拍板",
        title: "Agent 标了需拍板 — approve 会被拒, 需先调 POST /api/tasks/{id}/unset-awaiting-review",
        color: "bg-amber-100 text-amber-800 border-amber-200",
      },
    ];
  }
  return [];
}

// 本地 slice (与 DB 层 SUBSTR 同口径): 服务端真值会经 SSE / fetch 覆盖.
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
    awaiting_markers: t.awaiting_markers ?? null, // v61+R39: 多类型 marker JSON. R84 起 global-board 也渲染 chip（与 board-client / kanban-view 同源）。
    dispatched_by_task_id: t.dispatched_by_task_id ?? null, // v32+R39: global-board 也透传, 跟 board-client 保持形状一致 (Q2 后续接入)
    // R94: 同 board-client, 新建 task 默认 null, 下次 fetch 拉真值.
    requirement_status: null,
    // R109: 同 board-client / kanban-view 口径. 新建/本地 patch task 默认 null, 下次
    //   SSE 全量 refetch 走 listTasksPage 拉回真值.
    latest_checkpoint_status: null,
    // v510: 排队顺序. 同 board-client / kanban-view 口径, 新建/本地 patch task 默认
    //   null, 下次 SSE refetch 拉回真值 (TaskTrimmed 类型要求存在).
    queued_order: t.queued_order ?? null,
    queued_reason: t.queued_reason ?? null,
    // R112 续 (v129): reviewing 子终态标签. 同 board-client 口径, 默认 null, 下次 SSE
    //   refetch 拉回真值. UI 走 AwaitingReasonChip.
    awaiting_reason: null,
    // R99: 定时任务派发标记. 同步透传 schedule_id (Task 上有 → TaskTrimmed 也有),
    //   global-board 的看板卡片复用 board-client 的「定时」chip 渲染.
    schedule_id: t.schedule_id ?? null,
  };
}

type Project = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  current_version_id: string | null;
  current_version_name: string | null;
};

type Version = {
  id: string;
  project_id: string;
  name: string;
};

function formatUpdatedAt(iso: string): string {
  const d = parseDbTime(iso);
  if (!d) return "";
  const M = (d.getMonth() + 1).toString().padStart(2, "0");
  const D = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${M}-${D} ${h}:${m}`;
}

export default function GlobalBoard({
  initialTasks,
  projects,
  versions,
  // 🆕 DAG P3 收尾 (2026-09-21): L1 平台开关. server global/page.tsx 解析后
  //   传入. 关 = 不渲染 verifying (筛选条/列定义/默认选中都不出现).
  globallyEnabled,
}: {
  initialTasks: TaskTrimmed[];
  projects: Project[];
  versions: Version[];
  globallyEnabled: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error: toastError } = useToastActions();
  // R161: 每 60s 强制 re-render 让任务时间显示自动刷新 (分钟级精度足够).
  useTick(60_000);

  // 把 RSC 的 initialTasks 按 status 拆到两个数组 — active 全量进, terminal 进
  // 第一页 (initialTasks 只到 limit 那么, 后续 loadMoreTerminal). 视觉上 active
  // 在前, terminal 在后.
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

  const {
    viewMode, setViewMode,
    selectedStatuses, toggleStatus,
    columnOrder, setColumnOrder,
  } = useBoardConfig("global", { showVerifying: globallyEnabled });

  // URL params override localStorage: ?mode=cards|kanban|chat takes priority
  // R51 子 bug #2 (global-board 同源): 不再 setViewMode(urlMode) 写回 localStorage.
  //   全局看板用 scopeKey="global" 共用一份, 一次 chat 链接污染 = 全局都 chat.
  const urlMode = searchParams.get("mode") as BoardViewMode | null;
  const urlTaskId = searchParams.get("taskId");
  const effectiveViewMode: BoardViewMode =
    urlMode && ["cards", "kanban", "chat", "list", "grouped"].includes(urlMode) ? urlMode : viewMode;

  useEffect(() => {
    if (!urlTaskId) return;
    if (effectiveViewMode !== "chat") {
      router.replace(`/tasks/${urlTaskId}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewModeChange = useCallback((mode: BoardViewMode) => {
    setViewMode(mode);
    if (urlMode || urlTaskId) {
      router.replace(window.location.pathname);
    }
  }, [setViewMode, urlMode, urlTaskId, router]);

  // Filters
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [searchText, setSearchText] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  // v57 (R15 task 收藏): 只看当前用户收藏的 task. 切换时触发 refetch.
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ taskId: string; taskTitle: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText), 200);
    return () => clearTimeout(t);
  }, [searchText]);

  // Name maps for scope labels on cards/kanban
  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects]
  );
  const versionNames = useMemo(
    () => Object.fromEntries(versions.map((v) => [v.id, v.name])),
    [versions]
  );

  // Version dropdown is filtered by selected project (联动)
  const versionOptions = useMemo(() => {
    const list = selectedProjectId
      ? versions.filter((v) => v.project_id === selectedProjectId)
      : versions;
    return list.map((v) => ({
      value: v.id,
      label: `${projectNames[v.project_id] || "?"} / ${v.name}`,
    }));
  }, [versions, selectedProjectId, projectNames]);

  // Reset version if it no longer matches selected project
  useEffect(() => {
    if (selectedProjectId && selectedVersionId) {
      const v = versions.find((x) => x.id === selectedVersionId);
      if (!v || v.project_id !== selectedProjectId) setSelectedVersionId("");
    }
  }, [selectedProjectId, selectedVersionId, versions]);

  // Refs: 让 SSE handler 读"当前"state (避免 stale closure).
  const activeTasksRef = useRef(activeTasks);
  useEffect(() => { activeTasksRef.current = activeTasks; }, [activeTasks]);
  const terminalTasksRef = useRef(terminalTasks);
  useEffect(() => { terminalTasksRef.current = terminalTasks; }, [terminalTasks]);
  const showDeletedRef = useRef(showDeleted);
  useEffect(() => { showDeletedRef.current = showDeleted; }, [showDeleted]);
  const favoriteOnlyRef = useRef(favoriteOnly);
  useEffect(() => { favoriteOnlyRef.current = favoriteOnly; }, [favoriteOnly]);

  // 拼接 /api/tasks/page 的 query string. 看板分流 statusGroup + project/version 收窄.
  const buildPageQuery = useCallback((statusGroup: "active" | "terminal", offset: number, limit: number) => {
    const params = new URLSearchParams();
    params.set("statusGroup", statusGroup);
    if (selectedProjectId) {
      params.set("project", selectedProjectId);
      if (selectedVersionId) params.set("version", selectedVersionId);
    }
    if (showDeletedRef.current) params.set("includeDeleted", "true");
    // v57 (R15 task 收藏): favoriteOnly 同步到 query, 服务端走 EXISTS 子查询.
    if (favoriteOnlyRef.current) params.set("favorite", "true");
    // R114 (后台搜索): debouncedSearch 透传给服务端 — 非空时服务端 LIKE 已收窄,
    // 客户端 matchesTaskSearch 退化为 no-op (结果一致, 双层冗余无害).
    if (debouncedSearch) params.set("q", debouncedSearch);
    // R114 第二轮 (筛选全走后端): model + tag 也透传给服务端.
    if (selectedModel) params.set("model", selectedModel);
    if (selectedTag) params.set("tag", selectedTag);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return params;
  }, [selectedProjectId, selectedVersionId, debouncedSearch, selectedModel, selectedTag]);

  // 拉 active 集合 (全量, limit 200 足够).
  const refreshActive = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/page?${buildPageQuery("active", 0, 200).toString()}`);
      const data = await res.json();
      setActiveTasks(Array.isArray(data.items) ? data.items : []);
    } catch {
      // ignore; SSE 会重试
    }
  }, [buildPageQuery]);

  // 拉 terminal 集合 (分页).
  const refreshTerminal = useCallback(async (offset = 0, reset = true) => {
    try {
      const res = await fetch(`/api/tasks/page?${buildPageQuery("terminal", offset, 50).toString()}`);
      const data = await res.json();
      const items: TaskTrimmed[] = Array.isArray(data.items) ? data.items : [];
      setTerminalTasks(prev => reset ? items : [...prev, ...items]);
      setTerminalTotal(typeof data.total === "number" ? data.total : items.length);
      setTerminalHasMore(!!data.hasMore);
    } catch {
      // ignore
    }
  }, [buildPageQuery]);

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

  // 筛选条件变化 → 重拉 (project/version 收窄改变服务端结果).
  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, selectedVersionId, showDeleted, favoriteOnly]);

  // Subscribe to global SSE for cross-project real-time updates.
  // status_change 按 event.to 分四路 (与 board-client.tsx 同口径, 注释见那里):
  // active↔active / terminal↔terminal 原地 patch; 跨集合则移动; 未知 task 按
  // 方向只 refetch 一个集合; cost 事件原地 patch; 不再 debounced full refetch.
  // 共享全局单例 EventSource (NavigationTree / NavSidebar / chat-view 也订阅),
  // 避免与它们各开一条长连接占满浏览器同域并发名额.
  useGlobalEventSource((raw) => {
    const event = raw as {
      type: string;
      task_id?: string;
      to?: TaskTrimmed["status"];
      cost_usd?: unknown;
    };
    if (event.type === "status_change" && event.task_id && event.to) {
      const id = event.task_id;
      const toStatus = event.to;
      const toIsTerminal = TERMINAL_STATUS_SET.has(toStatus);
      const inActive = activeTasksRef.current.some((t) => t.id === id);
      const inTerminal = terminalTasksRef.current.some((t) => t.id === id);

      if (!inActive && !inTerminal) {
        if (toIsTerminal) refreshTerminal(0, true);
        else refreshActive();
        return;
      }

      if (inTerminal && toIsTerminal) {
        setTerminalTasks(prev => prev.map(t =>
          t.id === id
            ? { ...t, status: toStatus, updated_at: new Date().toISOString() }
            : t
        ));
      } else if (inActive && !toIsTerminal) {
        setActiveTasks(prev => prev.map(t =>
          t.id === id
            ? { ...t, status: toStatus, updated_at: new Date().toISOString() }
            : t
        ));
      } else if (inActive && toIsTerminal) {
        const moved = activeTasksRef.current.find(t => t.id === id);
        if (moved) {
          const patched: TaskTrimmed = { ...moved, status: toStatus, updated_at: new Date().toISOString() };
          setActiveTasks(prev => prev.filter(t => t.id !== id));
          setTerminalTasks(prev => [patched, ...prev]);
          setTerminalTotal(prev => prev + 1);
        }
      } else if (inTerminal && !toIsTerminal) {
        const moved = terminalTasksRef.current.find(t => t.id === id);
        if (moved) {
          const patched: TaskTrimmed = { ...moved, status: toStatus, updated_at: new Date().toISOString() };
          setTerminalTasks(prev => prev.filter(t => t.id !== id));
          setActiveTasks(prev => [patched, ...prev]);
          setTerminalTotal(prev => Math.max(0, prev - 1));
        }
      }
      return;
    }

    if (event.type === "cost" && event.task_id && typeof event.cost_usd === "number") {
      const id = event.task_id;
      const cost = event.cost_usd;
      setActiveTasks(prev => prev.some(t => t.id === id)
        ? prev.map(t => t.id === id ? { ...t, cost_usd: cost } : t)
        : prev
      );
      setTerminalTasks(prev => prev.some(t => t.id === id)
        ? prev.map(t => t.id === id ? { ...t, cost_usd: cost } : t)
        : prev
      );
    }
  });

  const modelOptions = useMemo(() => {
    const m = new Set<string>();
    [...activeTasks, ...terminalTasks].forEach((t) => { if (t.model) m.add(t.model); });
    return Array.from(m).sort();
  }, [activeTasks, terminalTasks]);

  const tagOptions = useMemo(() => {
    const m = new Set<string>();
    [...activeTasks, ...terminalTasks].forEach((t) => {
      if (t.tags) {
        try { JSON.parse(t.tags).forEach((tag: string) => m.add(tag)); } catch {}
      }
    });
    return Array.from(m).sort();
  }, [activeTasks, terminalTasks]);

  const filterPredicate = useCallback((t: TaskTrimmed) => {
    if (t.deleted_at && !showDeleted) return false;
    if (!selectedStatuses.has(t.status)) return false;
    if (selectedProjectId && t.project_id !== selectedProjectId) return false;
    if (selectedVersionId && t.version_id !== selectedVersionId) return false;
    if (selectedModel && t.model !== selectedModel) return false;
    if (selectedTag) {
      let tt: string[] = [];
      try { tt = t.tags ? JSON.parse(t.tags) : []; } catch { tt = []; }
      if (!tt.includes(selectedTag)) return false;
    }
    if (debouncedSearch) {
      if (!matchesTaskSearch(t, debouncedSearch)) return false;
    }
    return true;
  }, [selectedStatuses, selectedProjectId, selectedVersionId, selectedModel, selectedTag, debouncedSearch, showDeleted]);

  const filteredActive = useMemo(
    () => activeTasks.filter(filterPredicate),
    [activeTasks, filterPredicate]
  );
  const filteredTerminal = useMemo(
    () => terminalTasks.filter(filterPredicate),
    [terminalTasks, filterPredicate]
  );
  const filteredTasks = useMemo(
    () => [...filteredActive, ...filteredTerminal],
    [filteredActive, filteredTerminal]
  );

  // 卡片渲染移到 handleRestore / handleDeleteTask 定义之后 (依赖顺序).

  // Task actions
  const { warning: toastWarning } = useToastActions();
  const runAction = useCallback(async (taskId: string, action: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/${action}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`${action} failed: ${err.error}`);
        return;
      }
      // Optimistic update: 与 board-client.tsx 同口径, 走 computeTaskMove 纯函数分四路
      // (active↔active 原地 patch / active↔terminal 跨组 / terminal 内 patch / 未知
      // task 原样返回交给 SSE 兜底). R54 修复点: 原版无条件 `setActiveTasks(filter)`
      // + 仅 terminal 才补回 terminalTasks → 拖 queued→running / paused→running 时
      // 卡片从双数组同时消失 (SSE 没触发就永久消失).
      const data = await res.json().catch(() => null);
      if (data?.status) {
        // R54 N 列: 拖到「运行中」若并发已满, 后端真返 status=queued → 起 warning
        // toast 提示, 别用 alert (damo 原话「可以toast,好看的,别alert」). 仅 start
        // 会触发 queued, pause/resume 不会.
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
        setActiveTasks(result.active);
        setTerminalTasks(result.terminal);
      }
    } catch (err: any) {
      toastError(`Network error: ${err.message}`);
    }
  }, []);

  const handleDeleteTask = useCallback((taskId: string, taskTitle: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleteConfirm({ taskId, taskTitle });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const { taskId } = deleteConfirm;
    setDeleteConfirm(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`删除失败: ${err.error}`);
        return;
      }
      const now = new Date().toISOString();
      setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, deleted_at: now } : t));
      setTerminalTasks(prev => prev.map(t => t.id === taskId ? { ...t, deleted_at: now } : t));
    } catch (err: any) {
      toastError(`Network error: ${err.message}`);
    }
  }, [deleteConfirm]);

  const handleRestore = useCallback(async (taskId: string, e: React.MouseEvent) => {
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
    } catch (err: any) {
      toastError(`Network error: ${err.message}`);
    }
  }, []);

  // 卡片渲染 (active 用响应式 grid, terminal 用虚拟滚动, 但 DOM 一致).
  // 两个区块共用, 避免两边 CSS 漂移. 依赖 handleRestore / handleDeleteTask,
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
            onClick={(e) => handleRestore(task.id, e)}
            className="absolute top-2 right-2 p-1 rounded text-xs text-blue-500 hover:text-blue-700 hover:bg-blue-50 opacity-0 group-hover:opacity-100 transition-opacity"
            title="恢复任务"
          >
            ↩
          </button>
        ) : isTerminal ? (
          <button
            onClick={(e) => handleDeleteTask(task.id, task.title, e)}
            className="absolute top-2 right-2 p-1 rounded text-xs text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
            title="删除任务"
          >
            🗑
          </button>
        ) : null}
        <Link href={`/tasks/${task.id}`} className="block">
          {/* Scope label */}
          {task.project_id && (
            <div className="text-xs text-gray-400 mb-1.5 truncate">
              <span>{projectNames[task.project_id] || "?"}</span>
              {task.version_id && (
                <>
                  <span className="mx-1">›</span>
                  <span>{versionNames[task.version_id] || "?"}</span>
                </>
              )}
            </div>
          )}
          <div className="flex items-start gap-2 mb-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[task.status as keyof typeof STATUS_COLORS] || "bg-gray-100"}`}>
              {STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] || task.status}
            </span>
            {/* R84: awaiting marker chips — 与 board-client / kanban-view 同源, 补齐 global-board 缺口。
                R84 前 global-board 只透传 awaiting_markers 不渲染，全局看板看不到 task 在等什么。 */}
            {parseAwaitingMarkers(task.awaiting_markers, task.awaiting_owner_review).map((m, idx) => (
              <span
                key={idx}
                className={`px-2 py-0.5 rounded-full text-xs border ${m.color}`}
                title={m.title}
              >
                {m.label}
              </span>
            ))}
            {/* R94: 关联需求 chip — reviewing + 上游需求中间态时显示. 与 board-client / kanban
                同源, 共用 getRequirementChipMeta. */}
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
            {isDeleted && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-600">已删除</span>
            )}
            {/* R108 T3: [by]<短id> chip — 与 board-client / kanban-view 同源 (TaskByChip).
                字段 line 128 已透传 (global-board 跟 board-client 形状一致), 只缺渲染. */}
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
              <span className={`px-2 py-0.5 rounded-full text-xs border ${TYPE_COLORS[task.type] || "bg-gray-50 text-gray-500 border-gray-200"}`}>
                {TYPE_LABELS[task.type] || task.type}
              </span>
            )}
            {task.priority > 0 && (
              <span className="text-xs text-orange-500">P{task.priority}</span>
            )}
          </div>
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
  }, [handleRestore, handleDeleteTask, projectNames, versionNames]);

  // Chat view derives project/version from filter selection
  const chatProject = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) : null;
  const chatVersion = selectedVersionId ? versions.find((v) => v.id === selectedVersionId) : null;
  const chatProjectForView = chatProject
    ? { id: chatProject.id, name: chatProject.name, description: chatProject.description }
    : null;
  const chatVersionForView = chatVersion
    ? { id: chatVersion.id, name: chatVersion.name, feishu_url: null, feishu_sheet: null, cwd: null }
    : null;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
          <Link href="/" className="hover:text-blue-600">项目</Link>
          <span>›</span>
          <span className="text-gray-700 font-medium">全局看板</span>
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">
            全局看板 <span className="text-sm font-normal text-gray-500">({filteredTasks.length} 个任务)</span>
          </h1>
          <ViewSwitcher mode={effectiveViewMode} onChange={handleViewModeChange} />
        </div>
      </header>

      {/* Filter bar — hidden in Chat view */}
      {effectiveViewMode !== "chat" && (
        <div className="bg-white border-b border-gray-200 px-6 py-3 space-y-3">
          {/* Row 1: project / version / status tags */}
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={selectedProjectId}
              onChange={setSelectedProjectId}
              options={[{ value: "", label: "全部项目" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              className="w-36"
            />
            <Select
              value={selectedVersionId}
              onChange={setSelectedVersionId}
              options={[{ value: "", label: "全部版本" }, ...versionOptions]}
              className="w-48"
            />
            <span className="text-sm text-gray-500 ml-2 shrink-0">状态</span>
            {columnOrder.map((status) => (
              <button
                key={status}
                onClick={() => toggleStatus(status)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors select-none ${
                  selectedStatuses.has(status)
                    ? `${STATUS_COLORS[status] || "bg-gray-100"} ring-1 ring-current/20`
                    : "bg-gray-50 text-gray-300 line-through"
                }`}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
          </div>
          {/* Row 2: model / tag / search / showDeleted */}
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
            {/* v57 (R15 task 收藏): 顶部筛选条加"只看收藏"开关. 走 listTasksPage
                的 favorite 参数 + 服务端 EXISTS 子查询, 多设备同步由服务端权威.
                切换触发 refreshAll (effect 依赖 favoriteOnly). */}
            <label
              className={`flex items-center gap-1.5 text-sm cursor-pointer select-none shrink-0 ${
                favoriteOnly ? "text-amber-600" : "text-gray-500"
              }`}
              title="只看当前用户收藏的任务 (跨设备同步)"
            >
              <input
                type="checkbox"
                checked={favoriteOnly}
                onChange={(e) => setFavoriteOnly(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className={favoriteOnly ? "text-amber-500" : ""}>★</span>
              只看收藏
            </label>
          </div>
        </div>
      )}

      {/* cards view */}
      {effectiveViewMode === "cards" && (
        <>
          {filteredTasks.length === 0 && (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-gray-500 text-sm">
                {activeTasks.length === 0 && terminalTasks.length === 0
                  ? "暂无任务"
                  : "没有匹配筛选条件的任务"}
              </p>
            </div>
          )}
          {filteredTasks.length > 0 && (
            <div className="px-6 py-4 space-y-6">
              {/* Active 段: 响应式 grid, 永远全量 (typically <20) */}
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

              {/* Terminal 段: 虚拟滚动 — 强制单列 (与 @tanstack/react-virtual 兼容) */}
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
          onRestore={handleRestore}
          scopeLabels={{ projectNames, versionNames }}
          terminalTotal={terminalTotal}
          terminalLoaded={terminalTasks.length}
          onLoadMoreTerminal={loadMoreTerminal}
          isLoadingMore={isLoadingMore}
        />
      )}

      {effectiveViewMode === "chat" && (
        <ChatView
          tasks={filteredTasks}
          project={chatProjectForView}
          version={chatVersionForView}
          projectNames={projectNames}
          versionNames={versionNames}
          allowSwitchProject={true}
          onScopeChange={(projectId, versionId) => {
            // chat-view 切了 project/version → 同步筛选栏 + 触发 refetch.
            setSelectedProjectId(projectId);
            setSelectedVersionId(versionId || "");
          }}
          onTaskCreated={(task) => {
            // ChatView 新建 task — 按 status 落到对应数组. preview 用本地 slice
            // (DB SUBSTR 同口径), 后续 SSE / refresh 覆盖.
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
          // 是因为 R51 时 chat 模式整块 header 隐藏, ViewSwitcher 跟着没了. global-
          // board 始终展示 header (含 ViewSwitcher), 注入 = 冗余. 停传 viewSwitcher,
          // 让 pill 行末尾只剩 ChatView 自己新增的 chevron 折叠开关. 全平台只一份
          // ViewSwitcher (在 header 里), 各模式一致.
        />
      )}

      {effectiveViewMode === "list" && (
        <GlobalListView
          tasks={filteredTasks}
          projects={projects}
          projectNames={projectNames}
          versionNames={versionNames}
        />
      )}

      {effectiveViewMode === "grouped" && (
        <GlobalGroupedView
          tasks={filteredTasks}
          projects={projects}
          projectNames={projectNames}
          versionNames={versionNames}
        />
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        title="删除任务"
        message={`确定删除「${deleteConfirm?.taskTitle || ""}」？删除后可通过「显示已删除」恢复。`}
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}