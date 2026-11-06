// User CRUD - see src/lib/db/index.ts (migration v14) for schema.
// Password hashing uses bcryptjs (pure JS). Role policy (first user = admin)
// lives in the register route; this module just persists what it's given.

import { getDb } from "./index";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
  preflight_enabled: number; // v27: 1 = inject [preflight check] into every task prompt
  max_concurrency: number | null; // v30: per-user concurrency cap, NULL = unlimited
  notify_email: string | null; // v41: 通知收件邮箱, NULL/空 = 回落 env NOTIFY_FALLBACK_TO
  feishu_webhook_url: string | null; // v47: 用户自定义飞书机器人 webhook URL, NULL/空 = 未配飞书渠道
  party_a_enabled: number; // v55: R88 quota 开关, 0 = 普通用户三件套不生效, 1 = 甲方三件套生效
  quota_total_spent_cap: number | null; // v55: 账号总费用上限 (USD), NULL/0/负数 = 不限
  quota_granted_cap: number | null; // v55: 管理员授予额度上限 (仅展示), NULL/0/负数 = 不限
  quota_expire_at: string | null; // v55: 使用截止日期 (ISO8601), NULL = 不限
  git_name: string | null; // v515: 账号级 git 提交 user.name, NULL = 取邮箱前缀
  git_email: string | null; // v515: 账号级 git 提交 user.email, NULL = 取账号邮箱
  nickname: string | null; // v518: 用户昵称 (agent 称呼用), NULL = 回落「用户」
  bio: string | null; // v518: 用户自我介绍 (喜好/背景), NULL = 注入时省略整行
}

/** User shape returned to the client / API - never exposes password_hash. */
export interface SafeUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
  preflight_enabled: boolean;
  notify_email: string | null;
  feishu_webhook_url: string | null;
  party_a_enabled: boolean; // v55: R88 quota 开关
  quota_total_spent_cap: number | null; // v55: 账号总费用上限
  quota_granted_cap: number | null; // v55: 管理员授予额度上限
  quota_expire_at: string | null; // v55: 使用截止日期
  git_name: string | null; // v515: 不是秘密 —— 提交本来就要公开出现在 git log
  git_email: string | null;
  nickname: string | null; // v518: 用户昵称 (agent 视角), NULL = 未配置
  bio: string | null; // v518: 用户自我介绍, NULL = 未配置
}

export function toSafeUser(u: User): SafeUser {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
    preflight_enabled: !!u.preflight_enabled,
    notify_email: u.notify_email ?? null,
    feishu_webhook_url: u.feishu_webhook_url ?? null,
    party_a_enabled: !!u.party_a_enabled,
    quota_total_spent_cap: u.quota_total_spent_cap ?? null,
    quota_granted_cap: u.quota_granted_cap ?? null,
    quota_expire_at: u.quota_expire_at ?? null,
    git_name: u.git_name ?? null,
    git_email: u.git_email ?? null,
    nickname: u.nickname ?? null,
    bio: u.bio ?? null,
  };
}

const SALT_ROUNDS = 10;

export async function createUser(
  email: string,
  password: string,
  role: UserRole = "user"
): Promise<User> {
  const db = getDb();
  const id = uuidv4();
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)
  `).run(id, email, password_hash, role);
  return getUserById(id)!;
}

export function getUserByEmail(email: string): User | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as
    | User
    | undefined;
  return row ?? null;
}

export function getUserById(id: string): User | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | User
    | undefined;
  return row ?? null;
}

/** Number of registered users. Used by the register route to pick the first
 *  user as admin. */
export function getUserCount(): number {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as {
    c: number;
  };
  return row.c;
}

/** Verify a plaintext password against a stored hash. */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** v30: Per-user concurrency cap. NULL = unlimited (bounded only by the
 *  global scheduler cap). The scheduler reads this to decide whether a task
 *  from this owner may claim a slot. */
export function getUserMaxConcurrency(userId: string): number | null {
  const db = getDb();
  const row = db
    .prepare("SELECT max_concurrency FROM users WHERE id = ?")
    .get(userId) as { max_concurrency: number | null } | undefined;
  return row?.max_concurrency ?? null;
}

/** Set or clear a user's concurrency cap. null = unlimited. Caller is
 *  responsible for invalidating the scheduler's cache after a change. */
export function setUserMaxConcurrency(userId: string, n: number | null): void {
  const db = getDb();
  db.prepare("UPDATE users SET max_concurrency = ? WHERE id = ?").run(n, userId);
}

/** Toggle the per-user preflight self-check (v27). When false, createTask()
 *  skips the [preflight check] block — saves 1 turn of token per task, and
 *  removes a soft check the user may find noisy. */
export function setUserPreflightEnabled(userId: string, enabled: boolean): User | null {
  const db = getDb();
  db.prepare(`UPDATE users SET preflight_enabled = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    userId
  );
  return getUserById(userId);
}

