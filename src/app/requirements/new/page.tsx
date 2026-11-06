// 新建需求点页面 (in_app only, R60 P0 spec; R64 二轮改级联 client 表单).
// 关注点:
//   - 表单本体在 new-requirement-form.tsx (client) —— 项目/版本要级联,
//     server form 做不到「改项目即刷版本」, 故整表单下沉到 client + 走 POST /api/requirements.
//   - R107 R 列跟进: 接受 ?project_id= + ?version_id= 让"← 需求点列表"和"取消"按钮
//     携带原页面上下文, 用户从项目页面新建后能回到原页面 (而非全局入口).

import Link from "next/link";
import NewRequirementForm from "./new-requirement-form";

interface PageProps {
  searchParams?: Promise<{ project_id?: string; version_id?: string }>;
}

// 功能: 根据 query 上的 project_id + version_id 构造"回到列表页"的 href.
//   有 project_id → /requirements?project_id=X&version_id=Y (或仅 X)
//   无 → /requirements (全局入口)
function buildBackToListHref(projectId: string | undefined, versionId: string | undefined): string {
  if (!projectId) return "/requirements";
  const qs = new URLSearchParams();
  qs.set("project_id", projectId);
  if (versionId) qs.set("version_id", versionId);
  return `/requirements?${qs.toString()}`;
}

export default async function NewRequirementPage({ searchParams }: PageProps) {
  const params = (await searchParams) || {};
  const backHref = buildBackToListHref(params.project_id, params.version_id);

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-4">
        <Link href={backHref} className="text-sm text-blue-600 hover:underline">
          ← 需求点列表
        </Link>
      </div>

      <h1 className="text-2xl font-bold mb-6">新建需求点</h1>

      <NewRequirementForm
        presetProjectId={params.project_id}
        presetVersionId={params.version_id}
        backHref={backHref}
      />
    </div>
  );
}