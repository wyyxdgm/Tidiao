// requirements 模块 —— 飞书 R60 P0 新 spec (in_app 数据源 + 6 态 status + tasks.requirement_id FK).
//
// 设计要点 (docs/plans/feishu-alternative-data-source.md §4.1):
//   - source 严格 'in_app' (v63 已删 v42 'feishu'/'platform' 双源镜像).
//   - status 6 态 dispatcher-coordination: pending / done / awaiting_reply /
//     has_suggestion / blocked / closed. 终态 = done + closed.
//   - 软删走 status='closed', 无 deleted_at 列.
//   - 任务关联走 tasks.requirement_id FK (v64 migration + 索引 idx_tasks_requirement).
//
// 关注点:
//   - 所有 SELECT 加 owner_id 过滤 (v14-v19 多租户硬约束): owner_id 是 requirements
//     表的 user FK, 与 tasks.owner_id 同口径 (一个 user 的需求点只能被自己访问).
//   - 白名单字段写: PATCH 严格按 ALLOWED_FIELDS 走, 防止静默吞字段 (R128 教训).
//   - catch 用 code/name 字符串判, 不用 instanceof (damo 0823 教训).

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import {
  recordRevision,
  revisionStringify,
  type RevisionActor,
} from "./requirement-revisions";
import { getProjectById } from "./projects";
import { getVersionById } from "./versions";

// ---- 类型 ----

export type RequirementSource = "in_app";

// R60 §4.1 status 枚举 -- 对齐飞书 O 列四态 + 1 内部终态 closed (飞书无对应).
// pending      = 未动过 (对齐飞书 "空")
// done         = 处理好了 (终态, 对齐飞书 "1")
// awaiting_reply = 等派发人或伙伴回复 (中间态, 对齐飞书 "等回复")
// has_suggestion = 有建议给派发人或伙伴 (中间态, 对齐飞书 "有建议")
// blocked      = 需派发人或伙伴拍板 (中间态, 对齐飞书 "卡住")
// closed       = 内部终态, 不重派 (飞书无, 仅本表内部使用)
export type RequirementStatus =
  | "pending"
  | "done"
  | "awaiting_reply"
  | "has_suggestion"
  | "blocked"
  | "closed";

export const REQUIREMENT_STATUSES: RequirementStatus[] = [
  "pending",
  "done",
  "awaiting_reply",
  "has_suggestion",
  "blocked",
  "closed",
];

