// 项目+版本下需求列表 (R107 抽出, 默认带版本过滤).
//
// 功能: 项目某个版本下的需求点列表. 默认 filter = project_id + version_id (path 参数).
//   - ?clear=1 → 清空 version 过滤, 仅按 project_id 看全量.
//   - ?status=xxx → 状态过滤 (走 View 内 buildFilterHref 保留 project_id / version_id).
//   - 不传任何 query = 默认带当前 version 的全量需求.
// 关注点:
//   - View 内 buildFilterHref 默认写到 /requirements?... 这里需要把 "全部" / "状态过滤" chip
//     链回当前页 (保留 path 上下文), 不能直接用 buildFilterHref. 在本页自己构造 buildLocalHref.
//   - page.tsx 必须是 server component (DB 直连).

import Link from "next/link";
import RequirementsListView, {
  type RequirementsSearchParams,
} from "@/components/RequirementsListView";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { getServerRole, getServerUserId } from "@/lib/server-auth";

interface PageProps {
  params: Promise<{ projectId: string; versionId: string }>;
  searchParams?: Promise<{ clear?: string; status?: string }>;
}

export default async function VersionRequirementsPage({
  params,
  searchParams,
}: PageProps) {
  const { projectId, versionId } = await params;
  const sp = (await searchParams) || {};
  const userId = await getServerUserId();
  // Admin sees every project/version (matches /api/projects list semantics);
  // non-admin is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;

  // 拉项目名 / 版本名做面包屑. 跨 owner / 不存在 → null, 不挡渲染, 仅降级显示 id.
  const project = getProjectById(projectId, ownerId);
  const version = getVersionById(versionId, ownerId);
  const projectName = project?.name ?? projectId;
  const versionName = version?.name ?? versionId;

  // ?clear=1 → 不传 version_id 给 View → 不过滤 (等价看该 project 全量需求).
  // status 仍保留, 让用户清空后还能按状态切片.
  const viewParams: RequirementsSearchParams = {
    project_id: projectId,
    ...(sp.clear !== "1" ? { version_id: versionId } : {}),
    ...(sp.status ? { status: sp.status } : {}),
  };

  // 本页 chip "全部" / "状态过滤" 必须保留 path 上下文, 不能直接走 View 的 buildFilterHref
  // (那个默认写到 /requirements?... 把 path 丢了). 自己写一个 local 版.
  const pathBase = `/${projectId}/${versionId}/requirements`;
  function buildLocalHref(opts: { clear?: boolean; status?: string | null }): string {
    const qs = new URLSearchParams();
    const useClear = opts.clear ?? sp.clear === "1";
    if (!useClear) qs.set("version_id", versionId);
    if (opts.status !== undefined) {
      if (opts.status !== null) qs.set("status", opts.status);
    } else if (sp.status) {
      qs.set("status", sp.status);
    }
    const q = qs.toString();
    return q ? `${pathBase}?${q}` : pathBase;
  }

  const isCleared = sp.clear === "1";

  const topBar = (
    <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 text-gray-700 min-w-0">
        <Link
          href={`/${projectId}/${versionId}`}
          className="text-blue-700 hover:underline truncate max-w-[180px]"
          title={projectName}
        >
          {projectName}
        </Link>
        <span className="text-gray-400">/</span>
        <span className="text-gray-900 font-medium truncate max-w-[180px]" title={versionName}>
          {versionName}
        </span>
        <span className="text-gray-400 text-xs">
          · 当前视图 = {isCleared ? "项目全量" : "当前版本"}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {!isCleared ? (
          <Link
            href={buildLocalHref({ clear: true })}
            className="px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-white text-xs"
            title="清空 version 过滤, 看该 project 全量需求"
          >
            清空版本
          </Link>
        ) : (
          <Link
            href={buildLocalHref({ clear: false })}
            className="px-2.5 py-1 rounded border border-blue-300 bg-white text-blue-700 hover:bg-blue-50 text-xs"
            title="回到默认: 只看当前版本"
          >
            恢复版本
          </Link>
        )}
        <Link
          href={pathBase}
          className="px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-white text-xs"
          title="重置 = 清掉所有 query, 回到默认带当前版本的状态"
        >
          重置
        </Link>
        <Link
          href="/requirements"
          className="px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-white text-xs"
          title="总入口: 全局需求列表, 不带项目绑定"
        >
          总入口
        </Link>
      </div>
    </div>
  );

  return (
    <RequirementsListView
      searchParams={viewParams}
      extraTopBar={topBar}
      projectContext={{ projectId, versionId }}
      userId={userId}
    />
  );
}