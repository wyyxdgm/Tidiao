// 需求点列表渲染 (server component, R107 抽出).
//
// 三个入口共用:
//   - /requirements                                  (全局入口, 不带 project_id / version_id 上下文)
//   - /[projectId]/[versionId]/requirements          (默认带 version_id, 支持 ?clear=1 清空)
//   - /[projectId]/unversioned/requirements          (version_id=null 过滤未挂版本的需求)
//
// 关注点:
//   - 纯渲染: 接收已解析的 searchParams (object) + 可选 slot (顶部条), 不解析 Promise.
//   - 不做路由跳转: 由各 page.tsx 自行决定 searchParams 怎么来 (path 默认 / ?clear=1 / etc).
//   - 多租户: owner_id 隔离在 listRequirements 内部, 这里只透传 userId.
//   - 状态过滤 chip 走 buildFilterHref 保留 project_id / version_id (R87 跟进).

import Link from "next/link";
import type { ReactNode } from "react";
import {
  listRequirements,
  REQUIREMENT_STATUSES,
  parseRequirementTags,
  type RequirementStatus,
  getRequirementAggregates,
} from "@/lib/db/requirements";
import { getLatestRevisions, type ActorType } from "@/lib/db/requirement-revisions";
import { listProjects } from "@/lib/db/projects";
import { listVersions } from "@/lib/db/versions";

export interface RequirementsSearchParams {
  project_id?: string;
  status?: string;
  page?: string;
  version_id?: string;
}

interface RequirementsListViewProps {
  searchParams: RequirementsSearchParams;
  // 顶部条 slot: 项目面包屑 / "清空" / "重置" 按钮 (只在 [projectId]/[versionId]/requirements 渲染).
  // 全局入口 /requirements 不传, 自然不渲染顶部条.
  extraTopBar?: ReactNode;
  // R107 R 列跟进: 当前项目上下文. "+ 新建需求" / "暂无需求点. 新建一个" 链接
  // 都用此构造 URL, 让用户从项目页面新建/继续操作时不丢项目上下文.
  // 全局入口不传 → 链接不带 project_id / version_id.
  projectContext?: {
    projectId: string;
    // null = 该项目无版本 (unversioned 入口); 字符串 = 具体 version id.
    versionId: string | null;
  };
  // 调用方传 server-resolved userId (page.tsx 已经 await getServerUserId()).
  // 关注点: View 改成 sync server component, 因为 React 19 / Next 16.2.11
  //   在父 async server component 中渲染 async server component 时, TS 类型
  //   推断会报 "Promise<Element> is not a valid JSX element" (page.tsx 父→子).
  //   把唯一的 await (getServerUserId) 提到父层, View 内部全 sync DB 函数即可.
  userId: string;
}

// 功能: 根据 projectContext 构造 "/requirements/new" 的 href, 携带 project_id + version_id.
// 关注点:
//   - 有 context → /requirements/new?project_id=X&version_id=Y
//   - 无 context → /requirements/new (兜底, 全局入口行为)
//   - versionId=null → 显式传 null (强制不挂版本); 不传 = DB 兜到项目当前版本
//     (R64 既有语义, 表单 presetVersionId="__none__" sentinel 区分).
function buildNewRequirementHref(ctx: RequirementsListViewProps["projectContext"]): string {
  if (!ctx) return "/requirements/new";
  const qs = new URLSearchParams();
  qs.set("project_id", ctx.projectId);
  if (ctx.versionId) qs.set("version_id", ctx.versionId);
  // 注意: versionId === null 时不传 qs 参数, 让表单走 "__none__" sentinel
  // (api/requirements route 支持传 null 强制不挂版本). 后续如需传显式 null
  // 哨兵再加, 现在保持 URL 干净.
  return `/requirements/new?${qs.toString()}`;
}

const STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: "未开始",
  done: "已完成",
  awaiting_reply: "等回复",
  has_suggestion: "有建议",
  blocked: "需拍板",
  closed: "已关闭",
};