// 功能: 校验一个字符串是否像可投递的邮箱地址。
// 关注点: 故意保守而不追求 RFC 5322 完备 —— 只挡明显写错的(缺 @ / 缺域名 / 带空格),
//   真正的可投递性只有 SMTP 服务器说得准。宽松到能过的脏值由发送侧 catch 兜底。
export function isValidNotifyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s) && s.length <= 254;
}

// 功能: checkUserQuota 的"含当前 in-flight task 成本"变体. 用于 R88 双保险:
//   任务跑完 cost_usd 落库前, 用本次累计成本叠加历史 SUM, 看是否触 cap. 仅在
//   "任务 cost 还没写库" 的窗口调用 (snapshotCost 后 / updateTaskStatus 之前), 不能
//   取代 checkUserQuota —— 前置入口仍走 checkUserQuota, 这里只补 cost 落库后那道
//   闸门.
// 关注点:
//   - 复用 checkUserQuota 的 expire/party_a 判据, 短路: 已经禁的就直接返回 base.
//   - base.used 是 SUM(其他 task.cost_usd), currentCost 是当前 in-flight task 的累计.
//   - 不写库: used/cap/remaining_days 计算全是 in-memory, 调用方按需落 log / 改状态.
//   - currentCost 不入"cap <=0 = 不限"的转换: 这里复用 base.cap 已是 checkUserQuota
//     解析后的值 (NULL = 不限), 不需要再 normalize.
export function checkUserQuotaWithCurrent(
  userId: string,
  currentCost: number
): QuotaCheckResult {
  const base = checkUserQuota(userId);
  // party_a=0 / expired / user 不存在 → 直接返回 base, 不叠加 (前置拦截已经放行)
  if (!base.allowed && base.reason !== "total_spent_cap") return base;
  if (base.cap === null || base.cap === undefined) return base;
  if (currentCost <= 0) return base;
  const total = base.used + currentCost;
  if (total < Number(base.cap)) return { ...base, used: total };
  // 触 cap → 返拒绝 + 友好 detail
  return {
    allowed: false,
    reason: "total_spent_cap",
    detail: `已用 $${total.toFixed(2)} 触达上限 $${Number(base.cap).toFixed(2)} (含本次 $${currentCost.toFixed(2)})`,
    used: total,
    cap: base.cap,
    expire_at: base.expire_at,
    remaining_days: base.remaining_days,
  };
}

// 功能: 落一条 user_quota_change_log, 标记 "运行时 task 双保险触发". 仅 agent-runtime
//   在 cancel/pause/result 三路 cost_usd 落库前调用, 不给普通 setter 复用 (那些走
//   applyQuotaChange 事务).
// 关注点:
//   - operator_id 写死 'system': 这是平台自动判定, 不是 admin 操作. 与 v55 setter
//     约定一致, 不会撞 user.id.
//   - field 固定 'quota_exceeded_runtime', 跟手动改 party_a / cap 区分开, 后续 UI
//     可按 field 分类显示 (Sheet L 验收 ② 变更留痕).
//   - 不抛错: 调用方已经在做"任务要 failed"的善后, log 写失败不应再次炸栈.
//     best-effort, 同 commit 一致.
export function recordQuotaExceededRuntime(
  userId: string,
  currentCost: number,
  detail: string
): void {
  try {
    getDb().prepare(
      `INSERT INTO user_quota_change_log
         (operator_id, target_user_id, field, old_value, new_value, reason)
       VALUES ('system', ?, 'quota_exceeded_runtime', NULL, ?, ?)`
    ).run(userId, String(currentCost), detail.slice(0, 500));
  } catch (err) {
    console.warn(`[users] recordQuotaExceededRuntime 写 log 失败:`, (err as Error).message);
  }
}