export interface Requirement {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: RequirementStatus;
  priority: number | null;
  owner_id: string | null;
  tags: string | null; // JSON 数组字符串
  source: RequirementSource;
  version_id: string | null; // R64: 可选, 跨版本演进 (允许 v1→v2 迁移)
  progress: number | null; // v517 (R196): 完成度 0-100, null = 未评估
  progress_source: string | null; // 'rule' | 'manual' | 'ai'
  progress_note: string | null; // 评估依据/修正理由
  progress_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- 内部: 行映射 ----

function rowToRequirement(r: any): Requirement {
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    priority: r.priority ?? null,
    owner_id: r.owner_id ?? null,
    tags: r.tags ?? null,
    source: r.source,
    version_id: r.version_id ?? null,
    progress: r.progress ?? null,
    progress_source: r.progress_source ?? null,
    progress_note: r.progress_note ?? null,
    progress_updated_at: r.progress_updated_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---- 内部: 校验 ----

// PATCH 白名单字段 (id/project_id/source/created_at/updated_at 不可改, 防越权写).
// version_id 加入白名单 (R64): 允许把需求点从 v1 迁移到 v2, 支持版本演进.
export const REQUIREMENT_UPDATE_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "tags",
  "version_id",
  "progress", // v517 (R196): 完成度 0-100 或 null(清空). route 层固定带 progress_source='manual'.
  "progress_note", // v517: 评估依据/修正理由.
] as const;
export type RequirementUpdateField = (typeof REQUIREMENT_UPDATE_FIELDS)[number];

// 校验 tags 是 string[] 或 null.
export function parseRequirementTags(jsonStr: string | null | undefined): string[] {
  if (!jsonStr) return [];
  try {
    const v = JSON.parse(jsonStr);
    if (!Array.isArray(v)) return [];
    return v.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

export function serializeRequirementTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}

// ---- CRUD ----

// 功能: 新建一条 in_app requirement. ownerId 写入 owner_id (多租户隔离).
// 关注点:
//   - title 必填, 调用方已校验; description/priority/tags/version_id 可选.
//   - source 固定 'in_app' (DB CHECK 兜底, 不接前端入参).
//   - status 默认 'pending' (DB DEFAULT + 应用层显式传, 行为一致).
//   - version_id 不传 = 默认取 project.current_version_id (damo R64: "需求点
//     本就挂在版本上"). 传 null = 显式不挂版本 (老数据兼容 / 跨版本演进时).
export function createRequirement(
  projectId: string,
  input: {
    title: string;
    description?: string | null;
    priority?: number | null;
    tags?: string[] | null;
    version_id?: string | null;
  },
  ownerId: string,
  actor: RevisionActor = { type: "user", id: ownerId }
): Requirement {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const tagsJson = serializeRequirementTags(input.tags ?? null);

  // version_id 默认 = project.current_version_id (R64: "需求点本就挂在版本上").
  // 调用方显式传 null = 强制不挂 (留作跨版本迁移时的临时态).
  // 不传 = 自动取 current; 传字符串 = 用入参 (允许 v1→v2 迁移).
  let versionId: string | null;
  if (input.version_id === null) {
    versionId = null;
  } else if (input.version_id !== undefined) {
    versionId = input.version_id;
  } else {
    const project = getProjectById(projectId, ownerId);
    versionId = project?.current_version_id ?? null;
  }

  db.prepare(
    `INSERT INTO requirements
       (id, project_id, title, description, status, priority, owner_id, tags, source, version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, 'in_app', ?, ?, ?)`
  ).run(
    id,
    projectId,
    input.title,
    input.description ?? null,
    input.priority ?? null,
    ownerId,
    tagsJson,
    versionId,
    now,
    now
  );
  // R63 时间线: 新建 = 一行 (null → new). title 必填, 是首条可见 diff.
  recordRevision(id, "title", null, input.title, actor);
  // R64: 也记 version_id 起始 (老数据无 version, 历史上一律 null → 新建者挂的 version).
  if (versionId !== null) {
    recordRevision(id, "version_id", null, versionId, actor);
  }
  const created = getRequirementById(id, ownerId);
  if (!created) throw new Error("createRequirement: row not found after insert");
  return created;
}

// 功能: 按 id 查一行, 按 owner_id 隔离. 返回 null = 不存在或无权访问.
// 关注点: 不抛 404, 让调用方决定如何渲染 (前端可能想区分 "不存在" 和 "无权").
export function getRequirementById(id: string, ownerId: string): Requirement | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM requirements WHERE id = ? AND owner_id = ?")
    .get(id, ownerId) as any;
  if (!row) return null;
  return rowToRequirement(row);
}

// 功能: 列表 + 分页, 信封结构 {items, total, has_more}.
// 关注点:
//   - page 默认 1, page_size 默认 20, max 100 (防 list all).
//   - status / source 等值过滤 (不做模糊查询, 避免索引失效).
//   - owner_id 硬过滤, 多租户.
//   - 不含 closed? 默认含; 调用方按需前端过滤.
export interface ListRequirementsInput {
  project_id?: string;
  status?: RequirementStatus | RequirementStatus[];
  source?: RequirementSource;
  version_id?: string | null; // R64: 按 version 过滤 (null = 不挂版本的需求)
  page?: number;
  page_size?: number;
}

export interface ListRequirementsResult {
  items: Requirement[];
  total: number;
  has_more: boolean;
  page: number;
  page_size: number;
}

export function listRequirements(
  input: ListRequirementsInput,
  ownerId: string
): ListRequirementsResult {
  const db = getDb();
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.page_size ?? 20));

  const where: string[] = ["owner_id = ?"];
  const params: any[] = [ownerId];

  if (input.project_id) {
    where.push("project_id = ?");
    params.push(input.project_id);
  }
  // R64: version_id 过滤. 传 string = 该 version; 显式 null = 不挂版本的; 不传 = 不过滤.
  if (input.version_id !== undefined) {
    if (input.version_id === null) {
      where.push("version_id IS NULL");
    } else {
      where.push("version_id = ?");
      params.push(input.version_id);
    }
  }
  if (input.status) {
    if (Array.isArray(input.status)) {
      const placeholders = input.status.map(() => "?").join(",");
      where.push(`status IN (${placeholders})`);
      params.push(...input.status);
    } else {
      where.push("status = ?");
      params.push(input.status);
    }
  }
  if (input.source) {
    where.push("source = ?");
    params.push(input.source);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM requirements ${whereSql}`)
    .get(...params) as { n: number };

  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT * FROM requirements ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as any[];

  return {
    items: rows.map(rowToRequirement),
    total: totalRow.n,
    has_more: offset + rows.length < totalRow.n,
    page,
    page_size: pageSize,
  };
}

// 功能: 白名单 PATCH. 不传字段不动; 非法字段静默忽略 (防止 "未授权字段透传").
// 关注点:
//   - 仅 REQUIREMENT_UPDATE_FIELDS 列表内字段被写入; 其它一律 ignore (前端多塞 id/source
//     不会污染 DB).
//   - status 取值校验: 必须 ∈ REQUIREMENT_STATUSES (DB CHECK + 应用层双兜底).
//   - priority 范围 1-5, 越界 clamp 到 null (不抛错, 与 v44 attachments 行为一致).
//   - version_id 校验: 必须是字符串 (有效 version_id) 或 null (显式置空).
//     不存在 / 跨 project 一律忽略 (DB trigger 兜底, 应用层静默更友好).
//   - updated_at 自动写当前时间.
export function updateRequirement(
  id: string,
  patch: Partial<{
    title: string;
    description: string | null;
    status: RequirementStatus;
    priority: number | null;
    tags: string[] | null;
    version_id: string | null;
    progress: number | null;
    progress_note: string | null;
    // 内部字段: 不在 REQUIREMENT_UPDATE_FIELDS 白名单 (API 层禁改), 由调用方按语义传:
    //   route PATCH → 'manual'; 规则重算 → 'rule'; AI 评估 → 'ai'.
    progress_source: string;
  }>,
  ownerId: string,
  actor: RevisionActor = { type: "user", id: ownerId }
): Requirement | null {
  const db = getDb();

  // 校验 + 过滤白名单: 拒掉的字段 (status 非法值 / priority 越界 / tags 类型错 / version 不存在
  // 或跨 project) 不进 acceptedKeys.
  const sets: string[] = [];
  const params: any[] = [];
  const acceptedKeys: Array<keyof typeof patch> = [];

  // R64: version_id 校验需要先知道当前 requirement 的 project_id, 才能校验
  // version 是否同 project. 这里提前读一次, 复用为后续 "before" 比较.
  const before = getRequirementById(id, ownerId);
  if (!before) return null;

  // 内部可写字段: progress_source 不对外 (不在 REQUIREMENT_UPDATE_FIELDS, route 层
  // 会拒外部 PATCH), 但 applyRuleProgress / route PATCH 需要内部传 source 语义.
  const INTERNAL_FIELDS = ["progress_source"];
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (
      !REQUIREMENT_UPDATE_FIELDS.includes(key as RequirementUpdateField) &&
      !INTERNAL_FIELDS.includes(key as string)
    ) {
      continue; // 非白名单静默忽略
    }
    const v = patch[key];

    if (key === "status") {
      if (v === undefined) continue;
      if (typeof v !== "string" || !REQUIREMENT_STATUSES.includes(v as RequirementStatus)) {
        continue;
      }
      sets.push("status = ?");
      params.push(v);
      acceptedKeys.push(key);
      continue;
    }

    if (key === "priority") {
      if (v === undefined) continue;
      if (v === null) {
        sets.push("priority = ?");
        params.push(null);
        acceptedKeys.push(key);
        continue;
      }
      if (typeof v !== "number" || v < 1 || v > 5 || !Number.isInteger(v)) {
        continue; // 越界/非整数忽略
      }
      sets.push("priority = ?");
      params.push(v);
      acceptedKeys.push(key);
      continue;
    }

    if (key === "tags") {
      if (v === undefined) continue;
      if (v === null) {
        sets.push("tags = ?");
        params.push(null);
        acceptedKeys.push(key);
        continue;
      }
      if (!Array.isArray(v)) continue;
      sets.push("tags = ?");
      params.push(serializeRequirementTags(v));
      acceptedKeys.push(key);
      continue;
    }

    if (key === "version_id") {
      if (v === undefined) continue;
      // null = 显式置空 (跨版本迁移时清空, 允许 version_id 为空)
      if (v === null) {
        sets.push("version_id = ?");
        params.push(null);
        acceptedKeys.push(key);
        continue;
      }
      // string: 必须存在 + 属当前 requirement 的 project.
      if (typeof v !== "string") continue;
      const ver = getVersionById(v, ownerId);
      if (!ver) continue; // 不存在 / 跨 owner = 静默忽略
      if (ver.project_id !== before.project_id) continue; // 跨 project = 静默忽略 (DB trigger 兜底)
      sets.push("version_id = ?");
      params.push(v);
      acceptedKeys.push(key);
      continue;
    }

    // progress (v517 / R196): null = 清空; 整数 0-100 = 写入.
    // 写 progress 时自动带 progress_updated_at; progress_source 由调用方传 (route 层固定
    // 'manual', 规则重算 'rule'), 不在白名单 → 外部 PATCH 摸不到, 防伪造来源.
    if (key === "progress") {
      if (v === undefined) continue;
      if (v === null) {
        sets.push("progress = ?", "progress_source = ?", "progress_note = NULL");
        params.push(null, null);
        acceptedKeys.push(key);
      } else if (
        typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 0 &&
        v <= 100
      ) {
        sets.push("progress = ?", "progress_updated_at = ?");
        params.push(v, new Date().toISOString().replace("T", " ").slice(0, 19));
        acceptedKeys.push(key);
      }
      // 越界/非整数 = 忽略 (与 priority 同风格)
      continue;
    }

    if (key === "progress_source") {
      if (typeof v !== "string" || !["rule", "manual", "ai"].includes(v)) continue;
      sets.push("progress_source = ?");
      params.push(v);
      acceptedKeys.push(key);
      continue;
    }

    if (key === "progress_note") {
      if (v === undefined) continue;
      if (v !== null && typeof v !== "string") continue;
      sets.push("progress_note = ?");
      params.push(v);
      acceptedKeys.push(key);
      continue;
    }

    // title / description: undefined 不写; null 显式置空; 其他值原样落.
    if (v === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(v);
    acceptedKeys.push(key);
  }

  if (sets.length === 0) {
    // 没有可写字段, 直接返回当前行
    return getRequirementById(id, ownerId);
  }

  // R63 时间线: 先读旧值 → 写新值 → 逐字段落 diff (old_value === new_value 跳过, 避免噪音).
  // before 已在上面读过 (version_id 校验需要), 复用.

  sets.push("updated_at = ?");
  params.push(new Date().toISOString().replace("T", " ").slice(0, 19));

  params.push(id);
  params.push(ownerId);

  const result = db
    .prepare(
      `UPDATE requirements SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`
    )
    .run(...params);

  if (result.changes === 0) {
    return null; // id 不存在 或 owner 不匹配
  }

  for (const field of acceptedKeys) {
    const oldRaw = (before as any)[field];
    const oldStr = revisionStringify(field, oldRaw);
    const newStr = revisionStringify(field, (patch as any)[field]);
    if (oldStr === newStr) continue; // 写值与原值相同 = 无 diff
    recordRevision(id, field, oldStr, newStr, actor);
  }

  return getRequirementById(id, ownerId);
}

// 功能: 软删 (status='closed'). 不物理删, 保留历史可读.
// 关注点:
//   - 与硬 DELETE 不同, 软删后 GET 仍可查到, 但前端按 status 过滤可见性.
//   - 不级联改 tasks.requirement_id (FK ON DELETE SET NULL 不触发 -- 软删不走物理删).
export function softDeleteRequirement(
  id: string,
  ownerId: string,
  actor: RevisionActor = { type: "user", id: ownerId }
): boolean {
  const db = getDb();
  const before = getRequirementById(id, ownerId);
  if (!before) return false;
  const result = db
    .prepare(
      `UPDATE requirements SET status = 'closed', updated_at = ?
       WHERE id = ? AND owner_id = ? AND status != 'closed'`
    )
    .run(
      new Date().toISOString().replace("T", " ").slice(0, 19),
      id,
      ownerId
    );
  if (result.changes > 0) {
    recordRevision(id, "status", before.status, "closed", actor);
  }
  return result.changes > 0;
}

// ---- 关联 task 视图 (新 spec §3.1 任务森林) ----

// R78 W1 §4.3 invariant: 设计/调研 task 完成 (含 reviewing) 不能把 requirement
// 自动标 done. 实现层校验 = "至少一个 type ∈ {dev,test,deploy} 的 task status='completed'".
// 不计入: type='design' / type=null / status ∈ {queued,running,paused,reviewing,failed,rejected,cancelled}.
export function hasCompletedImplementationTask(
  requirementId: string,
  ownerId: string
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM tasks
       WHERE requirement_id = ?
         AND owner_id = ?
         AND type IN ('dev', 'test', 'deploy')
         AND status = 'completed'
       LIMIT 1`
    )
    .get(requirementId, ownerId);
  return row !== undefined && row !== null;
}

