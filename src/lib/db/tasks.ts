// Task CRUD operations

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./index";
import { getProjectById, getProjectDagEnforced } from "./projects";
import { getVersionById } from "./versions";
import { getUserById } from "./users";
import { getRequirementById } from "./requirements";
import { getIdea, getIdeaNode } from "./ideas";
import type { Task, TaskDefinition, TaskStatus, EffortLevel, TaskType, TaskTrimmed } from "../runtime/types";
// R15 auto-rename (auto-rename.ts) 从本模块取 Task 类型; 也方便外部消费者
// 不必绕道 runtime/types. 保持原 import 不动 (file 内使用), 仅 re-export.
export type { Task };
import { DELETED_TAG } from "../constants";
import { getRoleById, getRoleByName } from "./roles";
import { execSync } from "child_process";
import fs from "fs";
import { parseStrArray, stringifyStrArray } from "../json-array";

export type TaskLocationErrorCode =
  | "PROJECT_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "VERSION_PROJECT_MISMATCH"
  // v32: 不是 location 问题, 但同样是「调用方传了个解析不出来的引用」→ 复用这个
  // 类走 route 层已有的 400 出口, 免得为一个可选字段再加一套错误类型/catch 分支.
  | "DISPATCHER_NOT_FOUND"
  // v64: 同 owner 校验; 软删走 status='closed' (新 spec), 不能往已关的需求挂 task.
  | "REQUIREMENT_NOT_FOUND"
  | "REQUIREMENT_CLOSED"
  // DAG P1 (2026-09-05): task_dependencies 不允许成环. detectDependencyCycle
  // 在 createTask / replaceTaskDependencies 入口 throw, 路由 catch 转 400.
  | "DEPENDENCY_CYCLE"
  // Role 场景化 P1 (docs/plans/role-scoped-roles.md D1): project 专属 role 不能
  // 挂到别的 project 的 task. createTask throw, route 层 400 映射波 2 接.
  | "ROLE_SCOPE_MISMATCH"
  // Role 场景化 P2 (D2): 显式 role_id 查不到 (不存在 / 跨 owner). 原来裸 Error
  // 无 code, route 层按 code 判定接不住 → 500; 现走 TaskLocationError 转 400.
  | "ROLE_NOT_FOUND"
  // 波 2.5 (docs/plans/auto-complete-dag.md D7.1): auto_complete 仅 DAG 项目可用.
  // createTask 内校验 (防绕过 route 直调), route 层 400 同码映射.
  | "AUTO_COMPLETE_REQUIRES_DAG";

export class TaskLocationError extends Error {
  constructor(public code: TaskLocationErrorCode, message: string) {
    super(message);
    this.name = "TaskLocationError";
  }
}

// Preflight self-check. The orchestrator (not the agent) runs pwd / git
// remote -v / git log -1 at createTask time, stores the 4-line result in
// tasks.preflight_result, and injects it at the top of the prompt. This
// replaces the v27 scheme where the agent ran the commands itself - saving
// one Bash round per task. The dispatcher reads preflight_result (right
// dock) to confirm the task landed in the right repo/cwd; the injected
// block also tells the agent to halt if the cwd/remote is obviously wrong.
//
// Preflight fires on: POST /api/tasks, feishu sync, template instantiate,
// import (md/json/csv), schedule-runner.fireAgent, fork. It does NOT re-fire
// on reject-resume / pause-resume - those inject feedback via pending_messages
// or reject_reason and the SDK replays the original session.

// 功能: 服务端在 resolved cwd 同步执行 3 条 preflight 命令 (pwd / git remote -v
// / git log -1), 返回 4 行结构化字符串 (dispatcher grep 的字段名). 替代 v27 让
// agent 自跑命令的方案, 省一轮 Bash 调用.
// 关注点: execSync 同步执行, 每条 5s timeout; 正常 git 仓库 <200ms, 但超大仓库
// / 网络挂载可能阻塞 createTask (本函数同步调用). 已 catch 所有异常 + timeout
// 降级为描述字符串, 保证不阻断 createTask. cwd=NULL (isolated) 或目录不存在时
// 不执行命令, 直接报告状态.
function runPreflight(cwd: string | null): string {
  const CHECK = "请 dispatcher 核对";
  if (!cwd) {
    return [
      "preflight.cwd: isolated workspace",
      "preflight.remote: no git repo",
      "preflight.last_commit: no git repo",
      `preflight.is_correct: ${CHECK}`,
    ].join("\n");
  }
  if (!fs.existsSync(cwd)) {
    return [
      `preflight.cwd: ${cwd} (目录不存在)`,
      "preflight.remote: n/a",
      "preflight.last_commit: n/a",
      "preflight.is_correct: no",
    ].join("\n");
  }
  const opts = { cwd, timeout: 5000, encoding: "utf8" as const };
  const run = (cmd: string): string => {
    try { return execSync(cmd, opts).trim(); } catch { return ""; }
  };
  const pwd = run("pwd");
  const remoteRaw = run("git remote -v");
  // git remote -v prints one line per (remote, direction); keep just the
  // first line so the field stays compact.
  const remote = remoteRaw ? remoteRaw.split("\n")[0] : "no git repo";
  const commit = run("git log -1 --oneline") || "no git repo";
  return [
    `preflight.cwd: ${pwd || cwd}`,
    `preflight.remote: ${remote}`,
    `preflight.last_commit: ${commit}`,
    `preflight.is_correct: ${CHECK}`,
  ].join("\n");
}

// 功能: 构建 prompt 头部 preflight 块, 携带系统执行的结果. agent 不再跑命令,
// 只读事实; cwd/remote 明显不符时兜底停下报告 (cheap read, 非 Bash 轮).
// 功能: 构思上下文 block (idea-canvas P4, docs/plans/idea-canvas.md §6) — 任务挂
//   idea/node 时把构思的假设/判据/节点验收注入 prompt, agent 不用再查库就知道
//   「这个任务在验证什么、验收口径是什么」。
// 关注点: 与 preflight 同机制 (createTask 时写死进 tasks.prompt, resume/fork 重放
//   自然携带); idea 已出结论也照注 (agent 该知道结论再动手)。
function buildIdeaContextBlock(idea: { title: string; hypothesis: string | null; success_criteria: string | null; status: string; conclusion: string | null }, node: { title: string; detail: string | null; status: string } | null): string {
  const lines: string[] = ["", "[idea context] (系统注入 — 本任务挂在某个构思的验证链上)"];
  lines.push(`构思: ${idea.title}（状态: ${idea.status}）`);
  if (idea.hypothesis) lines.push(`假设: ${idea.hypothesis}`);
  if (idea.success_criteria) lines.push(`验证判据: ${idea.success_criteria}`);
  if (idea.conclusion) lines.push(`已有结论: ${idea.conclusion}`);
  if (node) {
    lines.push(`节点: ${node.title}（状态: ${node.status}）`);
    if (node.detail) lines.push(`节点要求: ${node.detail}`);
    lines.push("完成后: 结果要能回答这条假设是否被验证（能证实/证伪/无信号，写进收尾总结）");
  } else {
    lines.push("完成后: 总结里说明本任务对这条假设的推进/验证贡献。");
  }
  return lines.join("\n") + "\n";
}

function buildPreflightBlock(result: string): string {
  return `[preflight check] (系统已执行)
系统在 task 启动前已执行 preflight 自检，结果如下（dispatcher 用来确认派发正确）：

\`\`\`
${result}
\`\`\`

若上述 cwd / remote 与任务预期明显不符（派发到了错误仓库或目录），**不要做任何代码改动**，向用户报告你的发现并等待指示。一致则直接开始任务。

[task]
`;
}

// 功能: 构建 prompt 里的「派发方」一行, 告诉子 agent 自己由哪个上游 task 派发.
// 关注点: 只放 title + id, 不带上游 prompt (避免把上游上下文整段塞进来); 上游
// title 可能含换行, 压成单行防止破坏 prompt 结构.
function buildDispatchedByBlock(dispatcher: { id: string; title: string }): string {
  const title = dispatcher.title.replace(/\s+/g, " ").trim();
  return `[dispatched by] 本任务由上游任务「${title}」派发（task_id=${dispatcher.id}）。如需回报进展或结论，引用该 task_id。\n\n`;
}

export function validateTaskLocation(
  projectId: unknown,
  versionId?: unknown
): { project_id: string; version_id: string | null } {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new TaskLocationError("PROJECT_REQUIRED", "project_id is required");
  }

  const project_id = projectId.trim();
  if (!getProjectById(project_id)) {
    throw new TaskLocationError("PROJECT_NOT_FOUND", `Project ${project_id} not found`);
  }

  if (versionId === undefined || versionId === null || versionId === "") {
    return { project_id, version_id: null };
  }
  if (typeof versionId !== "string") {
    throw new TaskLocationError("VERSION_NOT_FOUND", "version_id must be a string");
  }

  const version = getVersionById(versionId);
  if (!version) {
    throw new TaskLocationError("VERSION_NOT_FOUND", `Version ${versionId} not found`);
  }
  if (version.project_id !== project_id) {
    throw new TaskLocationError(
      "VERSION_PROJECT_MISMATCH",
      `Version ${versionId} does not belong to project ${project_id}`
    );
  }

  return { project_id, version_id: version.id };
}

// ---- Create ----

/**
 * 创建 task 并写库 (派发路径主入口).
 *
 * @requirement 飞书 R92
 * @feature task-dispatch
 * @module tasks
 * @see-exclusive src/lib/db/tasks.ts:343 getTaskById
 * @see-info scripts/ao-dispatch.sh
 */