// 功能: 设置/清空这个账号的通知收件邮箱. 传 null 或空串 = 清空(回落系统邮箱).
//   返回更新后的 User, 用户不存在返回 null.
// 关注点: 不做格式校验 —— 校验在 API 路由(isValidNotifyEmail), 这里只负责存,
//   与 setUserMaxConcurrency 的分工一致。空串统一归一成 NULL, 避免库里出现
//   ""(会让 resolveNotifyTo 的「非空」判断多一个分支)。
export function setUserNotifyEmail(userId: string, email: string | null): User | null {
  const db = getDb();
  const normalized = email && email.trim() ? email.trim() : null;
  db.prepare(`UPDATE users SET notify_email = ? WHERE id = ?`).run(normalized, userId);
  return getUserById(userId);
}

// 功能: 校验一个字符串是否像合法的飞书自定义机器人 webhook URL。
// 关注点: 故意严格 —— webhook 不像邮箱那么常用, 卡死能挡掉脏值, 又不会误伤合法 URL。
//   必须是 https://open.feishu.cn/open-apis/bot/v2/hook/ + token (32 字符 base62/hex)。
//   长度 ≤ 512 防灌库。
const FEISHU_WEBHOOK_RE =
  /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,256}$/;
export function isValidFeishuWebhookUrl(s: string): boolean {
  return FEISHU_WEBHOOK_RE.test(s) && s.length <= 512;
}

// 功能: 把 webhook URL 末 4 位脱敏, 用于 GET /api/user/me/webhook-meta 的 masked_url 字段。
// 关注点: 不能完全隐藏(用户配完要看一眼配对了没有), 但也不能回完整明文。
//   返回 "https://open.feishu.cn/open-apis/bot/v2/hook/****abcd" 这种格式。
export function maskFeishuWebhookUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /^(https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/)([A-Za-z0-9_-]+)$/.exec(url);
  if (!m) return null;
  const token = m[2];
  const tail = token.slice(-4);
  return `${m[1]}****${tail}`;
}

// 功能: 设置/清空这个账号的飞书 webhook URL. 传 null 或空串 = 清空(未配飞书渠道).
//   返回更新后的 User, 用户不存在返回 null.
// 关注点: 不做格式校验 —— 校验在 API 路由(isValidFeishuWebhookUrl), 这里只负责存,
//   与 setUserNotifyEmail 分工一致。空串统一归一成 NULL, 避免库里出现 "" 让
//   sendFeishuWebhook 多一个分支。
export function setUserFeishuWebhook(userId: string, url: string | null): User | null {
  const db = getDb();
  const normalized = url && url.trim() ? url.trim() : null;
  db.prepare(`UPDATE users SET feishu_webhook_url = ? WHERE id = ?`).run(normalized, userId);
  return getUserById(userId);
}

// =====================================================================
// v515: 账号级 git 提交身份 (飞书 R178, damo 2026-10-03).
// 需求: 账号可配 git 提交用户名; 不指定 → email 用账号邮箱, name 取邮箱前缀.
// 生效点: active-session buildEnv 注入 GIT_AUTHOR_*/GIT_COMMITTER_* env,
//   agent 子进程 git commit 落这个身份 (git log 可见). 不写 .git/config ——
//   同一台机多账号并发跑 task, 写共享仓的 config 会互相踩.
// =====================================================================

// 功能: 校验 git user.name 是否合法. git 只禁 < > 和换行, 这里再收紧:
//   非空 / ≤ 128 字符 / 不含 < > 换行 / 不含控制字符.
export function isValidGitName(s: string): boolean {
  if (!s.trim() || s.length > 128) return false;
  return !/[<>\x00-\x1f\x7f]/.test(s);
}

