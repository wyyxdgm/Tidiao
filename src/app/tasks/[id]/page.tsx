// Task detail page - /tasks/[id]

import { notFound, redirect } from "next/navigation";
import TaskDetailClient from "./task-detail-client";
import TaskHeader from "./task-header";
import { getDependencyTaskIds, getDependentTaskIds, getTaskById, getTasksByShortId, getParentTask, getDispatchedTasks, getTaskTimeoutOverrideMinutes } from "@/lib/db/tasks";
import { isFavoriteByUser } from "@/lib/db/user-favorites";
import { getProjectById, listProjects } from "@/lib/db/projects";
import { getVersionById } from "@/lib/db/versions";
import { getServerUserId } from "@/lib/server-auth";
import { getGlobalTaskTimeoutMinutes, parseTimeoutMinutes } from "@/lib/db/settings";
import { getRequirementById, getRequirementTasks } from "@/lib/db/requirements";

type Task = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  priority: number;
  session_id: string | null;
  parent_session_id: string | null;
  forked_from_session_id: string | null;
  cwd: string | null;
  model: string | null;
  resolved_model: string | null;
  allowed_tools: string | null;
  max_turns: number | null;
  effort: string | null;
  result: string | null;
  cost_usd: number | null;
  context_tokens: number | null;
  context_max: number | null;
  error: string | null;
  preflight_result: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  tags: string | null;
  depends_on: string | null;
  project_id: string | null;
  type: string | null;
  version_id: string | null;
  metadata: string | null;
  auto_approve: number;
  dispatched_by_task_id: string | null;
  requirement_id: string | null; // R78 W3 §4.2: task ↔ requirement 关联 (v64 FK)
  awaiting_owner_review: number; // v56: 等拍板标记 (兼容旧数据 / v56 marker 翻译)
  awaiting_markers: string | null; // v61+R39: JSON 数组 (来自 <awaiting type="..."/> 多 marker)
  base_commit: string | null; // R113: git HEAD when task started (Commits Chain 面板 base→head 区间提示用)
  head_commit: string | null; // R113: git HEAD when task ended
};

