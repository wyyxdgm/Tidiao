// Client component: task conversation panel + controls

"use client";

import { useEffect, useRef, useState, useMemo, useCallback, type CSSProperties } from "react";
import Link from "next/link";
import { v4 as uuidv4 } from "uuid";
import { markdownToHtml, linkifyDocPaths, linkifyTaskPrefixes } from "@/lib/markdown";
import type { ProjectCwdRef } from "@/lib/wiki-links";
import { parseDbTime } from "@/lib/datetime";
import ConfirmDialog from "@/components/ConfirmDialog";
import Select from "@/components/Select";
import { useToastActions } from "@/components/Toast";
import { parseSlashCommand } from "@/lib/chat/slash-command";
import { playNotifySound } from "@/lib/sound";
import { shouldPlaySound } from "@/lib/sound-settings";
import { getCompactThreshold } from "@/lib/fork-settings";
import { useTaskStream } from "./use-task-stream";
import { parseRequirementRow } from "@/lib/feishu/requirement-id";
import {
  appendOptimisticUserMessage,
  removeOptimisticMessage,
} from "./optimistic-message";
import { mergeHistory } from "./merge-history";
import { insertByTimestamp } from "./insert-by-timestamp";
import { formatTimestampLabel } from "./format-timestamp-label";

type AttachmentInfo = {
  id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
};

type MessageItem = {
  type: string;
  role?: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: string;
  uuid?: string;
  collapsed?: boolean;
  timestamp?: number;
  // Injected task.prompt (not a real user message from the SDK/events).
  // Used to distinguish prompt injection from optimistic user messages
  // (which lack uuid) so the merge logic doesn't append the prompt at
  // the end of the list.
  isPrompt?: boolean;
  // Client-side id for optimistic user messages (inserted before POST
  // returns). Used by handleSendMessage's rollback path to remove the
  // temp message on POST failure. SSE / loadHistory never populate
  // this field, so their messages are not affected by removeOptimisticMessage.
  clientId?: string;
  // type === "attachment": a standalone upload entry surfaced in the stream.
  attachment?: AttachmentInfo;
  // R121 P3: type === "attachment_group": N 个相邻 attachment 合并为 grid 渲染.
  // attachments: 各 attachment 详情, groupSize: 合并前的消息条数 (用于 prevMsg 判断).
  attachments?: AttachmentInfo[];
  groupSize?: number;
  // R55 B1: who sent this user message? "user" = damo/chat box, "script" =
  // ao-session.sh transfer etc, "system" = platform events (parent-notify,
  // deploy notify). Absent = historical / unknown → render as 👤 you.
  sender_type?: "user" | "script" | "system";
};

// R121: 把相邻 attachment (timestamp 差 < 5s) 合并成一个 attachment_group item.
//   - 单条 attachment 仍走原 attachment 类型渲染 (不强制成 group, 避免无意义 group)
//   - 仅当连续 ≥ 2 条 attachment 时合并为 group
//   - 阈值 5s: 覆盖 agent 同 batch 调 mmx 多次 (≤ 1s 间隔) 同时防「真用户连续 2 张
//     不同主题图」被错误合并. 实测 mmx --out 调用间隔 < 1s, 5s 已留足缓冲.
function groupAdjacentAttachments(items: MessageItem[]): MessageItem[] {
  const GROUP_WINDOW_MS = 5_000;
  const out: MessageItem[] = [];
  let i = 0;
  while (i < items.length) {
    const cur = items[i];
    if (cur.type !== "attachment" || !cur.attachment) {
      out.push(cur);
      i++;
      continue;
    }
    // 收集连续 attachment
    const group: MessageItem[] = [cur];
    let j = i + 1;
    while (
      j < items.length &&
      items[j].type === "attachment" &&
      items[j].attachment &&
      Math.abs((items[j].timestamp ?? 0) - (cur.timestamp ?? 0)) < GROUP_WINDOW_MS
    ) {
      group.push(items[j]);
      j++;
    }
    if (group.length >= 2) {
      out.push({
        type: "attachment_group",
        attachments: group.map((g) => g.attachment!),
        groupSize: group.length,
        timestamp: cur.timestamp,
      });
    } else {
      out.push(cur);
    }
    i = j;
  }
  return out;
}

type PendingApproval = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

type UserDialogOption = {
  label: string;
  description?: string;
  preview?: string;
};

type UserDialogQuestion = {
  question: string;
  header: string;
  options: UserDialogOption[];
  multi_select: boolean;
};

type PendingDialog = {
  requestId: string;
  dialogKind: string;
  toolUseId?: string;
  questions: UserDialogQuestion[];
  // Per-question selection — multi-select uses Set; single-select uses Set of size 1.
  selected: Record<string, Set<string>>;
  // Stale flag: set when we replay a historical user_dialog_request after
  // server restart, so the UI can warn that the SDK promise is likely gone.
  stale?: boolean;
};

type FileChangeOperation = "added" | "modified" | "deleted" | "unknown";

type FileChange = {
  filePath: string;
  operation: FileChangeOperation;
  count: number;
  lastToolName: string;
  lastEventId: number;
};

type ChangesResponse = {
  active: boolean;
  source: "live" | "history";
  cwd: string;
  changes: FileChange[];
  note?: string;
};

type FileDiffResponse = {
  active: boolean;
  source: "live" | "history";
  file: string;
  diff: string | null;
  content: string | null;
  notFound: boolean;
};

type TimelineEvent = {
  id: number | null;
  from: string | null;
  to: string;
  created_at: string;
  is_initial: boolean;
  duration_ms: number | null;
};

const OPERATION_LABELS: Record<FileChangeOperation, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  unknown: "未知",
};

const OPERATION_COLORS: Record<FileChangeOperation, string> = {
  added: "bg-emerald-100 text-emerald-700",
  modified: "bg-amber-100 text-amber-700",
  deleted: "bg-red-100 text-red-700",
  unknown: "bg-gray-100 text-gray-500",
};

// --- Extract timestamp from API `timestamp` field (ISO string) or fallback to UUID v7 ---
function messageTimestamp(m: { timestamp?: string; uuid?: string }): number | undefined {
  if (m.timestamp) {
    const ms = new Date(m.timestamp).getTime();
    if (!isNaN(ms) && ms > 1_000_000_000_000) return ms;
  }
  return uuidToTimestamp(m.uuid);
}
function uuidToTimestamp(uuid?: string): number | undefined {
  if (!uuid) return undefined;
  // UUID v7: first 48 bits = unix_ms
  const clean = uuid.replace(/-/g, "");
  const msHex = clean.slice(0, 12);
  const ms = parseInt(msHex, 16);
  if (isNaN(ms) || ms < 1_000_000_000_000) return undefined; // not a plausible timestamp
  return ms;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Insert into a timestamp-ordered array, stable for ties (new item placed
// after existing equal-timestamp entries so SDK message order is preserved).
// 实现见 ./insert-by-timestamp.ts (R155 抽出来便于单测; 兜底 MAX_SAFE_INTEGER
// 让没 ts 的 DB event 排末尾, 不再因 ?? 0 跑到 SDK uuid v7 消息前面).

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// R47 跨日时间戳标签 (抽到独立文件便于单测):
//   同日只显示 HH:MM:SS, 跨日显示 MM-DD 前缀 — 避免「00:01 < 23:59」纯时间字
//   符串视觉错觉让用户觉得排序错位. 实现 + 关注点见 ./format-timestamp-label.ts.

// Detect SDK internal content that should NOT be shown as a user message.
// This includes task-notification blobs (subagent completion), system
// reminders, and other internal markers that the SDK injects into the
// transcript with type "user" but are not actual user input.
function isSdkInternalContent(text: string): boolean {
  if (!text) return false;
  // Subagent completion notification
  if (text.includes("<task-notification>")) return true;
  // System reminders injected by the SDK
  if (text.includes("<system-reminder>")) return true;
  // Tool result wrapper (shouldn't appear as string, but just in case)
  if (text.includes("tool_result")) return true;
  return false;
}

// --- Tool call summary for collapsed state ---
// 功能: 折叠态一行摘要. 有 description 时优先用它(Bash/Agent 等工具自带的人类可读说明),
//       否则按工具类型取关键入参.
// 关注点: description/command 不做 JS 截断, 交给容器的 CSS truncate 省略号处理; 换行压成空格避免撑破单行布局.
function toolCallSummary(toolName?: string, toolInput?: Record<string, unknown>): string {
  if (!toolName) return "Tool";
  const input = toolInput || {};
  const desc = typeof input.description === "string" ? input.description.trim() : "";
  if (desc) return `${toolName}: ${desc.replace(/\s*\n\s*/g, " ")}`;
  switch (toolName) {
    case "Edit":
    case "edit": {
      const fp = String(input.file_path || input.filePath || "");
      const file = fp.split("/").pop() || fp;
      const line = input.old_string
        ? `:${String(input.old_string).split("\n").length}L`
        : "";
      return `Edit: ${file}${line}`;
    }
    case "Write":
    case "write": {
      const fp = String(input.file_path || input.filePath || "");
      const file = fp.split("/").pop() || fp;
      return `Write: ${file}`;
    }
    case "Bash":
    case "bash": {
      const cmd = String(input.command || "");
      const short = cmd.length > 40 ? cmd.slice(0, 37) + "…" : cmd;
      return `Bash: ${short}`;
    }
    case "Read":
    case "read": {
      const fp = String(input.file_path || input.filePath || "");
      const file = fp.split("/").pop() || fp;
      return `Read: ${file}`;
    }
    case "Grep":
    case "grep": {
      const pat = String(input.pattern || "");
      return `Grep: ${pat}`;
    }
    case "Glob":
    case "glob": {
      const pat = String(input.pattern || "");
      return `Glob: ${pat}`;
    }
    default: {
      // Generic: show first meaningful input value
      const keys = Object.keys(input);
      if (keys.length > 0) {
        const val = String(input[keys[0]] || "");
        const short = val.length > 30 ? val.slice(0, 27) + "…" : val;
        return `${toolName}: ${short}`;
      }
      return toolName;
    }
  }
}

// --- Tool icon ---
// 功能: 工具类型 emoji 图标 (master 之前只有 ▶ 箭头没类型图, Bash / Read / Edit
//       区分不直观). SPA / Next 各自维护一份相同映射, 共享设计意图.
function toolIcon(toolName?: string): string {
  switch (toolName) {
    case "Bash":
    case "bash":
      return "🖥️";
    case "Read":
    case "read":
      return "📖";
    case "Write":
    case "write":
      return "📝";
    case "Edit":
    case "edit":
      return "✏️";
    case "Grep":
    case "grep":
      return "🔍";
    case "Glob":
    case "glob":
      return "📂";
    case "Agent":
    case "agent":
      return "🤖";
    case "WebFetch":
    case "WebSearch":
      return "🌐";
    default:
      return "🔧";
  }
}

// --- Search highlighting helpers ---
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Highlight matches in plain text → returns escaped HTML string
function highlightText(text: string, query: string): string {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  return escaped.replace(
    regex,
    '<mark class="bg-yellow-200 rounded px-0.5">$1</mark>'
  );
}

// Highlight matches inside text nodes of an HTML string, leaving tags intact
function highlightHtml(html: string, query: string): string {
  if (!query) return html;
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  const parts = html.split(/(<[^>]+>)/);
  return parts
    .map((part) => {
      if (part.startsWith("<") && part.endsWith(">")) return part;
      return part.replace(
        regex,
        '<mark class="bg-yellow-200 rounded px-0.5">$1</mark>'
      );
    })
    .join("");
}

import { STATUS_LABELS, STATUS_DOT, TYPE_LABELS, TYPE_COLORS, EFFORT_LEVELS, canDeleteTask } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import RightDock from "./right-dock";
import TaskMetaRow from "./task-meta-row";
import { useDockState } from "@/lib/hooks/use-dock-state";
import { useDisplayMode, type DisplayMode } from "@/lib/hooks/use-display-mode";
import { useAvailableModels } from "@/lib/hooks/use-available-models";

// --- Right dock width + collapsed state (persisted in localStorage) ---
const DOCK_WIDTH_KEY = "task-right-dock-width-v1";
const DOCK_COLLAPSED_KEY = "task-right-dock-collapsed-v1";
const DOCK_MIN_W = 280;
const DOCK_MAX_W = 800;
const DOCK_DEFAULT_W = 480;

function useDockWidth() {
  const [width, setWidth] = useState(DOCK_DEFAULT_W);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DOCK_WIDTH_KEY);
      if (raw) setWidth(Math.max(DOCK_MIN_W, Math.min(DOCK_MAX_W, parseInt(raw, 10) || DOCK_DEFAULT_W)));
    } catch {}
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try { localStorage.setItem(DOCK_WIDTH_KEY, String(width)); } catch {}
  }, [width, mounted]);

  return { width, setWidth };
}

function useDockCollapsed() {
  const [collapsed, setCollapsed] = useState(true); // mobile-first: 默认收起避免覆盖聊天
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DOCK_COLLAPSED_KEY);
      if (raw) {
        // 已有显式选择 — 尊重用户决定 (包括手机端想保持展开的)
        setCollapsed(raw === "true");
      } else {
        // 首次访问 — 按视口宽度给默认值: 桌面展开、手机收起.
        // 手机默认收起是因为 RightDock 用 fixed 浮层渲染, 展开会盖住整个聊天
        // 内容 (375px 屏上详情/时间线/checkpoints/commits 4 个面板叠起来
        // > 屏幕高度, 聊天消息和按钮全被盖).
        setCollapsed(window.matchMedia("(max-width: 767px)").matches);
      }
    } catch {}
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try { localStorage.setItem(DOCK_COLLAPSED_KEY, String(collapsed)); } catch {}
  }, [collapsed, mounted]);

  return { collapsed, setCollapsed, toggle: () => setCollapsed((c) => !c) };
}

// 状态动作按钮 - 复用原 TaskHeader ActionBtn 的 variant 配色，放在状态徽标旁
// loading=true 时按钮禁用 + 显示小 spinner, 防重复点击触发后端报错
function StatusBtn({ onClick, disabled, loading, variant, children, title }: {
  onClick: () => void; disabled?: boolean; loading?: boolean; variant: "green" | "red" | "yellow" | "blue" | "emerald" | "gray"; children: React.ReactNode; title?: string;
}) {
  const base = "text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 inline-flex items-center gap-1";
  const styles: Record<string, string> = {
    green: `${base} border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-green-600 hover:border-green-300`,
    red: `${base} border-gray-200 bg-white text-gray-600 hover:bg-red-50 hover:text-red-600 hover:border-red-300`,
    yellow: `${base} border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100`,
    blue: `${base} border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100`,
    emerald: `${base} border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`,
    gray: `${base} border-gray-200 bg-white text-gray-600 hover:bg-gray-50`,
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`${styles[variant]} ${loading ? "cursor-wait" : ""}`}
      title={loading ? "请求进行中..." : title}
    >
      {loading && (
        <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
      )}
      {children}
    </button>
  );
}

