// LLM configuration CRUD — per-user, per-project, and admin-level.
// v50: 从「每 owner 一个配置」改成「每 owner 多个配置 + name + is_default」。
//   - llm_configs: UNIQUE (owner_type, owner_id, name) + partial UNIQUE INDEX on
//     (owner_type, owner_id) WHERE is_default=1 (保证每 owner 至多一份默认)
//   - tasks.llm_config_id / templates.llm_config_id: 显式选定的配置 FK
//   - 解析链: env → admin default → user default → project default → task.llm_config_id
//     → template.llm_config_id → env（向后兼容 tasks.model override）
// API key 加密落库 (AES-256-GCM, src/lib/crypto.ts).

import { getDb } from "./index";
import { getUserById } from "./users";
import { v4 as uuidv4 } from "uuid";
import { encrypt, decrypt, maskApiKey } from "../crypto";
import { hasAnyPrice, priceCoefficient, type ModelPrices } from "../runtime/cost-estimate";
import { getSetting, setSetting } from "./settings";

const ADMIN_OWNER_ID = "system";

export type LlmConfigType = "anthropic"; // 协议类型, 预留 openai 等扩展
export type LlmOwnerType = "user" | "project" | "admin";

export interface LlmConfig {
  id: string;
  owner_type: LlmOwnerType;
  owner_id: string;
  name: string;
  type: LlmConfigType;
  api_key_encrypted: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  base_url: string | null;
  model: string | null;
  is_default: number;
  /** v514 (R175): 有序 fallback 链, JSON 数组 config id. NULL = 无链. */
  fallback_ids: string | null;
  /** v514 (R175): 模型视觉能力. NULL = 未设置 (按模型名启发式推断), 0/1 = 显式. */
  supports_vision: number | null;
  /** v519 (R239): per-model 单价 (USD/百万token). NULL = 未配置 (记账回落原机制). */
  price_in: number | null;
  price_out: number | null;
  price_cache_read: number | null;
  created_at: string;
  updated_at: string;
}

/** Safe shape returned to the frontend — never exposes encrypted key. */
export interface LlmConfigSafe {
  id: string;
  owner_type: LlmOwnerType;
  owner_id: string;
  name: string;
  type: LlmConfigType;
  api_key_masked: string | null;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
  fallback_ids: string[];
  supports_vision: boolean | null;
  /** v519 (R239): 单价 (USD/百万token), null = 未配置. 非密钥, 前端可直接回显编辑. */
  price_in: number | null;
  price_out: number | null;
  price_cache_read: number | null;
  /** v519: 模型系数 = 本配置基准价 / 基准配置基准价. null = 基准未设或未配价. */
  coefficient: number | null;
}

/** Input for create/update. `api_key` is plaintext — will be encrypted before storage. */
export interface LlmConfigInput {
  name?: string;
  type?: LlmConfigType;
  api_key?: string;          // plaintext, will be encrypted; omit to keep existing
  clear_api_key?: boolean;   // true to delete the stored key
  base_url?: string | null;
  model?: string | null;
  /** v514: 有序 fallback 链 (config id 数组). null/[] = 清空链. */
  fallback_ids?: string[] | null;
  /** v514: 视觉能力显式标记. null = 回到「未设置」(启发式推断). */
  supports_vision?: boolean | null;
  /** v519 (R239): 单价 (USD/百万token). undefined = 不动, null = 清空, 数字 = 设置. */
  price_in?: number | null;
  price_out?: number | null;
  price_cache_read?: number | null;
}

/** Aggregated list returned to authenticated user; marks the source so the UI
 *  can show "[平台]" vs "[我的]" + which configs are reachable based on grant. */
export interface AvailableLlmConfig {
  id: string;
  source: "self" | "admin_grant"; // self = owned by caller; admin_grant = admin-owned & user is granted
  name: string;
  type: LlmConfigType;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
  fallback_ids: string[];
  supports_vision: boolean | null;
}

// ---- 单行查询 ----

export function getLlmConfigById(id: string): LlmConfig | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM llm_configs WHERE id = ?`).get(id) as LlmConfig | undefined;
  return row ?? null;
}

export function getDefaultLlmConfig(
  ownerType: LlmOwnerType,
  ownerId: string
): LlmConfig | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM llm_configs WHERE owner_type = ? AND owner_id = ? AND is_default = 1`
    )
    .get(ownerType, ownerId) as LlmConfig | undefined;
  return row ?? null;
}

// ---- 列表 ----

