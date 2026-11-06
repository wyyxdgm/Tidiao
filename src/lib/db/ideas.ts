// ideas 模块 —— 构思层四实体 + 人工列表 + 积木布局 (idea-canvas P0, docs/plans/idea-canvas.md).
//
// 设计要点 (两处来源: damo 2026-10-11/12 口述 → docs/plans/idea-canvas.md §1-§3):
//   - 两层状态机红线: 任务运行态词表不动 (pending/running/... 留在 tasks), 意图态
//     (germinating/exploring/decided... 与 planned/dispatched/...) 全在本模块的表里.
//   - 任务对 idea/node 是可空弱引用 (v521 无 FK 约束): 删 idea 只把 tasks.idea_id
//     置 NULL, 不级联动历史任务 (D3).
//   - idea_signals = 反馈信号归因 (咨询/注册/收入/审核/使用), 收益面板的数据源;
//     投入侧 = SUM(tasks.cost_usd WHERE idea_id) (成本归因楔子吃自己狗粮).
//   - 假设-验证-归因回路: hypothesis/success_criteria/deadline 预写, conclusion
//     必须挂证据 (🔴 否定结论必须一手数据, L1 §否定方向=一手数据缺失).
//   - pin_lists 多态条目 (ref_type: task/idea/node), UNIQUE(list,ref) 防重 (D4).
//
// 关注点:
//   - 所有 SELECT/UPDATE/DELETE 带 owner_id 过滤 (多租户硬约束, 与 requirements 同口径);
//     子实体 (node/signal/list item) 先验父 idea/list 归属再操作 (防越权 IDOR).
//   - 白名单字段写: updateIdea/updateIdeaNode 严格按 ALLOWED_FIELDS, 防静默吞字段.
//   - catch 用 code/name 字符串判, 不用 instanceof (damo 0823 教训).
//   - 依赖环检测: setNodeDeps 对同 idea 内 deps 做 DFS 找环 (有环拒收).

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";

// ---- 类型 ----

export type IdeaStatus =
  | "germinating" // 构思中（聊着聊着还在变的默认态）
  | "exploring" // 探索中（验证任务在跑）
  | "decided" // 已定案（判据达成）
  | "shelved" // 搁置（过窗无信号，不等于否定）
  | "rejected" // 已否定（证伪，conclusion 必须挂一手证据）
  | "landed"; // 已落地（升格成 project/需求）

export const IDEA_STATUSES: IdeaStatus[] = [
  "germinating",
  "exploring",
  "decided",
  "shelved",
  "rejected",
  "landed",
];

export type IdeaNodeStatus =
  | "planned" // 计划中（未派发 = 「等派发」的意图层表达）
  | "dispatched" // 待执行（有 task 在队）
  | "running" // 执行中
  | "reviewing" // 待审核
  | "awaiting_decision" // 等决策
  | "blocked" // 卡住
  | "done" // 完成
  | "dropped"; // 放弃

export const IDEA_NODE_STATUSES: IdeaNodeStatus[] = [
  "planned",
  "dispatched",
  "running",
  "reviewing",
  "awaiting_decision",
  "blocked",
  "done",
  "dropped",
];

export type IdeaSignalKind =
  | "inquiry" // 咨询
  | "signup" // 注册
  | "payment" // 收入
  | "review" // 平台审核结果
  | "usage" // 使用
  | "other";

export const IDEA_SIGNAL_KINDS: IdeaSignalKind[] = [
  "inquiry",
  "signup",
  "payment",
  "review",
  "usage",
  "other",
];

export type WorkClass = "fix" | "feature" | "plan" | "ops";
export const WORK_CLASSES: WorkClass[] = ["fix", "feature", "plan", "ops"];