type DepTask = { id: string; title: string; status: string };

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await getServerUserId();

  // 短ID解析: 长度 < 36 且为合法 hex 前缀 → 前缀匹配, 唯一匹配则 redirect 到完整 UUID
  const isShortId = id.length < 36 && /^[0-9a-f-]+$/i.test(id);
  if (isShortId) {
    const matches = getTasksByShortId(id, userId);
    if (matches.length === 0) return notFound();
    if (matches.length > 1) return notFound(); // 多条匹配, 无法确定, 返回 404
    redirect(`/tasks/${matches[0].id}`);
  }

  const task = getTaskById(id, userId, { includeDeleted: true }) as Task | null;
  if (!task) return notFound();

  // Fetch dependency info
  const dependsOnIds = getDependencyTaskIds(id);
  const dependentTaskIds = getDependentTaskIds(id);

  // Resolve dependency task details (scoped to this user; non-owned ids drop out)
  const dependsOnTasks = dependsOnIds.map((depId) => getTaskById(depId, userId)).filter(Boolean) as Task[];
  const dependentTasks = dependentTaskIds.map((depId) => getTaskById(depId, userId)).filter(Boolean) as Task[];

  // Resolve parent task (if this task is a fork)
  const parentTask = task.forked_from_session_id ? getParentTask(task.forked_from_session_id) : null;

  // v32 派发链: 上游（谁派发了本任务）+ 下游（本任务派发了谁）。上游用 userId
  // 收窄，跨项目引用仍能解析（同 owner 即可）。
  const dispatcherTask = task.dispatched_by_task_id
    ? (getTaskById(task.dispatched_by_task_id, userId) as Task | null)
    : null;
  const dispatchedTasks = getDispatchedTasks(task.id, userId);

  // v57 (R15 task 收藏): 详情页 SSR 阶段查当前用户对该 task 的收藏状态.
  // 用户未登录时 isFavoriteByUser 返回 false, 详情页 ⭐ 灰显即可.
  const initialFavorite = isFavoriteByUser(userId, task.id);

  // R78 W3 §4.2: 需求点关联面板数据 -- task 挂在某个 requirement 下时, 拉该
  // requirement 的标题+状态 + 同 requirement 下其他 task (siblings, 去重本 task).
  // 同 owner 校验由 getRequirementById 兜底 (跨 owner → null).
  type RequirementLinkForDock = {
    id: string;
    title: string;
    status: string;
  };
  let requirementLink: RequirementLinkForDock | null = null;
  let requirementSiblings: DepTask[] = [];
  const requirementId = task.requirement_id;
  if (requirementId) {
    const reqRow = getRequirementById(requirementId, userId);
    if (reqRow) {
      requirementLink = {
        id: reqRow.id,
        title: reqRow.title,
        status: reqRow.status,
      };
      // siblings: 同 requirement 下所有 task, 去掉本 task, 最多 5 条.
      const forest = getRequirementTasks(requirementId);
      requirementSiblings = forest.tasks
        .filter((t) => t.id !== task.id)
        .slice(0, 5)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    }
  }

  // Resolve project/version for the header breadcrumb (task ownership already
  // verified above; unfiltered read so legacy NULL-owner projects still resolve).
  const project = task.project_id ? getProjectById(task.project_id) : null;
  const version = task.version_id ? getVersionById(task.version_id) : null;

  // v53 注入用户可见项目 cwd 列表 (R14 跨项目跳转兜底用) —— 与 wiki-client / page 同样的
  // 过滤 (只取 cwd 非空), owner 隔离由 listProjects(userId) 保证. 命名 wikiProjects
  // 区别于上面 project (单项目对象), 避免混淆.
  const wikiProjects = listProjects(userId, "created_at")
    .filter((p): p is typeof p & { cwd: string } => !!p.cwd)
    .map((p) => ({ id: p.id, cwd: p.cwd as string }));

  // Resolve fork timestamp (from task metadata) — used to draw a divider
  // between inherited (parent) messages and this session's own messages.
  let forkedAt: string | null = null;
  if (task.metadata) {
    try {
      const meta = JSON.parse(task.metadata);
      if (meta.forked_at) forkedAt = meta.forked_at as string;
    } catch {}
  }

  // Per-task timeout override (来自 metadata.timeout_minutes) + project/全局兜底,
  //   传给 TaskHeader 让编辑弹窗展示当前值 + 默认值.
  const timeoutOverrideMinutes = getTaskTimeoutOverrideMinutes(task as any);
  let defaultTimeoutMinutes: number | null = null;
  if (project?.timeout_minutes != null) {
    const parsed = parseTimeoutMinutes(project.timeout_minutes);
    defaultTimeoutMinutes = parsed ?? getGlobalTaskTimeoutMinutes();
  } else {
    defaultTimeoutMinutes = getGlobalTaskTimeoutMinutes();
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <TaskHeader
        task={task}
        parentTask={parentTask}
        project={project ? { id: project.id, name: project.name } : null}
        version={version ? { id: version.id, name: version.name } : null}
        modelName={task.resolved_model || process.env.ANTHROPIC_MODEL || task.model || "默认"}
        timeoutOverrideMinutes={timeoutOverrideMinutes}
        defaultTimeoutMinutes={defaultTimeoutMinutes}
        initialFavorite={initialFavorite}
      />

      {/* Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Conversation panel + right dock both live inside TaskDetailClient */}
        <div className="flex-1 min-w-0">
          <TaskDetailClient
            taskId={task.id}
            initialStatus={task.status}
            initialType={task.type}
            task={task}
            dependsOnTasks={dependsOnTasks as DepTask[]}
            dependentTasks={dependentTasks as DepTask[]}
            parentTask={parentTask}
            dispatcherTask={dispatcherTask ? { id: dispatcherTask.id, title: dispatcherTask.title, status: dispatcherTask.status } : null}
            dispatchedTasks={dispatchedTasks}
            requirementLink={requirementLink}
            requirementSiblings={requirementSiblings}
            forkedAt={forkedAt}
            wikiProjects={wikiProjects}
          />
        </div>
      </div>
    </div>
  );
}