export function listLlmConfigs(
  ownerType: LlmOwnerType,
  ownerId: string
): LlmConfig[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM llm_configs WHERE owner_type = ? AND owner_id = ?
       ORDER BY is_default DESC, name ASC`
    )
    .all(ownerType, ownerId) as LlmConfig[];
}

/** Aggregated list visible to a user: 自己的 + (若授权) 平台所有.
 *  收回授权 = self only. Admins always see admin's configs as self (they ARE admin). */
export function listAvailableLlmConfigs(
  userId: string,
  userRole: string
): AvailableLlmConfig[] {
  const selfRows = listLlmConfigs("user", userId).map((c): AvailableLlmConfig => ({
    id: c.id,
    source: "self",
    name: c.name,
    type: c.type,
    has_api_key: !!c.api_key_encrypted,
    base_url: c.base_url,
    model: c.model,
    is_default: c.is_default === 1,
    fallback_ids: parseFallbackIds(c.fallback_ids),
    supports_vision:
      c.supports_vision === 1 ? true : c.supports_vision === 0 ? false : null,
  }));

  if (!isUserGrantedAdminLlm(userId, userRole)) {
    return selfRows;
  }

  const adminRows = listLlmConfigs("admin", ADMIN_OWNER_ID).map((c): AvailableLlmConfig => ({
    id: c.id,
    source: "admin_grant",
    name: c.name,
    type: c.type,
    has_api_key: !!c.api_key_encrypted,
    base_url: c.base_url,
    model: c.model,
    is_default: c.is_default === 1,
    fallback_ids: parseFallbackIds(c.fallback_ids),
    supports_vision:
      c.supports_vision === 1 ? true : c.supports_vision === 0 ? false : null,
  }));

  return [...selfRows, ...adminRows];
}

// ---- 创建 / 更新 / 删除 ----

export class LlmConfigError extends Error {
  constructor(message: string, public code: "name_required" | "name_conflict" | "not_found" | "default_in_use" | "fallback_invalid") {
    super(message);
    this.name = "LlmConfigError";
  }
}

// ---- v514 (R175): fallback 链 + 视觉能力 ----

/** 链成员上限 (不含主配置). 防误配超长链拖慢失败路径. */
export const MAX_FALLBACK_ENTRIES = 5;

/**
 * 功能: 解析 fallback_ids 列 (JSON 数组字符串) 为 string[].
 * 关注点: 容错 — 非法 JSON / 非数组 / 元素非字符串一律视为无链 (老行 NULL 同义),
 *   不抛错. 写入侧由 validateFallbackIds 把关, 读取侧只兜底.
 */
export function parseFallbackIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/**
 * 功能: 校验 fallback 链写入值 — 每个 id 存在 / 同 owner / 非自身 / 无重复 / ≤ 上限.
 * 关注点: 链是「锚在本配置」的扁平有序列表 (不做递归接力), 唯一环风险 = 引自己,
 *   直接拒. 返回规整后的数组 (去重保序).
 */
export function validateFallbackIds(
  ownerType: LlmOwnerType,
  ownerId: string,
  selfId: string | null,
  ids: unknown
): string[] {
  if (ids === null || ids === undefined) return [];
  if (!Array.isArray(ids)) {
    throw new LlmConfigError("fallback_ids must be an array of config ids", "fallback_invalid");
  }
  const db = getDb();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) {
      throw new LlmConfigError("fallback_ids entries must be non-empty strings", "fallback_invalid");
    }
    if (id === selfId) {
      throw new LlmConfigError("fallback_ids cannot include the config itself", "fallback_invalid");
    }
    if (seen.has(id)) continue; // 去重保序
    const row = db
      .prepare(`SELECT owner_type, owner_id FROM llm_configs WHERE id = ?`)
      .get(id) as { owner_type: string; owner_id: string } | undefined;
    if (!row || row.owner_type !== ownerType || row.owner_id !== ownerId) {
      throw new LlmConfigError(
        `fallback_ids entry '${id}' not found under same owner`,
        "fallback_invalid"
      );
    }
    seen.add(id);
    out.push(id);
    if (out.length > MAX_FALLBACK_ENTRIES) {
      throw new LlmConfigError(
        `fallback_ids exceeds max ${MAX_FALLBACK_ENTRIES} entries`,
        "fallback_invalid"
      );
    }
  }
  return out;
}

/**
 * 功能: 按模型名保守推断视觉能力 (R175).
 * 关注点: 保守优先 — 拿不准返回 null (UI 显示「未知」), 不猜 true 导致带图任务误换模型.
 *   命中规则: claude 系全支持; 名字含 vl / vision / 4v / gpt-4o / gpt-4.1 / gpt-5 /
 *   gemini / o3 / o4 视为支持. 显式 supports_vision 列永远优先于本启发式.
 */
export function inferVisionFromModelName(model: string | null | undefined): boolean | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("claude")) return true;
  if (/(\b|[-_])vl(\b|[-_]|$)/.test(m) || m.includes("vision") || m.includes("-4v") || m.includes("gpt-4o") || m.includes("gpt-4.1") || m.includes("gpt-5") || m.includes("gemini") || m.includes("-o3") || m.includes("-o4")) return true;
  return null;
}

/**
 * 功能: 配置的有效视觉能力 = 显式列 (0/1) 优先, NULL 时按模型名启发式.
 */
export function effectiveVisionSupport(config: {
  supports_vision: number | null;
  model: string | null;
}): boolean | null {
  if (config.supports_vision === 1) return true;
  if (config.supports_vision === 0) return false;
  return inferVisionFromModelName(config.model);
}

export function createLlmConfig(
  ownerType: LlmOwnerType,
  ownerId: string,
  input: LlmConfigInput
): LlmConfig {
  if (!input.name || !input.name.trim()) {
    throw new LlmConfigError("name is required", "name_required");
  }
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM llm_configs WHERE owner_type = ? AND owner_id = ? AND name = ?`
    )
    .get(ownerType, ownerId, input.name);
  if (existing) {
    throw new LlmConfigError(
      `name '${input.name}' already exists for this owner`,
      "name_conflict"
    );
  }

  // 加密 api_key (可选)
  let apiKeyEncrypted: string | null = null;
  let apiKeyIv: string | null = null;
  let apiKeyTag: string | null = null;
  if (input.api_key) {
    const enc = encrypt(input.api_key);
    apiKeyEncrypted = enc.encrypted;
    apiKeyIv = enc.iv;
    apiKeyTag = enc.tag;
  }

  const id = uuidv4();
  const isFirst = db
    .prepare(`SELECT COUNT(*) AS n FROM llm_configs WHERE owner_type = ? AND owner_id = ?`)
    .get(ownerType, ownerId) as { n: number };
  // 第一份自动默认; 后续默认由 setDefaultLlmConfig 显式设
  const isDefault = isFirst.n === 0 ? 1 : 0;

  // v514: fallback 链校验 (新行 id 未知, 自引用不可能, 其余规则同 update)
  const fallbackIds = validateFallbackIds(ownerType, ownerId, null, input.fallback_ids ?? []);
  const supportsVision =
    input.supports_vision === true ? 1 : input.supports_vision === false ? 0 : null;
  // v519: 单价 (负数/非有限值一律归 null —— 坏价会让记账悄悄出错钱)
  const priceIn = normalizePrice(input.price_in);
  const priceOut = normalizePrice(input.price_out);
  const priceCacheRead = normalizePrice(input.price_cache_read);

  db.prepare(`
    INSERT INTO llm_configs
      (id, owner_type, owner_id, name, type, api_key_encrypted, api_key_iv, api_key_tag,
       base_url, model, is_default, fallback_ids, supports_vision,
       price_in, price_out, price_cache_read)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, ownerType, ownerId, input.name.trim(),
    input.type || "anthropic",
    apiKeyEncrypted, apiKeyIv, apiKeyTag,
    input.base_url || null,
    input.model || null,
    isDefault,
    fallbackIds.length > 0 ? JSON.stringify(fallbackIds) : null,
    supportsVision,
    priceIn, priceOut, priceCacheRead
  );

  return getLlmConfigById(id)!;
}

export function updateLlmConfig(
  id: string,
  input: LlmConfigInput
): LlmConfig {
  const db = getDb();
  const existing = getLlmConfigById(id);
  if (!existing) {
    throw new LlmConfigError(`config ${id} not found`, "not_found");
  }

  // 重名校验 (若改名)
  if (input.name !== undefined && input.name !== existing.name) {
    if (!input.name.trim()) {
      throw new LlmConfigError("name is required", "name_required");
    }
    const conflict = db
      .prepare(
        `SELECT id FROM llm_configs
         WHERE owner_type = ? AND owner_id = ? AND name = ? AND id != ?`
      )
      .get(existing.owner_type, existing.owner_id, input.name, id);
    if (conflict) {
      throw new LlmConfigError(
        `name '${input.name}' already exists for this owner`,
        "name_conflict"
      );
    }
  }

  // 加密字段
  let apiKeyEncrypted = existing.api_key_encrypted;
  let apiKeyIv = existing.api_key_iv;
  let apiKeyTag = existing.api_key_tag;
  if (input.clear_api_key) {
    apiKeyEncrypted = null;
    apiKeyIv = null;
    apiKeyTag = null;
  } else if (input.api_key !== undefined) {
    const enc = encrypt(input.api_key);
    apiKeyEncrypted = enc.encrypted;
    apiKeyIv = enc.iv;
    apiKeyTag = enc.tag;
  }

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const type = input.type ?? existing.type;
  const baseUrl = input.base_url !== undefined ? (input.base_url || null) : existing.base_url;
  const model = input.model !== undefined ? (input.model || null) : existing.model;

  // v514: fallback 链 / 视觉能力 (undefined = 不动, null/[] = 清链)
  const fallbackIds =
    input.fallback_ids !== undefined
      ? validateFallbackIds(existing.owner_type, existing.owner_id, existing.id, input.fallback_ids)
      : parseFallbackIds(existing.fallback_ids);
  const supportsVision =
    input.supports_vision === undefined
      ? existing.supports_vision
      : input.supports_vision === true
        ? 1
        : input.supports_vision === false
          ? 0
          : null;

  // v519: 单价 (undefined = 不动, null = 清空, 数字 = 校验后写入)
  const priceIn =
    input.price_in === undefined ? existing.price_in : normalizePrice(input.price_in);
  const priceOut =
    input.price_out === undefined ? existing.price_out : normalizePrice(input.price_out);
  const priceCacheRead =
    input.price_cache_read === undefined
      ? existing.price_cache_read
      : normalizePrice(input.price_cache_read);

  db.prepare(`
    UPDATE llm_configs
    SET name = ?, type = ?, api_key_encrypted = ?, api_key_iv = ?, api_key_tag = ?,
        base_url = ?, model = ?, fallback_ids = ?, supports_vision = ?,
        price_in = ?, price_out = ?, price_cache_read = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name, type, apiKeyEncrypted, apiKeyIv, apiKeyTag, baseUrl, model,
    fallbackIds.length > 0 ? JSON.stringify(fallbackIds) : null,
    supportsVision,
    priceIn, priceOut, priceCacheRead,
    id
  );

  return getLlmConfigById(id)!;
}

