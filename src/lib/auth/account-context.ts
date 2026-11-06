// R48 multi-tenant account context (飞书 R48, damo 2026-08-20 拍板).
//   决策档: /home/user/workspace/partner/docs/decisions/2026-08-20-workflow-saas-v0.1-draft.md
//
// 设计要点:
//   - middleware.ts 是 Edge Runtime, 不能 import better-sqlite3. 本文件也只在 Node API route
//     handler 里被调用 (AccountContext = DB read), 不能挂到 middleware.
//   - account context 注入有两种姿势:
//       (A) Header 'Authorization: Bearer <token>' → resolveAccountContext
//       (B) 内部 call (admin 替 account 操作) → requireAccountContextById(accountId, userId)
//     (B) 不验 token, 仅做 account 存在 + 归属校验, 因为内部调用方已通过 session auth.
//   - requireAccountContext 抛出的错误结构稳定 (HttpError-ish), route handler 用 try/catch
//     包统一返 401/403. 故意不挂 NextResponse —— 这层只产 data, 上层做 response.
//
// 关注点:
//   - 多租户隔离: WHERE account_id = ctx.accountId 必须出现在所有 children 查询里.
//     scopeToAccount() helper 强制把 rows 收窄到 ctx.accountId, 跨 account 读返空数组.
//   - 过期校验: expires_at < now → 当 token 无效 (抛 401 expired).
//   - last_used_at 异步触发: 不阻塞 token verify 主路径 (touch 是 best-effort, 失败不抛).
//   - 无 party_a quota check: 本文件只负责身份注入, 配额拦截走 R88 user 拦截点 (后续
//     Phase 2 再把粒度从 user 迁到 account).

import {
  getAccountById,
  getAccountTokenByPlaintext,
  hasAnyScope,
  touchAccountTokenLastUsed,
  type AccountRow,
  type AccountTokenRow,
} from "../db/accounts";

export class AccountContextError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AccountContextError";
  }
}

export interface AccountContext {
  account: AccountRow;
  token: AccountTokenRow;
  scopes: string[];
}

function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

function isExpired(token: AccountTokenRow): boolean {
  if (!token.expires_at) return false;
  const ts = Date.parse(token.expires_at);
  if (Number.isNaN(ts)) return false; // 脏值降级: 不挡 (跟 users.ts quota expire 判据同款)
  return ts <= Date.now();
}

/**
 * 从 Request 头解析 Bearer token → AccountContext (含 account + token + scopes).
 * 无 token / token 不存在 / account 关闭 / token 过期 → 抛 AccountContextError(401).
 */
export async function resolveAccountContext(
  req: Request
): Promise<AccountContext> {
  const plaintext = extractBearer(req);
  if (!plaintext) {
    throw new AccountContextError(
      401,
      "missing_token",
      "Authorization Bearer token required"
    );
  }
  const token = getAccountTokenByPlaintext(plaintext);
  if (!token) {
    throw new AccountContextError(
      401,
      "invalid_token",
      "Token not recognized"
    );
  }
  if (isExpired(token)) {
    throw new AccountContextError(
      401,
      "token_expired",
      "Token has expired"
    );
  }
  const account = getAccountById(token.account_id);
  if (!account) {
    throw new AccountContextError(
      401,
      "account_not_found",
      "Account bound to token not found"
    );
  }
  if (account.status !== "active") {
    throw new AccountContextError(
      403,
      `account_${account.status}`,
      `Account is ${account.status}`
    );
  }
  // Best-effort touch (失败不抛, 不阻断请求).
  try {
    touchAccountTokenLastUsed(token.id);
  } catch {
    /* ignore */
  }
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(token.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === "string");
  } catch {
    scopes = [];
  }
  return { account, token, scopes };
}

/**
 * resolveAccountContext + scope 校验二合一. 缺 scope → 403.
 */
export async function requireAccountContext(
  req: Request,
  requiredScope: string | string[] = []
): Promise<AccountContext> {
  const ctx = await resolveAccountContext(req);
  const required = Array.isArray(requiredScope)
    ? requiredScope
    : requiredScope
      ? [requiredScope]
      : [];
  if (required.length > 0 && !hasAnyScope(ctx.token, required)) {
    throw new AccountContextError(
      403,
      "insufficient_scope",
      `Token missing required scope: ${required.join(",")}`
    );
  }
  return ctx;
}

/**
 * 内部 call helper: 已通过 session auth 的 user 用 accountId 拿 context.
 * 验证 ownership: account.owner_user_id 必须 === callerUserId (admin 角色另说).
 */
export function requireAccountContextById(
  accountId: string,
  callerUserId: string,
  isAdmin = false
): AccountContext {
  const account = getAccountById(accountId);
  if (!account) {
    throw new AccountContextError(404, "account_not_found", `Account ${accountId} not found`);
  }
  if (!isAdmin && account.owner_user_id !== callerUserId) {
    throw new AccountContextError(
      403,
      "account_not_owned",
      `account_not_owned: caller ${callerUserId} does not own account ${accountId}`
    );
  }
  if (account.status !== "active") {
    throw new AccountContextError(
      403,
      `account_${account.status}`,
      `Account is ${account.status}`
    );
  }
  // 内部调用无 token, scopes 给空 (按设计: 内部 call 全权). 上层 route 自决权限.
  const syntheticToken: AccountTokenRow = {
    id: "internal",
    account_id: account.id,
    token_hash: "",
    token_prefix: "internal",
    name: "internal-call",
    scopes: '["admin"]',
    expires_at: null,
    last_used_at: null,
    created_at: account.created_at,
  };
  return { account, token: syntheticToken, scopes: ["admin"] };
}

/**
 * 多租户 WHERE 收窄 helper: 给一组已按 account_id 查出的 rows, 二次过滤 ctx.account_id.
 * 防 ID enumeration: 跨 account row 即使被错误 SQL 查出, 也被这一步过滤掉.
 * 用法: `const myWorkflows = scopeToAccount(allWorkflows, ctx);`
 */
export function scopeToAccount<T extends { account_id: string }>(
  rows: T[],
  ctx: AccountContext
): T[] {
  return rows.filter((r) => r.account_id === ctx.account.id);
}
