// 单需求详情页 (in_app only, R60 P0 新 spec).
//
// 功能: 显示 requirement 详情 + 关联 task 列表 (含森林依赖图) + 附件列表 (R71).
// 关注点:
//   - GET 返回 requirement + tasks (内联森林 API), 客户端不二次请求.
//   - 软删 (status='closed') 仍可查, 但前端标灰.
//   - R71 附件: 直接 DB 层 listAttachmentsByRequirementId 拿, 渲染下载链接 +
//     大小. 删除走客户端 (useTransition / form action) — 这里走 server action
//     保持页面 server-only; 实际删除接口是 DELETE /api/attachments/[id] (通用,
//     不区分 task / requirement).
//   - R78 W3 §4.1: 在头部加状态进程条; 在「关联任务」上方加"最近反馈/疑问/建议"
//     时间线 (revisions + 关联 task 的 status_change events 合并); 森林列表
//     标 root / sub-task 区分.

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getRequirementById,
  getRequirementTasks,
  hasCompletedImplementationTask,
  parseRequirementTags,
} from "@/lib/db/requirements";
import { getProjectById } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { getServerUserId } from "@/lib/server-auth";
import { listRevisions, type ActorType, type RequirementRevision } from "@/lib/db/requirement-revisions";
import { listAttachmentsByRequirementId } from "@/lib/db/attachments";
import { getDb } from "@/lib/db";
import RequirementAttachmentDeleteButton from "./requirement-attachment-delete-button";
import CreateTaskButton from "./create-task-button";
import StatusFlow from "./status-flow";
import StatusStepper from "./status-stepper";
import FeedbackTimeline, { type FeedbackTimelineEntry, type TaskTimelineEvent } from "./feedback-timeline";
import TaskByChip from "@/components/TaskByChip";
import TaskStatusChip from "@/components/TaskStatusChip";

