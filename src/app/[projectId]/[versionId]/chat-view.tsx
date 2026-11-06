"use client";

// Chat view — WeChat-like split: left task list + right TaskDetailClient + RightDock.

import { useState, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { useRouter, usePathname } from "next/navigation";
import ChatTaskList from "./chat-task-list";
import TaskDetailClient from "@/app/tasks/[id]/task-detail-client";
import {
  STATUS_LABELS, TOOL_PRESETS,
} from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { filesFromDataTransfer } from "@/lib/clipboard-files";
import { useToastActions } from "@/components/Toast";
import Select from "@/components/Select";
import { useRecentProject } from "@/lib/hooks/use-recent-project";
import { useAvailableModels } from "@/lib/hooks/use-available-models";
import { useGlobalEventSource } from "@/lib/use-global-event-source";
import type { Task, TaskTrimmed } from "@/lib/runtime/types";

interface ChatViewProps {
  tasks: TaskTrimmed[];
  // 新建 task 时由 ChatView 调用. Board 收到后, 按 task.status 落到对应数组.
  // task 是 POST /api/tasks 返回的全字段 Task — 含 prompt/result 全文. Board 不
  // 直接渲染该 task (只是把它塞进 activeTasks/terminalTasks), 后续靠 refetch
  // 把 preview 字段补回来.
  onTaskCreated: (task: Task) => void;
  // Initial project/version — caller 传的"当前上下文". chat 模式下 chat-view 自
  // 己维护 activeProject/activeVersion (pill 可改); 不传时 fallback 到 recent
  // localStorage. handleCreateTask 优先用 activeProject/activeVersion, 再 fallback
  // 到这里的 project/version props (向后兼容老的 chat 视图代码路径).
  project?: { id: string; name: string; description: string | null } | null;
  version: { id: string; name: string; feishu_url: string | null; feishu_sheet: string | null; cwd: string | null } | null;
  initialTaskId?: string | null;
  // Scope labels for chat list + header — 显示每条 task 的项目/版本.
  // 单项目 caller 也传 (所有 task 同 project, 一致显示).
  projectNames?: Record<string, string>;
  versionNames?: Record<string, string>;
  // 是否允许 pill 切换 project. URL 锁死的 caller (board-client) 传 false;
  // 全局 caller (global-board) 传 true.
  allowSwitchProject?: boolean;
  // pill 切换 project/version 后通知 caller — caller 用它同步自己的筛选/URL.
  onScopeChange?: (projectId: string, versionId: string | null) => void;
  // 视图切换器(卡片/看板/聊天),由 caller 在 pill 行末尾展示.
  // board-client / global-board 在 chat 模式下原本整块 header 都被隐藏,
  // 因此没有切回 cards/kanban 的入口(R51 反馈). caller 显式传 prop,默认不渲染,
  // 保持向后兼容(其他嵌入 ChatView 的 caller 不受影响).
  viewSwitcher?: React.ReactNode;
  // 顶部 header 折叠/展开开关(R126). 配套 board-client 的"上方整块"(面包屑 +
    // project/version 名 + ViewSwitcher + 新建/Wiki/需求点 入口)显示/收起.
    // 两个 prop 都传才渲染开关,任一缺失就不渲染(向后兼容, global-board 头
    // 始终展示,不传就不出现这个开关).
  topHeaderVisible?: boolean;
  onToggleTopHeader?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 文件名补全 + DataTransfer → File[] 抽到 src/lib/clipboard-files.ts (单测见旁),
// chat-view 这里只 import + 用, 不重复实现.

// 同步本地 liveTasks 到父级 props: 父级是 filter/sort 的权威, 本地严格按
// props 的 id 集合 + 顺序 + 内容. SSE patch 的 status 已就地改在每个 task 上,
// 即使父级还没收到 SSE 事件, 下次 props 更新时新 status 也会覆盖.
function mergeTasksFromProps(propsTasks: TaskTrimmed[]): TaskTrimmed[] {
  return [...propsTasks];
}

export default function ChatView({ tasks, project, version, onTaskCreated, initialTaskId, projectNames, versionNames, allowSwitchProject = false, onScopeChange, viewSwitcher, topHeaderVisible, onToggleTopHeader }: ChatViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { error: toastError } = useToastActions();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId ?? null);
  const [mobilePanel, setMobilePanel] = useState<"list" | "chat">(initialTaskId ? "chat" : "list");
  const [showNewTaskInput, setShowNewTaskInput] = useState(false);
  const [newPrompt, setNewPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedModel, setAdvancedModel] = useState("");
  const [advancedEffort, setAdvancedEffort] = useState("high");
  const [advancedMaxTurns, setAdvancedMaxTurns] = useState("");
  const { options: modelOptions } = useAvailableModels();
  const [advancedAutoApprove, setAdvancedAutoApprove] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 左侧任务列表: props.tasks 是父级 filter 后的权威, 但父级 SSE 漏接/未及时
  // 重渲染会让 props.status 不新鲜 — 右侧按钮直接 POST /api/tasks/:id/<action>
  // 改了 status, 父级 SSE handler patch 父级 state, 传到本组件时可能仍是旧值.
  // 因此本地维护一份 liveTasks, 父级更新时按 id 合并 (filter 权威归父级),
  // 本地订阅 SSE 独立 patch 状态. 这样不管父级 SSE 是否漏事件, 左侧颜色/状态都跟得上.
  const [liveTasks, setLiveTasks] = useState<TaskTrimmed[]>(tasks);
  // props.tasks 引用变化时同步 — 父级 filter / loadMore / 新建任务都会触发.
  // 注意: SSE 引起的父级 re-render 也会让 props.tasks 引用变, 但内容不变 (同一个
  // id + status), 合并后等价; 真要担心内容漂移, 用 lastSyncedIds 兜底判断.
  const lastSyncedRef = useRef<string>("");
  useEffect(() => {
    const sig = tasks.map((t) => `${t.id}:${t.status}:${t.updated_at}`).join("|");
    if (sig === lastSyncedRef.current) return;
    lastSyncedRef.current = sig;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveTasks(() => mergeTasksFromProps(tasks));
  }, [tasks]);

  // 订阅 SSE 独立 patch task 状态 (兜底父级 SSE 漏事件). URL 锁死的 caller
  // (单项目版本) 用项目级 SSE; 跨项目的 global caller 用全局 SSE.
  // chat-view 只展示一个排序列表 (不区分 active/terminal 区块), 所以 SSE 只需
  // patch status + updated_at; 不在本组件里跨集合重排 — 父级下次重渲会按方向归位.
  // 全局分支走 useGlobalEventSource 共享单例, 与 NavSidebar / global-board / NavigationTree
  // 复用同一条长连接, 避免重复占用浏览器同域 SSE 并发名额.
  const useGlobal = !project?.id || allowSwitchProject;
  useGlobalEventSource((raw) => {
    if (!useGlobal) return;
    const event = raw as { type: string; task_id?: string; to?: TaskTrimmed["status"] };
    if (event.type !== "status_change" || !event.task_id || !event.to) return;
    const id = event.task_id;
    const toStatus = event.to;
    setLiveTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev; // 父级 filter 已剔除, 不强行加回来
      if (prev[idx].status === toStatus) return prev;
      const now = new Date().toISOString();
      const next = prev.slice();
      next[idx] = { ...prev[idx], status: toStatus, updated_at: now };
      return next;
    });
  });
  // 项目级 SSE 路径: 单项目 chat 视图, 通常只有本组件一个消费者, 不需要单例,
  // 保留原 EventSource 直接订阅. project.id 变化时重连, 切到全局模式 (allowSwitchProject)
  // 时这个 effect 会关掉本条, 全局流由上面的 hook 接续.
  useEffect(() => {
    if (useGlobal) return;
    if (!project?.id) return;
    const es = new EventSource(`/api/projects/${project.id}/events`);
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as { type: string; task_id?: string; to?: TaskTrimmed["status"] };
        if (event.type !== "status_change" || !event.task_id || !event.to) return;
        const id = event.task_id;
        const toStatus = event.to;
        setLiveTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === id);
          if (idx === -1) return prev;
          if (prev[idx].status === toStatus) return prev;
          const now = new Date().toISOString();
          const next = prev.slice();
          next[idx] = { ...prev[idx], status: toStatus, updated_at: now };
          return next;
        });
      } catch {}
    };
    return () => { es.close(); };
  }, [project?.id, useGlobal]);

  // ===== Chat 列表列宽拖动 =====
  // 复制 NavSidebar 模式: localStorage 持久化, mounted 守卫防 hydration mismatch,
  // window 级 mousemove/mouseup 保证移出侧栏也能继续拖, body cursor 锁住.
  // 全 chat 视图共用一个 key (不按 scope 分).
  const CHAT_LIST_WIDTH_KEY = "chat-list-width";
  const CHAT_LIST_DEFAULT = 280;
  const CHAT_LIST_MIN = 200;
  const CHAT_LIST_MAX = 480;
  const [chatListWidth, setChatListWidth] = useState(CHAT_LIST_DEFAULT);
  const [chatListDragging, setChatListDragging] = useState(false);
  const [widthMounted, setWidthMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWidthMounted(true);
    try {
      const saved = localStorage.getItem(CHAT_LIST_WIDTH_KEY);
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= CHAT_LIST_MIN && n <= CHAT_LIST_MAX) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setChatListWidth(n);
        }
      }
    } catch {}
  }, []);
  useEffect(() => {
    if (!chatListDragging) return;
    function onMove(e: MouseEvent) {
      // 左侧面板的右边界 = 鼠标 clientX; 反算宽度.
      // 这里用 innerWidth - clientX 作为右侧空间, 算左列宽度更直接.
      // 简化: 直接用 clientX (panel left = 0 + sidebar width, 这里假设 chat-view 占满主内容区).
      const rect = (document.getElementById("chat-list-container") as HTMLElement | null)?.getBoundingClientRect();
      if (rect) {
        const next = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, e.clientX - rect.left));
        setChatListWidth(next);
      } else {
        // fallback: 假设左列从 0 开始, 拖到 clientX
        const next = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, e.clientX));
        setChatListWidth(next);
      }
    }
    function onUp(e: MouseEvent) {
      const rect = (document.getElementById("chat-list-container") as HTMLElement | null)?.getBoundingClientRect();
      let final: number;
      if (rect) {
        final = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, e.clientX - rect.left));
      } else {
        final = Math.max(CHAT_LIST_MIN, Math.min(CHAT_LIST_MAX, e.clientX));
      }
      try {
        localStorage.setItem(CHAT_LIST_WIDTH_KEY, String(final));
      } catch {}
      setChatListDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [chatListDragging]);
  // 拖动时锁 cursor 和文本选择, 防止移出侧栏时 cursor 变箭头.
  const chatListDragStyle = chatListDragging ? (
    <style>{`body { cursor: col-resize !important; user-select: none; }`}</style>
  ) : null;
  const dynamicChatListWidth = widthMounted ? { width: `${chatListWidth}px` } : undefined;

  // ===== Inline project/version pill =====
  // 优先级: URL props (project/version) > recent localStorage > 空.
  // pill 切换时调 setRecent + onScopeChange + 更新本地 activeProject/activeVersion.
  const allowProjectSwitch = allowSwitchProject;
  const { recent, setRecent, mounted: recentMounted } = useRecentProject();
  const [activeProject, setActiveProject] = useState<{ id: string; name: string } | null>(
    project ? { id: project.id, name: project.name } : null
  );
  const [activeVersion, setActiveVersion] = useState<{ id: string; name: string } | null>(
    version ? { id: version.id, name: version.name } : null
  );
  // 当 caller 传入的 project/version 变化 (如 URL/筛选变化), 同步本地 active.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveProject(project ? { id: project.id, name: project.name } : null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveVersion(version ? { id: version.id, name: version.name } : null);
  }, [project?.id, version?.id]);

  // 拉 picker 用的项目/版本列表 (按 activeProject 联动版本).
  const [allProjects, setAllProjects] = useState<{ id: string; name: string }[]>([]);
  const [allVersions, setAllVersions] = useState<{ id: string; project_id: string; name: string }[]>([]);
  useEffect(() => {
    if (!allowProjectSwitch) {
      // URL 锁死的场景不需要拉全部, 只在切换 version 时按 activeProject 拉.
    }
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d: { projects?: { id: string; name: string }[] }) =>
        setAllProjects(Array.isArray(d.projects) ? d.projects.map((p) => ({ id: p.id, name: p.name })) : [])
      )
      .catch(() => {});
  }, [allowProjectSwitch]);

  useEffect(() => {
    if (!activeProject) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAllVersions([]);
      return;
    }
    fetch(`/api/versions?project=${activeProject.id}`)
      .then((r) => r.json())
      .then((d: { versions?: { id: string; project_id: string; name: string }[] }) =>
        setAllVersions(Array.isArray(d.versions) ? d.versions : [])
      )
      .catch(() => {});
  }, [activeProject?.id]);

  // 当 initialProject 为空 + recent 有数据时, 在挂载后用 recent 兜底.
  useEffect(() => {
    if (!recentMounted) return;
    if (project) return; // URL 已锁, 不覆盖
    if (activeProject) return; // 已有 (例如 caller 后设置)
    if (!recent || !allProjects.length) return;
    const p = allProjects.find((x) => x.id === recent.projectId);
    if (!p) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveProject({ id: p.id, name: p.name });
    if (recent.versionId) {
      fetch(`/api/versions?project=${p.id}`)
        .then((r) => r.json())
        .then((d: { versions?: { id: string; name: string }[] }) => {
          const v = (d.versions || []).find((x) => x.id === recent.versionId);
          if (v) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setActiveVersion({ id: v.id, name: v.name });
          }
        })
        .catch(() => {});
    }
  }, [recentMounted, recent, allProjects, project, activeProject]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  // 点 pill 外关闭 picker
  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  const handlePickProject = useCallback((projectId: string) => {
    const p = allProjects.find((x) => x.id === projectId);
    if (!p) return;
    setActiveProject({ id: p.id, name: p.name });
    setActiveVersion(null); // 切换 project 后版本归零, 由用户重选
    setRecent({ projectId: p.id, versionId: null, updatedAt: Date.now() });
    onScopeChange?.(p.id, null);
    setPickerOpen(false);
  }, [allProjects, setRecent, onScopeChange]);

  const handlePickVersion = useCallback((versionId: string) => {
    if (!activeProject) return;
    const v = allVersions.find((x) => x.id === versionId);
    if (!v) return;
    setActiveVersion({ id: v.id, name: v.name });
    setRecent({ projectId: activeProject.id, versionId: v.id, updatedAt: Date.now() });
    onScopeChange?.(activeProject.id, v.id);
    setPickerOpen(false);
  }, [activeProject, allVersions, setRecent, onScopeChange]);

  // Sync selectedTaskId when initialTaskId changes (e.g. from URL param update)
  useEffect(() => {
    if (initialTaskId) {
      setSelectedTaskId(initialTaskId);
      setShowNewTaskInput(false);
      setMobilePanel("chat");
    }
  }, [initialTaskId]);

  // ===== Pill auto-sync to selected task's scope =====
  // 全局 board 模式下 chat 列表可混合多 project/version, 用户点 task 时让 pill
  // 跟随, 一致感更好. URL 锁死的 caller 不开 — 列表已限定 scope, pill 与 URL
  // 一致; 跨 scope 切换走 picker + router.push. 不触发 onScopeChange (会改父
  // 级筛选, 导致列表突变 — 反 UX). recent 同步写 localStorage, 下次进 chat
  // 默认沿用最近点开的 scope.
  useEffect(() => {
    if (!allowProjectSwitch) return;
    if (!selectedTaskId) return;
    const t = liveTasks.find((tt) => tt.id === selectedTaskId);
    if (!t || !t.project_id) return;
    const taskProjectId = t.project_id;
    const taskVersionId = t.version_id || null;
    const projectName = projectNames?.[taskProjectId];
    if (!projectName) return; // projectNames 未就绪, 下次 render 再试
    const versionName = taskVersionId ? versionNames?.[taskVersionId] : undefined;
    if (taskVersionId && !versionName) return;
    const projectChanged = activeProject?.id !== taskProjectId;
    const versionChanged = (taskVersionId || null) !== (activeVersion?.id || null);
    if (!projectChanged && !versionChanged) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveProject({ id: taskProjectId, name: projectName });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveVersion(taskVersionId && versionName ? { id: taskVersionId, name: versionName } : null);
    setRecent({ projectId: taskProjectId, versionId: taskVersionId, updatedAt: Date.now() });
  }, [selectedTaskId, allowProjectSwitch, liveTasks, projectNames, versionNames, activeProject?.id, activeVersion?.id, setRecent]);

  const newPromptRef = useRef<HTMLTextAreaElement>(null);

  // 桌面端 textarea 可手动拖拽调整高度 (沿用任务聊天输入框的 [MIN, MAX] 区间 +
  // localStorage 持久化模式); 移动端 auto-grow 跟任务聊天一致, 改由 JS effect
  // 直接操纵 height 避开 iOS Safari 不可靠的 `field-sizing:content`.
  // 默认 240px ≈ 12 行 (R47 反馈: 「直接默认高度 12 行吧」).
  const MIN_NEW_PROMPT_H_PX = 60; // ~3 行
  const MAX_NEW_PROMPT_H_PX = 400; // ~20 行
  const DEFAULT_NEW_PROMPT_H_PX = 240; // ~12 行
  const [newPromptHeight, setNewPromptHeight] = useState<number>(DEFAULT_NEW_PROMPT_H_PX);
  const [newPromptHeightMounted, setNewPromptHeightMounted] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("chat-new-prompt-input-height-v1");
      if (raw) {
        const n = parseInt(raw, 10);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (n >= MIN_NEW_PROMPT_H_PX && n <= MAX_NEW_PROMPT_H_PX) setNewPromptHeight(n);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNewPromptHeightMounted(true);
  }, []);
  useEffect(() => {
    if (!newPromptHeightMounted) return;
    try { localStorage.setItem("chat-new-prompt-input-height-v1", String(newPromptHeight)); } catch {}
  }, [newPromptHeight, newPromptHeightMounted]);

  // Auto-resize textarea on mobile (< sm) based on content. 桌面端由 newPromptHeight
  // (用户拖拽过的 px 值) 控制, clientWidth >= 640 时直接 short-circuit.
  // scrollHeight + 4px slack: trailing \n 不会让行高塌缩.
  useEffect(() => {
    const el = newPromptRef.current;
    if (!el) return;
    if (el.clientWidth >= 640) return;
    el.style.height = "auto";
    const scrollH = el.scrollHeight;
    const slack = 4;
    const next = Math.max(MIN_NEW_PROMPT_H_PX, Math.min(MAX_NEW_PROMPT_H_PX, scrollH + slack));
    el.style.height = `${next}px`;
    el.style.overflowY = scrollH + slack > MAX_NEW_PROMPT_H_PX ? "auto" : "hidden";
  }, [newPrompt, showNewTaskInput]);

  // Focus the prompt input when "new chat" is clicked
  useEffect(() => {
    if (showNewTaskInput && newPromptRef.current) {
      newPromptRef.current.focus();
    }
  }, [showNewTaskInput]);

  // ===== Paste + drop attachments =====
  // Cmd/Ctrl+V 在 prompt input 上粘贴剪贴板里的图片/文件 → 追加到 pendingFiles.
  // 粘贴纯文字时让默认行为继续 (不 preventDefault), 不会拦截文本粘贴。
  // 拖拽同理: 拖到 input 区上方, 把文件/图片追加到 pendingFiles, 拖入时边框高亮。
  const handlePromptPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromDataTransfer(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    setPendingFiles((prev) => [...prev, ...files]);
  }, []);

  // 兜底: window 级 paste 监听 (damo R47 二轮反馈 — "Cmd/Ctrl+V 粘贴文件或图片未实现").
  // textarea 的 onPaste 在 textarea 失焦 (点 📎 / ⚙️ 按钮) 后不再 fire,
  // 用户体感 = "粘不上". 这里兜底: 新建聊天面板打开期间, 全局监听 paste,
  // 只要剪贴板里有文件就追加到 pendingFiles, 没文件就放行 (不 preventDefault),
  // 不影响用户在 textarea 里打字的纯文本粘贴.
  useEffect(() => {
    if (!showNewTaskInput) return;
    function onWindowPaste(e: ClipboardEvent) {
      const files = filesFromDataTransfer(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      setPendingFiles((prev) => [...prev, ...files]);
    }
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [showNewTaskInput]);

  const handleDropZoneOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 仅响应文件拖拽 (dragenter/over 默认禁用 drop); 文字拖拽放手不管。
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  }, []);

  const handleDropZoneLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // dragleave 会在穿过每个子元素时冒泡 — 用 relatedTarget 是否仍在 zone 内判断,
    // 避免在 input/按钮之间穿过时高亮闪烁。
    const next = e.relatedTarget as Node | null;
    if (next && dropZoneRef.current?.contains(next)) return;
    setDraggingFiles(false);
  }, []);

  const handleDropZoneDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDraggingFiles(false);
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) setPendingFiles((prev) => [...prev, ...files]);
  }, []);

  const handleSelectTask = useCallback((id: string) => {
    setSelectedTaskId(id);
    setShowNewTaskInput(false);
    setMobilePanel("chat");
    // Sync URL so it reflects the selected task (replace, not push)
    router.replace(`${pathname}?mode=chat&taskId=${id}`);
  }, [router, pathname]);

  const handleNewTask = useCallback(() => {
    setShowNewTaskInput(true);
    setSelectedTaskId(null);
    setMobilePanel("chat");
    // Clear taskId from URL but keep mode=chat
    router.replace(`${pathname}?mode=chat`);
  }, [router, pathname]);

  const handleCreateTask = useCallback(async () => {
    if (!newPrompt.trim() || creating) return;
    // 优先用 pill 选中的项目, 兜底用 caller props (向后兼容).
    const useProject = activeProject ?? (project ? { id: project.id, name: project.name } : null);
    const useVersion = activeVersion ?? (version ? { id: version.id, name: version.name } : null);
    if (!useProject) {
      // Global board 没选项目 — 提示用户从 pill 选一个
      toastError("请先在顶部 pill 选择项目");
      return;
    }
    setCreating(true);
    try {
      const title = newPrompt.trim().slice(0, 60);
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          prompt: newPrompt.trim(),
          project_id: useProject.id,
          version_id: useVersion?.id || undefined,
          autoApprove: advancedAutoApprove,
          effort: advancedEffort || "high",
          maxTurns: advancedMaxTurns ? parseInt(advancedMaxTurns) : undefined,
          model: advancedModel || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`创建失败: ${err.error}`);
        return;
      }
      const task = await res.json();

      // 创建成功后写回 recent localStorage — 下次打开 chat 默认就用这个.
      setRecent({ projectId: useProject.id, versionId: useVersion?.id || null, updatedAt: Date.now() });

      // Upload attachments (two-step: task must exist first)
      const attIds: string[] = [];
      for (const file of pendingFiles) {
        try {
          const fd = new FormData();
          fd.append("file", file);
          const attRes = await fetch(`/api/tasks/${task.id}/attachments`, { method: "POST", body: fd });
          if (attRes.ok) {
            const data = await attRes.json();
            if (data.attachment?.id) attIds.push(data.attachment.id);
          }
        } catch {}
      }
      if (attIds.length > 0) {
        await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ append_attachments: attIds }),
        });
      }

      // Auto-start
      await fetch(`/api/tasks/${task.id}/start`, { method: "POST" }).catch(() => {});

      // Add to local task list and select it. Board 收到全字段 Task 后自行拆分到
      // active/terminal 数组; preview 字段靠下次 refetch 补上, 渲染前会先 fetch。
      onTaskCreated(task);
      setSelectedTaskId(task.id);
      setNewPrompt("");
      setPendingFiles([]);
      setShowNewTaskInput(false);
      setShowAdvanced(false);
      setMobilePanel("chat");
      // Sync URL to reflect the newly created task
      router.replace(`${pathname}?mode=chat&taskId=${task.id}`);
    } catch (err) {
      toastError(`网络错误: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }, [newPrompt, creating, project, version, activeProject, activeVersion, advancedAutoApprove, advancedEffort, advancedMaxTurns, advancedModel, pendingFiles, tasks, onTaskCreated, router, pathname, setRecent]);

  const handleMobileBack = useCallback(() => {
    setMobilePanel("list");
  }, []);

  return (
    <div className="flex h-screen relative overflow-x-hidden">
      {chatListDragStyle}
      {/* Desktop layout: left panel + right panel */}
      {/* Left panel - task list. 桌面态宽度由 inline style 控制 (可拖动). */}
      <div
        id="chat-list-container"
        className={`
          border-r border-gray-200 bg-white relative
          ${mobilePanel === "list" ? "flex" : "hidden"} md:flex
          w-full md:shrink-0 flex-col
        `}
        style={dynamicChatListWidth}
      >
        <ChatTaskList
          tasks={liveTasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={handleSelectTask}
          onNewTask={handleNewTask}
          projectNames={projectNames}
          versionNames={versionNames}
        />
        {/* 列宽拖动手柄 — 仅桌面态显示. */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setChatListDragging(true);
          }}
          className="hidden md:block absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 active:bg-blue-500 z-10"
          title="拖动调整列宽"
        />
      </div>

      {/* Right panel - chat / new task input. min-w-0 + overflow-x-hidden 防止
          H5 端 picker 下拉 / 任务标题 / 工具条子元素突破视口宽度产生横向滚动. */}
      <div className={`
        flex-1 min-w-0 flex flex-col overflow-x-hidden
        ${mobilePanel === "chat" ? "flex" : "hidden"} md:flex
      `}>
        {/* 项目上下文 pill — 顶部, 全宽 sticky. URL 锁死的 caller 只允许切 version.
            手机端 (chat-view 已在主区域) 隐藏 "项目上下文" 标签, 节省 4 行 header 之一. */}
        <div className="border-b border-gray-200 bg-white px-3 md:px-4 py-1.5 flex items-center gap-2 shrink-0 relative z-30" ref={pickerRef}>
          <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">项目上下文</span>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs transition-colors ${
              activeProject
                ? "border-gray-200 bg-gray-50 text-gray-700 hover:border-blue-300"
                : "border-dashed border-gray-300 text-gray-400 hover:border-blue-300"
            }`}
            title={activeProject ? "切换项目/版本" : "选择项目"}
          >
            {activeProject ? (
              <>
                {/* H5 端项目名 max-w 收紧 + 版本名整段隐藏, 避免 pill + 180 + 140px
                    把顶部行撑爆超出视口宽度 (R32 反馈: 聊天面板最宽 100%). */}
                <span className="truncate max-w-[120px] sm:max-w-[180px]">{activeProject.name}</span>
                {activeVersion && (
                  <>
                    <span className="text-gray-400 hidden sm:inline">›</span>
                      <span className="truncate max-w-[140px] hidden sm:inline">{activeVersion.name}</span>
                    </>
                  )}
              </>
            ) : (
              <span>选择项目</span>
            )}
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-gray-400 shrink-0">
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
          {pickerOpen && (
            <div className="absolute top-full left-3 md:left-4 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 min-w-[280px] max-w-[calc(100vw-24px)] z-40">
              {allowProjectSwitch ? (
                <div className="mb-2">
                  <label className="text-xs text-gray-500 mb-1 block">项目</label>
                  <Select
                    value={activeProject?.id || ""}
                    onChange={handlePickProject}
                    options={[{ value: "", label: "选择项目..." }, ...allProjects.map((p) => ({ value: p.id, label: p.name }))]}
                    className="w-full"
                  />
                </div>
              ) : (
                <div className="mb-2 text-xs text-gray-500">
                  项目: <span className="text-gray-700 font-medium">{activeProject?.name || project?.name || "—"}</span>
                  <span className="ml-1 text-gray-400">(URL 锁死)</span>
                </div>
              )}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">版本</label>
                <Select
                  value={activeVersion?.id || ""}
                  onChange={handlePickVersion}
                  options={[{ value: "", label: "未选版本" }, ...allVersions.map((v) => ({ value: v.id, label: v.name }))]}
                  className="w-full"
                  disabled={!activeProject}
                />
              </div>
            </div>
          )}
          {/* 右侧操作: md 以下显示 "返回列表", sm+ 显示 ViewSwitcher.
              R51 子 bug #3: 两个元素各自 ml-auto → 中等屏幕 (640-768px) ViewSwitcher
              和 "返回列表" 同时 ml-auto = 后渲染的覆盖前一个的右对齐.
              改为同一个 ml-auto 容器, 两个元素互补显示. caller 不传 viewSwitcher
              时保留原有 "返回列表" 行为 (向后兼容). */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <button
              onClick={handleMobileBack}
              className="md:hidden text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
              title="返回任务列表"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
              </svg>
              返回列表
            </button>
            {viewSwitcher}
            {/* 顶部 header 折叠/展开开关 (R126): 仅 caller 同时传 topHeaderVisible
                + onToggleTopHeader 时渲染. 默认渲染 chevron-up(=当前展开,点
                击折叠); 折叠后渲染 chevron-down(=点击展开). 视觉与下方其他
                圆形/方形小图标区分,保持简洁. */}
            {onToggleTopHeader && (
              <button
                type="button"
                onClick={onToggleTopHeader}
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md p-1 transition-colors"
                title={topHeaderVisible ? "折叠上方信息栏" : "展开上方信息栏"}
                aria-label={topHeaderVisible ? "折叠上方信息栏" : "展开上方信息栏"}
              >
                {topHeaderVisible ? (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 011.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>

        {/* New task input panel */}
        {showNewTaskInput && !selectedTaskId && (
          <div className="flex-1 flex flex-col items-center justify-center bg-gray-50 p-6">
            <div className="w-full max-w-2xl">
              <div
                ref={dropZoneRef}
                onDragOver={handleDropZoneOver}
                onDragLeave={handleDropZoneLeave}
                onDrop={handleDropZoneDrop}
                className={`bg-white rounded-lg border p-4 space-y-3 transition-colors ${draggingFiles ? "border-blue-400 bg-blue-50/50" : "border-gray-200"}`}
              >
                {/* 拖拽手柄: 桌面 sm+ 显示, 向上拖增 / 向下拖减, 高度范围
                    [MIN_NEW_PROMPT_H_PX, MAX_NEW_PROMPT_H_PX]. 默认 240px ≈ 12 行. */}
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const startY = e.clientY;
                    const startH = newPromptHeight;
                    const onMove = (ev: MouseEvent) => {
                      // delta 为负 (clientY 减小 = 往上) → 高度增加。
                      const delta = startY - ev.clientY;
                      const next = Math.max(MIN_NEW_PROMPT_H_PX, Math.min(MAX_NEW_PROMPT_H_PX, startH + delta));
                      setNewPromptHeight(next);
                    };
                    const onUp = () => {
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                      document.body.style.cursor = "";
                      document.body.style.userSelect = "";
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                    document.body.style.cursor = "ns-resize";
                    document.body.style.userSelect = "none";
                  }}
                  className="hidden sm:flex h-1.5 -mt-1 mb-1 cursor-ns-resize items-center justify-center hover:bg-blue-100 active:bg-blue-200"
                  title="拖动调整输入框高度（向上调高，向下调低）"
                >
                  <span className="block w-10 h-[3px] bg-gray-300 rounded-full" />
                </div>
                <textarea
                  ref={newPromptRef}
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 发送, Shift/Ctrl/Meta+Enter 插入换行 (与任务聊天输入框一致,
                    // 也兼顾 iMessage / 飞书 / 微信的 IM 习惯). IME composing 状态由
                    // 浏览器吞 Enter, 不触发发送 (中文输入法候选上屏安全).
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      if (e.shiftKey || e.metaKey || e.ctrlKey) {
                        e.preventDefault();
                        const t = e.currentTarget;
                        const { selectionStart: s, selectionEnd: end, value: v } = t;
                        const newValue = v.slice(0, s) + "\n" + v.slice(end);
                        setNewPrompt(newValue);
                        queueMicrotask(() => {
                          t.selectionStart = t.selectionEnd = s + 1;
                        });
                      } else {
                        e.preventDefault();
                        if (!creating && newPrompt.trim()) handleCreateTask();
                      }
                    }
                  }}
                  onPaste={handlePromptPaste}
                  placeholder="输入指令开始新任务... (Cmd/Ctrl+V 粘贴文件或图片)"
                  disabled={creating}
                  rows={6}
                  // 桌面 sm+ 用 CSS 变量套用户拖拽高度 (默认 240px); 移动端 < sm 由
                  // 上方 auto-resize effect 直接操纵 style.height (避免 iOS Safari
                  // field-sizing 不可靠). 行高 1.5rem 与 padding 6px+7px+border 配
                  // 240px ≈ 12 行, 跟 MIN/MAX 区间相容.
                  style={{ "--new-prompt-input-h": `${newPromptHeight}px` } as CSSProperties}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 disabled:bg-gray-50 resize-none leading-[1.5rem] sm:h-[var(--new-prompt-input-h)] sm:min-h-0"
                />
                <div className="flex justify-between items-center mt-1.5 gap-2 flex-wrap">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className={`shrink-0 border rounded-lg px-2 py-1.5 text-sm cursor-pointer ${showAdvanced ? "bg-blue-50 border-blue-300 text-blue-600" : "text-gray-500 hover:bg-gray-100 hover:border-gray-400"}`}
                      title="高级配置 (模型 / 强度 / 最大轮次 / 自动审批)"
                    >
                      <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                        <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length) setPendingFiles((prev) => [...prev, ...files]);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={creating}
                      title="上传附件"
                      className="border border-gray-300 rounded-lg p-2 text-gray-400 hover:text-gray-600 transition-colors shrink-0 disabled:opacity-50"
                    >
                      📎
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateTask}
                      disabled={!newPrompt.trim() || creating}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-sm shrink-0"
                    >
                      {creating ? "创建中..." : "发送"}
                    </button>
                  </div>
                </div>

                {/* Pending attachments */}
                {pendingFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {pendingFiles.map((f, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-50 rounded px-2 py-1 border border-gray-200">
                        <span className="truncate max-w-[120px]">{f.name}</span>
                        <span className="text-gray-400">({formatSize(f.size)})</span>
                        <button type="button" onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))} className="text-gray-400 hover:text-red-500 ml-0.5">×</button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Advanced config */}
                {showAdvanced && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-gray-100">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">模型</label>
                      <Select
                        value={advancedModel}
                        onChange={(v) => setAdvancedModel(v)}
                        options={modelOptions}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Effort</label>
                      <Select
                        value={advancedEffort}
                        onChange={(v) => setAdvancedEffort(v)}
                        options={TOOL_PRESETS.length > 0
                          ? ["low", "medium", "high", "xhigh", "max"].map(v => ({ value: v, label: v }))
                          : []}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">最大轮次</label>
                      <input
                        type="number"
                        value={advancedMaxTurns}
                        onChange={(e) => setAdvancedMaxTurns(e.target.value)}
                        placeholder="默认"
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2 pt-4">
                      <input
                        type="checkbox"
                        checked={advancedAutoApprove}
                        onChange={(e) => setAdvancedAutoApprove(e.target.checked)}
                        className="rounded border-gray-300"
                      />
                      <label className="text-sm text-gray-600">自动审批</label>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Selected task chat */}
        {selectedTaskId && !showNewTaskInput && (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Task title header — title, #id, copy icon, cost, link to detail */}
            {(() => {
              const t = liveTasks.find(t => t.id === selectedTaskId);
              if (!t) return null;
              return <ChatTaskHeader task={t} projectNames={projectNames} versionNames={versionNames} />;
            })()}
            <div className="flex-1 min-h-0">
              <TaskDetailClient
                taskId={selectedTaskId}
                initialStatus={liveTasks.find(tt => tt.id === selectedTaskId)?.status}
                embedded={true}
              />
            </div>
          </div>
        )}

        {/* Empty state - no task selected, no new task input */}
        {!selectedTaskId && !showNewTaskInput && (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center text-gray-400">
              <svg viewBox="0 0 60 60" fill="currentColor" className="w-16 h-16 mx-auto mb-4 text-gray-300">
                <rect x="5" y="10" width="50" height="35" rx="4" />
                <path d="M18 45l6 8 6-8" />
              </svg>
              <p className="text-sm">选择左侧任务查看对话</p>
              <p className="text-xs mt-1">或点击「新建聊天」开始</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Chat task header - title + #id + copy icon + scope (project › version), links to /tasks/[id]
function ChatTaskHeader({
  task,
  projectNames,
  versionNames,
}: {
  task: { id: string; title: string; project_id?: string | null; version_id?: string | null };
  projectNames?: Record<string, string>;
  versionNames?: Record<string, string>;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const url = `${window.location.origin}/#/tasks/${task.id}`;
    copyToClipboard(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }, [task.id]);

  // 项目/版本可点击跳转 chat 视图 — version 不存在则只显示 project
  const scopeHref = task.project_id
    ? `/${task.project_id}/${task.version_id || "unversioned"}?mode=chat&taskId=${task.id}`
    : null;
  const projectLabel = task.project_id ? (projectNames?.[task.project_id] || "?") : null;
  const versionLabel = task.version_id ? (versionNames?.[task.version_id] || "?") : null;

  return (
    <div className="border-b border-gray-200 bg-white px-3 py-1.5 sm:px-4 sm:py-2 flex items-center gap-2 shrink-0">
      <a href={`/tasks/${task.id}`} className="text-sm font-medium text-gray-900 hover:text-blue-600 hover:underline truncate" title="查看任务详情">{task.title}</a>
      <span className="text-xs text-gray-400 font-mono shrink-0">#{task.id.slice(0, 8)}</span>
      {scopeHref && projectLabel && (
        <a
          href={scopeHref}
          className="text-xs text-gray-400 hover:text-blue-600 truncate max-w-[260px] hidden sm:inline-block"
          title="跳转到该项目/版本 chat"
        >
          <span>{projectLabel}</span>
          {versionLabel && (
            <>
              <span className="mx-1">›</span>
              <span>{versionLabel}</span>
            </>
          )}
        </a>
      )}
      <button onClick={handleCopy} className="text-gray-400 hover:text-gray-600 transition-colors p-0.5 shrink-0 ml-auto" title="复制任务链接">
        {copied ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-emerald-500"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" /></svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M7 3.5A1.5 1.5 0 018.5 2h5A1.5 1.5 0 0115 3.5v9A1.5 1.5 0 0113.5 14h-5A1.5 1.5 0 017 12.5v-9z" /><path d="M3.5 6A1.5 1.5 0 002 7.5v9A1.5 1.5 0 003.5 18h9a1.5 1.5 0 001.5-1.5V7.5A1.5 1.5 0 0012.5 6h-9z" opacity="0.3" /></svg>
        )}
      </button>
    </div>
  );
}