export function createTask(def: TaskDefinition): Task {
  const location = validateTaskLocation(def.project_id, def.version_id);
  const db = getDb();
  const id = uuidv4();

  // cwd fallback chain: task > version > project > isolated workspace.
  // Lets "项目级其他任务" (version_id=NULL) inherit from project.cwd.
  const versionRow = location.version_id ? getVersionById(location.version_id) : null;
  const projectRow = getProjectById(location.project_id);
  const cwd = def.cwd || versionRow?.cwd || projectRow?.cwd || null;
  // T2: inherit owner_id from the owning project so list/get queries skip the
  // JOIN. The route layer has already gated that the caller owns this project.
  const ownerId = projectRow?.owner_id ?? null;

  // §9 v1: role inheritance. If role_id is given, read the role and use it as
  // defaults. Task-level fields (when supplied) override role defaults.
  // system_prompt is prepended to the user prompt so the agent sees role context
  // first, then the task-specific request.
  // T3: the role must belong to the same owner as the task (the project's
  // owner). A foreign role_id throws "not found" rather than silently borrowing
  // another user's role config.
  // Default fallback: if no role_id specified, use the user's "default" role
  // (created via /api/roles) so platform conventions (e.g. checkpoint output)
  // are applied to every task automatically.
  let role = def.role_id ? getRoleById(def.role_id, ownerId ?? undefined) : null;
  if (def.role_id && !role) {
    // v525 P2 (D2): 带 code 让 route 层映射 400 (裸 Error 会被当未知错误漏成 500).
    // 保留 "not found" 字样 (roles-scope.test.ts 断言 /not found/).
    throw new TaskLocationError(
      "ROLE_NOT_FOUND",
      `Role ${def.role_id} not found`
    );
  }
  // v525 (Role 场景化 P1): scope check. A project-scoped role only applies to
  // tasks of its own project; global roles (project_id NULL) work everywhere.
  // 显式 role_id 不匹配 → 硬错误 (不静默回落, route 层波 2 转 400);
  // default fallback 是 best-effort 增强, 不匹配就降级为无 role 并 warn,
  // 不让 default role 的项目绑定阻断无 role_id 的建任务。
  if (role && role.project_id !== null && role.project_id !== location.project_id) {
    throw new TaskLocationError(
      "ROLE_SCOPE_MISMATCH",
      `Role ${def.role_id} is scoped to project ${role.project_id}, cannot be used by a task in project ${location.project_id}`
    );
  }
  if (!role && ownerId) {
    role = getRoleByName("default", ownerId);
    if (role && role.project_id !== null && role.project_id !== location.project_id) {
      console.warn(
        `[tasks.create] default role scoped to project ${role.project_id}, ` +
        `task targets ${location.project_id}; skipping role inheritance`
      );
      role = null;
    }
  }

  const resolvedModel = def.model ?? role?.model ?? null;
  const resolvedTools = def.allowedTools
    ? stringifyStrArray(def.allowedTools)
    : role?.allowed_tools ?? null;
  const resolvedMaxTurns = def.maxTurns ?? role?.max_turns ?? null;
  // 平台规则: max_turns < 200 不抛错, 直接 console.warn 并 clamp 到 200。
  // 真要保留低值就 force_max_turns:true。仅供脚本/内部调用, 不进 /api/tasks 路由白名单。
  // 非整数仍 throw（malformed, 不是「太低」）。
  if (resolvedMaxTurns !== null
      && !Number.isInteger(resolvedMaxTurns)) {
    throw new Error(`invalid maxTurns: ${resolvedMaxTurns} (need integer or null)`);
  }
  if (resolvedMaxTurns !== null
      && resolvedMaxTurns < 200 && !def.force_max_turns) {
    console.warn(
      `[tasks.create] max_turns=${resolvedMaxTurns} < 200, clamping to 200 ` +
      `(pass force_max_turns:true to keep the original value)`
    );
  }
  const finalMaxTurns = resolvedMaxTurns !== null
    && resolvedMaxTurns < 200 && !def.force_max_turns
    ? 200
    : resolvedMaxTurns;
  const resolvedEffort = def.effort ?? (role?.effort as EffortLevel | null) ?? null;
  const resolvedAllowed = def.auto_approve === false ? 0 : 1;

  // Preflight: orchestrator runs pwd / git remote / git log server-side at
  // createTask time, stores the 4-line result in tasks.preflight_result, and
  // injects it at the top of the prompt. Replaces the v27 scheme where the
  // agent ran the commands itself - saves one Bash round per task. Stays in
  // tasks.prompt so resume/fork replay through the SDK does not re-send it
  // (only the first start sees it as a new user message; reject-resume /
  // pause-resume inject feedback instead). Per-user toggle (v27):
  // users.preflight_enabled = 0 skips the block to save 1 turn of token.
  const ownerForPreflight = ownerId ? getUserById(ownerId) : null;
  const preflightEnabled = ownerForPreflight ? ownerForPreflight.preflight_enabled !== 0 : true;
  const preflightResult = preflightEnabled ? runPreflight(cwd) : null;
  const preflight = preflightEnabled ? buildPreflightBlock(preflightResult!) : "";
  // v32: 派发方溯源. 引用只要求同 owner (跨项目派发合法: 子任务常落在别的仓库
  // 的 project). 找不到时两档处理 (damo 0826 拍, 撞同根第 3 次强制修):
  //   - 同 owner 查不到 + 不带 owner 查也查不到 → 上游 task 真不存在 (跨进程引用,
  //     sheetwatch / partner 派发链 / ORCHESTRATOR_TASK_ID 跨 instance 都撞过).
  //     warn + 降级为不注入 [dispatched by] block, 任务继续创建 — 派发链掉链不该
  //     阻塞新任务 (派发方溯源是诊断信号, 不是业务必需).
  //   - 同 owner 查不到 + 不带 owner 查到 → 上游存在但属另一个 owner, 仍然 throw
  //     DISPATCHER_NOT_FOUND (安全红线, 防越权派发溯源).
  // 注入位置在 preflight 之后, 保证 prompt 仍以 [preflight check] 开头.
  let dispatcher: Task | null = null;
  if (def.dispatched_by_task_id) {
    dispatcher = getTaskById(def.dispatched_by_task_id, ownerId ?? undefined);
    if (!dispatcher) {
      const anyOwner = getTaskById(def.dispatched_by_task_id);
      if (anyOwner) {
        throw new TaskLocationError(
          "DISPATCHER_NOT_FOUND",
          `Dispatcher task ${def.dispatched_by_task_id} not found`
        );
      }
      console.warn(
        `[dispatch] warn: dispatcher task ${def.dispatched_by_task_id} not found, ` +
        `falling back to no-dispatcher (派发链断裂, 撞同根第 3 次)`
      );
      dispatcher = null;
    }
  }
  const dispatchedBy = dispatcher ? buildDispatchedByBlock(dispatcher) : "";
  const rolePreamble = role?.system_prompt
    ? `[role: ${role.name}]\n${role.system_prompt}\n\n`
    : "";
  // idea-canvas P4: 挂了构思/节点的任务, 注入上下文 block (假设/判据/节点验收) —
  //   归属已在 route 层校验过, 这里直接读. 读失败降级不注入 (构思层数据不该阻塞派发).
  let ideaContext = "";
  if (def.idea_id || def.node_id) {
    try {
      const ideaRow = def.idea_id ? getIdea(def.idea_id, ownerId ?? "") : null;
      const nodeRow = def.node_id ? getIdeaNode(def.node_id, ownerId ?? "") : null;
      if (ideaRow || nodeRow) {
        const nodeForCtx = nodeRow ?? (ideaRow && def.idea_id ? null : null);
        ideaContext = buildIdeaContextBlock(
          ideaRow ?? { title: "(idea 已删)", hypothesis: null, success_criteria: null, status: "deleted", conclusion: null },
          nodeForCtx,
        );
      }
    } catch (e) {
      console.warn(`[tasks.create] idea context inject failed (降级不注入): ${e instanceof Error ? e.message : e}`);
    }
  }
  const resolvedPrompt = preflight + dispatchedBy + rolePreamble + ideaContext + def.prompt;

  // v64: requirement_id 关联需求点. 同 owner + status != 'closed' (新 spec 软删走 status).
  // 失败抛 TaskLocationError 走 route 已有 catch 分支 (复用 DISPATCHER_NOT_FOUND 模式).
  let resolvedRequirementId: string | null = null;
  if (def.requirement_id) {
    const req = getRequirementById(def.requirement_id, ownerId ?? "");
    if (!req) {
      throw new TaskLocationError(
        "REQUIREMENT_NOT_FOUND",
        `Requirement ${def.requirement_id} not found`
      );
    }
    if (req.status === "closed") {
      throw new TaskLocationError(
        "REQUIREMENT_CLOSED",
        `Requirement ${def.requirement_id} is closed`
      );
    }
    resolvedRequirementId = req.id;
  }

  // DAG P1 (2026-09-05): task_dependencies 写入前必须确认不形成环. 否则
  //   areDependenciesMet() 永远等不到 deps 变 completed, 调度死锁. 检查放
  //   在 INSERT 前, 撞环直接抛 TaskLocationError, DB 无脏行.
  if (def.dependsOn && def.dependsOn.length > 0) {
    const cycleDep = detectDependencyCycle(id, def.dependsOn);
    if (cycleDep !== null) {
      throw new TaskLocationError(
        "DEPENDENCY_CYCLE",
        `Dependency cycle detected via ${cycleDep}: adding [${def.dependsOn.join(",")}] as deps of ${id} would form a cycle`
      );
    }
  }

  // 波 2.5 (docs/plans/auto-complete-dag.md D7.1): auto_complete 硬限定 DAG 项目.
  //   非 DAG 项目跳过验收门的场景不存在 (常规项目保持人审), 违反 = 400 级配置错误,
  //   在 createTask 层拦 (防绕过 route 直调: schedule-runner / 内部 createTask 调用方).
  const resolvedAutoComplete = def.auto_complete === true ? 1 : 0;
  if (resolvedAutoComplete === 1 && !getProjectDagEnforced(location.project_id)) {
    throw new TaskLocationError(
      "AUTO_COMPLETE_REQUIRES_DAG",
      `auto_complete requires a DAG-enforced project (dag_enforced=1); project ${location.project_id} is not DAG-enforced`
    );
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, description, prompt, priority, cwd, auto_approve, model, allowed_tools, max_turns, effort, tags, depends_on, project_id, version_id, type, role_id, owner_id, schedule_id, preflight_result, dispatched_by_task_id, llm_config_id, requirement_id, value_significance, value_kind, idea_id, node_id, work_class, auto_complete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const dependsOn = def.dependsOn ? JSON.stringify(def.dependsOn) : null;

  stmt.run(
    id,
    def.title,
    def.description || null,
    resolvedPrompt,
    def.priority || 0,
    cwd,
    resolvedAllowed,
    resolvedModel,
    resolvedTools,
    finalMaxTurns,
    resolvedEffort,
    def.tags ? stringifyStrArray(def.tags) : null,
    dependsOn,
    location.project_id,
    location.version_id,
    def.type ?? null,
    role?.id ?? null,
    ownerId,
    def.schedule_id ?? null,
    preflightResult,
    dispatcher?.id ?? null,
    def.llm_config_id ?? null,
    resolvedRequirementId,
    // v132 (D10): 前置门字段. 缺省 NULL = 未填 (UI 角标 ⚠). 不在 createTask
    //   入口硬校验, API/CLI 层负责 warn + 反思引导 (见 §18.4).
    def.value_significance ?? null,
    def.value_kind ?? null,
    // idea-canvas P0 (v521): 构思层弱引用 + 工作类别. 归属校验在 API 层, 这里只落库.
    def.idea_id ?? null,
    def.node_id ?? null,
    def.work_class ?? null,
    // 波 2.5 (v528): DAG 校验已在 INSERT 前完成, 这里只落库 (0/1).
    resolvedAutoComplete
  );

  // Insert dependency relationships. 环检测已在 INSERT 前完成 (上面 DAG P1
  //   那块), 此处只管写入 + INSERT OR IGNORE 处理重复 depId.
  if (def.dependsOn && def.dependsOn.length > 0) {
    const depStmt = db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
    for (const depId of def.dependsOn) {
      depStmt.run(id, depId);
    }
  }

  return getTaskById(id)!;
}

// ---- Read ----

// userId is optional: API routes pass it to enforce ownership (non-owner gets
// null -> 404); internal/runtime callers omit it for an unfiltered read.
// includeDeleted: when true, return tasks even if deleted_at is set.
export function getTaskById(id: string, userId?: string, options?: { includeDeleted?: boolean }): Task | null {
  const db = getDb();
  const includeDeleted = options?.includeDeleted;
  // LEFT JOIN projects/versions 取真名给前端 TaskHeader breadcrumb + tab 标题用.
  // 别名带 task__ 前缀防与 tasks 列冲突 (虽然现在没冲突, 加一层更稳).
  let sql = `
    SELECT tasks.*,
           p.name AS project_name,
           v.name AS version_name
    FROM tasks
    LEFT JOIN projects p ON p.id = tasks.project_id
    LEFT JOIN versions v ON v.id = tasks.version_id
    WHERE tasks.id = ?
  `;
  const params: unknown[] = [id];
  if (userId) {
    sql += " AND tasks.owner_id = ?";
    params.push(userId);
  }
  if (!includeDeleted) {
    sql += " AND tasks.deleted_at IS NULL";
  }
  const stmt = db.prepare(sql);
  return (stmt.get(...params) as Task) || null;
}

// 功能: 用短ID前缀查询任务, 返回匹配列表(最多100条). 用于 URL/API 短ID解析.
// 关注点: prefix 经正则校验只允许 hex 字符, 防 SQL 注入; 不含 deleted 任务.
export function getTasksByShortId(prefix: string, userId?: string): Task[] {
  const db = getDb();
  let sql = "SELECT * FROM tasks WHERE id LIKE ? ESCAPE '\\' AND deleted_at IS NULL";
  const params: unknown[] = [prefix + "%"];
  if (userId) {
    sql += " AND owner_id = ?";
    params.push(userId);
  }
  sql += " LIMIT 100";
  const stmt = db.prepare(sql);
  return stmt.all(...params) as Task[];
}

/** Find the parent task of a fork by looking up which task owns the session this task forked from. */
export function getParentTask(forkedFromSessionId: string): { id: string; title: string; status: string } | null {
  const db = getDb();
  const stmt = db.prepare("SELECT id, title, status FROM tasks WHERE session_id = ?");
  return (stmt.get(forkedFromSessionId) as { id: string; title: string; status: string } | null) || null;
}

// 功能: 列出由 taskId 派发出来的下游 task (v32 dispatched_by_task_id 反向查).
// 关注点: 下游可能落在别的 project, 所以不按 project 过滤; userId 可选 (API 层
// 传入做归属收窄, 内部调用可省). 软删除的下游不返回.
export function getDispatchedTasks(
  taskId: string,
  userId?: string
): Array<{ id: string; title: string; status: string; project_id: string | null }> {
  const db = getDb();
  let sql =
    "SELECT id, title, status, project_id FROM tasks WHERE dispatched_by_task_id = ? AND deleted_at IS NULL";
  const params: unknown[] = [taskId];
  if (userId) {
    sql += " AND owner_id = ?";
    params.push(userId);
  }
  sql += " ORDER BY created_at ASC";
  return db.prepare(sql).all(...params) as Array<{
    id: string;
    title: string;
    status: string;
    project_id: string | null;
  }>;
}

// 终态 = 这一次执行已经了结, 定时任务可以再派下一次。
// 刻意把 reviewing / paused / rejected / await_user 排除在终态之外: 它们都是「还在飞,
// 只是在等人」, 把它们当完成就会每个周期重派同一件事（v2-p0-loop 事故: 5 天 604 个
// 任务 / $206）. 🆕 R131 (damo 2026-09-15) 加 await_user.
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

// 功能: 取该 schedule 派出的、最近一个「还没走完」的 task（没有则 null）。
// 关注点: 这是防重派闸门的判据, 覆盖两种来源 —— runner 自己 fireAgent 建的（带
//   schedule_id）+ shell 脚本走 POST /api/tasks 自建并显式传 schedule_id 的。
//   口径比「running」宽（见 TERMINAL_TASK_STATUSES）；软删除的不算在飞, 所以清掉
//   僵尸任务能直接解开被卡住的 schedule。
export function getUnfinishedTaskBySchedule(scheduleId: string): Task | null {
  const placeholders = TERMINAL_TASK_STATUSES.map(() => "?").join(", ");
  return (
    (getDb()
      .prepare(
        `SELECT * FROM tasks WHERE schedule_id = ? AND deleted_at IS NULL
           AND status NOT IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(scheduleId, ...TERMINAL_TASK_STATUSES) as Task) || null
  );
}

// 功能: C 逻辑 —— 查「status=reviewing + 由 schedule 派出 + updated_at 早于 (now - staleMs)」
//   的 task, 一次性 join 出 schedule 和 owner 信息, 给 ScheduleRunner 通知 damo 用。
// 关注点: ① 用 SQL 端 (julianday 差值 × 86400000) 算 idle 毫秒, 避免 JS 端字符串解析/时区坑;
//   ② 一次 SQL 拿齐三方信息, 避免 N+1; ③ owner 没拿到返 null, 调用方降级 console 而非抛错;
//   ④ deleted_at IS NULL 过滤软删任务; ⑤ LIMIT 200 防极端情况雪崩。
export interface StaleReviewingRow {
  task: { id: string; title: string; updated_at: string };
  schedule: { id: string; name: string; schedule_expr: string };
  owner: {
    id: string;
    feishu_webhook_url: string | null;
    notify_email: string | null;
  } | null;
}

export function getStaleReviewingScheduledTasks(
  staleMs: number
): StaleReviewingRow[] {
  // idle 毫秒 = (now - updated_at) × 86400000; staleMs 是 number, 用参数绑定防注入。
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         t.id              AS task_id,
         t.title           AS task_title,
         t.updated_at      AS task_updated_at,
         s.id              AS schedule_id,
         s.name            AS schedule_name,
         s.schedule_expr   AS schedule_expr,
         t.owner_id        AS owner_id,
         u.feishu_webhook_url AS owner_webhook,
         u.notify_email    AS owner_email
       FROM tasks t
       JOIN schedules s ON s.id = t.schedule_id
       LEFT JOIN users u ON u.id = t.owner_id
       WHERE t.status = 'reviewing'
         AND t.deleted_at IS NULL
         AND t.schedule_id IS NOT NULL
         AND (julianday('now') - julianday(t.updated_at)) * 86400000 > ?
       ORDER BY t.updated_at ASC
       LIMIT 200`
    )
    .all(staleMs) as Array<{
      task_id: string;
      task_title: string;
      task_updated_at: string;
      schedule_id: string;
      schedule_name: string;
      schedule_expr: string;
      owner_id: string | null;
      owner_webhook: string | null;
      owner_email: string | null;
    }>;
  return rows.map((r) => ({
    task: { id: r.task_id, title: r.task_title, updated_at: r.task_updated_at },
    schedule: { id: r.schedule_id, name: r.schedule_name, schedule_expr: r.schedule_expr },
    owner: r.owner_id
      ? { id: r.owner_id, feishu_webhook_url: r.owner_webhook, notify_email: r.owner_email }
      : null,
  }));
}

export function listTasks(filter?: {
  status?: TaskStatus;
  limit?: number;
  offset?: number;
  project_id?: string;
  version_id?: string;
  unversioned?: boolean;
  ownerId?: string;
  includeDeleted?: boolean;
  // v57 (R15 task 收藏): true → 只返回当前用户收藏的 task. ownerId 必传才能
  // 判定 (user_favorites 没 ownerId 走不出语义); 无 ownerId 时静默忽略 favorite,
  // 保持向后兼容 admin/跨用户查询场景.
  favorite?: boolean;
  // 飞书 R180: 顶栏全局任务搜索 — 关键词 LIKE 匹配 id / title / status / tags
  // (tags 存 JSON 文本, 子串命中即算). 空串/纯空白 = 不过滤.
  search?: string;
}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  // 所有条件列都带 tasks. 前缀: search 场景会 LEFT JOIN projects/versions,
  // 这两张表也有 id/created_at/owner_id 等列, 不限定则 "ambiguous column name".
  // Default: exclude soft-deleted tasks
  if (!filter?.includeDeleted) {
    conditions.push("tasks.deleted_at IS NULL");
  }
  if (filter?.ownerId) {
    conditions.push("tasks.owner_id = ?");
    params.push(filter.ownerId);
  }
  if (filter?.status) {
    conditions.push("tasks.status = ?");
    params.push(filter.status);
  }
  if (filter?.project_id) {
    conditions.push("tasks.project_id = ?");
    params.push(filter.project_id);
  }
  if (filter?.unversioned) {
    if (!filter.project_id) {
      throw new Error("project_id is required for unversioned task queries");
    }
    conditions.push("tasks.version_id IS NULL");
  } else if (filter?.version_id) {
    conditions.push("tasks.version_id = ?");
    params.push(filter.version_id);
  }
  if (filter?.favorite && filter.ownerId) {
    // EXISTS 子查询命中 idx_fav_user, 短路语义等价 INNER JOIN.
    conditions.push(
      "EXISTS (SELECT 1 FROM user_favorites WHERE user_id = ? AND task_id = tasks.id)"
    );
    params.push(filter.ownerId);
  }
  // 飞书 R180: 关键词搜索 — ESCAPE '\' 让用户输入里的 %/_ 当字面量, 不被当通配符.
  if (filter?.search && filter.search.trim()) {
    const kw = `%${filter.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      "(tasks.id LIKE ? ESCAPE '\\' OR tasks.title LIKE ? ESCAPE '\\' OR tasks.status LIKE ? ESCAPE '\\' OR tasks.tags LIKE ? ESCAPE '\\')"
    );
    params.push(kw, kw, kw, kw);
  }

  // 飞书 R209: 顶栏搜索下拉要展示任务所属项目/版本名, 只在 search 场景 LEFT JOIN
  // projects/versions 取真名 (与 getTaskById 同款别名). 其它调用点保持 SELECT *
  // 原样 — 不增 payload / 不多一次 JOIN.
  const searching = !!(filter?.search && filter.search.trim());
  let sql = searching
    ? `SELECT tasks.*, p.name AS project_name, v.name AS version_name
       FROM tasks
       LEFT JOIN projects p ON p.id = tasks.project_id
       LEFT JOIN versions v ON v.id = tasks.version_id`
    : "SELECT * FROM tasks";
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY tasks.updated_at DESC, tasks.created_at DESC";

  if (filter?.limit) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  if (filter?.offset) {
    sql += " OFFSET ?";
    params.push(filter.offset);
  }

  const stmt = db.prepare(sql);
  return stmt.all(...params) as Task[];
}

// ---- Paged list (status-aware, trimmed payload) ----
//
// 看板专用: 把 status 按"active / terminal"分组, 用精简投影 + 信封返回, 让 RSC
// payload 从 MB 级降到 KB 级。active (pending/queued/running/paused/reviewing)
// 通常 <20 行, 永远全量 + SSE realtime; terminal (completed/failed/rejected/
// cancelled) 才是 300+ 堆积源, 走分页 + 客户端虚拟滚动。
//
// 与 listTasks 共存, 不替换: agent-runtime.ts 的 recoverOrphanedTasks 等需要
// 全字段 (session_id, forked_from_session_id, metadata) 的调用点仍用 listTasks。
//
// 关于 prompt_preview = SUBSTR(prompt, -150): DB 里 prompt 已含 preflight /
// dispatchedBy / role preamble 增强块(tasks.ts:235), 头部 300+ 字符是系统噪音;
// 取末尾 150 字符才能拿到用户实际诉求。客户端 .slice(0, 100) / .includes() 搜
// 索时不会误命中 preflight 文本。详见 plan: glimmering-wibbling-teacup.md。
export type StatusGroup = "active" | "terminal" | "all";

// 用户实际盯着的「在飞」状态集合。paused/reviewing/verifying 包含在内 — 它们都是
// "还在等 人/系统/机械验收", 不是终态.
// ⚠️ 与 src/lib/constants.ts 的 BOARD_ACTIVE_STATUSES 是同一份. UI 端不能 import
// 此文件 (会拉 better-sqlite3 等 Node-only 模块), 所以常量在两处各存一份.
// 任一处改动必须连带改另一处.
//   🆕 DAG P3: verifying 加入 — 机械验收门跑命令的瞬态 (B4 拍板 2026-09-05).
//   🆕 R131 (damo 2026-09-15): await_user 加入 — 等用户介入/拍板/派发/建议.
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "pending", "queued", "running", "paused", "reviewing", "verifying", "await_user",
];

// 终态集合. 与 TERMINAL_TASK_STATUSES (上方:349) 区分: 那边是 schedule 防重派
// 闸门用, 把 rejected 排除(rejected 可重启). 这边是看板分流, rejected 就是用户
// 看到的终态之一, 跟 completed/failed/cancelled 平起平坐.
// ⚠️ 同步 src/lib/constants.ts 的 BOARD_TERMINAL_STATUSES.
export const PAGE_TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed", "failed", "rejected", "cancelled",
];

// 功能: /api/tasks/page 的筛选条件集. listTasksPage (取行) 与
// listTasksPageFingerprint (取变更指纹) 共用同一份 — R165 起 ETag 走条件拉取,
// 两边条件若各写一份必然漂移 (指纹说"没变"但行集变了 = 静默脏数据).
export interface TasksPageFilter {
  statusGroup: StatusGroup;
  project_id?: string;
  version_id?: string;
  unversioned?: boolean;
  ownerId: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
  // v57 (R15 task 收藏): true → 只返回当前用户收藏的 task. ownerId 必传 (类型已约束).
  favorite?: boolean;
  // R114 (后台搜索): 非空时, 服务端 LIKE 搜索 title/description/prompt (大小写不敏感).
  // 空串/纯空白 = 不加搜索条件 (与原路径兼容). 与客户端 matchesTaskSearch 协同:
  // q 命中时服务端已收窄, 客户端 useMemo 过滤变为 no-op (结果一致, 双层冗余无害).
  q?: string;
  // R114 第二轮 (筛选全走后端): 服务端 model 精确匹配 (用 tasks.model, 不是
  // resolved_model — 与前端 filterPredicate t.model 对齐).
  model?: string;
  // R114 第二轮: 服务端 tag 精确匹配 (tags 是 JSON 数组, 用 LIKE '%"<tag>"%' 命中).
  // 与前端 filterPredicate JSON.parse + includes 语义一致.
  tag?: string;
  // 飞书 AO-DEV R236 (damo): 精确状态集 — 非空时**在 statusGroup 段内收窄**
  // (AND 语义, 与分组条件叠加). 场景: 全局看板把「活跃/历史」segmented 改成
  // 状态 chip 宏后, 用户可跨组混选 (如 running + completed) — 前端对混选拉两段
  // (active 段 + terminal 段), 每段服务端用 AND 收到自己组内的选中状态, 两段
  // 天然不相交, 拼接不重不漏. 若做成「优先于 statusGroup」会让两段返回同一份
  // 混合行集 (实测 13001 每条任务渲染两次 + total 翻倍), 已废弃该语义.
  // 调用方 (API route) 负责校验合法状态值 + 去重, 这里只管翻 SQL.
  // ETag 无需额外处理: 指纹由同 WHERE 的 statusRows (GROUP BY status) 派生,
  // 不同选择集 → 不同 counts/total → 指纹天然不同 (同 URL 缓存键下不会假 304).
  statuses?: TaskStatus[];
}

// 功能: 把 filter 翻成 WHERE 子句 + 位置绑定参数. 抽出来是为了 listTasksPage 与
// listTasksPageFingerprint 复用同一套条件.
// 关注点: params.push 的顺序必须与 conditions.push 的顺序严格一致 (SQLite 位置
// 绑定, 错位不报错只会静默查错行). unversioned 与 version_id 互斥 (else if).
function buildTasksPageWhere(filter: TasksPageFilter): {
  whereClause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // statusGroup → IN 子句. "all" 不加 status 条件 (全状态).
  // R94: 全部用 `tasks.` 前缀 — 加上 LEFT JOIN requirements 后, status/owner_id 等列
  //   在两边都存在, 不加前缀会触发 "ambiguous column name" 错误.
  // R236: statuses 精确状态集为**独立 AND 条件** (在 statusGroup 段内收窄),
  //   不抢占分组分支 — 跨组混选时前端拉两段, 每段 AND 出自己组内的选中子集.
  if (filter.statusGroup === "active") {
    conditions.push(`tasks.status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`);
    params.push(...ACTIVE_STATUSES);
  } else if (filter.statusGroup === "terminal") {
    conditions.push(`tasks.status IN (${PAGE_TERMINAL_STATUSES.map(() => "?").join(", ")})`);
    params.push(...PAGE_TERMINAL_STATUSES);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    // 历史 rejected 显示兼容 (2026-09-15 决策, review-state-machine-refactor.md):
    // rejected 已废弃不再写入, 读路径统一视作 cancelled — 选 cancelled 带出
    // rejected 行, 传 rejected (stale URL) 也归到 cancelled 桶.
    const expanded = new Set(filter.statuses);
    if (expanded.has("cancelled") || expanded.has("rejected")) {
      expanded.add("cancelled");
      expanded.add("rejected");
    }
    const list = Array.from(expanded);
    conditions.push(`tasks.status IN (${list.map(() => "?").join(", ")})`);
    params.push(...list);
  }

  if (!filter.includeDeleted) {
    conditions.push("tasks.deleted_at IS NULL");
  }
  if (filter.ownerId) {
    conditions.push("tasks.owner_id = ?");
    params.push(filter.ownerId);
  }
  if (filter.project_id) {
    conditions.push("tasks.project_id = ?");
    params.push(filter.project_id);
  }
  if (filter.unversioned) {
    if (!filter.project_id) {
      throw new Error("project_id is required for unversioned task queries");
    }
    conditions.push("tasks.version_id IS NULL");
  } else if (filter.version_id) {
    conditions.push("tasks.version_id = ?");
    params.push(filter.version_id);
  }
  if (filter.favorite) {
    // listTasksPage 强制 ownerId, 这里无需再判.
    conditions.push(
      "EXISTS (SELECT 1 FROM user_favorites WHERE user_id = ? AND task_id = tasks.id)"
    );
    params.push(filter.ownerId);
  }

  // R114 (后台搜索): 服务端 q → LIKE 匹配 title / description / prompt (大小写不敏感).
  // LOWER() 两边归一处理 SQLite 默认 LIKE 仅 ASCII 不敏感的盲区 (中文/非 ASCII 也能命中).
  // 参数化查询 + LIKE 通配符由调用方在 API 层包装, 此处只接 raw query, 安全无注入风险.
  // 与现有 listTasks 的 title LIKE 用法保持一致 (idx_tasks_owner_status 仍走, prompt 走全表扫描 — 接受).
  //
  // R58.5: 同时匹配 tasks.id — 用户在 GlobalBoard 搜 task UUID 前缀时也能命中
  // (前端 placeholder 已宣称「ID...」, 但实现只搜 title/desc/prompt = 误导 + 搜不到).
  // UUID LIKE 走全表扫描, 但已经有 owner_id + status 索引收敛范围, 可接受.
  const qTrimmed = filter.q?.trim();
  if (qTrimmed) {
    const like = `%${qTrimmed.toLowerCase()}%`;
    conditions.push(
      "(LOWER(tasks.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(tasks.description, '')) LIKE ? ESCAPE '\\' OR LOWER(tasks.prompt) LIKE ? ESCAPE '\\' OR LOWER(tasks.id) LIKE ? ESCAPE '\\')"
    );
    params.push(like, like, like, like);
  }

  // R114 第二轮 (筛选全走后端): model + tag 精确匹配.
  // model: 直接 = 匹配 (用 tasks.model, 不动 resolved_model, 与前端 filterPredicate t.model 对齐).
  // tag: tasks.tags 是 JSON 字符串 `["tag1","tag2"]`, 用 LIKE '%"<tag>"%' 命中;
  //   tag 含引号/反斜杠的边角由前端 select 不允许输入自由文本规避 (前端 selectedTag
  //   来自预置 tag 列表 + 拖拽, 不接受用户键入). 走参数化绑定无注入风险.
  if (filter.model && filter.model.trim()) {
    conditions.push("tasks.model = ?");
    params.push(filter.model);
  }
  if (filter.tag && filter.tag.trim()) {
    conditions.push("tasks.tags LIKE ? ESCAPE '\\'");
    params.push(`%"${filter.tag}"%`);
  }

  const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
  return { whereClause, params };
}

// 功能: R182 — 同 WHERE 下的 per-status 计数 (GROUP BY status). 给看板状态
// chip 显示计数用 (如「失败 55」), 解决 terminal 段 completed 淹没 failed、
// 用户以为"错误状态的任务少了"的可发现性问题.
// 关注点: 与 listTasksPage / fingerprint 共用 buildTasksPageWhere 同一份 WHERE,
// 条件漂移 = 计数与行集不一致.
export type TaskStatusCounts = Record<string, number>;

// 功能: 跑一次 GROUP BY status 计数, 返回原始行. 压测实证 (2026-10-08):
// /api/tasks/page 单次请求会经 fingerprint 与 listTasksPage 各跑一遍同款
// GROUP BY, terminal 段 ~4800 行扫两遍纯属浪费 —— 调用方先跑本函数一次,
// 把结果同时传给两个函数即可 (传了就不再重跑, 不传保持各自自查的旧行为).
export function runTasksPageStatusRows(
  filter: TasksPageFilter
): Array<{ status: string; n: number }> {
  const db = getDb();
  const { whereClause, params } = buildTasksPageWhere(filter);
  return db
    .prepare(
      `SELECT tasks.status AS status, COUNT(*) AS n FROM tasks${whereClause} GROUP BY tasks.status`
    )
    .all(...params) as Array<{ status: string; n: number }>;
}

export function listTasksPageStatusCounts(
  filter: TasksPageFilter,
  statusRows?: Array<{ status: string; n: number }>
): TaskStatusCounts {
  const rows = statusRows ?? runTasksPageStatusRows(filter);
  const counts: TaskStatusCounts = {};
  for (const r of rows) {
    // 历史 rejected 显示兼容: 计数并进 cancelled, 与行集 CASE 映射同口径 —
    // chip 行不再出现「等待中 3」这类幽灵计数 (damo 2026-11-01 反馈).
    if (r.status === "rejected") {
      counts["cancelled"] = (counts["cancelled"] ?? 0) + r.n;
      continue;
    }
    counts[r.status] = r.n;
  }
  return counts;
}

// 功能: 看板分页的精简投影 + 分页信封. R165 拆出 where 构造后, 指纹函数
// (listTasksPageFingerprint) 与它共用同一份条件.
// 关注点: items 是 TaskTrimmed 26 字段投影, 不含 prompt/result/error 全文;
// limit/offset 只影响取哪几行, 不影响 total (COUNT 不带 LIMIT).
// R182: 返回体加 statusCounts (同 WHERE GROUP BY status), 供前端 chip 计数.
export function listTasksPage(
  filter: TasksPageFilter,
  statusRows?: Array<{ status: string; n: number }>
): { items: TaskTrimmed[]; total: number; hasMore: boolean; statusCounts: TaskStatusCounts } {
  const db = getDb();
  const { whereClause, params } = buildTasksPageWhere(filter);

  // COUNT — 同 WHERE, 走 v49 复合索引 (owner_id, status, updated_at, created_at).
  // COUNT 不走 JOIN: 任务总数语义不应被 LEFT JOIN 影响 (1 task 关联 1 req = 仍是 1 行,
  //   但显式不 JOIN 是最安全的, 与现有 listTasksCount 行为一致).
  const countSql = `SELECT COUNT(*) as total FROM tasks${whereClause}`;
  const total = (db.prepare(countSql).get(...params) as { total: number }).total;

  // PAGE — 精简投影, 剔除 prompt/result/error/metadata 全文, 替换为 preview.
  // ORDER BY 与 listTasks 一致: updated_at DESC, created_at DESC. SQLite 复合
  // 索引天然支持倒序扫描(反向遍历索引), LIMIT 提前终止, 不需要 DESC 关键字.
  //
  // R94: LEFT JOIN requirements 取关联需求 status, 用于任务列表/看板 chip 展示.
  //   JOIN 条件带 owner_id (防止越权 + 同口径多租户隔离). requirement_id 为 NULL 或
  //   需求已软删 / 跨 owner 时, req.status 自动 NULL → 前端不渲染 chip.
  //   COUNT 不走 JOIN (与现有 listTasksCount 语义一致 — 任务总数 ≠ 需求数).
  //
  // R109: LEFT JOIN checkpoints latest_cp 取"最新有状态的 cp" status, 用于 task 卡片
  //   sub-status chip (4 色: 等回复/有建议/需拍板/卡住). 子查询 MAX(rowid) + status
  //   IS NOT NULL → 跳过老 marker 形态 (status=NULL) 的 cp. inner subquery 走
  //   idx_checkpoints_task 命中快; 单 task 关联 cp 通常 <20 行. COUNT 不走 cp JOIN
  //   (同 requirement JOIN 口径, 任务总数 ≠ checkpoint 数).
  //
  // 历史 rejected 显示兼容 (2026-09-15 review-state-machine-refactor 决策):
  //   rejected 已废弃不再写入, 行集 CASE 映射到 cancelled 返回 (types.ts「历史
  //   rejected 数据保留显示兼容, 不删」的落地 — 原设想前端映射, SPA 一直没做,
  //   3 条遗留行被标成「等待中」成为幽灵计数; 2026-11-01 改在读路径统一映射,
  //   所有看板/列表/chip 计数自动一致. WHERE 仍用原始 status 匹配 DB 真值).
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const pageSql = `
    SELECT
      tasks.id, tasks.title, tasks.description,
      COALESCE(SUBSTR(tasks.prompt, -150), '') AS prompt_preview,
      COALESCE(SUBSTR(tasks.result, 1, 150), '') AS result_preview,
      COALESCE(SUBSTR(tasks.error, 1, 200), '') AS error_preview,
      CASE WHEN tasks.status = 'rejected' THEN 'cancelled' ELSE tasks.status END AS status,
      tasks.priority, tasks.type, tasks.model, tasks.resolved_model,
      tasks.llm_config_id, tasks.resolved_config_id, tasks.tags,
      tasks.project_id, tasks.version_id, tasks.owner_id, tasks.deleted_at,
      tasks.cost_usd, tasks.updated_at,
      tasks.auto_approve, tasks.context_tokens, tasks.context_max,
      tasks.awaiting_owner_review, tasks.awaiting_markers, tasks.dispatched_by_task_id,
      tasks.schedule_id,
      tasks.awaiting_reason,
      tasks.queued_order,
      tasks.queued_reason,
      req.status AS requirement_status,
      latest_cp.status AS latest_checkpoint_status
    FROM tasks
    LEFT JOIN requirements req
      ON req.id = tasks.requirement_id
     AND req.owner_id = tasks.owner_id
    LEFT JOIN checkpoints latest_cp
      ON latest_cp.rowid = (
        SELECT MAX(cp2.rowid) FROM checkpoints cp2
        WHERE cp2.task_id = tasks.id
          AND cp2.status IS NOT NULL
      )
    ${whereClause}
    ORDER BY tasks.updated_at DESC, tasks.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const items = db.prepare(pageSql).all(...params, limit, offset) as TaskTrimmed[];

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    statusCounts: listTasksPageStatusCounts(filter, statusRows),
  };
}

// 功能: 指纹的进程启动盐. 每次模块加载随机一次, 进程重启必换 → 老 ETag 必失效.
// 关注点: 仅活在进程内, 不落库; 重启后客户端手里那批 ETag 自然作废 (安全方向).
const FINGERPRINT_BOOT = Math.random().toString(36).slice(2, 10);

// 功能: 看板列表的"变更指纹" — 给 R165 条件拉取 (If-None-Match / ETag) 用.
// 客户端带着上次的 ETag 回来, 指纹没变就 304 空响应, 省掉整页 hydrate.
//
// 组成 4 段, 缺一不可 (每段堵一个具体的漏检):
//   boot  — 进程启动随机串. 服务端重启后 total_changes 会归零, 没有它就可能
//           "重启 + 计数撞车 + 行集没变" = 假 304, 客户端永远看不到新数据.
//   tc    — SQLite total_changes() (本连接累计受影响行数). 看板卡片除了
//           tasks 本身, 还渲染 requirement_status (requirements 表) 与
//           latest_checkpoint_status (checkpoints 表), 这两张表被写时
//           tasks.updated_at 不动, 单靠 MAX(updated_at) 必漏. 用全局写计数兜.
//   total — 该筛选下的行数 (走与 listTasksPage 同一份 WHERE).
//   maxup — 该筛选下 MAX(tasks.updated_at).
//
// 为什么可以接受"粗": ⚠️ MAX(updated_at) 是**秒级**精度, 同一秒内的两次写入
//   (如 agent 连续两条 checkpoint) 指纹不变 —— 这不是理论风险, 单测实测复现.
//   所以指纹以 tc 为主判据. 代价 = 别的项目在跑任务时我这边也会重拉 (多拉,
//   不错拉), 而省下来的本来就是**网络 payload**(50 行 × 26 字段 JSON), 不是
//   DB CPU —— 少一次 hydrate 的收益远大于多一次空探针的成本. 方向刻意选成
//   "宁可多拉, 不可漏拉": 假阴性 = 用户看到脏数据且无报错, 假阳性 = 浪费一次请求.
export function listTasksPageFingerprint(
  filter: TasksPageFilter,
  statusRows?: Array<{ status: string; n: number }>
): string {
  const db = getDb();
  const { whereClause, params } = buildTasksPageWhere(filter);

  // R182: 单次 GROUP BY 同时给 total + per-status 计数 (省一次 COUNT).
  // counts 进指纹串 — 否则状态迁移 (如 running→failed) 时 tc 未变但计数变了,
  // 客户端会拿到假 304, chip 计数 stale.
  // 调用方已跑过 runTasksPageStatusRows 时直接复用 (压测实证同请求扫两遍浪费).
  const rows = statusRows ?? runTasksPageStatusRows(filter);
  let total = 0;
  const counts: string[] = [];
  for (const r of rows) {
    total += r.n;
    counts.push(`${r.status}:${r.n}`);
  }
  counts.sort();
  const maxUpdated = db
    .prepare(
      `SELECT COALESCE(MAX(tasks.updated_at), '') AS max_updated FROM tasks${whereClause}`
    )
    .get(...params) as { max_updated: string };
  const tc = (db.prepare(`SELECT total_changes() AS tc`).get() as { tc: number }).tc;

  // ⚠️ 必须消灭所有空白: SQLite 的 datetime 格式是 "2026-09-29 08:11:36" (中间一个
  //   空格), 直接拼进 entity-tag 就违反 RFC 9110 —— 浏览器 / 代理 / curl 回传
  //   If-None-Match 时会把它截断, 条件拉取永远命中不了 (e2e 实测踩过: 带 INM
  //   仍然回 200). 空格统一压成 'T' (ISO 风格), 顺带保证整个 ETag 无空白.
  const stamp = String(maxUpdated.max_updated).replace(/\s+/g, 'T');
  // 弱校验 W/ 前缀: 指纹是派生值不是内容哈希, 允许代理/浏览器做弱比较.
  return `W/"${FINGERPRINT_BOOT}-${tc}-${total}-${counts.join('.')}-${stamp}"`;
}

// ---- Update ----

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  extra?: {
    session_id?: string;
    result?: string | null;
    error?: string | null;
    cost_usd?: number;
    started_at?: string;
    completed_at?: string | null;
    head_commit?: string;
    forked_from_session_id?: string;
    context_tokens?: number | null;
    context_max?: number | null;
    awaiting_owner_review?: number; // v56: running→reviewing 时由 active-session marker 检测写入 1, 后续由 unset API 改回 0
    awaiting_markers?: string | null; // v61+R39: JSON 数组 (来自 <awaiting type="..."/> 多 marker). null = 不动, 显式 undefined = 不传 = 不写
    awaiting_reason?: string | null; // v129 (R112 续): reviewing 子终态标签. null = 清空 (改回 reviewing 无子状态), undefined = 不动
  }
): Task | null {
  const db = getDb();

  const sets: string[] = ["status = ?", "updated_at = datetime('now')"];
  const params: unknown[] = [status];

  if (extra?.session_id !== undefined) {
    sets.push("session_id = ?");
    params.push(extra.session_id);
  }
  if (extra?.result !== undefined) {
    sets.push("result = ?");
    params.push(extra.result);
  }
  if (extra?.error !== undefined) {
    sets.push("error = ?");
    params.push(extra.error);
  }
  if (extra?.cost_usd !== undefined) {
    sets.push("cost_usd = ?");
    params.push(extra.cost_usd);
  }
  if (extra?.started_at !== undefined) {
    sets.push("started_at = ?");
    params.push(extra.started_at);
  }
  if (extra?.completed_at !== undefined) {
    sets.push("completed_at = ?");
    params.push(extra.completed_at);
  }
  if (extra?.head_commit !== undefined) {
    sets.push("head_commit = ?");
    params.push(extra.head_commit);
  }
  if (extra?.forked_from_session_id !== undefined) {
    sets.push("forked_from_session_id = ?");
    params.push(extra.forked_from_session_id);
  }
  if (extra?.context_tokens !== undefined) {
    sets.push("context_tokens = ?");
    params.push(extra.context_tokens);
  }
  if (extra?.context_max !== undefined) {
    sets.push("context_max = ?");
    params.push(extra.context_max);
  }
  if (extra?.awaiting_owner_review !== undefined) {
    // v56: 同 status 一起写入, marker 检测到 awaiting_review 后跟 reviewing 同事务落库,
    // 避免「先 reviewing → 再 marker 检测 → 再 UPDATE」的窗口里 damo 拍板漏看。
    sets.push("awaiting_owner_review = ?");
    params.push(extra.awaiting_owner_review);
  }
  if (extra?.awaiting_markers !== undefined) {
    // v61+R39: markers JSON 数组, 同 status 一起落库. null = 显式清空 (覆盖旧值),
    //   不传 = undefined = 跳过不动. 调用方决定「重置 markers」还是「不动 markers」.
    sets.push("awaiting_markers = ?");
    params.push(extra.awaiting_markers);
  }
  if (extra?.awaiting_reason !== undefined) {
    // v129 (R112 续): reviewing 子终态标签. null = 显式清空 (覆盖旧值), 不传 = 跳过不动.
    //   与 awaiting_markers 同一口径 — 调用方决定「重置 reason」还是「不动 reason」.
    sets.push("awaiting_reason = ?");
    params.push(extra.awaiting_reason);
  }
  if (status !== "queued") {
    // v531 续不变量: queued_reason 只在 status='queued' 时有意义
    //   (openbot-waiting-visibility plan 决策 C). 任何离开 queued 的翻转
    //   (running/paused/completed/cancelled/…) 顺带清空 —— cancel / 手动改
    //   状态等「调度器 dequeue 之外的旁路」不再残留陈旧原因, 不依赖下一轮
    //   schedule 的 diff 兜底. 同一条 UPDATE 内完成, 不增加写次数.
    sets.push("queued_reason = NULL");
  }

  params.push(id);

  const stmt = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...params);

  return getTaskById(id);
}

export function updateTask(id: string, updates: Partial<{
  title: string;
  description: string;
  prompt: string;
  priority: number;
  cwd: string;
  model: string;
  resolved_model: string | null;
  llm_config_id: string | null;
  resolved_config_id: string | null;
  allowed_tools: string;
  max_turns: number;
  effort: EffortLevel;
  tags: string;
  metadata: string;
  base_commit: string | null;
  head_commit: string | null;
  forked_from_session_id: string | null;
  session_id: string | null;
  project_id: string | null;
  version_id: string | null;
  type: TaskType | null;
  auto_approve: number;
  awaiting_owner_review: number; // v56: 等拍板标记 (0/1). agent marker 触发或人工 POST 设置, unset API 解除.
  awaiting_markers: string | null; // v61+R39: JSON 数组 (来自 <awaiting type="..."/> 多 marker). null = 显式清空.
  awaiting_reason: string | null; // v129 (R112 续): reviewing 子终态标签. null = 显式清空 (回到 reviewing 无子状态).
  requirement_id: string | null; // v64: 关联需求点. 改时同样走 createTask 同款校验 (route 层负责).
  progress: number | null; // v517 (R196): task 完成度 0-100, agent 每轮自报 / 人工修正.
  progress_source: string | null; // 'manual' (route 层固定) | 'ai' 预留
  progress_note: string | null; // 自报依据
  progress_updated_at: string | null;
  idea_id: string | null; // v521 (idea-canvas): 构思层弱引用, 归属校验 route 层负责.
  node_id: string | null; // v521: 构思节点弱引用.
  work_class: string | null; // v521: fix/feature/plan/ops.
}>): Task | null {
  const current = getTaskById(id);
  if (!current) return null;

  if ("project_id" in updates || "version_id" in updates) {
    const projectId = updates.project_id === undefined ? current.project_id : updates.project_id;
    const versionId = updates.version_id === undefined ? current.version_id : updates.version_id;
    const location = validateTaskLocation(projectId, versionId);
    updates.project_id = location.project_id;
    updates.version_id = location.version_id;
  }

  const db = getDb();
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }

  params.push(id);
  const stmt = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...params);

  return getTaskById(id);
}

