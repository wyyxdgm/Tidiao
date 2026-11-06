// Shared constants across the app

import path from "path";
import os from "os";

export const STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  reviewing: "待审核",
  // 🆕 DAG P3 (B4 拍板 2026-09-05): 机械验收门瞬态 (与 right-dock.tsx 同源).
  //   P3 已加 verifying 进 ALL_STATUSES, 但 P4 才补右坞视觉; board 筛选条
  //   (board-client.tsx:1195) 读 STATUS_LABELS, 漏注册 → 显示空文字标签.
  verifying: "验收中",
  // 🆕 R131 (damo 2026-09-15): 等用户介入/拍板/派发/建议.
  await_user: "等用户介入",
  completed: "已完成",
  failed: "失败",
  // ⚠️ 历史兼容: 老 task 可能仍是 rejected 状态 (单人系统前遗留).
  // 🆕 2026-09-15 R后续 damo 拍板: UI 统一显示「等待中」, 跟 await_user 的「等用户介入」区分
  //   (历史 vs 新流程的视觉差).
  rejected: "等待中",
  cancelled: "已取消",
};

export const STATUS_DOT: Record<string, string> = {
  pending: "bg-gray-400",
  queued: "bg-blue-400",
  running: "bg-sky-400 animate-pulse",
  paused: "bg-yellow-400",
  reviewing: "bg-purple-400",
  // 🆕 DAG P3 收尾 (2026-09-21): verifying 用 paused 同色族 — 语义上都是「
  //   进行中但被流程卡住, 等某个外部信号」 (人审/机器验收). 与 right-dock.tsx
  //   STATUS_DOT 表 (L269-272) 保持一致.
  verifying: "bg-yellow-400",
  await_user: "bg-amber-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  rejected: "bg-orange-300",
  cancelled: "bg-gray-300",
};

export const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  queued: "bg-blue-100 text-blue-700",
  running: "bg-sky-100 text-sky-700",
  paused: "bg-yellow-100 text-yellow-700",
  reviewing: "bg-purple-100 text-purple-700",
  // 🆕 DAG P3 收尾 (2026-09-21): verifying 同 paused 色族, 视觉区分于
  //   reviewing (紫) / running (绿), 与 STATUS_DOT 配套.
  verifying: "bg-yellow-100 text-yellow-700",
  await_user: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  rejected: "bg-orange-50 text-orange-600",
  cancelled: "bg-gray-100 text-gray-500",
};

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_OPTIONS = [
  { value: "", label: "系统默认（环境变量 ANTHROPIC_MODEL）" },
  { value: "astron-code-latest", label: "Astron-Code-Latest (讯飞)" },
  { value: "glm-5.2", label: "GLM-5.2" },
  { value: "glm-latest", label: "GLM-Latest" },
  { value: "MiniMax-M3", label: "MiniMax-M3" },
  { value: "MiniMax-M2.7", label: "MiniMax-M2.7" },
  { value: "doubao-seed-2.1-turbo", label: "Doubao-Seed-2.1-Turbo" },
  { value: "doubao-seed-2.0-pro", label: "Doubao-Seed-2.0-Pro" },
  { value: "doubao-seed-2.0-lite", label: "Doubao-Seed-2.0-Lite" },
] as const;

// All built-in tools exposed to the agent. The runtime's canUseTool enforces
// this set: a tool in here that isn't in a task's configured list is denied,
// so the UI selection / presets are actually restrictive (not advisory).
export const ALL_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "NotebookEdit"] as const;

// Default selection = 全开 (permissive). Quick-mode tasks send no allowed_tools
// and the runtime falls back to this full set.
export const DEFAULT_TOOLS: string[] = [...ALL_TOOLS];
export const AVAILABLE_TOOLS: string[] = [...ALL_TOOLS];