// 功能: 设置账号级 git 提交身份. 传 null / 空串 = 对应字段清空(回落默认).
//   name 和 email 一次写: UI 上是一张表单, API 单请求带俩字段.
//   返回更新后的 User, 用户不存在返回 null.
// 关注点: 不做格式校验 —— 校验在 API 路由(isValidGitName / isValidNotifyEmail),
//   这里只负责存, 与 setUserNotifyEmail 分工一致。空串统一归一成 NULL。
export function setUserGitIdentity(
  userId: string,
  name: string | null,
  email: string | null
): User | null {
  const db = getDb();
  const normalizedName = name && name.trim() ? name.trim() : null;
  const normalizedEmail = email && email.trim() ? email.trim() : null;
  db.prepare(`UPDATE users SET git_name = ?, git_email = ? WHERE id = ?`).run(
    normalizedName,
    normalizedEmail,
    userId
  );
  return getUserById(userId);
}

// 功能: 解析某账号 git 提交要用的最终身份 (配置值 + 默认回落).
//   email = git_email || 账号邮箱; name = git_name || email 前缀(@ 前部分).
//   用户不存在 / 账号邮箱也空(理论不可能, 注册必填) → null, 调用方跳过注入.
// 关注点: 只读不写; 前缀取自「已回落的 email」而不是账号邮箱 —— 显式配了
//   git_email 时, name 前缀跟 email 保持同一来源, 不出现 name 取账号邮箱前缀
//   而 email 是自定义值的精神分裂组合。
export function resolveGitIdentity(userId: string): { name: string; email: string } | null {
  const user = getUserById(userId);
  if (!user) return null;
  const email = (user.git_email && user.git_email.trim()) || user.email;
  if (!email) return null;
  const name = (user.git_name && user.git_name.trim()) || email.split("@")[0];
  if (!name) return null;
  return { name, email };
}

// =====================================================================
// v518: 账号级用户身份 —— 昵称 + 自我介绍 (飞书 R222, damo 2026-10-08).
// 需求: 项目里容易出现 damo 等昵称误称 (cwd / CLAUDE.md 里的名字泄漏进对话),
//   让用户可配昵称 + 自我介绍, agent 全局知道「用户是谁、喜好是什么」.
//   参考 OpenClaw 的 USER.md (About Your Human, 每 session 全局加载) 设计.
// 解析规则 (R222 原文): 配置了就用配置的; 昵称没配默认「用户」;
//   自我介绍没配省略整行. 生效点: active-session start() 首条 prompt 前注入
//   userProfileReminder (每 task 会话一次, resume 带历史不重注).
// =====================================================================

// 功能: 校验昵称合法性. 单行展示字段: 非空 / ≤ 64 字符 / 不含换行和控制字符.
//   空 / 纯空白由调用方归一成 NULL (未配置), 不算非法.
export function isValidNickname(s: string): boolean {
  if (!s.trim() || s.length > 64) return false;
  return !/[\r\n\x00-\x1f\x7f]/.test(s);
}

// 功能: 校验自我介绍长度. 多行自由文本, 只卡上限 (≤ 2000 字符, 防灌上下文).
export function isValidBio(s: string): boolean {
  return s.length <= 2000;
}

// 功能: 设置账号昵称 + 自我介绍. 传 null / 空串 = 对应字段清空(回落默认).
//   俩字段一次写: UI 上是一张表单, API 单请求带俩字段 (与 setUserGitIdentity 同构).
//   返回更新后的 User, 用户不存在返回 null.
// 关注点: 不做格式校验 —— 校验在 API 路由(isValidNickname / isValidBio), 这里只负责
//   存, 与 setUserGitIdentity 分工一致。空串统一归一成 NULL, 避免库里出现 "" 让
//   resolveUserProfile 多一个分支。
export function setUserProfile(
  userId: string,
  nickname: string | null,
  bio: string | null
): User | null {
  const db = getDb();
  const normalizedNickname = nickname && nickname.trim() ? nickname.trim() : null;
  const normalizedBio = bio && bio.trim() ? bio.trim() : null;
  db.prepare(`UPDATE users SET nickname = ?, bio = ? WHERE id = ?`).run(
    normalizedNickname,
    normalizedBio,
    userId
  );
  return getUserById(userId);
}