// R78 W1 §4.3 invariant: 设计型 task 当前是否还有未完成 (used by UI disabled
// 状态 + tooltip 文案). 包含 status='completed' 之外的全部 active 态 (pending/
// queued/running/paused/reviewing) + 失败态.
export function countActiveDesignTasks(
  requirementId: string,
  ownerId: string
): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE requirement_id = ?
         AND owner_id = ?
         AND type = 'design'
         AND status NOT IN ('completed', 'cancelled', 'closed')`
    )
    .get(requirementId, ownerId) as { n: number };
  return row.n;
}

export interface RequirementTaskEdge {
  // 森林 API 输出: 关联 task 列表 + 依赖图 edges.
  task_id: string;
  depends_on: string[]; // task 列表, 闭包传递依赖
}

export interface RequirementTasksResult {
  requirement_id: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    depends_on: string[];
    // R78 W3: 给详情页 forest 视图识别 root 用 (root = created 最早 + 无 dispatched_by).
    created_at: string;
    dispatched_by_task_id: string | null;
    // R109: 同 listTasksPage 语义 — 最新有 status 的 checkpoint. UI 走 TaskStatusChip
    //   渲染 4 色 chip. null 时不渲染 (向后兼容老 cp / 无 cp).
    latest_checkpoint_status: string | null;
  }>;
  edges: Array<{ from: string; to: string }>; // from depends on to
}

// 功能: 拉需求点的关联 task + 依赖图 (森林 API).
// 关注点:
//   - withDeps=false 时只返 task 列表 (id/title/status).
//   - withDeps=true 时额外返回 edges (a depends on b).
//   - 依赖从 tasks.depends_on JSON 字段读 (v3 已有列), 应用层解析.
//   - 不递归展开闭包; depends_on 是 1 层直接依赖. 客户端按需递归.
//   - 列表按 created_at ASC 排序, 第 0 条 = 最早创建 (root 候选).
export function getRequirementTasks(
  requirementId: string,
  withDeps: boolean = false
): RequirementTasksResult {
  const db = getDb();
  // R109: LEFT JOIN checkpoints latest_cp 取最新有 status 的 cp (同 listTasksPage 语义).
  //   需求详情页关联 task 列表也要展示 sub-status chip, 与 4 视图口径一致.
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.depends_on, t.created_at, t.dispatched_by_task_id,
              latest_cp.status AS latest_checkpoint_status
       FROM tasks t
       LEFT JOIN checkpoints latest_cp
         ON latest_cp.rowid = (
           SELECT MAX(cp2.rowid) FROM checkpoints cp2
           WHERE cp2.task_id = t.id
             AND cp2.status IS NOT NULL
         )
       WHERE t.requirement_id = ?
       ORDER BY t.created_at ASC`
    )
    .all(requirementId) as Array<{
    id: string;
    title: string;
    status: string;
    depends_on: string | null;
    created_at: string;
    dispatched_by_task_id: string | null;
    latest_checkpoint_status: string | null;
  }>;

  const tasks: RequirementTasksResult["tasks"] = [];
  const edges: RequirementTasksResult["edges"] = [];

  for (const r of rows) {
    let deps: string[] = [];
    if (r.depends_on) {
      try {
        const v = JSON.parse(r.depends_on);
        if (Array.isArray(v)) deps = v.filter((x): x is string => typeof x === "string");
      } catch {
        deps = [];
      }
    }
    tasks.push({
      id: r.id,
      title: r.title,
      status: r.status,
      depends_on: deps,
      created_at: r.created_at,
      dispatched_by_task_id: r.dispatched_by_task_id,
      latest_checkpoint_status: r.latest_checkpoint_status,
    });
    if (withDeps) {
      for (const dep of deps) {
        edges.push({ from: r.id, to: dep });
      }
    }
  }

  return { requirement_id: requirementId, tasks, edges };
}

