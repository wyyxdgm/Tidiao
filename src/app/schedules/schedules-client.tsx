"use client";

// Schedules list page: 创建/删除/启停全在 UI 上完成（damo R68 反馈「没看到添加删除按钮」）。
// 创建走 POST /api/schedules，删除走 DELETE /api/schedules/[id]，启停走 PATCH /api/schedules/[id]。

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useToastActions } from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import Select from "@/components/Select";

type Schedule = {
  id: string;
  name: string;
  exec_type: "agent" | "shell";
  title: string | null;
  description: string | null;
  prompt: string | null;
  command: string | null;
  cwd: string | null;
  project_id: string | null;
  schedule_type: "cron" | "once";
  schedule_expr: string;
  timezone: string;
  enabled: boolean;
  next_run: string;
  last_run: string | null;
  last_task_id: string | null;
  last_exit_code: number | null;
  skip_if_running: boolean;
  created_at: string;
  // 🆕 v68 软删除时间戳; 非空表示已软删除
  deleted_at: string | null;
};

type Project = { id: string; name: string };
// 🆕 R92 第二批: 版本类型（只用到 id/name/project_id，足够 toolbar 显示）。
type Version = { id: string; name: string; project_id: string };

// 🆕 飞书 R92: 筛选状态（项目 + 时间区间）。filterState 只装非空值；toQueryString 负责拼 URL。
//   datetime-local 输入框的 value 形如 "2026-09-01T09:00"（无时区/秒），所以我们转 ISO 时手动
//   加 ":00Z" 把其视为 UTC。后端 isIsoString + BETWEEN 会自然处理。
// 🆕 R92 第二批反馈: 加 versionId —— damo 0830 R 列明确要求「版本也支持筛选」。
//   与 projectId 是组合: 可单独筛 version, 也可先 project 后 version 叠加。
type FilterState = {
  projectId: string;
  versionId: string;
  lastRunFrom: string;
  lastRunTo: string;
  nextRunFrom: string;
  nextRunTo: string;
};

const EMPTY_FILTER: FilterState = {
  projectId: "",
  versionId: "",
  lastRunFrom: "",
  lastRunTo: "",
  nextRunFrom: "",
  nextRunTo: "",
};

// 拼 ?xxx=yyy —— 只拼非空字段。前端传 "" 后端路由用 || undefined 兜成 undefined，
//   listSchedules 里 isIsoString 又把空字符串判成 invalid 一并兜底。
function buildFilterQS(f: FilterState, includeDeleted: boolean): string {
  const parts: string[] = [];
  if (f.projectId) parts.push(`project=${encodeURIComponent(f.projectId)}`);
  if (f.versionId) parts.push(`version=${encodeURIComponent(f.versionId)}`);
  if (f.lastRunFrom) parts.push(`lastRunFrom=${encodeURIComponent(f.lastRunFrom + ":00Z")}`);
  if (f.lastRunTo) parts.push(`lastRunTo=${encodeURIComponent(f.lastRunTo + ":00Z")}`);
  if (f.nextRunFrom) parts.push(`nextRunFrom=${encodeURIComponent(f.nextRunFrom + ":00Z")}`);
  if (f.nextRunTo) parts.push(`nextRunTo=${encodeURIComponent(f.nextRunTo + ":00Z")}`);
  if (includeDeleted) parts.push("includeDeleted=true");
  return parts.length ? `?${parts.join("&")}` : "";
}

// 🆕 飞书 R75: 触发历史面板所需类型 —— 与 /api/schedules/[id]/runs 返回形状对齐。
type ScheduleRun = {
  id: number;
  schedule_id: string;
  exec_type: "agent" | "shell";
  task_id: string | null;
  command: string | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};
type RunsResponse = { runs: ScheduleRun[]; total: number; limit: number; offset: number };

// 🆕 R68 v2：新建表单的本地状态。exec_type 决定要渲染哪些字段；其余必填共用。
type CreateFormState = {
  name: string;
  exec_type: "agent" | "shell";
  schedule_type: "cron" | "once";
  schedule_expr: string;
  timezone: string;
  description: string;
  // agent 侧
  project_id: string;
  title: string;
  prompt: string;
  // shell 侧
  command: string;
  cwd: string;
};