// 功能: 解析 agent 视角的用户身份 (配置值 + 默认回落).
//   nickname = 配置值 || 「用户」(R222 明确口径); bio = 配置值 || null (省略).
//   用户不存在 (理论不可能, task 必绑 owner) → 返回默认身份而不是 null,
//   让注入点始终有值可注, 不因 DB 异常静默丢身份.
// 关注点: 只读不写; bio 原样返回不截断 (入库时已卡 2000).
export function resolveUserProfile(userId: string): { nickname: string; bio: string | null } {
  const DEFAULT_NICKNAME = "用户";
  const user = userId ? getUserById(userId) : null;
  if (!user) return { nickname: DEFAULT_NICKNAME, bio: null };
  return {
    nickname: (user.nickname && user.nickname.trim()) || DEFAULT_NICKNAME,
    bio: (user.bio && user.bio.trim()) || null,
  };
}

// =====================================================================
// v55: R88 quota 三件套 + party_a_enabled 开关 (飞书 R88, damo 0825).
// 设计要点:
//   - party_a_enabled = 0 → 三件套全部不生效 (老用户零行为变化, Sheet L 验收点 ③)
//   - party_a_enabled = 1 → 三件套生效, 任意一条触发即拒绝
//   - quota_total_spent_cap ≤0 / NULL → 该维度不限 (Sheet L 验收点 ② 边界)
//   - quota_granted_cap 只展示不二次拦截 (Sheet H 列明文)
//   - quota_expire_at ≤ now → 拒绝 (Sheet L 验收点 ② expire)
//   - 所有 setter 走同一事务: UPDATE users + INSERT user_quota_change_log
//     (Sheet H 变更留痕 ②)
// =====================================================================

/** "≤0 或 NULL = 不限" 的统一判据. 0/负数都视为不限, 是 Sheet H ⑤ + L ② 验收点.
 *  用 Number.isFinite 排除 NaN/Infinity, 用 Number(x) 让 string→number 安全转换. */
function isUnlimited(value: number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0;
}

/** 功能: 算这个 owner 所有未删 task 的累计费用 (USD). 排除 deleted_at 不为空的软删行
 *  (见 tasks.ts 软删模式). 没数据返回 0.
 *  关注点: 总费用是动态聚合, 不缓存; 调用方(拦截点)按需算, 单 user 量级 SUM 走索引
 *  idx_tasks_owner_status_updated (v49). 累计的是 tasks.cost_usd (per-task 终态费用),
 *  与 agent-runtime.ts snapshotCost 写入的列同名. */
