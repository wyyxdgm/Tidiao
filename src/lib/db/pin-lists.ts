// pin-lists 模块 —— 人工分拣列表（任意标题、人放 AI 也放）+ 积木控制台布局
// (idea-canvas P0/P3, docs/plans/idea-canvas.md §3 v522/v523).
//
// 设计要点:
//   - 多态条目 (D4): ref_type task|idea|node|plan (v530 加 plan, ref_id=仓内相对路径),
//     UNIQUE(list,ref_type,ref_id) 防重.
//   - added_by 归因: damo | agent:<项目名> —— 「这个列表是谁塞的」可追溯.
//   - 列表渲染需要把 ref 解引用成真对象 (标题/状态徽章): listItemsWithRefs 一次
//     批量 join, 不循环单查 (N+1 反模式, idea-canvas.md §8).
//
// 关注点:
//   - 所有操作带 owner 校验: list 归属 + ref 对象归属 (task/idea 各查各的 owner,
//     防越权把别人的 task 塞进自己的列表). plan 是仓内静态文档无 owner 列, 只校验
//     文件存在 (仓根 = process.cwd(), 三机部署都从仓根起服务).
//   - sort_key 用「尾部追加」默认 (MAX+1), 重排走 reorderItems 整组替换.

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

// ---- 类型 ----

export type PinRefType = "task" | "idea" | "node" | "plan";
export const PIN_REF_TYPES: PinRefType[] = ["task", "idea", "node", "plan"];

export interface PinList {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  project_id: string | null; // v524: 挂哪个项目 (NULL = 全局)
  data_schema: string | null; // v524: 条目扩展数据 schema (JSON 字符串: {properties, required})
  sort_key: number | null;
  created_at: string;
  updated_at: string;
}

export interface PinListItem {
  id: string;
  list_id: string;
  ref_type: PinRefType;
  ref_id: string;
  note: string | null;
  data: string | null; // v524: 条目扩展数据 (JSON object 字符串, 按 list.data_schema 校验)
  sort_key: number | null;
  added_by: string | null;
  created_at: string;
}

/** schema 轻校验: data 必须是 JSON object; schema.required 键必须存在; 已声明属性的类型
 *  (string/number/boolean) 校验。未声明键放行 (schema 是渲染约定不是铁笼)。
 *  返回错误文案, null = 通过。完整 JSON Schema 校验不引入依赖, 这层够 UI+AI 用。 */
export function validateDataAgainstSchema(dataJson: string | null, schemaJson: string | null): string | null {
  if (dataJson === null) return null; // 无 data 合法 (扩展字段可选)
  let data: any, schema: any = null;
  try { data = JSON.parse(dataJson); } catch { return "data 不是合法 JSON"; }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "data 必须是 JSON object";
  }
  if (schemaJson) {
    try { schema = JSON.parse(schemaJson); } catch { return "列表 data_schema 不是合法 JSON (先修 schema)"; }
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (data[key] === undefined || data[key] === null || data[key] === "") {
        return `缺少必填字段: ${key}`;
      }
    }
    const props = schema.properties ?? {};
    for (const [key, spec] of Object.entries<any>(props)) {
      if (data[key] === undefined || data[key] === null) continue;
      const t = spec.type;
      if (t === "string" && typeof data[key] !== "string") return `字段 ${key} 应为 string`;
      if (t === "number" && typeof data[key] !== "number") return `字段 ${key} 应为 number`;
      if (t === "boolean" && typeof data[key] !== "boolean") return `字段 ${key} 应为 boolean`;
    }
  }
  return null;
}

/** 解引用后的渲染条目：ref 对象不在了（被删）→ missing=true，渲染层显示灰条并可一键清。 */
export interface PinListItemWithRef extends PinListItem {
  title: string;
  status: string | null;
  missing: boolean;
  data: string | null;
}

// ---- List CRUD ----