// ---- Delete (soft) ----

// Soft-delete: set deleted_at and add DELETED_TAG to tags.
// Returns true if the task was found and updated.
export function deleteTask(id: string): boolean {
  // idea-canvas v521 级联 (damo 1012: 任务删除自动从分类去掉): 弱引用条目随任务删除清理.
  getDb().prepare("DELETE FROM pin_list_items WHERE ref_type = 'task' AND ref_id = ?").run(id);
  const db = getDb();
  const task = getTaskById(id, undefined, { includeDeleted: true });
  if (!task) return false;

  // Add DELETED_TAG to existing tags
  const tags = parseStrArray(task.tags);
  if (!tags.includes(DELETED_TAG)) {
    tags.push(DELETED_TAG);
  }

  const stmt = db.prepare(`
    UPDATE tasks SET deleted_at = datetime('now'), tags = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const result = stmt.run(JSON.stringify(tags), id);
  return result.changes > 0;
}

// ---- Restore ----

// Restore a soft-deleted task: clear deleted_at and remove DELETED_TAG from tags.
export function restoreTask(id: string): Task | null {
  const db = getDb();
  const task = getTaskById(id, undefined, { includeDeleted: true });
  if (!task || !task.deleted_at) return null;

  // Remove DELETED_TAG from tags
  const tags = parseStrArray(task.tags).filter((t) => t !== DELETED_TAG);

  const stmt = db.prepare(`
    UPDATE tasks SET deleted_at = NULL, tags = ?, updated_at = datetime('now') WHERE id = ?
  `);
  stmt.run(JSON.stringify(tags), id);

  return getTaskById(id);
}

// ---- Queue order (v510) ----
//
// 看板拖拽手动排序: 同一列内上下拖动 task card 调整顺序, 调度器按这个顺序
// 派发. 全局整数 (非 per-project) — 调度器进程内是单例, 跨项目共用 next_order
// = MAX + 1; 拖拽时一次性把目标列可见 task 全部写连续整数 (10/20/30…), 留
// 空位给将来插入. 写库后 scheduler 内存里的 this.queue 也要相应 reorder,
// 否则拖完即刻的 dispatch 仍按插入顺序. 对应 API:
//   POST /api/tasks/queue-order  body={orders:[{id,order},...]}
// 关注点:
//   - batch update 走 transaction (多条 UPDATE 一次性 commit, 失败原子回滚).
//   - ownership 校验留给路由层 (getTaskById(id, userId) null → 404), 这里
//     只管读写 DB.
//   - NULL 处理: reorderQueuedTasks 只写非 NULL order; 想显式清空走
//     setTaskQueuedOrder(taskId, null) 单条路径.

export function getMaxQueuedOrder(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COALESCE(MAX(queued_order), 0) AS max FROM tasks WHERE queued_order IS NOT NULL")
    .get() as { max: number };
  return row.max ?? 0;
}

// 功能: 给单条 task 写 queued_order (NULL = 清空, 走系统默认排序).
// 关注点: 不动 status / 不动 updated_at — 这只是排序元数据, 触发 SSE patch
//   风暴或 updated_at desc 排序跳变都是噪音. 调用方 (scheduler.enqueue)
//   已在同一轮翻 status, 一次 status_change 事件就够.
export function setTaskQueuedOrder(taskId: string, order: number | null): void {
  getDb().prepare("UPDATE tasks SET queued_order = ? WHERE id = ?").run(order, taskId);
}

// 功能: 写任务排队原因 (v531). reason=null = 清空 (出队/离开队列时).
// 关注点: 裸 UPDATE, 同 setTaskQueuedOrder 口径 —— 不碰 status / updated_at,
//   排队期间反复重写原因 (并发满 ↔ 内存闸门交替) 不搅动列表排序; ETag 指纹
//   靠 total_changes 段仍能感知, 前端轮询照常拉到.
export function setQueuedReason(taskId: string, reason: string | null): void {
  getDb().prepare("UPDATE tasks SET queued_reason = ? WHERE id = ?").run(reason, taskId);
}

// 功能: 批量重排 — 一次 API 调用把目标列可见 task 全部写连续整数. 路由层
//   已校验 (a) 全部 task 属同一 owner (b) 全部 task 仍存在. 写库走 transaction
//   防止半成品 (前几条写入后崩, 列里一半手动一半系统默认).
// 关注点:
//   - orders 数组允许包含 order=null (显式清空回系统默认排序), 实现为
//     UPDATE queued_order = ? (NULL 走 NULL 列值).
//   - 单条 UPDATE = 写库 + 返回 updated 行数; 全成功才 commit, 任一失败整体
//     回滚 (better-sqlite3 transaction 自动).
//   - 不动 updated_at — 同 setTaskQueuedOrder 注释, 这是排序元数据.
export function reorderQueuedTasks(
  orders: Array<{ id: string; order: number | null }>,
): { updated: number } {
  if (orders.length === 0) return { updated: 0 };
  const db = getDb();
  const stmt = db.prepare("UPDATE tasks SET queued_order = ? WHERE id = ?");
  const txn = db.transaction((items: Array<{ id: string; order: number | null }>) => {
    let updated = 0;
    for (const item of items) {
      const info = stmt.run(item.order, item.id);
      updated += info.changes;
    }
    return updated;
  });
  const updated = txn(orders);
  return { updated };
}

// ---- Stats ----

// T3: userId scopes the status counts to the given owner; omit for global.
// Excludes soft-deleted tasks.
export function getTaskStats(userId?: string): Record<TaskStatus, number> {
  const db = getDb();
  const stmt = userId
    ? db.prepare("SELECT status, COUNT(*) as count FROM tasks WHERE owner_id = ? AND deleted_at IS NULL GROUP BY status")
    : db.prepare("SELECT status, COUNT(*) as count FROM tasks WHERE deleted_at IS NULL GROUP BY status");
  const rows = stmt.all(...(userId ? [userId] : [])) as Array<{ status: TaskStatus; count: number }>;

  const stats: Record<string, number> = {
    pending: 0, queued: 0, running: 0, paused: 0,
    reviewing: 0, verifying: 0, await_user: 0,
    completed: 0, failed: 0, rejected: 0, cancelled: 0,
  };
  for (const row of rows) {
    stats[row.status] = row.count;
  }
  return stats as Record<TaskStatus, number>;
}

// Per-scope task counts: running (合并 queued+running) / reviewing / paused / total.
// Keyed by "projectId:versionId" or "projectId:" for unversioned.
// 飞书 R36: 加 paused —— 侧栏徽章要分颜色显示「排队+进行中/待审核/暂停」三态数字.
// 2026-10-11: 加 queued —— 侧栏「全局看板」徽章区分显示 {运行+排队}(纯运行).
//   running 保持 = running+queued 合并口径 (master NavigationTree/NavSidebar
//   老组件语义不变), queued 是纯排队计数, 前端用 running-queued 反推纯运行.
export interface ScopeCounts {
  running: number;
  queued: number;
  reviewing: number;
  paused: number;
  total: number;
}

export function getTaskCountsByScope(userId: string): Record<string, ScopeCounts> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT project_id, version_id, status, COUNT(*) as count
     FROM tasks WHERE owner_id = ? AND deleted_at IS NULL
     GROUP BY project_id, version_id, status`
  ).all(userId) as Array<{ project_id: string; version_id: string | null; status: TaskStatus; count: number }>;

  const result: Record<string, ScopeCounts> = {};
  for (const row of rows) {
    const key = `${row.project_id}:${row.version_id ?? ""}`;
    if (!result[key]) result[key] = { running: 0, queued: 0, reviewing: 0, paused: 0, total: 0 };
    result[key].total += row.count;
    if (row.status === "running" || row.status === "queued") result[key].running += row.count;
    if (row.status === "queued") result[key].queued += row.count;
    if (row.status === "reviewing") result[key].reviewing += row.count;
    if (row.status === "paused") result[key].paused += row.count;
  }
  return result;
}