export function deleteLlmConfigById(id: string): boolean {
  const db = getDb();
  const existing = getLlmConfigById(id);
  if (!existing) return false;
  // R215: 默认行 / 最后一份也允许删 (原先 throw default_in_use 挡掉, 导致只剩一份时
  // 死锁删不掉). 删光后 getDefaultLlmConfig 返 null, 运行时走平台默认配置 fallback.
  const result = db.prepare(`DELETE FROM llm_configs WHERE id = ?`).run(id);
  return result.changes > 0;
}

/** 复制一份配置 (整行拷贝 + 重命名为 `${src.name}-拷贝`, 冲突时自动 `-拷贝-2/-3/...`).
 *  api_key 加密字段直接复用 (源与副本共享同一 key); is_default 强制为 0
 *  (不抢源行的默认位); 其它字段 (type/base_url/model) 完整复制.
 *  用途: 设置页点「拷贝」基于已有改; 后续人工编辑即可.
 *  关注点: 创建走 `createLlmConfig` 自动判定 is_default=1 (因为 owner 暂无新行),
 *    这里不能用它 (会夺默认位), 改写独立 INSERT 强制 is_default=0. */
export function duplicateLlmConfig(id: string): LlmConfig {
  const db = getDb();
  const src = getLlmConfigById(id);
  if (!src) {
    throw new LlmConfigError(`config ${id} not found`, "not_found");
  }
  // 生成不冲突的 name: name / name-拷贝 / name-拷贝-2 / ...
  let candidate = `${src.name}-拷贝`;
  let suffix = 2;
  // 安全上限: 防止死循环 (极端情况下同一 owner 有 100+ 行同名同后缀)
  while (suffix < 1000) {
    const conflict = db
      .prepare(
        `SELECT id FROM llm_configs WHERE owner_type = ? AND owner_id = ? AND name = ?`
      )
      .get(src.owner_type, src.owner_id, candidate);
    if (!conflict) break;
    candidate = `${src.name}-拷贝-${suffix}`;
    suffix++;
  }

  const newId = uuidv4();
  db.prepare(`
    INSERT INTO llm_configs
      (id, owner_type, owner_id, name, type, api_key_encrypted, api_key_iv, api_key_tag,
       base_url, model, is_default, fallback_ids, supports_vision,
       price_in, price_out, price_cache_read)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(
    newId, src.owner_type, src.owner_id, candidate, src.type,
    src.api_key_encrypted, src.api_key_iv, src.api_key_tag,
    src.base_url, src.model,
    // v514: 链与视觉标记随行拷贝 (链成员 id 不变, 仍指同一批目标配置)
    src.fallback_ids,
    src.supports_vision,
    // v519: 单价随行拷贝
    src.price_in, src.price_out, src.price_cache_read
  );

  return getLlmConfigById(newId)!;
}

/** 强制删除 default 行 (admin 操作, 后续 setDefault 兜底).
 *  使用场景: admin 清空所有配置时; 普通用户场景下不应触发. */
export function forceDeleteLlmConfigById(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM llm_configs WHERE id = ?`).run(id);
  return result.changes > 0;
}

