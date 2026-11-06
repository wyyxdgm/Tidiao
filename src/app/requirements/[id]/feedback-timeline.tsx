// 需求点详情页"最近反馈/疑问/建议"时间线 (R78 W3 §4.1 (2)).
//
// 功能: 把 requirement_revisions (字段级 diff) + 关联 task 的关键事件拼成一条
//   时间线, 最多展示 N 条 + "查看全部" 链接 (跳到 revisions API).
//
// 关注点:
//   - server component, 纯渲染 (无客户端交互).
//   - 输入 revisions + taskEvents, 已在 page.tsx 拼好并按 created_at DESC 排序.
//   - 不在组件内排序 (page.tsx 合并后排序一次, 避免再次 N×log(N)).
//   - "查看全部" 链到 GET /api/requirements/[id]/revisions (现有 API, 不新建).
//   - type 字段: revision 用 field (status/description/...); task event 用 kind
//     (started/completed/failed/...). 两类共享视觉规范 (点 + 时间 + 内容 + 来源 task).

import Link from "next/link";
import type { RequirementRevision } from "@/lib/db/requirement-revisions";

type ActorType = RequirementRevision["actor_type"];

const ACTOR_COLOR: Record<ActorType, string> = {
  agent: "bg-purple-100 text-purple-700",
  user: "bg-blue-100 text-blue-700",
  system: "bg-gray-100 text-gray-600",
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

// 任务事件来自 task_events 表 (status_change 那一类). 给详情页时间线提供
// "执行段"事件, 与 revision (字段级) 互补.
export interface TaskTimelineEvent {
  id: number | null;
  from_status: string | null;
  to_status: string;
  created_at: string;
  task_id: string;
  task_title: string;
}

export interface FeedbackTimelineEntry {
  created_at: string;
  kind: "revision" | "task_event";
  // revision: field/old/new/actor; task_event: from/to/task
  revision?: RequirementRevision;
  taskEvent?: TaskTimelineEvent;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RevisionLine({ rev }: { rev: RequirementRevision }) {
  const fieldLabel = FIELD_LABEL[rev.field] ?? rev.field;
  const oldVal = rev.old_value ?? "∅";
  const newVal = rev.new_value ?? "∅";
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full ${ACTOR_COLOR[rev.actor_type]}`}
        >
          {ACTOR_LABEL[rev.actor_type]}
        </span>
        <span className="font-medium text-gray-900">{fieldLabel}</span>
        <span className="text-xs text-gray-500 truncate" title={`${oldVal} → ${newVal}`}>
          {oldVal.length > 24 ? `${oldVal.slice(0, 24)}…` : oldVal}
          {" → "}
          {newVal.length > 24 ? `${newVal.slice(0, 24)}…` : newVal}
        </span>
      </div>
      <div className="text-xs text-gray-400 mt-0.5">
        {formatTime(rev.created_at)}
        {rev.task_id && (
          <Link
            href={`/tasks/${rev.task_id}`}
            className="ml-2 text-blue-600 hover:underline"
          >
            · 回溯 task
          </Link>
        )}
      </div>
    </div>
  );
}

const TASK_STATUS_DOT: Record<string, string> = {
  pending: "bg-gray-400",
  queued: "bg-blue-400",
  running: "bg-sky-400",
  paused: "bg-yellow-400",
  reviewing: "bg-purple-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  rejected: "bg-orange-400",
  cancelled: "bg-gray-300",
};

function TaskEventLine({ ev }: { ev: TaskTimelineEvent }) {
  const dot = TASK_STATUS_DOT[ev.to_status] || "bg-gray-400";
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        {ev.from_status ? (
          <span className="text-gray-700">
            {ev.from_status} → <span className="font-medium">{ev.to_status}</span>
          </span>
        ) : (
          <span className="text-gray-700">
            启动 · <span className="font-medium">{ev.to_status}</span>
          </span>
        )}
        <Link
          href={`/tasks/${ev.task_id}`}
          className="text-xs text-blue-600 hover:underline truncate"
          title={ev.task_title}
        >
          · {ev.task_title.length > 28 ? `${ev.task_title.slice(0, 28)}…` : ev.task_title}
        </Link>
      </div>
      <div className="text-xs text-gray-400 mt-0.5">{formatTime(ev.created_at)}</div>
    </div>
  );
}

export default function FeedbackTimeline({
  entries,
  revisionCount,
  taskEventCount,
  requirementId,
  taskIds,
  max = 10,
}: {
  entries: FeedbackTimelineEntry[];
  // R78 W3 缺陷 2 修复: 拆两个 count, 各走自己的 link (原 totalCount 混算
  // → "查看全部" link 只指 revisions API, task_events 漏, 信息不一致).
  revisionCount: number;
  taskEventCount: number;
  requirementId: string;
  taskIds: string[]; // 用于 task events API (task 列表 → 各自 timeline)
  max?: number;
}) {
  if (entries.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-gray-500">暂无反馈或执行记录</div>
    );
  }
  const visible = entries.slice(0, max);
  const showRevisionLink = revisionCount > max;
  const showTaskEventLink = taskEventCount > 0;
  return (
    <div>
      <ul className="divide-y">
        {visible.map((e, i) => (
          <li key={`${e.kind}-${i}`} className="p-4 flex items-start gap-3">
            {e.kind === "revision" && e.revision ? (
              <RevisionLine rev={e.revision} />
            ) : e.taskEvent ? (
              <TaskEventLine ev={e.taskEvent} />
            ) : null}
          </li>
        ))}
      </ul>
      {(showRevisionLink || showTaskEventLink) && (
        <div className="px-4 py-3 border-t flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {showRevisionLink && (
            <Link
              href={`/api/requirements/${requirementId}/revisions`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-600 hover:underline"
              title="查看所有字段级变更 (status / description / priority / tags / version)"
            >
              查看字段变更 ({revisionCount}) →
            </Link>
          )}
          {showTaskEventLink && (
            <span className="text-xs text-gray-600">
              执行记录 ({taskEventCount}) ·{" "}
              {taskIds.slice(0, 3).map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <Link
                    href={`/tasks/${id}`}
                    className="text-blue-600 hover:underline font-mono"
                    title={`跳转到 task ${id.slice(0, 8)} 详情页 (右侧时间线)`}
                  >
                    #{id.slice(0, 8)}
                  </Link>
                </span>
              ))}
              {taskIds.length > 3 && (
                <span className="text-gray-400"> 等 {taskIds.length} 个</span>
              )}
              <span className="text-gray-400"> · 看每个 task 右侧时间线</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
