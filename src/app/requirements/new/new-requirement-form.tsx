"use client";

// 功能: 新建需求点表单 (client). 项目 → 版本级联 select, 提交走 POST /api/requirements.
//   飞书 R71: 加多附件上传 (拖拽 / 点选 / 多选) — 创建需求点后逐文件
//   POST /api/requirements/[id]/attachments (两步法, 与 tasks/new 同口径).
// 关注点:
//   - 飞书 R64 二轮: 原 server form 改项目要刷新页面才能刷版本选项(级联做不了),
//     故整表单改 client. 提交仍走 API 路由(校验齐全: project 归属 / version 同 project).
//   - 项目集合与左侧导航必须一致: 同样拉 /api/projects?sort=manual + /api/user/me,
//     再按 owner_id === currentUserId 过滤(与 NavigationTree.ownedProjects 同一规则).
//     userId 拿不到时不过滤, 保持与导航一致的兜底行为.
//   - 版本 select 三态 sentinel: "" = 自动取项目当前版本(不传 version_id);
//     "__none__" = 显式不挂版本(传 null); 其他 = 指定 version id.
//   - 切换项目时必须重置 version 选择, 否则会把 A 项目的 version 提交到 B 项目
//     (API 会 400 VERSION_PROJECT_MISMATCH, 但用户体验上应提前避免).
//   - R71 多附件: 上传失败不阻断创建 (单文件失败走 console.warn + 跳过, 整批
//     失败也只是需求点建了但没附件); 列表展示支持删除单个 (点 ×). 大小/类型
//     白名单服务端 415/413 兜底, 前端不做预校验 (与服务端重复校验徒增代码).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Select from "@/components/Select";

type Project = {
  id: string;
  name: string;
  owner_id: string | null;
  current_version_id: string | null;
};

type Version = {
  id: string;
  project_id: string;
  name: string;
};