// ---- Dependencies ----

// Get task IDs that depend on the given task
export function getDependentTaskIds(taskId: string): string[] {
  const db = getDb();
  const stmt = db.prepare("SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?");
  return (stmt.all(taskId) as Array<{ task_id: string }>).map((r) => r.task_id);
}

// Get task IDs that the given task depends on
export function getDependencyTaskIds(taskId: string): string[] {
  const db = getDb();
  const stmt = db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?");
  return (stmt.all(taskId) as Array<{ depends_on_task_id: string }>).map((r) => r.depends_on_task_id);
}

// 功能: 检测把 newDeps 加成 taskId 的依赖后是否会形成环. 返回首个「让 taskId
//   可达」的 depId (即从这个 dep 出发能沿 task_dependencies 表走到 taskId),
//   或 null 表示无环.
// 关注点:
//   - 自环直接返回 taskId (无需查表, taskId ∈ newDeps 就是死锁).
//   - 对每个新 dep BFS, 看现有 task_dependencies 里能否从它走回 taskId.
//     路径 = dep → dep 的依赖 → dep 的依赖的依赖 → ... → taskId.
//   - visited Set 防稠密图重复扫, 单次调用 O(V+E).
//   - 不校验 dep 是否存在 (那是 DEPENDENCY_NOT_FOUND 的事, 单独错误码);
//     不存在的 dep getDependencyTaskIds 返回 [], 自然走不到 taskId = 无环判断.
//   - 这个函数只读 DB 不写, 调用方拿到非 null 必须抛错或拒绝写.
//   - PATCH 路径: 调用前 taskId 已在 DB 里; 检查的是「用新 deps 替换旧 deps 后
//     是否成环」, 即不依赖 taskId 的旧 deps (它们马上被删). 新 deps 之间的现有
//     链路才决定有无环.
export function detectDependencyCycle(taskId: string, newDeps: string[]): string | null {
  // 自环: 直接判 list 里有没有 taskId 本身.
  if (newDeps.includes(taskId)) return taskId;
  // 逐个 dep BFS, 看谁能走回 taskId.
  const visited = new Set<string>();
  for (const depId of newDeps) {
    if (visited.has(depId)) continue;
    const queue: string[] = [depId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === taskId) return depId; // 走回来了, 环经由 depId 形成
      if (visited.has(cur)) continue;
      visited.add(cur);
      const nextDeps = getDependencyTaskIds(cur);
      for (const nd of nextDeps) {
        if (!visited.has(nd)) queue.push(nd);
      }
    }
  }
  return null;
}