// Quick-switch presets for the tool selector. Each is a coherent capability set.
// 计划/探索 exclude Bash deliberately: Bash can write files (echo >, sed -i),
// so a "no Write" preset that keeps Bash is bypassable -- dropping Bash closes it.
// 只读探索工具集. 独立具名导出是因为它不只给 UI preset 用: 外部输入驱动的
// 通道（企微 intake）必须显式传这组工具, 否则 createTask 落到 DEFAULT_TOOLS
// (= 全开, 含 Bash/Write/Edit). 两处共用同一个数组, 改一处不会漂移.
export const EXPLORE_TOOLS: string[] = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"];

export const TOOL_PRESETS: { key: string; label: string; tools: string[] }[] = [
  { key: "full", label: "全开", tools: [...ALL_TOOLS] },
  { key: "plan", label: "计划", tools: ["Read", "Glob", "Grep", "Agent"] },
  { key: "explore", label: "探索", tools: EXPLORE_TOOLS },
  { key: "local", label: "本地", tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "NotebookEdit"] },
];

// 🆕 R131: await_user 加入 ALL_STATUSES (damo 2026-09-15).
export const ALL_STATUSES = ["pending", "queued", "running", "paused", "reviewing", "verifying", "await_user", "completed", "failed", "rejected", "cancelled"] as const;

// 🆕 DAG P3 收尾 (2026-09-21): verifying 的 UI 可见性. 后端由 L1 平台级
//   master switch (app_settings.verification_globally_enabled) 控制 — 关 = 永不
//   进入 verifying 转换 (byte-identical 行为, B5 拍板). 客户端 UI 配套: 开关关
//   时**不渲染** verifying 按钮 (筛选条/列定义/默认选中), 避免「永远不会被点
//   的按钮」误导用户. 反向也成立: 开关开 → 按钮出现, 跟后端同步.
//   关注点:
//     - 后端数据保护是另一道闸 (agent-runtime.ts:1359 拦截, 开关关 = 不进状态机),
//       本函数只是 UI 配套; 不依赖本函数保证正确性, 仅保证视觉一致.
//     - 调用方统一: server entry (page.tsx) 读 resolveVerificationGloballyEnabled()
//       → 把布尔值作为 prop 传入 client → client 调本函数. 不在 client 单独 fetch /api/config.
export function getVisibleStatuses(globallyEnabled: boolean): readonly string[] {
  if (globallyEnabled) return ALL_STATUSES;
  return ALL_STATUSES.filter((s) => s !== "verifying");
}

// 看板分流用: active = 用户实际盯着的「在飞」状态. 复用为客户端 Set 判断事件去向.
// ⚠️ 与 src/lib/db/tasks.ts 的 ACTIVE_STATUSES 是同一份, 必须保持同步 — UI 端
// 不能 import @/lib/db/tasks (会拉进 better-sqlite3), 所以这份放在 constants.ts
// 共享. 任一处改动都连带改另一处.
//   🆕 DAG P3: verifying 加入 — 机械验收门跑命令的瞬态 (B4 拍板 2026-09-05).
//   视为 active (与 running 等价), 用户看得见, 调度器视为在飞不卡闸门.
//   🆕 R131 (damo 2026-09-15): await_user 加入 — 等用户介入/拍板/派发/建议.
//   与 running 等价「在飞」, agent 已停下, 等用户输入, 但调度器仍视为未结束.
export const BOARD_ACTIVE_STATUSES = ["pending", "queued", "running", "paused", "reviewing", "verifying", "await_user"] as const;
export const BOARD_TERMINAL_STATUSES = ["completed", "failed", "rejected", "cancelled"] as const;

// Built-in tag for soft-deleted tasks. Added to tags on delete, removed on restore.
export const DELETED_TAG = "已删除";