export function createPinList(input: {
  owner_id: string;
  title: string;
  description?: string | null;
  project_id?: string | null; // v524: 项目级列表 (NULL = 全局)
  data_schema?: string | null; // v524: 条目数据 schema (JSON 字符串)
}): PinList {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO pin_lists (id, owner_id, title, description, project_id, data_schema, sort_key)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_key), 0) + 1 FROM pin_lists WHERE owner_id = ?))`
    )
    .run(id, input.owner_id, input.title, input.description ?? null, input.project_id ?? null, input.data_schema ?? null, input.owner_id);
  return getPinList(id, input.owner_id)!;
}

export function getPinList(id: string, ownerId: string): PinList | null {
  const row = getDb()
    .prepare("SELECT * FROM pin_lists WHERE id = ? AND owner_id = ?")
    .get(id, ownerId);
  return row ? (row as PinList) : null;
}

export function listPinLists(ownerId: string, projectId?: string | null): PinList[] {
  if (projectId === undefined) {
    return getDb()
      .prepare("SELECT * FROM pin_lists WHERE owner_id = ? ORDER BY COALESCE(sort_key, 999999), created_at")
      .all(ownerId) as any;
  }
  if (projectId === null) {
    // 只全局 (project_id IS NULL)
    return getDb()
      .prepare("SELECT * FROM pin_lists WHERE owner_id = ? AND project_id IS NULL ORDER BY COALESCE(sort_key, 999999), created_at")
      .all(ownerId) as any;
  }
  return getDb()
    .prepare("SELECT * FROM pin_lists WHERE owner_id = ? AND (project_id = ? OR project_id IS NULL) ORDER BY COALESCE(sort_key, 999999), created_at")
    .all(ownerId, projectId) as any;
}

const LIST_ALLOWED_FIELDS = new Set(["title", "description", "sort_key", "project_id", "data_schema"]);

export function updatePinList(
  id: string,
  ownerId: string,
  updates: Record<string, unknown>
): PinList | null {
  const list = getPinList(id, ownerId);
  if (!list) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!LIST_ALLOWED_FIELDS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return list;
  sets.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE pin_lists SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .run(...vals, id, ownerId);
  return getPinList(id, ownerId);
}

/** 删列表：条目只删关联行，不动 ref 对象本体。 */
export function deletePinList(id: string, ownerId: string): boolean {
  const list = getPinList(id, ownerId);
  if (!list) return false;
  getDb().prepare("DELETE FROM pin_list_items WHERE list_id = ?").run(id);
  getDb().prepare("DELETE FROM pin_lists WHERE id = ? AND owner_id = ?").run(id, ownerId);
  return true;
}

// ---- Items ----

/** 校验 ref 归属：对象必须存在且属于该 owner。返回 [ok, 缺哪个]。 */
function validateRef(ownerId: string, refType: PinRefType, refId: string): boolean {
  const db = getDb();
  if (refType === "task") {
    return !!db.prepare("SELECT id FROM tasks WHERE id = ? AND owner_id = ?").get(refId, ownerId);
  }
  if (refType === "idea") {
    return !!db.prepare("SELECT id FROM ideas WHERE id = ? AND owner_id = ?").get(refId, ownerId);
  }
  if (refType === "plan") {
    // v530: 计划文档条目, ref_id = 仓内相对路径 (docs/plans/x.md)。仓内静态文档
    // 无 owner 列 → 只校验文件存在。🔴 ref_id 必须是仓内相对路径且不含 .. 穿越。
    if (refId.includes("..") || path.isAbsolute(refId)) return false;
    return fs.existsSync(path.join(process.cwd(), refId));
  }
  // node: 经父 idea 判 owner
  return !!db
    .prepare(
      "SELECT n.id FROM idea_nodes n JOIN ideas i ON i.id = n.idea_id WHERE n.id = ? AND i.owner_id = ?"
    )
    .get(refId, ownerId);
}

export function addPinListItem(input: {
  list_id: string;
  owner_id: string;
  ref_type: PinRefType;
  ref_id: string;
  note?: string | null;
  data?: string | null; // v524: JSON object 字符串, 按 list.data_schema 校验
  added_by?: string | null;
}): PinListItem | null {
  const list = getPinList(input.list_id, input.owner_id);
  if (!list) return null;
  if (!validateRef(input.owner_id, input.ref_type, input.ref_id)) {
    throw Object.assign(new Error(`ref ${input.ref_type}:${input.ref_id} not found or not owned`), {
      code: "REF_NOT_FOUND",
    });
  }
  const dataErr = validateDataAgainstSchema(input.data ?? null, list.data_schema);
  if (dataErr) {
    throw Object.assign(new Error(dataErr), { code: "DATA_INVALID" });
  }
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO pin_list_items (id, list_id, ref_type, ref_id, note, data, sort_key, added_by)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_key), 0) + 1 FROM pin_list_items WHERE list_id = ?), ?)`
    )
    .run(
      id,
      input.list_id,
      input.ref_type,
      input.ref_id,
      input.note ?? null,
      input.data ?? null,
      input.list_id,
      input.added_by ?? "damo"
    );
  return getPinListItem(id, input.owner_id);
}