// 功能: 原子替换某 task 的全部依赖 (清旧 rows + 重写 tasks.depends_on JSON + 写新 rows).
//   ids=null → 清空依赖 (对应 PATCH depends_on_ids:null 显式清空语义).
//   ids=[]   → 等价于 null (空集).
//   ids=[...] → replace 全部. 同 owner 校验留给路由层 (路由已拿到 userId),
//     这里只接受 string[] 写库.
// 关注点:
//   - 用 transaction 包住 (DELETE + UPDATE + N×INSERT), better-sqlite3 同步
//     API, 半成品状态不会出现.
//   - 同步改 tasks.depends_on JSON 列 (createTask 也写它, 两边要保持一致;
//     否则 GET 回读时会出现「JSON 有 id 但 task_dependencies 缺行」的不变量漂移).
//   - DAG P1 (2026-09-05): 写入前调 detectDependencyCycle, 撞环抛 TaskLocationError.
//     必须在 txn 外 (更好的-sqlite3 的事务里抛错会自动回滚, 但调用方拿到的错误栈
//     会穿过事务边界, 不直观; 显式抛也更易测). 撞环时不进事务, 旧 deps 不动.
export function replaceTaskDependencies(taskId: string, ids: string[] | null): void {
  if (ids && ids.length > 0) {
    const cycleDep = detectDependencyCycle(taskId, ids);
    if (cycleDep !== null) {
      throw new TaskLocationError(
        "DEPENDENCY_CYCLE",
        `Dependency cycle detected via ${cycleDep}: setting [${ids.join(",")}] as deps of ${taskId} would form a cycle`
      );
    }
  }
  const db = getDb();
  const txn = db.transaction((tid: string, depIds: string[] | null) => {
    db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(tid);
    db.prepare("UPDATE tasks SET depends_on = ?, updated_at = datetime('now') WHERE id = ?")
      .run(depIds && depIds.length > 0 ? JSON.stringify(depIds) : null, tid);
    if (depIds && depIds.length > 0) {
      const ins = db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
      for (const depId of depIds) {
        ins.run(tid, depId);
      }
    }
  });
  txn(taskId, ids);
}

