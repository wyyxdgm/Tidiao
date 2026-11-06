"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { EFFORT_LEVELS } from "@/lib/constants";
import { parseDbTime } from "@/lib/datetime";
import Select from "@/components/Select";
import { useToastActions } from "@/components/Toast";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useAvailableModels } from "@/lib/hooks/use-available-models";

type Template = {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  model: string | null;
  llm_config_id: string | null; // v50: 模板绑定的 LLM 配置 FK
  max_turns: number | null;
  effort: string | null;
  auto_approve: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
};

// v50: LLM 配置可见列表 (自配 + 平台授权). 用于卡片显示配置名 + 表单 Select.
type AvailableLlmConfig = {
  id: string;
  source: "self" | "admin_grant";
  name: string;
  is_default: boolean;
};


export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [availableLlmConfigs, setAvailableLlmConfigs] = useState<AvailableLlmConfig[]>([]);

  // R56-B4 模型下拉统一: 走 useAvailableModels() 拿 configured + builtin + used
  // 三源并集, 不再 import lib/constants 的 MODEL_OPTIONS 副本.
  const { options: modelOptions } = useAvailableModels();

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch("/api/templates");
      if (res.ok) setTemplates(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  // v50: 拉一次可用 LLM 配置, 给卡片 Meta row 查配置名 + 表单 Select 用
  useEffect(() => {
    fetch("/api/user/llm-config/available")
      .then((res) => res.json())
      .then((data) => setAvailableLlmConfigs(data.configs || []))
      .catch(() => setAvailableLlmConfigs([]));
  }, []);

  return (
    // 🆕 飞书 R139 第二批: 右滚修复 — 同 schedules/runners 套路.
    <div className="h-full flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-gray-600 hover:text-gray-900 text-sm">← 返回</Link>
            <h1 className="text-xl font-semibold text-gray-900">模板管理</h1>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            {showForm ? "取消" : "+ 新建模板"}
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-5xl w-full mx-auto px-6 py-6">
        {showForm && (
          <CreateTemplateForm
            onCreated={() => { setShowForm(false); fetchTemplates(); }}
            onCancel={() => setShowForm(false)}
          />
        )}

        {editingTemplate && (
          <EditTemplateForm
            template={editingTemplate}
            onSaved={() => { setEditingTemplate(null); fetchTemplates(); }}
            onCancel={() => setEditingTemplate(null)}
          />
        )}

        {loading ? (
          <div className="text-center py-20 text-gray-400">加载中...</div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <p className="text-lg mb-2">暂无模板</p>
            <p className="text-sm text-gray-400">创建模板可以快速复用常用任务配置</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onDeleted={fetchTemplates}
                onEdit={setEditingTemplate}
                availableLlmConfigs={availableLlmConfigs}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ---- Template Card ----

function TemplateCard({
  template,
  onDeleted,
  onEdit,
  availableLlmConfigs,
}: {
  template: Template;
  onDeleted: () => void;
  onEdit: (t: Template) => void;
  availableLlmConfigs: AvailableLlmConfig[];
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { error: toastError } = useToastActions();

  async function handleDelete() {
    try {
      const res = await fetch(`/api/templates/${template.id}`, { method: "DELETE" });
      if (res.ok) onDeleted();
      else toastError("删除失败");
    } catch {
      toastError("删除失败");
    } finally {
      setConfirmDelete(false);
    }
  }

  // Build URL params for task instantiation
  const params = new URLSearchParams();
  params.set("prompt", template.prompt);
  params.set("name", template.name);
  if (template.model) params.set("model", template.model);
  if (template.llm_config_id) params.set("llm_config_id", template.llm_config_id);
  if (template.effort) params.set("effort", template.effort);
  if (template.max_turns) params.set("maxTurns", String(template.max_turns));
  if (template.auto_approve) params.set("autoApprove", "true");
  const parsedTags = template.tags ? (() => { try { return JSON.parse(template.tags); } catch { return []; } })() : [];
  if (parsedTags.length > 0) params.set("tags", parsedTags.join(","));

  // v50: 查 LLM 配置名; 查不到时 fallback 后 8 位 (避免泄漏全 id, 不暴露「该配置已存在」)
  const llmConfigName = template.llm_config_id
    ? (availableLlmConfigs.find((c) => c.id === template.llm_config_id)?.name ?? `#${template.llm_config_id.slice(-8)}`)
    : null;

  const instantiateUrl = `/tasks/new?${params.toString()}`;

  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 hover:border-blue-300 hover:shadow-sm transition-all flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-gray-900 truncate">{template.name}</h3>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onEdit(template)}
            className="text-gray-300 hover:text-blue-500 transition-colors"
            title="编辑模板"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM5 12.586V14h1.414l7.586-7.586L12.586 5 5 12.586z" />
            </svg>
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-gray-300 hover:text-red-500 transition-colors"
            title="删除模板"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>

      {/* Prompt summary */}
      <p className="text-sm text-gray-500 mt-1 line-clamp-3 flex-1">{template.prompt}</p>

      {/* Meta row */}
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 flex-wrap">
        {llmConfigName && <span className="text-blue-600">LLM: {llmConfigName}</span>}
        {template.model && <span>{template.model}</span>}
        {template.effort && <span>{template.effort}</span>}
        {template.max_turns && <span>{template.max_turns} 轮</span>}
        {template.auto_approve && <span className="text-green-600">自动审批</span>}
        {parsedTags.length > 0 && (
          <div className="flex gap-1 overflow-hidden">
            {parsedTags.slice(0, 3).map((tag: string, i: number) => (
              <span key={i} className="bg-gray-100 text-gray-500 px-1 py-0.5 rounded truncate">{tag}</span>
            ))}
          </div>
        )}
        <span className="ml-auto shrink-0">
          {parseDbTime(template.created_at)?.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) ?? ""}
        </span>
      </div>

      {/* Instantiate button */}
      <Link
        href={instantiateUrl}
        className="mt-3 block text-center bg-gray-50 hover:bg-blue-50 hover:text-blue-600 text-gray-600 text-sm font-medium py-1.5 rounded-lg border border-gray-200 hover:border-blue-300 transition-colors"
      >
        从此模板创建任务
      </Link>

      <ConfirmDialog
        open={confirmDelete}
        title="删除模板"
        message={`删除模板「${template.name}」？`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

// ---- Create Template Form ----

function CreateTemplateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const { error: toastError } = useToastActions();
  const { options: modelOptions } = useAvailableModels();
  const [form, setForm] = useState({
    name: "",
    prompt: "",
    model: "",
    llm_config_id: "",
    effort: "",
    maxTurns: "",
    autoApprove: false,
    tags: "",
  });
  // v50: 可见的 LLM 配置 (自配 + 平台授权); 拉一次缓存
  const [availableLlmConfigs, setAvailableLlmConfigs] = useState<AvailableLlmConfig[]>([]);

  useEffect(() => {
    fetch("/api/user/llm-config/available")
      .then((res) => res.json())
      .then((data) => setAvailableLlmConfigs(data.configs || []))
      .catch(() => setAvailableLlmConfigs([]));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.prompt) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          prompt: form.prompt,
          model: form.model || undefined,
          llm_config_id: form.llm_config_id || undefined,
          effort: form.effort || undefined,
          maxTurns: form.maxTurns ? parseInt(form.maxTurns) : undefined,
          autoApprove: form.autoApprove,
          tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      onCreated();
    } catch {
      toastError("创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold mb-4">新建模板</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">模板名称 *</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
            placeholder="例如：代码审查"
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Prompt *</label>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm h-32 font-mono"
            placeholder="模板的 agent 指令..."
          />
        </div>

        {/* Optional config row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">模型</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              list="template-model-options"
              placeholder="默认 / 选择 / 自定义"
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <datalist id="template-model-options">
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value} />
              ))}
            </datalist>
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
              选「默认」按解析链；选具体某份即模板用此配置。用此模板创建任务时自动沿用。
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">推理强度</label>
            <Select
              value={form.effort}
              onChange={(v) => setForm({ ...form, effort: v })}
              options={[{ value: "", label: "默认" }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))]}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">最大轮次</label>
            <input
              type="number"
              value={form.maxTurns}
              onChange={(e) => setForm({ ...form, maxTurns: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="默认"
              min="1"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.autoApprove}
                onChange={(e) => setForm({ ...form, autoApprove: e.target.checked })}
                className="rounded"
              />
              自动审批
            </label>
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
            placeholder="review, code（逗号分隔）"
          />
        </div>

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting || !form.name || !form.prompt}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "创建中..." : "创建模板"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="border border-gray-300 text-gray-700 px-6 py-2 rounded-lg text-sm"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

// ---- Edit Template Form (parallel to Create; v50 增加 llm_config_id 编辑入口) ----

function EditTemplateForm({
  template,
  onSaved,
  onCancel,
}: {
  template: Template;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const { error: toastError } = useToastActions();
  const { options: modelOptions } = useAvailableModels();
  // 注意: prompt 在 backend updateTemplate 里「字段在 patch 中就覆盖」(非空校验仅 create 走), 故这里必须传回原值避免误清空
  const [form, setForm] = useState({
    name: template.name,
    prompt: template.prompt,
    model: template.model ?? "",
    llm_config_id: template.llm_config_id ?? "",
    effort: template.effort ?? "",
    maxTurns: template.max_turns ? String(template.max_turns) : "",
    autoApprove: !!template.auto_approve,
    tags: template.tags ? (() => { try { return (JSON.parse(template.tags) as string[]).join(","); } catch { return ""; } })() : "",
  });
  const [availableLlmConfigs, setAvailableLlmConfigs] = useState<AvailableLlmConfig[]>([]);

  useEffect(() => {
    fetch("/api/user/llm-config/available")
      .then((res) => res.json())
      .then((data) => setAvailableLlmConfigs(data.configs || []))
      .catch(() => setAvailableLlmConfigs([]));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.prompt) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          prompt: form.prompt,
          model: form.model || null,
          llm_config_id: form.llm_config_id || null,
          effort: form.effort || null,
          maxTurns: form.maxTurns ? parseInt(form.maxTurns) : null,
          autoApprove: form.autoApprove,
          tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        }),
      });
      if (!res.ok) throw new Error("Failed");
      onSaved();
    } catch {
      toastError("保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">编辑模板</h2>
        <span className="text-xs text-gray-400 font-mono">#{template.id.slice(0, 8)}</span>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">模板名称 *</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Prompt *</label>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm h-32 font-mono"
          />
        </div>

        {/* Optional config row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">模型</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              list="edit-template-model-options"
              placeholder="留空 = 不覆盖"
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <datalist id="edit-template-model-options">
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value} />
              ))}
            </datalist>
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
              选「默认」按解析链；选具体某份即模板用此配置。
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">推理强度</label>
            <Select
              value={form.effort}
              onChange={(v) => setForm({ ...form, effort: v })}
              options={[{ value: "", label: "默认" }, ...EFFORT_LEVELS.map((e) => ({ value: e, label: e }))]}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">最大轮次</label>
            <input
              type="number"
              value={form.maxTurns}
              onChange={(e) => setForm({ ...form, maxTurns: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              placeholder="默认"
              min="1"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.autoApprove}
                onChange={(e) => setForm({ ...form, autoApprove: e.target.checked })}
                className="rounded"
              />
              自动审批
            </label>
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
            placeholder="review, code（逗号分隔）"
          />
        </div>

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting || !form.name || !form.prompt}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "保存中..." : "保存修改"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="border border-gray-300 text-gray-700 px-6 py-2 rounded-lg text-sm"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
