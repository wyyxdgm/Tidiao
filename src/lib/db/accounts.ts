// R48「卖工作流账号版」三 entity CRUD (飞书 R48, damo 2026-08-20 拍板).
//   决策档: /home/user/workspace/partner/docs/decisions/2026-08-20-workflow-saas-v0.1-draft.md
//   Schema: src/lib/db/index.ts migration v74 (纯 schema) + v75 (party_a 数据迁移).
//
// 设计要点:
//   - 三 entity 共存一个文件因为紧密耦合 (account → workflows/tokens 都是 children):
//     跨文件 import 多一层, 不值得. 内部用 namespace-style export (createAccount / createWorkflow /
//     createAccountToken) 而不挂类, 跟 api-tokens.ts / users.ts 同款.
//   - 多租户隔离: 所有 workflows/tokens 查询必须传 accountId; 不传 = 抛错 (强制调用方明确范围).
//     见 src/lib/auth/account-context.ts 的 resolveAccountContext 注入.
//   - token 设计: createAccountToken 返回 plaintext token **一次**, 调用方必须立刻给用户;
//     DB 只存 SHA-256 hash. 类比 Stripe sk_live / GitHub PAT —— 明文不落库.
//   - party_a_enabled 是 R48 新权威源 (account 级), 旧 users.party_a_enabled 字段保留 (R88 拦截点
//     仍读它), 两者暂时并存. Phase 2 (R48.2 yu 老板样板) 时把拦截点迁到读 accounts.
//
// 关注点:
//   - 事务性: createAccountToken + 内部 hash 计算都在主线程 (better-sqlite3 sync API); 不需要
//     显式 transaction 因为只有一条 INSERT.
//   - token_hash 用 crypto.subtle? 错: Node API route 用 createHash (同步快). Edge runtime 才用
//     subtle, 本文件只被 Node 端 import (account-context.ts 也在 Node 端, 因为要 read DB).
//   - 幂等性: createWorkflow 用 UNIQUE(account_id, slug) 兜底, 重复 slug → throw 让上层处理.
//   - closeAccount 不物理删数据 (FK CASCADE 会带走 workflow/token); 仅 status='closed'.

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

// ============================================================
// accounts
// ============================================================

export type AccountTier = "party_a" | "standard";
export type AccountStatus = "active" | "suspended" | "closed";

export interface AccountRow {
  id: string;
  owner_user_id: string;
  name: string;
  tier: AccountTier;
  party_a_enabled: number; // 0 | 1
  status: AccountStatus;
  created_at: string;
  updated_at: string;
}

export interface SafeAccount {
  id: string;
  owner_user_id: string;
  name: string;
  tier: AccountTier;
  party_a_enabled: boolean;
  status: AccountStatus;
  created_at: string;
  updated_at: string;
}

export function toSafeAccount(row: AccountRow): SafeAccount {
  return {
    ...row,
    party_a_enabled: !!row.party_a_enabled,
  };
}

export interface CreateAccountInput {
  ownerUserId: string;
  name: string;
  tier?: AccountTier;
  partyAEnabled?: boolean;
}

export function createAccount(input: CreateAccountInput): AccountRow {
  const db = getDb();
  const id = uuidv4();
  const partyA = input.partyAEnabled ? 1 : 0;
  const tier: AccountTier =
    input.tier ?? (input.partyAEnabled ? "party_a" : "standard");
  db.prepare(
    `INSERT INTO accounts (id, owner_user_id, name, tier, party_a_enabled, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  ).run(id, input.ownerUserId, input.name, tier, partyA);
  return getAccountById(id)!;
}

export function getAccountById(id: string): AccountRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM accounts WHERE id = ?`)
    .get(id) as AccountRow | undefined;
  return row ?? null;
}

export function listAccountsByOwner(ownerUserId: string): AccountRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM accounts WHERE owner_user_id = ? ORDER BY created_at DESC`
    )
    .all(ownerUserId) as AccountRow[];
}

export function setAccountPartyAEnabled(
  accountId: string,
  enabled: boolean
): AccountRow {
  const db = getDb();
  const newValue = enabled ? 1 : 0;
  const newTier: AccountTier = enabled ? "party_a" : "standard";
  const before = getAccountById(accountId);
  if (!before) throw new Error(`account_not_found:${accountId}`);
  db.prepare(
    `UPDATE accounts
     SET party_a_enabled = ?, tier = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(newValue, newTier, accountId);
  return getAccountById(accountId)!;
}

