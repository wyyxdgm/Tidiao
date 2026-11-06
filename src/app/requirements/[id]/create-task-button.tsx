"use client";

// 飞书 R60 §3.1 — 详情页「关联任务」section 「+ 新建任务」按钮 + 弹窗表单.
//
// 功能: 打开弹窗, 收 title (必填) / prompt (必填) / type (必选, workflow 阶段)
//   / 立即启动 vs 留待启动 (默认立即) / auto_approve / effort / max_turns /
//   allowed_tools (multi-toggle). 提交 POST /api/tasks body 带 requirement_id +
//   project_id (继承). 「立即启动」路径创建后立刻 POST /api/tasks/[id]/start
//   让 agent SDK 立刻进入调度队列;「留待启动」只创建, 详情页显示「未启动」徽章.
//
// 关注点:
//   - 不让用户在弹窗里选 project / version: 这俩从 requirement 继承 (用户在
//     详情页弹窗 = 已确定 scope, 改 project/version 跨越需求点语义, 不合理).
//   - 弹窗自定义 modal (不用 ConfirmDialog): 表单字段多, ConfirmDialog 是
//     简化版两按钮弹窗, 不适合. 借鉴 ConfirmDialog 的 backdrop / scale-in 动画
//     风格, 自写.
//   - 失败用 Toast (useToastActions); 成功也用 Toast 提示; 弹窗内错误条用
//     顶部红色 alert 条 (与 new-requirement-form 同款).
//   - Esc 关弹窗 + backdrop click 关弹窗 (与 ConfirmDialog 同手感).
//   - type 字段是 R78 W1 §4.3 invariant 前置: 弹窗必须让用户标 workflow 阶段
//     (design/dev/test/deploy/null), 否则下游 invariant 检查无数据可用.
//   - 启动时机 toggle: 默认立即启动, 与 /tasks/[id] 详情页行为一致; 选「留待
//     启动」= 用户主动延后决策. 立即启动失败 (e.g. quota / runtime busy) 不回
//     滚已创建的 task, 弹 toast 提示用户去 /tasks/[id] 手动启.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EFFORT_LEVELS, TOOL_PRESETS, AVAILABLE_TOOLS } from "@/lib/constants";
import Select from "@/components/Select";
import { useToastActions } from "@/components/Toast";

interface CreateTaskButtonProps {
  requirementId: string;
  projectId: string;
  versionId: string | null;
}

// R78 W1 §4.3 invariant 前置. 与 src/lib/runtime/types.ts 的 TaskType 同源
// (排除 null 选项: UI 必须强制选一个 workflow 阶段, 避免「未分类」误入 invariant
// 校验盲区).
type TaskTypeOption = "design" | "dev" | "test" | "deploy";
const TASK_TYPE_OPTIONS: Array<{ value: TaskTypeOption; label: string }> = [
  { value: "design", label: "设计 / 调研" },
  { value: "dev", label: "实现 / 开发" },
  { value: "test", label: "测试" },
  { value: "deploy", label: "部署 / 上线" },
];

