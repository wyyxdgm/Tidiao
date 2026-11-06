"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import AccountSwitcher from "@/components/AccountSwitcher";
import ConfirmDialog from "@/components/ConfirmDialog";
import Select from "@/components/Select";
import { useToastActions } from "@/components/Toast";
import { useAvailableModels } from "@/lib/hooks/use-available-models";
import {
  MAX_EXTRA_EXTENSIONS,
  SUGGESTED_EXTENSIONS,
  normalizeExtensionsInput,
  parseStoredExtensions,
} from "@/lib/wiki-files";
import { normalizeSheetUrl } from "@/lib/feishu/url";

// 功能: 把库里 ports JSON 数组字符串解析回 number[]. 脏值 (NULL/空串/非 JSON/
// 非数组) → 空数组, 让 UI 显示空而不是炸. 同 parseStoredExtensions 的
// 「脏值降级」语义.
function parseStoredPorts(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => Number.isInteger(x));
  } catch {
    return [];
  }
}

// 同目录并发上限 / 任务超时的 UI 边界。权威校验在服务端 src/lib/db/projects.ts
// (MAX_PARALLEL_LIMIT) 和 src/lib/db/settings.ts (MIN/MAX_TASK_TIMEOUT_MINUTES)
// —— 这里不 import 那两个模块, 它们引了 better-sqlite3(server only)。
const MAX_PARALLEL_LIMIT = 10;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 1440;
// R51: 单项目最多配的 runner entry 条数. 后端 updateProject 还会校 command_patterns 上限
// (MAX_COMMAND_PATTERNS=32), 这里管「entry 数」(避免 UI 起 100 条).
const MAX_RUNNER_ENTRIES = 16;

// 把库里 JSON 字符串解析回 RunnerDraftEntry[]. 与 routing.ts 的 parseStoredRunners 用同样的
// 「脏值降级」: NULL/空串/非数组 → []. 单条缺字段/字段类型错 → 静默丢弃 (不给 UI 报错;
// 服务端 validateRunnerEntry 已经会兜底).
function parseStoredRunners(raw: string | null | undefined): RunnerDraftEntry[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e === "object")
      .map((e) => ({
        runner_id: typeof e.runner_id === "string" ? e.runner_id : "",
        purpose: typeof e.purpose === "string" ? e.purpose : "",
        cwd_mapping: typeof e.cwd_mapping === "string" ? e.cwd_mapping : "",
        // 把 string[] 用换行拼回, 提交时再 split. 失去空行语义但保持 UI 单行编辑体感.
        command_patterns: Array.isArray(e.command_patterns)
          ? e.command_patterns.filter((p: unknown) => typeof p === "string").join("\n")
          : "",
        // α (damo 0829): 旧 entry 无 os_type = 不解析出 os_type 字段 = 提交时不带
        // (向后兼容, 与 db projects.ts 的 validateRunnerEntry 行为一致).
        os_type:
          typeof e.os_type === "string" &&
          (e.os_type === "macos" || e.os_type === "windows" || e.os_type === "linux")
            ? e.os_type
            : undefined,
      }))
      .filter((e) => e.runner_id);
  } catch {
    return [];
  }
}

type Project = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  current_version_id: string | null;
  current_version_name: string | null;
  pinned?: number;
  wiki_extra_extensions?: string | null; // v35 wiki 高级选项, JSON 数组串
  parallel_limit?: number | null; // v38 同 cwd 并发上限, 1/null = 串行
  timeout_minutes?: number | null; // v40 壁钟超时(分钟), null = 继承全局默认
  ports?: string | null; // R18 v54 项目级端口 JSON 数组串, UI 高级选项面板编辑
  runners?: string | null; // R51 (R4): JSON 数组, 每条 = {runner_id, purpose, cwd_mapping, command_patterns}
};

// R51: 本项目配的 runners 草稿. 多条 entry (可选多个 runner, 每个独立 purpose + patterns).
// UI 一次只编辑「一条」: 选 runner → 填 purpose → 填 cwd_mapping → 填 patterns → 加到列表.
// 「保存」按钮一次性把整条数组 PATCH 过去.
type RunnerDraftEntry = {
  runner_id: string;
  purpose: string;
  cwd_mapping: string;
  command_patterns: string; // textarea 内容, 提交前 split("\n").filter(Boolean)
  // α (damo 0829): os_type —— 从所选 runner 的 runOptions 自动取, 不让用户手填
  //   (防错配). 提交时如果有就带上 (与后端 ProjectRunnerEntry.os_type 对齐);
  //   没取到 (runOptions 还没加载好) = 不带, 后端视为不限 OS (向后兼容).
  os_type?: string;
};

type Version = {
  id: string;
  project_id: string;
  name: string;
  is_released: number;
  feishu_url: string | null;
  feishu_sheet: string | null;
};

type Stats = {
  tasks?: Record<string, number>;
};

type ScopeCounts = {
  running: number;
  reviewing: number;
  total: number;
};