const EMPTY_FORM: CreateFormState = {
  name: "",
  exec_type: "agent",
  schedule_type: "cron",
  schedule_expr: "0 9 * * *",
  timezone: "Asia/Shanghai",
  description: "",
  project_id: "",
  title: "",
  prompt: "",
  command: "",
  cwd: "",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  if (iso.startsWith("9999")) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function exitBadge(code: number | null): { text: string; cls: string } {
  if (code === null) return { text: "进行中", cls: "bg-yellow-100 text-yellow-700" };
  if (code === 0) return { text: `成功 (${code})`, cls: "bg-emerald-100 text-emerald-700" };
  return { text: `失败 (${code})`, cls: "bg-red-100 text-red-700" };
}

export default function SchedulesClient({
  initialSchedules,
}: {
  initialSchedules: Schedule[];
}) {
  const [schedules, setSchedules] = useState<Schedule[]>(initialSchedules);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 🆕 v68 软删除筛选开关: 默认关 (=只看活跃); 开了拉 ?includeDeleted=true
  const [showDeleted, setShowDeleted] = useState(false);
  // 🆕 飞书 R92: 项目 + 时间区间筛选状态。空 = 不过滤；任意字段非空都会触发 refetch。
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  // 防抖计时器 —— datetime-local onChange 每个按键都会触发, 不防抖就每按一次打一次 API。
  // 300ms 与 chrome devtools 网络节流一致; 用户停手立即发, 不必等满。
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 🆕 R68 v2: 删除确认对话框状态（哪条 schedule 等待确认）
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null);
  // 🆕 R68 v2: 新建 modal 开关
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  // 🆕 R68 v2: agent 类型的 project 选择器数据
  const [projects, setProjects] = useState<Project[]>([]);
  // 🆕 R92 第二批: 版本列表 —— mount 时拉一次（不带 ?project=，拿全部）。
  //   toolbar 的版本 Select 按当前选中的 projectId 客户端过滤; 切换项目时 options 自动变。
  //   拉全量比每次切换项目重拉省一次请求 + 加载更顺。
  const [versions, setVersions] = useState<Version[]>([]);
  // 🆕 R86: 编辑 modal 状态 —— editTarget 记哪条 schedule 在编辑, editForm 装预填值
  const [editTarget, setEditTarget] = useState<Schedule | null>(null);
  const [editForm, setEditForm] = useState<CreateFormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  // 🆕 飞书 R75: 触发历史面板状态 —— per-schedule id 维度的开/关 + 分页 + 缓存。
  //   分页缓存避免「上一页 → 展开/收起 → 重展开」时多打一次 API。
  const [runsOpen, setRunsOpen] = useState<Record<string, boolean>>({});
  const [runsPage, setRunsPage] = useState<Record<string, number>>({});
  const [runsData, setRunsData] = useState<Record<string, RunsResponse | null>>({});
  const [runsLoading, setRunsLoading] = useState<Record<string, boolean>>({});
  // 🆕 飞书 R79: 「查看完整日志」弹窗状态 —— 单条 run 完整 output + error,
  //   跨页面切换 schedule 时保留 (但打开新 run 会替换).
  const [logDialogRun, setLogDialogRun] = useState<ScheduleRun | null>(null);
  // 🆕 飞书 R53 S 列: 「立即执行」按钮的 per-schedule loading 状态 —— Map[id,bool]
  //   避免多个 schedule 同时触发时按钮状态串。disabled 时灰显 + 文案改「触发中…」。
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});
  // 🆕 飞书 R86: SSE 流式日志订阅 —— logDialogRun 变化时启动 EventSource,
  //   liveStdout/liveStderr 优先显示,fallback 到 logDialogRun.output/error (DB 历史)。
  //   completed=true 后 es.close(), unmount 时也 close (防泄漏)。
  const [liveStdout, setLiveStdout] = useState<string>("");
  const [liveStderr, setLiveStderr] = useState<string>("");
  const [liveCompleted, setLiveCompleted] = useState<boolean>(false);
  const [liveExitCode, setLiveExitCode] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const stdoutEndRef = useRef<HTMLDivElement | null>(null);
  const stderrEndRef = useRef<HTMLDivElement | null>(null);
  const { error: toastError, success: toastSuccess, warning: toastWarning } = useToastActions();

  // 🆕 飞书 R92: 一次性拉项目列表 —— toolbar / 新建 / 编辑 三处都要用。
  //   之前只在打开 modal 时拉，toolbar 装上后立刻就要有 options，所以改成 mount 时拉一次。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data.projects ?? []);
        setProjects(list);
        if (!createForm.project_id && list[0]?.id) {
          setCreateForm((f) => ({ ...f, project_id: list[0].id }));
        }
      })
      .catch(() => {
        // 静默失败：用户能看到 project 下拉为空，提交时也会被后端 400
      });
    return () => {
      cancelled = true;
    };
    // 只在 mount 时拉一次；之后表单内 project_id 由用户改
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 🆕 R92 第二批: 版本列表 mount 时拉一次 —— toolbar 版本 Select 用。
  //   不带 ?project= 参数拿到当前用户全量版本, 客户端按 filter.projectId 过滤。
  //   失败静默: 用户能看到版本下拉为空, toolbar 仍可正常用 (filter.versionId 为空 = 不过滤)。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/versions")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data.versions ?? []);
        setVersions(list);
      })
      .catch(() => {
        // 静默失败
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 🆕 R92 第二批: 切换项目时清空版本筛选 (项目一变, 原 version 可能不属于新项目)。
  //   不清 = 后端 WHERE version_id 命中 0 行, 用户看到列表突然空会困惑。
  //   直接 setFilter 触发 onFilterChange 防抖链路, 与用户手动改 Select 行为一致。
  //   ref 初值 null 区分 mount; 之后每次 projectId 变了, 若 versionId 非空就清。
  //   注: 这个 effect 只在 projectId 变化时跑, 用户手动改 versionId 不会触发自身递归。
  const prevProjectIdRef = useRef<string | null>(null);

  // 🆕 飞书 R86: SSE 流式日志订阅 —— logDialogRun 变化时启动/停止 EventSource。
  //   - 打开 modal (logDialogRun 切到非空):重置 state + new EventSource(url)
  //   - onmessage 更新 liveStdout/liveStderr/liveCompleted/liveExitCode
  //   - completed=true 后 es.close()
  //   - 关闭 modal 或卸载组件:cleanup es.close() 防泄漏
  //   - 网络失败:EventSource 原生会自动重连,这里静默;若 completed 一直没来用户可手动关 modal。
  //   - 自动滚动:每次 liveStdout/liveStderr 更新后 scrollIntoView,跑长输出时用户能看到最新。
  useEffect(() => {
    if (!logDialogRun) return;
    // 重置 state (新 run / 重开 modal)
    setLiveStdout("");
    setLiveStderr("");
    setLiveCompleted(false);
    setLiveExitCode(null);
    const url = `/api/schedules/runs/${logDialogRun.id}/stream`;
    const es = new EventSource(url);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as {
          stdout?: string;
          stderr?: string;
          completed?: boolean;
          exitCode?: number | null;
        };
        if (typeof payload.stdout === "string") setLiveStdout(payload.stdout);
        if (typeof payload.stderr === "string") setLiveStderr(payload.stderr);
        if (typeof payload.completed === "boolean") setLiveCompleted(payload.completed);
        if ("exitCode" in payload) setLiveExitCode(payload.exitCode ?? null);
        if (payload.completed) {
          es.close();
          esRef.current = null;
        }
      } catch {
        // 忽略单帧解析失败,继续等下一帧
      }
    };
    es.onerror = () => {
      // EventSource 原生会自动重连; 真断了 completed 帧不再来,用户可手动关 modal。
      // 这里不主动 close, 让浏览器自己处理 retry。
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [logDialogRun]);

  // 🆕 飞书 R86: 自动滚动到 stdout/stderr 末尾 —— 跑长输出时用户能看到最新行,
  //   不必手动滚。behavior:smooth 让滚动不会跳得突兀。
  useEffect(() => {
    stdoutEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveStdout]);
  useEffect(() => {
    stderrEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [liveStderr]);
  useEffect(() => {
    const prev = prevProjectIdRef.current;
    prevProjectIdRef.current = filter.projectId;
    if (prev === null) return; // mount, 跳过
    if (prev !== filter.projectId && filter.versionId) {
      onFilterChange({ ...filter, versionId: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.projectId]);

  // 🆕 飞书 R92: 卸载时清理防抖 timer —— 防止组件卸载后还有挂起的 refetch
  //   操作 setSchedules 引发的 "Can't perform a state update on an unmounted component" 警告。
  useEffect(() => {
    return () => {
      if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    };
  }, []);

  // 🆕 R86: 从 schedule 预填 editForm 并打开 modal
  function openEdit(s: Schedule) {
    setEditForm({
      name: s.name,
      exec_type: s.exec_type,
      schedule_type: s.schedule_type,
      schedule_expr: s.schedule_expr,
      timezone: s.timezone,
      description: s.description ?? "",
      project_id: s.project_id ?? "",
      title: s.title ?? "",
      prompt: s.prompt ?? "",
      command: s.command ?? "",
      cwd: s.cwd ?? "",
    });
    setEditTarget(s);
  }

  // 🆕 R86: 关闭编辑 modal —— 不重置 editForm 以防用户想恢复
  function closeEdit() {
    setEditTarget(null);
    setEditForm(EMPTY_FORM);
  }

  // 🆕 R86: 提交编辑 -> PATCH /api/schedules/[id]。复用 validateCreateForm 的校验规则
  //   (字段名一致)。exec_type 不能改 —— 一旦创建 agent/shell 类型就钉死, 避免
  //   「编辑时切换类型导致 history 面板里旧的 shell run 和新的 agent 任务混淆」。
  async function submitEdit() {
    if (!editTarget) return;
    const err = validateCreateForm(editForm);
    if (err) {
      toastError(err);
      return;
    }
    // 🆕 飞书 R95: 提交时若 description 为空, 弹 warning toast 软提示(不阻断)。
    //   后端 service 层会同步 console.warn 兜底, 这里给用户即时反馈。
    //   "主动从有 → 无"也吃警告: 用户手贱清空要"被提醒一次",比静默掉好。
    if (!editForm.description.trim()) {
      toastWarning("没填描述,排查事故时不易快速定位意图");
    }
    setEditing(true);
    const body: Record<string, unknown> = {
      name: editForm.name.trim(),
      schedule_type: editForm.schedule_type,
      schedule_expr: editForm.schedule_expr.trim(),
      timezone: editForm.timezone.trim() || "Asia/Shanghai",
    };
    if (editForm.description.trim()) body.description = editForm.description.trim();
    if (editForm.exec_type === "agent") {
      body.title = editForm.title.trim();
      body.prompt = editForm.prompt.trim();
      body.project_id = editForm.project_id;
    } else {
      body.command = editForm.command.trim();
      if (editForm.cwd.trim()) body.cwd = editForm.cwd.trim();
    }
    try {
      const res = await fetch(`/api/schedules/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || `更新失败 (${res.status})`);
        return;
      }
      // 🆕 R86: 把后端回的对象回写到本地 schedules —— 避免再拉一次列表
      setSchedules((prev) =>
        prev.map((x) => (x.id === editTarget.id ? { ...x, ...(data as Partial<Schedule>) } : x))
      );
      toastSuccess("已保存");
      closeEdit();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setEditing(false);
    }
  }

  // 🆕 飞书 R92: 统一拉列表 —— showDeleted + project + 时间区间三组筛选合到一个函数，
  //   让 toggleShowDeleted / 筛选 onChange / 拉初始化 都走同一条路径，URL 参数不会漏。
  async function refetchSchedules(
    nextShowDeleted: boolean,
    nextFilter: FilterState
  ): Promise<void> {
    const qs = buildFilterQS(nextFilter, nextShowDeleted);
    try {
      const res = await fetch(`/api/schedules${qs}`, { cache: "no-store" });
      if (!res.ok) {
        toastError(`加载失败 (${res.status})`);
        return;
      }
      setSchedules(await res.json());
    } catch (e) {
      toastError(e instanceof Error ? e.message : "网络错误");
    }
  }

  function toggleShowDeleted(next: boolean) {
    setShowDeleted(next);
    void refetchSchedules(next, filter);
  }

  // 🆕 飞书 R92: 筛选输入 — 300ms 防抖，避免每个按键一次 API。
  function onFilterChange(next: FilterState) {
    setFilter(next);
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => {
      void refetchSchedules(showDeleted, next);
    }, 300);
  }

  // 重置所有筛选（清空 filter + 关掉 showDeleted）。
  function resetFilters() {
    setFilter(EMPTY_FILTER);
    setShowDeleted(false);
    void refetchSchedules(false, EMPTY_FILTER);
  }

  async function toggle(id: string, enabled: boolean) {
    const res = await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    if (!res.ok) {
      toastError(data.error || "操作失败");
      return;
    }
    setSchedules((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    toastSuccess(enabled ? "已启用" : "已停用");
  }

  // 🆕 R68 v2: 删除走 DELETE /api/schedules/[id]。后端是硬删（不走 v68 软删除通道）。
  // 误删风险用 ConfirmDialog 兜住。
  async function doDelete(s: Schedule) {
    const res = await fetch(`/api/schedules/${s.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toastError(data.error || `删除失败 (${res.status})`);
      return;
    }
    setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    toastSuccess("已删除");
  }

  // 🆕 飞书 R53 S 列: 「立即执行」按钮 handler —— POST /api/schedules/[id]/runs。
  //   后端不依赖 enabled 字段 (manual 是显式触发, paused 也能跑), 所以这里
  //   只对软删除的 schedule 禁触发 (避免误操作)。返回结构:
  //   - agent: { ok, task_id } —— task_id 可链到 /tasks/{id}
  //   - shell: { ok } —— 已发出 run, 详情在「触发历史」面板
  //   - 409: skip_if_running 兜底, 上一发还在飞 (后端 reason 已人类可读, 直接 toast)
  //   - 404 / 401: 罕至 (本页面的 schedule 列表来自 owner-scope GET, 触发时一般不会出现)
  // 🆕 飞书 R53 R 列追加: 触发成功后自动刷新该 schedule 的「触发历史」面板。
  //   - 面板打开时: 立即拉第 0 页, 用户看到新 run 出现在列表顶部
  //   - 面板关闭时: 仍拉第 0 页入缓存, 下次打开就是新数据 (toggleRuns 看 cache 命中会跳过 fetch)
  //   - 把 runsPage[s.id] 重置回 0, 避免之前翻到第 2 页导致新数据看不到
  async function triggerNow(s: Schedule) {
    if (s.deleted_at) {
      toastError("已软删除的 schedule 不能触发");
      return;
    }
    setTriggering((m) => ({ ...m, [s.id]: true }));
    try {
      const res = await fetch(`/api/schedules/${s.id}/runs`, { method: "POST" });
      const data: { ok?: boolean; task_id?: string; error?: string } = await res
        .json()
        .catch(() => ({}));
      if (res.ok) {
        if (s.exec_type === "agent" && data.task_id) {
          toastSuccess(`已触发 · 任务 ${data.task_id.slice(0, 8)}`);
        } else {
          toastSuccess("已触发 · shell 已开始执行");
        }
        // 🆕 R 列: 触发成功后静默刷新触发历史第 0 页。
        //   runsPage 同步重置, 否则用户翻到第 2 页时新 run 不在视野。
        setRunsPage((m) => ({ ...m, [s.id]: 0 }));
        void fetchRuns(s.id, 0);
        return;
      }
      toastError(data.error || `触发失败 (${res.status})`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setTriggering((m) => ({ ...m, [s.id]: false }));
    }
  }

  // 🆕 R68 v2: 提交新建。必填校验在前端做一遍（防无意义请求），
  // 后端 validateDefinition 是权威；前端只是「输错就别点出去」。
  function validateCreateForm(f: CreateFormState): string | null {
    if (!f.name.trim()) return "请填写任务名";
    if (!f.schedule_expr.trim()) return "请填写调度表达式（cron 5 段或 ISO 时间）";
    if (f.exec_type === "agent") {
      if (!f.project_id) return "请选择项目";
      if (!f.title.trim()) return "请填写任务标题（agent 派任务用）";
      if (!f.prompt.trim()) return "请填写 prompt（agent 派任务用）";
    } else {
      if (!f.command.trim()) return "请填写 shell 命令";
    }
    return null;
  }

  async function submitCreate() {
    const err = validateCreateForm(createForm);
    if (err) {
      toastError(err);
      return;
    }
    // 🆕 飞书 R95: 同 submitEdit —— 软警告, 不阻断。
    if (!createForm.description.trim()) {
      toastWarning("没填描述,排查事故时不易快速定位意图");
    }
    setCreating(true);
    const body: Record<string, unknown> = {
      name: createForm.name.trim(),
      exec_type: createForm.exec_type,
      schedule_type: createForm.schedule_type,
      schedule_expr: createForm.schedule_expr.trim(),
      timezone: createForm.timezone.trim() || "Asia/Shanghai",
    };
    if (createForm.description.trim()) body.description = createForm.description.trim();
    if (createForm.exec_type === "agent") {
      body.project_id = createForm.project_id;
      body.title = createForm.title.trim();
      body.prompt = createForm.prompt.trim();
    } else {
      body.command = createForm.command.trim();
      if (createForm.cwd.trim()) body.cwd = createForm.cwd.trim();
    }
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || `创建失败 (${res.status})`);
        return;
      }
      setSchedules((prev) => [data as Schedule, ...prev]);
      toastSuccess("已创建");
      setCreateOpen(false);
      setCreateForm(EMPTY_FORM);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setCreating(false);
    }
  }

  // 🆕 飞书 R75: 触发历史面板 —— 拉一页 + 缓存。open=true 时第一页必拉,
  //   后续翻页直接覆盖 cache。limit=10 与 UI 一致；后端允许任意 <= 200。
  async function fetchRuns(scheduleId: string, page: number) {
    setRunsLoading((m) => ({ ...m, [scheduleId]: true }));
    const limit = 10;
    const offset = page * limit;
    try {
      const res = await fetch(
        `/api/schedules/${encodeURIComponent(scheduleId)}/runs?limit=${limit}&offset=${offset}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        toastError(`加载触发历史失败 (${res.status})`);
        return;
      }
      const data = (await res.json()) as RunsResponse;
      setRunsData((m) => ({ ...m, [scheduleId]: data }));
      setRunsPage((m) => ({ ...m, [scheduleId]: page }));
    } catch (e) {
      toastError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setRunsLoading((m) => ({ ...m, [scheduleId]: false }));
    }
  }

  function toggleRuns(scheduleId: string) {
    const nextOpen = !runsOpen[scheduleId];
    setRunsOpen((m) => ({ ...m, [scheduleId]: nextOpen }));
    if (nextOpen && !runsData[scheduleId]) {
      void fetchRuns(scheduleId, 0);
    }
  }

  function gotoPage(scheduleId: string, page: number) {
    setRunsPage((m) => ({ ...m, [scheduleId]: page }));
    void fetchRuns(scheduleId, page);
  }

  return (
    // 🆕 飞书 R139: 右侧主区滚动修复 —— 旧版用 min-h-screen 把容器撑到 100vh,
    //   但 layout 主链 (NavSidebar + main flex overflow-hidden) 在外部已经
    //   限定了高度, min-h-screen = 内容超出可视区且无法滚动 (父级 overflow-hidden
    //   把溢出截掉, 自己又没设 overflow-y-auto)。改成 h-full + flex-col 让容器
    //   填满父级剩余高度, <main> 内部 overflow-y-auto 自己滚, header 不滚
    //   (TabStrip 已 sticky 在更外层管「tab 固定」, 此处只需页面级布局正确)。
    <div className="h-full flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="text-sm text-gray-500 mb-1">
          <Link href="/" className="hover:text-blue-600">
            项目
          </Link>
          <span className="mx-1">›</span>
          <span>定时任务</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">定时任务 Schedules</h1>
        <p className="text-sm text-gray-500 mt-1">
          到点自动创建并启动任务。支持 agent(派给 Claude Code)和 shell(直接执行命令)两种类型。
        </p>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-5xl w-full mx-auto px-6 py-6 space-y-4">
        {/* 🆕 飞书 R92: 筛选 + 操作按钮合并到一行 —— 项目 Select + 时间区间 datetime-local + 软删除复选框 + 重置 + 新建 */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            {/* 🆕 飞书 R92: 项目筛选 —— 复用已 fetch 的 projects state，agent/shell 一视同仁 */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">项目</span>
              <div className="w-44">
                <Select
                  value={filter.projectId}
                  onChange={(v) => onFilterChange({ ...filter, projectId: v })}
                  options={[
                    { value: "", label: "全部项目" },
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </div>
            </div>
            {/* 🆕 R92 第二批: 版本筛选 —— 客户端按当前 projectId 过滤 versions。
                切项目时 versionId 自动清空 (上面 effect), 不会显示「不属于当前项目的版本」。
                未选项目 (=全部) = 列出当前用户所有 version。 */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">版本</span>
              <div className="w-44">
                <Select
                  value={filter.versionId}
                  onChange={(v) => onFilterChange({ ...filter, versionId: v })}
                  options={[
                    { value: "", label: "全部版本" },
                    ...versions
                      .filter((v) => !filter.projectId || v.project_id === filter.projectId)
                      .map((v) => ({ value: v.id, label: v.name })),
                  ]}
                />
              </div>
            </div>
            {/* 🆕 飞书 R92: 时间区间 —— 上次执行（last_run）+ 下次执行（next_run），各一组起止。
                datetime-local 输入框无时区，我们把其视为 UTC（加 ":00Z"）传给后端 isIsoString。
                与 R 列 damo 拍板一致：未执行的（NULL）不算在区间内。
                🆕 R92 第二批: 尺寸统一到 w-44 (与 Select 等宽) —— 之前 text-xs 视觉小, R 列明确要求统一。 */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">上次</span>
              <input
                type="datetime-local"
                value={filter.lastRunFrom}
                onChange={(e) => onFilterChange({ ...filter, lastRunFrom: e.target.value })}
                className="w-44 text-xs border border-gray-300 rounded px-2 py-1 font-mono"
                aria-label="上次执行起始"
              />
              <span className="text-xs text-gray-400">→</span>
              <input
                type="datetime-local"
                value={filter.lastRunTo}
                onChange={(e) => onFilterChange({ ...filter, lastRunTo: e.target.value })}
                className="w-44 text-xs border border-gray-300 rounded px-2 py-1 font-mono"
                aria-label="上次执行结束"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">下次</span>
              <input
                type="datetime-local"
                value={filter.nextRunFrom}
                onChange={(e) => onFilterChange({ ...filter, nextRunFrom: e.target.value })}
                className="w-44 text-xs border border-gray-300 rounded px-2 py-1 font-mono"
                aria-label="下次执行起始"
              />
              <span className="text-xs text-gray-400">→</span>
              <input
                type="datetime-local"
                value={filter.nextRunTo}
                onChange={(e) => onFilterChange({ ...filter, nextRunTo: e.target.value })}
                className="w-44 text-xs border border-gray-300 rounded px-2 py-1 font-mono"
                aria-label="下次执行结束"
              />
            </div>
            {/* 🆕 v68 软删除筛选开关 */}
            <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => toggleShowDeleted(e.target.checked)}
                className="rounded border-gray-400"
              />
              <span className="text-xs">显示已软删除</span>
            </label>
            {/* 🆕 飞书 R92: 重置按钮 — 任何筛选非空就显示 */}
            {(filter.projectId ||
              filter.versionId ||
              filter.lastRunFrom ||
              filter.lastRunTo ||
              filter.nextRunFrom ||
              filter.nextRunTo ||
              showDeleted) && (
              <button
                onClick={resetFilters}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                重置
              </button>
            )}
          </div>
          {/* 🆕 R68 v2: 新建按钮 */}
          <button
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700"
          >
            + 新建定时任务
          </button>
        </div>

        {schedules.length === 0 && (
          <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
            <div className="text-4xl mb-3">⏰</div>
            <p className="text-gray-500 text-sm">还没有定时任务</p>
            <p className="text-gray-400 text-xs mt-1">点右上角「+ 新建定时任务」创建</p>
          </div>
        )}

        {schedules.map((s) => {
          const eb = s.exec_type === "shell" ? exitBadge(s.last_exit_code) : null;
          return (
            // 🆕 飞书 R86 (UI 二期): 卡片加 `group relative` —— 操作按钮组从原来右侧
            //   flex-col 垂直堆叠改为右下角 absolute 定位 + flex-row 横向一排,
            //   默认 opacity-0 + pointer-events-none 隐藏, hover 卡片/focus-within 时
            //   才渐显。按钮多了之后卡片高度不再被按钮列撑高, 视觉更干净。
            <div
              key={s.id}
              className="group relative bg-white rounded-lg border border-gray-200 px-5 py-4 transition-colors hover:border-gray-300 hover:bg-gray-50/40"
            >
              {/* 🆕 飞书 R86 (UI 三期): 头部内容 + 操作按钮组 包在同一 relative 容器内,
                  RunsPanel 移到容器外(卡片 div 的直接子元素)。根因: 二期把按钮组
                  absolute 锚到卡片 div 右下角 → RunsPanel 展开后卡片高度增加,
                  按钮组叠在 RunsPanel 右上角的「上一页/下一页」翻页按钮上。
                  三期把按钮组锚到头部内容区右下角(absolute bottom-3 right-0 +
                  relative 父 div 隔离),RunsPanel 自然排在按钮组下方,不再被覆盖。
                  RunsPanel 移出后,卡片默认折叠高度 = 头部内容区; 按钮组 absolute
                  仍不占 flex 高度,「按钮列不再挤压内容宽度」的二期目标保留。 */}
              <div className="relative">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-semibold text-gray-900">{s.name}</h3>
                    {s.deleted_at && (
                      <span
                        className="text-xs px-2 py-0.5 rounded-full bg-rose-100 text-rose-700"
                        title={`已软删除于 ${fmt(s.deleted_at)}`}
                      >
                        已删除
                      </span>
                    )}
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        s.enabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {s.enabled ? "启用" : "停用"}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                      {s.exec_type}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        s.schedule_type === "cron"
                          ? "bg-indigo-100 text-indigo-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {s.schedule_type === "cron" ? "cron 定时" : "once 一次性"}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-mono">
                      {s.schedule_expr}
                    </span>
                    {s.skip_if_running && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                        跳过重叠
                      </span>
                    )}
                  </div>

                  {s.exec_type === "agent" && (
                    <div className="mt-1 text-sm text-gray-700">{s.title}</div>
                  )}
                  {s.exec_type === "shell" && (
                    <code className="block mt-1 text-xs text-gray-600 font-mono break-all bg-gray-50 px-2 py-1 rounded">
                      $ {s.command}
                    </code>
                  )}

                  {s.description && (
                    <div
                      onClick={() =>
                        setExpandedId((prev) => (prev === s.id ? null : s.id))
                      }
                      className={`mt-2 text-sm text-gray-600 cursor-pointer rounded px-2 py-1 -mx-1 hover:bg-gray-50 ${
                        expandedId === s.id ? "" : "line-clamp-1"
                      }`}
                      title={expandedId === s.id ? "点击收起" : "点击展开完整描述"}
                    >
                      {s.description}
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                    <span>
                      下次:{" "}
                      <span className="font-mono text-gray-700">
                        {s.enabled ? fmt(s.next_run) : "—"}
                      </span>
                    </span>
                    <span>
                      上次: <span className="font-mono text-gray-700">{fmt(s.last_run)}</span>
                    </span>
                    {s.exec_type === "agent" && s.last_task_id && (
                      <span>
                        上次任务:{" "}
                        <Link
                          href={`/tasks/${s.last_task_id}`}
                          className="text-blue-600 hover:underline font-mono"
                        >
                          {s.last_task_id.slice(0, 8)}
                        </Link>
                      </span>
                    )}
                    {s.exec_type === "shell" && eb && (
                      <span>
                        上次结果:{" "}
                        <span className={`px-1.5 py-0.5 rounded-full text-xs ${eb.cls}`}>
                          {eb.text}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* 🆕 飞书 R86 (UI 二期): 右下角操作按钮组 —— 默认隐藏, hover 卡片或
                  键盘 focus 任意按钮时横向一排展开。pointer-events 默认关, hover
                  /focus-within 才开, 避免透明按钮拦截下方点击。绝对定位不占
                  flex 高度, 卡片其他内容宽度不再被按钮列挤压。🆕 R86 三期: 锚点
                  从卡片 div 改到头部内容区 div (上方 relative 容器),right-3
                  保留视觉位置; RunsPanel 移到容器外, 不会被按钮组覆盖。 */}
              <div
                className="absolute bottom-3 right-3 z-10
                           flex flex-row items-center gap-1.5
                           opacity-0 group-hover:opacity-100 focus-within:opacity-100
                           pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto
                           transition-opacity duration-150"
              >
                {/* 🆕 飞书 R53 S 列: 「立即执行」按钮 —— 调 POST /api/schedules/[id]/runs。
                    后端 manual trigger 不依赖 enabled, 所以暂停/已禁用 也能触发。
                    软删除的 schedule UI 上禁触发 (后端没挡, 前端兜住避免误点)。
                    蓝色描边放在最左, 作为「主操作」先看到, 后面才是历史/编辑/启停/删除。 */}
                <button
                  onClick={() => triggerNow(s)}
                  disabled={!!triggering[s.id] || !!s.deleted_at}
                  title={
                    s.deleted_at
                      ? "已软删除, 不能触发"
                      : "立即触发一次（不影响 cron 下次时间）"
                  }
                  className="px-3 py-1.5 rounded text-sm bg-white border border-blue-300 text-blue-600 hover:bg-blue-50 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {triggering[s.id] ? "触发中…" : "立即执行"}
                </button>
                {/* 飞书 R75: 触发历史按钮 —— 展开/收起 runs 面板 */}
                <button
                  onClick={() => toggleRuns(s.id)}
                  aria-expanded={!!runsOpen[s.id]}
                  className="px-3 py-1.5 rounded text-sm bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm"
                >
                  {runsOpen[s.id] ? "收起历史" : "触发历史"}
                </button>
                {/* 飞书 R86: 编辑按钮 —— 打开 EditScheduleModal 预填当前 schedule 字段 */}
                <button
                  onClick={() => openEdit(s)}
                  className="px-3 py-1.5 rounded text-sm bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 shadow-sm"
                >
                  编辑
                </button>
                <button
                  onClick={() => toggle(s.id, !s.enabled)}
                  className={`px-3 py-1.5 rounded text-sm shadow-sm ${
                    s.enabled
                      ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {s.enabled ? "停用" : "启用"}
                </button>
                {/* 飞书 R68 v2: 删除按钮（带二次确认） */}
                <button
                  onClick={() => setPendingDelete(s)}
                  className="px-3 py-1.5 rounded text-sm bg-white border border-red-300 text-red-600 hover:bg-red-50 shadow-sm"
                >
                  删除
                </button>
              </div>

              {/* 飞书 R86 (UI 二期): 非 hover 时右下角的「⋯」占位 —— 给非鼠标用户
                  「这里有操作」的暗示; hover/focus 时自身淡出 + pointer-events 关,
                  不与按钮组抢位置。绝对定位在按钮组正下方 1px, 视觉上像同一个元素。 */}
              <div
                aria-hidden="true"
                className="absolute bottom-3 right-3 z-0
                           flex items-center justify-center
                           w-9 h-9 rounded text-gray-400
                           group-hover:opacity-0 focus-within:opacity-0
                           transition-opacity duration-150"
              >
                <span className="text-lg leading-none">⋯</span>
              </div>
              </div>
              {/* ↑ R86 三期: 关闭头部内容 relative 容器, RunsPanel 在容器外 */}

              {/* 🆕 飞书 R75: 触发历史面板（折叠）。翻页与跳转见 RunsPanel。
                  🆕 R86 三期: RunsPanel 移到头部内容 div 之外(卡片 div 直接子元素),
                  避免被 absolute 锚在头部右下角的按钮组覆盖右上角翻页按钮。 */}
              {runsOpen[s.id] && (
                <RunsPanel
                  schedule={s}
                  page={runsPage[s.id] ?? 0}
                  data={runsData[s.id] ?? null}
                  loading={!!runsLoading[s.id]}
                  onPage={(p) => gotoPage(s.id, p)}
                  onShowFullLog={(r) => setLogDialogRun(r)}
                  toastError={toastError}
                />
              )}
            </div>
          );
        })}
      </main>

      {/* 🆕 R68 v2: 删除二次确认 */}
      <ConfirmDialog
        open={!!pendingDelete}
        title="删除定时任务？"
        message={
          pendingDelete
            ? `「${pendingDelete.name}」将立即删除，且不可恢复（不会软删除）。已触发过的历史也会一并删除。`
            : ""
        }
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            const target = pendingDelete;
            setPendingDelete(null);
            void doDelete(target);
          }
        }}
      />

      {/* 🆕 R68 v2: 新建 modal（半屏 modal 形式；够用即可，没拆独立文件） */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !creating && setCreateOpen(false)}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-[640px] max-w-[95vw] max-h-[90vh] overflow-auto p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">新建定时任务</h2>
            <div className="space-y-4">
              <ScheduleFormFields
                form={createForm}
                setForm={setCreateForm}
                projects={projects}
              />
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => !creating && setCreateOpen(false)}
                disabled={creating}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={submitCreate}
                disabled={creating}
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 R86: 编辑 modal —— 复用 ScheduleFormFields, 预填当前 schedule 字段;
          提交走 PATCH /api/schedules/[id]。exec_type 锁定不能改 (后端 PATCH 白名单
          不接受 exec_type, 见 src/lib/db/schedules.ts 的 UPDATABLE_SCHEDULE_FIELDS),
          避免 UI 切换类型但保存后无变化的歧义。 */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !editing && closeEdit()}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-[640px] max-w-[95vw] max-h-[90vh] overflow-auto p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              编辑定时任务
              <span className="ml-2 text-xs text-gray-400 font-mono">{editTarget.id.slice(0, 8)}</span>
            </h2>
            <div className="space-y-4">
              <ScheduleFormFields
                form={editForm}
                setForm={setEditForm}
                projects={projects}
                execTypeLocked
              />
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => !editing && closeEdit()}
                disabled={editing}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={submitEdit}
                disabled={editing}
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {editing ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 飞书 R79: 查看完整日志弹窗 —— 单条 run 的完整 output + error.
          shell 类型通常两边都有; agent 类型 output 一般空（看 task transcript 即可）,
          但仍保留入口, 避免「按钮时有时无」的 UI 闪烁. ESC 关闭, 点击 backdrop 关闭.
          与 ConfirmDialog 复用了相同的 fixed inset-0 z-50 模式, 没单独抽组件
          (本仓 R64 强调「禁止用原生 alert/confirm」, 但这个弹窗是 React 自渲染的 OK).
          🆕 飞书 R86: 流式改造 —— liveStdout/liveStderr 优先显示,fallback 到 DB
          静态字段 (liveStdout 空 + logDialogRun.output 非空 = 已完成的老 run)。
          状态徽章: 进行中 → 🟡 实时; 已完成 → 🟢 完成; 前端收到 completed:true 后自动切。 */}
      {logDialogRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setLogDialogRun(null)}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  完整日志
                  {liveCompleted ? (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">
                      已完成 {liveExitCode !== null && `· exit=${liveExitCode}`}
                    </span>
                  ) : (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-700">
                      实时推送中…
                    </span>
                  )}
                </h2>
                <p className="text-xs text-gray-500 mt-1 font-mono">
                  run #{logDialogRun.id} · {fmt(logDialogRun.started_at)}
                  {logDialogRun.completed_at && ` → ${fmt(logDialogRun.completed_at)}`}
                  {logDialogRun.exit_code !== null && ` · exit=${logDialogRun.exit_code}`}
                </p>
              </div>
              <button
                onClick={() => setLogDialogRun(null)}
                className="px-2 py-1 text-sm text-gray-500 hover:text-gray-700"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto space-y-4">
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">
                  stdout <span className="text-gray-400">(
                    {((liveStdout || logDialogRun.output) ?? "").length} 字符
                  )</span>
                </div>
                <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-800 whitespace-pre-wrap break-all max-h-[40vh] overflow-auto">
                  {(liveStdout || logDialogRun.output) || <span className="text-gray-400">（空）</span>}
                  <div ref={stdoutEndRef} />
                </pre>
              </div>
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">
                  stderr <span className="text-gray-400">(
                    {((liveStderr || logDialogRun.error) ?? "").length} 字符
                  )</span>
                </div>
                <pre className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs font-mono text-red-700 whitespace-pre-wrap break-all max-h-[40vh] overflow-auto">
                  {(liveStderr || logDialogRun.error) || <span className="text-gray-400">（空）</span>}
                  <div ref={stderrEndRef} />
                </pre>
              </div>
            </div>
            <div className="flex justify-end mt-4 pt-3 border-t">
              <button
                onClick={() => setLogDialogRun(null)}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400";

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="block mt-1 text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