/** 设为默认 (事务: 同一 owner 其它行的 is_default 清零, 目标行 set=1). */
export function setDefaultLlmConfig(
  ownerType: LlmOwnerType,
  ownerId: string,
  configId: string
): LlmConfig {
  const db = getDb();
  const target = getLlmConfigById(configId);
  if (!target) {
    throw new LlmConfigError(`config ${configId} not found`, "not_found");
  }
  if (target.owner_type !== ownerType || target.owner_id !== ownerId) {
    throw new LlmConfigError(
      `config ${configId} does not belong to (${ownerType}, ${ownerId})`,
      "not_found"
    );
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE llm_configs SET is_default = 0, updated_at = datetime('now')
      WHERE owner_type = ? AND owner_id = ?
    `).run(ownerType, ownerId);
    db.prepare(`
      UPDATE llm_configs SET is_default = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(configId);
  })();

  return getLlmConfigById(configId)!;
}

// ---- Admin 便捷包装 (旧 API 兼容) ----

export function getAdminLlmConfig(): LlmConfig | null {
  // 旧 API: 返回 admin 的默认行. v50 后 admin 仍可有 is_default=1 的多份之一.
  return getDefaultLlmConfig("admin", ADMIN_OWNER_ID);
}

export function upsertAdminLlmConfig(data: LlmConfigInput): LlmConfig {
  const existing = getAdminLlmConfig();
  if (existing) {
    return updateLlmConfig(existing.id, data);
  }
  return createLlmConfig("admin", ADMIN_OWNER_ID, {
    name: data.name || "Default",
    ...data,
  });
}