export default function ProjectsClient({ userEmail = "" }: { userEmail?: string }) {
  const toast = useToastActions();
  const [projects, setProjects] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scopeCounts, setScopeCounts] = useState<Record<string, ScopeCounts>>({});
  const [loading, setLoading] = useState(true);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: "danger" | "default";
    onConfirm: () => void;
  } | null>(null);
  const [creating, setCreating] = useState<"project" | "version" | null>(null);
  // Skill-first P0 #6: 项目模板（仓内 JSON，前端 fetch）。展开状态下显示列表，
  // 选模板只预填 name/description；tasks/roles 暂不自动创建，引导用户看 docs/usage/19-templates.md。
  type ProjectTemplate = {
    id: string;
    name: string;
    description: string;
    category?: string;
    estimated_minutes?: number;
    icon?: string;
    project?: { name?: string; description?: string; cwd?: string };
  };
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplate[]>([]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  // v54 (R18): 项目新建时允许填端口 (逗号分隔, 最多 5 个, 1024-65535)。
  // 后端 normalizeProjects / normalizePorts 负责校验, 这里只收集字符串。
  const [newPorts, setNewPorts] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [newFeishuUrl, setNewFeishuUrl] = useState("");
  const [newFeishuSheet, setNewFeishuSheet] = useState("");
  const [editingVersion, setEditingVersion] = useState<string | null>(null);
  const [editFeishuUrl, setEditFeishuUrl] = useState("");
  const [editFeishuSheet, setEditFeishuSheet] = useState("");
  // Project LLM config state (v50 多配置 + list)
  //   - 一次只展开一个项目面板 (editingLlmProject), 配置列表按面板打开时拉取
  //   - editingLlmConfigId: null=列表态, "new"=新增表单, string=编辑对应 id 的表单
  //   - 协议 type 当前固定 anthropic, UI 不暴露选择 (plan 决策: 暂不开放其它协议)
  type ProjectLlmConfig = {
    id: string;
    owner_type: "project";
    owner_id: string;
    name: string;
    type: string;
    api_key_masked: string | null;
    has_api_key: boolean;
    base_url: string | null;
    model: string | null;
    is_default: boolean;
  };
  type ProjectLlmDraft = {
    name: string;
    base_url: string;
    model: string;
    api_key: string;
    clear_api_key: boolean;
  };
  const [editingLlmProject, setEditingLlmProject] = useState<string | null>(null);
  const [llmConfigs, setLlmConfigs] = useState<ProjectLlmConfig[]>([]);
  const [editingLlmConfigId, setEditingLlmConfigId] = useState<string | "new" | null>(null);
  const [llmDraft, setLlmDraft] = useState<ProjectLlmDraft>({
    name: "",
    base_url: "",
    model: "",
    api_key: "",
    clear_api_key: false,
  });
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  // 高级选项面板 (v35 wiki 扩展名 + v38 同 cwd 并发上限 + v40 任务超时): 哪个项目
  // 的面板展开 + 输入框内容. 默认收起, 不干扰主流程. 三项共用一个「保存」按钮,
  // 一次 PATCH 发全.
  const [editingWikiProject, setEditingWikiProject] = useState<string | null>(null);
  const [wikiExtInput, setWikiExtInput] = useState("");
  const [parallelInput, setParallelInput] = useState("1");
  // 空字符串 = 继承全局默认(PATCH 发 null).
  const [timeoutInput, setTimeoutInput] = useState("");
  // R18 P2: 端口输入草稿. 空 = 清空 (PATCH 发 null).
  const [portsInput, setPortsInput] = useState("");
  // R51 (R4): Runners 草稿.
  //   - runOptions: 从 /api/runners 拉回来的候选 runner 列表 (admin only).
  //   - runnerEntries: 当前面板编辑中的多条 entry (textarea 内容不立刻 split,
  //     让用户能编辑带空行的多行字符串 —— 提交前 split("\n").filter(Boolean)).
  //   - draftEntry: 「正在新增」的 entry 草稿, 「加入列表」push 到 runnerEntries.
  type RunnerOption = {
    id: string;
    name: string;
    host: string;
    port: number;
    os_type: "macos" | "windows" | "linux";
    status: "online" | "offline" | "dead";
  };
  const [runOptions, setRunOptions] = useState<RunnerOption[]>([]);
  const [runnerEntries, setRunnerEntries] = useState<RunnerDraftEntry[]>([]);
  const [draftRunnerId, setDraftRunnerId] = useState("");
  const [draftPurpose, setDraftPurpose] = useState("");
  const [draftCwdMapping, setDraftCwdMapping] = useState("");
  const [draftPatterns, setDraftPatterns] = useState("");
  const [wikiSaving, setWikiSaving] = useState(false);

  // Sort key for the project list. Persisted in localStorage so each user
  // keeps their preferred view across reloads / new tabs. The DB layer
  // (listProjects) also always orders pinned-first regardless of this.
  const [sort, setSort] = useState<"created_at" | "recent_activity">("created_at");

  // R56-B4 模型下拉统一: 走 useAvailableModels() 拿 configured + builtin + used
  // 三源并集 (其他 5 处 settings / tasks/new / chat-view / task-detail /
  // templates 都在用同一 hook), 不再维护本地 MODEL_OPTIONS 副本.
  const { options: modelOptions } = useAvailableModels();

  async function refresh() {
    const [p, v, s, c] = await Promise.all([
      fetch(`/api/projects?sort=${sort}`).then((r) => r.json()),
      fetch("/api/versions").then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/stats/counts").then((r) => r.json()),
    ]);
    setProjects(p.projects || []);
    setVersions(v.versions || []);
    setStats(s);
    setScopeCounts(c || {});
    setLoading(false);
  }

  // Hydrate sort preference from localStorage on first client render. Done
  // in an effect (not during useState init) to avoid SSR/CSR mismatch — the
  // server always renders the default, then we swap to the user's choice.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("projects:sort");
      if (saved === "created_at" || saved === "recent_activity") setSort(saved);
    } catch {
      // localStorage may be unavailable (private mode, blocked); ignore.
    }
  }, []);

  // Re-fetch when sort changes. Writes through to localStorage so the
  // preference survives reloads; the next effect-driven refresh uses it.
  useEffect(() => {
    try {
      localStorage.setItem("projects:sort", sort);
    } catch {
      // ignore
    }
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  // Skill-first P0 #6: 拉项目模板（仓内 JSON, read-only）。
  // 不鉴权（出厂模板公开）；失败降级为 [], 按钮不显示。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/project-templates");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.templates)) {
          setProjectTemplates(data.templates);
        }
      } catch {
        // graceful 退化：模板不可用时隐藏按钮，不影响主流程
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Skill-first P0 #6: 从模板预填表单。tasks/roles 不自动创建 —— 弹 toast
  // 引导用户看 docs/usage/19-templates.md 步骤手动建, 避免一次性复杂 UI。
  function applyProjectTemplate(t: ProjectTemplate) {
    setNewName(t.project?.name ?? t.id);
    setNewDescription(t.project?.description ?? t.description);
    if (t.project?.cwd) {
      setNewPorts(""); // cwd 在 quickstart 任务里另设, 这里不混
    }
    setCreating("project");
    setShowTemplatePicker(false);
    const extraHints = t.id === "requirement-collab"
      ? "（记得建 version 时填 feishu_url + feishu_sheet）"
      : t.id === "long-running-dev"
      ? "（建完后看 19-templates.md §长跑开发 手动建 dev/test 角色 + DAG 任务）"
      : "";
    toast.success(`已预填 ${t.icon ?? ""} ${t.name} 模板${extraHints}`);
  }

  function renderCountBadge(counts: ScopeCounts | undefined) {
    if (!counts || counts.total === 0) return null;
    return (
      <span className="text-xs tabular-nums flex items-center gap-1">
        {counts.running > 0 && <span className="text-blue-600">{counts.running}运行</span>}
        {counts.reviewing > 0 && (
          <span className="bg-purple-100 text-purple-700 rounded-full px-1.5 text-[10px] font-semibold leading-none">{counts.reviewing}审核</span>
        )}
        <span className="text-gray-400">{counts.total}</span>
      </span>
    );
  }

  async function createProject() {
    if (!newName.trim()) return;
    // v54 (R18): 端口输入。空串 = 不传 (后端写 NULL); 非空 = 逗号分隔字符串,
    // 后端 normalizePorts 校验 (1024-65535, 最多 5, 去重)。
    const portsStr = newPorts.trim();
    const body: Record<string, unknown> = {
      name: newName.trim(),
      description: newDescription || undefined,
    };
    if (portsStr) body.ports = portsStr;
    // 检查 res.ok: 重名会回 409（partial unique index 只拦「活」项目, 软删的同名
    // 项目不占名字）, 不检查的话弹窗照常关闭 + 列表没新增 = 又一次静默失败.
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // R18 P2: 端口池冲突是结构化 409, 后端带 conflict 明细. 把 outOfPool 和
      // conflicting 各自拼一句给用户看, 比单纯 toast 后端 message 信息密度高.
      if (data.code === "PORT_POOL_CONFLICT" && data.conflict) {
        const c = data.conflict as {
          outOfPool?: number[];
          conflicting?: Array<{ port: number; owner_project_id: string }>;
        };
        const parts: string[] = [];
        if (c.outOfPool && c.outOfPool.length > 0) {
          parts.push(`不在端口池内: ${c.outOfPool.join(", ")}`);
        }
        if (c.conflicting && c.conflicting.length > 0) {
          const used = c.conflicting
            .map(
              (x) =>
                `${x.port}（被项目 ${x.owner_project_id.slice(0, 8)} 占用）`,
            )
            .join(", ");
          parts.push(`与其它项目冲突: ${used}`);
        }
        toast.error(`端口冲突 — ${parts.join("; ")}`);
        return;
      }
      toast.error(`创建项目失败：${data.error || `HTTP ${res.status}`}`);
      return;
    }
    setNewName("");
    setNewDescription("");
    setNewPorts("");
    setCreating(null);
    setLoading(true);
    await refresh();
  }

  // R18 P2: 「从池里自动选可用端口」按钮. 调 GET /api/port-pool/available 拿
  // 前 N 个池内未占用端口, 写入 newPorts (逗号分隔) 让用户看见再改.
  async function autoPickPorts() {
    try {
      const res = await fetch("/api/port-pool/available?n=5");
      if (!res.ok) {
        toast.error(`自动选端口失败: HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      const list: number[] = data.available || [];
      if (list.length === 0) {
        toast.error("端口池已无可用端口, 请联系 admin 扩容");
        return;
      }
      setNewPorts(list.join(", "));
      toast.success(`已选 ${list.length} 个可用端口: ${list.join(", ")}`);
    } catch (err) {
      toast.error(`自动选端口失败: ${(err as Error).message}`);
    }
  }

  async function createVersion(projectId: string) {
    if (!newName.trim()) return;
    // 写库前归一化:把 ?sheet=xxx 等 query 剥掉,存干净 wiki URL.
    // 读路径(lark-cli / sheetwatch)拿到的是干净 URL,零改动.
    let normalizedUrl: string | undefined;
    if (newFeishuUrl.trim()) {
      try {
        normalizedUrl = normalizeSheetUrl(newFeishuUrl).wikiUrl || undefined;
      } catch (err) {
        toast.error(`飞书 URL 无效: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const res = await fetch("/api/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        name: newName.trim(),
        feishu_url: normalizedUrl,
        feishu_sheet: newFeishuSheet.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(`创建版本失败：${data.error || `HTTP ${res.status}`}`);
      return;
    }
    const data = await res.json();
    // Auto-set as current version if project has none
    if (data.version) {
      const project = projects.find((p) => p.id === projectId);
      if (project && !project.current_version_id) {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_version_id: data.version.id }),
        });
      }
    }
    setNewName("");
    setNewProjectId("");
    setNewFeishuUrl("");
    setNewFeishuSheet("");
    setCreating(null);
    setLoading(true);
    await refresh();
  }

  async function updateVersionFeishu(versionId: string) {
    // 同 createVersion:写库前归一化,防 API 被绕过的脏数据走兜底在这里挡.
    let normalizedUrl: string | null = null;
    if (editFeishuUrl.trim()) {
      try {
        normalizedUrl = normalizeSheetUrl(editFeishuUrl).wikiUrl || null;
      } catch (err) {
        toast.error(`飞书 URL 无效: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    await fetch(`/api/versions/${versionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feishu_url: normalizedUrl,
        feishu_sheet: editFeishuSheet.trim() || null,
      }),
    });
    setEditingVersion(null);
    setEditFeishuUrl("");
    setEditFeishuSheet("");
    setLoading(true);
    await refresh();
  }

  async function togglePin(projectId: string, currentPinned: number) {
    const next = currentPinned ? 0 : 1;
    // Optimistic flip so the UI feels instant; refresh re-syncs with DB
    // (also re-applies server-side pinned-first ordering).
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, pinned: next } : p))
    );
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: next }),
    });
    if (!res.ok) {
      // Rollback on failure.
      setProjects((prev) =>
        prev.map((p) => (p.id === projectId ? { ...p, pinned: currentPinned } : p))
      );
    } else {
      // Server ordering may have changed (pinned moved to top); refetch.
      await refresh();
    }
  }

  // 功能: 删项目 —— 确认后调 DELETE, 成功刷新列表, 失败弹 Toast.
  // 关注点: 必须检查 res.ok. 此前不检查, 所以级联删除的 500(FK 约束失败) 完全
  // 不可见 —— 弹窗照常关闭、列表照常刷新、项目还在, 用户看到的是「点了没反应」.
  function deleteProject(projectId: string) {
    setPendingConfirm({
      title: "删除项目",
      message:
        "将隐藏该项目及其下所有版本和任务，从列表中消失。数据保留在数据库中，可通过数据库恢复。继续？",
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast.error(`删除项目失败：${data.error || `HTTP ${res.status}`}`);
            return;
          }
          setLoading(true);
          await refresh();
        } catch (err) {
          toast.error(`删除项目失败：${(err as Error).message}`);
        }
      },
    });
  }

  function deleteVersion(versionId: string) {
    setPendingConfirm({
      title: "删除版本",
      message:
        "将隐藏该版本及其下所有任务，从列表中消失。数据保留在数据库中，可通过数据库恢复。继续？",
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/versions/${versionId}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast.error(`删除版本失败：${data.error || `HTTP ${res.status}`}`);
            return;
          }
          setLoading(true);
          await refresh();
        } catch (err) {
          toast.error(`删除版本失败：${(err as Error).message}`);
        }
      },
    });
  }

  async function openLlmConfig(projectId: string) {
    if (editingLlmProject === projectId) {
      setEditingLlmProject(null);
      setEditingLlmConfigId(null);
      setLlmConfigs([]);
      return;
    }
    setEditingLlmProject(projectId);
    setEditingLlmConfigId(null);
    setLlmSaving(false);
    setLlmMessage(null);
    setLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
    try {
      const res = await fetch(`/api/projects/${projectId}/llm-config`);
      const data = await res.json();
      setLlmConfigs(data.configs || []);
    } catch {
      setLlmConfigs([]);
    }
  }

  // 功能: 拉取当前展开项目的 LLM 配置列表 (保存/删除/设默认后刷新用).
  async function fetchProjectLlmConfigs(projectId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/llm-config`);
      const data = await res.json();
      setLlmConfigs(data.configs || []);
    } catch {
      setLlmConfigs([]);
    }
  }

  // 功能: 进入编辑/新增表单态, 用配置回填草稿 (新增时全空).
  function startEditProjectLlm(cfg: ProjectLlmConfig | "new") {
    if (cfg === "new") {
      setEditingLlmConfigId("new");
      setLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
    } else {
      setEditingLlmConfigId(cfg.id);
      setLlmDraft({
        name: cfg.name,
        base_url: cfg.base_url || "",
        model: cfg.model || "",
        api_key: "",
        clear_api_key: false,
      });
    }
    setLlmMessage(null);
  }

  // 功能: 保存当前草稿. 新增 -> POST /api/projects/[id]/llm-config;
  //       编辑 -> PUT /api/projects/[id]/llm-config/[configId].
  // 关注点: name 必填 (服务端二次校验, 前端 disabled 按钮只是体验); api_key 留空
  //         保留现有 key, 勾选 clear_api_key 才真清空. 默认行不允许直接删除, 这部分
  //         在前端 disable 按钮, 服务端 LlmConfigError("default_in_use") 兜底.
  async function handleProjectLlmSave(projectId: string) {
    if (!llmDraft.name.trim()) {
      setLlmMessage("名称必填");
      return;
    }
    setLlmSaving(true);
    setLlmMessage(null);
    try {
      const body: Record<string, unknown> = {
        name: llmDraft.name.trim(),
        base_url: llmDraft.base_url.trim() || null,
        model: llmDraft.model.trim() || null,
      };
      if (llmDraft.clear_api_key) {
        body.clear_api_key = true;
      } else if (llmDraft.api_key.trim()) {
        body.api_key = llmDraft.api_key.trim();
      }
      let res: Response;
      if (editingLlmConfigId === "new") {
        res = await fetch(`/api/projects/${projectId}/llm-config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (editingLlmConfigId) {
        res = await fetch(`/api/projects/${projectId}/llm-config/${editingLlmConfigId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        setLlmMessage("无正在编辑的配置");
        setLlmSaving(false);
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setLlmMessage("✅ 已保存");
        setEditingLlmConfigId(null);
        setLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
        await fetchProjectLlmConfigs(projectId);
      } else {
        setLlmMessage(data.error || "保存失败");
      }
    } catch (err) {
      setLlmMessage((err as Error).message);
    } finally {
      setLlmSaving(false);
    }
  }

  // 功能: 把指定配置设为该项目默认. 服务端事务: 同 owner 其它 default 清零.
  async function handleProjectSetLlmDefault(projectId: string, configId: string) {
    setLlmSaving(true);
    setLlmMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/llm-config/${configId}/default`, {
        method: "POST",
      });
      if (res.ok) {
        setLlmMessage("✅ 已设为默认");
        await fetchProjectLlmConfigs(projectId);
      } else {
        const data = await res.json();
        setLlmMessage(data.error || "设置失败");
      }
    } catch (err) {
      setLlmMessage((err as Error).message);
    } finally {
      setLlmSaving(false);
    }
  }

  // 功能: 删除指定配置. 用 ConfirmDialog 二次确认, 避免误删.
  function handleDeleteProjectLlmConfig(projectId: string, id: string, name: string) {
    setPendingConfirm({
      title: `删除项目 LLM 配置「${name}」`,
      message: "确定要删除这份配置？默认配置需要先切换默认才能删除。",
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        setLlmSaving(true);
        setLlmMessage(null);
        try {
          const res = await fetch(`/api/projects/${projectId}/llm-config/${id}`, {
            method: "DELETE",
          });
          if (res.ok) {
            setLlmMessage("✅ 已删除");
            await fetchProjectLlmConfigs(projectId);
          } else {
            const data = await res.json();
            setLlmMessage(data.error || "删除失败");
          }
        } catch (err) {
          setLlmMessage((err as Error).message);
        } finally {
          setLlmSaving(false);
        }
      },
    });
  }

  // 功能: 切换高级选项面板. 展开时用项目当前配置回填四个输入框.
  // 关注点: wiki 扩展名用 parseStoredExtensions 而不是裸 JSON.parse —— 库里可能有手工写入的脏数据.
  function toggleWikiConfig(project: Project & { ports?: string | null }) {
    if (editingWikiProject === project.id) {
      setEditingWikiProject(null);
      return;
    }
    setEditingWikiProject(project.id);
    setWikiExtInput(parseStoredExtensions(project.wiki_extra_extensions).join(" "));
    setParallelInput(String(project.parallel_limit ?? 1));
    setTimeoutInput(project.timeout_minutes == null ? "" : String(project.timeout_minutes));
    // R18 P2: 端口回填. ports 是 JSON 数组字符串, parse 后用逗号分隔还原给输入框.
    setPortsInput(parseStoredPorts(project.ports).join(", "));
    // R51 (R4): runners 回填. 编辑列表 + 清空草稿态.
    setRunnerEntries(parseStoredRunners(project.runners));
    setDraftRunnerId("");
    setDraftPurpose("");
    setDraftCwdMapping("");
    setDraftPatterns("");
    // 拉一次候选 runner 列表 (admin only, 非 admin 会 401, 这里允许列表空白).
    fetch("/api/runners")
      .then((r) => (r.ok ? r.json() : Promise.resolve({ runners: [] })))
      .then((data) => setRunOptions(data.runners || []))
      .catch(() => setRunOptions([]));
  }

  // R51: 「加入列表」按钮. 本地校验 + 推入 runnerEntries. 不调 API —— 与其它
  //       高级选项保持一致, 所有变更「保存」时一次 PATCH.
  function addRunnerEntry() {
    if (!draftRunnerId) {
      toast.error("请选择 runner");
      return;
    }
    const purpose = draftPurpose.trim();
    if (!purpose) {
      toast.error("purpose 必填");
      return;
    }
    const cwd = draftCwdMapping.trim();
    if (!cwd) {
      toast.error("cwd_mapping 必填 (平台 cwd = /home/user/..., runner 物理路径 = /Users/user/...)");
      return;
    }
    const patterns = draftPatterns
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (patterns.length === 0) {
      toast.error("command_patterns 至少一条 (每行一条)");
      return;
    }
    if (patterns.length > 32) {
      toast.error("command_patterns 最多 32 条");
      return;
    }
    if (runnerEntries.length >= MAX_RUNNER_ENTRIES) {
      toast.error(`最多 ${MAX_RUNNER_ENTRIES} 条 entry`);
      return;
    }
    setRunnerEntries((prev) => [
      ...prev,
      {
        runner_id: draftRunnerId,
        purpose,
        cwd_mapping: cwd,
        command_patterns: patterns.join("\n"),
        // α (damo 0829): 自动从所选 runner 取 os_type, 不让用户手填 (防错配).
        //   runOptions 还没加载完时这里取到 undefined = 提交时不带该字段 (向后兼容).
        os_type: runOptions.find((r) => r.id === draftRunnerId)?.os_type,
      },
    ]);
    // 清空草稿, runner_id 留旧值方便下条再选. purpose/cwd/patterns 清掉强迫用户重新填.
    setDraftPurpose("");
    setDraftCwdMapping("");
    setDraftPatterns("");
  }

  function removeRunnerEntry(idx: number) {
    setRunnerEntries((prev) => prev.filter((_, i) => i !== idx));
  }

  // 功能: 保存高级选项(wiki 额外扩展名 + 同 cwd 并发上限 + 任务超时 + 端口). 扩展名留空
  //      = 回到只放行 .md; 超时留空 = 回到继承全局默认; 端口留空 = 清空(回 NULL).
  // 关注点: 前端先本地校验一遍给即时反馈, 但**服务端仍会独立校验**(前端校验只是
  //        体验, 不是安全边界 —— 有人直接 curl PATCH 就绕过了).
  async function saveAdvancedConfig(projectId: string) {
    const local = normalizeExtensionsInput(wikiExtInput);
    if (!local.ok) {
      toast.error(local.error);
      return;
    }
    const limit = Number(parallelInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PARALLEL_LIMIT) {
      toast.error(`同目录并发上限必须是 1-${MAX_PARALLEL_LIMIT} 的整数`);
      return;
    }
    // 空 = null = 继承全局默认; 非空必须是合法整数(别把 "abc" 当成清空).
    const trimmedTimeout = timeoutInput.trim();
    let timeout: number | null = null;
    if (trimmedTimeout !== "") {
      const n = Number(trimmedTimeout);
      if (!Number.isInteger(n) || n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
        toast.error(`任务超时必须是 ${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES} 的整数(分钟), 留空=继承全局`);
        return;
      }
      timeout = n;
    }
    // R18 P2: 端口输入. 空串 = 清空(回 NULL). 非空 = 逗号分隔数字, 后端 normalize
    // + 池 + 冲突校验. 非法端口 / 出池 / 撞项目 都会回 409 + 结构化 conflict.
    const trimmedPorts = portsInput.trim();
    let ports: number[] | null;
    if (!trimmedPorts) {
      ports = null;
    } else {
      ports = trimmedPorts
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
      if (
        ports.length === 0 ||
        ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)
      ) {
        toast.error("端口必须是 1024-65535 整数, 逗号分隔, 最多 5 个");
        return;
      }
    }
    // R51: runners 配置. 空数组 = 显式清空(回 NULL, 全部本地执行). 提交前把所有 textarea
    //       的 command_patterns split 一遍, 与后端 validate 一致. entries 已经经过 addRunnerEntry
    //       本地校验, 这里不再重复.
    //       α (damo 0829): os_type 字段只在 UI 草稿里有值时带 (后端可选字段, 旧 entry
    //       不传 = 向后兼容不限 OS).
    const runnersBody =
      runnerEntries.length === 0
        ? null
        : runnerEntries.map((e) => {
            const base: Record<string, unknown> = {
              runner_id: e.runner_id,
              purpose: e.purpose,
              cwd_mapping: e.cwd_mapping,
              command_patterns: e.command_patterns
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            };
            if (e.os_type) base.os_type = e.os_type;
            return base;
          });
    setWikiSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wiki_extra_extensions: local.value,
          parallel_limit: limit,
          timeout_minutes: timeout,
          // null/undefined 区别: 不传 ports = PATCH 路由不调 updateProject 里的 ports
          // 分支 (现有字段保持); ports=null = 显式清空; ports=[1,2] = 覆盖.
          ports: ports === null ? null : ports,
          // R51: runners 同 ports 语义. null = 显式清空, 不传 = 不变.
          //   这里永远传 (runnersBody 已经显式 null), 让 admin 的「保存」一键回零也有意义.
          runners: runnersBody,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // R18 P2: 端口池冲突同 createProject 路径, 结构化 409.
        if (data.code === "PORT_POOL_CONFLICT" && data.conflict) {
          const c = data.conflict as {
            outOfPool?: number[];
            conflicting?: Array<{ port: number; owner_project_id: string }>;
          };
          const parts: string[] = [];
          if (c.outOfPool && c.outOfPool.length > 0) {
            parts.push(`不在端口池内: ${c.outOfPool.join(", ")}`);
          }
          if (c.conflicting && c.conflicting.length > 0) {
            const used = c.conflicting
              .map(
                (x) => `${x.port}（被项目 ${x.owner_project_id.slice(0, 8)} 占用）`,
              )
              .join(", ");
            parts.push(`与其它项目冲突: ${used}`);
          }
          toast.error(`端口冲突 — ${parts.join("; ")}`);
          return;
        }
        toast.error(`保存失败：${data.error || `HTTP ${res.status}`}`);
        return;
      }
      toast.success(
        `已保存：同目录并发 ${limit}，超时 ${timeout === null ? "跟随全局默认" : `${timeout} 分钟`}${
          local.value.length === 0
            ? "，wiki 只读取 .md"
            : `，wiki 额外读取 ${local.value.map((e) => `.${e}`).join(" ")}`
        }${ports && ports.length > 0 ? `，端口 ${ports.join(", ")}` : ""}${
          runnersBody === null
            ? ""
            : `，runners ${runnerEntries.length} 条`
        }`
      );
      setEditingWikiProject(null);
      setLoading(true);
      await refresh();
    } finally {
      setWikiSaving(false);
    }
  }

  // LLM 配置 (v50 多配置) 的所有操作都走 openLlmConfig / handleProjectLlmSave /
  // startEditProjectLlm / handleProjectSetLlmDefault / handleDeleteProjectLlmConfig
  // 五个入口. 旧 saveLlmConfig / clearLlmApiKey / deleteLlmConfig 已删除.

  const projectVersions = (projectId: string) =>
    versions.filter((v) => v.project_id === projectId);

  return (
    // 🆕 飞书 R139 第四批: 之前漏了 /——根 min-h-screen 但 main 无 overflow, 同款套路.
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 md:px-6 py-4 shrink-0">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">Agent Task Orchestrator</h1>
            <p className="text-sm text-gray-500 mt-1">
              管理多个项目和版本，每个项目绑定飞书 sheet 作为数据源
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap self-end md:self-auto">
            <label className="flex items-center gap-1 text-sm text-gray-600" title="项目排序方式">
              <span className="hidden md:inline">排序</span>
              <Select
                value={sort}
                onChange={(v) =>
                  setSort(v as "created_at" | "recent_activity")
                }
                options={[
                  { value: "created_at", label: "按创建时间" },
                  { value: "recent_activity", label: "按最近活跃" },
                ]}
                className="w-36"
              />
            </label>
            <Link
              href="/global"
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 btn-press text-sm"
              title="全局看板 - 跨项目任务总览"
            >
              🌐 全局看板
            </Link>
            <Link
              href="/settings"
              prefetch={false}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 btn-press text-sm"
              title="设置"
            >
              ⚙️ 设置
            </Link>
            <Link
              href="/import"
              prefetch={false}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 btn-press text-sm"
            >
              批量导入
            </Link>
            {projectTemplates.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowTemplatePicker((v) => !v)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 btn-press text-sm"
                  title="从 docs/project-templates/ 选一套模板预填"
                >
                  📦 从模板建 ▾
                </button>
                {showTemplatePicker && (
                  <div className="absolute right-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-96 overflow-auto">
                    {projectTemplates.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => applyProjectTemplate(t)}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0"
                      >
                        <div className="font-medium text-sm text-gray-900">
                          {t.icon ?? "📦"} {t.name}
                          {t.estimated_minutes != null && (
                            <span className="ml-2 text-xs text-gray-500">
                              ~{t.estimated_minutes}min
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {t.description}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setCreating("project")}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 btn-press text-sm"
            >
              + 新建项目
            </button>
            {userEmail && (
              <div className="pl-2 ml-1 border-l border-gray-200">
                <AccountSwitcher userEmail={userEmail} variant="header" />
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Create form */}
      {creating === "project" && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 md:px-6 py-3 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="项目名称（如 anflow）"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 max-w-xs"
            autoFocus
          />
          <input
            type="text"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="描述（可选）"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 max-w-md"
          />
          <input
            type="text"
            value={newPorts}
            onChange={(e) => setNewPorts(e.target.value)}
            placeholder="端口（可选，逗号分隔，如 13001, 13002）"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm flex-1 max-w-xs font-mono"
            inputMode="numeric"
            aria-label="端口列表"
          />
          <button
            type="button"
            onClick={autoPickPorts}
            title="从 admin 配置的端口池里自动选可用端口"
            className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm hover:bg-gray-50 btn-press"
          >
            🎯 自动选可用
          </button>
          <button onClick={createProject} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm">
            创建
          </button>
          <button onClick={() => { setCreating(null); setNewName(""); setNewDescription(""); setNewPorts(""); }} className="px-3 py-1.5 text-gray-600 text-sm">
            取消
          </button>
        </div>
      )}

      {/* Project list */}
      <main className="flex-1 min-h-0 overflow-y-auto max-w-6xl w-full mx-auto px-4 md:px-6 py-6 space-y-4 animate-fade-in-up">
        {loading && <div className="text-gray-500 text-sm">加载中...</div>}

        {!loading && projects.length === 0 && (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">🚀</div>
            <h3 className="text-lg font-semibold text-gray-700">还没有项目</h3>
            <p className="text-sm text-gray-500 mt-2">点击右上角"新建项目"开始</p>
          </div>
        )}

        {projects.map((project) => {
          const pvs = projectVersions(project.id);
          // Aggregate project-level counts from all scopes under this project
          const projectCounts: ScopeCounts = { running: 0, reviewing: 0, total: 0 };
          for (const [key, counts] of Object.entries(scopeCounts)) {
            if (key.startsWith(`${project.id}:`)) {
              projectCounts.running += counts.running;
              projectCounts.reviewing += counts.reviewing;
              projectCounts.total += counts.total;
            }
          }

          return (
            <div
              key={project.id}
              className={`group bg-white rounded-lg border overflow-hidden card-hover ${
                project.pinned
                  ? "border-amber-300 ring-1 ring-amber-200"
                  : "border-gray-200"
              }`}
            >
              {/* Project header */}
              <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                    {project.pinned === 1 && (
                      <span title="已置顶" className="text-amber-500 text-base">📌</span>
                    )}
                    {project.name}
                  </h2>
                  {project.description && (
                    <p className="text-sm text-gray-500 mt-0.5">{project.description}</p>
                  )}
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    <span>{pvs.length} 个版本</span>
                    <span>•</span>
                    {projectCounts.total > 0 ? (
                      <span className="flex items-center gap-1">
                        {projectCounts.running > 0 && <span className="text-blue-600">{projectCounts.running}运行 </span>}
                        {projectCounts.reviewing > 0 && (
                          <span className="bg-purple-100 text-purple-700 rounded-full px-1.5 text-[10px] font-semibold leading-none">{projectCounts.reviewing}审核</span>
                        )}
                        <span>{projectCounts.total}个任务</span>
                      </span>
                    ) : (
                      <span>0 个任务</span>
                    )}
                    {(project.parallel_limit ?? 1) > 1 && (
                      <>
                        <span>•</span>
                        <span className="text-amber-600" title="本项目共享同一工作目录的任务可并发数">
                          ⚡ 同目录并发 {project.parallel_limit}
                        </span>
                      </>
                    )}
                    {project.runners && parseStoredRunners(project.runners).length > 0 && (
                      <>
                        <span>•</span>
                        <span
                          className="text-amber-600"
                          title={`已配 ${parseStoredRunners(project.runners).length} 个 runner entry (高级选项 · Runners)`}
                        >
                          🛰️ {parseStoredRunners(project.runners).length} runners
                        </span>
                      </>
                    )}
                    {project.timeout_minutes != null && (
                      <>
                        <span>•</span>
                        <span className="text-amber-600" title="本项目任务的壁钟超时(覆盖全局默认)">
                          ⏱ 超时 {project.timeout_minutes}min
                        </span>
                      </>
                    )}
                    {project.current_version_name && (
                      <>
                        <span>•</span>
                        <span className="text-blue-600">
                          ⭐ 当前: {project.current_version_name}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => togglePin(project.id, project.pinned ?? 0)}
                  className={`text-xs px-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ${
                    project.pinned
                      ? "text-amber-600 hover:text-amber-700 font-medium"
                      : "text-gray-400 hover:text-amber-500"
                  }`}
                  title={project.pinned ? "取消置顶" : "置顶到顶部"}
                >
                  {project.pinned ? "📌 已置顶" : "📌 置顶"}
                </button>
                <button
                  onClick={() => deleteProject(project.id)}
                  className="text-xs text-gray-400 hover:text-red-500 px-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  删除项目
                </button>
                <button
                  onClick={() => openLlmConfig(project.id)}
                  className={`text-xs px-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ${editingLlmProject === project.id ? "text-blue-600 font-medium" : "text-gray-400 hover:text-blue-500"}`}
                >
                  LLM 配置
                </button>
                <button
                  onClick={() => toggleWikiConfig(project)}
                  title="高级选项：同目录并发上限 + 任务超时 + 端口 + wiki 可读取的文件类型"
                  className={`text-xs px-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ${editingWikiProject === project.id ? "text-blue-600 font-medium" : "text-gray-400 hover:text-blue-500"}`}
                >
                  高级选项
                </button>
              </div>

              {/* 高级选项 (v35 wiki 扩展名 + v38 同目录并发 + v40 任务超时, inline expand, 默认收起) */}
              {editingWikiProject === project.id && (
                <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 space-y-3">
                  <div>
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      ⚡ 高级选项 · 同目录并发上限
                    </div>
                    <p className="text-xs text-gray-500 leading-5">
                      本项目<strong>共享同一个工作目录</strong>的任务默认只能跑一个（避免两个
                      agent 同时改同一棵 git 工作树）。调高后可让 N 个任务同时跑在同一目录。
                      <br />
                      <span className="text-amber-700">
                        🔴 只适合基本不写工作目录的项目（巡检/研究/问答）。会写文件或
                        <code className="bg-white px-1 rounded">git commit</code> 的项目调高
                        = <code className="bg-white px-1 rounded">index.lock</code> 冲突
                        + 同名文件互相覆盖。实际并行度 = min(全局并发, 本值, 账号上限)。
                      </span>
                    </p>
                    <input
                      type="number"
                      min={1}
                      max={MAX_PARALLEL_LIMIT}
                      value={parallelInput}
                      onChange={(e) => setParallelInput(e.target.value)}
                      className="mt-1.5 w-24 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      ⏱ 高级选项 · 任务超时（分钟）
                    </div>
                    <p className="text-xs text-gray-500 leading-5">
                      单个任务最长运行多久。<strong>留空 = 跟随全局默认</strong>（设置页「任务超时」，
                      缺省 30 分钟）。到点后走「暂停」同一条路径：打断当前一轮但保留上下文，可恢复续跑。
                      <br />
                      <span className="text-amber-700">
                        🔴 调长的代价：<code className="bg-white px-1 rounded">paused</code> 是非终态，
                        定时任务防重派闸门按「非终态」算在飞 —— 超时挂着的任务会挡住后续触发更久。
                        对已在跑的任务不生效（下一次启动/恢复才吃到新值）。
                      </span>
                    </p>
                    <input
                      type="number"
                      min={MIN_TIMEOUT_MINUTES}
                      max={MAX_TIMEOUT_MINUTES}
                      placeholder="跟随全局"
                      value={timeoutInput}
                      onChange={(e) => setTimeoutInput(e.target.value)}
                      className="mt-1.5 w-28 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      🔌 高级选项 · 项目端口
                    </div>
                    <p className="text-xs text-gray-500 leading-5">
                      本项目占用的端口列表（逗号分隔, 最多 5 个）。必须落在 admin
                      配置的<strong>端口池</strong>内, 也不能与其它项目撞. 出池或
                      撞端口时保存会回 409 + 冲突明细. <strong>留空 = 清空</strong>.
                    </p>
                    <input
                      type="text"
                      value={portsInput}
                      onChange={(e) => setPortsInput(e.target.value)}
                      placeholder="13001, 13002（留空 = 清空）"
                      className="mt-1.5 w-64 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
                      inputMode="numeric"
                      aria-label="项目端口"
                    />
                    {project.ports && (
                      <div className="mt-1 text-xs text-gray-500">
                        当前: {parseStoredPorts(project.ports).join(", ") || "（未分配）"}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      🔧 高级选项 · Wiki 可读取的文件类型
                    </div>
                    <p className="text-xs text-gray-500 leading-5">
                      Wiki 默认只读取 <code className="bg-white px-1 rounded">.md</code>。
                      在此追加扩展名(空格或逗号分隔),即可在 Wiki 里浏览 agent 产出的
                      json / csv 等文件。留空保存 = 恢复默认(只读 .md)。
                      <br />
                      <span className="text-amber-700">
                        仅小写字母数字,最多 {MAX_EXTRA_EXTENSIONS} 个;隐藏文件
                        (<code className="bg-white px-1 rounded">.env</code> 等以 . 开头的)
                        和密钥类扩展名始终不可读取。非 .md 文件有 1 MiB 大小上限。
                      </span>
                    </p>
                  </div>
                  <input
                    type="text"
                    value={wikiExtInput}
                    onChange={(e) => setWikiExtInput(e.target.value)}
                    placeholder="json csv txt yaml"
                    className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTED_EXTENSIONS.map((ext) => {
                      const on = wikiExtInput
                        .split(/[,\s;]+/)
                        .map((x) => x.trim().replace(/^\.+/, "").toLowerCase())
                        .includes(ext);
                      return (
                        <button
                          key={ext}
                          onClick={() => {
                            // 点一下加/减一个扩展名, 保持输入框为唯一数据源.
                            const cur = wikiExtInput
                              .split(/[,\s;]+/)
                              .map((x) => x.trim().replace(/^\.+/, "").toLowerCase())
                              .filter(Boolean);
                            const next = on
                              ? cur.filter((x) => x !== ext)
                              : [...cur, ext];
                            setWikiExtInput(next.join(" "));
                          }}
                          className={`text-xs px-2 py-0.5 rounded border font-mono ${
                            on
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white text-gray-600 border-gray-300 hover:border-blue-400"
                          }`}
                        >
                          .{ext}
                        </button>
                      );
                    })}
                  </div>
                  {/* R51 (R4): Runners 子块 —— 多选 runner 配命令白名单 */}
                  <div className="pt-3 border-t border-amber-200">
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      🛰️ 高级选项 · Runners（远程执行白名单）
                    </div>
                    <p className="text-xs text-gray-500 leading-5">
                      把本项目命中命令白名单的 Bash 调到目标机的 runner daemon 执行
                      (例：<code className="bg-white px-1 rounded">cargo tauri build</code>
                      必须在 mac 上跑)。每条 entry = 一个 runner + 一个目的 (purpose)
                      + 路径映射 (runner 物理路径, 与平台 WSL 的 /home/user/... 不同)
                      + 命令白名单 (每行一条, R3 escape 后 .* 匹配).
                      <br />
                      <span className="text-amber-700">
                        🔴 runner_id 必须真在
                        <Link href="/runners" className="mx-1 underline">/runners</Link>
                        里注册过; <code className="bg-white px-1 rounded">cwd_mapping</code>
                        错了 exec 必失败; <code className="bg-white px-1 rounded">.*</code>{" "}
                        等过宽正则 = 把 Bash 几乎全打到 runner 上, 慎填. 留空 = 清空
                        (回 NULL, 全部走本地 SDK bash, 不走远程).
                      </span>
                    </p>

                    {/* 已配的 entry 列表 */}
                    {runnerEntries.length > 0 && (
                      <ul className="mt-2 space-y-2">
                        {runnerEntries.map((e, idx) => {
                          const opt = runOptions.find((r) => r.id === e.runner_id);
                          const patterns = e.command_patterns
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean);
                          return (
                            <li
                              key={idx}
                              className="bg-white border border-amber-200 rounded p-2 text-xs flex items-start justify-between gap-2"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-gray-700 truncate" title={e.runner_id}>
                                  runner: {opt ? `${opt.name} (${opt.host}:${opt.port})` : e.runner_id}
                                </div>
                                <div className="text-gray-600 mt-0.5">
                                  purpose: <span className="font-medium">{e.purpose}</span>
                                </div>
                                <div className="text-gray-600 mt-0.5 truncate" title={e.cwd_mapping}>
                                  cwd_mapping: <span className="font-mono">{e.cwd_mapping}</span>
                                </div>
                                <div className="text-gray-600 mt-0.5">
                                  patterns ({patterns.length}):{" "}
                                  <span className="font-mono">
                                    {patterns.slice(0, 3).join(", ")}
                                    {patterns.length > 3 ? ` … (+${patterns.length - 3})` : ""}
                                  </span>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeRunnerEntry(idx)}
                                className="text-red-500 hover:text-red-700 text-xs shrink-0 px-1"
                              >
                                删除
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {/* 新增 entry 草稿 */}
                    <div className="mt-2 bg-amber-100 border border-amber-200 rounded p-2 space-y-2">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs text-gray-600">runner</span>
                          <Select
                            value={draftRunnerId}
                            onChange={setDraftRunnerId}
                            options={runOptions.map((r) => ({
                              value: r.id,
                              label: `${r.name} (${r.host}:${r.port})`,
                            }))}
                            placeholder={
                              runOptions.length === 0
                                ? "无可用 runner, 去 /runners 注册"
                                : "选择 runner"
                            }
                            disabled={runOptions.length === 0}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs text-gray-600">purpose (自由文本, 例: mac-tauri-build)</span>
                          <input
                            type="text"
                            value={draftPurpose}
                            onChange={(ev) => setDraftPurpose(ev.target.value)}
                            placeholder="mac-tauri-build"
                            className="border border-gray-300 rounded px-2 py-1 text-sm"
                          />
                        </label>
                      </div>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-600">
                          cwd_mapping (runner 物理路径, 例:
                          <code className="bg-white px-1 rounded mx-1">/Users/user/workspace/agent-orchestrator-dev</code>)
                        </span>
                        <input
                          type="text"
                          value={draftCwdMapping}
                          onChange={(ev) => setDraftCwdMapping(ev.target.value)}
                          placeholder="/Users/user/workspace/agent-orchestrator-dev"
                          className="border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-600">command_patterns (每行一条, 子串匹配)</span>
                        <textarea
                          value={draftPatterns}
                          onChange={(ev) => setDraftPatterns(ev.target.value)}
                          rows={4}
                          placeholder={"cargo tauri build\nnpm run tauri build"}
                          className="border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                        />
                      </label>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={addRunnerEntry}
                          disabled={runnerEntries.length >= MAX_RUNNER_ENTRIES}
                          className="px-3 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 btn-press disabled:opacity-50"
                        >
                          + 加入列表
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveAdvancedConfig(project.id)}
                      disabled={wikiSaving}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 btn-press disabled:opacity-50"
                    >
                      {wikiSaving ? "保存中..." : "保存"}
                    </button>
                    <button
                      onClick={() => setEditingWikiProject(null)}
                      className="px-3 py-1 text-gray-600 text-sm"
                    >
                      取消
                    </button>
                    <Link
                      href={`/${project.id}/wiki`}
                      className="text-xs text-blue-600 hover:underline ml-auto"
                    >
                      打开 Wiki →
                    </Link>
                  </div>
                </div>
              )}

              {/* Project LLM Config (inline expand, v50 多配置 + list) */}
              {editingLlmProject === project.id && (
                <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 space-y-3">
                  <p className="text-xs text-gray-500">
                    项目级 LLM 配置（可多份，命名区分）。该项目下的任务优先用此处的默认配置；不配则按 admin → user → env 链路解析。
                  </p>

                  {/* 已有的配置列表 */}
                  {llmConfigs.length > 0 && (
                    <table className="w-full text-sm bg-white rounded">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 border-b">
                          <th className="py-1.5">名称</th>
                          <th className="py-1.5">Base URL</th>
                          <th className="py-1.5">Model</th>
                          <th className="py-1.5">Key</th>
                          <th className="py-1.5">默认</th>
                          <th className="py-1.5 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {llmConfigs.map((cfg) => (
                          <tr key={cfg.id} className="border-b last:border-b-0">
                            <td className="py-1.5 font-medium max-w-[160px] truncate" title={cfg.name}>{cfg.name}</td>
                            <td className="py-1.5 text-xs text-gray-600 truncate max-w-[160px]" title={cfg.base_url || ""}>{cfg.base_url || "—"}</td>
                            <td className="py-1.5 text-xs max-w-[160px] truncate" title={cfg.model || ""}>{cfg.model || "—"}</td>
                            <td className="py-1.5 text-xs max-w-[160px] truncate" title={cfg.api_key_masked || ""}>
                              {cfg.has_api_key
                                ? <code className="bg-gray-100 px-1 py-0.5 rounded">{cfg.api_key_masked}</code>
                                : <span className="text-red-500">未配</span>}
                            </td>
                            <td className="py-1.5">
                              {cfg.is_default
                                ? <span className="inline-block bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded">默认</span>
                                : <button
                                    onClick={() => handleProjectSetLlmDefault(project.id, cfg.id)}
                                    disabled={llmSaving}
                                    className="text-xs text-blue-600 hover:underline"
                                  >设为默认</button>}
                            </td>
                            <td className="py-1.5 text-right">
                              <button
                                onClick={() => startEditProjectLlm(cfg)}
                                disabled={llmSaving}
                                className="text-xs text-blue-600 hover:underline mr-2"
                              >编辑</button>
                              <button
                                onClick={() => handleDeleteProjectLlmConfig(project.id, cfg.id, cfg.name)}
                                disabled={cfg.is_default || llmSaving}
                                className="text-xs text-red-600 hover:underline disabled:opacity-30"
                              >删除</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* 新增 / 编辑表单 */}
                  <div className="border-t pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-medium text-gray-700">
                        {editingLlmConfigId === "new" ? "新增项目 LLM 配置" : editingLlmConfigId ? "编辑项目 LLM 配置" : ""}
                      </h4>
                      {editingLlmConfigId === null && (
                        <button
                          onClick={() => startEditProjectLlm("new")}
                          disabled={llmSaving}
                          className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded hover:bg-blue-700 btn-press disabled:opacity-50"
                        >+ 新增配置</button>
                      )}
                    </div>
                    {editingLlmConfigId !== null && (
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-0.5">名称 *</label>
                            <input
                              type="text"
                              value={llmDraft.name}
                              onChange={(e) => setLlmDraft({ ...llmDraft, name: e.target.value })}
                              placeholder="如：Claude 生产 / 火山方舟测试"
                              className="w-full border rounded px-2 py-1 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-0.5">Model</label>
                            <input
                              type="text"
                              value={llmDraft.model}
                              onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })}
                              list="project-llm-model-options"
                              placeholder="选择或输入自定义模型名"
                              className="w-full border rounded px-2 py-1 text-sm"
                            />
                            <datalist id="project-llm-model-options">
                              {modelOptions.filter((o) => o.value).map((opt) => (
                                <option key={opt.value} value={opt.value} />
                              ))}
                            </datalist>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-0.5">Base URL</label>
                            <input
                              type="text"
                              value={llmDraft.base_url}
                              onChange={(e) => setLlmDraft({ ...llmDraft, base_url: e.target.value })}
                              placeholder="留空继承上级"
                              className="w-full border rounded px-2 py-1 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-0.5">API Key</label>
                            <input
                              type="password"
                              value={llmDraft.api_key}
                              onChange={(e) => setLlmDraft({ ...llmDraft, api_key: e.target.value, clear_api_key: false })}
                              placeholder={editingLlmConfigId !== "new" ? "留空保留现有 key" : "输入 API Key"}
                              className="w-full border rounded px-2 py-1 text-sm"
                            />
                            {editingLlmConfigId !== "new" && (
                              <label className="text-xs text-gray-600 mt-1 inline-flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={llmDraft.clear_api_key}
                                  onChange={(e) => setLlmDraft({ ...llmDraft, clear_api_key: e.target.checked })}
                                />
                                清除现有 key
                              </label>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleProjectLlmSave(project.id)}
                            disabled={llmSaving || !llmDraft.name.trim()}
                            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 btn-press disabled:opacity-50"
                          >
                            {llmSaving ? "保存中..." : "保存"}
                          </button>
                          <button
                            onClick={() => { setEditingLlmConfigId(null); setLlmMessage(null); }}
                            disabled={llmSaving}
                            className="px-3 py-1 border rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                          >取消</button>
                          {llmMessage && <span className="text-xs">{llmMessage}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Versions */}
              <div className="divide-y divide-gray-100">
                {pvs.map((v) => {
                  const isCurrent = v.id === project.current_version_id;
                  const isEditing = editingVersion === v.id;

                  return (
                    <div key={v.id}>
                      <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50">
                        <span className="text-lg shrink-0">{isCurrent ? "⭐" : ""}</span>
                        <Link
                          href={`/${project.id}/${v.id}`}
                          className="flex-1 min-w-0 font-medium text-gray-800 hover:text-blue-600 truncate"
                        >
                          {v.name}
                        </Link>
                        {renderCountBadge(scopeCounts[`${project.id}:${v.id}`])}
                        {v.feishu_url && (
                          <span title={`飞书: ${v.feishu_url}`} className="text-sm shrink-0">🔗</span>
                        )}
                        {v.is_released === 1 && (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">stable</span>
                        )}
                        <button
                          onClick={() => {
                            setEditingVersion(v.id);
                            setEditFeishuUrl(v.feishu_url || "");
                            setEditFeishuSheet(v.feishu_sheet || "");
                          }}
                          className="text-xs text-gray-400 hover:text-blue-500 px-2"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => deleteVersion(v.id)}
                          className="text-xs text-gray-400 hover:text-red-500 px-2"
                        >
                          删除
                        </button>
                      </div>
                      {isEditing && (
                        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 space-y-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editFeishuUrl}
                              onChange={(e) => setEditFeishuUrl(e.target.value)}
                              placeholder="飞书 sheet URL"
                              className="border border-gray-300 rounded px-3 py-1 text-sm flex-1"
                            />
                            <input
                              type="text"
                              value={editFeishuSheet}
                              onChange={(e) => setEditFeishuSheet(e.target.value)}
                              placeholder="Sheet2"
                              className="border border-gray-300 rounded px-3 py-1 text-sm w-32"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => updateVersionFeishu(v.id)}
                              className="px-3 py-1 bg-blue-600 text-white rounded text-sm"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setEditingVersion(null)}
                              className="px-3 py-1 text-gray-600 text-sm"
                            >
                              取消
                            </button>
                            <span className="text-xs text-gray-400">留空保存即清除绑定</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Project-level tasks without a version */}
                <Link
                  href={`/${project.id}/unversioned`}
                  className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50"
                >
                  <span className="text-lg shrink-0">📁</span>
                  <span className="flex-1 font-medium text-gray-800 hover:text-blue-600">
                    其他任务
                  </span>
                  {renderCountBadge(scopeCounts[`${project.id}:`])}
                  <span className="text-xs text-gray-400">无版本</span>
                </Link>

                {/* Wiki 入口 - 默认走 current version */}
                <Link
                  href={`/${project.id}/wiki`}
                  className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50"
                >
                  <span className="text-lg shrink-0">📖</span>
                  <span className="flex-1 font-medium text-gray-800 hover:text-blue-600">
                    Wiki
                  </span>
                  <span className="text-xs text-gray-400">默认版本</span>
                </Link>

                {/* Add version */}
                {creating === "version" && newProjectId === project.id ? (
                  <div className="px-5 py-3 bg-blue-50 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="版本名（如 v1.7）"
                        className="border border-gray-300 rounded px-3 py-1 text-sm flex-1 max-w-xs"
                        autoFocus
                      />
                      <button onClick={() => createVersion(project.id)} className="px-3 py-1 bg-blue-600 text-white rounded text-sm">
                        创建
                      </button>
                      <button onClick={() => { setCreating(null); setNewName(""); setNewProjectId(""); setNewFeishuUrl(""); setNewFeishuSheet(""); }} className="px-3 py-1 text-gray-600 text-sm">
                        取消
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={newFeishuUrl}
                        onChange={(e) => setNewFeishuUrl(e.target.value)}
                        placeholder="飞书 sheet URL（可选）"
                        className="border border-gray-300 rounded px-3 py-1 text-sm flex-1"
                      />
                      <input
                        type="text"
                        value={newFeishuSheet}
                        onChange={(e) => setNewFeishuSheet(e.target.value)}
                        placeholder="Sheet2"
                        className="border border-gray-300 rounded px-3 py-1 text-sm w-32"
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setCreating("version"); setNewProjectId(project.id); setNewName(""); setNewFeishuUrl(""); setNewFeishuSheet(""); }}
                    className="w-full px-5 py-2.5 text-sm text-gray-500 hover:bg-gray-50 hover:text-blue-600 text-left"
                  >
                    + 新建版本
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Stats footer */}
        {stats?.tasks && (
          <div className="bg-white rounded-lg border border-gray-200 px-5 py-3 text-sm text-gray-600">
            全局共 {Object.values(stats.tasks).reduce((a, b) => (a as number) + (b as number), 0)} 个 task
          </div>
        )}
      </main>

      <ConfirmDialog
        open={!!pendingConfirm}
        title={pendingConfirm?.title ?? ""}
        message={pendingConfirm?.message ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel}
        variant={pendingConfirm?.variant}
        onConfirm={() => {
          pendingConfirm?.onConfirm();
          setPendingConfirm(null);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}