// R105: 任务卡片是否允许显示删除按钮. 三处 UI (task-detail / board-client
//   / kanban-view) 共用同一份判断, 收敛在常量层避免一处改三处忘.
//   护栏: running 中的 task 不能删 (会中断 agent session, 跟其他状态动作按钮对齐:
//   running 时一律禁写). 已软删的也不再显示 (走恢复流程).
//   queued / pending / paused / reviewing / verifying / 终态 全部允许.
export function canDeleteTask(status: string | null | undefined, deletedAt: string | null | undefined): boolean {
  if (deletedAt) return false;
  if (status === "running") return false;
  return true;
}

export const TASK_TYPES = ["design", "dev", "test", "deploy"] as const;
export type TaskTypeValue = (typeof TASK_TYPES)[number];

export const TYPE_LABELS: Record<string, string> = {
  design: "设计",
  dev: "开发",
  test: "测试",
  deploy: "部署",
};

export const TYPE_COLORS: Record<string, string> = {
  design: "bg-pink-100 text-pink-700 border-pink-300",
  dev: "bg-blue-100 text-blue-700 border-blue-300",
  test: "bg-violet-100 text-violet-700 border-violet-300",
  deploy: "bg-emerald-100 text-emerald-700 border-emerald-300",
};

// Kanban board column definitions — one column per status.
// Used as default column order; actual visible columns and order are
// managed by useBoardConfig and persisted in localStorage.

// Valid drag transitions between statuses (source → set of target statuses).
// Keyed by the source status; value is the set of valid target statuses
// a task can be dragged to.
//   🆕 DAG P3 (B4 拍板 2026-09-05): 加 verifying 转换.
//   - paused → verifying (人工 review 走 approveTask, paused 走 resume + approve)
//   - reviewing → verifying (主路径: approveTask 拦截后翻 verifying 再跑命令)
//   - verifying → completed (验收成功)
//   - verifying → running (验收失败回退, agent 自己改)
//   - verifying → failed (重试耗尽, B3 = 2 retries)
//   - verifying → cancelled (用户取消, 跟其它 active 状态同口径)
//   paused → verifying 由人触发, 与 paused → running 然后再 verifying 等价, 但
//   保留这个直接转换让拖拽 UI 不挡 (P4 UI 阶段会用到).
//   🆕 2026-09-20: paused → completed 走 approve — 服务端 approveTask 早支持
//   paused (agent-runtime.ts line 1323), 前端白名单漏了导致看板把 paused 任务
//   拖到「已完成」列时静默 noop (handleColDrop 直接 return, 连 toast 都没有).
//   用例: 用户主动决定"这个 paused 任务结果可用, 视作完成", 跳过 resume + 跑完
//   + review 三段式. 已 completed 可再 start 回 running (R161 双向), 误操作可逆.
//   🆕 R131 (damo 2026-09-15): 加 await_user 转换. running ⇄ await_user 双向;
//   await_user → completed (approve 自动 unwait) / running (unawait 显式) /
//   cancelled / paused (走 message 路径, 跟其它 active 状态同口径).
//   reviewing → rejected 不再允许 (reject 端点删除, 历史 rejected 仍可 start).
//   🆕 R162 (damo 2026-09-22): queued → pending — 看板允许把排队中的任务拖回
//     「待执行」列 (走新加的 dequeue action). 用例: 用户改变了主意, 想让该 task
//     不要随槽位空闲自动跑 (跟取消不同 — 任务还在, 后续手动再 start 即可).
//     后端 dequeueTask 与 cancelTask 并列, 不删 session_id, 仅从 scheduler.queue
//     摘除 + 翻 status. 与 R155 server_restart 恢复路径同源, 但 source 字段标
//     "manual_dequeue" 区分.
export const VALID_STATUS_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["queued", "running", "cancelled"]),
  queued: new Set(["running", "cancelled", "pending"]),
  running: new Set(["paused", "await_user", "cancelled"]),
  paused: new Set(["running", "verifying", "completed", "cancelled"]),
  reviewing: new Set(["completed", "running", "verifying"]),
  verifying: new Set(["completed", "running", "failed", "cancelled"]),
  await_user: new Set(["running", "completed", "cancelled"]),
  completed: new Set(["running"]),
  failed: new Set(["running"]),
  rejected: new Set(["running", "completed"]),
  cancelled: new Set(["running"]),
};