// Check if all dependencies of a task are completed (deleted deps are ignored)
export function areDependenciesMet(taskId: string): boolean {
  const depIds = getDependencyTaskIds(taskId);
  if (depIds.length === 0) return true;

  const db = getDb();
  const stmt = db.prepare("SELECT status, deleted_at FROM tasks WHERE id = ?");
  for (const depId of depIds) {
    const row = stmt.get(depId) as { status: string; deleted_at: string | null } | undefined;
    if (!row) return false; // dependency doesn't exist
    if (row.deleted_at) continue; // deleted dep is ignored (treated as met)
    if (row.status !== "completed") return false;
  }
  return true;
}

// Append a message to the task's pending_messages queue. Stored in the
// tasks.metadata column as a JSON array. Drained by ActiveSession.resume()
// after the SDK session is reconnected.
// 功能: 以「重新读库 -> 改 -> 写回」的方式改 tasks.metadata 的某几个键, mutator
//   返回 false 表示无需写库. 返回 mutator 是否真的写了.
// 关注点: 🔴 metadata 是整块 JSON, updateTask 是全字段覆盖 —— 谁手上攥着一份
//   过期快照再写回, 就会把别人刚写的键悄悄抹掉(2026-08-12 实测: resume() 里
//   compact_first 的清理用了进函数时的 task.metadata, 把 drainPendingMessages
//   刚排空的 pending_messages 又复活了一次). 所以改 metadata 一律走这里, 别自己
//   JSON.parse(task.metadata) 再 updateTask. 仍无事务, 并发写只是把窗口收窄到
//   函数内, 没有消除.
export function mutateTaskMetadata(
  taskId: string,
  mutator: (meta: Record<string, unknown>) => boolean | void,
): boolean {
  const task = getTaskById(taskId);
  if (!task) return false;
  let meta: Record<string, unknown> = {};
  try {
    meta = task.metadata ? JSON.parse(task.metadata) : {};
  } catch {
    return false;
  }
  if (mutator(meta) === false) return false;
  updateTask(taskId, { metadata: JSON.stringify(meta) });
  return true;
}