export function closeAccount(accountId: string): AccountRow {
  // 不物理删, FK CASCADE 已经会带走 children. 仅切 status.
  const db = getDb();
  const before = getAccountById(accountId);
  if (!before) throw new Error(`account_not_found:${accountId}`);
  db.prepare(
    `UPDATE accounts
     SET status = 'closed', updated_at = datetime('now')
     WHERE id = ?`
  ).run(accountId);
  return getAccountById(accountId)!;
}

// ============================================================
// workflows
// ============================================================

export type WorkflowVisibility = "private" | "public";

export interface WorkflowRow {
  id: string;
  account_id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: WorkflowVisibility;
  config_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkflowInput {
  accountId: string;
  slug: string;
  name: string;
  description?: string;
  visibility?: WorkflowVisibility;
  configJson?: unknown;
}

export function createWorkflow(input: CreateWorkflowInput): WorkflowRow {
  const db = getDb();
  const id = uuidv4();
  const configJson = input.configJson !== undefined ? JSON.stringify(input.configJson) : null;
  try {
    db.prepare(
      `INSERT INTO workflows (id, account_id, slug, name, description, visibility, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.accountId,
      input.slug,
      input.name,
      input.description ?? null,
      input.visibility ?? "private",
      configJson
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("UNIQUE constraint failed: workflows.account_id, workflows.slug")) {
      throw new Error(`workflow_slug_conflict:${input.accountId}:${input.slug}`);
    }
    throw e;
  }
  return getWorkflowById(input.accountId, id)!;
}

export function getWorkflowById(
  accountId: string,
  id: string
): WorkflowRow | null {
  // 多租户隔离: accountId 必须匹配, 否则返 null (404 而非 403, 防 ID enumeration).
  const row = getDb()
    .prepare(
      `SELECT * FROM workflows WHERE id = ? AND account_id = ?`
    )
    .get(id, accountId) as WorkflowRow | undefined;
  return row ?? null;
}

export function listWorkflowsByAccount(accountId: string): WorkflowRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM workflows WHERE account_id = ? ORDER BY updated_at DESC`
    )
    .all(accountId) as WorkflowRow[];
}

export function listPublicWorkflows(limit = 100): WorkflowRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM workflows WHERE visibility = 'public'
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as WorkflowRow[];
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  visibility?: WorkflowVisibility;
  configJson?: unknown;
}

export function updateWorkflow(
  accountId: string,
  id: string,
  patch: UpdateWorkflowInput
): WorkflowRow {
  // 多租户: 跨 account 更新返 null, 上层报 404.
  const before = getWorkflowById(accountId, id);
  if (!before) throw new Error(`workflow_not_found:${id}`);
  const db = getDb();
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) { sets.push("name = ?"); args.push(patch.name); }
  if (patch.description !== undefined) { sets.push("description = ?"); args.push(patch.description); }
  if (patch.visibility !== undefined) { sets.push("visibility = ?"); args.push(patch.visibility); }
  if (patch.configJson !== undefined) { sets.push("config_json = ?"); args.push(JSON.stringify(patch.configJson)); }
  if (sets.length === 0) return before;
  sets.push("updated_at = datetime('now')");
  args.push(accountId, id);
  db.prepare(
    `UPDATE workflows SET ${sets.join(", ")} WHERE account_id = ? AND id = ?`
  ).run(...args);
  return getWorkflowById(accountId, id)!;
}

export function deleteWorkflow(accountId: string, id: string): boolean {
  const r = getDb()
    .prepare(`DELETE FROM workflows WHERE account_id = ? AND id = ?`)
    .run(accountId, id);
  return r.changes > 0;
}

// ============================================================
// account_tokens
// ============================================================

// Token 长度 32 字节 base64url = 43 字符, ~256 bits entropy. SHA-256 hash 后存 64-char hex.
export const ACCOUNT_TOKEN_BYTES = 32;
export const ACCOUNT_TOKEN_PREFIX_LEN = 8;

