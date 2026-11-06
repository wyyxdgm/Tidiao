// GET /api/tasks - List tasks (scoped to current user)
// POST /api/tasks - Create task (owner inherited from project; project must be owned by current user)

import { NextRequest, NextResponse } from "next/server";
import { listTasks, mutateTaskMetadata } from "@/lib/db/tasks";
import { getProjectById } from "@/lib/db/projects";
import { getScheduleById } from "@/lib/db/schedules";
import { getIdea, getIdeaNode } from "@/lib/db/ideas";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { checkUserQuota } from "@/lib/db/users";
import { checkGoalMarkerAutoApprove } from "@/lib/runtime/goal-marker";
import {
  MIN_MAX_GOAL_ROUNDS,
  MAX_MAX_GOAL_ROUNDS,
} from "@/lib/db/settings";
import type { TaskDefinition } from "@/lib/runtime/types";

export async function GET(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || undefined;
  const limit = searchParams.get("limit")
    ? parseInt(searchParams.get("limit")!)
    : undefined;
  // projectId (camelCase, partner/JS 客户端约定) 优先; ?project= 兜底兼容
  // docs/api-routes.md 现有文档与 test-e2e.sh 的写法. 两者都给则 projectId 赢.
  const projectId =
    searchParams.get("projectId") || searchParams.get("project") || undefined;
  const versionId = searchParams.get("version") || undefined;
  const unassigned = searchParams.get("unassigned") === "true";
  const unversioned = searchParams.get("unversioned") === "true";
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  // v57 (R15 task 收藏): ?favorite=true 透传给 listTasks. ownerId 已有
  // (userId 来自鉴权), favorite filter 直接生效. false/undefined 走原路径.
  const favorite = searchParams.get("favorite") === "true";
  // 飞书 R180: 顶栏全局搜索 — ?search=<kw> LIKE 匹配 id/title/status/tags.
  const search = searchParams.get("search") || undefined;

  if (unversioned && !projectId) {
    return NextResponse.json(
      { error: "project is required for unversioned task queries" },
      { status: 400 }
    );
  }

  if (unassigned) {
    // Return this user's tasks where project_id is NULL (legacy unassigned).
    const { getDb } = await import("@/lib/db/index");
    const db = getDb();
    const tasks = db
      .prepare(
        "SELECT * FROM tasks WHERE project_id IS NULL AND owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC"
      )
      .all(userId);
    return NextResponse.json(tasks);
  }

  const tasks = listTasks({
    status: status as any,
    limit,
    project_id: projectId,
    version_id: versionId,
    unversioned,
    ownerId: userId,
    includeDeleted,
    favorite,
    search,
  });

  return NextResponse.json(tasks);
}

