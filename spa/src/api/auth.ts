import { post } from './http';

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
}

export interface LoginResponse {
  user: SafeUser;
  switchToken: string;
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return post<LoginResponse>('/api/auth/login', { email, password });
}

export function logout(): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/api/auth/logout');
}

// 后端 register 返回体与 login 一致 (user + switchToken)，共用 LoginResponse。
// 后端实际 status=201 (REST 语义)，SPA 走 http.ts 通用处理 (2xx 都算 ok)。
export function register(email: string, password: string): Promise<LoginResponse> {
  return post<LoginResponse>('/api/auth/register', { email, password });
}

// 切换账号: 用 localStorage 里的 switch token 兑换新 session cookie。
// 后端路径 = /api/auth/switch (master src/app/api/auth/switch/route.ts),
// body = {email, token}; 成功 → 200 + {user}; 失败 → 401 (token 过期/作废).
// 关注点: 走原生 fetch 而非 http.ts 的 api() — 本流程 401 不应触发 refresh
// 链 (refresh 路径是「当前 cookie 失效」, 这里是「切到别人 cookie」语义不同);
// 直接拿到 HTTP 状态让 AccountSwitcher 区分处理 (401 = token 失效删条目).
export async function switchAccount(email: string, token: string): Promise<SafeUser> {
  const res = await fetch('/api/auth/switch', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error || `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { user: SafeUser };
  return body.user;
}