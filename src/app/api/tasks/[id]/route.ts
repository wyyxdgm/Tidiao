// GET /api/tasks/[id] - Get task detail
// PATCH /api/tasks/[id] - Update task
// DELETE /api/tasks/[id] - Delete task

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { getTaskById, getTasksByShortId, updateTask, deleteTask, restoreTask, getDependencyTaskIds, getDependentTaskIds, getDispatchedTasks, getParentTask, mutateTaskMetadata, replaceTaskDependencies } from "@/lib/db/tasks";
import type { Task } from "@/lib/runtime/types";
import { getAttachmentById, resolveTaskCwd } from "@/lib/db/attachments";
import { getRequirementById, getRequirementTasks } from "@/lib/db/requirements";
import { isFavoriteByUser } from "@/lib/db/user-favorites";
import { getIdea, getIdeaNode } from "@/lib/db/ideas";
import { stringifyStrArray } from "@/lib/json-array";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { parseTimeoutMinutes, MIN_TASK_TIMEOUT_MINUTES, MAX_TASK_TIMEOUT_MINUTES } from "@/lib/db/settings";
import { getLlmPrices, getCostBaselineConfigId } from "@/lib/db/llm-configs";
import { priceCoefficient } from "@/lib/runtime/cost-estimate";
import { readCachedCardSummary } from "@/lib/runtime/card-summary-store";
import { readCachedResultLayers } from "@/lib/runtime/result-layers-store";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const includeDeleted = searchParams.get("includeDeleted") === "true";

  // 短ID解析: id 长度 < 36 且为合法 hex 前缀时, 用 LIKE 查询
  const isShortId = id.length < 36 && /^[0-9a-f-]+$/i.test(id);
  let task: Task | null | undefined;
  let resolvedId = id;

  if (isShortId) {
    const matches = getTasksByShortId(id, userId);
    if (matches.length === 0) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    if (matches.length > 1) {
      return NextResponse.json({
        error: "Ambiguous short ID",
        matches: matches.map((t) => ({ id: t.id, title: (t.title || "").slice(0, 60) })),
      }, { status: 409 });
    }
    task = matches[0];
    resolvedId = task.id;
  } else {
    task = getTaskById(id, userId, { includeDeleted });
  }

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  // 功能: 收窄后的 task 常量。关注点: `task` 是 let, TS 的 null 收窄不跨闭包传递,
  // 下面 filter((t) => t.id !== task.id) 里引用会报 possibly null — 用 const 承接。
  const t: Task = task;

  // Enrich with dependency info
  const dependsOnIds = getDependencyTaskIds(resolvedId);
  const dependentTaskIds = getDependentTaskIds(resolvedId);

  // 关系对象补齐 (SPA 依赖图用)。背景: 详情页 SSR (src/app/tasks/[id]/page.tsx)
  // 在 server 侧 hydrate 好 dependsOnTasks / dispatcherTask / parentTask 再当
  // props 传下去, 而 SPA 是纯客户端 fetch —— 以前这里只回 *_ids, SPA 拿到
  // undefined → 依赖图恒为空 (damo R62)。ids 字段保留不动 (下游脚本在用)。
  const dependsOnTasks = dependsOnIds
    .map((depId) => getTaskById(depId, userId))
    .filter(Boolean);
  const dependentTasks = dependentTaskIds
    .map((depId) => getTaskById(depId, userId))
    .filter(Boolean);
  const parentTask = task.forked_from_session_id
    ? getParentTask(task.forked_from_session_id)
    : null;
  const dispatcherTask = task.dispatched_by_task_id
    ? getTaskById(task.dispatched_by_task_id, userId)
    : null;
  const dispatchedTasks = getDispatchedTasks(resolvedId, userId);
  const dispatchedTaskIds = dispatchedTasks.map((t) => t.id);

  // 需求点关联 (同 SSR 页 R78 W3 §4.2 口径): 本 task 挂了 requirement 就回
  // 标题+状态 + 同 requirement 的其他 task (去重本 task, 最多 5 条)。
  let requirementLink: { id: string; title: string; status: string } | null = null;
  let requirementSiblings: { id: string; title: string; status: string }[] = [];
  if (task.requirement_id) {
    const reqRow = getRequirementById(task.requirement_id, userId);
    if (reqRow) {
      requirementLink = { id: reqRow.id, title: reqRow.title, status: reqRow.status };
      requirementSiblings = getRequirementTasks(task.requirement_id)
        .tasks.filter((task) => task.id !== t.id)
        .slice(0, 5)
        .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    }
  }

  return NextResponse.json({
    ...task,
    // v57 (R15 task 收藏): 收藏是 per-user 偏好, 存在 user_favorites 表而非 tasks 行,
    // 必须按 x-user-id 现算. 漏这字段 -> SPA 详情页 (spa/src/views/TaskDetailView.vue)
    // 读 task.is_favorite 恒 undefined -> `?? false` -> 刷新后收藏状态丢失 (2026-09-29 实证).
    is_favorite: isFavoriteByUser(userId, resolvedId),
    depends_on_ids: dependsOnIds,
    dependent_task_ids: dependentTaskIds,
    // v32: 下游派发链 (本任务派发出去的 task ids)。上游 id 已在 task 行的
    // dispatched_by_task_id 字段里，不重复。
    dispatched_task_ids: dispatchedTaskIds,
    // 关系对象 (SPA 依赖图 / 派发与依赖面板; ids 版见上)。
    depends_on_tasks: dependsOnTasks,
    dependent_tasks: dependentTasks,
    parent_task: parentTask,
    dispatcher_task: dispatcherTask,
    dispatched_tasks: dispatchedTasks,
    requirement_link: requirementLink,
    requirement_siblings: requirementSiblings,
    // 收尾预热产物直读 (R200 预热 + 本批次): 任务详情自带总结, 信息面板
    // 直接从这里渲染, 不再调 Console 的两个按需接口. 没预热/已失效 → null,
    // 前端隐藏模块 (存量任务可跑 scripts/warm-result-layers.ts 回填).
    card_summary: readCachedCardSummary(t),
    result_layers: readCachedResultLayers(t),
    // R239 成本系数: 本任务模型基准价 / 全局基准模型基准价 (基准未设或任一侧
    // 没配价 → null, 前端显「—」). 现算不入库 —— 系数随基准切换即时生效.
    cost_coefficient: (() => {
      const prices = getLlmPrices(t.llm_config_id ?? null);
      const baseline = getLlmPrices(getCostBaselineConfigId());
      return prices && baseline ? priceCoefficient(prices, baseline) : null;
    })(),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate before mutating.
  if (!getTaskById(id, userId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const body = await request.json();

  // v32 派发方溯源不可改：dispatched_by_task_id 只在 POST 时定一次（来自 body
  // 显式值或 ORCHESTRATOR_TASK_ID env 自动注入），PATCH 路径没有合法写入源。
  // 静默丢弃会让 partner 这类外部 PATCH 误以为改成功（实测 0823 task 1e7d4744）。
  // 拒成 400 让调用方立刻看见失败，不要在 metadata 里塞补丁标记。
  if ("dispatched_by_task_id" in body && body.dispatched_by_task_id !== undefined) {
    return NextResponse.json(
      { error: "dispatched_by_task_id is immutable; set it via POST /api/tasks", code: "DISPATCHED_BY_IMMUTABLE" },
      { status: 400 }
    );
  }

  // Whitelist of fields that can be updated via PATCH. timeout_minutes 是 per-task
  //   override (持久化在 metadata, 不在 tasks 列), 单独抽出处理 (见下方), 不进这集合.
  // progress/progress_note (v517 / R196): agent 每轮自报完成度 0-100 + 依据.
  //   progress_source 由这里按语义固定 'manual' (agent/人工经 API 报都算直接修正).
  const ALLOWED_FIELDS = new Set(["title", "description", "prompt", "priority", "cwd", "model", "allowed_tools", "max_turns", "effort", "tags", "metadata", "auto_approve", "requirement_id", "awaiting_reason", "progress", "progress_note", "idea_id", "node_id", "work_class"]);
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(key)) {
      updates[key] = value;
    }
  }
  // progress 校验: null = 清空; 整数 0-100 = 写入 (非法值拒 400, 不静默吞).
  if (updates.progress !== undefined && updates.progress !== null) {
    const p = updates.progress;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 100) {
      return NextResponse.json(
        { error: "progress must be integer 0-100 or null", code: "PROGRESS_INVALID" },
        { status: 400 }
      );
    }
  }
  if (updates.progress_note !== undefined && updates.progress_note !== null && typeof updates.progress_note !== "string") {
    return NextResponse.json(
      { error: "progress_note must be string or null", code: "PROGRESS_NOTE_INVALID" },
      { status: 400 }
    );
  }
  if (updates.progress !== undefined) {
    updates.progress_source = "manual";
    updates.progress_updated_at = new Date().toISOString().replace("T", " ").slice(0, 19);
  }
  if (updates.idea_id !== undefined && updates.idea_id !== null && !getIdea(updates.idea_id as string, userId)) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  if (updates.node_id !== undefined && updates.node_id !== null) {
    const node = getIdeaNode(updates.node_id as string, userId);
    if (!node) {
      return NextResponse.json({ error: "Idea node not found", code: "NODE_NOT_FOUND" }, { status: 404 });
    }
    // 一致性: node 必须属于 (新值 ?: 任务现有值) 的 idea
    const targetIdea =
      updates.idea_id !== undefined ? updates.idea_id : getTaskById(id, userId)!.idea_id ?? null;
    if (targetIdea && node.idea_id !== targetIdea) {
      return NextResponse.json(
        { error: "node does not belong to idea", code: "NODE_IDEA_MISMATCH" },
        { status: 400 }
      );
    }
  }
  if (updates.work_class !== undefined && updates.work_class !== null && !["fix", "feature", "plan", "ops"].includes(updates.work_class as string)) {
    return NextResponse.json(
      { error: "work_class must be fix/feature/plan/ops", code: "WORK_CLASS_INVALID" },
      { status: 400 }
    );
  }
  // tags/allowed_tools/metadata 在 DB 里是 JSON 字符串列, 但 JSON 客户端会自然地
  // 把它们当数组/对象传 (2026-08-25 实测: tags 传数组 -> better-sqlite3 把数组值
  // 展开成多个绑定参数 -> RangeError "Too many parameter values were provided" 500,
  // 对象则是 "Too few"). 这里统一序列化成列期望的字符串, 与 createTask 同构.
  if (Array.isArray(updates.tags)) {
    updates.tags = stringifyStrArray(updates.tags);
  }
  if (Array.isArray(updates.allowed_tools)) {
    updates.allowed_tools = stringifyStrArray(updates.allowed_tools);
  }
  if (updates.metadata !== undefined && updates.metadata !== null && typeof updates.metadata === "object") {
    updates.metadata = JSON.stringify(updates.metadata);
  }
  // auto_approve is stored as 0/1 in SQLite; coerce booleans from the API.
  if (updates.auto_approve !== undefined) {
    updates.auto_approve = updates.auto_approve ? 1 : 0;
  }
  // Append uploaded attachment paths to the prompt so the agent sees them at
  // start time. Used by the task-creation two-step flow (create -> upload ->
  // append -> start). Paths resolve server-side (cwd fallback) since the
  // client cannot know the absolute cwd.
  if (Array.isArray(body.append_attachments) && body.append_attachments.length > 0) {
    const current = getTaskById(id, userId);
    if (current) {
      const cwd = resolveTaskCwd(current);
      const lines: string[] = [];
      for (const aid of body.append_attachments as string[]) {
        const att = getAttachmentById(aid, userId);
        if (!att || att.task_id !== id) continue;
        lines.push(`- ${path.join(cwd, "attachments", att.filename)} (${formatSize(att.size_bytes)}, ${att.media_type})`);
      }
      if (lines.length > 0) {
        updates.prompt = (current.prompt || "") + `\n\n用户上传了以下文件：\n${lines.join("\n")}`;
      }
    }
  }

  // per-task timeout override: 校验 + 写 metadata + 已在跑的任务重挂 timer.
  // 单独从 updates 抽出, 不走 updateTask (tasks 列上没有这字段).
  // undefined = 未给 (保持现状); null = 清掉 override, 恢复 project/全局; 数字 = 覆盖.
  let timeoutOverride: number | null | undefined;
  if ("timeout_minutes" in body) {
    const raw = body.timeout_minutes;
    if (raw === null) {
      timeoutOverride = null;
    } else {
      const n = parseTimeoutMinutes(raw);
      if (n === null) {
        return NextResponse.json(
          { error: `timeout_minutes 必须是 ${MIN_TASK_TIMEOUT_MINUTES}-${MAX_TASK_TIMEOUT_MINUTES} 的整数` },
          { status: 400 },
        );
      }
      timeoutOverride = n;
    }
  }

  // depends_on_ids: 与 timeout_minutes 同形 — 涉及两张表 (tasks.depends_on JSON +
  // task_dependencies rows), 不能走 updateTask 的「字符串列 SET」路径.
  // undefined = 未给 (不碰); string[] = 替换全部 (空数组=清空); null = 显式清空.
  // 同 owner 校验委托 createTask 已有路径 (路由只判 schema, DB 层 createTask
  // 已经报 DEPENDENCY_NOT_FOUND). 严格校验在路由层防脏值进库 (空字符串 / 嵌套).
  let dependsOnIds: string[] | null | undefined;
  if ("depends_on_ids" in body) {
    const raw = body.depends_on_ids;
    if (raw === null) {
      dependsOnIds = null;
    } else if (Array.isArray(raw)) {
      if (!raw.every((x) => typeof x === "string" && x.length > 0)) {
        return NextResponse.json(
          { error: "depends_on_ids 必须是 string[] (非空字符串)" },
          { status: 400 },
        );
      }
      dependsOnIds = raw as string[];
    } else {
      return NextResponse.json(
        { error: "depends_on_ids 必须是 string[] 或 null" },
        { status: 400 },
      );
    }
  }

  // 白名单一个字段都没匹配 + 没传 timeout_minutes/depends_on_ids = 没东西可改.
  if (Object.keys(updates).length === 0 && timeoutOverride === undefined && dependsOnIds === undefined) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // 存在性校验放在所有解析之后, 避免给不存在 task 走完校验才 404.
  let task = getTaskById(id, userId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // v64: requirement_id 关联校验. 同 owner + 未软删 (status != 'closed').
  // 显式 null = 解绑, 允许 (清空 FK); 非字符串 = 400.
  if ("requirement_id" in updates) {
    const rid = updates.requirement_id;
    if (rid === null) {
      // 解绑, OK
    } else if (typeof rid === "string") {
      const req = getRequirementById(rid, userId);
      if (!req) {
        return NextResponse.json(
          { error: `Requirement ${rid} not found`, code: "REQUIREMENT_NOT_FOUND" },
          { status: 404 }
        );
      }
      if (req.status === "closed") {
        return NextResponse.json(
          { error: `Requirement ${rid} is closed`, code: "REQUIREMENT_CLOSED" },
          { status: 400 }
        );
      }
    } else {
      return NextResponse.json(
        { error: "requirement_id must be string or null" },
        { status: 400 }
      );
    }
  }

  // R15 sub-3: 记下更新前的 title, 后面比对 — 用 task.title (没更新) 而不是更新
  //   之后的 task.title, 否则同名 PATCH (用户没真改) 也会被误判为手动.
  const oldTitle = task.title;

  if (Object.keys(updates).length > 0) {
    task = updateTask(id, updates) || task;
  }

  // 持久化 timeout override 到 metadata (走 mutateTaskMetadata, 别自己 JSON.parse ——
  //   CLAUDE.md 红线: 全字段覆盖会抹掉别人刚写的键).
  if (timeoutOverride !== undefined) {
    mutateTaskMetadata(id, (meta) => {
      if (timeoutOverride === null) {
        delete meta.timeout_minutes;
      } else {
        meta.timeout_minutes = timeoutOverride;
      }
    });
  }

  // R15 sub-3: title 改动走 PATCH = 用户手动改, 立刻置 metadata.title_lock =
  //   'manual', 锁死 auto-rename. 条件: updates.title 是 string (走白名单), 且
  //   与老 title 不等 (同名 PATCH 不算手动, 别误锁). 与 auto-rename 的 lock='auto'
  //   互斥 — 一旦用户动过, 锁永远是 manual.
  if (typeof updates.title === "string" && updates.title !== oldTitle) {
    mutateTaskMetadata(id, (meta) => {
      meta.title_lock = "manual";
    });
  }

  // 持久化 depends_on_ids (走 replaceTaskDependencies, 原子 DELETE+UPDATE+INSERT,
  //   tasks.depends_on JSON 与 task_dependencies 表保持一致).
  // DAG P1 (2026-09-05): replaceTaskDependencies 会做环检测, 撞环抛
  //   TaskLocationError("DEPENDENCY_CYCLE"); 转 400, 旧 deps 不动.
  if (dependsOnIds !== undefined) {
    try {
      replaceTaskDependencies(id, dependsOnIds);
    } catch (err) {
      const code = (err as { code?: string; name?: string })?.code;
      if (code === "DEPENDENCY_CYCLE" || (err as { name?: string })?.name === "TaskLocationError") {
        return NextResponse.json(
          { error: (err as Error).message, code: "DEPENDENCY_CYCLE" },
          { status: 400 }
        );
      }
      throw err;
    }
  }

  // 自动审批开关对正在跑的任务实时生效 (下一次工具调用即读到新值)。
  if (updates.auto_approve !== undefined) {
    getRuntime().setAutoApprove(id, updates.auto_approve === 1);
  }
  // 改 timeout_minutes 后: 已在跑 → 重挂 timer + 推 status_change (新 timeout_ms 走 SSE);
  //   没在跑 → 下次 start/resume 由 resolveTaskTimeoutMs 现算, 不需要额外动作.
  //   null (清掉) 不重挂 (timer 在 cancel/runTask finally 自己清), 仅 metadata 覆盖被删就够.
  if (timeoutOverride !== undefined && timeoutOverride !== null) {
    const ok = getRuntime().setTaskTimeout(id, timeoutOverride);
    if (ok) {
      // 同状态 status_change: matchingRules 不匹配任何 from==to 规则, webhook 也不发;
      //   唯一作用是让前端 SSE 拿到新 timeout_ms 重启倒计时.
      const current = getTaskById(id);
      if (current) {
        getRuntime().emitEvent(id, {
          type: "status_change",
          task_id: id,
          from: current.status,
          to: current.status,
          source: "manual",
        });
      }
    }
  }

  // 重新读一次返回最新 task (含 metadata override).
  const final = getTaskById(id, userId);
  return NextResponse.json(final ?? task);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Ownership gate: only the owner may delete (no existence leak).
  // Use includeDeleted so already-deleted tasks return 404 on re-delete.
  const task = getTaskById(id, userId, { includeDeleted: true });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.deleted_at) {
    return NextResponse.json({ error: "Task already deleted" }, { status: 409 });
  }
  const ok = deleteTask(id);
  if (!ok) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