const STATUS_COLOR: Record<RequirementStatus, string> = {
  pending: "bg-gray-100 text-gray-700",
  done: "bg-green-100 text-green-700",
  awaiting_reply: "bg-blue-100 text-blue-700",
  has_suggestion: "bg-purple-100 text-purple-700",
  blocked: "bg-orange-100 text-orange-700",
  closed: "bg-gray-200 text-gray-500",
};

// R63 时间胶囊: actor 视觉区分 (AI 改的紫色 / 人改的蓝色 / 系统灰色).
const ACTOR_COLOR: Record<ActorType, string> = {
  agent: "bg-purple-50 text-purple-700 border-purple-200",
  user: "bg-blue-50 text-blue-700 border-blue-200",
  system: "bg-gray-50 text-gray-600 border-gray-200",
};
const ACTOR_LABEL: Record<ActorType, string> = {
  agent: "AI",
  user: "人",
  system: "系统",
};
const FIELD_LABEL: Record<string, string> = {
  title: "标题",
  description: "描述",
  status: "状态",
  priority: "优先级",
  tags: "标签",
  version_id: "版本",
};

function RevisionBadge({
  field,
  actorType,
  createdAt,
}: {
  field: string;
  actorType: ActorType;
  createdAt: string;
}) {
  return (
    <span
      title={`${ACTOR_LABEL[actorType]}改 ${FIELD_LABEL[field] ?? field} · ${new Date(createdAt).toLocaleString("zh-CN")}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${ACTOR_COLOR[actorType]}`}
    >
      <span>{ACTOR_LABEL[actorType]}</span>
      <span className="opacity-60">·</span>
      <span>{FIELD_LABEL[field] ?? field}</span>
    </span>
  );
}