// 功能: 从 task.metadata 读出 per-task timeout override (分钟). 没存或脏值 = null.
// 关注点: 与 resolveTaskTimeoutMs 的优先级配合 —— task 行有 override 时优先用它,
//   跳过 project / 全局默认. 脏值(非整数/字符串/越界)一律视为未设置, 不抛错,
//   让上游走下一级链路. 与 project.timeout_minutes 的校验口径不同 —— project
//   由 parseTimeoutMinutes 兜底, 这里仅做轻量校验 (Number.isInteger), 范围检查
//   留给 setTaskTimeout / PATCH 路由 (parseTimeoutMinutes 拒掉).
export function getTaskTimeoutOverrideMinutes(task: Task): number | null {
  if (!task.metadata) return null;
  try {
    const meta = JSON.parse(task.metadata);
    const n = meta?.timeout_minutes;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function queuePendingMessage(taskId: string, message: string): void {
  mutateTaskMetadata(taskId, (meta) => {
    const pending = Array.isArray(meta.pending_messages) ? (meta.pending_messages as string[]) : [];
    pending.push(message);
    meta.pending_messages = pending;
  });
}

// Read and clear pending_messages for a task. Returns the messages that
// were queued (in arrival order) so the caller can replay them.
export function drainPendingMessages(taskId: string): string[] {
  let pending: string[] = [];
  mutateTaskMetadata(taskId, (meta) => {
    pending = Array.isArray(meta.pending_messages) ? (meta.pending_messages as string[]) : [];
    if (pending.length === 0) return false;
    delete meta.pending_messages;
  });
  return pending;
}

// Read pending_messages WITHOUT clearing - used to decide whether a just-finished
// task needs an automatic resume to drain messages that arrived during its
// teardown window. drainPendingMessages (which clears) runs later inside resume().
export function peekPendingMessages(taskId: string): string[] {
  const task = getTaskById(taskId);
  if (!task) return [];
  try {
    const meta = task.metadata ? JSON.parse(task.metadata) : {};
    return Array.isArray(meta.pending_messages) ? (meta.pending_messages as string[]) : [];
  } catch {
    return [];
  }
}

// R127 §3.4 洞2+3: 父 task 在等子 task 完成时, 把子 task id 写进父 metadata.
//   存 tasks.metadata JSON, 键 = waiting_child_id. 命中条件: parent-notify.ts 收到
//   子 completed 时, 读父 metadata.waiting_child_id === child.id 才推父 + 触发
//   auto-resume helper. 写入 / 清除都走 mutateTaskMetadata (read-modify-write,
//   不走 updateTask 全字段覆盖, 与 resume-contract 红线一致).
//   字段语义: 父 agent 显式声明「我正在等子任务 X, X 完成即可触发我的 auto-resume」.
//   agent 自己写 (e.g. 派完子任务后置位), 不走 schema migration (0 migration 方案 A).
export function setWaitingChild(parentTaskId: string, childTaskId: string): boolean {
  return mutateTaskMetadata(parentTaskId, (meta) => {
    (meta as Record<string, unknown>).waiting_child_id = childTaskId;
    return true;
  });
}

export function clearWaitingChild(parentTaskId: string, expectedChildTaskId?: string): boolean {
  return mutateTaskMetadata(parentTaskId, (meta) => {
    const cur = (meta as Record<string, unknown>).waiting_child_id;
    // expectedChildTaskId 提供时做身份校验: 只清等于它的, 防 race 把新写的也清了.
    if (expectedChildTaskId !== undefined && cur !== expectedChildTaskId) return false;
    if (cur === undefined) return false;
    delete (meta as Record<string, unknown>).waiting_child_id;
    return true;
  });
}

export function getWaitingChild(parentTaskId: string): string | null {
  const task = getTaskById(parentTaskId);
  if (!task?.metadata) return null;
  try {
    const meta = JSON.parse(task.metadata);
    const v = meta?.waiting_child_id;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
