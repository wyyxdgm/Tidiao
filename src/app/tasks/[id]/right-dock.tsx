"use client";

// Right dock — vertical stack of 4 panels (always present):
//   - "details"      (former TaskSidebar contents, now split into 4 sub-blocks)
//   - "timeline"     (TaskTimeline)
//   - "checkpoints"  (CheckpointsPanel)
//   - "commits"      (CommitsChainPanel)
//
// Each panel can be collapsed (header-only row) or expanded (header + body).
//
// R35 (2026-08-28) — accordion mode: at any time AT MOST ONE panel is
// expanded. Activating a collapsed panel auto-collapses whatever was
// expanded and gives the new one the full dock interior height (minus the
// three sibling headers). Replaces the prior "drag-resize between any two
// expanded panels" UI which R35 explicitly retired. Drag handles are kept
// in the DOM (no rendering changes for handlers / state) but only render
// between two adjacent expanded panels — in practice that never happens
// under accordion, so they're invisible in steady state.
//
// R37 (2026-08-28) — 任务详情内容区只占 ~50px 修复. R36 试图靠 RAF +
// ResizeObserver 兜底修, 但根因没找到: clientHeight=0 时 use-dock-state 的
// redistribute 把 height clamp 到 MIN_H=120, dock 撑开但 React state 卡住.
// R37 直接抛弃整条 height map / normalize 算法, 改用纯 CSS flex: 折叠的
// panel `shrink-0` (header 自然高度), 展开的 panel `flex-1 + min-h-0`
// 自动撑满 dock 剩余高度, 零 JS. 副作用: drag-resize "相邻两展开面板
// 重分" 不可用了 — 这条路径 R35 已经废 (accordion 一次只一个), 实际不损.
//
// R36 (2026-08-28) — 任务详情内容区只占 ~50px. 根因没找到, R37 重写覆盖.
//
// All state (collapsed flags + per-panel heights) is owned by the parent
// via the useDockState hook. This component is purely presentational w.r.t.
// dock state.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { DockPanelId } from "@/lib/hooks/use-dock-state";
import { DOCK_ORDER } from "@/lib/hooks/use-dock-state";
import { copyToClipboard } from "@/lib/clipboard";
import { parseDbTime } from "@/lib/datetime";
import { parseStrArray } from "@/lib/json-array";
import { getStatusDisplay } from "@/lib/checkpoints/status-display";

// ---------- Copy link button ----------

function CopyLinkButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const url = `${window.location.origin}/#/tasks/${id}`;
    copyToClipboard(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [id]);
  return (
    <button
      onClick={handleCopy}
      className="text-gray-400 hover:text-gray-600 transition-colors p-0.5 shrink-0"
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
  );
}

// ---------- Shared types ----------

export type TaskForDock = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  model: string | null;
  cwd: string | null;
  allowed_tools: string | null;
  tags: string | null;
  project_id: string | null;
  version_id: string | null;
  session_id: string | null;
  result: string | null;
  error: string | null;
  preflight_result: string | null;
  // R78 W3 §4.2: 关联需求点 (v64 起的 tasks.requirement_id FK). null = 没挂需求点.
  requirement_id: string | null;
  // R113 (2026-09-07): 起始/结束时的 git HEAD snapshot. Commits Chain 面板在
  //   agent 未声明任何 <git/> marker 时, 用 base→head 区间提示用户「这个
  //   task 改了哪些 commit 但 agent 没记录」.
  base_commit: string | null;
  head_commit: string | null;
};

type DepTask = { id: string; title: string; status: string };
type DispatchedTask = DepTask & { project_id: string | null };

// R78 W3 §4.2: 需求点关联面板的最小数据. status 6 态走 service-side 渲染 (不
// 重复 STATUS_LABEL, 这里只拿到原始 enum).
export type RequirementLink = {
  id: string;
  title: string;
  status: string;
};

export interface RightDockProps {
  task: TaskForDock;
  dependsOnTasks: DepTask[];
  dependentTasks: DepTask[];
  parentTask: DepTask | null;
  dispatcherTask: DepTask | null;
  dispatchedTasks: DispatchedTask[];

  // R78 W3 §4.2: 需求点关联面板 -- null = 该 task 未挂需求点, 不渲染此面板.
  requirementLink: RequirementLink | null;
  // 森林 siblings (同一 requirement 下其他 task, 不含本 task), 最多 5 条.
  // 也可为空 (只有本 task 是 requirement 下唯一 task).
  requirementSiblings: DepTask[];

  taskId: string;
  sessionIdAvailable: boolean;
  onForkFromCheckpoint: (checkpointId: number) => void;

  refreshKeys: {
    timeline: number;
    checkpoints: number;
    commits: number;
  };

  heights: Record<DockPanelId, number>;
  collapsed: Record<DockPanelId, boolean>;
  setHeightPair: (p: DockPanelId, delta: number) => void;
  normalizeHeights: (totalHeight: number) => void;
  toggleCollapsed: (p: DockPanelId, opts?: { availableHeight?: number }) => void;
  setCollapsed: (p: DockPanelId, v: boolean) => void;
  dockWidth: number;
  onClose?: () => void;
}

const PANEL_META: Record<DockPanelId, { icon: string; label: string }> = {
  details: { icon: "🗂", label: "详情" },
  timeline: { icon: "🕒", label: "时间线" },
  checkpoints: { icon: "🧷", label: "Checkpoints" },
  commits: { icon: "🔗", label: "Commits" },
};

// ---------- Main dock container ----------

