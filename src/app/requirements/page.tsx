// 全局需求点入口 (R60 P0, R107 抽出 View 后变成薄壳).
//
// 功能: 全局需求点列表, 不带任何 project_id / version_id 默认上下文.
// 关注点:
//   - 与 /[projectId]/[versionId]/requirements / /[projectId]/unversioned/requirements 共用 RequirementsListView.
//     本页 = 纯无 project_id 兜底, 让用户从总入口看全局需求 (R107 第二段 "保留").
//   - 不传 extraTopBar → 顶部条 (面包屑 + 清空/重置) 不渲染, 只在项目/版本入口出现.
//   - searchParams 透传给 View, 解析逻辑 (status / version_id / page) 全部在 View 内.

import RequirementsListView, {
  type RequirementsSearchParams,
} from "@/components/RequirementsListView";
import { getServerUserId } from "@/lib/server-auth";

interface PageProps {
  searchParams?: Promise<RequirementsSearchParams>;
}

export default async function RequirementsListPage({
  searchParams,
}: PageProps) {
  const params = (await searchParams) || {};
  const userId = await getServerUserId();
  return <RequirementsListView searchParams={params} userId={userId} />;
}