export function deleteAdminLlmConfig(): boolean {
  const existing = getAdminLlmConfig();
  if (!existing) return false;
  return forceDeleteLlmConfigById(existing.id);
}

/** v50 兼容: 旧调用方传 (owner_type, owner_id, partial), 语义 = upsert 到一份名为
 *  'Default' 的配置 (若存在就更新, 不存在就建). admin 类型走 'system'.
 *  注意: 这只用于「每 owner 一份配置」的旧语义; 多配置场景请用 createLlmConfig +
 *  updateLlmConfig + setDefaultLlmConfig. 旧测试代码 / 内部兜底使用. */
export function upsertLlmConfig(
  ownerType: LlmOwnerType,
  ownerId: string,
  data: LlmConfigInput
): LlmConfig {
  const ownerIdResolved = ownerType === "admin" ? ADMIN_OWNER_ID : ownerId;
  const existing = getLlmConfig(ownerType, ownerIdResolved);
  if (existing) {
    return updateLlmConfig(existing.id, data);
  }
  return createLlmConfig(ownerType, ownerIdResolved, {
    name: data.name || "Default",
    ...data,
  });
}

/** v50 兼容: 旧「按 (owner_type, owner_id) 查单条」语义, 返回名为 Default 的行.
 *  没匹配返 null. */
export function getLlmConfig(
  ownerType: LlmOwnerType,
  ownerId: string
): LlmConfig | null {
  const ownerIdResolved = ownerType === "admin" ? ADMIN_OWNER_ID : ownerId;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM llm_configs WHERE owner_type = ? AND owner_id = ? AND name = 'Default'`
    )
    .get(ownerType, ownerIdResolved) as LlmConfig | undefined;
  return row ?? null;
}

/** v50 兼容: 旧「按 (owner_type, owner_id) 删单条」语义, 删名为 Default 的行.
 *  用于兼容旧代码; 多配置删除请用 deleteLlmConfigById(id). */
export function deleteLlmConfig(
  ownerType: LlmOwnerType,
  ownerId: string
): boolean {
  const existing = getLlmConfig(ownerType, ownerId);
  if (!existing) return false;
  return forceDeleteLlmConfigById(existing.id);
}

// ---- Admin LLM grants ----

export interface AdminLlmGrant {
  id: string;
  user_id: string;
  enabled: number;
  created_at: string;
}

export interface UserWithGrant {
  id: string;
  email: string;
  role: string;
  granted: boolean;
  max_concurrency: number | null;
}

export function isUserGrantedAdminLlm(userId: string, userRole: string): boolean {
  if (userRole === "admin") return true;
  const db = getDb();
  const row = db.prepare(
    `SELECT enabled FROM admin_llm_grants WHERE user_id = ?`
  ).get(userId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

export function listAdminLlmGrants(): UserWithGrant[] {
  const db = getDb();
  return db.prepare(`
    SELECT u.id, u.email, u.role,
           CASE WHEN g.enabled = 1 THEN 1 ELSE 0 END AS granted,
           u.max_concurrency
    FROM users u
    LEFT JOIN admin_llm_grants g ON g.user_id = u.id
    ORDER BY u.created_at ASC
  `).all() as UserWithGrant[];
}

export function setAdminLlmGrant(userId: string, enabled: boolean): void {
  const db = getDb();
  if (enabled) {
    db.prepare(`
      INSERT INTO admin_llm_grants (id, user_id, enabled)
      VALUES (?, ?, 1)
      ON CONFLICT (user_id) DO UPDATE SET enabled = 1
    `).run(uuidv4(), userId);
  } else {
    db.prepare(`
      INSERT INTO admin_llm_grants (id, user_id, enabled)
      VALUES (?, ?, 0)
      ON CONFLICT (user_id) DO UPDATE SET enabled = 0
    `).run(uuidv4(), userId);
  }
}

export function removeAdminLlmGrant(userId: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM admin_llm_grants WHERE user_id = ?`).run(userId);
  return result.changes > 0;
}