// Determine the API action when a task is dragged from sourceStatus to targetStatus.
// Only maps to existing API endpoints (start, pause, cancel, approve, refine,
// await, unawait, resume, dequeue).
//   🆕 R131: reject 子命令移除; 新增 refine / await / unawait.
//   🆕 R162: 新增 dequeue (queued → pending).
export function getStatusDragAction(sourceStatus: string, targetStatus: string): string | null {
  const map: Record<string, Record<string, string>> = {
    pending: { running: "start", queued: "start", cancelled: "cancel" },
    queued: { running: "start", cancelled: "cancel", pending: "dequeue" },
    running: { paused: "pause", await_user: "await", cancelled: "cancel" },
    paused: { running: "resume", completed: "approve", cancelled: "cancel" },
    reviewing: { completed: "approve", running: "refine" },
    await_user: { running: "unawait", completed: "approve", cancelled: "cancel" },
    completed: { running: "start" },
    failed: { running: "start" },
    rejected: { running: "start", completed: "approve" },
    cancelled: { running: "start" },
  };
  return map[sourceStatus]?.[targetStatus] ?? null;
}

// Legacy kanban column definitions (kept for backward compat with KANBAN_COLUMNS
// references that may exist). New code should use the per-status approach above.
//   🆕 R131 (damo 2026-09-15): await_user 列加入.
export const KANBAN_COLUMNS = [
  { key: "pending", statuses: ["pending", "queued"], label: "待执行" },
  { key: "running", statuses: ["running"], label: "运行中" },
  { key: "paused", statuses: ["paused"], label: "暂停" },
  { key: "reviewing", statuses: ["reviewing"], label: "待审核" },
  { key: "await_user", statuses: ["await_user"], label: "等用户" },
  { key: "rejected", statuses: ["rejected"], label: "驳回(历史)" },
  { key: "done", statuses: ["completed", "failed", "cancelled"], label: "结束" },
] as const;

// Legacy drag transitions (column-key based). New code should use
// VALID_STATUS_TRANSITIONS and getStatusDragAction instead.
export const VALID_DRAG_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["running", "done"]),
  running: new Set(["paused", "done"]),
  paused: new Set(["running", "done"]),
  reviewing: new Set([]),
  await_user: new Set([]),
  rejected: new Set(["running"]),
  done: new Set([]),
};

// Legacy: determine the API action when a task is dragged from sourceCol to targetCol.
export function getDragAction(sourceColKey: string, targetColKey: string): string | null {
  const map: Record<string, Record<string, string>> = {
    pending: { running: "start", done: "cancel" },
    running: { paused: "pause", done: "cancel" },
    paused: { running: "start", done: "cancel" },
    rejected: { running: "start" },
  };
  return map[sourceColKey]?.[targetColKey] ?? null;
}

/** Safely parse JSON, returning fallback on error */
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Centralized home directory for orchestrator data (db, workspaces, claude config).
// Overridable via ORCHESTRATOR_HOME so alternate deploys (e.g. this multi-tenant
// dev copy) can isolate from the default ~/.agent-orchestrator without touching
// every call site. Falls back to ~/.agent-orchestrator to preserve existing behavior.
export const ORCHESTRATOR_HOME = process.env.ORCHESTRATOR_HOME || path.join(os.homedir(), ".agent-orchestrator");

// CLAUDE_CONFIG_DIR for the SDK subprocess — isolated from user's global ~/.claude. See agent-sdk-standards.md §6.
export const CLAUDE_CONFIG_DIR = path.join(ORCHESTRATOR_HOME, "claude-config");
