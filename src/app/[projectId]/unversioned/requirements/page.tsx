// 项目未发布版本下需求列表 (R107 抽出, version_id=null 过滤未挂版本需求).
//
// 功能: 未发布版本项目下, 看所有 version_id=NULL 的需求 (跨版本演进 / 历史遗留).
//   - 不支持 ?clear=1 (本页语义本身 = 强制 null 过滤, 清空没有意义).
// 关注点:
//   - View 内 buildFilterHref 默认写到 /requirements?... 这里需要把 chip 链回当前页.
//   - page.tsx 必须是 server component (DB 直连).

import Link from "next/link";
import RequirementsListView, {
  type RequirementsSearchParams,
} from "@/components/RequirementsListView";
import { getProjectById } from "@/lib/db/projects";
import { getServerRole, getServerUserId } from "@/lib/server-auth";

interface PageProps {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ status?: string }>;
}

export default async function UnversionedRequirementsPage({
  params,
  searchParams,
}: PageProps) {
  const { projectId } = await params;
  const sp = (await searchParams) || {};
  const userId = await getServerUserId();
  // Admin sees every project (matches /api/projects list semantics); non-admin
  // is scoped to its own owner_id.
  const ownerId = (await getServerRole()) === "admin" ? undefined : userId;

  const project = getProjectById(projectId, ownerId);
  const projectName = project?.name ?? projectId;

  // 强制 version_id=null, 看未挂版本的需求 (跨版本演进 / 历史遗留).
  const viewParams: RequirementsSearchParams = {
    project_id: projectId,
    version_id: "null",
    ...(sp.status ? { status: sp.status } : {}),
  };

  const pathBase = `/${projectId}/unversioned/requirements`;
  function buildLocalHref(opts: { status?: string | null }): string {
    const qs = new URLSearchParams();
    if (opts.status !== undefined) {
      if (opts.status !== null) qs.set("status", opts.status);
    } else if (sp.status) {
      qs.set("status", sp.status);
    }
    const q = qs.toString();
    return q ? `${pathBase}?${q}` : pathBase;
  }

  const topBar = (
    <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 text-gray-700 min-w-0">
        <Link
          href={`/${projectId}/unversioned`}
          className="text-yellow-700 hover:underline truncate max-w-[180px]"
          title={projectName}
        >
          {projectName}
        </Link>
        <span className="text-gray-400">/</span>
        <span className="text-gray-900 font-medium">未发布版本</span>
        <span className="text-gray-400 text-xs">· 当前视图 = 未挂版本</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Link
          href={pathBase}
          className="px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-white text-xs"
          title="重置 = 清掉所有 query, 回到默认未挂版本过滤"
        >
          重置
        </Link>
        <Link
          href="/requirements"
          className="px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-white text-xs"
          title="总入口: 全局需求列表"
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
      projectContext={{ projectId, versionId: null }}
      userId={userId}
    />
  );
}