/** 更新条目扩展数据 (AI 遵循 schema 整理数据的写入口)。整组替换语义。 */
export function updatePinListItemData(id: string, ownerId: string, dataJson: string): PinListItem | null {
  const item = getPinListItem(id, ownerId);
  if (!item) return null;
  const list = getPinList(item.list_id, ownerId);
  const dataErr = validateDataAgainstSchema(dataJson, list?.data_schema ?? null);
  if (dataErr) {
    throw Object.assign(new Error(dataErr), { code: "DATA_INVALID" });
  }
  getDb().prepare("UPDATE pin_list_items SET data = ? WHERE id = ?").run(dataJson, id);
  return getPinListItem(id, ownerId);
}

export function getPinListItem(id: string, ownerId: string): PinListItem | null {
  const row = getDb()
    .prepare(
      `SELECT li.* FROM pin_list_items li JOIN pin_lists l ON l.id = li.list_id
       WHERE li.id = ? AND l.owner_id = ?`
    )
    .get(id, ownerId);
  return row ? (row as PinListItem) : null;
}

export function removePinListItem(id: string, ownerId: string): boolean {
  const item = getPinListItem(id, ownerId);
  if (!item) return false;
  getDb().prepare("DELETE FROM pin_list_items WHERE id = ?").run(id);
  return true;
}

/** 重排（整组替换语义）：入参 = 该列表全部 item id 的目标顺序。 */
export function reorderPinListItems(listId: string, ownerId: string, itemIds: string[]): boolean {
  const list = getPinList(listId, ownerId);
  if (!list) return false;
  const db = getDb();
  const tx = db.transaction(() => {
    const stmt = db.prepare("UPDATE pin_list_items SET sort_key = ? WHERE id = ? AND list_id = ?");
    itemIds.forEach((itemId, idx) => stmt.run(idx + 1, itemId, listId));
    db.prepare("UPDATE pin_lists SET updated_at = datetime('now') WHERE id = ?").run(listId);
  });
  tx();
  return true;
}