export function getUserQuotaUsedTotal(userId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS used
       FROM tasks
       WHERE owner_id = ? AND deleted_at IS NULL`
    )
    .get(userId) as { used: number };
  return Number(row.used) || 0;
}

/** Quota 检查结果. allowed=false 时 reason + detail 给前端拼友好提示. */
export interface QuotaCheckResult {
  allowed: boolean;
  /** 拦截理由. allowed=true 时为 null. */
  reason: "total_spent_cap" | "expired" | "no_party_a" | null;
  /** 给前端 / 任务流水的友好提示文案(已含"还剩 X / 已超 Y"). */
  detail: string | null;
  /** 已用 (USD), 即 SUM(tasks.total_cost_usd). */
  used: number;
  /** 总费用上限 (USD), null = 不限. */
  cap: number | null;
  /** 截止日期 ISO 字符串, null = 不限. */
  expire_at: string | null;
  /** 剩余天数 (>=0 整数). 已过期为 0. null = 不限. */
  remaining_days: number | null;
}

/** 功能: 检查这个 owner 是否可以发起新任务 / 继续运行. 三件套任一触发即拒绝.
 *  关注点:
 *   - party_a_enabled = 0 → 直接放行 (allowed=true, reason='no_party_a', 这是 not-rejected
 *     状态而非错误, 前端 UI 可据此隐藏 "剩余 X 天" 卡片).
 *   - 三个 setter 各自独立检查; 短路求值: 已过期就不再查 cap.
 *   - getUserQuotaUsedTotal 是 SUM 全表, 不缓存. 调用频次受限于拦截点(创建任务 + 记账后),
 *     量级与 tasks 总数同阶, v49 索引覆盖, 不会爆.
 *   - 剩余天数用毫秒差向上取整; 已过期返回 0 (不允许负数 — 让前端进度条别画超界). */
export function checkUserQuota(userId: string): QuotaCheckResult {
  const user = getUserById(userId);
  if (!user) {
    return {
      allowed: false,
      reason: "no_party_a", // user 不存在, 借用此 reason 让上层 401/404
      detail: "user not found",
      used: 0,
      cap: null,
      expire_at: null,
      remaining_days: null,
    };
  }
  if (!user.party_a_enabled) {
    return {
      allowed: true,
      reason: "no_party_a",
      detail: null,
      used: 0,
      cap: null,
      expire_at: null,
      remaining_days: null,
    };
  }
  const cap = user.quota_total_spent_cap ?? null;
  const expireAt = user.quota_expire_at ?? null;
  const used = getUserQuotaUsedTotal(userId);
  const capUnlimited = isUnlimited(cap);
  const expireUnlimited = !expireAt || isUnlimitedDateString(expireAt);

  // 1. expire_at 优先 (过了截止日期就一票否决, 即便费用没用满)
  if (!expireUnlimited) {
    const expireMs = Date.parse(expireAt!);
    if (Number.isFinite(expireMs) && expireMs < Date.now()) {
      const remaining = 0;
      return {
        allowed: false,
        reason: "expired",
        detail: `账号使用期限已截止 (${expireAt}), 请联系管理员续期`,
        used,
        cap,
        expire_at: expireAt,
        remaining_days: remaining,
      };
    }
  }

  // 2. quota_total_spent_cap 上限 (≤0 = 不限, 不走这条)
  if (!capUnlimited) {
    if (used >= Number(cap)) {
      return {
        allowed: false,
        reason: "total_spent_cap",
        detail: `已用 $${used.toFixed(2)} 触达上限 $${Number(cap).toFixed(2)}`,
        used,
        cap,
        expire_at: expireAt,
        remaining_days: computeRemainingDays(expireAt),
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    detail: null,
    used,
    cap,
    expire_at: expireAt,
    remaining_days: computeRemainingDays(expireAt),
  };
}

/** "≤now 或解析失败 = 不限" 的统一判据. 解析失败不抛错, 视为不限 —— 手工 SQL 脏值
 *  走默认通过, 跟 settings.ts "脏值 warn 并回退" 的策略同款. */
function isUnlimitedDateString(s: string): boolean {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return true;
  return t <= 0;
}

/** 剩余天数 (向上取整, 已过期=0, 不限=null). 拦截点返回 detail 时用到. */
function computeRemainingDays(expireAt: string | null): number | null {
  if (!expireAt) return null;
  const ms = Date.parse(expireAt);
  if (!Number.isFinite(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86400000);
}

// ---------------------------------------------------------------------
// Setter: 4 个 setter 走同一模式 — UPDATE users + INSERT user_quota_change_log
// 在一个事务里. 调用方是 PATCH /api/admin/users/[id] 等管理路由.
// 关注点:
//   - 事务: 事务外抛错让路由 catch 成 500, 不会留下"users 改了但 log 没写"的孤行.
//   - operator_id 必传: 让审计能追到 "谁改的". 内部自动触发 (如 expire 自然到期)
//     调用方传 'system' 字符串, 与 user.id 不冲突 (UUID v4 全数字 + '-', 'system'
//     是英文小写, 不可能撞上).
//   - reason 可选 (运营备注, NULL 也行).
//   - normalizeEmpty: "" / NaN / undefined 一律归 NULL, 与 v41 notify_email / v47
//     feishu_webhook_url 同款轻校验, 避免库里出现脏值让 isUnlimited 多分支.
// ---------------------------------------------------------------------

interface QuotaSetOpts {
  operatorId: string;
  reason?: string | null;
}

function normalizeCap(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizeExpireAt(input: unknown): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") return null;
  const t = Date.parse(input);
  if (!Number.isFinite(t)) return null;
  // 校验合法 ISO8601 后落库 (保留原始字符串避免时区漂移)
  return input;
}

/** 切换 party_a_enabled. true=标记为甲方三件套生效; false=回退普通用户.
 *  关注点: 这个开关改一次不影响已经生效的任务, 只影响后续拦截点判断. */
export function setUserPartyAEnabled(
  userId: string,
  enabled: boolean,
  opts: QuotaSetOpts
): User | null {
  const before = getUserById(userId);
  if (!before) return null;
  const newValue = enabled ? 1 : 0;
  const oldValue = before.party_a_enabled ? 1 : 0;
  return applyQuotaChange({
    userId,
    operatorId: opts.operatorId,
    field: "party_a_enabled",
    oldValue: String(oldValue),
    newValue: String(newValue),
    reason: opts.reason ?? null,
    apply: () => {
      getDb().prepare(`UPDATE users SET party_a_enabled = ? WHERE id = ?`).run(newValue, userId);
    },
  });
}

/** 设置账号总费用上限 (USD). null=清空(改回不限). 非法值(非数字/null) 归 null.
 *  关注点: cap = 0 被归 null (走 "≤0 = 不限" 判据). */
export function setUserQuotaTotalSpentCap(
  userId: string,
  cap: number | null | undefined,
  opts: QuotaSetOpts
): User | null {
  const before = getUserById(userId);
  if (!before) return null;
  const normalized = normalizeCap(cap);
  return applyQuotaChange({
    userId,
    operatorId: opts.operatorId,
    field: "quota_total_spent_cap",
    oldValue: before.quota_total_spent_cap == null ? null : String(before.quota_total_spent_cap),
    newValue: normalized == null ? null : String(normalized),
    reason: opts.reason ?? null,
    apply: () => {
      getDb().prepare(`UPDATE users SET quota_total_spent_cap = ? WHERE id = ?`).run(normalized, userId);
    },
  });
}

/** 设置管理员授予额度上限 (USD). 仅展示不二次拦截 (Sheet H 列明文), 但同样走留痕.
 *  关注点: 与 setUserQuotaTotalSpentCap 同一套 normalize, 区别只在 apply() 的列名.
 *    拦截点不会被 granted_cap 触发, 只用于前端展示 "已用 / 授予" 进度. */
export function setUserQuotaGrantedCap(
  userId: string,
  cap: number | null | undefined,
  opts: QuotaSetOpts
): User | null {
  const before = getUserById(userId);
  if (!before) return null;
  const normalized = normalizeCap(cap);
  return applyQuotaChange({
    userId,
    operatorId: opts.operatorId,
    field: "quota_granted_cap",
    oldValue: before.quota_granted_cap == null ? null : String(before.quota_granted_cap),
    newValue: normalized == null ? null : String(normalized),
    reason: opts.reason ?? null,
    apply: () => {
      getDb().prepare(`UPDATE users SET quota_granted_cap = ? WHERE id = ?`).run(normalized, userId);
    },
  });
}

/** 设置使用截止日期 (ISO8601). null=清空(改回不限). 非法字符串 归 null.
 *  关注点: 截止日期存字符串(原始 ISO)而非 epoch, 避免时区漂移; 解析走 Date.parse,
 *    与 isUnlimitedDateString / computeRemainingDays 同源, 保证 "过期 = 拒绝" 一致. */
export function setUserQuotaExpireAt(
  userId: string,
  expireAt: string | null | undefined,
  opts: QuotaSetOpts
): User | null {
  const before = getUserById(userId);
  if (!before) return null;
  const normalized = normalizeExpireAt(expireAt);
  return applyQuotaChange({
    userId,
    operatorId: opts.operatorId,
    field: "quota_expire_at",
    oldValue: before.quota_expire_at ?? null,
    newValue: normalized,
    reason: opts.reason ?? null,
    apply: () => {
      getDb().prepare(`UPDATE users SET quota_expire_at = ? WHERE id = ?`).run(normalized, userId);
    },
  });
}

/** 事务包裹: apply(更新 users) + 写 log. 一个事务保证不会 "users 改了 log 漏了".
 *  关注点: old/new 都用 TEXT 序列化; NULL 表示"无值"(与 schema 一致); reason 可空;
 *    log 行 created_at 由 DEFAULT (datetime('now')) 拿, 不需要传入. */
function applyQuotaChange(args: {
  userId: string;
  operatorId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  apply: () => void;
}): User | null {
  const db = getDb();
  db.transaction(() => {
    args.apply();
    db.prepare(
      `INSERT INTO user_quota_change_log (operator_id, target_user_id, field, old_value, new_value, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(args.operatorId, args.userId, args.field, args.oldValue, args.newValue, args.reason);
  })();
  return getUserById(args.userId);
}