export default function NewRequirementForm({
  presetProjectId,
  presetVersionId,
  backHref,
}: {
  presetProjectId?: string;
  presetVersionId?: string;
  backHref?: string;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [projectId, setProjectId] = useState(presetProjectId || "");
  // R107 R 列跟进: presetVersionId 用于页面入口带了 ?version_id= 时自动选中.
  // 空字符串 = "自动取项目当前版本" 兜底 sentinel (与 onProjectChange 重置同语义).
  // null = 显式不挂版本 (__none__ sentinel 对应).
  const [versionId, setVersionId] = useState(presetVersionId || "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // R71: 多附件 (浏览器 File 对象数组, 提交时逐文件 POST).
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/projects?sort=manual").then((r) => r.json()),
      fetch("/api/versions").then((r) => r.json()),
      fetch("/api/user/me")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([pData, vData, meData]) => {
        setProjects(pData.projects || []);
        setVersions(vData.versions || []);
        if (meData?.id) setCurrentUserId(meData.id);
      })
      .finally(() => setLoading(false));
  }, []);

  // 与 NavigationTree.ownedProjects 同一规则: 只留自己名下的项目.
  const visibleProjects = useMemo(
    () => (currentUserId ? projects.filter((p) => p.owner_id === currentUserId) : projects),
    [projects, currentUserId]
  );

  const selectedProject = visibleProjects.find((p) => p.id === projectId) || null;
  const projectVersions = useMemo(
    () => versions.filter((v) => v.project_id === projectId),
    [versions, projectId]
  );

  function onProjectChange(next: string) {
    setProjectId(next);
    setVersionId(""); // 级联重置: 防止把上一个项目的 version 带过去
  }

  // R71: 多附件两步上传 — 先 POST /api/requirements 拿到 id, 再逐文件
  //   POST /api/requirements/[id]/attachments. 单文件失败不阻断整批 (warn 跳过),
  //   这样需求点本身能正常建, 漏掉的附件用户后续可在详情页补传.
  async function uploadAttachments(requirementId: string): Promise<void> {
    for (const file of pendingFiles) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/requirements/${requirementId}/attachments`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.warn(`[requirement] attachment upload failed for ${file.name}:`, data.error);
        }
      } catch (err) {
        console.warn(`[requirement] attachment upload error for ${file.name}:`, err);
      }
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!projectId || !title.trim()) {
      setError("项目和标题必填");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        project_id: projectId,
        title: title.trim(),
      };
      if (description.trim()) body.description = description.trim();
      if (priority) body.priority = parseInt(priority);
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (tagList.length) body.tags = tagList;
      // "" 不传 = DB 兜到项目当前版本; "__none__" 显式 null
      if (versionId === "__none__") body.version_id = null;
      else if (versionId) body.version_id = versionId;

      const res = await fetch("/api/requirements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `创建失败 (HTTP ${res.status})`);
        setSubmitting(false);
        return;
      }
      // 两步上传附件 (R71): 失败不阻断跳转, 只 console.warn.
      if (pendingFiles.length > 0) {
        await uploadAttachments(data.id);
      }
      // R107 R 列跟进: 详情页跳回带 project_id + version_id, 让详情页的"← 需求点列表"
      // 能返回原页面 (而非全局入口). versionId === "" 表示用户没选 (走项目 current),
      // 此场景不传 version_id 给详情页.
      const detailQs = new URLSearchParams();
      detailQs.set("project_id", projectId);
      if (versionId === "__none__") {
        // 显式不挂版本 = version_id=null sentinel. 详情页用同样 sentinel.
        detailQs.set("version_id", "null");
      } else if (versionId) {
        detailQs.set("version_id", versionId);
      }
      router.push(`/requirements/${data.id}?${detailQs.toString()}`);
    } catch (err: any) {
      setError(err?.message || "创建失败");
      setSubmitting(false);
    }
  }

  const currentVersionLabel = (v: Version) =>
    v.name + (v.id === selectedProject?.current_version_id ? "  · 当前" : "");

  return (
    <form onSubmit={onSubmit} className="space-y-4 bg-white rounded-lg shadow p-6">
      {error && <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">项目 *</label>
        <Select
          value={projectId}
          onChange={onProjectChange}
          disabled={loading}
          placeholder={loading ? "加载中…" : "-- 选择项目 --"}
          options={visibleProjects.map((p) => ({ value: p.id, label: p.name }))}
        />
        {!loading && visibleProjects.length === 0 && (
          <p className="mt-1 text-xs text-red-600">
            当前账号名下没有项目，先去{" "}
            <Link href="/" className="underline">
              首页
            </Link>{" "}
            创建一个。
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">版本 (可选)</label>
        <Select
          value={versionId}
          onChange={setVersionId}
          disabled={!projectId}
          placeholder={projectId ? "-- (自动 = 项目当前版本) --" : "先选项目"}
          options={[
            { value: "__none__", label: "(不挂版本)" },
            ...projectVersions.map((v) => ({ value: v.id, label: currentVersionLabel(v) })),
          ]}
        />
        <p className="mt-1 text-xs text-gray-500">
          默认 = 项目的「当前版本」. 允许跨版本迁移 (v1 → v2, 跟进迭代).
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">标题 *</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">优先级 (1-5)</label>
          <Select
            value={priority}
            onChange={setPriority}
            placeholder="--"
            options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `P${n}` }))}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">标签 (逗号分隔)</label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="ui, p1"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
          />
        </div>
      </div>

      {/* R71: 多附件上传 — 创建需求点时挂载 (创建后逐文件 POST 到详情页 API). */}
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
          拖拽文件到此处，或点击选择（创建需求点后自动上传，单文件 ≤10MB）
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
              <li
                key={i}
                className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1"
              >
                <span className="truncate">
                  {f.name} <span className="text-gray-400">({formatSize(f.size)})</span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  className="text-gray-400 hover:text-red-500 ml-2"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex gap-2 pt-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "创建中…" : "创建"}
        </button>
        <Link
          href={backHref ?? "/requirements"}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          取消
        </Link>
      </div>
    </form>
  );
}