export default function TaskDetailClient({
  taskId,
  initialStatus,
  initialType,
  task: taskProp,
  dependsOnTasks: dependsOnTasksProp,
  dependentTasks: dependentTasksProp,
  parentTask: parentTaskProp,
  dispatcherTask: dispatcherTaskProp,
  dispatchedTasks: dispatchedTasksProp,
  requirementLink: requirementLinkProp,
  requirementSiblings: requirementSiblingsProp,
  forkedAt: forkedAtProp,
  wikiProjects: wikiProjectsProp,
  embedded = false,
}: {
  taskId: string;
  initialStatus?: string;
  initialType?: string | null;
  task?: {
    id: string;
    title: string;
    prompt: string;
    status: string;
    cwd: string | null;
    allowed_tools: string | null;
    tags: string | null;
    project_id: string | null;
    version_id: string | null;
    session_id: string | null;
    result: string | null;
    error: string | null;
    preflight_result: string | null;
    model: string | null;
    resolved_model: string | null;
    auto_approve: number;
    max_turns: number | null;
    effort: string | null;
    deleted_at: string | null;
    cost_usd: number | null;
    context_tokens: number | null;
    context_max: number | null;
    created_at: string;
    // R78 W3 §4.2: task ↔ requirement 关联 (v64 FK).
    requirement_id: string | null;
    // R113 (2026-09-07): base/head git snapshot — Commits Chain 面板在 agent
    //   没写 <git/> marker 时, 用 base→head 区间提示用户改了什么 commit.
    base_commit: string | null;
    head_commit: string | null;
    // R143 五轮 (2026-09-15): /goal slash command 复用当前 task 的 workflow
    //   阶段 (design/dev/test/deploy), 传给新建 task. d2b200f 加 handleSlashGoal
    //   时漏改 props 类型, deploy.sh build 报 TS2353.
    type: string | null;
  };
  dependsOnTasks?: Array<{ id: string; title: string; status: string }>;
  dependentTasks?: Array<{ id: string; title: string; status: string }>;
  parentTask?: { id: string; title: string; status: string } | null;
  dispatcherTask?: { id: string; title: string; status: string } | null;
  dispatchedTasks?: Array<{ id: string; title: string; status: string; project_id: string | null }>;
  // R78 W3 §4.2: 需求点关联面板数据 (由 page.tsx 一次性 server-side 取好).
  requirementLink?: { id: string; title: string; status: string } | null;
  requirementSiblings?: Array<{ id: string; title: string; status: string }>;
  forkedAt?: string | null;
  // v53 R14 跨项目跳转兜底: server component 注入的用户可见项目 cwd 列表,
  // 透传给 linkifyDocPaths 让 chat 流里的 mac / ~/ 形态路径直跳目标项目 wiki.
  wikiProjects?: ProjectCwdRef[];
  embedded?: boolean;
}) {
  // --- Embedded mode: fetch task data client-side if not provided ---
  const [fetchedTask, setFetchedTask] = useState<typeof taskProp>(undefined);
  useEffect(() => {
    if (!embedded || taskProp) return;
    let cancelled = false;
    fetch(`/api/tasks/${taskId}`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setFetchedTask(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [embedded, taskProp, taskId]);

  const task = taskProp || fetchedTask;
  const dependsOnTasks = dependsOnTasksProp ?? [];
  const dependentTasks = dependentTasksProp ?? [];
  const parentTask = parentTaskProp ?? null;
  const dispatcherTask = dispatcherTaskProp ?? null;
  const dispatchedTasks = dispatchedTasksProp ?? [];
  const requirementLink = requirementLinkProp ?? null;
  const requirementSiblings = requirementSiblingsProp ?? [];
  const forkedAt = forkedAtProp ?? null;
  const { error: toastError, warning: toastWarning, success: toastSuccess } = useToastActions();

  const [taskType] = useState(initialType ?? null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [status, setStatus] = useState(initialStatus ?? task?.status ?? "pending");
  const [streamingText, setStreamingText] = useState("");
  const [messageInput, setMessageInput] = useState("");
  // 🆕 R131 (damo 2026-09-15): 旧 feedbackInput (reject feedback 必填) 移除.
  //   改用 refine/await/unawait 各自的弹窗 input. 保留 feedbackInput 变量名
  //   引用会扰乱 git blame, 索性删.
  const [refineInput, setRefineInput] = useState("");
  const [awaitReason, setAwaitReason] = useState<"dispatch_needed" | "decision_pending" | "suggestion">("decision_pending");
  const [awaitNote, setAwaitNote] = useState("");
  const [unawaitReason, setUnawaitReason] = useState<"agent_self_resolved" | "user_timeout" | "external_event">("agent_self_resolved");
  const [unawaitNote, setUnawaitNote] = useState("");
  const [refineDialogOpen, setRefineDialogOpen] = useState(false);
  const [awaitDialogOpen, setAwaitDialogOpen] = useState(false);
  const [unawaitDialogOpen, setUnawaitDialogOpen] = useState(false);
  function openRefineDialog() { setRefineInput(""); setRefineDialogOpen(true); }
  function openAwaitDialog() { setAwaitNote(""); setAwaitDialogOpen(true); }
  function openUnawaitDialog() { setUnawaitNote(""); setUnawaitDialogOpen(true); }
  // Attachments staged for the next message (uploaded, not yet sent). Each is
  // also pushed to the stream as a standalone "attachment" entry on upload;
  // this list is just the send queue, cleared after the message POST.
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentInfo[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Ref to the message input form. Used by the AskUserQuestion dialog below to
  // size its scroll wrapper so the dialog never overlaps the input (90vh minus
  // form height). The form height changes when the textarea grows (mobile
  // 1→8 rows), so we observe it instead of hardcoding a constant.
  const inputFormRef = useRef<HTMLFormElement>(null);
  // R56-B4: ref 镜像 messageInput, 兜底 React state 闭包被 stale 渲染 / 浏览器
  // autofill 注入污染时仍能拿到最近一次有效值. 每次 state 变更同步刷 ref.
  const messageInputRef = useRef("");
  useEffect(() => { messageInputRef.current = messageInput; }, [messageInput]);
  // Ref to the message textarea itself, for JS-based auto-resize on mobile
  // (replacing the unreliable `field-sizing:content` CSS feature — iOS Safari
  // and older mobile browsers ignore it and render at max-h, so the input
  // opens at 8-row height instead of 1).
  const messageTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputFormHeight, setInputFormHeight] = useState(0);
  // 桌面端 textarea 可手动拖拽调整高度; 移动端 auto-grow (1→8 行) 不受影响.
  // maxHpx = 当前桌面态固定 10rem (≈ 160px, 实际 1.25rem×8+padding), minHpx = 2.25rem.
  // 持久化 key 用 task 前缀, 同一浏览器不同 task 之间不串.
  const MIN_INPUT_H_PX = 36; // ~2.25rem = 1 row
  const MAX_INPUT_H_PX = 160; // ~10rem = 8 rows (matches desktop sm:h-[10rem])
  const [messageInputHeight, setMessageInputHeight] = useState<number>(MAX_INPUT_H_PX);
  const [messageInputHeightMounted, setMessageInputHeightMounted] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("task-msg-input-height-v1");
      if (raw) {
        const n = parseInt(raw, 10);
        if (n >= MIN_INPUT_H_PX && n <= MAX_INPUT_H_PX) setMessageInputHeight(n);
      }
    } catch {}
    setMessageInputHeightMounted(true);
  }, []);
  useEffect(() => {
    if (!messageInputHeightMounted) return;
    try { localStorage.setItem("task-msg-input-height-v1", String(messageInputHeight)); } catch {}
  }, [messageInputHeight, messageInputHeightMounted]);

  // Auto-resize textarea on mobile (< sm) based on content. CSS
  // `field-sizing:content` is unreliable on mobile browsers (iOS Safari +
  // older Android WebView), so the textarea opens at max-h (= 8 rows) instead
  // of 1. This effect sizes the textarea to its content height, clamped to
  // [MIN, MAX]. On desktop (sm+) the height is fixed by the user's drag, so
  // this effect is a no-op there (el.clientWidth >= 640 short-circuits it).
  // Note: leading-newline edge case — a single "\n" would compute scrollHeight
  // = 1 row, but the user is mid-edit and the second line is incoming; we
  // add one extra row of slack so a trailing \n doesn't visually shrink.
  useEffect(() => {
    const el = messageTextareaRef.current;
    if (!el) return;
    // Skip on desktop — messageInputHeight (CSS var) governs height there.
    if (el.clientWidth >= 640) return;
    el.style.height = "auto"; // reset to natural so scrollHeight is accurate
    const scrollH = el.scrollHeight;
    const slack = 4; // 1-2px slack so trailing newline doesn't shrink the box
    const next = Math.max(MIN_INPUT_H_PX, Math.min(MAX_INPUT_H_PX, scrollH + slack));
    el.style.height = `${next}px`;
    el.style.overflowY = scrollH + slack > MAX_INPUT_H_PX ? "auto" : "hidden";
  }, [messageInput]);
  // De-dup set: the upload route emits an SSE "attachment" event back to this
  // same tab. We push optimistically on upload, so track ids to skip the echo.
  const knownAttachmentIds = useRef<Set<string>>(new Set());
  // Only seed the failure banner from the DB when the task is actually
  // failed. A stale task.error (left over from a prior failure before the
  // task was re-activated) would otherwise re-show the banner on every
  // refresh even though the task is now running/reviewing/completed.
  const [error, setError] = useState<string | null>(
    task?.status === "failed" ? (task.error ?? null) : null
  );
  // Clear error when switching to a different task — the old task's error
  // is irrelevant and would otherwise persist across task switches.
  useEffect(() => { setError(null); }, [taskId]);
  // Track message-input form height so the AskUserQuestion dialog above can
  // cap its scroll wrapper at `90vh - formHeight` and never overlap the input.
  // ResizeObserver picks up textarea grow/shrink (mobile 1→8 rows, attachment
  // chips appearing, send button state changes) without us polling.
  useEffect(() => {
    const el = inputFormRef.current;
    if (!el) return;
    setInputFormHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setInputFormHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Reset scroll + content state on task switch. In chat/embedded mode the
  // component is reused (not remounted) across tasks, so anything from the
  // previous task would otherwise linger:
  //   - isNearBottomRef/unreadCount from the previous task → stale "N new
  //     messages" badge on a fresh task (scroll reset rationale)
  //   - messages/streamingText/error/loadingHistory from task A → user
  //     briefly sees A's content while B's history loads (the "task switch
  //     delay shows A's content" bug, R147)
  //   - status snapshot from task A → stale status badge on task B
  //   - fetchedTask (embedded mode) from task A → wrong task context (e.g.
  //     isDeleted flag) sticks until B's fetch resolves
  // Resetting messages to [] here guarantees the subsequent loadHistory sees
  // prev=[], so mergeHistory returns only B's history (covered by
  // merge-history.test.ts "prev 为空 → 直接返回 history").
  useEffect(() => {
    isNearBottomRef.current = true;
    setUnreadCount(0);
    userGestureAtRef.current = 0;
    progScrollAtRef.current = 0;
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    setMessages([]);
    setStreamingText("");
    setStatus(initialStatus ?? task?.status ?? "pending");
    setLoadingHistory(true);
    setError(null);
    if (embedded && !taskProp) setFetchedTask(undefined);
  }, [taskId]);
  // 同步 task prop 变化 (embedded 模式异步 fetch 到 task 时更新初始快照)
  useEffect(() => {
    if (task?.context_tokens != null) setContextTokens(task.context_tokens);
    if (task?.context_max != null) setContextMax(task.context_max);
    if (task?.cost_usd != null) setCostUsd(task.cost_usd);
  }, [task?.context_tokens, task?.context_max, task?.cost_usd]);
  const [isDeleted, setIsDeleted] = useState(!!task?.deleted_at);
  // Sync isDeleted when the active task changes (chat-view embedded 模式复用同一
  // TaskDetailClient 实例, selectedTaskId 切换只会换 taskId 不会重挂载; 不同步
  // 会出现「上一个 task 删除后的横幅停留在新 task 上」的 bug).
  useEffect(() => {
    setIsDeleted(!!task?.deleted_at);
  }, [task?.id, task?.deleted_at]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // v56: approveTask 被 gate 拒时 (awaiting_owner_review=1) 后端返 409, UI 弹
  //   确认框提示先 unset flag. 关闭后即可再 approve.
  const [awaitingOwnerReviewError, setAwaitingOwnerReviewError] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [rejectFeedbackMap, setRejectFeedbackMap] = useState<Record<string, string>>({});
  // User dialogs from the SDK (e.g. AskUserQuestion). Driven by
  // user_dialog_request / response / timeout SSE events; resolved via
  // POST /api/tasks/[id]/user-dialog. While non-empty, the "Send" form is
  // disabled to avoid concurrent input.
  const [pendingDialogs, setPendingDialogs] = useState<PendingDialog[]>([]);
  const [costUsd, setCostUsd] = useState(0);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  // 上下文占用快照 - 从 task prop 起步, SSE reviewing 终态事件携带时更新
  const [contextTokens, setContextTokens] = useState<number | null>(task?.context_tokens ?? null);
  const [contextMax, setContextMax] = useState<number | null>(task?.context_max ?? null);
  // 功能: Fork 弹窗打开时按当前上下文占用决定是否默认勾选「压缩后继续」.
  // 关注点: 必须读 live contextTokens —— task prop 是页面加载时的服务端快照, 而
  // context_tokens 只在每轮终态落库, 任务在页面打开后才跑完时 prop 恒为 null = 永不自动勾选.
  const shouldCompactFirst = () => (contextTokens ?? 0) > getCompactThreshold();
  const [loadingHistory, setLoadingHistory] = useState(true);
  // Evaluation widget — §9 v1 score API.
  const [evals, setEvals] = useState<Array<{ id: number; score: number; note: string | null; event: string; created_at: string }>>([]);
  const [evalScore, setEvalScore] = useState<number>(0);
  const [evalNote, setEvalNote] = useState("");
  const [evalSubmitting, setEvalSubmitting] = useState(false);
  // Right dock state — open set + per-panel widths (persisted via localStorage).
  const dock = useDockState();
  // Right dock width (horizontal resize) + collapsed toggle.
  const dockWidth = useDockWidth();
  const dockCollapsed = useDockCollapsed();
  const displayMode = useDisplayMode();
  // Drag state for horizontal split handle.
  const dragSplitRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Horizontal split drag handler — registered once.
  // 触屏兼容: R40 (镜像 R39 NavSidebar 模式) 加 touchmove/touchend 让移动端
  // (R56-B5 让 SPA 移动端可用) 也能调 dock 宽度. 桌面端 onmouse* 路径保留.
  useEffect(() => {
    // 抽 clientX: 鼠标事件直接 e.clientX; TouchEvent 在 e.touches[0].
    // 用 in 操作符窄判断避免误判 PointerEvent 之类.
    function getX(ev: MouseEvent | TouchEvent): number {
      if ("touches" in ev) {
        const t = ev.touches[0] ?? (ev as TouchEvent).changedTouches[0];
        return t ? t.clientX : 0;
      }
      return (ev as MouseEvent).clientX;
    }
    function onMove(e: MouseEvent | TouchEvent) {
      if (!dragSplitRef.current) return;
      const { startX, startWidth } = dragSplitRef.current;
      // Dragging left → dock gets wider (startX - clientX is positive)
      const delta = startX - getX(e);
      const next = Math.max(DOCK_MIN_W, Math.min(DOCK_MAX_W, startWidth + delta));
      dockWidth.setWidth(next);
    }
    function onUp() {
      if (dragSplitRef.current) {
        dragSplitRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // touchmove 用 { passive: false } 才能 e.preventDefault 阻止页面横滑; 桌面端不加会报 passive 警告.
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      if (dragSplitRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, [dockWidth.setWidth]);

  // 鼠标/触屏统一入口: 触屏从 e.touches[0].clientX 取起始 X, 桌面直接 e.clientX.
  function startSplitDrag(e: React.MouseEvent | React.TouchEvent) {
    const clientX =
      "touches" in e
        ? (e as React.TouchEvent).touches[0]?.clientX ?? 0
        : (e as React.MouseEvent).clientX;
    dragSplitRef.current = { startX: clientX, startWidth: dockWidth.width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  // Refresh keys for dock panels — bumped by SSE events.
  const [checkpointRefreshKey, setCheckpointRefreshKey] = useState(0);
  const [commitRefreshKey, setCommitRefreshKey] = useState(0);
  // Fork-from-here form state. null means the form is closed.
  // mode="message" forks at an arbitrary transcript message (upToMessageId),
  // not just at the head or a checkpoint.
  const [forkForm, setForkForm] = useState<
    | null
    | {
        mode: "head" | "checkpoint" | "message";
        checkpointId?: number;
        upToMessageId?: string;
        title: string;
        prompt: string;
        newCwd: string;
        maxTurns: string;
        autoApprove: "inherit" | "on" | "off";
        compactFirst: boolean;
      }
  >(null);
  // Resume-options modal. null = closed. Opened by the 暂停态 "恢复执行" button
  // so the operator can flip auto_approve / max_turns before resuming.
  const [resumeOpen, setResumeOpen] = useState(false);
  // Feishu write-back state. Only shown when task has an R<row> tag.
  const [feishuWriting, setFeishuWriting] = useState(false);
  const [feishuResult, setFeishuResult] = useState<{ wrote: number; total: number; row: number } | null>(null);
  const [feishuError, setFeishuError] = useState<string | null>(null);
  // Task tags - fetched once on mount so we can show the Feishu write-back
  // button only when the task originated from a Feishu row (has R<row> tag).
  const [taskTags, setTaskTags] = useState<string[]>([]);
  const feishuRow = useMemo(() => parseRequirementRow(taskTags), [taskTags]);
  // File changes panel
  const [showChanges, setShowChanges] = useState(false);
  const [changes, setChanges] = useState<ChangesResponse | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<{ diff: string | null; content: string | null; notFound: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Timeline refresh key — panel is rendered by RightDock
  const [timelineRefreshKey, setTimelineRefreshKey] = useState(0);
  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // 手机端 ⋯更多 下拉开关 — 折叠右侧 8 个次级按钮
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // Eval bar toggle
  const [evalOpen, setEvalOpen] = useState(false);
  // 状态动作按钮的 loading 态 - 单一槽位记录当前正在执行的 action 名
  // (approve/start/pause/cancel/refine/await/unawait/restart/delete).
  // 🆕 R131 (damo 2026-09-15): 旧 reject 从列表移除, 替换为 refine/await/unawait.
  // 任一按钮触发网络请求时设置, 完成/失败清空; StatusBtn 据此决定禁用 + spinner,
  // 既给用户反馈, 也避免重复点击触发后端 "task 已在终态" 类报错.
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Auto-approve toggle (synced with task.auto_approve, can be flipped before sending).
  // Default ON — operator experience 默认自动审批, 新会话不需要每次再勾一次.
  const [autoApprove, setAutoApprove] = useState(true);
  // Send-time LLM override popover. model is tri-state:
  //   ""        -> "默认" = use latest default (ignore task.model)
  //   "<model>" -> use this model
  // effort/max_turns pre-fill from the task row (they don't go stale) and are
  // derived during render so they track the async-fetched task in embedded mode
  // without a sync effect. Once the user edits a field, the edit sticks.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedModel, setAdvancedModel] = useState("");
  const [effortEdit, setEffortEdit] = useState<string | null>(null);
  const [maxTurnsEdit, setMaxTurnsEdit] = useState<string | null>(null);
  const advancedEffort = effortEdit ?? (task?.effort || "high");
  const advancedMaxTurns = maxTurnsEdit ?? (task?.max_turns ? String(task.max_turns) : "");
  const { options: modelOptions, loading: modelOptionsLoading } = useAvailableModels();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll key — only incremented on new content (messages/streaming/approvals),
  // NOT on collapse toggles, so expanding a tool call doesn't jump to bottom.
  const [scrollKey, setScrollKey] = useState(0);
  // Smart auto-scroll: track whether user is viewing history (scrolled up)
  const isNearBottomRef = useRef(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamps used to tell our own programmatic scrolls apart from real user
  // scrolling — see handleScroll for why the distinction matters.
  const progScrollAtRef = useRef(0);
  const userGestureAtRef = useRef(0);
  const NEAR_BOTTOM_THRESHOLD = 80; // px from bottom to consider "at bottom"
  const IDLE_AUTO_SCROLL_MS = 30000; // auto-scroll after 30s idle
  const PROG_SCROLL_ECHO_MS = 400; // window in which a scroll event may be our own echo

  // Filter messages by search query (case-insensitive) + display mode
  const { filteredMessages, matchCount, isFiltering } = useMemo(() => {
    let base = messages;
    // In text-only mode, hide all tool_use / tool_result messages.
    if (displayMode.mode === "text-only") {
      base = messages.filter(
        (msg) => msg.type !== "tool_use" && msg.type !== "tool_result"
      );
    }
    const q = searchQuery.trim();
    if (!q) {
      return { filteredMessages: base, matchCount: 0, isFiltering: false };
    }
    const lower = q.toLowerCase();
    const matched = base.filter((msg) => {
      if (msg.text && msg.text.toLowerCase().includes(lower)) return true;
      if (msg.toolName && msg.toolName.toLowerCase().includes(lower)) return true;
      if (msg.toolInput) {
        const inputStr = JSON.stringify(msg.toolInput).toLowerCase();
        if (inputStr.includes(lower)) return true;
      }
      return false;
    });
    return {
      filteredMessages: matched,
      matchCount: matched.length,
      isFiltering: true,
    };
  }, [messages, searchQuery, displayMode.mode]);

  // 进入 "expanded" 模式时一次性把所有 tool_use 设为 collapsed=false.
  // 这样 expanded 不再是"渲染时强制 uncollapse"——后者每帧都建新对象, 阻断
  // 单条 toggle (messages.indexOf 失败 + state 写完立刻被派生擦掉).
  // 改成"切到 expanded 那一刻落 state", 之后用户单条 toggle 写到 messages,
  // 渲染读 messages[i].collapsed, 单条折叠自然生效. 切回 all 不还原, 保留
  // 用户已经手动改过的状态; 再次切回 expanded 会重新全部 uncollapse.
  useEffect(() => {
    if (displayMode.mode === "expanded") {
      setMessages((prev) =>
        prev.map((m) =>
          m.type === "tool_use" && m.collapsed ? { ...m, collapsed: false } : m
        )
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode.mode]);

  // 注意: 不再在 effectiveMessages 里强制派生 collapsed=false, 见上面 useEffect.
  // expanded / all / text-only 的差异改由 filteredMessages (line ~837 隐藏
  // tool_use/tool_result) + MessageView 内部 collapsed 分支共同承担.
  const effectiveMessages = useMemo(() => {
    return groupAdjacentAttachments(filteredMessages);
  }, [filteredMessages]);

  // Load historical messages from DB (used on mount and on status_change
  // from terminal → queued/running to avoid wiping the message list).
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`);
      if (!res.ok) return;
      const msgs = await res.json();
      if (!Array.isArray(msgs)) return;
      const history: MessageItem[] = [];
      for (const m of msgs) {
        const ts = messageTimestamp(m as any);
        if (m.type === "user") {
          const content = m.message?.content;
          // Skip tool_result messages — the SDK stores them as type "user"
          // in the transcript, but they are NOT user input. They contain
          // tool execution results, subagent output, and internal markers
          // like <task-notification> that should never be shown as "👤 你".
          if (Array.isArray(content)) {
            const hasToolResult = content.some((b: any) => b.type === "tool_result");
            if (hasToolResult) continue; // skip entirely
            // Only extract genuine text blocks
            const text = content.map((b: any) => b.type === "text" ? b.text : "").join("");
            if (text) history.push({ type: "user", role: "user", text, uuid: m.uuid, timestamp: ts });
          } else if (typeof content === "string") {
            // String content: filter out SDK internal markers
            const text = content;
            if (text && !isSdkInternalContent(text)) {
              history.push({ type: "user", role: "user", text, uuid: m.uuid, timestamp: ts });
            }
          }
        } else if (m.type === "assistant" && m.message?.content) {
          const content = m.message.content;
          if (typeof content === "string") {
            history.push({ type: "assistant", role: "assistant", text: content, uuid: m.uuid, timestamp: ts });
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                history.push({ type: "assistant", role: "assistant", text: block.text, uuid: m.uuid, timestamp: ts });
              } else if (block.type === "tool_use") {
                history.push({
                  type: "tool_use",
                  toolName: block.name,
                  toolInput: block.input,
                  collapsed: true,
                  uuid: m.uuid,
                  timestamp: ts,
                });
              }
            }
          }
        }
      }
      // Merge task-level attachments into the timeline by created_at so
      // historical uploads (not replayed via SSE) still render in the stream.
      try {
        const attRes = await fetch(`/api/tasks/${taskId}/attachments`);
        if (attRes.ok) {
          const { attachments } = await attRes.json();
          if (Array.isArray(attachments)) {
            for (const a of attachments) {
              knownAttachmentIds.current.add(a.id);
              const ts = parseDbTime(a.created_at)?.getTime() ?? 0;
              insertByTimestamp(history, {
                type: "attachment",
                attachment: { id: a.id, filename: a.filename, media_type: a.media_type, size_bytes: a.size_bytes },
                timestamp: isNaN(ts) ? Date.now() : ts,
              });
            }
          }
        }
      } catch {
        /* attachments are best-effort for history */
      }
      // Inject task.prompt as the first user message if it's missing from
      // history. This covers the race where a newly created task's initial
      // prompt hasn't been flushed to the SDK JSONL or DB events yet.
      // On page refresh the SDK JSONL will contain it, so we deduplicate.
      // Note: a separate useEffect also handles this for the embedded mode
      // case where task data arrives after loadHistory has already run.
      const prompt = task?.prompt;
      if (prompt && !history.some((m) => m.type === "user" && m.text === prompt)) {
        // Fork 任务继承了父会话的 transcript, prompt 属于「fork 那一刻」而不是
        // 全部历史之前 —— unshift 会把操作者自己的指令埋到继承历史最上面、
        // fork 分隔线之上, 看起来就像消息没发出去。
        const forkMs = parseDbTime(forkedAt)?.getTime() ?? 0;
        if (forkMs) {
          insertByTimestamp(history, { type: "user", role: "user", text: prompt, timestamp: forkMs, isPrompt: true });
        } else {
          history.unshift({ type: "user", role: "user", text: prompt, timestamp: 0, isPrompt: true });
        }
      }
      // Merge instead of replace: preserve live messages (those the SSE
      // stream already pushed to state) that the freshly-loaded history
      // doesn't yet contain. Two dedup keys:
      //   1) optimistic user (no uuid) → text match against history user
      //   2) any prev message with uuid → uuid match against history
      // Without (2), an assistant_message SSE arriving between
      // status_change→running and loadHistory() resolving would be dropped
      // on resolve — the user sees "AI replied, then my message vanished"
      // until SDK JSONL flushes + a manual refresh. See merge-history.ts
      // for the rationale + tests.
      setMessages((prev) => mergeHistory(prev, history));
      setScrollKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  }, [taskId, forkedAt]);

  // Load historical messages on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadHistory();
      if (!cancelled) setLoadingHistory(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // In embedded mode, task is fetched asynchronously. When it arrives and
  // the initial prompt is missing from messages, inject it so the user's
  // first message is visible immediately (instead of waiting for the SDK
  // JSONL to flush, which may take seconds).
  useEffect(() => {
    if (!task?.prompt) return;
    setMessages((prev) => {
      if (prev.some((m) => m.type === "user" && m.text === task.prompt)) return prev;
      // 与 loadHistory 同一规则: fork 任务按 forked_at 插到继承历史之后。
      const forkMs = parseDbTime(forkedAt)?.getTime() ?? 0;
      if (forkMs) {
        const next = [...prev];
        insertByTimestamp(next, { type: "user", role: "user", text: task.prompt!, timestamp: forkMs, isPrompt: true });
        return next;
      }
      return [{ type: "user", role: "user", text: task.prompt!, timestamp: 0, isPrompt: true }, ...prev];
    });
  }, [task?.prompt, forkedAt]);

  // Fetch task tags once on mount - used to detect Feishu-origin tasks (R<row>)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/evals`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data)) return;
        setEvals(data);
      } catch {
        // ignore — endpoint may 404 if no evals yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  async function submitEval() {
    if (evalScore < 1 || evalScore > 5) return;
    setEvalSubmitting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score: evalScore, note: evalNote || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || "评分失败");
        return;
      }
      // refresh list
      const r2 = await fetch(`/api/tasks/${taskId}/evals`);
      if (r2.ok) setEvals(await r2.json());
      setEvalScore(0);
      setEvalNote("");
    } finally {
      setEvalSubmitting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled || !d.tags) return;
        try {
          const tags = JSON.parse(d.tags);
          if (Array.isArray(tags)) setTaskTags(tags);
        } catch {}
      } catch {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Connect to SSE stream. 共享单例: 与 TaskHeader 复用同一 EventSource.
  // handleEvent 是 function 声明(hoisted), cbRef 在 hook 内保最新引用.
  useTaskStream(taskId, (event) => {
    handleEvent(event);
  });

  // Smart auto-scroll: only scroll to bottom if user is already near bottom.
  // If user scrolled up to read history, show "N new messages" badge instead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // 所有程序滚动都要打 progScrollAtRef 时间戳, handleScroll 靠它区分
    // 「自己滚动的回声」与「用户手动上滚」, 见下面那个 effect 的注释.
    const stickToBottom = () => {
      progScrollAtRef.current = Date.now();
      el.scrollTop = el.scrollHeight;
    };

    if (isNearBottomRef.current) {
      stickToBottom();
      setUnreadCount(0);
    } else {
      // User is viewing history — increment unread count
      setUnreadCount((c) => c + 1);
    }

    // Reset idle timer — if user is idle for a while, auto-scroll back
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!isNearBottomRef.current) {
      idleTimerRef.current = setTimeout(() => {
        stickToBottom();
        isNearBottomRef.current = true;
        setUnreadCount(0);
      }, IDLE_AUTO_SCROLL_MS);
    }
  }, [scrollKey]);

  // Track scroll position to detect if user is near bottom.
  // Deps include taskId + !!task: in embedded (chat) mode the component early-
  // returns a loading placeholder before `task` is fetched, so scrollRef.current
  // is null on mount and the [] effect would register the listener on nothing.
  // Re-running once task resolves (and on task switch) binds the listener to
  // the now-mounted scroll container.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const stickToBottom = () => {
      progScrollAtRef.current = Date.now();
      el.scrollTop = el.scrollHeight;
    };

    // The scrollKey effect above may have fired while the container was still
    // unmounted (embedded mode renders a placeholder until `task` arrives), so
    // its scroll-to-bottom was silently dropped. Do it here once the container
    // exists, otherwise the view stays pinned at the top of the history.
    if (isNearBottomRef.current) stickToBottom();

    // 关注点: `el.scrollTop = el.scrollHeight` 派发的 scroll 事件是异步的, 等它跑到
    // 这里时 React 往往已提交了更多消息, scrollHeight 变大 -> 误判 atBottom=false,
    // isNearBottomRef 被自己的滚动回声置成 false, 之后每条新消息都记未读, 于是刚进
    // 聊天页就凭空冒出「N 条新消息」. 用 gesture/prog 时间戳区分: 若最近一次程序滚动
    // 之后没有用户手势, 这次 scroll 就是回声, 忽略.
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
      if (atBottom) {
        isNearBottomRef.current = true;
        setUnreadCount(0);
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        return;
      }
      const sinceProg = Date.now() - progScrollAtRef.current;
      const isEcho =
        sinceProg < PROG_SCROLL_ECHO_MS &&
        userGestureAtRef.current < progScrollAtRef.current;
      if (isEcho) return;
      isNearBottomRef.current = false;
    };

    const markGesture = () => { userGestureAtRef.current = Date.now(); };

    // 内容在首次滚动之后才变高(markdown 表格/代码块渲染、图片加载、流式补字)会让
    // 容器停在离底一百多像素处, 之后随便一条新消息就被记成未读. 跟随模式下重新贴底.
    // 用 MutationObserver 盯整个子树, 避免每条消息各挂一个 ResizeObserver.
    const mo = new MutationObserver(() => {
      if (isNearBottomRef.current) stickToBottom();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });

    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("wheel", markGesture, { passive: true });
    el.addEventListener("touchmove", markGesture, { passive: true });
    el.addEventListener("keydown", markGesture);
    el.addEventListener("mousedown", markGesture);
    return () => {
      mo.disconnect();
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("wheel", markGesture);
      el.removeEventListener("touchmove", markGesture);
      el.removeEventListener("keydown", markGesture);
      el.removeEventListener("mousedown", markGesture);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [taskId, !!task]);

  function handleEvent(event: any) {
    switch (event.type) {
      case "status_change":
        setStatus(event.to);
        if (event.cost_usd != null) setCostUsd(event.cost_usd);
        if (event.context_tokens != null) setContextTokens(event.context_tokens);
        if (event.context_max != null) setContextMax(event.context_max);
        if (shouldPlaySound(event)) playNotifySound();
        setTimelineRefreshKey((k) => k + 1);
        setCommitRefreshKey((k) => k + 1);
        // When task restarts/resumes from a terminal state, reload messages
        // from DB instead of clearing. This preserves history on resume (same
        // session_id) while still showing the full transcript on restart.
        if (["completed", "failed", "cancelled", "reviewing", "rejected", "await_user"].includes(event.from)
            && ["queued", "running"].includes(event.to)) {
          setStreamingText("");
          loadHistory();
          // Clear the stale failure banner (e.g. "Agent finished with error").
          // The task is running again; without this the red error block lingers
          // until a manual page refresh, even though the backend already
          // cleared task.error on re-activation.
          setError(null);
        }
        // When task fails, fetch the error message from DB (not carried in SSE event)
        if (event.to === "failed") {
          fetch(`/api/tasks/${task?.id ?? taskId}`)
            .then((r) => r.json())
            .then((t) => { if (t.error) setError(t.error); })
            .catch(() => {});
        }
        // Clear any dangling dialogs when task reaches a terminal state
        if (["completed", "failed", "cancelled"].includes(event.to)) {
          setPendingDialogs([]);
        }
        break;
      case "stream_delta":
        setStreamingText((prev) => prev + event.text);
        setScrollKey((k) => k + 1);
        break;
      case "assistant_message":
        setStreamingText("");
        setMessages((prev) => [
          ...prev,
          { type: "assistant", role: "assistant", text: event.text, uuid: event.uuid, timestamp: uuidToTimestamp(event.uuid) || Date.now() },
        ]);
        setScrollKey((k) => k + 1);
        break;
      case "tool_use":
        setStreamingText("");
        setMessages((prev) => [
          ...prev,
          {
            type: "tool_use",
            toolName: event.tool_name,
            toolInput: event.tool_input,
            uuid: event.uuid,
            timestamp: uuidToTimestamp(event.uuid) || Date.now(),
            collapsed: true, // Tool calls collapsed by default
          },
        ]);
        setScrollKey((k) => k + 1);
        break;
      case "tool_use_update":
        // Update an existing tool_use message with complete input
        // (emitted when the assistant message is finalized after
        // streaming already showed the tool call via content_block_start).
        setMessages((prev) =>
          prev.map((msg) =>
            msg.type === "tool_use" && msg.uuid === event.uuid
              ? { ...msg, toolInput: event.tool_input }
              : msg
          )
        );
        break;
      case "tool_result":
        setMessages((prev) => [
          ...prev,
          {
            type: "tool_result",
            toolName: event.tool_name,
            result: event.result,
          },
        ]);
        setScrollKey((k) => k + 1);
        break;
      case "tool_approval_request":
        if (shouldPlaySound(event)) playNotifySound();
        setPendingApprovals((prev) => [
          ...prev,
          {
            requestId: event.request_id,
            toolName: event.tool_name,
            toolInput: event.tool_input,
          },
        ]);
        // Also show in the message timeline like any other event
        setMessages((prev) => [
          ...prev,
          {
            type: "tool_use",
            toolName: event.tool_name,
            toolInput: event.tool_input,
            collapsed: false,
            uuid: event.request_id,
            timestamp: Date.now(),
          },
        ]);
        setScrollKey((k) => k + 1);
        break;
      case "tool_approval_response":
        setPendingApprovals((prev) =>
          prev.filter((a) => a.requestId !== event.request_id)
        );
        setRejectFeedbackMap((prev) => {
          const next = { ...prev };
          delete next[event.request_id];
          return next;
        });
        break;
      case "user_dialog_request":
        if (shouldPlaySound(event)) playNotifySound();
        setPendingDialogs((prev) => {
          if (prev.some((d) => d.requestId === event.request_id)) return prev;
          const selected: Record<string, Set<string>> = {};
          for (const q of event.questions || []) selected[q.question] = new Set();
          return [
            ...prev,
            {
              requestId: event.request_id,
              dialogKind: event.dialog_kind,
              toolUseId: event.tool_use_id,
              questions: event.questions || [],
              selected,
            },
          ];
        });
        break;
      case "user_dialog_response":
      case "user_dialog_timeout":
        setPendingDialogs((prev) =>
          prev.filter((d) => d.requestId !== event.request_id)
        );
        break;
      case "cost":
        setCostUsd(event.cost_usd ?? 0);
        setInputTokens((prev) => prev + (event.input_tokens || 0));
        setOutputTokens((prev) => prev + (event.output_tokens || 0));
        break;
      case "attachment": {
        const a = event.attachment;
        if (!a || knownAttachmentIds.current.has(a.id)) break;
        knownAttachmentIds.current.add(a.id);
        setMessages((prev) => {
          const next = [...prev];
          insertByTimestamp(next, { type: "attachment", attachment: a, timestamp: Date.now() });
          return next;
        });
        setScrollKey((k) => k + 1);
        break;
      }
      case "checkpoint":
        // Refresh the checkpoints list so the side panel shows the new row
        // without a manual reload.
        setCheckpointRefreshKey((k) => k + 1);
        break;
      case "error":
        setError(event.error);
        break;
      case "warning":
        // 平台侧告警(如后台 subagent 未回收就收尾): 进时间线, 不覆盖 error 横幅.
        setMessages((prev) => [
          ...prev,
          { type: "warning", text: event.message, timestamp: Date.now() },
        ]);
        setScrollKey((k) => k + 1);
        break;
      case "message":
        // Real-time user message pushed via SSE (from sendUserMessage in
        // reviewing/paused/queued/closed-session branches). Without this,
        // messages sent during reviewing don't appear until page refresh.
        if (event.data) {
          try {
            const data = JSON.parse(event.data);
            if (data.role === "user" && data.text && !isSdkInternalContent(data.text)) {
              setMessages((prev) => {
                // Deduplicate: skip if already present (optimistic append or
                // history replay may have added it).
                if (prev.some((m) => m.type === "user" && m.text === data.text)) return prev;
                return [
                  ...prev,
                  {
                    type: "user",
                    role: "user",
                    text: data.text,
                    // R55 B1: read sender_type from event data so live UI shows
                    // 👤你/🤖脚本/⚙️系统 instead of hardcoded 👤.
                    sender_type: data.sender_type,
                    timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
                  },
                ];
              });
              setScrollKey((k) => k + 1);
            }
          } catch {}
        }
        break;
      case "history":
        // History events from DB — process both non-message events and
        // messages that may be missing from the initial history fetch
        // (e.g. queued messages while the task was paused, which exist in
        // DB events but not in the SDK session JSONL).
        if (event.data) {
          try {
            const data = JSON.parse(event.data);
            // Restore cost info from history
            if (event.event_type === "cost" && data.cost_usd) {
              setCostUsd(data.cost_usd);
            }
            // 刷新后仍能看到平台告警(后台 subagent 未回收等), 按 message 去重.
            if (event.event_type === "warning" && data.message) {
              setMessages((prev) =>
                prev.some((m) => m.type === "warning" && m.text === data.message)
                  ? prev
                  : [...prev, { type: "warning", text: data.message, timestamp: Date.now() }]
              );
            }
            // Replay user messages from history that aren't already shown.
            // This covers the gap where queued messages (sent while paused)
            // exist in DB events but weren't in the SDK session when the
            // initial /messages fetch ran.
            if (event.event_type === "message" && (data.role === "user" || data.role === "assistant")) {
              const text = typeof data.text === "string" ? data.text : "";
              // Filter out SDK internal content (task-notification, system-reminder)
              // that may have been logged as user messages.
              if (text && !(data.role === "user" && isSdkInternalContent(text))) {
                setMessages((prev) => {
                  // Deduplicate: skip if a message with the same text already exists
                  const isDup = prev.some(
                    (m) => m.type === (data.role === "user" ? "user" : "assistant") && m.text === text
                  );
                  if (isDup) return prev;
                  return [
                    ...prev,
                    {
                      type: data.role === "user" ? "user" : "assistant",
                      role: data.role,
                      text,
                      // R55 B1: same as live SSE path — replay shows correct icon.
                      sender_type: data.role === "user" ? data.sender_type : undefined,
                      timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
                    },
                  ];
                });
                setScrollKey((k) => k + 1);
              }
            }
            // Replay a pending user dialog so the widget re-appears after
            // reload (the SDK promise may already be gone after a server
            // restart — flag stale so the UI can warn). Only add if no
            // matching response/timeout event exists later in history.
            if (event.event_type === "user_dialog_request" && data.questions) {
              const reqId = data.request_id || `replay-${data.tool_use_id || Math.random()}`;
              setPendingDialogs((prev) => {
                if (prev.some((d) => d.requestId === reqId)) return prev;
                const selected: Record<string, Set<string>> = {};
                for (const q of data.questions as UserDialogQuestion[]) selected[q.question] = new Set();
                return [
                  ...prev,
                  {
                    requestId: reqId,
                    dialogKind: data.dialog_kind,
                    toolUseId: data.tool_use_id,
                    questions: data.questions,
                    selected,
                    stale: true,
                  },
                ];
              });
            }
            // Replay dialog resolution — remove from pendingDialogs so
            // already-answered questions don't reappear after page refresh.
            if (event.event_type === "user_dialog_response" && data.request_id) {
              setPendingDialogs((prev) =>
                prev.filter((d) => d.requestId !== data.request_id)
              );
            }
            if (event.event_type === "user_dialog_timeout" && data.request_id) {
              setPendingDialogs((prev) =>
                prev.filter((d) => d.requestId !== data.request_id)
              );
            }
            // Update status from history events (e.g. after page refresh,
            // the SSE replays status_change so the UI reflects the latest state
            // even if the initialStatus prop was stale).
            if (
              event.event_type === "status_change" &&
              data.to
            ) {
              setStatus(data.to);
              // Fetch error message when task fails (not carried in SSE/history event)
              if (data.to === "failed" && !error) {
                fetch(`/api/tasks/${task?.id ?? taskId}`)
                  .then((r) => r.json())
                  .then((t) => { if (t.error) setError(t.error); })
                  .catch(() => {});
              }
              // Clear dangling dialogs if task reached a terminal state
              if (["completed", "failed", "cancelled", "reviewing"].includes(data.to)) {
                setPendingDialogs([]);
              }
            }
          } catch {}
        }
        break;
    }
  }

  // tool_use 的折叠态翻转. 按 uuid 匹配, 同 assistant message 内多个 tool_use
  // 共享 assistant 的 uuid 时会一起翻转 (上游 SDK 没给每个 tool_use block
  // 独立 id, 短期修不动 — 已知 trade-off). uuid 缺失直接 return 不响应.
  function toggleCollapse(uuid: string) {
    if (!uuid) return;
    setMessages((prev) =>
      prev.map((msg) =>
        msg.type === "tool_use" && msg.uuid === uuid
          ? { ...msg, collapsed: !msg.collapsed }
          : msg
      )
    );
  }

  async function postAction(action: string, body?: any) {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/tasks/${taskId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        // v56: approve 被 awaiting_owner_review gate 拦下, 后端返 409 + code=
        // AWAITING_OWNER_REVIEW. UI 不只 toast 错误, 弹一个确认框提示先 unset.
        if (data?.code === "AWAITING_OWNER_REVIEW") {
          setAwaitingOwnerReviewError(true);
        } else {
          toastError(data.error || "操作失败");
        }
        return { ...data, ok: false };
      } else if (data.status) {
        setStatus(data.status);
        // Local action may also flip status — refresh timeline so it shows
        // the new transition without waiting for the SSE event.
        setTimelineRefreshKey((k) => k + 1);
        // If the action re-activated the task (message/start/resume/restart
        // from a terminal state), clear the stale failure banner in lockstep
        // with the status update instead of waiting for the SSE event.
        if (["queued", "running"].includes(data.status)) {
          setError(null);
        }
      }
      return data;
    } catch (err: any) {
      toastError(err.message);
      return { ok: false, error: err.message };
    } finally {
      setActionLoading(null);
    }
  }

  // 功能: 清空重来 - 走 postAction("restart"), loading 态由 actionLoading 槽位管.
  // 关注点: postAction 内已 setActionLoading("restart"), StatusBtn 据此禁用 + spinner.
  async function handleRestart() {
    await postAction("restart");
  }

  async function handleDeleteTask() {
    setShowDeleteConfirm(true);
  }

  // v56: unset awaiting_owner_review flag. Damo 拍板完成后调, 然后再 approve
  //   即可转 completed. 仅 PATCH 该 flag, 不动 status (保持 reviewing/await_user/paused).
  async function unsetAwaitingReview() {
    setActionLoading("unset-awaiting-review");
    try {
      const res = await fetch(`/api/tasks/${taskId}/unset-awaiting-review`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || "unset 失败");
        return;
      }
      // 关闭 gate 提示框. SSE task-update 不携带 awaiting_owner_review 字段,
      // 走 window.location.reload 拉新 server props (角标立即消失, 用户可接着 approve).
      setAwaitingOwnerReviewError(false);
      toastWarning("已解除等拍板标记, 刷新中...");
      window.location.reload();
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function confirmDeleteTask() {
    setShowDeleteConfirm(false);
    setActionLoading("delete");
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`删除失败: ${err.error}`);
        return;
      }
      setIsDeleted(true);
    } catch (err: any) {
      toastError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRestoreTask() {
    try {
      const res = await fetch(`/api/tasks/${taskId}/restore`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        toastError(`恢复失败: ${err.error}`);
        return;
      }
      setIsDeleted(false);
    } catch (err: any) {
      toastError(err.message);
    }
  }

  async function handleFileSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/tasks/${taskId}/attachments`, { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) {
          toastError(data.error || "上传失败");
          continue;
        }
        const a: AttachmentInfo = {
          id: data.attachment.id,
          filename: data.attachment.filename,
          media_type: data.attachment.media_type,
          size_bytes: data.attachment.size_bytes,
        };
        knownAttachmentIds.current.add(a.id);
        // Surface the upload as a standalone entry in the stream.
        setMessages((prev) => {
          const next = [...prev];
          insertByTimestamp(next, { type: "attachment", attachment: a, timestamp: Date.now() });
          return next;
        });
        setPendingAttachments((prev) => [...prev, a]);
        setScrollKey((k) => k + 1);
      } catch (err: any) {
        toastError(err.message);
      }
    }
  }

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    // 优先用 ref 兜底 (state 在 stale closure / 浏览器 autofill / React 批处理
    // 竞态时可能滞后), trim 检查 + capture 都走 ref, 避免空 message 把
    // "message is required" toast 撞出来.
    const liveText = (messageInputRef.current || messageInput).trim();
    if (!liveText) return;
    const text = messageInputRef.current || messageInput;
    const atts = pendingAttachments;
    const attIds = atts.map((a) => a.id);

    // 🆕 R143 五轮 (damo 2026-09-15): chat slash command.
    //   /goal <prompt> → POST /api/tasks 新建 goal-loop task (同当前 project/version).
    //   /loop [interval] <prompt> → POST /api/schedules 新建 cron schedule (agent 类型).
    //   非 slash → 走原 message 路径. parseSlashCommand 纯函数, 见 src/lib/chat/slash-command.ts.
    const slash = parseSlashCommand(text);
    if (slash.kind === "goal") {
      if (!slash.prompt) {
        toastError("/goal 后请输入目标条件");
        return;
      }
      await handleSlashGoal(slash.prompt);
      return;
    }
    if (slash.kind === "loop") {
      if (!slash.prompt) {
        toastError("/loop 后请输入任务指令");
        return;
      }
      await handleSlashLoop(slash.prompt, slash.interval, slash.cronExpr);
      return;
    }

    // True optimistic UI: 生成 clientId 并在 POST 之前就插入 temp message.
    // reviewing 等状态下 SSE 不一定补发 message 事件, post-response 追加会让
    // 用户感知「消息没出去」直到刷新. 这里按 clientId 立即入 UI, POST 失败
    // 按同 clientId 撤回; SSE message 事件按 text 去重不会重复渲染.
    const clientId = uuidv4();
    setMessageInput("");
    setPendingAttachments([]);
    setMessages((prev) => appendOptimisticUserMessage(prev, text, clientId));
    // User actively sent a message — always scroll to bottom
    isNearBottomRef.current = true;
    setUnreadCount(0);
    setScrollKey((k) => k + 1);
    const result = await postAction("message", {
      message: text,
      attachments: attIds.length > 0 ? attIds : undefined,
      // model: always sent. null = use latest default (ignore task.model
      // snapshot); non-empty = use this model. Implements "默认用最新模型".
      model: advancedModel || null,
      // effort/max_turns: only override when the user opened the advanced
      // panel (opt-in). When the panel stays closed, the task row's stored
      // values apply (they don't go stale like model names do).
      effort: showAdvanced ? (advancedEffort || undefined) : undefined,
      max_turns: showAdvanced && advancedMaxTurns ? Number(advancedMaxTurns) : undefined,
    });
    if (result?.ok === false) {
      // POST 失败回滚: 撤回 temp message + 还原输入框 + 还原附件
      setMessages((prev) => removeOptimisticMessage(prev, clientId));
      setMessageInput(text);
      setPendingAttachments(atts);
    }
  }

  // R143 五轮: /goal <prompt> → 创建新 task, prompt 包成 <goal>...</goal>
  //   触发 goal loop (settings.max_goal_rounds 走默认 20). project_id/version_id
  //   复用当前 task 归属, 失败 → 还原输入框.
  async function handleSlashGoal(prompt: string) {
    const goalPrompt = `<goal>${prompt}</goal>`;
    setMessageInput("");
    setPendingAttachments([]);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt,
          prompt: goalPrompt,
          autoApprove: true, // goal loop 强制要求
          project_id: task?.project_id,
          version_id: task?.version_id || undefined,
          type: task?.type || undefined,
          // 复用当前 task 的运行配置 (model/effort 等), 不复用 prompt
          model: task?.model || undefined,
          effort: task?.effort || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const newTask = await res.json();
      toastSuccess(`已创建 goal task #${newTask.id.slice(0, 8)}`);
      window.location.href = `/tasks/${newTask.id}`;
    } catch (err) {
      console.error("[slash /goal] failed:", err);
      toastError("创建 goal task 失败");
      setMessageInput(`/goal ${prompt}`); // 还原输入框
    }
  }

  // R143 五轮: /loop [interval] <prompt> → 创建 cron schedule (agent 类型),
  //   用当前 task 的 project/version. 失败 → 还原输入框.
  async function handleSlashLoop(prompt: string, interval: string, cronExpr: string) {
    setMessageInput("");
    setPendingAttachments([]);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `loop-${interval}-${prompt.slice(0, 30)}`,
          exec_type: "agent",
          schedule_type: "cron",
          schedule_expr: cronExpr,
          title: prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt,
          prompt,
          auto_approve: true,
          project_id: task?.project_id,
          version_id: task?.version_id || undefined,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const schedule = await res.json();
      toastSuccess(`已创建 cron schedule #${schedule.id.slice(0, 8)} (${interval})`);
    } catch (err) {
      console.error("[slash /loop] failed:", err);
      toastError(`创建 /loop schedule 失败: ${err instanceof Error ? err.message : "未知"}`);
      setMessageInput(`/loop ${interval} ${prompt}`); // 还原输入框
    }
  }

  async function handleRefine() {
    isNearBottomRef.current = true;
    setUnreadCount(0);
    // 🆕 R131 (damo 2026-09-15): refine 取代旧 reject. message 可选 — 不传只切
    //   状态, 传了同时 push 给 agent 让它接着改. 无 feedback 必填限制.
    await postAction("refine", { message: refineInput });
    setRefineInput("");
  }

  // 🆕 R131 (damo 2026-09-15): await 弹窗 - running 状态主动切到 await_user.
  async function handleAwait() {
    isNearBottomRef.current = true;
    setUnreadCount(0);
    await postAction("await", { reason: awaitReason, note: awaitNote });
    setAwaitNote("");
  }

  // 🆕 R131 (damo 2026-09-15): unawait 弹窗 - await_user 状态显式回到 running.
  async function handleUnawait() {
    isNearBottomRef.current = true;
    setUnreadCount(0);
    await postAction("unawait", { reason: unawaitReason, note: unawaitNote });
    setUnawaitNote("");
  }

  // Write orchestrator metadata (task_id, session_id, base/head_commit,
  // fork count, checkpoint count, status) back to the Feishu row that
  // originated this task. Only meaningful for tasks with an R<row> tag.
  async function writeBackToFeishu() {
    setFeishuWriting(true);
    setFeishuError(null);
    setFeishuResult(null);
    try {
      const res = await fetch(`/api/feishu/write-back/${taskId}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFeishuResult({ wrote: data.wrote, total: data.total, row: data.row });
    } catch (err) {
      setFeishuError(err instanceof Error ? err.message : "写回失败");
    } finally {
      setFeishuWriting(false);
    }
  }

  async function handleToolApproval(requestId: string, approved: boolean, feedback?: string) {
    // User actively approved a tool — scroll to bottom on next content
    isNearBottomRef.current = true;
    setUnreadCount(0);
    try {
      const res = await fetch(`/api/tasks/${taskId}/tool-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, approved, feedback }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || "审批操作失败");
      }
    } catch (err: any) {
      toastError(err.message);
    }
  }

  // Build the {question -> "label" or "label1, label2"} map from the
  // current selection state and POST it to the runtime. Multi-select
  // answers are joined with ", " to match the format the runtime expects
  // when filtering selected options server-side.
  async function handleDialogSubmit(d: PendingDialog) {
    const answers: Record<string, string> = {};
    for (const q of d.questions) {
      const sel = d.selected[q.question];
      if (!sel || sel.size === 0) {
        toastWarning("请先回答每个问题");
        return;
      }
      answers[q.question] = Array.from(sel).join(", ");
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}/user-dialog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: d.requestId, answers }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || "提交答案失败");
        return;
      }
      // Optimistic clear: SSE usually delivers user_dialog_response within
      // ms, but a stale/duplicate widget may not. Drop after 5s regardless.
      setTimeout(() => {
        setPendingDialogs((prev) => prev.filter((p) => p.requestId !== d.requestId));
      }, 5000);
    } catch (err: any) {
      toastError(err.message);
    }
  }

  async function handleDialogCancel(d: PendingDialog) {
    try {
      const res = await fetch(`/api/tasks/${taskId}/user-dialog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: d.requestId, cancelled: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || "取消失败");
      }
      setTimeout(() => {
        setPendingDialogs((prev) => prev.filter((p) => p.requestId !== d.requestId));
      }, 5000);
    } catch (err: any) {
      toastError(err.message);
    }
  }

  // In embedded mode, wait for task data to be fetched before rendering.
  if (embedded && !task) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        加载中...
      </div>
    );
  }

  // 状态动作按钮 - 放在状态徽标旁，方便直接更新状态（聊天/非聊天共用位置B）
  // 每个按钮的 loading 判断: actionLoading === <该 action 名>. 同一时刻只有一个
  // action 在飞 (单一槽位), 所以可以全局通用, 无需为每个按钮单独写 state.
  const statusActions = (() => {
    switch (status) {
      case "pending":
        return <StatusBtn onClick={() => postAction("start")} loading={actionLoading === "start"} variant="green">▶ 启动</StatusBtn>;
      case "queued":
        // 排在中, 没有 session 在跑, 也还没有 running slot; 只能取消出列.
        // 不给"启动"按钮 -- queued 是调度器已收下、并发/cwd 闸门还未放行的状态,
        // 手动 start 会绕过 scheduler, 抢同一槽位. 等调度器推即可.
        return <StatusBtn onClick={() => postAction("cancel")} loading={actionLoading === "cancel"} variant="red">✕ 取消</StatusBtn>;
      case "running":
        // 🆕 R131 (damo 2026-09-15): 等用户介入按钮 - 让 damo 在 running 状态主动
        //   切到 await_user (等派发 / 等拍板 / 有建议), 不用等 agent 自己跑完.
        return <>
          <StatusBtn onClick={() => openAwaitDialog()} loading={actionLoading === "await"} variant="yellow">⏸ 等用户介入</StatusBtn>
          <StatusBtn onClick={() => postAction("pause")} loading={actionLoading === "pause"} variant="yellow">⏸ 暂停</StatusBtn>
          <StatusBtn onClick={() => postAction("cancel")} loading={actionLoading === "cancel"} variant="red">✕ 取消</StatusBtn>
        </>;
      case "reviewing":
        // 🆕 R131 (damo 2026-09-15): 旧 reject 按钮替换为 refine (reviewing→running
        //   投消息让 agent 接着干). feedback 不再必填, refine 弹窗可选带消息.
        return <>
          <StatusBtn onClick={() => openRefineDialog()} loading={actionLoading === "refine"} variant="blue">↻ 继续干</StatusBtn>
          <StatusBtn onClick={() => postAction("approve")} loading={actionLoading === "approve"} variant="emerald">✅ 完成</StatusBtn>
          <StatusBtn onClick={handleRestart} loading={actionLoading === "restart"} variant="green">🔄 清空重来</StatusBtn>
        </>;
      case "await_user":
        // 🆕 R131 (damo 2026-09-15): 等用户介入状态 - 显示 approve (自动 unwait)
        //   + unawait (显式回到 running, 留痕 reason) 两个动作. 区别 approve 直接
        //   完成, unawait 让 agent 继续工作.
        return <>
          <StatusBtn onClick={() => openUnawaitDialog()} loading={actionLoading === "unawait"} variant="blue">▶ 继续执行</StatusBtn>
          <StatusBtn onClick={() => postAction("approve")} loading={actionLoading === "approve"} variant="emerald">✅ 完成</StatusBtn>
          <StatusBtn onClick={() => postAction("cancel")} loading={actionLoading === "cancel"} variant="red">✕ 取消</StatusBtn>
        </>;
      case "paused":
        return <>
          <StatusBtn onClick={() => postAction("start")} loading={actionLoading === "start"} variant="blue">▶ 恢复执行</StatusBtn>
          <StatusBtn onClick={() => postAction("approve")} loading={actionLoading === "approve"} variant="emerald">✅ 已完成</StatusBtn>
          <StatusBtn onClick={() => postAction("cancel")} loading={actionLoading === "cancel"} variant="red">✕ 取消</StatusBtn>
        </>;
      case "rejected":
        // ⚠️ 历史兼容: 旧 task 可能仍在 rejected 状态. 不再写入新值, 但 UI 保留
        //   "继续执行" (走 start 路径) + "已完成" (走 approve 路径) 两个按钮.
        return <>
          <StatusBtn onClick={() => postAction("start")} loading={actionLoading === "start"} variant="blue">继续执行</StatusBtn>
          <StatusBtn onClick={() => postAction("approve")} loading={actionLoading === "approve"} variant="emerald">✅ 已完成</StatusBtn>
        </>;
      case "failed":
      case "cancelled":
      case "completed":
        return <StatusBtn onClick={handleRestart} loading={actionLoading === "restart"} variant="green">🔄 清空重来</StatusBtn>;
      default:
        return null;
    }
  })();

  // R105: 删除按钮从终态放宽到「非 running」. 与 board-client / kanban-view
  //   共用 canDeleteTask 判定 (constants.ts), 收敛在常量层避免漂移.
  const deleteButton = canDeleteTask(status, task?.deleted_at) ? (
    <StatusBtn onClick={handleDeleteTask} loading={actionLoading === "delete"} variant="red">🗑 删除</StatusBtn>
  ) : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* 任务元信息行 - embedded(聊天)模式放标题下方; 非聊天由 TaskHeader 提供 */}
      {embedded && task && (
        <div className="border-b border-gray-200 bg-white px-3 py-1 sm:px-4 sm:py-1.5">
          <TaskMetaRow
            model={task.resolved_model || task.model}
            effort={task.effort}
            maxTurns={task.max_turns}
            createdAt={task.created_at}
            contextTokens={contextTokens}
            contextMax={contextMax}
            cost={costUsd}
          />
        </div>
      )}
      {/* Status bar (位置B) - 状态 + 动作按钮(紧挨状态) ... 右侧 dock/view 按钮靠右.
          relative 给下面 MoreMenu 的 absolute top-full 提供定位锚点 — 否则 dropdown 会
          浮到外层容器底部 (R32 H5 反馈).
          H5 端 flex-nowrap + overflow-x-auto: 状态动作按钮多时不让 ⋯ 被挤到下一行
          (R32 反馈 "工具条不要换行"), 横向溢出用户可滚动; sm+ 恢复 flex-wrap 自适应. */}
      <div className="relative border-b border-gray-200 bg-white px-3 py-1.5 sm:px-4 sm:py-2 flex items-center gap-1.5 sm:gap-2 flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-visible">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${STATUS_DOT[status] || "bg-gray-400"}`} />
        <span className="text-sm font-medium">{STATUS_LABELS[status] || status}</span>
        {taskType && (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${TYPE_COLORS[taskType] || "bg-gray-50 text-gray-500 border-gray-200"}`}>
            {TYPE_LABELS[taskType] || taskType}
          </span>
        )}
        {statusActions}
        {deleteButton}
        {!embedded && task?.project_id && (
          <Link
            href={`/${task.project_id}/${task.version_id || "unversioned"}?mode=chat&taskId=${taskId}`}
            className="text-xs px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-blue-600 hover:border-blue-300 transition-colors"
            title="在聊天视图中查看"
          >
            💬 聊天视图
          </Link>
        )}
        <a
          href={`/transcript/${taskId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:inline-flex text-xs px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-blue-600 hover:border-blue-300 transition-colors"
          title="完整会话转录 (含 thinking / tool_result), 可下载 .md / .jsonl"
        >
          📜 完整会话
        </a>
        {/* Dock / 搜索 / 评分 / Fork / 视图模式 按钮 — 桌面态右侧铺开, 手机端折叠到
            ⋯更多 下拉里 (R56). 关键: 右侧块整块 hide on mobile, 避免 ml-auto + flex-wrap
            把这些按钮推到换行后被裁出可视区, 也避免按钮挤占状态行高度把消息区压扁.
            4 个 dock 面板 (详情/时间线/Checkpoints/Commits) 的 toggle 不放这里,
            用户直接点右侧 RightDock 的 panel header 即可. */}
        <div className="ml-auto hidden sm:flex items-center gap-1.5 sm:gap-2 flex-wrap">
        <button
          onClick={dockCollapsed.toggle}
          className={`text-xs px-2 py-1 rounded border ${
            dockCollapsed.collapsed
              ? "bg-blue-100 text-blue-700 border-blue-200"
              : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
          }`}
          title={dockCollapsed.collapsed ? "展开右侧面板" : "收起右侧面板"}
        >
          {dockCollapsed.collapsed ? "◧ 面板" : "◨"}
        </button>
        <button
          onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearchQuery(""); }}
          className={`text-xs px-2 py-1 rounded border ${
            searchOpen || searchQuery
              ? "bg-sky-100 text-sky-700 border-sky-200"
              : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
          }`}
          title="搜索消息"
        >
          🔍
        </button>
        {(status === "completed" || status === "rejected") && (
          <button
            onClick={() => setEvalOpen((v) => !v)}
            className={`text-xs px-2 py-1 rounded border ${
              evalOpen
                ? "bg-amber-100 text-amber-700 border-amber-200"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
            }`}
            title="评分"
          >
            ⭐
          </button>
        )}
        {session_id_available(status) && (
          <button
            onClick={() =>
              setForkForm({
                mode: "head",
                title: "",
                prompt: "",
                newCwd: "",
                maxTurns: "",
                autoApprove: "inherit",
                compactFirst: shouldCompactFirst(),
              })
            }
            className="inline-flex text-xs px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            title="Fork 当前 session"
          >
            <span>📋</span>
            <span className="hidden sm:inline ml-1">Fork</span>
          </button>
        )}
        <button
          onClick={displayMode.cycle}
          className={`inline-flex text-xs px-2 py-1 rounded border ${
            displayMode.mode === "text-only"
              ? "bg-gray-100 text-gray-700 border-gray-300"
              : displayMode.mode === "expanded"
                ? "bg-sky-100 text-sky-700 border-sky-200"
                : "bg-amber-100 text-amber-700 border-amber-200"
          }`}
          title={`显示模式：${displayMode.labels[displayMode.mode]}（点击切换：纯文本 → 标准 → 详情）`}
        >
          {displayMode.icons[displayMode.mode]}
        </button>
        </div>
        {/* 手机端 ⋯更多 下拉 — 折叠 8 个次级按钮 (详情/时间线/Checkpoints/Commits/
            面板/搜索/评分/Fork) + 状态栏 sm:hidden 的 transcript + displayMode.
            H5 端只露 ⋯ 一个图标, 其它显示模式按钮也折叠进来 (R32: "工具条不要换行...保留...
            和最前面的一两个图标就够了"). */}
        <div className="ml-auto sm:hidden flex items-center gap-1.5">
          <button
            onClick={() => setMoreMenuOpen((v) => !v)}
            className={`text-xs px-2 py-1 rounded border ${
              moreMenuOpen
                ? "bg-blue-100 text-blue-700 border-blue-200"
                : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
            }`}
            title="更多操作"
            aria-expanded={moreMenuOpen}
            aria-haspopup="menu"
          >
            ⋯
          </button>
        </div>
      </div>
      {/* MoreMenu — 手机端下拉, 折叠 8 个次级按钮. 点 pill 外关闭.
          用 absolute 定位浮在 status bar 下方, 不撑高 flex-wrap 行. */}
      {moreMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 sm:hidden"
            onClick={() => setMoreMenuOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute right-2 top-full mt-1 z-50 sm:hidden bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[180px]"
          >
            {/* 顶部: 状态栏上 sm:inline-flex 但 mobile 隐藏的入口, 兜到下拉里 (R32). */}
            <a
              href={`/transcript/${taskId}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMoreMenuOpen(false)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 text-gray-700"
            >
              <span>📜</span><span>完整会话</span>
            </a>
            {/* 视图模式切换: H5 端从状态栏折叠到下拉, 当前模式在文字后面括号标注. */}
            <button
              onClick={() => { displayMode.cycle(); }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 text-gray-700`}
              title={`切换：纯文本 → 标准 → 详情（当前：${displayMode.labels[displayMode.mode]}）`}
            >
              <span>{displayMode.icons[displayMode.mode]}</span>
              <span>视图：{displayMode.labels[displayMode.mode]}</span>
            </button>
            <div className="border-t border-gray-100 my-1" />
            <button
              onClick={() => { dockCollapsed.toggle(); setMoreMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 text-gray-700"
            >
              <span>{dockCollapsed.collapsed ? "◧" : "◨"}</span>
              <span>{dockCollapsed.collapsed ? "展开右侧面板" : "收起右侧面板"}</span>
            </button>
            <button
              onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearchQuery(""); setMoreMenuOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 text-gray-700"
            >
              <span>🔍</span><span>搜索消息</span>
            </button>
            {(status === "completed" || status === "rejected") && (
              <button
                onClick={() => { setEvalOpen((v) => !v); setMoreMenuOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 text-gray-700"
              >
                <span>⭐</span><span>评分</span>
              </button>
            )}
            {session_id_available(status) && (
              <button
                onClick={() => {
                  setForkForm({
                    mode: "head",
                    title: "",
                    prompt: "",
                    newCwd: "",
                    maxTurns: "",
                    autoApprove: "inherit",
                    compactFirst: shouldCompactFirst(),
                  });
                  setMoreMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 text-gray-700"
              >
                <span>📋</span><span>Fork 当前 session</span>
              </button>
            )}
          </div>
        </>
      )}

      {/* Evaluation bar (§9 v1) — only on completed/rejected, toggled by ⭐ icon */}
      {evalOpen && (status === "completed" || status === "rejected") && (
        <div className="border-b border-gray-200 bg-amber-50/50 px-3 py-1.5 sm:px-4 sm:py-2 flex items-center gap-2 sm:gap-3 flex-wrap text-xs">
          <span className="font-medium text-gray-700">
            评分（{evals.length} 次）
          </span>
          {evals.length > 0 && (
            <span className="text-gray-600">
              avg{" "}
              {(
                evals.reduce((s, e) => s + e.score, 0) / evals.length
              ).toFixed(2)}
            </span>
          )}
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setEvalScore(n)}
              className={`px-2 py-0.5 rounded-full border ${
                evalScore === n
                  ? "bg-amber-500 text-white border-amber-500"
                  : "bg-white text-gray-600 border-gray-300 hover:bg-amber-100"
              }`}
              title={`${n} 星`}
            >
              {n}★
            </button>
          ))}
          <input
            type="text"
            value={evalNote}
            onChange={(e) => setEvalNote(e.target.value)}
            placeholder="备注（可选）"
            className="border border-gray-300 rounded px-2 py-0.5 flex-1 min-w-[160px] max-w-md"
          />
          <button
            onClick={submitEval}
            disabled={evalScore < 1 || evalSubmitting}
            className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:bg-gray-300"
          >
            {evalSubmitting ? "提交中..." : "提交评分"}
          </button>
          {evals.length > 0 && (
            <details className="ml-2">
              <summary className="cursor-pointer text-gray-500">历史</summary>
              <ul className="absolute z-10 mt-1 bg-white border border-gray-200 rounded shadow p-2 text-xs space-y-1 max-h-40 overflow-y-auto w-72">
                {evals.map((e) => (
                  <li key={e.id} className="border-b border-gray-100 pb-1">
                    <span className="font-mono text-gray-500">{e.created_at}</span>{" "}
                    <span className="font-medium">{e.score}★</span>{" "}
                    <span className="text-gray-400">({e.event})</span>
                    {e.note && <div className="text-gray-600 ml-2">{e.note}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Deleted banner */}
      {isDeleted && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 flex items-center gap-3">
          <span className="text-sm text-red-700 font-medium">🗑 此任务已删除</span>
          <button
            onClick={handleRestoreTask}
            className="bg-blue-600 text-white px-3 py-1 rounded text-xs hover:bg-blue-700"
          >
            恢复任务
          </button>
        </div>
      )}

      {/* Pending tool approvals */}
      {pendingApprovals.length > 0 && (
        <div className="border-b border-orange-200 bg-orange-50 px-3 py-2 sm:px-4 sm:py-3 space-y-3">
          <div className="text-sm font-medium text-orange-800">
            ⚠️ 等待审批 ({pendingApprovals.length})
          </div>
          {pendingApprovals.map((approval) => (
            <div key={approval.requestId} className="bg-white rounded-lg border border-orange-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-orange-700">
                    🔧 {approval.toolName}
                  </div>
                  <pre className="text-xs text-gray-600 overflow-x-auto mt-1 max-h-32">
                    {JSON.stringify(approval.toolInput, null, 2)}
                  </pre>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button
                    onClick={() => handleToolApproval(approval.requestId, true)}
                    className="bg-emerald-600 text-white px-3 py-1 rounded text-xs hover:bg-emerald-700 whitespace-nowrap"
                  >
                    ✅ 允许
                  </button>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={rejectFeedbackMap[approval.requestId] || ""}
                      onChange={(e) =>
                        setRejectFeedbackMap((prev) => ({
                          ...prev,
                          [approval.requestId]: e.target.value,
                        }))
                      }
                      placeholder="拒绝原因..."
                      className="border rounded px-1.5 py-0.5 text-xs w-24"
                    />
                    <button
                      onClick={() =>
                        handleToolApproval(
                          approval.requestId,
                          false,
                          rejectFeedbackMap[approval.requestId] || undefined
                        )
                      }
                      className="bg-red-500 text-white px-2 py-0.5 rounded text-xs hover:bg-red-600 whitespace-nowrap"
                    >
                      ❌ 拒绝
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pending user dialogs (e.g. AskUserQuestion). Agent is blocked
          inside `onUserDialog` until the user submits or cancels. The
          "Send" form is disabled while any dialog is pending so the model
          doesn't get a side-channel text message mid-question. */}
      {pendingDialogs.length > 0 && (
        // 弹窗整体 cap 在 60vh, 内部用 flex column 让 scroll 区自动填满剩余,
        // 提交/取消按钮 shrink-0 始终贴底可见 — 之前用 inline maxHeight 算 100vh - inputFormHeight,
        // 在 mobile 弹窗出现瞬间 inputFormHeight=0 → maxHeight=812px → 弹窗直接撑爆底部按钮行。
        <div className="border-b border-violet-200 bg-violet-50 px-3 py-2 sm:px-4 sm:py-3 max-h-[60vh] flex flex-col gap-3">
          <div className="flex items-center justify-between shrink-0">
            <div className="text-sm font-medium text-violet-800">
              ❓ Agent 提问 ({pendingDialogs.length})
            </div>
            <div className="text-xs text-violet-600">回答前无法发送消息</div>
          </div>
          {pendingDialogs.map((d) => {
            const allAnswered = d.questions.every((q) => (d.selected[q.question]?.size ?? 0) > 0);
            return (
              <div key={d.requestId} className="bg-white rounded-lg border border-violet-200 p-3 flex flex-col gap-3 flex-1 min-h-0 overflow-hidden">
                {d.stale && (
                  <div className="shrink-0 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    ⚠ 服务端已重启，原问题可能已超时；提交可能无效。
                  </div>
                )}
                {/* Scroll wrapper: flex-1 + min-h-0 让此区域自动填满卡片内剩余高度,
                    长 question / 多 options / 多 question 时只滚动此区域,
                    提交/取消按钮在外 shrink-0 保持可见,不被长内容挤到看不见。 */}
                <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
                {d.questions.map((q) => (
                  <div key={q.question}>
                    {q.header && (
                      <div className="text-[10px] font-medium text-violet-700 bg-violet-100 inline-block rounded px-1.5 py-0.5 mb-1 uppercase tracking-wide">
                        {q.header}
                      </div>
                    )}
                    <div className="text-sm font-medium text-gray-800 mb-1.5 whitespace-pre-wrap break-words">
                      {q.question}
                    </div>
                    <div className="space-y-1.5">
                      {q.options.map((opt) => {
                        const sel = d.selected[q.question];
                        const checked = sel?.has(opt.label) ?? false;
                        return (
                          <label
                            key={opt.label}
                            className={`flex items-start gap-2 px-2.5 py-1.5 rounded border cursor-pointer text-sm ${
                              checked
                                ? "border-violet-500 bg-violet-50 ring-1 ring-violet-300"
                                : "border-gray-200 hover:border-gray-300 bg-white"
                            }`}
                          >
                            <input
                              type={q.multi_select ? "checkbox" : "radio"}
                              name={`q-${d.requestId}-${q.question}`}
                              checked={checked}
                              onChange={() => {
                                setPendingDialogs((prev) =>
                                  prev.map((p) => {
                                    if (p.requestId !== d.requestId) return p;
                                    const nextSet = new Set(p.selected[q.question] ?? []);
                                    if (q.multi_select) {
                                      if (nextSet.has(opt.label)) nextSet.delete(opt.label);
                                      else nextSet.add(opt.label);
                                    } else {
                                      nextSet.clear();
                                      nextSet.add(opt.label);
                                    }
                                    return {
                                      ...p,
                                      selected: { ...p.selected, [q.question]: nextSet },
                                    };
                                  })
                                );
                              }}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-gray-800 break-words">{opt.label}</div>
                              {opt.description && (
                                <div className="text-xs text-gray-500 mt-0.5 break-words whitespace-pre-wrap">
                                  {opt.description}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
                </div>
                <div className="shrink-0 flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
                  <button
                    onClick={() => handleDialogCancel(d)}
                    className="px-3 py-1 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => handleDialogSubmit(d)}
                    disabled={!allAnswered}
                    className="bg-violet-600 text-white px-3 py-1 text-sm rounded hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    提交
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Search bar — expandable via 🔍 button in status bar */}
      {searchOpen && (
        <div className="border-b border-gray-200 bg-white px-4 py-1.5 flex items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setSearchQuery(""); setSearchOpen(false); }
            }}
            placeholder="搜索消息..."
            autoFocus
            className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-blue-400"
          />
          {isFiltering && (
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {matchCount} 个匹配
            </span>
          )}
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-xs text-gray-400 hover:text-gray-700 px-1"
              title="清空搜索"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Messages — min-h 兜底: 即使上方弹窗 cap 到 60vh, 消息区仍保留至少
          80px 上下文 (最近一条 tool call / streaming 行), 用户能看到 agent 在干嘛.
          R56-B4: flex 列布局, 每条 MessageView 外包一层按 role 决定左右对齐
          (user 右, assistant/tool 左); warning/attachment 居中保持不变. */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.length === 0 && !streamingText && !task?.result && !error && (
          <div className="text-center text-gray-400 py-10">
            {loadingHistory
              ? "加载历史消息..."
              : status === "pending"
                ? "任务尚未启动"
                : status === "queued"
                  ? "排队中，等待调度..."
                  : status === "failed"
                    ? "任务失败"
                    : status === "cancelled"
                      ? "任务已取消"
                    : status === "completed"
                      ? "任务已完成"
                    : status === "reviewing"
                      ? "任务执行完毕，等待审核"
                    : status === "rejected"
                      ? "任务已驳回"
                    : status === "paused"
                      ? "任务已暂停"
                    : status === "verifying"
                      ? "正在跑机械验收..."
                    : "等待 agent 输出..."}
          </div>
        )}
        {/* Show task.result when no messages but agent produced output */}
        {messages.length === 0 && !streamingText && (task?.result || error) && (
          <div className="space-y-2">
            {error && (
              <div className="bg-red-50 rounded-lg p-3 text-sm text-red-700">
                ⚠️ {error}
              </div>
            )}
            {task?.result && (
              <div className="bg-blue-50 rounded-lg p-3 text-sm text-gray-700">
                <div className="flex items-center mb-1">
                  <span className="text-blue-500 text-xs mr-2">🤖</span>
                  <span className="text-gray-400 text-xs">Agent 输出</span>
                </div>
                <div
                  className="prose-sm max-w-none break-words [&_pre]:bg-gray-900 [&_pre]:text-gray-100 [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre]:text-xs [&_code]:bg-blue-100 [&_code]:text-blue-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs"
                  dangerouslySetInnerHTML={{ __html: linkifyTaskPrefixes(linkifyDocPaths(markdownToHtml(task.result, task?.project_id, task?.version_id), task?.project_id, task?.version_id, wikiProjectsProp)) }}
                />
              </div>
            )}
          </div>
        )}
        {isFiltering && filteredMessages.length === 0 && messages.length > 0 && (
          <div className="text-center text-gray-400 py-10 text-sm">
            没有匹配的消息
          </div>
        )}
        {effectiveMessages.map((msg, displayIdx) => {
          // 用 msg.uuid 作 key + onToggle 入参; expanded 模式派生新对象不
          // 再阻断 toggle (uuid 跨对象稳定). attachment_group 是 R121 合并
          // 出来的合成对象, 没有原 uuid, 不参与 tool_use toggle 路径.
          // R56-B4 chat 布局: 按 message 类型决定 row 对齐 — user 右, assistant /
          // tool_use / tool_result 居左, warning / attachment / attachment_group
          // 居中. 注意 wrapper 是 flex-col, 横向对齐是 items-X (cross axis),
          // 不是 justify-X (justify-X 在 column 里是垂直对齐).
          const rowAlign =
            msg.type === "warning" ||
            msg.type === "attachment" ||
            msg.type === "attachment_group"
              ? "items-center"
              : msg.role === "user"
                ? "items-end"
                : "items-start";
          return (
            <div key={msg.uuid || `m-${displayIdx}`} className={`flex flex-col w-full ${rowAlign}`}>
              <MessageView
                msg={msg}
                onToggle={() => {
                  if (msg.type === "tool_use" && msg.uuid) toggleCollapse(msg.uuid);
                }}
                prevMsg={displayIdx > 0 ? effectiveMessages[displayIdx - 1] : undefined}
              searchQuery={searchQuery}
              parentTask={parentTask}
              forkedAt={forkedAt}
              displayMode={displayMode.mode}
              projectId={task?.project_id ?? null}
              versionId={task?.version_id ?? null}
              wikiProjects={wikiProjectsProp}
              onForkFromMessage={
                session_id_available(status)
                  ? (upToMessageId) =>
                      setForkForm({
                        mode: "message",
                        upToMessageId,
                        title: "",
                        prompt: "",
                        newCwd: "",
                        maxTurns: "",
                        autoApprove: "inherit",
                        compactFirst: shouldCompactFirst(),
                      })
                  : undefined
              }
            />
            </div>
          );
        })}
        {streamingText && (
          <div className="bg-blue-50 rounded-lg p-3 text-sm text-gray-700">
            <span className="text-blue-500 text-xs mr-2">🤖</span>
            {streamingText}
            <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse" />
          </div>
        )}
        {error && (
          <div className="bg-red-50 rounded-lg p-3 text-sm text-red-700">
            ⚠️ {error}
          </div>
        )}
        {/* New messages notification — shown when user scrolled up */}
        {unreadCount > 0 && (
          <div
            className="sticky bottom-0 left-0 right-0 flex justify-center pointer-events-none"
          >
            <button
              onClick={() => {
                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                  isNearBottomRef.current = true;
                  setUnreadCount(0);
                  if (idleTimerRef.current) {
                    clearTimeout(idleTimerRef.current);
                    idleTimerRef.current = null;
                  }
                }
              }}
              className="pointer-events-auto bg-blue-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg hover:bg-blue-700 transition-colors mb-2"
            >
              ↓ {unreadCount} 条新消息
            </button>
          </div>
        )}
      </div>

      {/* Message input — always visible; sending a message auto-starts/resumes */}
      <form
        ref={inputFormRef}
        onSubmit={handleSendMessage}
        // R56-B4 防 autofill / 浏览器扩展污染: noValidate 跳过原生校验,
        // autoComplete="off" 让密码管理器 / Grammarly 等扩展别插手;
        // 配套 textarea 也设 autoComplete="off" 见下.
        noValidate
        autoComplete="off"
        className="border-t bg-white p-2 sm:p-3 shrink-0"
      >
          {/* 拖拽手柄: form 的第一个节点, -mt-3 把手柄从 padding 内拉到 1px border 上,
              视觉上读作「border 的延伸」。向上拖 = 高度增加, 向下拖 = 高度减小。 */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = messageInputHeight;
              const onMove = (ev: MouseEvent) => {
                // 手柄在 form 顶部: delta 为负(clientY 减小 = 往上) → 高度增加。
                // 范围 [MIN_INPUT_H_PX, MAX_INPUT_H_PX] = [2.25rem, 10rem]。
                const delta = startY - ev.clientY;
                const next = Math.max(MIN_INPUT_H_PX, Math.min(MAX_INPUT_H_PX, startH + delta));
                setMessageInputHeight(next);
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
            className="hidden sm:flex h-1.5 -mt-3 mb-1.5 cursor-ns-resize items-center justify-center hover:bg-blue-100 active:bg-blue-200"
            title="拖动调整输入框高度（向上调高，向下调低）"
          >
            <span className="block w-10 h-[3px] bg-gray-300 rounded-full" />
          </div>
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pendingAttachments.map((a) => (
                // Chip 整块可点击 → 新窗口打开原文件 (和 messages 区 attachment 一致,
                // `messages.attachment` 块已用 /api/attachments/<id>). × 按钮 stopPropagation
                // 阻止冒泡到外层 <a>, 否则点 × 会同时新窗口打开附件.
                <a
                  key={a.id}
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex items-center gap-1 bg-gray-100 border border-gray-200 rounded px-2 py-1 text-xs text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors"
                  title="点击查看附件"
                >
                  {a.media_type.startsWith("image/") ? "🖼️" : "📄"}
                  <span className="max-w-[160px] truncate group-hover:underline">{a.filename}</span>
                  <span className="text-gray-400 group-hover:text-blue-500">{formatSize(a.size_bytes)}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setPendingAttachments((prev) => prev.filter((p) => p.id !== a.id));
                    }}
                    className="text-gray-400 hover:text-red-500"
                  >
                    ×
                  </button>
                </a>
              ))}
            </div>
          )}
          {/* 输入框上移一行: 原 [⚙️][textarea][📎][发送] 横排改成 textarea 顶满宽,
              下面一行 [☑自动审批 + ⚙️] ............ [📎 + 发送] 居两侧. */}
          <textarea
            ref={messageTextareaRef}
            value={messageInput}
            onChange={(e) => {
              setMessageInput(e.target.value);
              // 同步刷 ref, 避免下一次 send 触发时 useEffect 还没跑 (state
              // 闭包 stale) 导致 messageInputRef.current 滞后.
              messageInputRef.current = e.target.value;
            }}
            autoComplete="off"
            spellCheck={false}
            // 用 CSS 变量 + Tailwind 响应式断点: 桌面 sm+ 套用户拖拽高度,
            // 移动端 < sm 用 JS auto-resize (见上方 useEffect) — 不能依赖
            // `field-sizing:content`, iOS Safari 不可靠, 会一上来按 max-h 渲染 8 行.
            style={{ "--msg-input-h": `${messageInputHeight}px` } as CSSProperties}
            onKeyDown={(e) => {
              // Enter 发送 (符合主流 IM 习惯: 微信/飞书/QQ/iMessage).
              // Cmd/Ctrl/Shift+Enter 显式插入 \n (controlled textarea 下不赌浏览器
              // 默认行为, 避免 React setState 与默认插入的 race 丢字符).
              // 跳过 IME composing 状态: 中文输入法候选上屏时 Enter 由 IME 吞掉,
              // 不能误触发发送, 换行也先等 IME 确认再说 (queueMicrotask 跑在 IME
              // 提交之后, 自然安全).
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                if (e.shiftKey || e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  const t = e.currentTarget;
                  const { selectionStart: s, selectionEnd: end, value: v } = t;
                  const newValue = v.slice(0, s) + "\n" + v.slice(end);
                  setMessageInput(newValue);
                  // React 18+ 自动批处理会在 commit 后 re-render; 用 microtask
                  // 在 re-render 之后把光标移回换行符后, 否则光标会跳到末尾.
                  queueMicrotask(() => {
                    t.selectionStart = t.selectionEnd = s + 1;
                  });
                } else {
                  e.preventDefault();
                  inputFormRef.current?.requestSubmit();
                }
              }
            }}
            placeholder={
              pendingDialogs.length > 0
                ? "请先回答 agent 的提问..."
                : status === "running"
                  ? "输入消息发送给 agent… (/goal <目标> 创建 goal task, /loop 30m <指令> 周期任务)"
                  : status === "paused"
                    ? "输入消息（恢复后自动发送）… (/goal /loop 同上)"
                    : "输入消息重新激活任务… (/goal /loop 同上)"
            }
            disabled={pendingDialogs.length > 0}
            rows={1}
            // 移动端高度由 JS auto-resize effect 控制 (见上 useEffect, 1 行 → 8 行);
            // 桌面 sm+ 由 messageInputHeight (用户拖拽过的 px 值) 控制, 默认 160px =
            // 原 sm:h-[10rem]. 用户拖拽后存 localStorage, 跨刷新保留.
            // 关键: sm:h-[var(--msg-input-h)] 只在 sm+ 套用, 移动端不设 height — 改由
            // effect 直接操作 el.style.height (因为 CSS max-h 在移动端也会推高渲染高度).
            className="w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400 resize-none leading-[1.25rem] sm:h-[var(--msg-input-h)] sm:min-h-0"
          />
          <div className="flex justify-between items-center mt-1.5 sm:mt-2 gap-2 flex-wrap">
            <div className="flex items-center gap-2 sm:gap-3">
              <label className="flex items-center gap-1 text-xs text-gray-500 select-none cursor-pointer" title="自动审批：开启后 agent 工具调用无需逐个审核">
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(e) => {
                    setAutoApprove(e.target.checked);
                    // Persist to DB immediately
                    fetch(`/api/tasks/${taskId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ auto_approve: e.target.checked }),
                    }).catch(() => {});
                  }}
                  className="rounded border-gray-300"
                />
                <span className="hidden sm:inline">自动审批</span>
              </label>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                title="发送时覆盖模型/强度/最大轮次"
                className={`shrink-0 border rounded-lg px-2 py-1.5 text-sm cursor-pointer ${showAdvanced ? "bg-blue-50 border-blue-300 text-blue-600" : "text-gray-500 hover:bg-gray-100 hover:border-gray-400"}`}
              >
                ⚙️
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  handleFileSelect(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={pendingDialogs.length > 0}
                title="上传附件"
                className="border rounded-lg px-3 py-2 text-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 hover:bg-gray-100 hover:border-gray-400 hover:text-gray-700 transition-colors"
              >
                📎
              </button>
              <button
                type="submit"
                disabled={!messageInput.trim() || pendingDialogs.length > 0}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50 hover:bg-blue-700 transition-colors"
              >
                发送
              </button>
            </div>
          </div>
          {showAdvanced && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              {status === "running" && (
                <div className="mb-2 text-xs text-amber-600">
                  💡 任务运行中：配置将在下次恢复/重启时生效，本次发送仅推送消息。
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">模型</label>
                  <Select
                    value={advancedModel}
                    onChange={(v) => setAdvancedModel(v)}
                    options={modelOptions}
                    disabled={modelOptionsLoading && modelOptions.length <= 1}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">强度</label>
                  <Select
                    value={advancedEffort}
                    onChange={(v) => setEffortEdit(v)}
                    options={EFFORT_LEVELS.map((v) => ({ value: v, label: v }))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">最大轮次</label>
                  <input
                    type="number"
                    value={advancedMaxTurns}
                    onChange={(e) => setMaxTurnsEdit(e.target.value)}
                    placeholder="默认 200"
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
            </div>
          )}
        </form>
      </div>

      {/* Resizable split handle + Right dock — desktop: inline, mobile: overlay drawer */}
      {!dockCollapsed.collapsed && (
        <>
          {/* Mobile overlay backdrop */}
          <div
            className="fixed inset-0 bg-black/30 z-40 md:hidden"
            onClick={dockCollapsed.toggle}
          />
          {/* Vertical drag handle between chat and right dock (desktop only) */}
          <div
            onMouseDown={startSplitDrag}
            onTouchStart={startSplitDrag}
            // touchAction: none 让拖动手柄上的触碰不触发页面横滑 / 缩放, 跟 R39 NavSidebar 一致
            style={{ touchAction: "none" }}
            className="hidden md:block w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors"
            title="拖拽调整面板宽度"
          />
          <div className="md:contents fixed inset-y-0 right-0 z-50 md:relative md:z-auto">
            <RightDock
              task={task!}
              dependsOnTasks={dependsOnTasks}
              dependentTasks={dependentTasks}
              parentTask={parentTask}
              dispatcherTask={dispatcherTask}
              dispatchedTasks={dispatchedTasks}
              requirementLink={requirementLink}
              requirementSiblings={requirementSiblings}
              taskId={taskId}
              sessionIdAvailable={session_id_available(status)}
              onForkFromCheckpoint={(checkpointId) => {
                setForkForm({
                  mode: "checkpoint",
                  checkpointId,
                  title: "",
                  prompt: "",
                  newCwd: "",
                  maxTurns: "",
                  autoApprove: "inherit",
                  compactFirst: shouldCompactFirst(),
                });
              }}
              refreshKeys={{
                timeline: timelineRefreshKey,
                checkpoints: checkpointRefreshKey,
                commits: commitRefreshKey,
              }}
              heights={dock.state.height}
              collapsed={dock.state.collapsed}
              setHeightPair={dock.setHeightPair}
              normalizeHeights={dock.normalizeHeights}
              toggleCollapsed={dock.toggleCollapsed}
              setCollapsed={dock.setCollapsed}
              dockWidth={dockWidth.width}
              onClose={dockCollapsed.toggle}
            />
          </div>
        </>
      )}

      {/* Fork-from-here modal form */}
      {forkForm && (
        <ForkFormModal
          taskId={taskId}
          form={forkForm}
          onChange={setForkForm}
          onClose={() => setForkForm(null)}
        />
      )}

      {/* Resume-options modal (暂停态恢复执行) */}
      {resumeOpen && (
        <ResumeModal
          taskId={taskId}
          task={task!}
          onClose={() => setResumeOpen(false)}
          onResumed={(status) => {
            setStatus(status);
            setTimelineRefreshKey((k) => k + 1);
            setResumeOpen(false);
          }}
        />
      )}

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="删除任务"
        message={`确定删除「${task?.title ?? ""}」？删除后可通过看板「显示已删除」恢复。`}
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={confirmDeleteTask}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* v56: 等拍板 gate 拦截提示. 用户点 approve 时如果任务标了
         awaiting_owner_review=1, 弹这个确认框, 提供「先 unset 再 approve」入口. */}
      <ConfirmDialog
        open={awaitingOwnerReviewError}
        title="任务标了等拍板"
        message={`Agent 在 result 里写了 <awaiting_review/> marker, 平台拒绝自动 approve。先调「解除等拍板标记」解除 flag, 再点完成即可。`}
        confirmLabel="解除等拍板标记"
        cancelLabel="取消"
        variant="default"
        onConfirm={unsetAwaitingReview}
        onCancel={() => setAwaitingOwnerReviewError(false)}
      />

      {/* 🆕 R131 (damo 2026-09-15): refine 弹窗 — reviewing 状态投消息让 agent 接着干.
           取代旧 reject 弹窗. message 可选 (不传只切状态). */}
      <ConfirmDialog
        open={refineDialogOpen}
        title="让 agent 接着干"
        message={
          <div className="space-y-2">
            <p className="text-sm text-gray-600">
              任务从 reviewing 切回 running, agent 会按新指示继续。消息可选。
            </p>
            <input
              type="text"
              value={refineInput}
              onChange={(e) => setRefineInput(e.target.value)}
              placeholder="(可选) 给 agent 的继续消息"
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
        }
        confirmLabel="↻ 继续干"
        cancelLabel="取消"
        variant="default"
        onConfirm={() => { handleRefine(); setRefineDialogOpen(false); }}
        onCancel={() => setRefineDialogOpen(false)}
      />

      {/* 🆕 R131 (damo 2026-09-15): await 弹窗 — running 状态切到 await_user.
           reason 3 选 1 + note 可选. */}
      <ConfirmDialog
        open={awaitDialogOpen}
        title="等用户介入"
        message={
          <div className="space-y-2">
            <p className="text-sm text-gray-600">切到「等用户介入」状态，等拍板/建议。</p>
            <select
              value={awaitReason}
              onChange={(e) => setAwaitReason(e.target.value as typeof awaitReason)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="dispatch_needed">dispatch_needed — 等派发实现</option>
              <option value="decision_pending">decision_pending — 等拍板</option>
              <option value="suggestion">suggestion — 有建议给 damo</option>
            </select>
            <input
              type="text"
              value={awaitNote}
              onChange={(e) => setAwaitNote(e.target.value)}
              placeholder="(可选) 备注"
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
        }
        confirmLabel="⏸ 等用户介入"
        cancelLabel="取消"
        variant="default"
        onConfirm={() => { handleAwait(); setAwaitDialogOpen(false); }}
        onCancel={() => setAwaitDialogOpen(false)}
      />

      {/* 🆕 R131 (damo 2026-09-15): unawait 弹窗 — await_user 切回 running.
           reason 3 选 1 + note 可选. 区别 approve (完成): unawait 让 agent 继续. */}
      <ConfirmDialog
        open={unawaitDialogOpen}
        title="让 agent 继续执行"
        message={
          <div className="space-y-2">
            <p className="text-sm text-gray-600">任务从「等用户介入」回到 running，agent 接着干。</p>
            <select
              value={unawaitReason}
              onChange={(e) => setUnawaitReason(e.target.value as typeof unawaitReason)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="agent_self_resolved">agent_self_resolved — agent 自决</option>
              <option value="user_timeout">user_timeout — 用户超时</option>
              <option value="external_event">external_event — 外部触发</option>
            </select>
            <input
              type="text"
              value={unawaitNote}
              onChange={(e) => setUnawaitNote(e.target.value)}
              placeholder="(可选) 备注"
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
        }
        confirmLabel="▶ 继续执行"
        cancelLabel="取消"
        variant="default"
        onConfirm={() => { handleUnawait(); setUnawaitDialogOpen(false); }}
        onCancel={() => setUnawaitDialogOpen(false)}
      />
    </div>
  );
}

function session_id_available(status: string): boolean {
  return ["paused", "reviewing", "rejected", "await_user", "completed", "failed", "cancelled"].includes(status);
}

// Visual divider between inherited (parent session) and own-session messages
function ForkBoundary({ parentTask }: { parentTask: { id: string; title: string; status: string } | null }) {
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = `${window.location.origin}/#/tasks/${parentTask?.id}`;
    copyToClipboard(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  // This component only renders client-side (inside message list), so window is safe
  return (
    <div className="my-4 w-full">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 h-px bg-blue-300" />
        <div className="flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 px-3 py-1.5 rounded-full border border-blue-200 shrink-0 font-medium">
          <span>🔀</span>
          <span>Fork 起点 — 以下为本会话内容</span>
        </div>
        <div className="flex-1 h-px bg-blue-300" />
      </div>
      {parentTask && (
        <div className="text-center text-xs text-blue-500 flex items-center justify-center gap-1">
          上方继承自{' '}
          <a
            href={`/tasks/${parentTask.id}`}
            className="text-blue-700 hover:underline font-medium"
            title={parentTask.title}
          >
            {parentTask.title}
          </a>
          <a
            href={`/tasks/${parentTask.id}`}
            className="text-blue-400 hover:text-blue-600 font-mono"
            title={`跳转到 ${parentTask.id}`}
          >
            #{parentTask.id.slice(0, 8)}
          </a>
          <button
            onClick={copyLink}
            className="text-blue-300 hover:text-blue-500 transition-colors p-0.5"
            title="复制任务链接"
          >
            {copied ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-emerald-500">
                <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                <path d="M7 3.5A1.5 1.5 0 018.5 2h5A1.5 1.5 0 0115 3.5v9A1.5 1.5 0 0113.5 14h-5A1.5 1.5 0 017 12.5v-9z" />
                <path d="M3.5 6A1.5 1.5 0 002 7.5v9A1.5 1.5 0 003.5 18h9a1.5 1.5 0 001.5-1.5V7.5A1.5 1.5 0 0012.5 6h-9z" opacity="0.3" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function MessageView({ msg, onToggle, prevMsg, searchQuery, parentTask, forkedAt, displayMode, projectId, versionId, onForkFromMessage, wikiProjects }: { msg: MessageItem; onToggle: () => void; prevMsg?: MessageItem; searchQuery: string; parentTask: { id: string; title: string; status: string } | null; forkedAt: string | null; displayMode: DisplayMode; projectId: string | null; versionId: string | null; onForkFromMessage?: (upToMessageId: string) => void; wikiProjects?: ProjectCwdRef[] }) {
  // R47 反馈: 跨日时显式加日期前缀 (MM-DD HH:MM:SS), 同日保持 HH:MM:SS.
  const tsLabel = msg.timestamp ? formatTimestampLabel(msg.timestamp, prevMsg?.timestamp) : null;
  const q = searchQuery.trim();

  // Visual separator between user and assistant messages
  const needsSeparator = prevMsg && prevMsg.role !== msg.role && (msg.role === "assistant" || msg.role === "user");

  // Fork boundary: prevMsg timestamp < forkedAt AND current msg timestamp >= forkedAt
  // → marks the transition from inherited (parent) messages to this session's own messages.
  const forkMs = parseDbTime(forkedAt)?.getTime() ?? 0;
  const isForkBoundary =
    forkedAt &&
    prevMsg?.timestamp &&
    msg.timestamp &&
    prevMsg.timestamp < forkMs &&
    msg.timestamp >= forkMs;

  if (msg.type === "warning") {
    return (
      <div className="flex justify-center my-1">
        <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-xs text-amber-800 max-w-[560px]">
          ⚠️ {msg.text}
        </div>
      </div>
    );
  }
  if (msg.type === "attachment" && msg.attachment) {
    const a = msg.attachment;
    const url = `/api/attachments/${a.id}`;
    // PR-1: chat inline 媒体渲染. 前端只认 media_type 前缀, 不读 metadata, 不绑 provider.
    //   image/* → <img> 大图预览; video/* → <video controls> (autoplay=false);
    //   audio/* → <audio controls>; 其他保持原文本行. 视频/音频依赖 attachments GET
    //   路由返回 Content-Disposition: inline, 否则浏览器会触发下载而不是内联播放.
    const isImage = a.media_type.startsWith("image/");
    const isVideo = a.media_type.startsWith("video/");
    const isAudio = a.media_type.startsWith("audio/");
    return (
      <div className="flex justify-center my-1">
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 max-w-[560px] text-xs text-gray-600">
          <div className="flex items-center gap-2">
            <span className="text-base shrink-0" aria-hidden>
              {isImage ? "🖼️" : isVideo ? "🎬" : isAudio ? "🎵" : "📄"}
            </span>
            <div className="min-w-0 flex-1">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="block truncate hover:underline text-gray-700"
                title={a.filename}
              >
                {a.filename}
              </a>
              <span className="text-gray-400">{formatSize(a.size_bytes)}</span>
            </div>
          </div>
          {/* Inline media preview. 大图 max-h 480 防撑爆布局; video 不 autoplay;
              全部走 /api/attachments/[id] (owner-gated GET, 已守住跨租户隔离). */}
          {isImage && (
            <a href={url} target="_blank" rel="noreferrer" className="block mt-2">
              <img
                src={url}
                alt={a.filename}
                loading="lazy"
                className="max-w-full max-h-[480px] object-contain rounded bg-gray-100 mx-auto"
              />
            </a>
          )}
          {isVideo && (
            <video
              controls
              preload="metadata"
              src={url}
              className="max-w-full max-h-[480px] rounded bg-gray-100 mt-2 mx-auto block"
            />
          )}
          {isAudio && (
            <audio controls preload="metadata" src={url} className="w-full mt-2" />
          )}
          {/* 非媒体保持原文本行观感, 不渲染下方预览区. */}
        </div>
      </div>
    );
  }
  // R121 P3: 相邻 attachment 合并为 grid 渲染. 与 attachment 单条分支并行, 不互斥.
  if (msg.type === "attachment_group" && msg.attachments && msg.attachments.length >= 2) {
    const items = msg.attachments;
    return (
      <div className="flex justify-center my-1">
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 max-w-[480px]">
          <div className="text-xs text-gray-500 mb-1.5 flex items-center gap-1">
            <span>📎</span>
            <span>{items.length} 个附件</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {items.map((a) => {
              const url = `/api/attachments/${a.id}`;
              const isImage = a.media_type.startsWith("image/");
              return (
                <a
                  key={a.id}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block bg-white border border-gray-200 rounded p-1 hover:border-blue-400 transition-colors"
                  title={a.filename}
                >
                  {isImage ? (
                    <img src={url} alt={a.filename} className="w-full h-16 object-cover rounded" />
                  ) : (
                    <div className="w-full h-16 flex items-center justify-center text-2xl bg-gray-100 rounded">
                      📄
                    </div>
                  )}
                  <div className="text-[10px] text-gray-600 truncate mt-0.5">{a.filename}</div>
                </a>
              );
            })}
          </div>
        </div>
      </div>
    );
  }
  if (msg.type === "user") {
    // R55 B1: render different icon/label based on who sent the message.
    // user = 👤 你 (default for backwards compat when sender_type missing),
    // script = 🤖 脚本, system = ⚙️ 系统. The badge text only differs for
    // script/system so existing UI screenshots remain stable for 👤 cases.
    const senderBadge = (() => {
      switch (msg.sender_type) {
        case "script": return { icon: "🤖", label: "脚本", cls: "text-orange-500" };
        case "system": return { icon: "⚙️", label: "系统", cls: "text-purple-500" };
        default:       return { icon: "👤", label: "你",   cls: "text-gray-500" };
      }
    })();
    return (
      <>
        {needsSeparator && <div className="border-t border-gray-200 my-2 w-full" />}
        {isForkBoundary && <ForkBoundary parentTask={parentTask} />}
        <div className="bg-gray-100 rounded-lg p-3 text-sm text-gray-700 w-[90%] max-w-[90%] relative">
          <div className="flex items-center justify-between mb-1">
            <span className={`${senderBadge.cls} text-xs`}>{senderBadge.icon} {senderBadge.label}</span>
            {tsLabel && <span className="text-gray-400 text-xs">{tsLabel}</span>}
          </div>
          <div
            className="whitespace-pre-wrap"
            dangerouslySetInnerHTML={{ __html: highlightHtml(linkifyTaskPrefixes(linkifyDocPaths(escapeHtml(msg.text || ""), projectId, versionId, wikiProjects)), q) }}
          />
        </div>
      </>
    );
  }
  if (msg.type === "assistant") {
    const html = useMemo(() => {
      const md = markdownToHtml(msg.text || "", projectId, versionId);
      return highlightHtml(linkifyTaskPrefixes(linkifyDocPaths(md, projectId, versionId, wikiProjects)), q);
    }, [msg.text, q, projectId, versionId]);
    return (
      <>
        {needsSeparator && <div className="border-t border-gray-200 my-2 w-full" />}
        {isForkBoundary && <ForkBoundary parentTask={parentTask} />}
        <div className="group bg-blue-50 rounded-lg p-3 text-sm text-gray-700 w-[90%] max-w-[90%] relative">
          <div className="flex items-center justify-between mb-1">
            <span className="text-blue-500 text-xs">🤖</span>
            <span className="flex items-center gap-2">
              {/* Hover-only fork entry. Anchored at this SDK message's uuid so
                  the new session inherits history up to and including it.
                  Only assistant messages carry a real transcript uuid —
                  tool_use cards store the tool_use block id instead, and
                  locally-appended user messages have none, both of which the
                  fork API rejects as "not found in parent session". */}
              {onForkFromMessage && msg.uuid && (
                <button
                  onClick={() => onForkFromMessage(msg.uuid!)}
                  title="从这条消息 fork：新任务继承到此为止的历史"
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-xs px-1.5 py-0.5 rounded border border-blue-200 bg-white text-blue-600 hover:bg-blue-100"
                >
                  ⑂ fork
                </button>
              )}
              {tsLabel && <span className="text-gray-400 text-xs">{tsLabel}</span>}
            </span>
          </div>
          <div
            className="prose-sm max-w-none break-words [&_pre]:bg-gray-900 [&_pre]:text-gray-100 [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre]:text-xs [&_code]:bg-blue-100 [&_code]:text-blue-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:text-inherit [&_pre_code]:p-0 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1 [&_li]:my-0.5 [&_mark]:bg-yellow-200 [&_mark]:rounded [&_mark]:px-0.5"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </>
    );
  }
  if (msg.type === "tool_use") {
    const summary = toolCallSummary(msg.toolName, msg.toolInput);
    const toolInputJson = msg.toolInput ? JSON.stringify(msg.toolInput, null, 2) : "";
    const collapsed = msg.collapsed !== false; // default collapsed

    // 三模式统一用同一套可点击 toggle UI: expanded 进入时一次性 setMessages
    // 把全部 collapsed 置 false (见上面 useEffect), 用户单条点击会回到 messages
    // 状态; text-only 模式 tool_use 被 filteredMessages 直接过滤掉, 不会到这里.
    return (
      <>
        {needsSeparator && <div className="border-t border-gray-200 my-2 w-full" />}
        {isForkBoundary && <ForkBoundary parentTask={parentTask} />}
        <div className="bg-amber-50 border border-amber-200 rounded-lg text-sm max-w-[90%] w-[90%]">
          <button
            onClick={onToggle}
            className="w-full text-left p-2.5 flex items-center gap-2 hover:bg-amber-100 rounded-lg"
          >
            <span className="text-amber-500 text-xs">{collapsed ? "▶" : "▼"}</span>
            <span aria-hidden="true" className="text-base leading-none">{toolIcon(msg.toolName)}</span>
            <span
              className="text-amber-700 font-medium shrink-0"
              dangerouslySetInnerHTML={{ __html: highlightText(msg.toolName || "", q) }}
            />
            {collapsed && (
              <span
                className="text-xs text-gray-500 truncate min-w-0 flex-1"
                dangerouslySetInnerHTML={{ __html: highlightText(summary.replace(/^[A-Za-z]+: /, ""), q) }}
              />
            )}
            <span className="ml-auto flex items-center gap-2 shrink-0">
              {!collapsed && <span className="text-xs text-gray-400">点击折叠</span>}
              {tsLabel && <span className="text-gray-400 text-xs">{tsLabel}</span>}
            </span>
          </button>
          {!collapsed && msg.toolInput && (
            <div className="px-3 pb-2.5">
              <pre
                className="text-xs text-gray-600 overflow-x-auto bg-white rounded p-2 whitespace-pre-wrap break-words"
                dangerouslySetInnerHTML={{ __html: highlightHtml(toolInputJson, q) }}
              />
            </div>
          )}
        </div>
      </>
    );
  }
  if (msg.type === "tool_result") {
    const isExpanded = displayMode === "expanded";
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 text-sm max-w-[90%] w-[90%]">
        <div className="flex items-center justify-between">
          <div className="text-green-700 font-medium text-xs">✅ {msg.toolName}</div>
          {tsLabel && <span className="text-gray-400 text-xs">{tsLabel}</span>}
        </div>
        {msg.result && (
          <pre className={`text-xs text-gray-600 overflow-x-auto mt-1 ${isExpanded ? "whitespace-pre-wrap break-words" : "max-h-32"}`}>
            {!isExpanded && msg.result.length > 500 ? msg.result.slice(0, 500) + "..." : msg.result}
          </pre>
        )}
      </div>
    );
  }
  return null;
}


function ForkFormModal({
  taskId,
  form,
  onChange,
  onClose,
}: {
  taskId: string;
  form: {
    mode: "head" | "checkpoint" | "message";
    checkpointId?: number;
    upToMessageId?: string;
    title: string;
    prompt: string;
    newCwd: string;
    maxTurns: string;
    autoApprove: "inherit" | "on" | "off";
    compactFirst: boolean;
  };
  onChange: (next: typeof form) => void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Files staged to be uploaded alongside the fork. Path-into-prompt injection
  // happens server-side, so the client just hands the files over in
  // multipart/form-data.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function pickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
  }

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const atCheckpoint = form.mode === "checkpoint" && form.checkpointId !== undefined;
      const url = atCheckpoint
        ? `/api/tasks/${taskId}/fork-at-checkpoint`
        : `/api/tasks/${taskId}/fork`;
      const meta = {
        title: form.title || undefined,
        prompt: form.prompt || undefined,
        newCwd: form.newCwd || undefined,
        maxTurns: form.maxTurns ? parseInt(form.maxTurns) : undefined,
        autoApprove: form.autoApprove === "on" ? true : form.autoApprove === "off" ? false : undefined,
        compactFirst: form.compactFirst || undefined,
        ...(atCheckpoint ? { checkpoint_id: form.checkpointId } : {}),
        // mode="message": anchor the fork at this transcript message. Omitted
        // for mode="head" so the API forks at the session's end.
        ...(form.mode === "message" && form.upToMessageId
          ? { upToMessageId: form.upToMessageId }
          : {}),
      };

      let res: Response;
      if (pendingFiles.length === 0) {
        // No files — keep the old JSON path so existing tooling / curl
        // scripts that hit /fork with `Content-Type: application/json` keep
        // working byte-for-byte.
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(meta),
        });
      } else {
        // Files present — switch to multipart. `meta` is the JSON payload;
        // each staged file is sent as a `file` field.
        const fd = new FormData();
        fd.append("meta", JSON.stringify(meta));
        for (const f of pendingFiles) fd.append("file", f);
        res = await fetch(url, { method: "POST", body: fd });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.new_task_id) {
        window.location.href = `/tasks/${data.new_task_id}`;
      } else {
        onClose();
      }
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[480px] max-w-[92vw] p-5">
        <div className="flex items-center mb-3">
          <h3 className="text-base font-semibold text-gray-800">
            {form.mode === "checkpoint"
              ? "🧷 Fork from checkpoint"
              : form.mode === "message"
                ? "⑂ Fork from message"
                : "📋 Fork session"}
          </h3>
          <button
            onClick={onClose}
            className="ml-auto text-gray-400 hover:text-gray-700"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div className="text-xs text-gray-500 mb-3">
          {form.mode === "checkpoint"
            ? `将从 checkpoint step ${(form as any).checkpointId} 处 fork，创建独立的新 SDK session 和任务。`
            : form.mode === "message"
              ? `将从选中的这条消息处 fork（消息 ${(form.upToMessageId || "").slice(0, 8)}…），新 session 只继承到此为止的历史。`
              : "将从任务当前 SDK session 的末尾 fork，创建独立的新任务。"}
        </div>

        <label className="block text-xs text-gray-600 mb-1">新任务标题（可选）</label>
        <input
          type="text"
          value={form.title}
          onChange={(e) => onChange({ ...form, title: e.target.value })}
          placeholder="留空使用默认标题"
          className="w-full border rounded px-2 py-1.5 text-sm mb-3"
        />

        <label className="block text-xs text-gray-600 mb-1">首个 prompt（可选）</label>
        <textarea
          value={form.prompt}
          onChange={(e) => onChange({ ...form, prompt: e.target.value })}
          placeholder="留空使用默认提示"
          rows={3}
          className="w-full border rounded px-2 py-1.5 text-sm mb-3"
        />

        <label className="block text-xs text-gray-600 mb-1">新 cwd（可选）</label>
        <input
          type="text"
          value={form.newCwd}
          onChange={(e) => onChange({ ...form, newCwd: e.target.value })}
          placeholder="留空继承父任务 cwd"
          className="w-full border rounded px-2 py-1.5 text-sm mb-3 font-mono"
        />

        <label className="block text-xs text-gray-600 mb-1">最大轮次（可选）</label>
        <input
          type="number"
          value={form.maxTurns}
          onChange={(e) => onChange({ ...form, maxTurns: e.target.value })}
          placeholder="留空继承父任务设置（默认 200）"
          min="1"
          className="w-full border rounded px-2 py-1.5 text-sm mb-3"
        />

        <label className="block text-xs text-gray-600 mb-1">工具审核</label>
        <Select
          value={form.autoApprove}
          onChange={(v) => onChange({ ...form, autoApprove: v as "inherit" | "on" | "off" })}
          options={[
            { value: "inherit", label: "继承父任务设置" },
            { value: "on", label: "自动通过（不审核）" },
            { value: "off", label: "需要逐个审核" },
          ]}
          className="mb-3"
        />

        <label className="flex items-start gap-2 text-xs text-gray-600 mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.compactFirst}
            onChange={(e) => onChange({ ...form, compactFirst: e.target.checked })}
            className="mt-0.5 rounded"
          />
          <span>
            压缩后继续（/compact）
            <span className="block text-gray-400">fork 后首个动作压缩历史上下文为摘要，腾出空间再承接后续工作。会额外调用模型做摘要（有成本+时间），且压缩有损；仅在父任务上下文较大、需继续工作时使用，不必每次勾选。</span>
          </span>
        </label>

        {/* 附件: 与聊天输入框相同的 staging 模式, fork 后这些文件会作为新任务的初始附件.
            路径会进 prompt, agent 首条消息就能看到. */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-gray-600">附件（可选，单文件 ≤ 10MB）</label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              📎 添加
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
            />
          </div>
          {pendingFiles.length > 0 && (
            <ul className="space-y-1 mb-1">
              {pendingFiles.map((f, i) => (
                <li key={i} className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                  <span className="truncate">{f.name} <span className="text-gray-400">({formatSize(f.size)})</span></span>
                  <button
                    type="button"
                    onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-gray-400 hover:text-red-500 ml-2"
                    title="移除"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {submitError && (
          <div className="text-xs text-red-600 mb-2">⚠ {submitError}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
            disabled={submitting}
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:bg-emerald-400"
          >
            {submitting ? "Forking..." : "确认 Fork"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Resume options modal - opened from the 暂停态 "恢复执行" button. Lets the
// operator flip auto_approve / max_turns before resuming. Pause/resume rebuilds
// the ActiveSession (interrupt + new query()), and the scheduler re-reads the
// task from DB before running, so PATCHed values take effect on resume.
function ResumeModal({
  taskId,
  task,
  onClose,
  onResumed,
}: {
  taskId: string;
  task: { auto_approve: number; max_turns: number | null };
  onClose: () => void;
  onResumed: (status: string) => void;
}) {
  const [autoApprove, setAutoApprove] = useState<"on" | "off">(
    task?.auto_approve === 1 ? "on" : "off",
  );
  const [maxTurns, setMaxTurns] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // PATCH first so the new auto_approve / max_turns are in DB before the
      // scheduler re-reads the task on resume.
      const patchBody: Record<string, unknown> = {
        auto_approve: autoApprove === "on",
      };
      if (maxTurns) {
        const n = parseInt(maxTurns);
        if (!Number.isNaN(n)) patchBody.max_turns = n;
      }
      const patchRes = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!patchRes.ok) {
        const d = await patchRes.json();
        throw new Error(d.error || `PATCH HTTP ${patchRes.status}`);
      }
      const resRes = await fetch(`/api/tasks/${taskId}/resume`, { method: "POST" });
      const data = await resRes.json();
      if (!resRes.ok) throw new Error(data.error || `HTTP ${resRes.status}`);
      onResumed(data.status || "running");
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-[480px] max-w-[92vw] p-5">
        <div className="flex items-center mb-3">
          <h3 className="text-base font-semibold text-gray-800">▶ 恢复执行</h3>
          <button
            onClick={onClose}
            className="ml-auto text-gray-400 hover:text-gray-700"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div className="text-xs text-gray-500 mb-3">
          恢复前可调整工具审核策略与最大轮次，恢复后对新 session 生效。
        </div>

        <label className="block text-xs text-gray-600 mb-1">工具审核</label>
        <Select
          value={autoApprove}
          onChange={(v) => setAutoApprove(v as "on" | "off")}
          options={[
            { value: "off", label: "需要逐个审核" },
            { value: "on", label: "自动通过（不审核）" },
          ]}
        />

        <label className="block text-xs text-gray-600 mb-1">最大轮次（可选）</label>
        <input
          type="number"
          value={maxTurns}
          onChange={(e) => setMaxTurns(e.target.value)}
          placeholder={task?.max_turns ? `留空保持当前设置（${task?.max_turns}）` : "留空保持当前设置"}
          min="1"
          className="w-full border rounded px-2 py-1.5 text-sm mb-3"
        />

        {submitError && (
          <div className="text-xs text-red-600 mb-2">⚠ {submitError}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
            disabled={submitting}
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-blue-400"
          >
            {submitting ? "恢复中..." : "确认恢复"}
          </button>
        </div>
      </div>
    </div>
  );
}