/** 功能: 拉这个 user 的 quota 变更历史, 按时间倒序, 默认最多 50 条.
 *  关注点: 给 admin 详情页 "变更历史" 面板用; operator_id 应用层 try-resolve 到 email
 *    (users.id 是 UUID, 存的是操作人 user.id; 'system' 字符串直接显示). */
export interface QuotaChangeLogEntry {
  id: number;
  operator_id: string;
  target_user_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  created_at: string;
}

export function getQuotaChangeLog(
  targetUserId: string,
  limit: number = 50
): QuotaChangeLogEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, operator_id, target_user_id, field, old_value, new_value, reason, created_at
       FROM user_quota_change_log
       WHERE target_user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(targetUserId, limit) as QuotaChangeLogEntry[];
}

// =====================================================================
// v55+: Admin 配额管理 API 给前端用的列表/详情聚合函数.
//   - listUsersWithQuota(): admin UI 列表, 一行一个 user + 4 个 quota 字段 + 累计费用.
//     累计走 getUserQuotaUsedTotal 内部 SUM(tasks.cost_usd), 每行单独算 (=N+1 次 SUM).
//     user 数量级 < 1000 没问题; 大了再考虑聚合缓存.
//   - 当前累计只在 party_a_enabled=1 时有意义 (party_a=0 不参与拦截), 但 UI 仍展示
//     方便 admin 一眼看到哪些用户在跑超 cap 边界.
// =====================================================================

