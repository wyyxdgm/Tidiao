"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useCallback, useEffect, useRef } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import TaskMetaRow from "./task-meta-row";
import TaskTimeoutEditDialog from "./task-timeout-edit-dialog";
import { useTaskStream } from "./use-task-stream";
import { useToastActions } from "@/components/Toast";

type Task = {
  id: string;
  title: string;
  status: string;
  model: string | null;
  resolved_model: string | null;
  effort: string | null;
  max_turns: number | null;
  cost_usd: number | null;
  context_tokens: number | null;
  context_max: number | null;
  project_id: string | null;
  version_id: string | null;
  created_at: string;
  deleted_at: string | null;
  metadata: string | null;
  started_at: string | null;
  awaiting_owner_review: number; // v56: 1 = 等拍板 (兼容旧数据 / v56 marker 翻译)
  awaiting_markers: string | null; // v61+R39: JSON 数组 (来自 <awaiting type="..."/> 多 marker). 与 awaiting_owner_review 同事务落库, 优先读这个.
};

type ParentTask = { id: string; title: string; status: string };
type ProjectRef = { id: string; name: string };
type VersionRef = { id: string; name: string };

// v61+R39: 解析 awaiting_markers + awaiting_owner_review 回退, 返回角标渲染列表.
//   与 board-client.tsx 的同名函数同款语义, 复刻一份因为两个文件不同 store 拉数据
//   (board 拿 TaskTrimmed, task-header 拿全 Task), 共享会让组件边界变得奇怪.
//   后续真要统一, 抽到 @/lib/awaiting-markers.ts 即可 (本期不抽, 避免动两个组件边界).
function parseAwaitingMarkers(
  awaitingMarkersJson: string | null,
  awaitingOwnerReview: number,
): Array<{ label: string; title: string; icon: string; color: string }> {
  // R84: 加 waiting_reply / suggestion / stuck + review label 改"需拍板"对齐 R84 文案.
  //   与 board-client / kanban-view 同源. icon 也扩展, 与飞书 O 列四态一一对应.
  const TYPE_META: Record<string, { color: string; cn: string; icon: string }> = {
    review: { color: "bg-amber-100 text-amber-800 border-amber-200", cn: "需拍板", icon: "🛎" },
    choice: { color: "bg-blue-100 text-blue-800 border-blue-200", cn: "等选", icon: "🔀" },
    info: { color: "bg-gray-100 text-gray-700 border-gray-200", cn: "提示", icon: "ℹ️" },
    waiting_reply: { color: "bg-cyan-100 text-cyan-800 border-cyan-200", cn: "等回复", icon: "📩" },
    suggestion: { color: "bg-emerald-100 text-emerald-800 border-emerald-200", cn: "有建议", icon: "💡" },
    stuck: { color: "bg-red-100 text-red-800 border-red-200", cn: "卡住", icon: "🆘" },
  };
  if (awaitingMarkersJson) {
    try {
      const parsed = JSON.parse(awaitingMarkersJson) as Array<{ type?: string; desc?: string | null }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m) => {
          const t = (m.type || "review").toLowerCase();
          const meta = TYPE_META[t] || { color: "bg-purple-100 text-purple-800 border-purple-200", cn: t || "等拍板", icon: "⏳" };
          const descSnippet = m.desc ? ` · ${m.desc.slice(0, 30)}${m.desc.length > 30 ? "…" : ""}` : "";
          return {
            label: `${meta.cn}${descSnippet}`,
            title: m.desc ? `${t}: ${m.desc}` : `awaiting marker (type=${t})`,
            icon: meta.icon,
            color: meta.color,
          };
        });
      }
    } catch {
      // 解析失败静默走回退 (上层 console.warn 已在 board-client 打)
    }
  }
  // R84: review label 同步改为"需拍板"对齐 R84 文案 (与 board-client / kanban-view 同源).
  if (awaitingOwnerReview === 1) {
    return [
      {
        label: "需拍板",
        title: "Agent 标了需拍板 — approve 会被拒, 需先调 POST /api/tasks/{id}/unset-awaiting-review",
        icon: "🛎",
        color: "bg-amber-100 text-amber-800 border-amber-200",
      },
    ];
  }
  return [];
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className || "w-3.5 h-3.5"}>
      <path d="M7 3.5A1.5 1.5 0 018.5 2h5A1.5 1.5 0 0115 3.5v9A1.5 1.5 0 0113.5 14h-5A1.5 1.5 0 017 12.5v-9z" />
      <path d="M3.5 6A1.5 1.5 0 002 7.5v9A1.5 1.5 0 003.5 18h9a1.5 1.5 0 001.5-1.5V7.5A1.5 1.5 0 0012.5 6h-9z" opacity="0.3" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className || "w-3.5 h-3.5"}>
      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
    </svg>
  );
}