export default function RightDock(props: RightDockProps) {
  const { collapsed, dockWidth, onClose } = props;

  // R37 重写: 抛弃 height map + ResizeObserver + normalize 整套算法, 改用
  // 纯 CSS flex 布局让展开的 panel 自动占满剩余空间. 折叠的 panel 用 shrink-0
  // 让它自然高度 (header only);展开的 panel 用 flex-1 + min-h-0 自填剩余
  // 高度. 消除了之前的状态时序问题 (clientHeight=0 时 normalizeHeights 把
  // height clamp 到 MIN_H=120, dock 撑开后不再 fire → 永远卡在小高度).
  //
  // R35 之前还保留 per-panel height map 是为了支持 drag-resize "相邻两
  // 展开面板拖拽重分", R35 已经把这个功能废了 ("一次只一个激活"), 所以
  // use-dock-state 里的 height map + setHeightPair + normalizeHeights 现在
  // 是死代码. props 暂留着 (外部仍是同一个 hook, 类型不变), body 不用.

  return (
    <div
      className="flex flex-col shrink-0 h-full border-l border-gray-200 w-full md:w-auto"
      style={{ width: dockWidth }}
    >
      {/* Dock header with close button */}
      {onClose && (
        <div className="border-b border-gray-200 px-3 py-1.5 flex items-center justify-between shrink-0">
          <span className="text-xs text-gray-400">面板</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded hover:bg-gray-100"
            title="收起右侧面板"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      )}
      {/* 4 panels always rendered in DOCK_ORDER; accordion (R35): only the
          expanded panel gets flex-1 (fills remaining dock height), the other
          three are shrink-0 (header only). Dock root is h-full, parent layout
          gives it a definite height, so flex-1 auto-sizes without any JS. */}
      {DOCK_ORDER.map((panel) => {
        const isCollapsed = collapsed[panel];
        return (
          <div
            key={panel}
            className={`relative flex flex-col w-full min-h-0 ${isCollapsed ? "shrink-0" : "flex-1 overflow-hidden"}`}
          >
            <PanelContent panel={panel} {...props} toggleCollapsed={props.toggleCollapsed} />
          </div>
        );
      })}
    </div>
  );
}

// Header-only row height when a panel is collapsed. Matches the rendered
// `border-b border-gray-200 px-4 py-2` header band.
const COLLAPSED_H = 33;

// ---------- Panel content switch ----------

function PanelContent({
  panel,
  toggleCollapsed,
  ...rest
}: { panel: DockPanelId } & RightDockProps) {
  // 注意: 这里的 toggleCollapsed 由 main 函数注入 = handleToggle (2/3 boost 版),
  // 而不是 props.toggleCollapsed。PanelContent 本身在模块顶层,看不到 main 里
  // 的 handleToggle,所以从 props 解构出来透传给子组件。
  switch (panel) {
    case "details":
      return (
        <DetailsPanelBody
          {...rest}
          toggleCollapsed={toggleCollapsed}
        />
      );
    case "timeline":
      return (
        <TaskTimeline
          taskId={rest.taskId}
          refreshKey={rest.refreshKeys.timeline}
          collapsed={rest.collapsed}
          toggleCollapsed={toggleCollapsed}
        />
      );
    case "checkpoints":
      return (
        <CheckpointsPanel
          taskId={rest.taskId}
          refreshKey={rest.refreshKeys.checkpoints}
          onForkFromHere={rest.onForkFromCheckpoint}
          sessionIdAvailable={rest.sessionIdAvailable}
          collapsed={rest.collapsed}
          toggleCollapsed={toggleCollapsed}
        />
      );
    case "commits":
      return (
        <CommitsChainPanel
          taskId={rest.taskId}
          refreshKey={rest.refreshKeys.commits}
          collapsed={rest.collapsed}
          toggleCollapsed={toggleCollapsed}
          baseCommit={rest.task.base_commit}
          headCommit={rest.task.head_commit}
        />
      );
  }
}

// ---------- Shared status constants (duplicated from task-detail-client) ----------

const STATUS_DOT: Record<string, string> = {
  pending: "bg-gray-400",
  queued: "bg-blue-400",
  running: "bg-sky-400 animate-pulse",
  // DAG P3 (B4 拍板 2026-09-05): verifying 视觉同 paused (黄色), 借鉴 P2
  //   模式. 机械验收门瞬态, 文档 src/lib/runtime/types.ts TaskStatus 段.
  verifying: "bg-yellow-400",
  paused: "bg-yellow-400",
  reviewing: "bg-purple-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  rejected: "bg-orange-400",
  cancelled: "bg-gray-300",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  queued: "排队中",
  running: "运行中",
  verifying: "验收中",
  paused: "已暂停",
  reviewing: "待审核",
  completed: "已完成",
  failed: "失败",
  // ⚠️ 历史兼容. 🆕 2026-09-15 R后续 damo: UI 改「等待中」.
  rejected: "等待中",
  cancelled: "已取消",
};

// ---------- Panel header (clickable to collapse body + ✕ to close) ----------

function PanelHeader({
  icon,
  title,
  count,
  bodyId,
  collapsed,
  onToggle,
}: {
  icon: string;
  title: string;
  count?: number | string;
  bodyId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <div className="border-b border-gray-200 px-4 py-2 flex items-center gap-2">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={onToggle}
        onKeyDown={onKey}
        title={collapsed ? "展开面板" : "折叠面板"}
        className="flex items-center gap-2 cursor-pointer select-none rounded outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 flex-1 min-w-0"
      >
        <span aria-hidden className="text-xs text-gray-500 w-3 inline-block text-center shrink-0">
          {collapsed ? "▶" : "▼"}
        </span>
        <span className="text-sm font-semibold text-gray-700 truncate">
          {icon} {title}
        </span>
        {count !== undefined && (
          <span className="text-xs text-gray-400 shrink-0">{count}</span>
        )}
      </div>
    </div>
  );
}

