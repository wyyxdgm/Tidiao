// Create task page - /tasks/new

"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EFFORT_LEVELS, DEFAULT_TOOLS, AVAILABLE_TOOLS, TASK_TYPES, TYPE_LABELS, TOOL_PRESETS } from "@/lib/constants";
import Select from "@/components/Select";
import { useToastActions } from "@/components/Toast";
import { useAvailableModels } from "@/lib/hooks/use-available-models";
import ConfirmDialog from "@/components/ConfirmDialog";

type Project = { id: string; name: string };
type Version = { id: string; project_id: string; name: string };

type SnapshotScope = "global" | "project" | "version";
type Snapshot = {
  id: string;
  name: string;
  description: string | null;
  scope: SnapshotScope;
  project_id: string | null;
  version_id: string | null;
  model: string | null;
  effort: string | null;
  max_turns: number | null;
  auto_approve: number | null;
  allowed_tools: string | null;
  tags: string | null;
  type: string | null;
  llm_config_id: string | null;
  created_at: string;
  updated_at: string;
};

// Config knobs passed from 完整配置 -> 模板配置 ("存为快照" prefill)
type SnapshotConfig = {
  model: string;
  llm_config_id?: string;
  effort: string;
  maxTurns: string;
  autoApprove: boolean;
  allowedTools: string[];
  tags: string;
  type: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Pure keydown predicate — extracted from the form handler so it can be
// unit-tested without a DOM. Mirrors the spec: Ctrl/Cmd+Enter inside a
// textfield triggers form submit; plain Enter / other combos / disabled state
// do nothing. The form handler adds the IME-guard (e.nativeEvent.isComposing)
// on top, since it's a DOM concern.
export interface SubmitKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  targetIsInputOrTextarea: boolean;
}

export function shouldTriggerSubmitOnKey(
  e: SubmitKeyEvent,
  opts: { submitting: boolean; canSubmit: boolean }
): boolean {
  if (e.key !== "Enter") return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (!e.targetIsInputOrTextarea) return false;
  if (opts.submitting || !opts.canSubmit) return false;
  return true;
}

// Pure click-submit predicate — mirrors the same early-return contract as
// shouldTriggerSubmitOnKey but for the click path. The handler uses a
// useRef-based sync lock (submitLockRef) so that fast-clicks arriving before
// the setSubmitting re-render can't slip through. This predicate abstracts
// the same "in-flight or invalid → block" rule so it's testable without
// rendering React. Refs are mutable, so the handler passes
// `submitLockRef.current` as `inFlight` on every call.
export function shouldBlockClickSubmit(opts: {
  inFlight: boolean;
  canSubmit: boolean;
}): boolean {
  if (opts.inFlight) return true;
  if (!opts.canSubmit) return true;
  return false;
}

// Spinner 显隐判断 (damo 2026-09-18 反馈: 创建按钮 loading 反馈太弱,
// 用户感知不到, 容易重复点). 抽成纯函数便于单测断言.
export function shouldShowSpinner(submitting: boolean): boolean {
  return submitting;
}

// 提交按钮文案: loading 时显示进度文案, 避免宽窄抖动 (固定 min-width)。
// quick / full / snapshot 三处都走这条规则, 单点统一.
export function getSubmitButtonLabel(
  mode: "quick" | "full" | "snapshot",
  submitting: boolean,
  snapshotEditing: boolean
): string {
  if (submitting) {
    return mode === "quick" ? "创建启动中..." : mode === "full" ? "创建中..." : "保存中...";
  }
  if (mode === "quick") return "创建并启动 →";
  if (mode === "full") return "创建任务";
  return snapshotEditing ? "保存修改" : "创建快照";
}

// Goal-driven loop UI 集成 (R143, damo 2026-09-15): 把结构化 goal_text 字段
//   拼回 prompt 文本，零 API 改动。
//   - basePrompt 为空 + goalText 非空 → 直接产出 `<goal>...</goal>` (agent 拿
//     到非空 prompt 即可启动 goal loop; quick 模式合法).
//   - goalText 为空 → 原样返回 basePrompt (向后兼容, 不污染普通 task prompt).
//   - goalText 已含 `<goal>` 字面 (用户手填) → 仍走拼路径, 不去重也不抛错,
//     API 端 regex 首匹配即可 —— 接受重复 marker 是 tolerant 行为, 跟
//     docs/usage/18-goal-loop.md §"怎么用" 的 `<goal>...</goal>` 写法一致.
//   关注点: 此函数是 UI 层唯一拼接点, 改 marker 语法需同步 4 处
//   (active-session.GOAL_MARKER_RE + goal-marker.GOAL_MARKER_RE + 3 API route).
//   UI 层沿用字面 `<goal>`, 不读 regex, 是有意为之 (regex 改 UI 不必跟).
export function buildGoalPrompt(
  basePrompt: string,
  goalText: string | undefined | null
): string {
  const trimmed = (goalText ?? "").trim();
  if (!trimmed) return basePrompt;
  if (!basePrompt) return `<goal>${trimmed}</goal>`;
  return `${basePrompt}\n\n<goal>${trimmed}</goal>`;
}

// R143 二轮: 把 UI 表单里的 goal_rounds 字符串字段转成 API 期望的数字/null.
//   "" → 不传, 走 settings 默认 (R143 二轮后默认 20).
//   非整数 / 越界 → null (不传), API 层校验报 400 (UI 不预校验, 错误集中服务端).
//   注: 没传 max_goal_rounds 时 continueGoalLoop 读 metadata.max_goal_rounds
//   缺省, 落回 getMaxGoalRounds() 全局设置.
export function parseGoalRoundsInput(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  return n;
}