/** 列表渲染：批量解引用（每 ref_type 一条 IN 查询，不循环单查）。missing = ref 已删。 */
export function listItemsWithRefs(listId: string, ownerId: string): PinListItemWithRef[] {
  const list = getPinList(listId, ownerId);
  if (!list) return [];
  const db = getDb();
  const items = db
    .prepare("SELECT * FROM pin_list_items WHERE list_id = ? ORDER BY COALESCE(sort_key, 999999), created_at")
    .all(listId) as PinListItem[];
  const taskIds = items.filter((i) => i.ref_type === "task").map((i) => i.ref_id);
  const ideaIds = items.filter((i) => i.ref_type === "idea").map((i) => i.ref_id);
  const nodeIds = items.filter((i) => i.ref_type === "node").map((i) => i.ref_id);
  const titles = new Map<string, { title: string; status: string | null }>();
  const fill = (rows: Array<any>, type: string) => {
    for (const r of rows) titles.set(`${type}:${r.id}`, { title: r.title, status: r.status ?? null });
  };
  if (taskIds.length > 0) {
    const rows = db
      .prepare(`SELECT id, title, status FROM tasks WHERE id IN (${taskIds.map(() => "?").join(",")}) AND owner_id = ?`)
      .all(...taskIds, ownerId);
    fill(rows, "task");
  }
  if (ideaIds.length > 0) {
    const rows = db
      .prepare(`SELECT id, title, status FROM ideas WHERE id IN (${ideaIds.map(() => "?").join(",")}) AND owner_id = ?`)
      .all(...ideaIds, ownerId);
    fill(rows, "idea");
  }
  if (nodeIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT n.id, n.title, n.status FROM idea_nodes n JOIN ideas i ON i.id = n.idea_id
         WHERE n.id IN (${nodeIds.map(() => "?").join(",")}) AND i.owner_id = ?`
      )
      .all(...nodeIds, ownerId);
    fill(rows, "node");
  }
  // v530: plan 条目不查 DB (静态文档无 title/status 列), 渲染层直接用
  //   note 或 ref_id (路径) 当标题 —— 在下方 map 时兜底。
  return items.map((i) => {
    const hit = titles.get(`${i.ref_type}:${i.ref_id}`);
    const fallbackTitle = i.ref_type === "plan" ? i.ref_id : "(已删除)";
    return {
      ...i,
      title: hit?.title ?? (i.ref_type === "plan" ? i.note || fallbackTitle : fallbackTitle),
      status: hit?.status ?? null,
      missing: !hit && i.ref_type !== "plan",
    };
  });
}

// ---- Dashboard blocks（积木控制台布局，P3）----

export interface DashboardBlock {
  id: string;
  owner_id: string;
  block_type: string;
  ref_id: string | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  config: string | null;
  sort_key: number | null;
}

const BLOCK_TYPES = new Set(["list", "idea_canvas", "console", "stats"]);

export function listDashboardBlocks(ownerId: string): DashboardBlock[] {
  return getDb()
    .prepare(
      "SELECT * FROM dashboard_blocks WHERE owner_id = ? ORDER BY COALESCE(sort_key, 999999), created_at"
    )
    .all(ownerId) as any;
}

/** 整组替换（前端拖完一把保存，原子事务）。 */
export function saveDashboardBlocks(
  ownerId: string,
  blocks: Array<{
    id?: string;
    block_type: string;
    ref_id?: string | null;
    x?: number | null;
    y?: number | null;
    w?: number | null;
    h?: number | null;
    config?: string | null;
    sort_key?: number | null;
  }>
): DashboardBlock[] {
  const db = getDb();
  for (const b of blocks) {
    if (!BLOCK_TYPES.has(b.block_type)) {
      throw Object.assign(new Error(`invalid block_type: ${b.block_type}`), { code: "BLOCK_TYPE_INVALID" });
    }
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM dashboard_blocks WHERE owner_id = ?").run(ownerId);
    const ins = db.prepare(
      `INSERT INTO dashboard_blocks (id, owner_id, block_type, ref_id, x, y, w, h, config, sort_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    blocks.forEach((b, idx) => {
      ins.run(
        b.id ?? uuidv4(),
        ownerId,
        b.block_type,
        b.ref_id ?? null,
        b.x ?? null,
        b.y ?? null,
        b.w ?? null,
        b.h ?? null,
        b.config ?? null,
        b.sort_key ?? idx + 1
      );
    });
  });
  tx();
  return listDashboardBlocks(ownerId);
}