// R78 W3 §4.4: 列表页量化基础 3 列 = 关联 task 数 / 完成进度 / 最近反馈时间.
// 一次 SQL 拿三个数, 按 requirement_id 分组返回. 入参 ids 为空 → 返空 Map.
//
// "完成进度" 口径: completed tasks / total tasks. completed = task.status IN
// ('completed', 'reviewing', 'done') (reviewing/done 视为已完成执行段, 等
// damo approve 走需求层; 失败/拒绝/取消不计入). 这个口径与 R78 W1 §4.3 (c) 的
// "eligible_for_done" 口径一致 (实现/测试/部署 task completed 才算).
//
// "最近反馈时间" 口径: MAX(requirement_revisions.created_at) WHERE field IN
// ('status', 'description') -- 即"反馈类"字段变更, 排除 priority / tags 这种
// 元信息变更.
export interface RequirementAggregate {
  task_count: number;
  completed_count: number;
  completion_ratio: number; // 0..1
  latest_feedback_at: string | null;
}

export function getRequirementAggregates(
  requirementIds: string[]
): Map<string, RequirementAggregate> {
  const out = new Map<string, RequirementAggregate>();
  if (requirementIds.length === 0) return out;
  const db = getDb();
  const placeholders = requirementIds.map(() => "?").join(",");

  // 1) task 计数 + 完成计数 (LEFT JOIN 防 requirement 没关联 task 时整行丢).
  const taskRows = db
    .prepare(
      `SELECT t.requirement_id AS rid,
              COUNT(t.id) AS task_count,
              SUM(CASE WHEN t.status IN ('completed','reviewing') THEN 1 ELSE 0 END) AS done_count
       FROM tasks t
       WHERE t.requirement_id IN (${placeholders})
       GROUP BY t.requirement_id`
    )
    .all(...requirementIds) as Array<{
    rid: string;
    task_count: number;
    done_count: number | null;
  }>;

  // 2) 最近反馈时间 (status / description 字段的最近一次变更).
  const revRows = db
    .prepare(
      `SELECT requirement_id AS rid, MAX(created_at) AS latest
       FROM requirement_revisions
       WHERE requirement_id IN (${placeholders})
         AND field IN ('status', 'description')
       GROUP BY requirement_id`
    )
    .all(...requirementIds) as Array<{ rid: string; latest: string | null }>;

  // 先确保每个 id 都有 entry (无 task / 无 revision 时给 0/null 兜底).
  for (const id of requirementIds) {
    out.set(id, {
      task_count: 0,
      completed_count: 0,
      completion_ratio: 0,
      latest_feedback_at: null,
    });
  }
  for (const r of taskRows) {
    const done = r.done_count ?? 0;
    const total = r.task_count;
    const prev = out.get(r.rid);
    if (!prev) continue;
    prev.task_count = total;
    prev.completed_count = done;
    prev.completion_ratio = total > 0 ? done / total : 0;
  }
  for (const r of revRows) {
    const prev = out.get(r.rid);
    if (!prev) continue;
    prev.latest_feedback_at = r.latest;
  }

  return out;
}