// 提交按钮 spinner (damo 2026-09-18 反馈: 原版只切文案, 远看察觉不到
// loading 状态, 用户在 router.push 之前的窗口期重复点). 用 SVG 而非 CSS
// border 是为了避免 Tailwind preflight 移除默认 UA button 内边距/边框.
function ButtonSpinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 mr-2 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Builds the form-level onKeyDown handler. Re-derived each render (cheap),
// since the inputs (submitting / canSubmit) are stable primitives.
function makeFormKeyDown(
  submitting: boolean,
  canSubmit: boolean
): (e: React.KeyboardEvent<HTMLFormElement>) => void {
  return (e) => {
    // Skip IME composition (e.g. CJK input confirm) — pressing Enter to pick
    // a candidate should never trigger form submit.
    if (e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const ok = shouldTriggerSubmitOnKey(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        targetIsInputOrTextarea:
          target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement,
      },
      { submitting, canSubmit }
    );
    if (!ok) return;
    e.preventDefault();
    // requestSubmit() fires onSubmit → handleQuickSubmit / handleSubmit, which
    // already does POST + attachments + auto-start. Buttons in both forms are
    // already `type="submit"`, so this is identical to clicking "创建并启动 →".
    e.currentTarget.requestSubmit();
  };
}

function NewTaskForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { error: toastError } = useToastActions();
  const [submitting, setSubmitting] = useState(false);
  // 同步锁：防止 setSubmitting 异步生效前用户连续点击导致双 POST。
  // useState 在多次同步事件之间的更新不保证立即应用（React 18 batching），
  // 而 useRef.current 是同步读写的——这是表单防双提交的标准 idiom。
  const submitLockRef = useRef(false);

  const [mode, setMode] = useState<"quick" | "full" | "snapshots">("quick");
  const [quickPrompt, setQuickPrompt] = useState("");
  // Goal-driven loop UI (R143): quick 模式折叠. R143 三轮 (damo 2026-09-15):
  //   默认展开, 避免折叠按钮被忽略 → 体验上「quick 模式没 goal UI」的错觉.
  //   用户不填也不影响普通 task 提交 (goalText 空 → buildGoalPrompt 原样返回).
  //   R143 二轮: 多了 goalRounds (per-task max_goal_rounds 覆盖). 空串表示
  //   「不传, 走 settings 默认 20」.
  const [quickGoalOpen, setQuickGoalOpen] = useState(true);
  const [quickGoalText, setQuickGoalText] = useState("");
  const [quickGoalRounds, setQuickGoalRounds] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [projectId, setProjectId] = useState(searchParams.get("project") || "");
  const [versionId, setVersionId] = useState(searchParams.get("version") || "");

  const [form, setForm] = useState({
    title: "",
    prompt: "",
    description: "",
    cwd: "",
    model: "",
    llm_config_id: "",
    effort: "high",
    maxTurns: "200",
    autoApprove: true,
    priority: "0",
    allowedTools: DEFAULT_TOOLS,
    tags: "",
    dependsOn: [] as string[],
    type: "" as "" | "design" | "dev" | "test" | "deploy",
    // Goal-driven loop (R143): 完成条件独立输入, 提交时拼到 prompt 末尾.
    //   非空 + autoApprove=true → 命中 goal loop; 空 → 普通 task 行为不变.
    goal_text: "",
    // R143 二轮: per-task max_goal_rounds 覆盖. 空串 → 不传, 走 settings 默认 20.
    goal_rounds: "",
  });
  // v50: 可见的 LLM 配置 (自配 + 平台授权); 拉一次缓存
  const [availableLlmConfigs, setAvailableLlmConfigs] = useState<{ id: string; name: string; source: string; is_default: boolean }[]>([]);
  // Files staged for upload. Uploaded after task creation (two-step: the
  // task must exist to receive uploads), then their paths are appended to the
  // prompt via PATCH append_attachments before start.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Config snapshots (模板配置) - quick-mode switcher + URL auto-match
  const [applicableSnapshots, setApplicableSnapshots] = useState<Snapshot[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Snapshot | null>(null);
  const [snapPrefillConfig, setSnapPrefillConfig] = useState<SnapshotConfig | null>(null);
  const [snapPrefillKey, setSnapPrefillKey] = useState(0);
  const autoMatched = useRef(false);
  const urlProject = searchParams.get("project");
  const urlVersion = searchParams.get("version");

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => setProjects(data.projects || []))
      .catch(() => setProjects([]));
    // v50: 加载可见的 LLM 配置列表
    fetch("/api/user/llm-config/available")
      .then((res) => res.json())
      .then((data) => setAvailableLlmConfigs(data.configs || []))
      .catch(() => setAvailableLlmConfigs([]));
  }, []);

  const { options: modelOptions } = useAvailableModels();

  useEffect(() => {
    if (!projectId) {
      setVersions([]);
      setVersionId("");
      return;
    }
    fetch(`/api/versions?project=${projectId}`)
      .then((res) => res.json())
      .then((data) => {
        const nextVersions = data.versions || [];
        setVersions(nextVersions);
        setVersionId((current) =>
          current && nextVersions.some((version: Version) => version.id === current)
            ? current
            : ""
        );
      })
      .catch(() => {
        setVersions([]);
        setVersionId("");
      });
  }, [projectId]);

  function renderTaskLocationFields() {
    return (
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">项目 *</label>
          <Select
            value={projectId}
            onChange={(v) => { setProjectId(v); setVersionId(""); setSelectedSnapshot(null); }}
            options={[{ value: "", label: "请选择项目" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            placeholder="请选择项目"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">版本</label>
          <Select
            value={versionId}
            onChange={(v) => { setVersionId(v); setSelectedSnapshot(null); }}
            options={[{ value: "", label: "其他任务（无版本）" }, ...versions.map((v2) => ({ value: v2.id, label: v2.name }))]}
            disabled={!projectId}
          />
        </div>
      </div>
    );
  }

  // Dependency selector state
  const [depSearch, setDepSearch] = useState("");
  const [depDropdownOpen, setDepDropdownOpen] = useState(false);
  const [availableTasks, setAvailableTasks] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const depInputRef = useRef<HTMLInputElement>(null);

  // Fetch available tasks for dependency selector
  useEffect(() => {
    if (!depDropdownOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tasks?limit=100");
        if (!res.ok) return;
        const tasks = await res.json();
        if (cancelled) return;
        // Only show pending/completed tasks as candidates
        setAvailableTasks(
          tasks
            .filter((t: any) => ["pending", "completed", "queued", "paused"].includes(t.status))
            .map((t: any) => ({ id: t.id, title: t.title, status: t.status }))
        );
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [depDropdownOpen]);

  // Pre-fill from template URL params
  useEffect(() => {
    const name = searchParams.get("name");
    const prompt = searchParams.get("prompt");
    const model = searchParams.get("model");
    const llmConfigId = searchParams.get("llm_config_id");
    const effort = searchParams.get("effort");
    const maxTurns = searchParams.get("maxTurns");
    const autoApprove = searchParams.get("autoApprove");
    const tags = searchParams.get("tags");

    if (prompt) {
      setMode("full");
      setForm((f) => ({
        ...f,
        title: name || f.title,
        prompt: prompt || f.prompt,
        model: model || f.model,
        llm_config_id: llmConfigId || f.llm_config_id,
        effort: effort || f.effort,
        maxTurns: maxTurns || f.maxTurns,
        autoApprove: autoApprove === "true" || f.autoApprove,
        tags: tags || f.tags,
      }));
    }
  }, [searchParams]);

  // Apply a matched snapshot's config to the full-config form. URL-explicit
  // params (from the prompt-template prefill) win over the snapshot.
  function applySnapshotToForm(snap: Snapshot) {
    const sp = searchParams;
    setForm((f) => ({
      ...f,
      model: sp.get("model") ? f.model : (snap.model || f.model),
      llm_config_id: sp.get("llm_config_id") ? f.llm_config_id : (snap.llm_config_id || f.llm_config_id),
      effort: sp.get("effort") ? f.effort : (snap.effort || f.effort),
      maxTurns: sp.get("maxTurns") ? f.maxTurns : (snap.max_turns ? String(snap.max_turns) : f.maxTurns),
      autoApprove: sp.get("autoApprove") ? f.autoApprove : (snap.auto_approve !== null ? snap.auto_approve === 1 : f.autoApprove),
      allowedTools: snap.allowed_tools ? (JSON.parse(snap.allowed_tools) as string[]) : f.allowedTools,
      tags: sp.get("tags") ? f.tags : (snap.tags ? (JSON.parse(snap.tags) as string[]).join(",") : f.tags),
      type: (sp.get("type") ? f.type : (snap.type || f.type)) as typeof f.type,
    }));
  }

  // Fetch applicable snapshots for the current location; auto-match once on
  // URL-driven entry (?project=&version=). Most-specific first (version>project>global).
  useEffect(() => {
    if (!projectId && !versionId) {
      setApplicableSnapshots([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/config-snapshots?project=${projectId}&version=${versionId}`)
      .then((res) => res.json())
      .then((list: Snapshot[]) => {
        if (cancelled) return;
        setApplicableSnapshots(list);
        if (!autoMatched.current && (urlProject || urlVersion) && list.length > 0) {
          autoMatched.current = true;
          const best = list[0];
          setSelectedSnapshot(best);
          applySnapshotToForm(best);
        } else if (selectedSnapshot && !list.some((s) => s.id === selectedSnapshot.id)) {
          setSelectedSnapshot(null);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Re-fetch when switching to quick mode (new snapshots may have been created
    // in the snapshots tab) or when project/version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, versionId, mode === "quick"]);

  function toggleTool(tool: string) {
    setForm((f) => ({
      ...f,
      allowedTools: f.allowedTools.includes(tool)
        ? f.allowedTools.filter((t) => t !== tool)
        : [...f.allowedTools, tool],
    }));
  }

  async function uploadAttachments(taskId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const file of pendingFiles) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/tasks/${taskId}/attachments`, { method: "POST", body: fd });
        if (res.ok) {
          const data = await res.json();
          if (data.attachment?.id) ids.push(data.attachment.id);
        } else {
          const data = await res.json().catch(() => ({}));
          console.error("Attachment upload failed:", data.error);
        }
      } catch (err) {
        console.error("Attachment upload failed:", err);
      }
    }
    return ids;
  }

  function renderAttachments() {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">附件</label>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files);
            if (files.length) setPendingFiles((prev) => [...prev, ...files]);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="border border-dashed border-gray-300 rounded-lg p-4 text-center text-sm text-gray-500 cursor-pointer hover:border-blue-400 hover:bg-blue-50/30"
        >
          拖拽文件到此处，或点击选择（创建任务后自动上传，agent 按路径读取）
        </div>
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
        {pendingFiles.length > 0 && (
          <ul className="mt-2 space-y-1">
            {pendingFiles.map((f, i) => (
              <li key={i} className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                <span className="truncate">{f.name} <span className="text-gray-400">({formatSize(f.size)})</span></span>
                <button type="button" onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))} className="text-gray-400 hover:text-red-500 ml-2">×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (shouldBlockClickSubmit({ inFlight: submitLockRef.current, canSubmit: !!form.title && !!form.prompt })) return;
    submitLockRef.current = true;

    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          prompt: buildGoalPrompt(form.prompt, form.goal_text),
          description: form.description || undefined,
          cwd: form.cwd || undefined,
          model: form.model || undefined,
          llm_config_id: form.llm_config_id || undefined,
          effort: form.effort,
          maxTurns: parseInt(form.maxTurns) || undefined,
          autoApprove: form.autoApprove,
          priority: parseInt(form.priority) || 0,
          allowedTools: form.allowedTools,
          tags: form.tags ? form.tags.split(",").map((t) => t.trim()) : undefined,
          dependsOn: form.dependsOn.length > 0 ? form.dependsOn : undefined,
          project_id: projectId,
          version_id: versionId || undefined,
          type: form.type || undefined,
          // R143 二轮: per-task max_goal_rounds. 空 / 非法 → 不传, 落 settings 默认 20
          //   (R143 四轮后范围 [0, 1000], 0 = 不限轮次).
          goalRounds: parseGoalRoundsInput(form.goal_rounds) ?? undefined,
        }),
      });

      if (!res.ok) throw new Error("Failed to create task");
      const task = await res.json();
      // Two-step attachments: upload to the new task, then append their paths
      // to the prompt so the agent sees them at start.
      const attIds = await uploadAttachments(task.id);
      if (attIds.length > 0) {
        await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ append_attachments: attIds }),
        });
      }
      // Auto-start
      await fetch(`/api/tasks/${task.id}/start`, { method: "POST" });
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      console.error(err);
      toastError("创建失败");
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }

  async function handleQuickSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (shouldBlockClickSubmit({ inFlight: submitLockRef.current, canSubmit: !!quickPrompt.trim() && !!projectId })) return;
    submitLockRef.current = true;

    const s = selectedSnapshot;
    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: quickPrompt.length > 60 ? quickPrompt.slice(0, 60) + "..." : quickPrompt,
          prompt: buildGoalPrompt(quickPrompt, quickGoalText),
          autoApprove: s && s.auto_approve !== null ? s.auto_approve === 1 : true,
          effort: s?.effort || "high",
          maxTurns: s?.max_turns || 200,
          model: s?.model || undefined,
          llm_config_id: s?.llm_config_id || undefined,
          allowedTools: s?.allowed_tools ? JSON.parse(s.allowed_tools) : undefined,
          tags: s?.tags ? JSON.parse(s.tags) : undefined,
          type: s?.type || undefined,
          project_id: projectId,
          version_id: versionId || undefined,
          // R143 二轮: 同 full 模式, parse 后 undefined 时不传 goalRounds 字段.
          goalRounds: parseGoalRoundsInput(quickGoalRounds) ?? undefined,
        }),
      });

      if (!res.ok) throw new Error("Failed to create task");
      const task = await res.json();
      const attIds = await uploadAttachments(task.id);
      if (attIds.length > 0) {
        await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ append_attachments: attIds }),
        });
      }
      // Auto-start
      await fetch(`/api/tasks/${task.id}/start`, { method: "POST" });
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      console.error(err);
      toastError("创建失败");
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }

  return (
    // 🆕 飞书 R139 第五批: /tasks/new 右滚修复——同 schedules 套路.
    <div className="h-full flex flex-col">
      <header className="bg-white border-b px-6 py-4 shrink-0">
        <button onClick={() => router.back()} className="text-gray-600 hover:text-gray-900 text-sm">
          ← 返回
        </button>
        <h1 className="text-xl font-semibold mt-2">新建任务</h1>
        {/* Mode toggle */}
        <div className="flex gap-1 mt-3 bg-gray-100 rounded-lg p-0.5 w-fit">
          {([
            { key: "quick", label: "快速模式" },
            { key: "full", label: "完整配置" },
            { key: "snapshots", label: "模板配置" },
          ] as const).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setMode(t.key)}
              className={`px-3 py-1 rounded text-sm font-medium ${mode === t.key ? "bg-white shadow-sm" : "text-gray-500"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-2xl w-full mx-auto px-6 py-6">
        {mode === "quick" ? (
          /* Quick mode: just prompt, auto-create + auto-start. Config from
             selected snapshot (switcher) or hardcoded defaults. */
          <form
            onSubmit={handleQuickSubmit}
            onKeyDown={makeFormKeyDown(submitting, !!quickPrompt.trim() && !!projectId)}
            className="space-y-4"
          >
            {renderTaskLocationFields()}
            {/* Config snapshot switcher */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">配置</label>
              <Select
                value={selectedSnapshot?.id || ""}
                onChange={(id) => {
                  setSelectedSnapshot(id ? applicableSnapshots.find((s) => s.id === id) || null : null);
                }}
                options={[
                  { value: "", label: "默认配置（自动审批 · high · 200 轮）" },
                  ...applicableSnapshots.map((s) => ({
                    value: s.id,
                    label: `${s.name}${s.scope === "version" ? "（版本）" : s.scope === "project" ? "（项目）" : "（全局）"}`,
                  })),
                ]}
                disabled={applicableSnapshots.length === 0}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">任务指令 *</label>
              <textarea
                value={quickPrompt}
                onChange={(e) => setQuickPrompt(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm h-48 font-mono"
                placeholder="直接输入 agent 指令，例如：&#10;优化这个项目的 README 文档，补充使用示例&#10;&#10;将自动审批，创建后立即启动，模型用系统配置"
                autoFocus
              />
            </div>
            {/* Goal-driven loop (R143): 折叠区. 展开后填写完成条件 →
                提交时拼到 prompt 末尾, 触发 goal loop (需 autoApprove=true,
                快速模式默认即 true, 见上方快照/默认配置说明). */}
            <div>
              <button
                type="button"
                onClick={() => setQuickGoalOpen((v) => !v)}
                className="text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1"
              >
                <span>{quickGoalOpen ? "▾" : "▸"}</span>
                <span>{quickGoalOpen ? "收起完成条件" : "设置完成条件（goal loop，自动循环直到满足）"}</span>
              </button>
              {quickGoalOpen && (
                <div className="mt-2 pl-3 border-l-2 border-gray-200 space-y-2">
                  <textarea
                    value={quickGoalText}
                    onChange={(e) => setQuickGoalText(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm h-24 font-mono"
                    placeholder="例：docs/foo.md 第一段第一个词是 'bar'（且其他内容不变）"
                  />
                  {/* R143 二轮 + 四轮: quick 模式 goalRounds. 同 full 模式「没 goal_text
                      数字无效」规则, UI 显式禁用 + 警告.
                      R143 四轮 (damo 2026-09-15): 范围 [1, 20] → [0, 1000], 0 表示
                      「不限制轮次」(sentinel), 仅由 agent 主动 goal_report
                      [impossible] 或 grader met 才停. */}
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-600 shrink-0">最大轮次</label>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={quickGoalRounds}
                      onChange={(e) => setQuickGoalRounds(e.target.value)}
                      disabled={!quickGoalText.trim()}
                      placeholder="留空=默认 20, 0=不限"
                      className="w-28 border rounded px-2 py-1 text-xs font-mono disabled:bg-gray-50 disabled:text-gray-400"
                    />
                    <span className="text-xs text-gray-400">范围 [0, 1000], 0=不限</span>
                    {!quickGoalText.trim() && quickGoalRounds.trim() && (
                      <span className="text-xs text-amber-600">
                        ⚠ goal_text 为空, 该数字无效
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    提交时会拼成 <code>&lt;goal&gt;...&lt;/goal&gt;</code> 追加到指令末尾。grader（小模型）每轮判定 done / not_done / impossible，agent 也可在 goal_report 写 impossible 主动早停。最多 20 轮（默认）。
                  </p>
                </div>
              )}
            </div>
            {renderAttachments()}
            <div className="text-xs text-gray-500 bg-gray-50 rounded p-2">
              {selectedSnapshot ? (
                <>当前快照：{selectedSnapshot.name} · {selectedSnapshot.model || "默认模型"} · effort={selectedSnapshot.effort || "high"} · {selectedSnapshot.max_turns || 200} 轮 · {selectedSnapshot.auto_approve === 1 ? "自动审批" : selectedSnapshot.auto_approve === 0 ? "需审核" : "自动审批"}</>
              ) : (
                <>默认配置：自动审批 · effort=high · 200 轮 · 工作目录自动隔离 · 模型用个人/项目配置或环境变量 ANTHROPIC_MODEL</>
              )}
            </div>
            <button
              type="submit"
              disabled={submitting || !quickPrompt.trim() || !projectId}
              className="inline-flex items-center justify-center min-w-[140px] bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <ButtonSpinner />}
              {getSubmitButtonLabel("quick", submitting, false)}
            </button>
          </form>
        ) : mode === "full" ? (
        <form
          onSubmit={handleSubmit}
          onKeyDown={makeFormKeyDown(submitting, !!form.title && !!form.prompt && !!projectId)}
          className="space-y-5"
        >
          {renderTaskLocationFields()}
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">标题 *</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="修复 auth 模块登录 Bug"
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Prompt *</label>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm h-40 font-mono"
              placeholder="实际传给 agent 的指令..."
            />
          </div>

          {/* Goal-driven loop 完成条件 (R143). 提交时拼成 <goal>...</goal>
              追加到 prompt 末尾; 含 marker 必须 autoApprove=true (上方面板已
              默认 true; 切到"需逐个审核"会触发 API 400 GOAL_REQUIRES_AUTO_APPROVE).
              R143 二轮 + 四轮: 下方加「最大轮次」number input. 默认 20, 范围 [0, 1000],
              0 表示不限制轮次 (sentinel). 仅 goal_text 非空时启用 (没 goal_text 时
              传 number 也无效, UI 显式禁用). */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              完成条件（goal loop，可选）
            </label>
            <textarea
              value={form.goal_text}
              onChange={(e) => setForm({ ...form, goal_text: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm h-24 font-mono"
              placeholder="例：docs/foo.md 第一段第一个词是 'bar'（且其他内容不变）"
            />
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-gray-600 shrink-0">最大轮次</label>
              <input
                type="number"
                min={0}
                max={1000}
                value={form.goal_rounds}
                onChange={(e) => setForm({ ...form, goal_rounds: e.target.value })}
                disabled={!form.goal_text.trim()}
                placeholder="留空=默认 20, 0=不限"
                className="w-28 border rounded px-2 py-1 text-xs font-mono disabled:bg-gray-50 disabled:text-gray-400"
              />
              <span className="text-xs text-gray-400">范围 [0, 1000], 0=不限</span>
              {!form.goal_text.trim() && form.goal_rounds.trim() && (
                <span className="text-xs text-amber-600">
                  ⚠ goal_text 为空, 该数字无效
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              非空 → agent 跑完后 grader 小模型判定 done/not_done/impossible, 未达成自动续跑（最多 20 轮, 见 settings.goal_*）。详见 docs/usage/18-goal-loop.md。
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="任务说明（可选，不传给 agent）"
            />
          </div>

          {/* Row: CWD, Model, Effort, Priority */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">工作目录</label>
              <input
                type="text"
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="留空=自动隔离"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">任务类型</label>
              <Select
                value={form.type}
                onChange={(v) => setForm({ ...form, type: v as typeof form.type })}
                options={[{ value: "", label: "未分类" }, ...TASK_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))]}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">LLM 配置</label>
              <Select
                value={form.llm_config_id}
                onChange={(v) => setForm({ ...form, llm_config_id: v })}
                options={[
                  { value: "", label: "默认 (按解析链)" },
                  ...availableLlmConfigs.map((c) => ({
                    value: c.id,
                    label: `${c.source === "self" ? "我的" : "平台"} · ${c.name}${c.is_default ? " (默认)" : ""}`,
                  })),
                ]}
              />
              <p className="text-xs text-gray-500 mt-1">
                选「默认」按管理员/项目默认链解析；从下拉选具体配置即固定用该份。
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">模型覆盖 (高级)</label>
              <Select
                value={form.model}
                onChange={(v) => setForm({ ...form, model: v })}
                options={modelOptions}
                placeholder="留空使用 LLM 配置里的 model"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">推理强度</label>
              <Select
                value={form.effort}
                onChange={(v) => setForm({ ...form, effort: v })}
                options={EFFORT_LEVELS.map((e) => ({ value: e, label: e }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">优先级</label>
              <Select
                value={form.priority}
                onChange={(v) => setForm({ ...form, priority: v })}
                options={[
                  { value: "0", label: "低 (0)" },
                  { value: "5", label: "中 (5)" },
                  { value: "10", label: "高 (10)" },
                ]}
              />
            </div>
          </div>

          {/* Max turns + auto approve */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">最大轮次</label>
              <input
                type="number"
                value={form.maxTurns}
                onChange={(e) => setForm({ ...form, maxTurns: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                min="1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">工具审核</label>
              <Select
                value={form.autoApprove ? "on" : "off"}
                onChange={(v) => setForm({ ...form, autoApprove: v === "on" })}
                options={[
                  { value: "off", label: "需要逐个审核" },
                  { value: "on", label: "自动通过（不审核）" },
                ]}
              />
            </div>
          </div>

          {/* Allowed tools */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">允许的工具</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {TOOL_PRESETS.map((p) => {
                const active = p.tools.length === form.allowedTools.length && p.tools.every((t) => form.allowedTools.includes(t));
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setForm({ ...form, allowedTools: [...p.tools] })}
                    className={`px-2.5 py-1 rounded-full text-xs border ${active ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 text-gray-600 border-gray-300 hover:border-blue-400"}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_TOOLS.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => toggleTool(tool)}
                  className={`px-3 py-1 rounded text-sm ${
                    form.allowedTools.includes(tool)
                      ? "bg-blue-100 text-blue-700 border border-blue-300"
                      : "bg-gray-100 text-gray-500 border border-gray-200"
                  }`}
                >
                  {tool}
                </button>
              ))}
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">标签</label>
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="bugfix, auth（逗号分隔）"
            />
          </div>

          {/* Dependencies */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">依赖任务</label>
            <div className="relative">
              <div className="border rounded-lg px-3 py-2 text-sm flex flex-wrap gap-1 items-center min-h-[38px]">
                {form.dependsOn.map((depId) => {
                  const depTask = availableTasks.find((t) => t.id === depId);
                  return (
                    <span key={depId} className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-xs">
                      {depTask ? depTask.title.slice(0, 20) : depId.slice(0, 8)}
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, dependsOn: form.dependsOn.filter((id) => id !== depId) })}
                        className="text-blue-400 hover:text-blue-600"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                <input
                  ref={depInputRef}
                  type="text"
                  value={depSearch}
                  onChange={(e) => setDepSearch(e.target.value)}
                  onFocus={() => setDepDropdownOpen(true)}
                  placeholder={form.dependsOn.length === 0 ? "输入任务ID或搜索..." : ""}
                  className="flex-1 min-w-[120px] outline-none text-sm bg-transparent"
                />
              </div>
              {depDropdownOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setDepDropdownOpen(false)} />
                  <div className="absolute z-20 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {availableTasks
                      .filter((t) => !form.dependsOn.includes(t.id))
                      .filter((t) => {
                        if (!depSearch) return true;
                        const q = depSearch.toLowerCase();
                        return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
                      })
                      .length === 0 ? (
                      <div className="px-3 py-2 text-xs text-gray-400">
                        {depSearch ? "无匹配任务" : "无可选任务（仅显示待执行/已完成）"}
                      </div>
                    ) : (
                      availableTasks
                        .filter((t) => !form.dependsOn.includes(t.id))
                        .filter((t) => {
                          if (!depSearch) return true;
                          const q = depSearch.toLowerCase();
                          return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
                        })
                        .map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-2"
                            onClick={() => {
                              setForm({ ...form, dependsOn: [...form.dependsOn, t.id] });
                              setDepSearch("");
                              depInputRef.current?.focus();
                            }}
                          >
                            <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                              t.status === "completed" ? "bg-emerald-400" :
                              t.status === "running" ? "bg-sky-400" :
                              t.status === "queued" ? "bg-blue-400" :
                              "bg-gray-400"
                            }`} />
                            <span className="truncate">{t.title}</span>
                            <span className="text-xs text-gray-400 shrink-0">#{t.id.slice(0, 8)}</span>
                          </button>
                        ))
                    )}
                  </div>
                </>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">依赖任务完成后才会启动此任务</p>
          </div>

          {/* Attachments */}
          {renderAttachments()}

          {/* Submit */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || !form.title || !form.prompt || !projectId}
              className="inline-flex items-center justify-center min-w-[120px] bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <ButtonSpinner />}
              {getSubmitButtonLabel("full", submitting, false)}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="border border-gray-300 text-gray-700 px-6 py-2 rounded-lg text-sm"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                setSnapPrefillConfig({
                  model: form.model,
                  llm_config_id: form.llm_config_id,
                  effort: form.effort,
                  maxTurns: form.maxTurns,
                  autoApprove: form.autoApprove,
                  allowedTools: form.allowedTools,
                  tags: form.tags,
                  type: form.type,
                });
                setSnapPrefillKey((k) => k + 1);
                setMode("snapshots");
              }}
              className="border border-blue-300 text-blue-600 px-6 py-2 rounded-lg text-sm hover:bg-blue-50"
            >
              存为快照
            </button>
          </div>
        </form>
        ) : (
          <SnapshotManager
            projects={projects}
            availableLlmConfigs={availableLlmConfigs}
            initialProjectId={projectId}
            initialVersionId={versionId}
            prefillConfig={snapPrefillConfig}
            prefillKey={snapPrefillKey}
          />
        )}
      </main>
    </div>
  );
}

// ---- 模板配置 tab: manage config snapshots (CRUD) ----

function SnapshotManager({
  projects,
  availableLlmConfigs,
  initialProjectId,
  initialVersionId,
  prefillConfig,
  prefillKey,
}: {
  projects: Project[];
  availableLlmConfigs: { id: string; name: string; source: string; is_default: boolean }[];
  initialProjectId: string;
  initialVersionId: string;
  prefillConfig: SnapshotConfig | null;
  prefillKey: number;
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const { error: toastError } = useToastActions();
  const [showForm, setShowForm] = useState(false);
  const { options: modelOptions } = useAvailableModels();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);

  const [form, setForm] = useState({
    name: "",
    description: "",
    scope: "global" as SnapshotScope,
    bindProjectId: "",
    bindVersionId: "",
    model: "",
    llm_config_id: "",
    effort: "",
    maxTurns: "",
    autoApprove: "" as "" | "on" | "off", // "" = inherit
    allowedTools: DEFAULT_TOOLS,
    tags: "",
    type: "",
  });
  const [bindVersions, setBindVersions] = useState<Version[]>([]);
  const lastPrefillKey = useRef(0);

  const fetchSnapshots = useCallback(async () => {
    try {
      const res = await fetch("/api/config-snapshots");
      if (res.ok) setSnapshots(await res.json());
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSnapshots(); }, [fetchSnapshots]);

  // Load versions for the binding project selector
  useEffect(() => {
    if (!form.bindProjectId) { setBindVersions([]); return; }
    fetch(`/api/versions?project=${form.bindProjectId}`)
      .then((r) => r.json())
      .then((d) => setBindVersions(d.versions || []))
      .catch(() => setBindVersions([]));
  }, [form.bindProjectId]);

  // Prefill from 完整配置 "存为快照"
  useEffect(() => {
    if (prefillKey === lastPrefillKey.current || !prefillConfig) return;
    lastPrefillKey.current = prefillKey;
    const scope: SnapshotScope = initialVersionId ? "version" : initialProjectId ? "project" : "global";
    setForm((f) => ({
      ...f,
      name: "",
      description: "",
      scope,
      bindProjectId: initialProjectId,
      bindVersionId: initialVersionId,
      model: prefillConfig.model,
      llm_config_id: prefillConfig.llm_config_id || "",
      effort: prefillConfig.effort,
      maxTurns: prefillConfig.maxTurns,
      autoApprove: prefillConfig.autoApprove ? "on" : "off",
      allowedTools: prefillConfig.allowedTools,
      tags: prefillConfig.tags,
      type: prefillConfig.type,
    }));
    setEditingId(null);
    setShowForm(true);
  }, [prefillKey, prefillConfig, initialProjectId, initialVersionId]);

  function resetForm() {
    setForm({
      name: "", description: "", scope: "global", bindProjectId: "", bindVersionId: "",
      model: "", llm_config_id: "", effort: "", maxTurns: "", autoApprove: "",
      allowedTools: DEFAULT_TOOLS, tags: "", type: "",
    });
    setEditingId(null);
  }

  function toggleTool(tool: string) {
    setForm((f) => ({
      ...f,
      allowedTools: f.allowedTools.includes(tool)
        ? f.allowedTools.filter((t) => t !== tool)
        : [...f.allowedTools, tool],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name) return;
    setSubmitting(true);
    try {
      const body = {
        name: form.name,
        description: form.description || undefined,
        scope: form.scope,
        projectId: form.scope === "global" ? undefined : form.bindProjectId,
        versionId: form.scope === "version" ? form.bindVersionId : undefined,
        model: form.model || undefined,
        llm_config_id: form.llm_config_id || undefined,
        effort: form.effort || undefined,
        maxTurns: form.maxTurns ? parseInt(form.maxTurns) : undefined,
        autoApprove: form.autoApprove === "" ? undefined : form.autoApprove === "on",
        allowedTools: form.allowedTools,
        tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
        type: form.type || undefined,
      };
      const res = await fetch(
        editingId ? `/api/config-snapshots/${editingId}` : "/api/config-snapshots",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || "保存失败");
        return;
      }
      setShowForm(false);
      resetForm();
      fetchSnapshots();
    } catch {
      toastError("保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(s: Snapshot) {
    const parsedTools = s.allowed_tools ? (() => { try { return JSON.parse(s.allowed_tools); } catch { return DEFAULT_TOOLS; } })() : DEFAULT_TOOLS;
    const parsedTags = s.tags ? (() => { try { return JSON.parse(s.tags).join(","); } catch { return ""; } })() : "";
    setForm({
      name: s.name,
      description: s.description || "",
      scope: s.scope,
      bindProjectId: s.project_id || "",
      bindVersionId: s.version_id || "",
      model: s.model || "",
      llm_config_id: s.llm_config_id || "",
      effort: s.effort || "",
      maxTurns: s.max_turns ? String(s.max_turns) : "",
      autoApprove: s.auto_approve === null ? "" : s.auto_approve === 1 ? "on" : "off",
      allowedTools: parsedTools,
      tags: parsedTags,
      type: s.type || "",
    });
    setEditingId(s.id);
    setShowForm(true);
  }

  async function confirmDeleteSnapshot() {
    const id = deleteConfirm?.id;
    if (!id) return;
    try {
      const res = await fetch(`/api/config-snapshots/${id}`, { method: "DELETE" });
      if (res.ok) fetchSnapshots();
      else toastError("删除失败");
    } catch { toastError("删除失败"); }
    finally { setDeleteConfirm(null); }
  }

  function projectName(id: string | null): string {
    if (!id) return "";
    return projects.find((p) => p.id === id)?.name || id.slice(0, 8);
  }

  function scopeLabel(s: Snapshot): string {
    if (s.scope === "global") return "全局";
    if (s.scope === "project") return `项目: ${projectName(s.project_id)}`;
    return `版本: ${projectName(s.project_id)} / ${s.version_id?.slice(0, 8)}`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">保存常用配置为命名快照，快速模式可切换，URL 带 project/version 时自动套用</p>
        <button
          onClick={() => { if (showForm) resetForm(); setShowForm(!showForm); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          {showForm ? "取消" : "+ 新建快照"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-5 mb-6 space-y-4">
          <h2 className="text-lg font-semibold">{editingId ? "编辑快照" : "新建快照"}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">名称 *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="例如：谨慎审查模式"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">说明</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="可选"
            />
          </div>

          {/* Scope + binding */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">作用范围 *</label>
              <Select
                value={form.scope}
                onChange={(v) => setForm({ ...form, scope: v as SnapshotScope, bindVersionId: "" })}
                options={[
                  { value: "global", label: "全局（任意项目可用）" },
                  { value: "project", label: "绑定项目" },
                  { value: "version", label: "绑定版本" },
                ]}
              />
            </div>
            {form.scope !== "global" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">项目 *</label>
                <Select
                  value={form.bindProjectId}
                  onChange={(v) => setForm({ ...form, bindProjectId: v, bindVersionId: "" })}
                  options={[{ value: "", label: "请选择项目" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                  placeholder="请选择项目"
                />
              </div>
            )}
            {form.scope === "version" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">版本 *</label>
                <Select
                  value={form.bindVersionId}
                  onChange={(v) => setForm({ ...form, bindVersionId: v })}
                  options={[{ value: "", label: "请选择版本" }, ...bindVersions.map((bv) => ({ value: bv.id, label: bv.name }))]}
                  disabled={!form.bindProjectId}
                  placeholder="请选择版本"
                />
              </div>
            )}
          </div>

          {/* Config knobs */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">模型</label>
              <Select
                value={form.model}
                onChange={(v) => setForm({ ...form, model: v })}
                options={modelOptions}
                placeholder="继承默认 / 选择 / 自定义"
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">LLM 配置</label>
              <Select
                value={form.llm_config_id}
                onChange={(v) => setForm({ ...form, llm_config_id: v })}
                options={[
                  { value: "", label: "继承默认 (按解析链)" },
                  ...availableLlmConfigs.map((c) => ({
                    value: c.id,
                    label: `${c.source === "self" ? "我的" : "平台"} · ${c.name}${c.is_default ? " (默认)" : ""}`,
                  })),
                ]}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">推理强度</label>
              <Select
                value={form.effort}
                onChange={(v) => setForm({ ...form, effort: v })}
                options={[{ value: "", label: "继承默认" }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))]}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">最大轮次</label>
              <input
                type="number"
                value={form.maxTurns}
                onChange={(e) => setForm({ ...form, maxTurns: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="继承默认"
                min="1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">任务类型</label>
              <Select
                value={form.type}
                onChange={(v) => setForm({ ...form, type: v })}
                options={[{ value: "", label: "未分类" }, ...TASK_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))]}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">工具审核</label>
              <Select
                value={form.autoApprove}
                onChange={(v) => setForm({ ...form, autoApprove: v as "" | "on" | "off" })}
                options={[
                  { value: "", label: "继承默认" },
                  { value: "off", label: "需要逐个审核" },
                  { value: "on", label: "自动通过（不审核）" },
                ]}
              />
            </div>
          </div>

          {/* Allowed tools */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">允许的工具</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {TOOL_PRESETS.map((p) => {
                const active = p.tools.length === form.allowedTools.length && p.tools.every((t) => form.allowedTools.includes(t));
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setForm({ ...form, allowedTools: [...p.tools] })}
                    className={`px-2.5 py-1 rounded-full text-xs border ${active ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 text-gray-600 border-gray-300 hover:border-blue-400"}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_TOOLS.map((tool) => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => toggleTool(tool)}
                  className={`px-3 py-1 rounded text-sm ${
                    form.allowedTools.includes(tool)
                      ? "bg-blue-100 text-blue-700 border border-blue-300"
                      : "bg-gray-100 text-gray-500 border border-gray-200"
                  }`}
                >
                  {tool}
                </button>
              ))}
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">标签</label>
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="bugfix, auth（逗号分隔）"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting || !form.name || (form.scope !== "global" && !form.bindProjectId) || (form.scope === "version" && !form.bindVersionId)}
              className="inline-flex items-center justify-center min-w-[120px] bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <ButtonSpinner />}
              {getSubmitButtonLabel("snapshot", submitting, !!editingId)}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              className="border border-gray-300 text-gray-700 px-6 py-2 rounded-lg text-sm"
            >
              取消
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center py-20 text-gray-400">加载中...</div>
      ) : snapshots.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-lg mb-2">暂无配置快照</p>
          <p className="text-sm text-gray-400">在完整配置下点"存为快照"，或在此新建</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {snapshots.map((s) => {
            const toolCount = s.allowed_tools ? (() => { try { return JSON.parse(s.allowed_tools).length; } catch { return 0; } })() : 0;
            return (
              <div key={s.id} className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-col">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium text-gray-900 truncate">{s.name}</h3>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => startEdit(s)} className="text-xs text-blue-500 hover:text-blue-700">编辑</button>
                    <button
                      onClick={() => setDeleteConfirm({ id: s.id, name: s.name })}
                      className="text-xs text-gray-400 hover:text-red-500"
                    >删除</button>
                  </div>
                </div>
                {s.description && <p className="text-sm text-gray-500 mt-1 line-clamp-2">{s.description}</p>}
                <div className="mt-2">
                  <span className="inline-block bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded">{scopeLabel(s)}</span>
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 flex-wrap">
                  {s.model && <span>{s.model}</span>}
                  {s.llm_config_id && (
                    <span>LLM: {availableLlmConfigs.find((c) => c.id === s.llm_config_id)?.name || s.llm_config_id.slice(0, 8)}</span>
                  )}
                  {s.effort && <span>{s.effort}</span>}
                  {s.max_turns && <span>{s.max_turns} 轮</span>}
                  {s.auto_approve !== null && <span>{s.auto_approve === 1 ? "自动审批" : "需审核"}</span>}
                  {toolCount > 0 && <span>{toolCount} 工具</span>}
                  {s.type && <span>{TYPE_LABELS[s.type] || s.type}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        title="删除快照"
        message={`删除快照「${deleteConfirm?.name ?? ""}」？`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={confirmDeleteSnapshot}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}

export default function NewTaskPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400">加载中...</div>}>
      <NewTaskForm />
    </Suspense>
  );
}
