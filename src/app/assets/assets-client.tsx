"use client";

// /assets 客户端组件: 表格 + 顶部工具栏 + 批量删 + 单删.
// 数据源: GET /api/assets (列表) + GET /api/assets/filters (project/version 下拉).
//
// 关注点:
//   - 复用 <Select> / <ConfirmDialog> / <useToast> (封装组件, 不引原生).
//   - 跨 owner 隔离: 全部走服务端 owner_id 过滤, 前端只管渲染.
//   - 排序 / 筛选 / 搜索全部走 URLSearchParams, 切页不丢状态 (刷新还在).
//   - 默认 sort = created_at desc, limit=50.
//   - 不提供「物理全清」按钮 (damo 拍板, 防误删).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Select from "@/components/Select";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToastActions } from "@/components/Toast";

interface AssetItem {
  id: string;
  task_id: string;
  task_title: string | null;
  project_id: string | null;
  version_id: string | null;
  owner_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  source: string;
  created_at: string;
}

interface FilterProj {
  id: string;
  name: string;
  count: number;
  versions: Array<{ id: string; name: string; count: number }>;
}

interface FilterData {
  projects: FilterProj[];
  orphan_count: number;
}

type TypeFilter = "" | "image" | "video" | "audio" | "file";

const TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "file", label: "其他文件" },
];

type SourceFilter = "" | "upload" | "agent_generated" | "fork";

const SOURCE_OPTIONS = [
  { value: "", label: "全部来源" },
  { value: "agent_generated", label: "AI 生成" },
  { value: "upload", label: "人工上传" },
  { value: "fork", label: "Fork 继承" },
];

// source 枚举值 -> 中文标签 + 配色 (给表格徽章用).
const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  agent_generated: { label: "AI 生成", cls: "bg-purple-100 text-purple-700" },
  upload: { label: "人工上传", cls: "bg-blue-100 text-blue-700" },
  fork: { label: "Fork 继承", cls: "bg-amber-100 text-amber-700" },
};

const SORT_OPTIONS = [
  { value: "created_at:desc", label: "最新优先" },
  { value: "created_at:asc", label: "最旧优先" },
  { value: "size_bytes:desc", label: "大小 ↓" },
  { value: "size_bytes:asc", label: "大小 ↑" },
  { value: "filename:asc", label: "文件名 A→Z" },
  { value: "filename:desc", label: "文件名 Z→A" },
];

const PAGE_LIMIT = 50;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function typeLabel(mt: string): string {
  if (mt.startsWith("image/")) return "图片";
  if (mt.startsWith("video/")) return "视频";
  if (mt.startsWith("audio/")) return "音频";
  return "文件";
}

function fileIcon(mt: string): string {
  if (mt.startsWith("image/")) return "🖼️";
  if (mt.startsWith("video/")) return "🎬";
  if (mt.startsWith("audio/")) return "🎵";
  if (mt.includes("pdf")) return "📄";
  if (mt.includes("zip") || mt.includes("gzip") || mt.includes("tar")) return "📦";
  if (mt.startsWith("text/")) return "📝";
  return "📎";
}