export interface Idea {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  status: IdeaStatus;
  project_id: string | null;
  pinned: number;
  hypothesis: string | null;
  success_criteria: string | null;
  deadline: string | null;
  conclusion: string | null;
  concluded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaWithCounts extends Idea {
  node_count: number;
  task_count: number;
  signal_count: number;
}

export interface IdeaNode {
  id: string;
  idea_id: string;
  title: string;
  detail: string | null;
  status: IdeaNodeStatus;
  pos_x: number | null;
  pos_y: number | null;
  sort_key: number | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaNodeWithDeps extends IdeaNode {
  depends_on: string[];
  task_count: number;
}

export interface IdeaSignal {
  id: string;
  idea_id: string;
  source: string;
  kind: IdeaSignalKind;
  value: number | null;
  note: string | null;
  ref: string | null;
  occurred_at: string | null;
  created_at: string;
}

export interface IdeaROI {
  idea_id: string;
  cost_usd: number;
  task_count: number;
  signal_count: number;
  inquiry_count: number;
  signup_count: number;
  payment_total: number;
  window_left_days: number | null;
  overdue: boolean; // deadline 已过且未出结论 = 待复盘
}

// ---- 内部工具 ----

function rowToIdea(r: any): Idea {
  return {
    id: r.id,
    owner_id: r.owner_id,
    title: r.title,
    description: r.description,
    status: r.status,
    project_id: r.project_id,
    pinned: r.pinned,
    hypothesis: r.hypothesis,
    success_criteria: r.success_criteria,
    deadline: r.deadline,
    conclusion: r.conclusion,
    concluded_at: r.concluded_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 父 idea 归属校验：不存在 / 不属于该 owner 一律 null（no existence leak，与 requirements 同口径）。 */
export function getIdea(id: string, ownerId: string): Idea | null {
  const row = getDb()
    .prepare("SELECT * FROM ideas WHERE id = ? AND owner_id = ?")
    .get(id, ownerId);
  return row ? rowToIdea(row) : null;
}

// ---- Idea CRUD ----

export interface CreateIdeaInput {
  owner_id: string;
  title: string;
  description?: string | null;
  status?: IdeaStatus;
  hypothesis?: string | null;
  success_criteria?: string | null;
  deadline?: string | null;
  project_id?: string | null;
}

export function createIdea(input: CreateIdeaInput): Idea {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO ideas (id, owner_id, title, description, status, project_id, hypothesis, success_criteria, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.owner_id,
      input.title,
      input.description ?? null,
      input.status ?? "germinating",
      input.project_id ?? null,
      input.hypothesis ?? null,
      input.success_criteria ?? null,
      input.deadline ?? null
    );
  return getIdea(id, input.owner_id)!;
}

/** 列表 + 计数（node/task/signal 各一列）。task 计数含软删外任务（weak ref 不影响）。 */
export function listIdeas(ownerId: string): IdeaWithCounts[] {
  const rows = getDb()
    .prepare(
      `SELECT i.*,
        (SELECT COUNT(*) FROM idea_nodes n WHERE n.idea_id = i.id) AS node_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.idea_id = i.id AND t.deleted_at IS NULL) AS task_count,
        (SELECT COUNT(*) FROM idea_signals s WHERE s.idea_id = i.id) AS signal_count
       FROM ideas i WHERE i.owner_id = ?
       ORDER BY i.pinned DESC, i.updated_at DESC`
    )
    .all(ownerId) as Array<any>;
  return rows.map((r) => ({ ...rowToIdea(r), node_count: r.node_count, task_count: r.task_count, signal_count: r.signal_count }));
}

const IDEA_ALLOWED_FIELDS = new Set([
  "title",
  "description",
  "status",
  "project_id",
  "pinned",
  "hypothesis",
  "success_criteria",
  "deadline",
  "conclusion",
]);

/** 白名单字段写（R128 教训：PATCH 静默吞字段 = 事故）。status 合法值校验。 */
export function updateIdea(
  id: string,
  ownerId: string,
  updates: Record<string, unknown>
): Idea | null {
  const idea = getIdea(id, ownerId);
  if (!idea) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!IDEA_ALLOWED_FIELDS.has(k)) continue;
    if (k === "status" && !IDEA_STATUSES.includes(v as IdeaStatus)) {
      throw Object.assign(new Error(`invalid idea status: ${v}`), { code: "STATUS_INVALID" });
    }
    if (k === "pinned") {
      sets.push("pinned = ?");
      vals.push(v ? 1 : 0);
      continue;
    }
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return idea;
  sets.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE ideas SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .run(...vals, id, ownerId);
  return getIdea(id, ownerId);
}

/** 出结论：写 conclusion + concluded_at + status（decided/rejected/shelved/landed）。 */
export function concludeIdea(
  id: string,
  ownerId: string,
  conclusion: string,
  status: Extract<IdeaStatus, "decided" | "rejected" | "shelved" | "landed">
): Idea | null {
  const idea = getIdea(id, ownerId);
  if (!idea) return null;
  getDb()
    .prepare(
      `UPDATE ideas SET conclusion = ?, concluded_at = datetime('now'), status = ?, updated_at = datetime('now')
       WHERE id = ? AND owner_id = ?`
    )
    .run(conclusion, status, id, ownerId);
  return getIdea(id, ownerId);
}

/** 删 idea：级联清本表族 + tasks.idea_id/node_id 置 NULL（弱引用 D3，任务本体不动）。 */
export function deleteIdea(id: string, ownerId: string): boolean {
  const idea = getIdea(id, ownerId);
  if (!idea) return false;
  const db = getDb();
  const nodeIds = (
    db.prepare("SELECT id FROM idea_nodes WHERE idea_id = ?").all(id) as Array<{ id: string }>
  ).map((r) => r.id);
  // 弱引用解挂（先于删节点，node_id 也一并清）
  db.prepare("UPDATE tasks SET idea_id = NULL WHERE idea_id = ?").run(id);
  for (const nid of nodeIds) {
    db.prepare("UPDATE tasks SET node_id = NULL WHERE node_id = ?").run(nid);
  }
  db.prepare("DELETE FROM idea_node_deps WHERE node_id IN (SELECT id FROM idea_nodes WHERE idea_id = ?)").run(id);
  db.prepare("DELETE FROM idea_nodes WHERE idea_id = ?").run(id);
  db.prepare("DELETE FROM idea_links WHERE idea_id = ? OR linked_idea_id = ?").run(id, id);
  db.prepare("DELETE FROM idea_signals WHERE idea_id = ?").run(id);
  db.prepare("DELETE FROM pin_list_items WHERE ref_type = 'idea' AND ref_id = ?").run(id);
  db.prepare("DELETE FROM ideas WHERE id = ? AND owner_id = ?").run(id, ownerId);
  return true;
}

// ---- IdeaNode CRUD ----

export function createIdeaNode(input: {
  idea_id: string;
  owner_id: string;
  title: string;
  detail?: string | null;
  deps?: string[];
  pos_x?: number | null;
  pos_y?: number | null;
}): IdeaNode | null {
  const idea = getIdea(input.idea_id, input.owner_id);
  if (!idea) return null;
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO idea_nodes (id, idea_id, title, detail, pos_x, pos_y, sort_key)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_key), 0) + 1 FROM idea_nodes WHERE idea_id = ?))`
    )
    .run(id, input.idea_id, input.title, input.detail ?? null, input.pos_x ?? null, input.pos_y ?? null, input.idea_id);
  if (input.deps && input.deps.length > 0) {
    setNodeDeps(id, input.owner_id, input.deps);
  }
  return getIdeaNode(id, input.owner_id);
}

export function getIdeaNode(id: string, ownerId: string): IdeaNode | null {
  const row = getDb()
    .prepare(
      `SELECT n.* FROM idea_nodes n JOIN ideas i ON i.id = n.idea_id
       WHERE n.id = ? AND i.owner_id = ?`
    )
    .get(id, ownerId);
  return row ? (row as IdeaNode) : null;
}

export function listIdeaNodes(ideaId: string, ownerId: string): IdeaNodeWithDeps[] {
  const idea = getIdea(ideaId, ownerId);
  if (!idea) return [];
  const rows = getDb()
    .prepare(
      `SELECT n.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.node_id = n.id AND t.deleted_at IS NULL) AS task_count
       FROM idea_nodes n WHERE n.idea_id = ?
       ORDER BY COALESCE(n.sort_key, 999999), n.created_at`
    )
    .all(ideaId) as Array<any>;
  const deps = getDb()
    .prepare(
      `SELECT d.node_id, d.depends_on FROM idea_node_deps d
       JOIN idea_nodes n ON n.id = d.node_id WHERE n.idea_id = ?`
    )
    .all(ideaId) as Array<{ node_id: string; depends_on: string }>;
  return rows.map((r) => ({
    id: r.id,
    idea_id: r.idea_id,
    title: r.title,
    detail: r.detail,
    status: r.status,
    pos_x: r.pos_x,
    pos_y: r.pos_y,
    sort_key: r.sort_key,
    created_at: r.created_at,
    updated_at: r.updated_at,
    depends_on: deps.filter((d) => d.node_id === r.id).map((d) => d.depends_on),
    task_count: r.task_count,
  }));
}

const NODE_ALLOWED_FIELDS = new Set(["title", "detail", "status", "pos_x", "pos_y", "sort_key"]);

export function updateIdeaNode(
  id: string,
  ownerId: string,
  updates: Record<string, unknown>
): IdeaNode | null {
  const node = getIdeaNode(id, ownerId);
  if (!node) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!NODE_ALLOWED_FIELDS.has(k)) continue;
    if (k === "status" && !IDEA_NODE_STATUSES.includes(v as IdeaNodeStatus)) {
      throw Object.assign(new Error(`invalid node status: ${v}`), { code: "STATUS_INVALID" });
    }
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return node;
  sets.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE idea_nodes SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals, id);
  return getIdeaNode(id, ownerId);
}

export function deleteIdeaNode(id: string, ownerId: string): boolean {
  const node = getIdeaNode(id, ownerId);
  if (!node) return false;
  const db = getDb();
  db.prepare("UPDATE tasks SET node_id = NULL WHERE node_id = ?").run(id);
  db.prepare("DELETE FROM idea_node_deps WHERE node_id = ? OR depends_on = ?").run(id, id);
  db.prepare("DELETE FROM pin_list_items WHERE ref_type = 'node' AND ref_id = ?").run(id);
  db.prepare("DELETE FROM idea_nodes WHERE id = ?").run(id);
  return true;
}

/** 设依赖（整组替换语义）。校验：deps 必须同 idea 存在且 ≠ 自身；DFS 拒环。 */
export function setNodeDeps(id: string, ownerId: string, deps: string[]): IdeaNode | null {
  const node = getIdeaNode(id, ownerId);
  if (!node) return null;
  const db = getDb();
  const valid = new Set<string>();
  for (const dep of deps) {
    if (dep === id) {
      throw Object.assign(new Error("node cannot depend on itself"), { code: "DEP_SELF" });
    }
    const d = getIdeaNode(dep, ownerId);
    if (!d || d.idea_id !== node.idea_id) {
      throw Object.assign(new Error(`dep ${dep} not in same idea`), { code: "DEP_CROSS_IDEA" });
    }
    valid.add(dep);
  }
  // 环检测：对每个新 dep，沿「其他节点的现有依赖边」走——能走到 node.id = 环。
  // （dep → … → node.id 意味着 node 依赖 dep 的同时 dep 间接依赖 node。node 自己的
  // 旧边整组废弃不参与模拟；到达 node.id 即停，故 node 的出边无关。）
  const adj = new Map<string, string[]>();
  const depRows = db
    .prepare(
      `SELECT d.node_id, d.depends_on FROM idea_node_deps d JOIN idea_nodes n ON n.id = d.node_id WHERE n.idea_id = ?`
    )
    .all(node.idea_id) as Array<{ node_id: string; depends_on: string }>;
  for (const r of depRows) {
    if (!adj.has(r.node_id)) adj.set(r.node_id, []);
    adj.get(r.node_id)!.push(r.depends_on);
  }
  for (const dep of valid) {
    const seen = new Set<string>();
    const stack = [dep];
    let cyclic = false;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === node.id) {
        cyclic = true;
        break;
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) ?? []) stack.push(next);
    }
    if (cyclic) {
      throw Object.assign(new Error(`dependency cycle via ${dep}`), { code: "DEP_CYCLE" });
    }
  }
  db.prepare("DELETE FROM idea_node_deps WHERE node_id = ?").run(id);
  const ins = db.prepare("INSERT INTO idea_node_deps (node_id, depends_on) VALUES (?, ?)");
  for (const dep of valid) ins.run(id, dep);
  db.prepare("UPDATE idea_nodes SET updated_at = datetime('now') WHERE id = ?").run(id);
  return getIdeaNode(id, ownerId);
}

// ---- IdeaLink（球间关联）----

export function addIdeaLink(
  ownerId: string,
  ideaId: string,
  linkedIdeaId: string,
  relation = "related",
  weight = 1
): boolean {
  if (ideaId === linkedIdeaId) {
    throw Object.assign(new Error("cannot link idea to itself"), { code: "LINK_SELF" });
  }
  if (!getIdea(ideaId, ownerId) || !getIdea(linkedIdeaId, ownerId)) return false;
  getDb()
    .prepare(
      `INSERT INTO idea_links (idea_id, linked_idea_id, relation, weight) VALUES (?, ?, ?, ?)
       ON CONFLICT (idea_id, linked_idea_id) DO UPDATE SET relation = excluded.relation, weight = excluded.weight`
    )
    .run(ideaId, linkedIdeaId, relation, weight);
  return true;
}

export function removeIdeaLink(ownerId: string, ideaId: string, linkedIdeaId: string): boolean {
  const a = getIdea(ideaId, ownerId);
  const b = getIdea(linkedIdeaId, ownerId);
  if (!a || !b) return false;
  getDb()
    .prepare("DELETE FROM idea_links WHERE idea_id = ? AND linked_idea_id = ?")
    .run(ideaId, linkedIdeaId);
  return true;
}

export function listIdeaLinks(ownerId: string): Array<{
  idea_id: string;
  linked_idea_id: string;
  relation: string;
  weight: number;
}> {
  return getDb()
    .prepare(
      `SELECT l.idea_id, l.linked_idea_id, l.relation, l.weight FROM idea_links l
       JOIN ideas a ON a.id = l.idea_id JOIN ideas b ON b.id = l.linked_idea_id
       WHERE a.owner_id = ? AND b.owner_id = ?`
    )
    .all(ownerId, ownerId) as any;
}

// ---- IdeaSignal（反馈信号）----

export function addIdeaSignal(input: {
  idea_id: string;
  owner_id: string;
  source?: string;
  kind: IdeaSignalKind;
  value?: number | null;
  note?: string | null;
  ref?: string | null;
  occurred_at?: string | null;
}): IdeaSignal | null {
  const idea = getIdea(input.idea_id, input.owner_id);
  if (!idea) return null;
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO idea_signals (id, idea_id, source, kind, value, note, ref, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.idea_id,
      input.source ?? "manual",
      input.kind,
      input.value ?? null,
      input.note ?? null,
      input.ref ?? null,
      input.occurred_at ?? null
    );
  return getIdeaSignal(id, input.owner_id);
}

export function getIdeaSignal(id: string, ownerId: string): IdeaSignal | null {
  const row = getDb()
    .prepare(
      `SELECT s.* FROM idea_signals s JOIN ideas i ON i.id = s.idea_id WHERE s.id = ? AND i.owner_id = ?`
    )
    .get(id, ownerId);
  return row ? (row as IdeaSignal) : null;
}

export function listIdeaSignals(ideaId: string, ownerId: string): IdeaSignal[] {
  const idea = getIdea(ideaId, ownerId);
  if (!idea) return [];
  return getDb()
    .prepare("SELECT * FROM idea_signals WHERE idea_id = ? ORDER BY COALESCE(occurred_at, created_at) DESC")
    .all(ideaId) as any;
}

export function deleteIdeaSignal(id: string, ownerId: string): boolean {
  const sig = getIdeaSignal(id, ownerId);
  if (!sig) return false;
  getDb().prepare("DELETE FROM idea_signals WHERE id = ?").run(id);
  return true;
}

/** 收益面板数据（归因回路核心）：投入侧 = 任务成本汇总，信号侧 = 按 kind 汇总。 */
export function getIdeaROI(ideaId: string, ownerId: string): IdeaROI | null {
  const idea = getIdea(ideaId, ownerId);
  if (!idea) return null;
  const db = getDb();
  const cost = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM tasks WHERE idea_id = ? AND deleted_at IS NULL"
    )
    .get(ideaId) as { c: number; n: number };
  const sigs = db
    .prepare(
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM idea_signals WHERE idea_id = ? GROUP BY kind`
    )
    .all(ideaId) as Array<{ kind: string; n: number; v: number }>;
  const byKind = new Map(sigs.map((s) => [s.kind, s]));
  let windowLeftDays: number | null = null;
  let overdue = false;
  if (idea.deadline) {
    const left = Math.ceil((new Date(idea.deadline).getTime() - Date.now()) / 86400000);
    windowLeftDays = left;
    if (left < 0 && !idea.concluded_at) overdue = true;
  }
  return {
    idea_id: ideaId,
    cost_usd: cost.c,
    task_count: cost.n,
    signal_count: sigs.reduce((a, s) => a + s.n, 0),
    inquiry_count: byKind.get("inquiry")?.n ?? 0,
    signup_count: byKind.get("signup")?.n ?? 0,
    payment_total: byKind.get("payment")?.v ?? 0,
    window_left_days: windowLeftDays,
    overdue,
  };
}
