"use client";

import { useState, useEffect } from "react";
import { parseJsonImport, parseCsvImport, parseMarkdownImport } from "@/lib/import/parsers";
import type { ImportedTaskDefinition } from "@/lib/import/parsers";
import Select from "@/components/Select";

type ImportFormat = "json" | "csv" | "markdown";

const FORMAT_HELP: Record<ImportFormat, string> = {
  json: `[{"title": "任务标题", "prompt": "详细指令", "description": "可选描述", "tags": ["tag1"]}]`,
  csv: `title,prompt,description,tags
任务标题,详细指令,可选描述,tag1;tag2`,
  markdown: `- [ ] 任务标题
  : 详细指令（可选）
- [ ] 另一个任务`,
};

export default function ImportPage() {
  const [format, setFormat] = useState<ImportFormat>("json");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<ImportedTaskDefinition[] | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors?: string[] } | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [versions, setVersions] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState("");
  const [versionId, setVersionId] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => setProjects(data.projects || []))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!projectId) {
      setVersions([]);
      setVersionId("");
      return;
    }
    fetch(`/api/versions?project=${projectId}`)
      .then((res) => res.json())
      .then((data) => setVersions(data.versions || []))
      .catch(() => setVersions([]));
  }, [projectId]);

  function handleParse() {
    setResult(null);
    let parsed;
    switch (format) {
      case "json":
        parsed = parseJsonImport(content);
        break;
      case "csv":
        parsed = parseCsvImport(content);
        break;
      case "markdown":
        parsed = parseMarkdownImport(content);
        break;
    }
    setPreview(parsed.tasks);
    setParseErrors(parsed.errors);
  }

  async function handleImport() {
    if (!preview || preview.length === 0) return;
    setImporting(true);
    setResult(null);

    try {
      const res = await fetch(`/api/import/${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          project_id: projectId,
          version_id: versionId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setParseErrors([data.error || "导入失败"]);
      } else {
        setResult({ imported: data.imported, errors: data.errors });
        setPreview(null);
        setContent("");
      }
    } catch (err: any) {
      setParseErrors([err.message]);
    } finally {
      setImporting(false);
    }
  }

  return (
    // 🆕 飞书 R139 第四批: /import 右滚修复——根 plain div 无 overflow, 加 h-full overflow-y-auto.
    <div className="h-full overflow-y-auto max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">批量导入任务</h1>
        <a href="/" className="text-blue-600 text-sm hover:underline">← 返回任务列表</a>
      </div>

      {/* Import target */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">项目 *</label>
          <Select
            value={projectId}
            onChange={(v) => { setProjectId(v); setVersionId(""); }}
            options={[{ value: "", label: "请选择项目" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            placeholder="请选择项目"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">版本</label>
          <Select
            value={versionId}
            onChange={setVersionId}
            options={[{ value: "", label: "其他任务（无版本）" }, ...versions.map((v) => ({ value: v.id, label: v.name }))]}
            disabled={!projectId}
          />
        </div>
      </div>

      {/* Format selector */}
      <div className="flex gap-2 mb-4">
        {(["json", "csv", "markdown"] as ImportFormat[]).map((f) => (
          <button
            key={f}
            onClick={() => { setFormat(f); setPreview(null); setParseErrors([]); setResult(null); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${
              format === f
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {f.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Format help */}
      <div className="bg-gray-50 rounded-lg p-3 mb-4 text-xs text-gray-600 font-mono whitespace-pre-wrap">
        {FORMAT_HELP[format]}
      </div>

      {/* Content input */}
      <textarea
        value={content}
        onChange={(e) => { setContent(e.target.value); setPreview(null); setParseErrors([]); setResult(null); }}
        placeholder={`粘贴 ${format.toUpperCase()} 内容...`}
        className="w-full h-64 border rounded-lg p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {/* Action buttons */}
      <div className="flex gap-3 mt-4">
        <button
          onClick={handleParse}
          disabled={!content.trim()}
          className="bg-gray-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          预览解析
        </button>
        {preview && preview.length > 0 && (
          <button
            onClick={handleImport}
            disabled={importing || !projectId}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? "导入中..." : `确认导入 (${preview.length} 个任务)`}
          </button>
        )}
      </div>

      {/* Parse errors */}
      {parseErrors.length > 0 && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
          {parseErrors.map((err, i) => (
            <div key={i} className="text-sm text-red-700">⚠️ {err}</div>
          ))}
        </div>
      )}

      {/* Import result */}
      {result && (
        <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="text-sm text-green-700">✅ 成功导入 {result.imported} 个任务</div>
          {result.errors?.map((err, i) => (
            <div key={i} className="text-sm text-yellow-700">⚠️ {err}</div>
          ))}
        </div>
      )}

      {/* Preview */}
      {preview && preview.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-3">预览 ({preview.length} 个任务)</h2>
          <div className="space-y-2">
            {preview.map((task, i) => (
              <div key={i} className="bg-white border rounded-lg p-3">
                <div className="font-medium text-sm">{i + 1}. {task.title}</div>
                <div className="text-xs text-gray-500 mt-1 line-clamp-2">{task.prompt}</div>
                {task.tags && task.tags.length > 0 && (
                  <div className="flex gap-1 mt-1">
                    {task.tags.map((tag, j) => (
                      <span key={j} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