// ---------- Details panel body (former TaskSidebar contents) ----------
//
// R35 (2026-08-28): split into 4 collapsible sub-blocks so a long prompt
// no longer buries the result / dependency sections below it. Each sub-block
// header stays visible (no internal scroll for headers); body scrolls
// independently with max-h ≈ 400px so a 5k-token prompt becomes scrollable
// instead of stretching the dock body.
//   - Prompt           (default open; always shown)
//   - 派发与依赖        (default open iff any relations exist)
//   - 结果             (result + error; default open iff either exists)
//   - 元信息           (cwd / preflight / tools / tags / project / session;
//                       default collapsed — opened on demand to keep top of
//                       dock focused on the user-facing 3 requested in R35)

// ---------- Sub-section: collapsible block with max-height + scroll ----------

function SubSection({
  title,
  hint,
  open,
  onToggle,
  maxHeightClass = "max-h-[400px]",
  children,
}: {
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  maxHeightClass?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-gray-200 rounded-md bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-gray-700 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 transition-colors"
      >
        <span aria-hidden className="text-gray-400 w-3 inline-block text-center shrink-0">
          {open ? "▼" : "▶"}
        </span>
        <span className="uppercase tracking-wide">{title}</span>
        {hint && (
          <span className="text-[11px] text-gray-400 font-normal normal-case ml-auto truncate">
            {hint}
          </span>
        )}
      </button>
      <div
        aria-hidden={open ? undefined : true}
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className={`px-3 pb-3 overflow-y-auto ${open ? maxHeightClass : ""}`}>
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Relation row (used inside 派发与依赖) ----------

function RelationRow({
  task,
  parentId,
  variant = "downstream",
}: {
  task: DepTask | DispatchedTask;
  parentId: string | null | undefined;
  variant?: "upstream" | "downstream" | "depends" | "dependent";
}) {
  const dispatchedTask = task as DispatchedTask;
  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <Link
        href={`/tasks/${task.id}`}
        className="flex items-center gap-2 rounded hover:bg-gray-50 text-sm flex-1 min-w-0"
      >
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${
            STATUS_DOT[task.status] || "bg-gray-400"
          }`}
        />
        <span
          className={`truncate ${
            variant === "upstream" || variant === "depends"
              ? "text-blue-600 hover:underline"
              : "text-gray-700"
          }`}
        >
          {task.title}
        </span>
        {dispatchedTask.project_id &&
          parentId &&
          dispatchedTask.project_id !== parentId && (
            <span
              className="text-xs text-purple-600 shrink-0"
              title={`跨项目: ${dispatchedTask.project_id}`}
            >
              跨项目
            </span>
          )}
        <span className="text-xs text-gray-400 ml-auto shrink-0">
          {STATUS_LABELS[task.status] || task.status}
        </span>
        <span className="text-xs text-gray-400 shrink-0 font-mono">
          #{task.id.slice(0, 8)}
        </span>
      </Link>
      <CopyLinkButton id={task.id} />
    </div>
  );
}

// ---------- Main DetailsPanelBody ----------

function DetailsPanelBody({
  task,
  dependsOnTasks,
  dependentTasks,
  parentTask,
  dispatcherTask,
  dispatchedTasks,
  requirementLink,
  requirementSiblings,
  collapsed,
  toggleCollapsed,
}: {
  task: TaskForDock;
  dependsOnTasks: DepTask[];
  dependentTasks: DepTask[];
  parentTask: DepTask | null;
  dispatcherTask: DepTask | null;
  dispatchedTasks: DispatchedTask[];
  requirementLink: RequirementLink | null;
  requirementSiblings: DepTask[];
  collapsed: { details: boolean };
  toggleCollapsed: (p: DockPanelId) => void;
}) {
  const allowedTools = parseStrArray(task.allowed_tools);
  const tags = parseStrArray(task.tags);

  const hasDispatch = !!dispatcherTask || dispatchedTasks.length > 0;
  const hasDeps = dependsOnTasks.length > 0 || dependentTasks.length > 0;
  const hasRelations = hasDispatch || hasDeps;
  const hasOutcome = !!(task.result || task.error);

  // Local UI state for the 4 sub-blocks within 任务详情. Not persisted to
  // localStorage on purpose — task-level transient UI, resets when navigating
  // to a different task (reasonable: prompt size / relation shape differ
  // enough that no single "good default" fits all tasks).
  //
  // DAG P4 (2026-09-06): 新增 subOpen.dependency 字段. 依赖图段独立成 SubSection,
  //   始终渲染 (有依赖显示 3 段式 DAG, 无依赖显示占位文案), 默认展开让用户
  //   一眼看到依赖拓扑.
  const [subOpen, setSubOpen] = useState({
    prompt: true,
    relations: hasRelations,
    outcome: hasOutcome,
    meta: false,
    requirement: !!requirementLink, // R78 W3 §4.2: 有挂需求点时默认展开
    dependency: hasDeps, // DAG P4: 有依赖时默认展开, 无依赖时折叠 (占位一行)
  });
  const toggleSub = useCallback(
    (k: keyof typeof subOpen) =>
      setSubOpen((s) => ({ ...s, [k]: !s[k] })),
    []
  );

  // 需求点状态色 (与 status-flow.tsx 的 STATUS_COLOR 同源, 复制避免 client
  // 引 server-only modules).
  const REQ_STATUS_COLOR: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    done: "bg-green-100 text-green-700",
    awaiting_reply: "bg-blue-100 text-blue-700",
    has_suggestion: "bg-purple-100 text-purple-700",
    blocked: "bg-orange-100 text-orange-700",
    closed: "bg-gray-200 text-gray-500",
  };
  const REQ_STATUS_LABEL: Record<string, string> = {
    pending: "未开始",
    done: "已完成",
    awaiting_reply: "等回复",
    has_suggestion: "有建议",
    blocked: "需拍板",
    closed: "已关闭",
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-white">
      <PanelHeader
        icon="🗂"
        title="任务详情"
        bodyId="dock-panel-details-body"
        collapsed={collapsed.details}
        onToggle={() => toggleCollapsed("details")}
      />
      {/* flex-1 让 body grid 撑满 PanelHeader 之后的剩余空间;
          之前缺这一行 + 父级 flex-1 把详情面板撑到 dock 全高, body
          仍按内容高度渲染只在顶部一小块 = "50px 视图". 详见 R37. */}
      <div
        id="dock-panel-details-body"
        aria-hidden={collapsed.details ? true : undefined}
        inert={collapsed.details ? true : undefined}
        className={`grid flex-1 min-h-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          collapsed.details ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="overflow-y-auto h-full p-3 space-y-3">
            {/* 1. Prompt — always shown, default open */}
            <SubSection
              title="Prompt"
              hint={task.prompt.length > 80 ? `${task.prompt.length} chars` : undefined}
              open={subOpen.prompt}
              onToggle={() => toggleSub("prompt")}
              maxHeightClass="max-h-[400px]"
            >
              <pre className="text-sm bg-gray-50 rounded p-3 whitespace-pre-wrap font-mono break-words">
                {task.prompt}
              </pre>
            </SubSection>

            {/* 1.5 R78 W3 §4.2: 需求点关联 — only render if task.requirement_id 非空.
                 默认展开 (比"派发与依赖"优先级高), 让 reviewer 一眼看到 task
                 服务于哪个需求点. */}
            {requirementLink && (
              <SubSection
                title="需求点关联"
                hint={requirementSiblings.length > 0 ? `森林 ${requirementSiblings.length + 1} 个` : undefined}
                open={subOpen.requirement}
                onToggle={() => toggleSub("requirement")}
                maxHeightClass="max-h-[400px]"
              >
                <div className="space-y-2">
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50">
                    <span aria-hidden className="text-xs text-gray-400 shrink-0">📋</span>
                    <Link
                      href={`/requirements/${requirementLink.id}`}
                      className="flex-1 min-w-0 truncate text-sm font-medium text-blue-600 hover:underline"
                      title={requirementLink.title}
                    >
                      {requirementLink.title}
                    </Link>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                        REQ_STATUS_COLOR[requirementLink.status] || "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {REQ_STATUS_LABEL[requirementLink.status] || requirementLink.status}
                    </span>
                  </div>
                  {requirementSiblings.length > 0 && (
                    <div>
                      <div className="text-xs text-gray-400 mb-1 px-2">
                        同需求点下的其他 task (森林)
                      </div>
                      {requirementSiblings.map((sib) => (
                        <div key={sib.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50">
                          <span
                            className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                              STATUS_DOT[sib.status] || "bg-gray-400"
                            }`}
                          />
                          <Link
                            href={`/tasks/${sib.id}`}
                            className="flex-1 min-w-0 truncate text-sm text-gray-700 hover:text-blue-600"
                            title={sib.title}
                          >
                            {sib.title}
                          </Link>
                          <span className="text-xs text-gray-400 shrink-0">
                            {STATUS_LABELS[sib.status] || sib.status}
                          </span>
                        </div>
                      ))}
                      <Link
                        href={`/requirements/${requirementLink.id}`}
                        className="block text-center text-xs text-blue-600 hover:underline mt-1.5 px-2 py-1"
                      >
                        查看森林 →
                      </Link>
                    </div>
                  )}
                </div>
              </SubSection>
            )}

            {/* 2. 派发与依赖 — only render if there's any relations */}
            {hasRelations && (
              <SubSection
                title="派发与依赖"
                hint={
                  [
                    dispatcherTask ? "1 上游" : null,
                    `${dispatchedTasks.length} 下游`,
                    dependsOnTasks.length ? `${dependsOnTasks.length} 前置` : null,
                    dependentTasks.length ? `${dependentTasks.length} 后续` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                open={subOpen.relations}
                onToggle={() => toggleSub("relations")}
                maxHeightClass="max-h-[400px]"
              >
                <div className="space-y-3">
                  {dispatcherTask && (
                    <div>
                      <div className="text-xs text-gray-400 mb-1">
                        派发自（上游任务）
                      </div>
                      <RelationRow
                        task={dispatcherTask}
                        parentId={task.project_id}
                        variant="upstream"
                      />
                    </div>
                  )}
                  {dispatchedTasks.length > 0 && (
                    <div>
                      <div className="text-xs text-gray-400 mb-1">
                        本任务派发（下游任务）
                      </div>
                      {dispatchedTasks.map((d) => (
                        <RelationRow
                          key={d.id}
                          task={d}
                          parentId={task.project_id}
                          variant="downstream"
                        />
                      ))}
                    </div>
                  )}
                </div>
              </SubSection>
            )}

            {/* 2.5 DAG P4 (2026-09-06): 依赖图 — 独立 SubSection, 始终渲染.
                 有依赖显示 3 段式 DAG (上游蓝边/当前蓝填高亮/下游绿边), 无
                 依赖显示占位文案. 仅一层, 不递归 (设计稿 §4.4 否决). 节点数
                 超 5 时只展示前 5 + "还有 N 个" 提示, 不引入 <details> 折叠
                 (跟 right-dock 现有扁平风格一致). */}
            <SubSection
              title="依赖图"
              hint={
                hasDeps
                  ? `${dependsOnTasks.length} 上游 · ${dependentTasks.length} 下游`
                  : undefined
              }
              open={subOpen.dependency}
              onToggle={() => toggleSub("dependency")}
              maxHeightClass="max-h-[400px]"
            >
              {(() => {
                const MAX_VISIBLE = 5;
                const upstreamVisible = dependsOnTasks.slice(0, MAX_VISIBLE);
                const upstreamHidden = dependsOnTasks.length - upstreamVisible.length;
                const downstreamVisible = dependentTasks.slice(0, MAX_VISIBLE);
                const downstreamHidden = dependentTasks.length - downstreamVisible.length;
                return (
                  <div data-testid="dependency-graph" className="space-y-2">
                    {!hasDeps && (
                      <div className="text-xs text-gray-400 italic px-2 py-1">
                        此任务无依赖关系
                      </div>
                    )}
                    {dependsOnTasks.length > 0 && (
                      <div className="space-y-1 pl-2 border-l-2 border-blue-200">
                        <div className="text-[11px] text-blue-700 font-medium uppercase">
                          上游（依赖）
                        </div>
                        {upstreamVisible.map((dep) => (
                          <RelationRow
                            key={dep.id}
                            task={dep}
                            parentId={task.project_id}
                            variant="depends"
                          />
                        ))}
                        {upstreamHidden > 0 && (
                          <div className="text-[11px] text-gray-400 px-2 py-1">
                            还有 {upstreamHidden} 个上游…
                          </div>
                        )}
                      </div>
                    )}
                    {hasDeps && (
                      <div className="rounded-md border-2 border-blue-500 bg-blue-50 p-2">
                        <div className="text-[10px] text-blue-700 uppercase font-semibold tracking-wide">
                          当前任务
                        </div>
                        <div
                          className="text-sm font-medium text-blue-900 truncate mt-0.5"
                          title={task.title}
                        >
                          {task.title}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${
                              STATUS_DOT[task.status] || "bg-gray-400"
                            }`}
                            aria-hidden
                          />
                          <span className="text-[11px] text-blue-800">
                            {STATUS_LABELS[task.status] || task.status}
                          </span>
                          <span className="text-[11px] text-blue-600/70 font-mono ml-auto">
                            #{task.id.slice(0, 8)}
                          </span>
                        </div>
                      </div>
                    )}
                    {dependentTasks.length > 0 && (
                      <div className="space-y-1 pl-2 border-l-2 border-green-200">
                        <div className="text-[11px] text-green-700 font-medium uppercase">
                          下游（被依赖）
                        </div>
                        {downstreamVisible.map((dep) => (
                          <RelationRow
                            key={dep.id}
                            task={dep}
                            parentId={task.project_id}
                            variant="dependent"
                          />
                        ))}
                        {downstreamHidden > 0 && (
                          <div className="text-[11px] text-gray-400 px-2 py-1">
                            还有 {downstreamHidden} 个下游…
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </SubSection>

            {/* 3. 结果 — outcome (result + error) */}
            {hasOutcome && (
              <SubSection
                title="结果"
                hint={
                  [
                    task.result ? "result" : null,
                    task.error ? "error" : null,
                  ]
                    .filter(Boolean)
                    .join(" + ") || undefined
                }
                open={subOpen.outcome}
                onToggle={() => toggleSub("outcome")}
                maxHeightClass="max-h-[400px]"
              >
                {task.result && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      result
                    </h4>
                    <pre className="text-sm bg-gray-50 rounded p-3 whitespace-pre-wrap break-words">
                      {task.result}
                    </pre>
                  </div>
                )}
                {task.error && (
                  <div className={task.result ? "mt-3" : undefined}>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      error
                    </h4>
                    <pre className="text-sm bg-red-50 rounded p-3 whitespace-pre-wrap break-words text-red-700">
                      {task.error}
                    </pre>
                  </div>
                )}
              </SubSection>
            )}

            {/* 4. 元信息 — secondary metadata, default collapsed */}
            <SubSection
              title="元信息"
              open={subOpen.meta}
              onToggle={() => toggleSub("meta")}
              maxHeightClass="max-h-[400px]"
            >
              <div className="space-y-3">
                {task.cwd && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      工作目录
                    </h4>
                    <p className="text-sm text-gray-700 font-mono break-all">
                      {task.cwd}
                    </p>
                  </div>
                )}
                {task.preflight_result && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      Preflight 自检（系统执行）
                    </h4>
                    <pre className="text-xs bg-amber-50 border border-amber-200 rounded p-3 whitespace-pre-wrap font-mono break-words">
                      {task.preflight_result}
                    </pre>
                  </div>
                )}
                {allowedTools.length > 0 && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      工具
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {allowedTools.map((t: string) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 bg-gray-100 rounded text-xs"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {tags.length > 0 && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      标签
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((t: string) => (
                        <span
                          key={t}
                          className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {(task.project_id || task.version_id) && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      归属
                    </h4>
                    {task.project_id && (
                      <span className="inline-block px-2 py-0.5 bg-purple-50 text-purple-700 rounded text-xs mr-1">
                        项目: {task.project_id.slice(0, 8)}…
                      </span>
                    )}
                    {task.version_id && (
                      <span className="inline-block px-2 py-0.5 bg-orange-50 text-orange-700 rounded text-xs">
                        版本: {task.version_id.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                )}
                {parentTask && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      父任务
                    </h4>
                    <RelationRow
                      task={parentTask}
                      parentId={task.project_id}
                      variant="upstream"
                    />
                  </div>
                )}
                {task.session_id && (
                  <div>
                    <h4 className="text-[11px] font-semibold text-gray-500 uppercase mb-1">
                      Session
                    </h4>
                    <p className="text-xs text-gray-500 font-mono break-all">
                      {task.session_id}
                    </p>
                  </div>
                )}
              </div>
            </SubSection>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Task timeline panel ----------

type TimelineEvent = {
  id: number | null;
  from: string | null;
  to: string;
  created_at: string;
  is_initial: boolean;
  duration_ms: number | null;
};

function TaskTimeline({
  taskId,
  refreshKey,
  collapsed,
  toggleCollapsed,
}: {
  taskId: string;
  refreshKey: number;
  collapsed: { timeline: boolean };
  toggleCollapsed: (p: DockPanelId) => void;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/timeline`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setEvents(Array.isArray(data.events) ? data.events : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-white">
      <PanelHeader
        icon="🕒"
        title="任务时间线"
        count={`${events.length} 个节点`}
        bodyId="dock-panel-timeline-body"
        collapsed={collapsed.timeline}
        onToggle={() => toggleCollapsed("timeline")}
      />
      <div
        id="dock-panel-timeline-body"
        aria-hidden={collapsed.timeline ? true : undefined}
        inert={collapsed.timeline ? true : undefined}
        className={`grid flex-1 min-h-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          collapsed.timeline ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="overflow-y-auto h-full p-4">
        {loading && (
          <div className="text-center text-gray-400 py-6 text-sm">加载中...</div>
        )}
        {error && (
          <div className="text-center text-red-500 py-6 text-sm">⚠ {error}</div>
        )}
        {!loading && !error && events.length === 0 && (
          <div className="text-center text-gray-400 py-6 text-sm">暂无事件</div>
        )}
        {!loading && !error && events.length > 0 && (
          <ol className="relative">
            <span
              className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-200"
              aria-hidden
            />
            {events.map((ev, i) => (
              <TimelineNode key={`${ev.id ?? "init"}-${i}`} event={ev} />
            ))}
          </ol>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineNode({ event }: { event: TimelineEvent }) {
  const ts = parseDbTime(event.created_at);
  const time = ts ? formatTime(ts.getTime()) : "--:--:--";
  const dot = STATUS_DOT[event.to] || "bg-gray-400";
  const isHighlight = event.from === "running" && event.to === "reviewing";
  const statusLabel = event.from
    ? `${STATUS_LABELS[event.from] || event.from} → ${STATUS_LABELS[event.to] || event.to}`
    : STATUS_LABELS[event.to] || event.to;

  return (
    <li className="relative pl-6 pb-4 last:pb-0">
      <span
        className={`absolute left-0 top-0.5 inline-block w-[15px] h-[15px] rounded-full border-2 border-white shadow ring-1 ring-gray-200 ${dot} ${
          isHighlight ? "ring-2 ring-purple-400 ring-offset-1" : ""
        }`}
        aria-hidden
      />
      <div
        className={`rounded px-2 py-1.5 text-sm ${
          isHighlight ? "bg-purple-50 border border-purple-200" : "hover:bg-gray-50"
        }`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-gray-500">{time}</span>
          <span
            className={`text-xs ${
              isHighlight ? "text-purple-700 font-semibold" : "text-gray-700"
            }`}
          >
            {statusLabel}
          </span>
          {isHighlight && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
              完成
            </span>
          )}
          {event.is_initial && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
              起始
            </span>
          )}
        </div>
        {event.duration_ms != null && (
          <div className="text-xs text-gray-400 mt-0.5">
            ⏱ 持续 {formatDuration(event.duration_ms)}
          </div>
        )}
      </div>
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return "<1秒";
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}时${mins}分`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ---------- Checkpoints panel ----------

interface CheckpointRow {
  id: number;
  task_id: string;
  session_id: string;
  step: string;
  summary: string | null;
  // R108: by / status 字段在 DB schema 已加 (v76). 本 task 不在 UI 渲染
  //   (T2/T4 后续再设计 chip 颜色 + 映射规则); 字段先过 type 防
  //   `Property 'by' does not exist on type 'CheckpointRow'` 编译错.
  by: string | null;
  status: string | null;
  commit_id: string | null;
  transcript_slice: string | null;
  up_to_message_id: string | null;
  created_at: string;
}

function CheckpointsPanel({
  taskId,
  refreshKey,
  onForkFromHere,
  sessionIdAvailable,
  collapsed,
  toggleCollapsed,
}: {
  taskId: string;
  refreshKey: number;
  onForkFromHere: (checkpointId: number) => void;
  sessionIdAvailable: boolean;
  collapsed: { checkpoints: boolean };
  toggleCollapsed: (p: DockPanelId) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a manual checkpoint is created so the list re-fetches
  // without relying on an SSE checkpoint event.
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/checkpoints`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setCheckpoints(Array.isArray(data) ? data : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey, localRefresh]);

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-white">
      <PanelHeader
        icon="🧷"
        title="Checkpoints"
        count={`${checkpoints.length} 个`}
        bodyId="dock-panel-checkpoints-body"
        collapsed={collapsed.checkpoints}
        onToggle={() => toggleCollapsed("checkpoints")}
      />
      <div
        id="dock-panel-checkpoints-body"
        aria-hidden={collapsed.checkpoints ? true : undefined}
        inert={collapsed.checkpoints ? true : undefined}
        className={`grid flex-1 min-h-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          collapsed.checkpoints ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="overflow-y-auto h-full p-4">
        <div className="mb-3">
          <AddCheckpointControl
            taskId={taskId}
            sessionIdAvailable={sessionIdAvailable}
            onCreated={() => setLocalRefresh((n) => n + 1)}
          />
        </div>
        {loading && (
          <div className="text-center text-gray-400 py-6 text-sm">加载中...</div>
        )}
        {error && (
          <div className="text-center text-red-500 py-6 text-sm">⚠ {error}</div>
        )}
        {!loading && !error && checkpoints.length === 0 && (
          <div className="text-center text-gray-400 py-6 text-xs">
            暂无 checkpoint。让 agent 在输出里写
            <code className="mx-1 px-1 bg-gray-100 rounded">&lt;checkpoint step=N summary="..."&gt;</code>
            ，或手动添加一个 fork 点。
          </div>
        )}
        {!loading && !error && checkpoints.length > 0 && (
          <ol className="space-y-2">
            {checkpoints.map((cp) => (
              <CheckpointNode
                key={cp.id}
                cp={cp}
                canFork={sessionIdAvailable && !!cp.up_to_message_id}
                onForkFromHere={() => onForkFromHere(cp.id)}
              />
            ))}
          </ol>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AddCheckpointControl({
  taskId,
  sessionIdAvailable,
  onCreated,
}: {
  taskId: string;
  sessionIdAvailable: boolean;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [stepInput, setStepInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // step is a string tag (v46): accept digits or semantic names like
      // "final". Empty falls back to ms-timestamp server-side, so just
      // pass the raw trim when present.
      const body: { summary?: string; step?: string } = {};
      const s = summary.trim();
      if (s) body.summary = s;
      const st = stepInput.trim();
      if (st) body.step = st;
      const res = await fetch(`/api/tasks/${taskId}/checkpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSummary("");
      setStepInput("");
      setOpen(false);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={!sessionIdAvailable}
        title={sessionIdAvailable ? "手动添加一个 checkpoint 作为 fork 点" : "需要先启动任务生成 session"}
        className="w-full text-xs px-2 py-1.5 border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        + 手动添加 checkpoint
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 border border-gray-300 rounded p-2 bg-gray-50">
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="简述这个 checkpoint（可选）"
        rows={2}
        className="w-full text-sm px-2 py-1 border border-gray-300 rounded resize-none focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
      />
      <input
        value={stepInput}
        onChange={(e) => setStepInput(e.target.value)}
        placeholder="step（数字或语义词，如 final；留空用时间戳）"
        className="w-full text-xs px-2 py-1 border border-gray-300 rounded font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
      />
      {error && <div className="text-xs text-red-500 break-words">⚠ {error}</div>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
        >
          {submitting ? "添加中..." : "添加"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-xs px-2 py-1 border border-gray-300 text-gray-600 rounded hover:bg-gray-100"
        >
          取消
        </button>
      </div>
    </form>
  );
}

function CheckpointNode({
  cp,
  canFork,
  onForkFromHere,
}: {
  cp: CheckpointRow;
  canFork: boolean;
  onForkFromHere: () => void;
}) {
  const ts = parseDbTime(cp.created_at);
  const time = ts ? formatTime(ts.getTime()) : "--:--:--";
  // R108 T2: status 字符串 → 4 色 chip. 返回 null → 老 checkpoint 行 /
  // agent 没写 status → 不渲染 chip (向后兼容).
  const statusDisplay = getStatusDisplay(cp.status);
  return (
    <li className="relative bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1 flex-wrap">
        <span className="font-mono text-emerald-700">step {cp.step}</span>
        <span>·</span>
        <span>{time}</span>
        {cp.commit_id && (
          <>
            <span>·</span>
            <code
              className="font-mono text-gray-500 truncate max-w-[120px]"
              title={cp.commit_id}
            >
              {cp.commit_id.slice(0, 7)}
            </code>
          </>
        )}
        {cp.by && (
          <span
            className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200"
            title={`写这个 checkpoint 的 agent / 上游: ${cp.by}`}
          >
            [by]{cp.by}
          </span>
        )}
      </div>
      <div className="text-sm text-gray-800 break-words">
        {cp.summary || <span className="text-gray-400 italic">(no summary)</span>}
      </div>
      {statusDisplay && (
        <div className="mt-1.5">
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs ${statusDisplay.bgClass} ${statusDisplay.textClass}`}
            title={`status=${cp.status}`}
          >
            {statusDisplay.label}
          </span>
        </div>
      )}
      {canFork && (
        <button
          onClick={onForkFromHere}
          className="mt-2 text-xs px-2 py-1 border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-100"
        >
          Fork from here
        </button>
      )}
      {!cp.up_to_message_id && (
        <div className="mt-1 text-[10px] text-gray-400">fork point not available (anchor only)</div>
      )}
    </li>
  );
}

// ---------- Commits chain panel ----------
//
// R113 (2026-09-07): data model reshaped from "task chain + checkpoint
//   snapshots" to a real git log view. Each row is one agent-emitted
//   <git commit-id="..." desc="..." files="..."/> marker (parsed by
//   active-session.ts transcript parser, stored in task_commits table).
//
//   - Click a commit row to expand the file list (R113 §2 "git 记录点开,
//     期望能看到变更的文件").
//   - Header shows a collapsed "派生 task" hint (replaces the old "根任务 /
//     fork" badge per row — the topology is now metadata, the body is
//     the commit log).
//   - Empty entries → "区间内无 commit" hint + base/head 区间提示.
//     R158 (damo 2026-09-26) 起, 区间内未声明的 commit 已由 agent 退出时
//     自动收集 (INSERT OR IGNORE, marker 声明的保留). 这里看到 entries.length
//     === 0 通常是: cwd 非 git 仓 / base==head (无新 commit) / base/head 字段
//     未落库. marker 仍是建议通道 —— 写 marker 带 desc + files 比 git subject
//     更精细.

interface CommitChainEntry {
  task_id: string;
  commit_id: string;
  desc: string | null;
  files: string[];
  files_json: string | null;
  created_at: string;
}

interface DescendantTaskSummary {
  task_id: string;
  task_title: string;
}

function CommitsChainPanel({
  taskId,
  refreshKey,
  collapsed,
  toggleCollapsed,
  baseCommit,
  headCommit,
}: {
  taskId: string;
  refreshKey: number;
  collapsed: { commits: boolean };
  toggleCollapsed: (p: DockPanelId) => void;
  // R113: base/head snapshot hints when no <git/> markers were emitted.
  baseCommit: string | null;
  headCommit: string | null;
}) {
  const [entries, setEntries] = useState<CommitChainEntry[]>([]);
  const [descendantTasks, setDescendantTasks] = useState<DescendantTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // R113: which commit rows are expanded to show files. Single open at a time
  // — keeps the dock body compact; clicking another row auto-collapses the
  // previous. Same UX contract as the dock accordion (R35).
  const [expandedCommitId, setExpandedCommitId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/commits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setEntries(Array.isArray(data.entries) ? data.entries : []);
          setDescendantTasks(
            Array.isArray(data.descendant_tasks) ? data.descendant_tasks : [],
          );
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  // Auto-collapse expanded row if it's no longer in the entries list (e.g.
  // refreshKey bumped and the marker was removed/replayed).
  useEffect(() => {
    if (
      expandedCommitId &&
      !entries.some((e) => e.commit_id === expandedCommitId)
    ) {
      setExpandedCommitId(null);
    }
  }, [entries, expandedCommitId]);

  // R113: header count switched from "N 个任务" to "N 条 commit". Topology
  // (派生 task 数量) moved to a collapsible hint below the count line.
  const showDescendantHint = descendantTasks.length > 1;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-white">
      <PanelHeader
        icon="🔗"
        title="Commits"
        count={entries.length > 0 ? `${entries.length} 条 commit` : undefined}
        bodyId="dock-panel-commits-body"
        collapsed={collapsed.commits}
        onToggle={() => toggleCollapsed("commits")}
      />
      <div
        id="dock-panel-commits-body"
        aria-hidden={collapsed.commits ? true : undefined}
        inert={collapsed.commits ? true : undefined}
        className={`grid flex-1 min-h-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          collapsed.commits ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="overflow-y-auto h-full p-4">
        {showDescendantHint && (
          <details className="mb-3 text-xs">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none">
              派生 task ({descendantTasks.length}) — 点击查看 fork 拓扑
            </summary>
            <ul className="mt-1.5 space-y-1 pl-3 border-l-2 border-gray-200">
              {descendantTasks.map((d, i) => (
                <li key={d.task_id} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400 w-3 shrink-0">{i === 0 ? "●" : "↳"}</span>
                  <a
                    href={`/tasks/${d.task_id}`}
                    className="text-blue-600 hover:underline truncate flex-1 min-w-0"
                    title={d.task_title}
                  >
                    {d.task_title}
                  </a>
                  <code className="text-gray-400 shrink-0">
                    {d.task_id.slice(0, 8)}
                  </code>
                </li>
              ))}
            </ul>
          </details>
        )}
        {loading && <div className="text-center text-gray-400 py-6 text-sm">加载中...</div>}
        {error && <div className="text-center text-red-500 py-6 text-sm">⚠ {error}</div>}
        {!loading && !error && entries.length === 0 && (
          <div className="space-y-2 py-6 text-center">
            {/* R158 (damo 2026-09-26): 自动收集已上线, 区间内 0 commit 才是真
                的空. 顶部"或手动 git commit 后重启任务"是兜底 (重启触发新一轮
                自动收集; 不过本任务 commit 区间是「task 启动时 base → task 结束时
                head」固定窗口, 重启不重算). 让 agent 写 marker 仍是建议通道,
                marker 带 desc + files 比 git subject 更精细. */}
            <div className="text-sm text-gray-500">区间内无 commit</div>
            <div className="text-xs text-gray-400">
              让 agent 在输出里写
              <code className="mx-1 px-1 bg-gray-100 rounded font-mono">
                &lt;git commit-id=&quot;abc&quot; desc=&quot;...&quot; files=&quot;a.ts,b.ts&quot;/&gt;
              </code>
              （已自动收集区间内 commit；marker 可补 desc 与文件清单）。
            </div>
            {(baseCommit || headCommit) && (
              <div className="text-[11px] font-mono text-gray-400 mt-2">
                区间 base <code>{baseCommit?.slice(0, 7) ?? "—"}</code>
                {" → "}
                head <code>{headCommit?.slice(0, 7) ?? "—"}</code>
              </div>
            )}
          </div>
        )}
        {!loading && !error && entries.length > 0 && (
          <ol className="space-y-1.5">
            {entries.map((e) => (
              <CommitEntryCard
                key={`${e.task_id}-${e.commit_id}`}
                entry={e}
                expanded={expandedCommitId === e.commit_id}
                onToggle={() =>
                  setExpandedCommitId((cur) =>
                    cur === e.commit_id ? null : e.commit_id,
                  )
                }
              />
            ))}
          </ol>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}

// R113: commit-row card. Compact git-log style — short hash + desc + relative
// time + expand-on-click. Click expands the files list (R113 §2 "git 记录点开,
// 期望能看到变更的文件"). Files are read from task_commits.files_json at
// insert time, parsed by the DB helper into `files: string[]`.
function CommitEntryCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: CommitChainEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ts = parseDbTime(entry.created_at);
  const time = ts ? formatTime(ts.getTime()) : "--:--:--";
  const hasFiles = entry.files.length > 0;
  return (
    <li className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-2.5 py-2 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 transition-colors"
      >
        <div className="flex items-start gap-2 text-xs">
          <span aria-hidden className="text-gray-400 mt-0.5 w-3 shrink-0 inline-block text-center">
            {expanded ? "▼" : "▶"}
          </span>
          <code className="font-mono text-indigo-700 shrink-0 mt-0.5">
            {entry.commit_id.slice(0, 7)}
          </code>
          <span className="text-gray-700 flex-1 min-w-0 break-words">
            {entry.desc || <span className="text-gray-400 italic">(no desc)</span>}
          </span>
          <span className="text-gray-400 font-mono shrink-0 mt-0.5">
            {time}
          </span>
        </div>
        {hasFiles && (
          <div className="ml-5 mt-1 text-[10px] text-gray-400">
            {entry.files.length} 个文件变更 {expanded ? "" : "· 点击展开"}
          </div>
        )}
      </button>
      {expanded && hasFiles && (
        <ul className="border-t border-gray-100 bg-gray-50 px-2.5 py-2 space-y-0.5">
          {entry.files.map((f) => (
            <li
              key={f}
              className="text-[11px] font-mono text-gray-600 truncate"
              title={f}
            >
              {f}
            </li>
          ))}
        </ul>
      )}
      {expanded && !hasFiles && (
        <div className="border-t border-gray-100 bg-gray-50 px-2.5 py-2 text-[11px] text-gray-400 italic">
          (无文件清单 — R158 自动收集不带文件, marker 没写 files 属性)
        </div>
      )}
    </li>
  );
}