export async function POST(request: NextRequest) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  if (!body.project_id || typeof body.project_id !== "string") {
    return NextResponse.json(
      { error: "project_id is required", code: "PROJECT_REQUIRED" },
      { status: 400 }
    );
  }

  // Gate: the project must exist AND be owned by the current user. A missing
  // or foreign project returns 404 (no existence leak). createTask then
  // inherits owner_id from this project.
  const project = getProjectById(body.project_id, userId);
  if (!project) {
    return NextResponse.json(
      { error: "Project not found", code: "PROJECT_NOT_FOUND" },
      { status: 404 }
    );
  }

  // idea-canvas P0 (v521): 构思层弱引用归属校验 — idea/node 必须属当前 user
  // (no existence leak → 404); 同时给时 node 必须属于该 idea (一致性 400).
  if (body.idea_id && !getIdea(body.idea_id, userId)) {
    return NextResponse.json({ error: "Idea not found", code: "IDEA_NOT_FOUND" }, { status: 404 });
  }
  if (body.node_id) {
    const node = getIdeaNode(body.node_id, userId);
    if (!node) {
      return NextResponse.json({ error: "Idea node not found", code: "NODE_NOT_FOUND" }, { status: 404 });
    }
    if (body.idea_id && node.idea_id !== body.idea_id) {
      return NextResponse.json(
        { error: "node does not belong to idea", code: "NODE_IDEA_MISMATCH" },
        { status: 400 }
      );
    }
  }

  const def: TaskDefinition = {
    title: body.title,
    prompt: body.prompt,
    description: body.description,
    priority: body.priority,
    cwd: body.cwd,
    auto_approve: body.autoApprove,
    model: body.model,
    allowedTools: body.allowedTools,
    maxTurns: body.maxTurns,
    effort: body.effort,
    tags: body.tags,
    // 字段别名: depends_on_ids (snake, 与 GET 回读对齐) 优先, 旧 camel 兜底;
    //   两者都给则 snake 赢 — 与 GET 单一蛇形说法一致, 避免一个字段两套名.
    dependsOn: body.depends_on_ids ?? body.dependsOn,
    project_id: body.project_id,
    version_id: body.version_id,
    dispatched_by_task_id: body.dispatched_by_task_id,
    schedule_id: body.schedule_id, // shell 类定时任务自建 task 时关联回 schedule（防重派闸门要用）
    // Role 场景化 P2 (docs/plans/role-scoped-roles.md D2): 透传 role_id.
    //   createTask 内做存在 + owner + 作用域校验, 抛 ROLE_NOT_FOUND /
    //   ROLE_SCOPE_MISMATCH → 下方 catch 转 400 (不留 500).
    role_id: body.role_id ?? undefined,
    llm_config_id: body.llm_config_id ?? null,
    template_id: body.template_id ?? null,
    requirement_id: body.requirement_id ?? null,
    // idea-canvas P0 (v521): 构思层弱引用. 归属校验在上方 (idea/node 必须属当前 user).
    idea_id: body.idea_id ?? null,
    node_id: body.node_id ?? null,
    work_class: body.work_class ?? null,
    // R78 W1 §4.3 invariant 前置: 透传 task.type ∈ {design,dev,test,deploy,null}.
    // requirement 详情页弹窗 = 创建 linked root task 时显式传; 不传 = 落库 null (uncategorized).
    // 非法值由 createTask 内部兜底 (走 TaskDefinition.type 校验).
    type: body.type ?? null,
    // v132 (D10): 前置门字段. dispatcher 派活时填「为什么派这个任务」+ 5 选 1 枚举.
    //   后置反思不靠谱 (5 样本 0/5 命中), 派发那一瞬 dispatcher 知道为什么. 不传 = NULL,
    //   UI 角标显示「⚠ 未填价值」. 不硬阻塞 (damo 9/8 拍板「软警告」, 详见 §18.1 + §18.5).
    value_significance: body.value_significance ?? null,
    value_kind: body.value_kind ?? null,
    // 波 2.5 (docs/plans/auto-complete-dag.md D7.2#4): 透传 auto_complete.
    //   createTask 内做 DAG 硬校验, 抛 AUTO_COMPLETE_REQUIRES_DAG → 下方 catch 转 400.
    auto_complete: body.autoComplete,
  };

  // v132 (D10) 软警告: value_significance 缺失时 console.warn + 业务日志记录,
  //   但不阻塞 createTask (存量 ~200+ task 全没填, hard block = 一次炸所有线上).
  //   设计: 让 damo / 上游 agent 慢慢养成习惯, UI 角标 + dashboard「未填价值排行」施压.
  //   升硬时机见 §18.8 (UI 角标显示 30 天 < 20% 未填 / damo 主动 ack 等条件).
  if (!body.value_significance || (typeof body.value_significance === "string" && body.value_significance.trim() === "")) {
    console.warn(
      `[tasks.create] warn: value_significance is empty for "${body.title}" — ` +
      `D10 前置门 (docs/plans/requirement-as-entity.md §18) 建议派发时反思「为什么派这个任务」`
    );
  }

  // R78 W1 §4.3 invariant 前置: 显式校验 task.type, 越界返 400 (友好报错, 与 status 同口径).
  const allowedTaskTypes = ["design", "dev", "test", "deploy", null];
  if (body.type !== undefined && body.type !== null && !allowedTaskTypes.includes(body.type)) {
    return NextResponse.json(
      {
        error: `type must be one of: design,dev,test,deploy (or null)`,
        code: "TYPE_INVALID",
      },
      { status: 400 }
    );
  }

  if (!def.title || !def.prompt) {
    return NextResponse.json(
      { error: "title and prompt are required" },
      { status: 400 }
    );
  }

  // Goal-driven loop 阶段 3 (D20, 漏洞 #5): prompt 含 <goal>...</goal> marker
  //   → 必须 autoApprove=true. 否则 pushMessage 注入到非 autoApprove task 时
  //   下一轮工具调用进审批 UI = loop 死锁. 没 marker → fast-path 放行, 不污染
  //   99%+ 的非 goal task 创建流程.
  const goalCheck = checkGoalMarkerAutoApprove(def.prompt, body.autoApprove);
  if (!goalCheck.ok) {
    return NextResponse.json(
      { error: goalCheck.reason, code: goalCheck.code },
      { status: 400 },
    );
  }

  // R143 二轮 (damo 2026-09-15): per-task max_goal_rounds 覆盖. body.goalRounds
  //   校验 + 不在 POST 字段白名单里 (R78 §4.3 invariant 不动 schema) → 不走
  //   TaskDefinition, 创建后写 metadata.max_goal_rounds. 范围 [0, 1000] 与
  //   settings.ts 上限一致 (R143 四轮扩到 1000, 0 = 不限 sentinel).
  //   越界/非整数 → 400 (跟其他 400 同口径).
  //   没传 → 不写 metadata, 跑动时 fall back 到 settings.getMaxGoalRounds().
  //   "没有 goal_text 传数字也无效" = 字段无副作用 (active-session 见不到
  //   goalText 就不会进 continueGoalLoop), 不报 400 但 UI 层会显式提示.
  let resolvedGoalRounds: number | null = null;
  if (body.goalRounds !== undefined && body.goalRounds !== null) {
    if (
      typeof body.goalRounds !== "number" ||
      !Number.isInteger(body.goalRounds) ||
      body.goalRounds < MIN_MAX_GOAL_ROUNDS ||
      body.goalRounds > MAX_MAX_GOAL_ROUNDS
    ) {
      return NextResponse.json(
        {
          error:
            `goalRounds must be an integer in [${MIN_MAX_GOAL_ROUNDS}, ${MAX_MAX_GOAL_ROUNDS}]; got ${body.goalRounds}`,
          code: "GOAL_ROUNDS_INVALID",
        },
        { status: 400 },
      );
    }
    resolvedGoalRounds = body.goalRounds;
  }

  // schedule_id 归属校验: 只能挂到自己的 schedule 上。shell 类定时任务的脚本走这个
  // 接口自建 task, 传了才能让平台反查「这个 schedule 派出的 task 还没走完」=
  // 防重派闸门对 shell 也生效（见 docs/plans/schedule-runaway-shell-gap.md G1）。
  // 外键 schedules.id 不校验会在 INSERT 时炸成 500, 所以在这里拦成 404。
  if (def.schedule_id !== undefined && def.schedule_id !== null) {
    if (
      typeof def.schedule_id !== "string" ||
      !getScheduleById(def.schedule_id, userId)
    ) {
      return NextResponse.json(
        { error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" },
        { status: 404 }
      );
    }
  }

  // 派发方溯源走两条路径：(1) 显式 body 字段；(2) ao-dispatch.sh 客户端从
  // agent 子进程 env 读 ORCHESTRATOR_TASK_ID 转成显式 --from-task。server
  // 侧不再读 env — 曾因 pm2 env 残留导致 38 条误归因事故，见
  // docs/fixes/2026-08-26-task-dispatch-env-pollution.md.

  // R88 quota 拦截（Sheet L 验收 ⑥）: 三件套 party_a=1 用户的 create 入口必查。
  //   - 自动覆盖路径: agent schedule (schedule-runner.fireAgent 走 createTask),
  //     intake/wecom, feishu/sync, 这些都调 runtime.createTask / startTask.
  //   - 不覆盖: shell schedule (fireShell 直接 exec, 不经 task 实体; cost 不计入
  //     tasks.cost_usd) —— 这是 R88 维度=user 的副作用, 不是 bug.
  //   - 返 403 + code=QUOTA_BLOCKED 让前端统一处理（toast + 链接到 /settings 配额卡）.
  const quota = checkUserQuota(userId);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: quota.detail ?? "quota blocked", code: "QUOTA_BLOCKED", reason: quota.reason, quota },
      { status: 403 }
    );
  }

  try {
    const task = getRuntime().createTask(def);
    // R143 二轮: per-task max_goal_rounds 写入 metadata (key 名跟
    //   agent-runtime.ts:continueGoalLoop 读的对齐). 不抛错时静默继续;
    //   写失败 (task 不存在 / metadata 脏) 不阻断 task 创建 —— 与 active-session
    //   写 goal_text 同款 "metadata 失败不阻断" 容错.
    if (resolvedGoalRounds !== null) {
      try {
        mutateTaskMetadata(task.id, (meta) => {
          (meta as Record<string, unknown>).max_goal_rounds = resolvedGoalRounds;
          return true;
        });
      } catch (metaErr) {
        console.warn(
          `[tasks.create] warn: failed to write max_goal_rounds to metadata for task ${task.id}:`,
          metaErr,
        );
      }
    }
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    // 用 code 字段判定（不用 instanceof: vitest dynamic-import 下同模块的类
    // 可能不是同一引用, instanceof 会 false 漏接）.
    const code = (err as { code?: string })?.code;
    if (code && [
      "PROJECT_REQUIRED",
      "PROJECT_NOT_FOUND",
      "VERSION_NOT_FOUND",
      "VERSION_PROJECT_MISMATCH",
      "DISPATCHER_NOT_FOUND",
      "REQUIREMENT_NOT_FOUND",
      "REQUIREMENT_CLOSED",
      "DEPENDENCY_CYCLE",
      // Role 场景化 P2 (docs/plans/role-scoped-roles.md D2): role 校验错误转 400.
      "ROLE_NOT_FOUND",
      "ROLE_SCOPE_MISMATCH",
      // 波 2.5 (docs/plans/auto-complete-dag.md D7.1): auto_complete 仅 DAG 项目.
      "AUTO_COMPLETE_REQUIRES_DAG",
    ].includes(code)) {
      return NextResponse.json(
        { error: (err as Error).message, code },
        { status: 400 }
      );
    }
    throw err;
  }
}