interface PageProps {
  params: Promise<{ id: string }>;
  // R107 R 列跟进: 接受 ?project_id= + ?version_id= 让"← 需求点列表"返回按钮
  // 能回到原项目页面 (而非全局入口). version_id="null" 表示不挂版本 (跨版本演进).
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

// R63 时间线渲染.
const ACTOR_COLOR: Record<ActorType, string> = {
  agent: "bg-purple-100 text-purple-700",
  user: "bg-blue-100 text-blue-700",
  system: "bg-gray-100 text-gray-600",
};
const ACTOR_LABEL: Record<ActorType, string> = {
  agent: "AI 改动",
  user: "手动改动",
  system: "系统改动",
};
const FIELD_LABEL: Record<string, string> = {
  title: "标题",
  description: "描述",
  status: "状态",
  priority: "优先级",
  tags: "标签",
  version_id: "版本",
};

function diffPreview(oldVal: string | null, newVal: string | null): string {
  const o = oldVal === null ? "∅" : oldVal;
  const n = newVal === null ? "∅" : newVal;
  return `${o} → ${n}`;
}

function RevisionTimeline({ revisions }: { revisions: RequirementRevision[] }) {
  if (revisions.length === 0) {
    return <div className="p-6 text-center text-sm text-gray-500">暂无变更记录</div>;
  }
  return (
    <ul className="divide-y">
      {revisions.map((rev) => (
        <li key={rev.id} className="p-4 flex items-start gap-3">
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${ACTOR_COLOR[rev.actor_type]}`}
          >
            {ACTOR_LABEL[rev.actor_type]}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-900">
              <span className="font-medium">{FIELD_LABEL[rev.field] ?? rev.field}</span>
              <span className="ml-2 text-gray-600 text-xs">{diffPreview(rev.old_value, rev.new_value)}</span>
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {new Date(rev.created_at).toLocaleString("zh-CN")}
              {rev.actor_id && rev.actor_id !== "system" && <span> · {rev.actor_id}</span>}
              {rev.task_id && (
                <Link href={`/tasks/${rev.task_id}`} className="ml-1 text-blue-600 hover:underline">
                  · 回溯 task
                </Link>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function RequirementDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const userId = await getServerUserId();
  const req = getRequirementById(id, userId);
  if (!req) notFound();

  // R107 R 列跟进: 从 query 读 project_id + version_id, 构造"← 需求点列表"回链.
  // 优先用 query 里的 (新流程从项目页面进来); 兜底用 req 自带的 (老直链访问).
  const ctxProjectId = sp.project_id ?? req.project_id;
  const ctxVersionId = sp.version_id ?? req.version_id ?? undefined;
  const backHref = buildBackToListHref(ctxProjectId, ctxVersionId);

  // R64 反馈: 详情页无 project 标识 → 像"未分类". 单独查一次 (detail 路径, 无 N+1).
  const project = getProjectById(req.project_id, userId);
  const projectName = project?.name ?? "未分类";
  // R64: 详情页加 version 标识 (绿底徽章, 与 project 灰底区分).
  const version = req.version_id ? getVersionById(req.version_id, userId) : null;
  const versionName = version?.name ?? "未挂版本";
  const tags = parseRequirementTags(req.tags);

  const tasksResult = getRequirementTasks(id);

  // R78 W1 §4.3 (c) UI 前置查询: 「标记完成」按钮 disabled 判据.
  const eligibleForDone = hasCompletedImplementationTask(id, userId);

  // R63 时间线: 详情页完整时间线 (列表页只取最近一次, 这里取全部).
  const revisions = listRevisions(id);

  // R78 W3 §4.1 (3): root task 识别 -- 森林里 created 最早且无 dispatched_by 的 = root.
  // tasksResult 已按 created_at ASC 排序; 第一个 dispatched_by_task_id IS NULL 的就是 root.
  // (forest 可能存在多个"无 dispatched_by"的并行 root, 这里只高亮最早的那个.)
  const rootTaskId =
    tasksResult.tasks.find((t) => t.dispatched_by_task_id == null)?.id ?? null;

  // R78 W3 §4.1 (2): 反馈 timeline = revisions + 关联 task 的 status_change events
  // 合并, 按 created_at DESC 排, 最多展示 10 条. events 直接读 DB (server component,
  // 走 raw SQL 一次拿齐所有 task 的 status_change 事件, 避免 N+1).
  const taskIds = tasksResult.tasks.map((t) => t.id);
  // taskIds 复用于下方 FeedbackTimeline 渲染 (缺陷 2 修复).
  const taskEvents: TaskTimelineEvent[] = [];
  if (taskIds.length > 0) {
    const db = getDb();
    const placeholders = taskIds.map(() => "?").join(",");
    const evRows = db
      .prepare(
        `SELECT id, task_id, data, created_at FROM events
         WHERE task_id IN (${placeholders}) AND type = 'status_change'
         ORDER BY created_at DESC LIMIT 100`
      )
      .all(...taskIds) as Array<{
      id: number;
      task_id: string;
      data: string;
      created_at: string;
    }>;
    const taskTitleById = new Map(tasksResult.tasks.map((t) => [t.id, t.title]));
    for (const r of evRows) {
      let parsed: { from?: string; to?: string } = {};
      try {
        parsed = JSON.parse(r.data);
      } catch {
        continue;
      }
      taskEvents.push({
        id: r.id,
        from_status: parsed.from ?? null,
        to_status: parsed.to ?? "unknown",
        created_at: r.created_at,
        task_id: r.task_id,
        task_title: taskTitleById.get(r.task_id) ?? "(已删除)",
      });
    }
  }
  const timelineEntries: FeedbackTimelineEntry[] = [
    ...revisions.map((r) => ({
      created_at: r.created_at,
      kind: "revision" as const,
      revision: r,
    })),
    ...taskEvents.map((e) => ({
      created_at: e.created_at,
      kind: "task_event" as const,
      taskEvent: e,
    })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  // R78 W3 缺陷 2 修复: 拆分 count, 各走自己的 link. revisionCount 控制
  // "查看字段变更" link (只展示超 max 的部分); taskEventCount 总是展示
  // (task 数量上限 5 已经够细, 但还想给 damo 一眼看到总执行事件数).
  const revisionCount = revisions.length;
  const taskEventCount = taskEvents.length;
  // taskIds 已在上面声明 (line ~130, 用于 SQL batch events 查询), 复用给 FeedbackTimeline.

  // R71 附件: 直接 DB 层拿 (server component). 渲染下载链接 + 大小 + 媒体类型.
  const attachments = listAttachmentsByRequirementId(id, userId);
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-4">
        <Link href={backHref} className="text-sm text-blue-600 hover:underline">
          ← 需求点列表
        </Link>
      </div>

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h1 className="text-2xl font-bold flex-1">{req.title}</h1>
          {/* R60 §3.1: 状态 badge 改为 dropdown — 点开切 6 态, closed 二次确认 */}
          <StatusFlow
            requirementId={req.id}
            initialStatus={req.status}
            eligibleForDone={eligibleForDone}
          />
        </div>
        {req.description && (
          <div className="text-gray-700 whitespace-pre-wrap mb-4">{req.description}</div>
        )}
        <div className="flex flex-wrap gap-3 text-xs text-gray-500">
          <Link
            href={`/requirements?project_id=${req.project_id}`}
            className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            {projectName}
          </Link>
          {/* R64: 版本徽章 (绿底 = 已挂版本, 黄底 = 未挂). 详情页版本可点跳过滤视图. */}
          {req.version_id ? (
            <Link
              href={`/requirements?version_id=${req.version_id}`}
              className="px-1.5 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100"
            >
              v·{versionName}
            </Link>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700">
              未挂版本
            </span>
          )}
          {tags.map((t) => (
            <span key={t} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
              #{t}
            </span>
          ))}
          {req.priority !== null && <span>优先级 P{req.priority}</span>}
          <span>· 创建于 {new Date(req.created_at).toLocaleString("zh-CN")}</span>
          <span>· 更新于 {new Date(req.updated_at).toLocaleString("zh-CN")}</span>
        </div>
      </div>

      {/* R78 W3 §4.1 (1): 状态进程条 (pending → done 主轴, closed 走分支, 中间态蓝/紫/橙). */}
      <StatusStepper current={req.status} />

      {/* R78 W3 §4.1 (2): 最近反馈/疑问/建议 timeline = revisions + 关联 task 状态变更. */}
      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-4 border-b">
          <h2 className="font-semibold">
            最近反馈与执行 ({revisionCount} 字段 + {taskEventCount} 执行事件)
          </h2>
        </div>
        <FeedbackTimeline
          entries={timelineEntries}
          revisionCount={revisionCount}
          taskEventCount={taskEventCount}
          requirementId={req.id}
          taskIds={taskIds}
        />
      </div>

      {/* R71 附件列表 — 详情页可见, 点文件名走 GET /api/attachments/[id] 下载/预览. */}
      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-4 border-b">
          <h2 className="font-semibold">附件 ({attachments.length})</h2>
        </div>
        {attachments.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">暂无附件</div>
        ) : (
          <ul className="divide-y">
            {attachments.map((a) => (
              <li key={a.id} className="p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <a
                    href={`/api/attachments/${a.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline truncate block"
                  >
                    {a.filename}
                  </a>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {a.media_type} · {formatSize(a.size_bytes)}
                  </div>
                </div>
                <RequirementAttachmentDeleteButton attachmentId={a.id} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* R63 字段级变更时间线 (保留, 作为详细字段 diff 视图; 上方 timeline 是合并版概览). */}
      <div className="bg-white rounded-lg shadow mb-6">
        <div className="p-4 border-b">
          <h2 className="font-semibold">字段变更明细 ({revisions.length})</h2>
        </div>
        <RevisionTimeline revisions={revisions} />
      </div>

      {/* 关联 task 列表 (森林 API) */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold">关联任务 ({tasksResult.tasks.length})</h2>
          {/* R60 §3.1: 详情页「+ 新建任务」入口 — 弹窗带 requirement_id + project_id + version_id 继承 */}
          <CreateTaskButton
            requirementId={req.id}
            projectId={req.project_id}
            versionId={req.version_id}
          />
        </div>
        {tasksResult.tasks.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            暂无关联任务
          </div>
        ) : (
          <div className="divide-y">
            {tasksResult.tasks.map((t) => {
              const isRoot = t.id === rootTaskId;
              return (
                <div key={t.id} className="p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isRoot ? (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold"
                        title="root task = 创建最早且无 dispatched_by 的 task"
                      >
                        root
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                        sub-task
                      </span>
                    )}
                    <Link
                      href={`/tasks/${t.id}`}
                      className="font-medium text-gray-900 hover:text-blue-600"
                    >
                      {t.title}
                    </Link>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                    <span>状态: {t.status}</span>
                    {t.depends_on.length > 0 && (
                      <span>· 依赖 {t.depends_on.length} 个上游 task</span>
                    )}
                    {t.dispatched_by_task_id && (
                      <TaskByChip dispatchedByTaskId={t.dispatched_by_task_id} />
                    )}
                    {/* R109: sub-status chip — 与 board-client / kanban-view / global-board 同源. */}
                    {t.latest_checkpoint_status && (
                      <TaskStatusChip status={t.latest_checkpoint_status} />
                    )}
                    {/* R112 续 (v129): reviewing 子终态标签 — 需求详情页 getRequirementTasks
                        暂未带回 awaiting_reason 字段 (后续可扩 requirements.ts), 此处先
                        不挂 chip. board-client / kanban-view / global-board 已覆盖 3 视图. */}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