// ---- Safe conversion ----

export function toSafeLlmConfig(config: LlmConfig | null): LlmConfigSafe | null {
  if (!config) return null;

  let apiKeyMasked: string | null = null;
  let hasApiKey = false;

  if (config.api_key_encrypted && config.api_key_iv && config.api_key_tag) {
    try {
      const plaintext = decrypt(config.api_key_encrypted, config.api_key_iv, config.api_key_tag);
      apiKeyMasked = maskApiKey(plaintext);
      hasApiKey = true;
    } catch {
      apiKeyMasked = "*** (解密失败，请重新输入)";
      hasApiKey = true;
    }
  }

  return {
    id: config.id,
    owner_type: config.owner_type,
    owner_id: config.owner_id,
    name: config.name,
    type: config.type,
    api_key_masked: apiKeyMasked,
    has_api_key: hasApiKey,
    base_url: config.base_url,
    model: config.model,
    is_default: config.is_default === 1,
    fallback_ids: parseFallbackIds(config.fallback_ids),
    supports_vision:
      config.supports_vision === 1 ? true : config.supports_vision === 0 ? false : null,
    price_in: config.price_in,
    price_out: config.price_out,
    price_cache_read: config.price_cache_read,
    // coefficient 由 attachCoefficients 统一算 (基准一次查, 避免逐行 N+1)
    coefficient: null,
  };
}

// ---- v519 (R239): per-model 计价 + 基准系数 ----

/** app_settings KV 键: 基准模型配置 id (全局唯一, 系数分母的来源). */
export const COST_BASELINE_SETTING_KEY = "cost_baseline_llm_config_id";