export default function CreateTaskButton({
  requirementId,
  projectId,
  versionId,
}: CreateTaskButtonProps) {
  const router = useRouter();
  const { success: toastSuccess, error: toastError } = useToastActions();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 表单字段 — 默认值贴近 new-task 完整配置的「快速模式」默认值, 让点击即用.
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [taskType, setTaskType] = useState<TaskTypeOption>("dev");
  // R78 W1 §4.2: 启动时机 toggle. 默认 true = 立即启动 (保持现有行为).
  const [autoStart, setAutoStart] = useState(true);
  const [autoApprove, setAutoApprove] = useState(true);
  const [effort, setEffort] = useState<string>("high");
  const [maxTurns, setMaxTurns] = useState<string>("200");
  const [allowedTools, setAllowedTools] = useState<string[]>([...AVAILABLE_TOOLS]);

  const titleRef = useRef<HTMLInputElement>(null);

  // Esc 关弹窗 (与 ConfirmDialog 同手感)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // 打开时聚焦 title (与 tasks/new 同款)
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  function toggleTool(tool: string) {
    setAllowedTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    );
  }

  function resetForm() {
    setTitle("");
    setPrompt("");
    setTaskType("dev");
    setAutoStart(true);
    setAutoApprove(true);
    setEffort("high");
    setMaxTurns("200");
    setAllowedTools([...AVAILABLE_TOOLS]);
    setFormError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!title.trim()) {
      setFormError("标题必填");
      return;
    }
    if (!prompt.trim()) {
      setFormError("任务指令必填");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        prompt: prompt.trim(),
        type: taskType,
        autoApprove,
        effort,
        maxTurns: parseInt(maxTurns, 10) || undefined,
        allowedTools,
        project_id: projectId,
        requirement_id: requirementId,
      };
      if (versionId) body.version_id = versionId;
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const code = data.code ? ` [${data.code}]` : "";
        throw new Error(`${data.error || res.statusText}${code}`);
      }
      const task = await res.json();

      // R78 W1 §4.2: 「立即启动」= 创建后立刻 POST /api/tasks/[id]/start;
      // 「留待启动」= 只创建, 详情页「未启动」徽章 (W3 才接) 提示用户.
      if (autoStart) {
        const startRes = await fetch(`/api/tasks/${task.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!startRes.ok) {
          const data = await startRes.json().catch(() => ({}));
          const code = data.code ? ` [${data.code}]` : "";
          toastError(
            `任务已创建但启动失败: ${data.error || startRes.statusText}${code} (去任务页手动启)`
          );
        } else {
          const started = await startRes.json();
          toastSuccess(`任务已创建并启动: ${task.title} (${started.status})`);
        }
      } else {
        toastSuccess(`任务已创建 (留待启动): ${task.title}`);
      }

      setOpen(false);
      resetForm();
      router.refresh();
    } catch (err: any) {
      const msg = err?.message || "创建失败";
      setFormError(msg);
      toastError(`创建失败: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
      >
        + 新建任务
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !submitting && setOpen(false)}
          />
          {/* Dialog */}
          <form
            onSubmit={handleSubmit}
            className="relative bg-white rounded-xl shadow-2xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-y-auto p-6 space-y-4"
          >
            <h3 className="text-lg font-semibold text-gray-900">为这个需求点新建任务</h3>

            {formError && (
              <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{formError}</div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">标题 *</label>
              <input
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="例: 修复登录页响应式"
                maxLength={200}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">任务指令 *</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm h-32 font-mono"
                placeholder="实际传给 agent 的指令..."
                required
              />
              <p className="mt-1 text-xs text-gray-500">
                关联到这个需求点后, 后续可拉出"任务森林"视图 (含依赖关系).
              </p>
            </div>

            {/* R78 W1 §4.3 invariant 前置: type 必选. 影响下游「可标完成」校验. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                任务阶段 *
              </label>
              <Select
                value={taskType}
                onChange={(v) => setTaskType(v as TaskTypeOption)}
                options={TASK_TYPE_OPTIONS}
              />
              <p className="mt-1 text-xs text-gray-500">
                {taskType === "design"
                  ? "设计/调研 — 完成不计入「可标完成」前置条件"
                  : "实现/测试/部署 — 完成计入「可标完成」前置条件"}
              </p>
            </div>

            {/* R78 W1 §4.2: 启动时机 toggle. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">启动时机</label>
              <Select
                value={autoStart ? "now" : "later"}
                onChange={(v) => setAutoStart(v === "now")}
                options={[
                  { value: "now", label: "立即启动 (创建后立刻进入调度队列)" },
                  { value: "later", label: "只创建待启动 (用户在任务页手动启动)" },
                ]}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">推理强度</label>
                <Select
                  value={effort}
                  onChange={setEffort}
                  options={EFFORT_LEVELS.map((e) => ({ value: e, label: e }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">最大轮次</label>
                <input
                  type="number"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  min="1"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">工具审核</label>
              <Select
                value={autoApprove ? "on" : "off"}
                onChange={(v) => setAutoApprove(v === "on")}
                options={[
                  { value: "off", label: "需要逐个审核" },
                  { value: "on", label: "自动通过（不审核）" },
                ]}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">允许的工具</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {TOOL_PRESETS.map((p) => {
                  const active =
                    p.tools.length === allowedTools.length &&
                    p.tools.every((t) => allowedTools.includes(t));
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setAllowedTools([...p.tools])}
                      className={`px-2.5 py-1 rounded-full text-xs border ${
                        active
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-gray-50 text-gray-600 border-gray-300 hover:border-blue-400"
                      }`}
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
                      allowedTools.includes(tool)
                        ? "bg-blue-100 text-blue-700 border border-blue-300"
                        : "bg-gray-100 text-gray-500 border border-gray-200"
                    }`}
                  >
                    {tool}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-3 justify-end pt-2 border-t mt-2">
              <button
                type="button"
                onClick={() => !submitting && setOpen(false)}
                disabled={submitting}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting || !title.trim() || !prompt.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? "创建中…" : autoStart ? "创建并启动" : "创建待启动"}
              </button>
            </div>
          </form>

          </div>
      )}
    </>
  );
}