function CopyButton({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    copyToClipboard(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }, [text]);
  return (
    <button onClick={handleCopy} className="text-gray-400 hover:text-gray-600 transition-colors p-0.5" title={title || "复制链接"}>
      {copied ? <CheckIcon className="w-3.5 h-3.5 text-emerald-500" /> : <CopyIcon className="w-3.5 h-3.5" />}
    </button>
  );
}

function TaskIdBadge({ id }: { id: string }) {
  const short = id.slice(0, 8);
  const [origin, setOrigin] = useState("");
  useEffect(() => { setOrigin(window.location.origin); }, []);
  return (
    <span className="inline-flex items-center gap-1">
      <Link href={`/tasks/${id}`} className="text-sm text-gray-500 hover:text-blue-600 hover:underline font-mono" title={`跳转到 ${id}`}>
        #{short}
      </Link>
      <CopyButton text={origin ? `${origin}/#/tasks/${id}` : `/#/tasks/${id}`} title="复制任务链接" />
    </span>
  );
}

export default function TaskHeader({
  task,
  parentTask,
  project,
  version,
  modelName,
  timeoutOverrideMinutes,
  defaultTimeoutMinutes,
  // v57 (R15 task 收藏): SSR 阶段 server 已查好, 客户端立即有状态不闪.
  initialFavorite,
}: {
  task: Task;
  parentTask: ParentTask | null;
  project?: ProjectRef | null;
  version?: VersionRef | null;
  modelName?: string;
  // server 解析出的 per-task override (来自 metadata.timeout_minutes) + project/全局兜底.
  timeoutOverrideMinutes?: number | null;
  defaultTimeoutMinutes?: number | null;
  initialFavorite: boolean;
}) {
  const router = useRouter();
  const toast = useToastActions();
  const [origin, setOrigin] = useState("");
  // Live status - starts from server prop, updates via SSE
  const [liveStatus, setLiveStatus] = useState(task.status);
  // Live cost/context - 同样从 server prop 起步, SSE 终态事件携带时更新
  // (运行中花费由 cost 事件实时更新; 上下文在 reviewing 终态快照)
  const [liveCost, setLiveCost] = useState(task.cost_usd);
  const [liveContextTokens, setLiveContextTokens] = useState(task.context_tokens);
  const [liveContextMax, setLiveContextMax] = useState(task.context_max);
  // v57 (R15 task 收藏): ⭐ toggle 状态, 乐观更新, 失败回滚.
  const [favorite, setFavorite] = useState(initialFavorite);
  const [favoritePending, setFavoritePending] = useState(false);
  // Pending tool-approval count - drives title emphasis while agent waits
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  // 超时倒计时锚点: status_change 携带 started_at + timeout_ms 时刷新;
  //   客户端 setInterval 每秒重算 remainingMs. status !== running 时 anchor = null → 不渲染.
  const [timeoutAnchor, setTimeoutAnchor] = useState<{ startedAt: number; timeoutMs: number } | null>(null);
  const [timeoutRemainingMs, setTimeoutRemainingMs] = useState<number | null>(null);
  // 编辑超时弹窗
  const [dialogOpen, setDialogOpen] = useState(false);
  // R14 sub-1: 标题 click-edit. 默认 h1, 点一下切 input; blur / Enter 保存;
  // Esc 取消. 不在 input 上挂 autoFocus 避免 React SSR 警告, 用 effect 提焦点.
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [titleSaving, setTitleSaving] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  // 进入编辑态时 focus + 全选, 让用户直接覆盖输入.
  useEffect(() => {
    if (titleEditing && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [titleEditing]);
  // 外部 (router.refresh / SSE) 更新 task.title 时同步到草稿; 正在编辑不覆盖.
  useEffect(() => {
    if (!titleEditing) setTitleDraft(task.title);
  }, [task.title, titleEditing]);

  // R14 sub-1: 保存 title 草稿. 空串 / 与原值相同 → 直接退出编辑态.
  // 保存成功 → router.refresh 拉新 server props + 退出编辑. 失败 → toast.
  const saveTitle = useCallback(async () => {
    const next = titleDraft.trim();
    if (!next) {
      toast.error("标题不能为空");
      setTitleDraft(task.title);
      setTitleEditing(false);
      return;
    }
    if (next === task.title) {
      setTitleEditing(false);
      return;
    }
    setTitleSaving(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(`保存标题失败：${data.error || `HTTP ${res.status}`}`);
        setTitleDraft(task.title);
        return;
      }
      setTitleEditing(false);
      // router.refresh 让 server props (page.tsx + TaskHeader props) 重读,
      // 否则下次进任务页会显示旧 title.
      router.refresh();
    } catch (err) {
      toast.error(`保存标题失败：${(err as Error).message}`);
      setTitleDraft(task.title);
    } finally {
      setTitleSaving(false);
    }
  }, [titleDraft, task.title, task.id, router, toast]);

  // v57 (R15 task 收藏): ⭐ toggle. 乐观更新先改 UI, 后端失败回滚 + toast.
  // 401 (未登录) 走老逻辑不变: 详情页 server 渲染时已鉴权, 401 是异常路径.
  const toggleFavorite = useCallback(async () => {
    if (favoritePending) return;
    const next = !favorite;
    setFavorite(next);
    setFavoritePending(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/favorite`, {
        method: next ? "POST" : "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        // 回滚 UI
        setFavorite(!next);
        const data = await res.json().catch(() => ({}));
        toast.error(`${next ? "收藏" : "取消收藏"}失败：${data.error || `HTTP ${res.status}`}`);
      }
    } catch (err) {
      setFavorite(!next);
      toast.error(`${next ? "收藏" : "取消收藏"}失败：${(err as Error).message}`);
    } finally {
      setFavoritePending(false);
    }
  }, [favorite, favoritePending, task.id, toast]);

  // 客户端倒计时: 锚点变时重算 + 每秒 tick. 卸载 / 锚点清空时停掉.
  useEffect(() => {
    if (!timeoutAnchor) {
      setTimeoutRemainingMs(null);
      return;
    }
    const tick = () => {
      const remain = timeoutAnchor.startedAt + timeoutAnchor.timeoutMs - Date.now();
      setTimeoutRemainingMs(Math.max(0, remain));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timeoutAnchor]);

  // Subscribe to SSE for real-time status updates (标题脉冲 + 花费 + 上下文 + 倒计时锚点).
  // 共享单例: 与 TaskDetailClient 复用同一 EventSource, 避免重复长连接.
  useTaskStream(task.id, (event) => {
    if (event.type === "status_change" && event.to) {
      setLiveStatus(event.to as string);
      if (event.cost_usd != null) setLiveCost(event.cost_usd as number);
      if (event.context_tokens != null) setLiveContextTokens(event.context_tokens as number);
      if (event.context_max != null) setLiveContextMax(event.context_max as number);
      // 倒计时锚点: 仅 running 时维护; 非 running 立即清空(满足"不是 running 没必要了").
      if (event.to === "running") {
        const started = event.started_at as string | undefined;
        const tMs = event.timeout_ms as number | null | undefined;
        if (started && typeof tMs === "number" && tMs > 0) {
          setTimeoutAnchor({ startedAt: new Date(started).getTime(), timeoutMs: tMs });
        }
      } else {
        setTimeoutAnchor(null);
      }
    } else if (event.type === "cost") {
      if (event.cost_usd != null) setLiveCost(event.cost_usd as number);
    } else if (event.type === "tool_approval_request") {
      setPendingApprovalCount((c) => c + 1);
    } else if (event.type === "tool_approval_response") {
      setPendingApprovalCount((c) => Math.max(0, c - 1));
    }
  });

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-3">
      {/* Breadcrumb: 项目 › 项目名 › 版本名 (projectId…/versionId…) */}
      {project && (
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
          <Link href="/" className="hover:text-blue-600">项目</Link>
          <span>›</span>
          <Link href={`/${project.id}`} className="hover:text-blue-600">{project.name}</Link>
          <span>›</span>
          <Link
            href={version ? `/${project.id}/${version.id}` : `/${project.id}/unversioned`}
            className="text-gray-700 font-medium hover:text-blue-600"
          >
            {version?.name || "其他任务"}
          </Link>
          {version && (
            <span className="text-xs text-gray-400">
              ({project.id.slice(0, 8)}…/{version.id.slice(0, 8)}…)
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-gray-600 hover:text-gray-900 text-sm shrink-0">← 返回</button>
        {titleEditing ? (
          // R14 sub-1: 编辑态 input. 宽度按父容器, 1px 边框 + 蓝色提示是编辑中.
          // onBlur 触发保存, Enter / Esc 同理. disabled 控制 titleSaving 防双击.
          <input
            ref={titleInputRef}
            type="text"
            value={titleDraft}
            disabled={titleSaving}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => { if (!titleSaving) saveTitle(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                titleInputRef.current?.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setTitleDraft(task.title);
                setTitleEditing(false);
              }
            }}
            className={`text-lg font-semibold truncate flex-1 min-w-0 px-1.5 py-0.5 -mx-1.5 border border-blue-400 rounded outline-none focus:ring-2 focus:ring-blue-200 ${
              liveStatus === "reviewing" || pendingApprovalCount > 0
                ? "text-purple-700"
                : "text-gray-900"
            }`}
            aria-label="任务标题"
            maxLength={500}
          />
        ) : (
          // 默认 h1: hover 提示可编辑 (cursor + 浅蓝), 已删任务不进入编辑态.
          <h1
            onClick={() => { if (!task.deleted_at) setTitleEditing(true); }}
            title={task.deleted_at ? undefined : "点击直接编辑"}
            className={`text-lg font-semibold truncate flex-1 min-w-0 ${
              task.deleted_at ? "cursor-default" : "cursor-text hover:bg-blue-50 rounded px-1.5 py-0.5 -mx-1.5"
            } ${
              liveStatus === "reviewing" || pendingApprovalCount > 0
                ? "text-purple-700"
                : "text-gray-900"
            }`}
          >
            {(liveStatus === "reviewing" || pendingApprovalCount > 0) && "⚠️ "}
            {task.title}
          </h1>
        )}
        {/* v61+R39: 多类型 awaiting marker 角标. 优先读 awaiting_markers (新格式,
            JSON 数组), 缺省时回退 awaiting_owner_review=1 (老数据 / v56 marker 翻译).
            marker 颜色按 type 分: review=amber 等拍板, choice=blue 等选, info=gray
            提示, 其他=紫色. 多 marker 全显, 不聚合 (damo 拍板要尽量发挥空间).
            data={json} 字段本期不在 task-header 渲染 (后续 UI 弹选项卡可加). */}
        {parseAwaitingMarkers(task.awaiting_markers, task.awaiting_owner_review).map((m, idx) => (
          <span
            key={idx}
            className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${m.color}`}
            title={m.title}
          >
            {m.icon} {m.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 shrink-0">
          <span className="text-sm text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
          <CopyButton text={origin ? `${origin}/#/tasks/${task.id}` : `/#/tasks/${task.id}`} title="复制任务链接" />
        </span>
        {/* v57 (R15 task 收藏): ⭐ toggle 按钮. 收藏后变 ★ + 琥珀色.
            已删任务 (deleted_at 非空) 不允许收藏. */}
        {!task.deleted_at && (
          <button
            onClick={toggleFavorite}
            disabled={favoritePending}
            title={favorite ? "取消收藏" : "收藏这个任务"}
            aria-label={favorite ? "取消收藏" : "收藏"}
            aria-pressed={favorite}
            className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
              favorite
                ? "text-amber-500 hover:text-amber-600 hover:bg-amber-50"
                : "text-gray-300 hover:text-amber-400 hover:bg-amber-50"
            } ${favoritePending ? "opacity-60 cursor-wait" : ""}`}
          >
            <span className="text-base leading-none">{favorite ? "★" : "☆"}</span>
          </button>
        )}
      </div>
      {parentTask && (
        <div className="mt-1 text-sm text-gray-500 flex items-center gap-1">
          🔗 Fork 自{" "}
          <Link href={`/tasks/${parentTask.id}`} className="text-blue-600 hover:underline">{parentTask.title}</Link>
          <TaskIdBadge id={parentTask.id} />
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <TaskMetaRow
          model={modelName || task.resolved_model || task.model}
          effort={task.effort}
          maxTurns={task.max_turns}
          createdAt={task.created_at}
          contextTokens={liveContextTokens}
          contextMax={liveContextMax}
          cost={liveCost}
          timeoutRemainingMs={liveStatus === "running" ? timeoutRemainingMs : null}
          timeoutTotalMs={timeoutAnchor?.timeoutMs ?? null}
        />
        {/* 编辑超时按钮: 已删任务不显示; ✎ 触发弹窗 */}
        {!task.deleted_at && (
          <button
            onClick={() => setDialogOpen(true)}
            title="编辑单任务超时"
            className="text-gray-400 hover:text-blue-600 transition-colors p-1 rounded"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M2.695 14.763l-1.262 3.155a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.886L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
            </svg>
          </button>
        )}
      </div>
      <TaskTimeoutEditDialog
        open={dialogOpen}
        currentMinutes={timeoutOverrideMinutes ?? null}
        defaultMinutes={defaultTimeoutMinutes ?? null}
        taskId={task.id}
        onSaved={(newMinutes) => {
          setDialogOpen(false);
          // PATCH 成功后路由刷新, 让 server props (timeoutOverrideMinutes) 重新计算,
          //   SSE 已经推了新 timeout_ms, 倒计时会自动跟上.
          router.refresh();
        }}
        onCancel={() => setDialogOpen(false)}
      />
    </header>
  );
}