export interface UserWithQuota {
  id: string;
  email: string;
  role: string;
  party_a_enabled: boolean;
  quota_total_spent_cap: number | null;
  quota_granted_cap: number | null;
  quota_expire_at: string | null;
  /** SUM(tasks.cost_usd) WHERE owner_id=? AND deleted_at IS NULL. */
  used_total_usd: number;
}

type UserQuotaRow = {
  id: string;
  email: string;
  role: string;
  party_a_enabled: number;
  quota_total_spent_cap: number | null;
  quota_granted_cap: number | null;
  quota_expire_at: string | null;
};

function mapQuotaRows(rows: UserQuotaRow[]): UserWithQuota[] {
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    party_a_enabled: !!u.party_a_enabled,
    quota_total_spent_cap: u.quota_total_spent_cap,
    quota_granted_cap: u.quota_granted_cap,
    quota_expire_at: u.quota_expire_at,
    used_total_usd: getUserQuotaUsedTotal(u.id),
  }));
}

const USER_QUOTA_SELECT =
  `SELECT id, email, role, party_a_enabled, quota_total_spent_cap, quota_granted_cap, quota_expire_at
   FROM users`;

export function listUsersWithQuota(): UserWithQuota[] {
  const db = getDb();
  const rows = db
    .prepare(`${USER_QUOTA_SELECT} ORDER BY created_at ASC`)
    .all() as UserQuotaRow[];
  return mapQuotaRows(rows);
}

// AO-DEV R208: 账号配额用户列表分页. page 1-indexed, page/pageSize 由路由层 clamp.
//   - total = 全表 COUNT (分页 UI 用, 不随页变).
//   - 关注点: used_total_usd 仍每行单独 SUM (N+1), 分页后单页上限 = pageSize,
//     全量拉取的开销只在无分页的旧路径 (listUsersWithQuota) 保留.
export function listUsersWithQuotaPaged(
  page: number,
  pageSize: number
): { users: UserWithQuota[]; total: number } {
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
  const rows = db
    .prepare(`${USER_QUOTA_SELECT} ORDER BY created_at ASC LIMIT ? OFFSET ?`)
    .all(pageSize, (page - 1) * pageSize) as UserQuotaRow[];
  return { users: mapQuotaRows(rows), total };
}