export default function RequirementsListView({
  searchParams,
  extraTopBar,
  projectContext,
  userId,
}: RequirementsListViewProps) {
  let status: RequirementStatus | RequirementStatus[] | undefined;
  if (searchParams.status) {
    const arr = searchParams.status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    status = arr.length === 1
      ? (arr[0] as RequirementStatus)
      : (arr as RequirementStatus[]);
  }

  // R64: ?version_id=xxx 过滤某 version; ?version_id=null 过滤无 version; 不传 = 不过滤.
  const versionIdFilter: string | null | undefined =
    searchParams.version_id === undefined
      ? undefined
      : searchParams.version_id === "null"
        ? null
        : searchParams.version_id;

  const out = listRequirements(
    {
      project_id: searchParams.project_id,
      status,
      version_id: versionIdFilter,
      page: 1,
      page_size: 50,
    },
    userId,
  );

  // 预取所有可见 project 一次 (R64 反馈: 列表项无 project 标识 → 像"未分类").
  const projects = listProjects(userId);
  const projectNameById = new Map<string, string>();
  for (const p of projects) projectNameById.set(p.id, p.name);

  // R64: 预取所有可见 version.
  const versions = listVersions(undefined, userId);
  const versionNameById = new Map<string, string>();
  for (const v of versions) versionNameById.set(v.id, v.name);

  // R63 时间胶囊: 批量取列表项的最近一次变更.
  const latestRevisions = getLatestRevisions(out.items.map((r) => r.id));

  // R78 W3 §4.4 / R74 Q1: 量化基础 3 列.
  const aggregates = getRequirementAggregates(out.items.map((r) => r.id));

  // R87 跟进: status 过滤 chip 必须保留 project_id / version_id, 避免切 status
  // 时把"当前项目"的上下文丢了变成全局视图. page 参数故意不传 — 切 status
  // 视为新查询, 回到第 1 页是预期行为.
  function buildFilterHref(extras: { status?: RequirementStatus }): string {
    const sp = new URLSearchParams();
    if (searchParams.project_id) sp.set("project_id", searchParams.project_id);
    if (searchParams.version_id) sp.set("version_id", searchParams.version_id);
    if (extras.status) sp.set("status", extras.status);
    const qs = sp.toString();
    return qs ? `/requirements?${qs}` : "/requirements";
  }

  function formatFeedbackTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "刚刚";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
    if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}天前`;
    return d.toLocaleDateString("zh-CN");
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">需求点</h1>
        <Link
          href={buildNewRequirementHref(projectContext)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
        >
          + 新建需求
        </Link>
      </div>

      {/* R107: 项目/版本下入口的顶部条 (面包屑 + 清空 / 重置). 仅版本页传 extraTopBar,
          全局入口自然不渲染. */}
      {extraTopBar}

      {/* status 过滤 (R87 跟进) */}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Link
          href={buildFilterHref({})}
          className={`px-3 py-1 rounded-full border ${
            !searchParams.status
              ? "bg-blue-600 text-white border-blue-600"
              : "border-gray-300 text-gray-700 hover:bg-gray-50"
          }`}
        >
          全部
        </Link>
        {REQUIREMENT_STATUSES.map((s) => (
          <Link
            key={s}
            href={buildFilterHref({ status: s })}
            className={`px-3 py-1 rounded-full border ${
              searchParams.status === s
                ? "bg-blue-600 text-white border-blue-600"
                : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {STATUS_LABEL[s]}
          </Link>
        ))}
      </div>

      {out.items.length === 0 ? (
        // R107 R 列第五轮: 顶部"+ 新建需求"按钮已是唯一入口, 空态不再重复一个 inline
        // 链接. damo 反馈"暂无需求点. 新建一个 这个入口还不对" = 这个 inline 链接冗余
        // (顶部按钮已覆盖). 改为纯文本 + 提示用户用顶部按钮, 减少视觉重复.
        <div className="text-center py-12 text-gray-500">
          <div className="mb-2">暂无需求点</div>
          <div className="text-xs text-gray-400">
            点击右上角「+ 新建需求」添加
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow divide-y">
          {out.items.map((r) => {
            const projectName = projectNameById.get(r.project_id) ?? "未分类";
            const versionName = r.version_id
              ? (versionNameById.get(r.version_id) ?? "未挂版本")
              : "未挂版本";
            const tags = parseRequirementTags(r.tags);
            const latest = latestRevisions.get(r.id);
            const agg = aggregates.get(r.id);
            return (
              <Link
                key={r.id}
                href={`/requirements/${r.id}`}
                className="block p-4 hover:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900">{r.title}</div>
                    {r.description && (
                      <div className="text-sm text-gray-500 mt-1 line-clamp-2">
                        {r.description}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-gray-400">
                      <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        {projectName}
                      </span>
                      {r.version_id ? (
                        <span className="px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                          v·{versionName}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700">
                          未挂版本
                        </span>
                      )}
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600"
                        >
                          #{t}
                        </span>
                      ))}
                      <span>
                        {new Date(r.created_at).toLocaleString("zh-CN")}
                      </span>
                      {r.priority !== null && <span>· P{r.priority}</span>}
                      {latest && (
                        <RevisionBadge
                          field={latest.field}
                          actorType={latest.actor_type}
                          createdAt={latest.created_at}
                        />
                      )}
                    </div>
                    {agg && (
                      <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-500">
                        <span
                          title="关联任务数"
                          className="inline-flex items-center gap-1"
                        >
                          <span aria-hidden>📋</span>
                          <span>{agg.task_count}</span>
                          <span className="text-gray-400">tasks</span>
                        </span>
                        <span
                          title={`完成 ${agg.completed_count} / ${agg.task_count}`}
                          className="inline-flex items-center gap-1"
                        >
                          <span aria-hidden>📈</span>
                          <span>
                            {agg.task_count > 0
                              ? `${Math.round(agg.completion_ratio * 100)}%`
                              : "—"}
                          </span>
                          <span className="text-gray-400">完成</span>
                        </span>
                        <span
                          title={`最近反馈时间 (status / description 字段变更): ${agg.latest_feedback_at ?? "无"}`}
                          className="inline-flex items-center gap-1"
                        >
                          <span aria-hidden>💬</span>
                          <span>{formatFeedbackTime(agg.latest_feedback_at)}</span>
                          <span className="text-gray-400">反馈</span>
                        </span>
                      </div>
                    )}
                  </div>
                  <span
                    className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${STATUS_COLOR[r.status]}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-xs text-gray-500 text-center">
        共 {out.total} 条 · 当前页 {out.page} · 每页 {out.page_size}
      </div>
    </div>
  );
}