export default function AssetsClient() {
  const toast = useToastActions();
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FilterData>({ projects: [], orphan_count: 0 });

  // 筛选 / 搜索 / 排序
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [type, setType] = useState<TypeFilter>("");
  const [source, setSource] = useState<SourceFilter>("");
  const [projectId, setProjectId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [sort, setSort] = useState("created_at:desc");
  const [offset, setOffset] = useState(0);

  // 批量选择
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatchOpen, setConfirmBatchOpen] = useState(false);

  // 单删确认
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // 拉 project / version 下拉
  useEffect(() => {
    fetch("/api/assets/filters")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: FilterData | null) => {
        if (d) setFilters(d);
      })
      .catch(() => {});
  }, []);

  // 拉列表 (loading 初始为 true, 数据到达后置 false; 不在 effect 里 setState 触发级联 render)
  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (type) params.set("type", type);
    if (source) params.set("source", source);
    if (projectId) params.set("project_id", projectId);
    if (versionId) params.set("version_id", versionId);
    params.set("sort", sort);
    params.set("limit", String(PAGE_LIMIT));
    params.set("offset", String(offset));
    fetch(`/api/assets?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { assets: AssetItem[]; total: number } | null) => {
        if (d) {
          setAssets(d.assets);
          setTotal(d.total);
          setSelected(new Set()); // 切换筛选后清空选择
        }
      })
      .catch(() => {
        toast.error("加载资源列表失败");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, type, source, projectId, versionId, sort, offset]);

  // 提交搜索 (debounce 不做, Enter 触发)
  function commitSearch() {
    setOffset(0);
    setSearch(searchInput.trim());
  }

  // 项目下拉变了, 清掉 version
  function onProjectChange(v: string) {
    setProjectId(v);
    setVersionId("");
    setOffset(0);
  }

  // 当前项目下的 version 列表
  const versionOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: "", label: "全部版本" }];
    if (projectId) {
      const p = filters.projects.find((x) => x.id === projectId);
      for (const v of p?.versions ?? []) {
        opts.push({ value: v.id, label: `${v.name} (${v.count})` });
      }
    }
    return opts;
  }, [filters, projectId]);

  const projectOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [{ value: "", label: "全部项目" }];
    for (const p of filters.projects) {
      opts.push({ value: p.id, label: `${p.name} (${p.count})` });
    }
    return opts;
  }, [filters]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === assets.length) return new Set();
      return new Set(assets.map((a) => a.id));
    });
  }

  async function doDelete(ids: string[]) {
    if (ids.length === 0) return;
    try {
      const r = await fetch("/api/assets/delete-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { deleted: number; failed: Array<{ id: string }> };
      toast.success(`已删除 ${d.deleted} 项${d.failed.length ? `, ${d.failed.length} 项失败` : ""}`);
      // 重新拉当前页; 删完可能不够一页, 退回上一页
      const remaining = total - ids.length;
      const newOffset = remaining > 0 && assets.length - ids.length === 0 && offset > 0
        ? Math.max(0, offset - PAGE_LIMIT)
        : offset;
      if (newOffset !== offset) setOffset(newOffset);
      // 简化: 直接 re-fetch 触发 useEffect
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (type) params.set("type", type);
      if (source) params.set("source", source);
      if (projectId) params.set("project_id", projectId);
      if (versionId) params.set("version_id", versionId);
      params.set("sort", sort);
      params.set("limit", String(PAGE_LIMIT));
      params.set("offset", String(newOffset));
      setLoading(true);
      const rr = await fetch(`/api/assets?${params.toString()}`);
      if (rr.ok) {
        const dd = (await rr.json()) as { assets: AssetItem[]; total: number };
        setAssets(dd.assets);
        setTotal(dd.total);
      }
      setSelected(new Set());
    } catch (e) {
      toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_LIMIT, total);

  return (
    // 🆕 飞书 R139 第四批: /assets 右滚修复——根是 plain div, 无高度/overflow 控制, 加 h-full overflow-y-auto 兜底.
    <div className="h-full overflow-y-auto px-6 py-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-gray-900">资源池</h1>
        <div className="text-sm text-gray-500">
          {loading ? "加载中..." : `共 ${total} 项${total > 0 ? ` · 当前 ${start}-${end}` : ""}`}
        </div>
      </div>

      {/* 类型 tab (直接点击切换, 比下拉快) */}
      <div className="bg-white border border-gray-200 rounded-lg p-1 mb-3 inline-flex flex-wrap gap-1">
        {TYPE_OPTIONS.map((opt) => {
          const active = type === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => { setType(opt.value as TypeFilter); setOffset(0); }}
              className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                active
                  ? "bg-blue-600 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* 工具栏 */}
      <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <input
            type="text"
            placeholder="搜索文件名..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSearch();
            }}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
          <button
            onClick={commitSearch}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            搜索
          </button>
        </div>

        <div className="w-[160px]">
          <Select
            value={source}
            onChange={(v) => { setSource(v as SourceFilter); setOffset(0); }}
            options={SOURCE_OPTIONS}
            title="按来源筛选"
          />
        </div>

        <div className="w-[200px]">
          <Select
            value={projectId}
            onChange={onProjectChange}
            options={projectOptions}
            title="按项目筛选"
          />
        </div>

        <div className="w-[160px]">
          <Select
            value={versionId}
            onChange={(v) => { setVersionId(v); setOffset(0); }}
            options={versionOptions}
            disabled={!projectId}
            title="按版本筛选"
          />
        </div>

        <div className="w-[160px]">
          <Select
            value={sort}
            onChange={(v) => setSort(v)}
            options={SORT_OPTIONS}
            title="排序"
          />
        </div>

        <button
          onClick={() => setConfirmBatchOpen(true)}
          disabled={selected.size === 0}
          className={`px-4 py-2 text-sm rounded-lg transition-colors ${
            selected.size === 0
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-red-600 text-white hover:bg-red-700"
          }`}
        >
          批量删除{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>

      {/* 表格 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        {loading && assets.length === 0 ? (
          <div className="p-12 text-center text-gray-400">加载中...</div>
        ) : assets.length === 0 ? (
          <div className="p-12 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-lg m-3">
            暂无资产
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 w-8 text-left">
                  <input
                    type="checkbox"
                    checked={selected.size === assets.length && assets.length > 0}
                    onChange={toggleAll}
                    aria-label="全选当前页"
                  />
                </th>
                <th className="px-3 py-2 w-16 text-left">预览</th>
                <th className="px-3 py-2 text-left">文件名</th>
                <th className="px-3 py-2 w-20 text-left">类型</th>
                <th className="px-3 py-2 w-24 text-left">来源</th>
                <th className="px-3 py-2 w-24 text-right">大小</th>
                <th className="px-3 py-2 text-left">所属 Task</th>
                <th className="px-3 py-2 w-40 text-left">创建时间</th>
                <th className="px-3 py-2 w-20 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const isImage = a.media_type.startsWith("image/");
                return (
                  <tr key={a.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggleOne(a.id)}
                        aria-label={`选择 ${a.filename}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {isImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/attachments/${a.id}`}
                          alt={a.filename}
                          loading="lazy"
                          className="w-10 h-10 object-cover rounded border border-gray-200"
                        />
                      ) : (
                        <div className="w-10 h-10 flex items-center justify-center text-xl bg-gray-100 rounded border border-gray-200">
                          {fileIcon(a.media_type)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        href={`/api/attachments/${a.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate inline-block max-w-[260px]"
                        title={a.filename}
                      >
                        {a.filename}
                      </a>
                      <div className="text-xs text-gray-400 mt-0.5 truncate" title={a.media_type}>
                        {a.media_type}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700">
                        {typeLabel(a.media_type)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {(() => {
                        const badge = SOURCE_BADGE[a.source] ?? {
                          label: a.source || "未知",
                          cls: "bg-gray-100 text-gray-700",
                        };
                        return (
                          <span className={`inline-block px-2 py-0.5 rounded text-xs ${badge.cls}`}>
                            {badge.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 tabular-nums">
                      {formatSize(a.size_bytes)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/tasks/${a.task_id}`}
                        className="text-blue-600 hover:underline truncate inline-block max-w-[200px]"
                        title={a.task_title ?? a.task_id}
                      >
                        {a.task_title ?? a.task_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">
                      {formatDate(a.created_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setPendingDelete(a.id)}
                        className="text-red-600 hover:text-red-700 text-xs"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 分页 */}
      {total > PAGE_LIMIT && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <div className="text-gray-500">
            第 {start} - {end} 项 / 共 {total} 项
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
              disabled={offset === 0}
              className={`px-3 py-1.5 rounded border ${
                offset === 0
                  ? "border-gray-200 text-gray-300 cursor-not-allowed"
                  : "border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              上一页
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_LIMIT)}
              disabled={end >= total}
              className={`px-3 py-1.5 rounded border ${
                end >= total
                  ? "border-gray-200 text-gray-300 cursor-not-allowed"
                  : "border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* 单删确认 */}
      <ConfirmDialog
        open={!!pendingDelete}
        title="删除附件"
        message="确定要删除这个附件吗? 物理文件将被清理, 不可恢复."
        variant="danger"
        confirmLabel="删除"
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id) void doDelete([id]);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {/* 批量删确认 */}
      <ConfirmDialog
        open={confirmBatchOpen}
        title={`批量删除 ${selected.size} 个附件`}
        message="确定要批量删除选中的附件吗? 物理文件将被清理, 不可恢复."
        variant="danger"
        confirmLabel="全部删除"
        onConfirm={() => {
          const ids = Array.from(selected);
          setConfirmBatchOpen(false);
          void doDelete(ids);
        }}
        onCancel={() => setConfirmBatchOpen(false)}
      />
    </div>
  );
}