// ---- 完成度量化 (v517 / 飞书 R196) ----

// 口径: 100% = 需求 status done (终态 = 部署上去并验证通过, damo R196 定).
// 0-90% 由关联 task 聚合: task 自报 progress 优先 (R196 追加: agent 每轮自报),
// 无自报按 task 状态折算 (completed/reviewing=1.0, 进行中=0.3, 失败/取消=0).
// 聚合结果封顶 90%, 剩下 10% 只能由 status=done 兑现 —— 防止"代码写完就 100%".

const TASK_WEIGHTS_DONE: Record<string, number> = {
  completed: 1,
  reviewing: 1,
  done: 1,
};
const TASK_WEIGHT_ACTIVE = 0.3; // pending/queued/running/paused 等非终态
const PROGRESS_CAP_BEFORE_DONE = 90;

// 功能: 按规则计算需求完成度 (0-100, 纯函数式读, 不写库).
// 关注点: task 自报 progress 与状态折算混合时, 有自报的 task 用自报值, 没有的用状态权重.
export function computeRuleProgress(requirementId: string): number {
  const db = getDb();
  const req = db
    .prepare(`SELECT status FROM requirements WHERE id = ?`)
    .get(requirementId) as { status: string } | undefined;
  if (!req) return 0;
  if (req.status === "done" || req.status === "closed") return 100;

  const rows = db
    .prepare(
      `SELECT status, progress FROM tasks WHERE requirement_id = ? AND deleted_at IS NULL`
    )
    .all(requirementId) as Array<{ status: string; progress: number | null }>;
  if (rows.length === 0) return 0;

  let sum = 0;
  for (const t of rows) {
    if (t.progress !== null && t.progress !== undefined) {
      sum += Math.min(100, Math.max(0, t.progress)); // 有自报用自报
    } else if (TASK_WEIGHTS_DONE[t.status]) {
      sum += 100 * TASK_WEIGHTS_DONE[t.status];
    } else if (t.status === "failed" || t.status === "cancelled") {
      sum += 0;
    } else {
      sum += 100 * TASK_WEIGHT_ACTIVE;
    }
  }
  const ratio = sum / (rows.length * 100);
  return Math.round(ratio * PROGRESS_CAP_BEFORE_DONE);
}

// 功能: 规则重算并落库 (source='rule', note 自动生成). 返回更新后的 requirement.
// 关注点: status=done 时规则恒 100, 重复调用幂等; 不覆盖手动修正 —— 调用方决定何时重算
//         (task 状态变更 / 进度自报后), 若想保留手动值需在调用前比较 progress_source.
export function applyRuleProgress(
  id: string,
  ownerId: string
): Requirement | null {
  const value = computeRuleProgress(id);
  const tasks = getRequirementTasks(id).tasks;
  const doneCount = tasks.filter(
    (t) => TASK_WEIGHTS_DONE[t.status]
  ).length;
  const note = `规则: ${doneCount}/${tasks.length} task 完成, ${value}% (100% = 部署+验证通过)`;
  return updateRequirement(
    id,
    { progress: value, progress_note: note, progress_source: "rule" },
    ownerId
  );
}