export interface AccountTokenRow {
  id: string;
  account_id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  scopes: string; // JSON array string, e.g. '["workflow:run"]'
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface SafeAccountToken {
  id: string;
  account_id: string;
  token_prefix: string; // 前 8 字符 (UI 展示用, 不算秘密)
  name: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function toSafeAccountToken(row: AccountTokenRow): SafeAccountToken {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === "string");
  } catch {
    scopes = []; // 脏值降级, 不抛错
  }
  return {
    id: row.id,
    account_id: row.account_id,
    token_prefix: row.token_prefix,
    name: row.name,
    scopes,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

export interface CreateAccountTokenInput {
  accountId: string;
  name: string;
  scopes?: string[];
  expiresAt?: string; // ISO8601
}

export interface CreateAccountTokenResult {
  row: AccountTokenRow;
  plaintext: string; // 仅此次返回, DB 不存明文
}

/**
 * 生成新 token: plaintext (43 chars base64url) + SHA-256 hash + prefix(8 chars).
 * 调用方必须把 plaintext 立即返回给用户, 之后无法再读 (类 Stripe API key 创建).
 */
export function createAccountToken(
  input: CreateAccountTokenInput
): CreateAccountTokenResult {
  const db = getDb();
  const id = uuidv4();
  const plaintext = crypto
    .randomBytes(ACCOUNT_TOKEN_BYTES)
    .toString("base64url");
  const tokenHash = crypto
    .createHash("sha256")
    .update(plaintext)
    .digest("hex");
  const tokenPrefix = plaintext.slice(0, ACCOUNT_TOKEN_PREFIX_LEN);
  const scopes = JSON.stringify(input.scopes ?? ["workflow:run"]);
  db.prepare(
    `INSERT INTO account_tokens (id, account_id, token_hash, token_prefix, name, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.accountId,
    tokenHash,
    tokenPrefix,
    input.name,
    scopes,
    input.expiresAt ?? null
  );
  const row = getDb()
    .prepare(`SELECT * FROM account_tokens WHERE id = ?`)
    .get(id) as AccountTokenRow;
  return { row, plaintext };
}

/**
 * O(1) hash lookup: 接受 plaintext token → 返回 row 或 null.
 * 注意: 这步不校验 expires_at (业务层再判) 也不更新 last_used_at (调用方决定).
 */
export function getAccountTokenByPlaintext(
  plaintext: string
): AccountTokenRow | null {
  const tokenHash = crypto
    .createHash("sha256")
    .update(plaintext)
    .digest("hex");
  const row = getDb()
    .prepare(`SELECT * FROM account_tokens WHERE token_hash = ?`)
    .get(tokenHash) as AccountTokenRow | undefined;
  return row ?? null;
}

export function listAccountTokensByAccount(
  accountId: string
): AccountTokenRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM account_tokens WHERE account_id = ? ORDER BY created_at DESC`
    )
    .all(accountId) as AccountTokenRow[];
}

export function touchAccountTokenLastUsed(id: string): void {
  getDb()
    .prepare(
      `UPDATE account_tokens SET last_used_at = datetime('now') WHERE id = ?`
    )
    .run(id);
}

export function deleteAccountToken(accountId: string, id: string): boolean {
  const r = getDb()
    .prepare(
      `DELETE FROM account_tokens WHERE account_id = ? AND id = ?`
    )
    .run(accountId, id);
  return r.changes > 0;
}

/**
 * 校验 scopes 是否被 token 覆盖 (任一 scope ∈ token.scopes 即放行).
 * 用于 API 层 scope check: createAccountContext 注入后, route handler 调一次.
 */
export function hasAnyScope(
  token: AccountTokenRow,
  required: string[]
): boolean {
  if (required.length === 0) return true; // 空 required = 不限制 (oauth 通用约定)
  let granted: string[] = [];
  try {
    const parsed = JSON.parse(token.scopes);
    if (Array.isArray(parsed)) granted = parsed.filter((s) => typeof s === "string");
  } catch {
    return false;
  }
  return required.some((r) => granted.includes(r));
}

/**
 * 给一个 user 建 default account (若尚无). R48 v75 迁移逻辑的运行时版, 用于:
 *   - v75 迁移: 历史 user 在 migration 时一次性建
 *   - 后续新建 user: 在 createUser 后调一次 (懒迁移)
 * 幂等: UNIQUE(owner_user_id, name) + 重复检查, 重复 = 跳过, 不出错.
 */
export function ensureDefaultAccount(userId: string): AccountRow | null {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM accounts WHERE owner_user_id = ? AND name = 'default'`
    )
    .get(userId) as AccountRow | undefined;
  if (existing) return existing;
  const user = db
    .prepare(`SELECT party_a_enabled FROM users WHERE id = ?`)
    .get(userId) as { party_a_enabled: number } | undefined;
  if (!user) return null;
  return createAccount({
    ownerUserId: userId,
    name: "default",
    partyAEnabled: !!user.party_a_enabled,
  });
}