// 🆕 R86: 抽取 schedule 表单字段渲染 —— 新建 + 编辑 modal 复用, 避免两份
//   ~100 行 JSX 漂移。execTypeLocked=true 时不渲染「执行体」Select, 改成只读
//   label (后端 PATCH 白名单不接受 exec_type, UI 上能改但保存无效是反模式)。
function ScheduleFormFields({
  form,
  setForm,
  projects,
  execTypeLocked = false,
}: {
  form: CreateFormState;
  setForm: React.Dispatch<React.SetStateAction<CreateFormState>>;
  projects: Project[];
  execTypeLocked?: boolean;
}) {
  return (
    <>
      {/* 基本 */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="任务名" required>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="例如：每日 9 点巡检"
            className={inputCls}
          />
        </Field>
        <Field label="时区" hint="IANA 名，默认 Asia/Shanghai">
          <input
            value={form.timezone}
            onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
            placeholder="Asia/Shanghai"
            className={inputCls}
          />
        </Field>
      </div>
      <Field label="执行体" required={!execTypeLocked} hint={execTypeLocked ? "编辑时不能切换类型（后端 PATCH 白名单不含 exec_type）" : undefined}>
        {execTypeLocked ? (
          <div className="text-sm text-gray-700 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
            {form.exec_type === "agent" ? "agent — 派给 Claude Code" : "shell — 直接执行命令"}
          </div>
        ) : (
          <Select
            value={form.exec_type}
            onChange={(v) => setForm((f) => ({ ...f, exec_type: v as "agent" | "shell" }))}
            options={[
              { value: "agent", label: "agent — 派给 Claude Code（创建并启动任务）" },
              { value: "shell", label: "shell — 直接执行命令（不进入任务队列）" },
            ]}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="调度类型" required>
          <Select
            value={form.schedule_type}
            onChange={(v) => setForm((f) => ({ ...f, schedule_type: v as "cron" | "once" }))}
            options={[
              { value: "cron", label: "cron 周期" },
              { value: "once", label: "once 一次性" },
            ]}
          />
        </Field>
        <Field
          label="调度表达式"
          required
          hint={form.schedule_type === "cron" ? "5 段：分 时 日 月 周，如 0 9 * * *" : "ISO 时间，如 2026-12-31T16:00:00Z"}
        >
          <input
            value={form.schedule_expr}
            onChange={(e) => setForm((f) => ({ ...f, schedule_expr: e.target.value }))}
            placeholder={form.schedule_type === "cron" ? "0 9 * * *" : "2026-12-31T16:00:00Z"}
            className={`${inputCls} font-mono`}
          />
        </Field>
      </div>
      <Field label="描述（可选）">
        <textarea
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          rows={2}
          placeholder="给这个 schedule 的备注"
          className={inputCls}
        />
      </Field>

      {/* agent 侧 */}
      {form.exec_type === "agent" && (
        <div className="space-y-3 border-t pt-3">
          <div className="text-sm font-medium text-gray-700">agent 字段</div>
          <Field label="项目" required>
            <Select
              value={form.project_id}
              onChange={(v) => setForm((f) => ({ ...f, project_id: v }))}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              placeholder={projects.length === 0 ? "（暂无项目）" : "选择项目"}
            />
          </Field>
          <Field label="任务标题" required hint="agent 派任务时显示的标题">
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="例如：每日项目状态巡检"
              className={inputCls}
            />
          </Field>
          {/* 🆕 飞书 R116: prompt 高度从 3 行 → 9 行（×3），长 prompt 不必再悬停在 1 行滚动条上看 */}
          <Field label="prompt" required hint="agent 派任务时收到的指令（自然语言）">
            <textarea
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
              rows={9}
              placeholder="检查项目状态并汇报"
              className={inputCls}
            />
          </Field>
        </div>
      )}

      {/* shell 侧 */}
      {form.exec_type === "shell" && (
        <div className="space-y-3 border-t pt-3">
          <div className="text-sm font-medium text-gray-700">shell 字段</div>
          <Field label="命令" required>
            <input
              value={form.command}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="例如：echo tick && date"
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="cwd（可选）" hint="默认 ORCHESTRATOR_HOME">
            <input
              value={form.cwd}
              onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
              placeholder="/path/to/workdir"
              className={`${inputCls} font-mono`}
            />
          </Field>
        </div>
      )}
    </>
  );
}

// 🆕 飞书 R75: 触发历史面板 —— 单条 schedule 的 runs 折叠区。
//   翻页通过 props 回调把 page 传回父组件, 父组件发起 fetch 后把 data 传回来。
//   表格列：开始时间 / 状态(成功/失败/进行中) / task_id 或 exit_code / stderr 前 N 行 / 查看 task。
//   🆕 R79: 多一列 stdout (灰色截断), shell 类型多了「查看完整日志」按钮 → 弹窗。
const PAGE_SIZE = 10;
const STDERR_PREVIEW = 200; // stderr 截断到 N 字符, 超过加 "…"
const STDOUT_PREVIEW = 200; // stdout 同款截断 (R79); 灰色显示, 与红色 stderr 区分.

function runsBadge(code: number | null): { text: string; cls: string } {
  if (code === null) return { text: "进行中", cls: "bg-yellow-100 text-yellow-700" };
  if (code === 0) return { text: `成功 (${code})`, cls: "bg-emerald-100 text-emerald-700" };
  return { text: `失败 (${code})`, cls: "bg-red-100 text-red-700" };
}

function RunsPanel({
  schedule,
  page,
  data,
  loading,
  onPage,
  onShowFullLog,
  toastError,
}: {
  schedule: Schedule;
  page: number;
  data: RunsResponse | null;
  loading: boolean;
  onPage: (p: number) => void;
  // 🆕 R79: 父组件管理弹窗状态, 子组件只回传 run 对象 (避免 panel 跨 schedule 共享).
  onShowFullLog: (r: ScheduleRun) => void;
  // 🆕 R53 R 列: 父组件注入 toastError, RunsPanel 在 agent 无 task_id 时弹错。
  //   不在这里自己 useToastActions(), 避免每次 re-render 重建订阅;
  //   父组件已经持有同一引用, 直接传下来。
  toastError: (msg: string) => void;
}) {
  const total = data?.total ?? 0;
  const runs = data?.runs ?? [];
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
  const canPrev = page > 0;
  const canNext = page + 1 < totalPages;

  return (
    <div className="mt-4 border-t border-gray-200 pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-gray-700">
          触发历史
          <span className="ml-2 text-xs text-gray-400">共 {total} 条 · 第 {page + 1} / {totalPages} 页</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => canPrev && onPage(page - 1)}
            disabled={!canPrev || loading}
            className="px-2.5 py-1 rounded text-xs border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <button
            onClick={() => canNext && onPage(page + 1)}
            disabled={!canNext || loading}
            className="px-2.5 py-1 rounded text-xs border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      </div>

      {loading && runs.length === 0 && (
        <div className="text-sm text-gray-400 py-4 text-center">加载中…</div>
      )}

      {!loading && total === 0 && (
        <div className="text-sm text-gray-400 py-4 text-center">暂无触发记录</div>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs table-fixed">
            <colgroup>
              <col className="w-40" />  {/* 开始时间 160px */}
              <col className="w-40" />  {/* 结束时间 160px */}
              <col className="w-16" />  {/* 类型 64px */}
              <col className="w-20" />  {/* 状态 80px */}
              <col />                    {/* 命令/输出/错误 (自适应剩余) */}
              <col className="w-24" />  {/* 操作 96px (按钮专用) */}
            </colgroup>
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-1.5 pr-3 font-medium">开始时间</th>
                <th className="py-1.5 pr-3 font-medium">结束时间</th>
                <th className="py-1.5 pr-3 font-medium">类型</th>
                <th className="py-1.5 pr-3 font-medium">状态</th>
                <th className="py-1.5 pr-3 font-medium">
                  {schedule.exec_type === "agent" ? "任务 / 错误" : "命令 / 输出 / 错误"}
                </th>
                {/* 🆕 R53 R 列第 6 轮: 操作列独立成第 6 列。
                    上一轮把按钮塞在「命令 / 输出 / 错误」同一 flex 行内, 即便三层兜底
                    (td max-w-xl / code max-w-md / button ml-auto) 长命令仍能挤出按钮。
                    这次直接把按钮提到独立列 — 操作列只有按钮, 不受命令长度影响。 */}
                <th className="py-1.5 pr-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const eb = runsBadge(r.exit_code);
                // 🆕 R79: 有 output 或 error 才显示「查看完整日志」按钮;
                //   都没有 = 弹窗打开只会显示两个「空」, 加按钮反而是噪声.
                // 🆕 R53 R 列追加: 无论有无 output, 都给一个统一「查看日志」按钮。
                //   - agent + task_id: 跳到 /tasks/{task_id} 看 transcript (agent 的「日志」是任务流)
                //   - shell: 弹 LogViewerDialog 看 stdout/stderr (即时空也展示, UI 标「（空）」)
                //   - agent 无 task_id (极端: 调度器派出前就挂): 按钮禁用 + toast 提示
                const hasAnyLog = !!(r.output || r.error);
                return (
                  <tr key={r.id} className="border-b border-gray-100 align-top">
                    <td className="py-1.5 pr-3 font-mono text-gray-700">{fmt(r.started_at)}</td>
                    <td className="py-1.5 pr-3 font-mono text-gray-700">
                      {r.completed_at ? fmt(r.completed_at) : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-gray-600">{r.exec_type}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`px-1.5 py-0.5 rounded-full text-xs ${eb.cls}`}>{eb.text}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      {/* 🆕 R53 R 列第 6 轮: 5th 列只装命令/输出/错误, 不再带按钮。
                          之前按钮在 5th 列里 + flex 容器 + max-w-md + ml-auto 仍被长命令
                          挤掉 → damo 第 6 轮要求「按钮放最后一列」。
                          现在按钮已提到独立 6th 列, 这里只保留:
                          - agent + task_id: Link + 「查看 task」span (直接 inline)
                          - shell + command: <code> (自限宽, cell 内换行)
                          - 下方 stdout/stderr 块级 pre */}
                      <div>
                        {schedule.exec_type === "agent" && r.task_id && (
                          <span className="inline-flex items-center gap-2 mr-2">
                            <Link
                              href={`/tasks/${r.task_id}`}
                              className="text-blue-600 hover:underline font-mono"
                            >
                              {r.task_id.slice(0, 8)}
                            </Link>
                            <span className="text-gray-400">查看 task</span>
                          </span>
                        )}
                        {schedule.exec_type === "shell" && r.command && (
                          <code className="font-mono text-gray-600 break-all bg-gray-50 px-1.5 py-0.5 rounded text-xs">
                            $ {r.command}
                          </code>
                        )}
                      </div>
                      {/* 🆕 R79: shell 类型的 stdout 截断预览（agent 类型 output 字段本就是空, 不展示）。
                          保留块级 pre (独占一行) — 命令/链接已是顶部一行, 长输出自然另起。 */}
                      {schedule.exec_type === "shell" && r.output && (
                        <pre className="mt-1 text-xs text-gray-600 whitespace-pre-wrap break-all">
                          {r.output.length > STDOUT_PREVIEW
                            ? r.output.slice(0, STDOUT_PREVIEW) + "…"
                            : r.output}
                        </pre>
                      )}
                      {r.error && (
                        <pre className="mt-1 text-xs text-red-700 whitespace-pre-wrap break-all">
                          {r.error.length > STDERR_PREVIEW
                            ? r.error.slice(0, STDERR_PREVIEW) + "…"
                            : r.error}
                        </pre>
                      )}
                    </td>
                    {/* 🆕 R53 R 列第 6 轮: 6th 「操作」列只放「查看日志」按钮。
                        独立成列后按钮永远在第一行右侧, 不再受命令长度影响。 */}
                    <td className="py-1.5 pr-3 text-right">
                      <button
                        onClick={() => {
                          if (schedule.exec_type === "agent") {
                            if (r.task_id) {
                              window.location.href = `/tasks/${r.task_id}`;
                            } else {
                              toastError("该 run 没有关联 task_id, 无法跳转");
                            }
                            return;
                          }
                          // shell: 弹 LogViewerDialog (即时空也展示, modal 里有「（空）」占位)
                          onShowFullLog(r);
                        }}
                        disabled={schedule.exec_type === "agent" && !r.task_id}
                        title={
                          schedule.exec_type === "agent" && !r.task_id
                            ? "该 run 未生成 task"
                            : schedule.exec_type === "agent"
                              ? "查看任务的完整 transcript"
                              : hasAnyLog
                                ? "查看 stdout / stderr 完整日志"
                                : "本次执行无输出, 可点开确认"
                        }
                        className="inline-flex items-center text-xs text-blue-600 hover:bg-blue-50 hover:underline px-1.5 py-0.5 rounded disabled:text-gray-400 disabled:cursor-not-allowed disabled:no-underline disabled:hover:bg-transparent"
                      >
                        查看日志 →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
