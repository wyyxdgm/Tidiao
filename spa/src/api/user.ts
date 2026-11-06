// 🆕 R26: 用户级通用设置 API 封装 — 对应 master src/app/api/user/me/route.ts.
//   与 GET /api/user/me 一致: 返回 SafeUser + mailer_configured + feishu_configured +
//   notify_fallback_to 等扩展字段; PATCH 接 { preflight_enabled | notify_email |
//   feishu_webhook_url } 单字段更新.

import { get, patch } from './http';

/** GET /api/user/me 响应 — 与 master route.ts:33-52 字段对齐.
    feishu_webhook_url 不返明文 (字段本身在响应里以 undefined 出现, 简化前端
    用 feishu_configured 布尔判断 + /webhook-meta 拿脱敏值). */
export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  created_at?: string;
  admin_llm_granted?: boolean;
  preflight_enabled: boolean;
  notify_email: string | null;
  mailer_configured?: boolean;
  feishu_configured?: boolean;
  notify_fallback_to?: string | null;
  // v55+ R88 quota: 个人端展示字段 (Sheet L 验收 ⑤).
  // GET /api/user/me 不返 used_total_usd (聚合避免 /user/me 变重) —— 用户端配额卡
  // 只展示 caps + expire_at, 不画进度条; admin 接口 /api/admin/users 才返聚合 used_total_usd.
  party_a_enabled?: boolean;
  quota_total_spent_cap?: number | null;
  quota_granted_cap?: number | null;
  quota_expire_at?: string | null;
  /** v515 (飞书 R178): 账号级 git 提交身份. null = 回落默认 (email→账号邮箱, name→前缀) */
  git_name?: string | null;
  git_email?: string | null;
  /** v518 (飞书 R222): 用户身份. nickname null = agent 回落称「用户」; bio null = 注入时省略 */
  nickname?: string | null;
  bio?: string | null;
}

/** GET /api/user/me — 当前用户 profile. */
export function getMyProfile(): Promise<UserProfile> {
  return get<UserProfile>('/api/user/me');
}

/** PATCH /api/user/me 入参. master 一次只接受一个字段; 多字段需多次 PATCH.
    关注点:
    - "preflight_enabled": boolean (v27)
    - "notify_email": string | null (空串/未传视为 null, 与 v41 一致)
    - "feishu_webhook_url": string | null (v47)
    - "git_name" + "git_email": string | null (v515, 俩字段一次写, R178)
    - "nickname" + "bio": string | null (v518, 俩字段一次写, R222) */
export interface UserProfileUpdate {
  preflight_enabled?: boolean;
  notify_email?: string | null;
  feishu_webhook_url?: string | null;
  git_name?: string | null;
  git_email?: string | null;
  nickname?: string | null;
  bio?: string | null;
}

/** PATCH /api/user/me — 单字段更新. 后端校验失败返 400 + {error:string}. */
export function updateMyProfile(body: UserProfileUpdate): Promise<UserProfile> {
  return patch<UserProfile>('/api/user/me', body);
}