/** 功能: 单价输入规整 — 非有限值/负数归 null (坏价悄悄算错钱, 宁可当没配). */
export function normalizePrice(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/** 功能: 取一行配置的单价三元组; 全空或配置不存在返 null (调用方回落原记账机制). */
export function getLlmPrices(configId: string | null | undefined): ModelPrices | null {
  if (!configId) return null;
  const cfg = getLlmConfigById(configId);
  if (!cfg) return null;
  const p: ModelPrices = {
    in: cfg.price_in,
    out: cfg.price_out,
    cacheRead: cfg.price_cache_read,
  };
  return hasAnyPrice(p) ? p : null;
}

/** 功能: 读基准配置 id (KV). 未设或指向已删除的配置返 null. */
export function getCostBaselineConfigId(): string | null {
  const id = getSetting(COST_BASELINE_SETTING_KEY);
  if (!id) return null;
  return getLlmConfigById(id) ? id : null;
}

/** 功能: 设/清基准配置 (id=null 清空). 设时要求配置存在, 否则抛 LlmConfigError. */
export function setCostBaselineConfigId(configId: string | null): void {
  if (configId === null) {
    setSetting(COST_BASELINE_SETTING_KEY, "");
    return;
  }
  if (!getLlmConfigById(configId)) {
    throw new LlmConfigError(`config ${configId} not found`, "not_found");
  }
  setSetting(COST_BASELINE_SETTING_KEY, configId);
}

/** 功能: 给一组 safe 配置批量算系数 (基准价查一次). 基准自身系数 = 1. */
export function attachCoefficients<T extends { price_in: number | null; price_out: number | null; price_cache_read: number | null; coefficient: number | null }>(
  configs: T[],
  baselineId: string | null,
): T[] {
  const baseline = baselineId ? getLlmPrices(baselineId) : null;
  for (const c of configs) {
    const p: ModelPrices = { in: c.price_in, out: c.price_out, cacheRead: c.price_cache_read };
    c.coefficient =
      baselineId && baseline && hasAnyPrice(p)
        ? priceCoefficient(p, baseline)
        : null;
  }
  return configs;
}

// ---- Resolution ----

export interface ResolvedLlmConfig {
  api_key: string | undefined;
  base_url: string | undefined;
  model: string | null;
  /** Which config id produced this resolution (for trace). */
  source_config_id: string | null;
  /** v514 (R175): 有序 fallback 链 (含主配置, [0] 恒为主). 起跑失败按序换凭证重试用. */
  fallback_chain: FallbackChainEntry[];
  /** v514 (R175): 与主配置同凭证 (同 key + 同 base_url) 的链成员模型名, 喂 SDK
   *  options.fallbackModel (SDK 在凭证内自动切模型, 每 user turn 回试主模型). */
  fallback_models: string[];
}

/** v514 (R175): fallback 链单成员快照 (主配置也是 [0] 号成员). */
export interface FallbackChainEntry {
  config_id: string | null;
  name: string;
  model: string | null;
  base_url: string | undefined;
  api_key: string | undefined;
  /** 与主配置同 api_key + 同 base_url (SDK fallbackModel 可直接切模型名). */
  same_credentials: boolean;
  supports_vision: boolean | null;
}

/** Resolve the effective LLM config for a task by walking the chain:
 *  env → admin default (if granted) → user default → project default →
 *  task.llm_config_id (if visible) → template.llm_config_id (if visible) →
 *  task.model (legacy override) → env
 *
 *  Visibility = 当前 user 能用此配置 (用户自己 OR admin granted);
 *  系统内部无 owner 的任务不受此限 (走 env 兜底).
 *
 *  modelOverride 是 send-time 的模型名覆写 (三态, 同 active-session 协议):
 *   - undefined: 走 task.model (cron 等非交互场景)
 *   - null:      忽略 task.model, 用链路默认 (UI 选了「默认」)
 *   - string:    强制此 model (UI 显式选)
 */
export function resolveLlmConfig(
  task: {
    model: string | null;
    owner_id: string | null;
    project_id: string | null;
    llm_config_id: string | null;
    template_id?: string | null;
  },
  modelOverride?: string | null,
): ResolvedLlmConfig {
  let model: string | null = process.env.ANTHROPIC_MODEL || null;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let sourceConfigId: string | null = null;

  const tryDecrypt = (cfg: LlmConfig | null) => {
    if (!cfg) return;
    if (cfg.api_key_encrypted && cfg.api_key_iv && cfg.api_key_tag) {
      try {
        apiKey = decrypt(cfg.api_key_encrypted, cfg.api_key_iv, cfg.api_key_tag);
      } catch (err) {
        console.warn(`[llm-configs] Failed to decrypt api key for ${cfg.owner_type}/${cfg.owner_id}/${cfg.name}:`, (err as Error).message);
      }
    }
    if (cfg.base_url) baseUrl = cfg.base_url;
    if (cfg.model) model = cfg.model;
    sourceConfigId = cfg.id;
  };

  // 工具: 检查 user 是否能用某 config (self / admin_grant)
  const userCanUse = (cfg: LlmConfig): boolean => {
    if (cfg.owner_type === "user") {
      return task.owner_id !== null && cfg.owner_id === task.owner_id;
    }
    if (cfg.owner_type === "admin") {
      if (!task.owner_id) return true; // system / owner-less task
      const user = getUserById(task.owner_id);
      return !!user && isUserGrantedAdminLlm(task.owner_id, user.role);
    }
    if (cfg.owner_type === "project") {
      return task.project_id !== null && cfg.owner_id === task.project_id;
    }
    return false;
  };

  // 1) admin default (if user granted)
  if (task.owner_id) {
    const user = getUserById(task.owner_id);
    if (user && isUserGrantedAdminLlm(task.owner_id, user.role)) {
      tryDecrypt(getDefaultLlmConfig("admin", ADMIN_OWNER_ID));
    }
  }

  // 2) user default
  if (task.owner_id) {
    const userDefault = getDefaultLlmConfig("user", task.owner_id);
    if (userDefault) tryDecrypt(userDefault);
  }

  // 3) project default
  if (task.project_id) {
    const projDefault = getDefaultLlmConfig("project", task.project_id);
    if (projDefault) tryDecrypt(projDefault);
  }

  // 4) task.llm_config_id (显式选定, 优先于链路默认)
  if (task.llm_config_id) {
    const explicit = getLlmConfigById(task.llm_config_id);
    if (explicit && userCanUse(explicit)) {
      tryDecrypt(explicit);
    }
  }

  // 5) template.llm_config_id (templateId 通过 task 透传过来, 也可能通过 metadata)
  if (!sourceConfigId && task.template_id) {
    // 读 template.llm_config_id; 不 import 避免循环依赖
    try {
      const db = getDb();
      const row = db
        .prepare(`SELECT llm_config_id FROM templates WHERE id = ?`)
        .get(task.template_id) as { llm_config_id: string | null } | undefined;
      if (row?.llm_config_id) {
        const tpl = getLlmConfigById(row.llm_config_id);
        if (tpl && userCanUse(tpl)) tryDecrypt(tpl);
      }
    } catch (err) {
      console.warn(`[llm-configs] Failed to load template ${task.template_id}:`, (err as Error).message);
    }
  }

  // 6) model override (同 active-session.ts 协议)
  if (modelOverride !== undefined && modelOverride !== null) {
    model = modelOverride;
  } else if (modelOverride === undefined && task.model) {
    model = task.model;
  }

  // 7) env 兜底 (only when no owner_id)
  if (!apiKey && !task.owner_id) {
    apiKey = process.env.ANTHROPIC_API_KEY;
    baseUrl = baseUrl || process.env.ANTHROPIC_BASE_URL;
  }

  // 8) v514 (R175): 构建 fallback 链 — 锚在最终解析出的主配置行 (sourceConfigId),
  //    沿其 fallback_ids 扁平展开 (不做递归接力 → 无环), 每个成员须 task owner 可用
  //    (userCanUse 同上), 去重 + 上限. env 兜底解析 (无锚配置) 时链 = [主] 单成员.
  const chain: FallbackChainEntry[] = [];
  const decryptKey = (cfg: LlmConfig): string | undefined => {
    if (cfg.api_key_encrypted && cfg.api_key_iv && cfg.api_key_tag) {
      try {
        return decrypt(cfg.api_key_encrypted, cfg.api_key_iv, cfg.api_key_tag);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const anchor = sourceConfigId ? getLlmConfigById(sourceConfigId) : null;
  if (anchor) {
    const seen = new Set<string>([anchor.id]);
    const members: LlmConfig[] = [anchor];
    for (const fid of parseFallbackIds(anchor.fallback_ids)) {
      if (members.length > MAX_FALLBACK_ENTRIES) break;
      const cfg = getLlmConfigById(fid);
      if (!cfg || seen.has(cfg.id) || !userCanUse(cfg)) continue;
      seen.add(cfg.id);
      members.push(cfg);
    }
    for (const cfg of members) {
      const cfgKey = decryptKey(cfg);
      chain.push({
        config_id: cfg.id,
        name: cfg.name,
        model: cfg.model,
        base_url: cfg.base_url || undefined,
        api_key: cfgKey,
        same_credentials:
          cfg.id === anchor.id
            ? true
            : !!cfgKey &&
              !!apiKey &&
              cfgKey === apiKey &&
              (cfg.base_url || undefined) === (anchor.base_url || undefined),
        supports_vision: effectiveVisionSupport(cfg),
      });
    }
  }
  if (chain.length === 0) {
    chain.push({
      config_id: sourceConfigId,
      name: anchor?.name || "(env)",
      model,
      base_url: baseUrl,
      api_key: apiKey,
      same_credentials: true,
      supports_vision: inferVisionFromModelName(model),
    });
  }

  // SDK fallbackModel: 同凭证链成员的模型名 (排除主模型自身 / 空名 / 重复)
  const fallbackModels: string[] = [];
  for (const entry of chain.slice(1)) {
    if (!entry.same_credentials || !entry.model) continue;
    if (entry.model === model) continue;
    if (!fallbackModels.includes(entry.model)) fallbackModels.push(entry.model);
  }

  return {
    api_key: apiKey,
    base_url: baseUrl,
    model,
    source_config_id: sourceConfigId,
    fallback_chain: chain,
    fallback_models: fallbackModels,
  };
}

/**
 * 功能: R175 视觉换主 — hasImages 且主配置明确不支持视觉 (false; null 未知不换)
 *   且链上有明确支持 (true) 的成员时, 把第一个支持者提升为主配置.
 * 返回: 换主后的新 ResolvedLlmConfig; 不满足条件返回 null (调用方不动原配置).
 * 关注点: 换主后 same_credentials / fallback_models 相对新主重算 — 否则 SDK
 *   fallbackModel 会拿到「与旧主同凭证」的错误列表.
 */
export function planVisionSwap(
  resolved: ResolvedLlmConfig,
  hasImages: boolean
): ResolvedLlmConfig | null {
  if (!hasImages) return null;
  const chain = resolved.fallback_chain;
  if (chain.length < 2) return null;
  const primary = chain[0];
  if (primary.supports_vision !== false) return null;
  const idx = chain.findIndex((e) => e.supports_vision === true);
  if (idx === -1) return null;
  const chosen = chain[idx];
  const newChain = [chosen, ...chain.filter((_, i) => i !== idx)];
  for (const e of newChain.slice(1)) {
    (e as FallbackChainEntry & { same_credentials: boolean }).same_credentials =
      !!e.api_key &&
      !!chosen.api_key &&
      e.api_key === chosen.api_key &&
      (e.base_url || undefined) === (chosen.base_url || undefined);
  }
  const fallbackModels: string[] = [];
  for (const e of newChain.slice(1)) {
    if (!e.same_credentials || !e.model || e.model === chosen.model) continue;
    if (!fallbackModels.includes(e.model)) fallbackModels.push(e.model);
  }
  return {
    api_key: chosen.api_key,
    base_url: chosen.base_url,
    model: chosen.model,
    source_config_id: chosen.config_id,
    fallback_chain: newChain,
    fallback_models: fallbackModels,
  };
}
