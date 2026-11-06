import { defineStore } from 'pinia';
import { ref } from 'vue';
import { login as apiLogin, logout as apiLogout, register as apiRegister, type SafeUser, type LoginResponse } from '@/api/auth';
import { api } from '@/api/http';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<SafeUser | null>(null);
  // 'unknown' = haven't checked yet (initial state).
  // 'yes' = have a session.
  // 'no' = confirmed no session.
  const sessionState = ref<'unknown' | 'yes' | 'no'>('unknown');

  // 返回完整 LoginResponse (含 switchToken) 而非仅 SafeUser —— LoginView 需要
  // switchToken 写入 recent-accounts (localStorage, AccountSwitcher 后续接入)。
  // 其他调用方原本就没读返回值, 改动不破现有契约。
  async function login(email: string, password: string): Promise<LoginResponse> {
    const resp = await apiLogin(email, password);
    user.value = resp.user;
    sessionState.value = 'yes';
    return resp;
  }

  // register 与 login 走同一份后端响应形状 (user + switchToken), sessionState
  // 翻转到 'yes' 后 LoginView 成功路径用的 addRecentAccount 逻辑在 RegisterView
  // 直接复用。返回 LoginResponse 而非仅 SafeUser, 与 login() 同款。
  async function register(email: string, password: string): Promise<LoginResponse> {
    const resp = await apiRegister(email, password);
    user.value = resp.user;
    sessionState.value = 'yes';
    return resp;
  }

  async function logout() {
    try {
      await apiLogout();
    } finally {
      user.value = null;
      sessionState.value = 'no';
    }
  }

  // Try a cheap request to learn session state.
  // /api/projects returns 401 if no session, 200 if have session (canary).
  // After confirming session, also fetch /api/user/me to populate `user.value` —
  // LoginView/RegisterView hard-navigate after success, which wipes the in-memory
  // pinia store. Without this second fetch, `auth.user` stays null on every
  // full page reload and the sidebar bottom-left AccountSwitcher (R56-B5)
  // never renders (`<div v-if="auth.user">`).
  async function checkSession(): Promise<boolean> {
    try {
      const r = await fetch('/api/projects', { credentials: 'include' });
      if (!r.ok) {
        sessionState.value = 'no';
        return false;
      }
      sessionState.value = 'yes';
    } catch {
      sessionState.value = 'no';
      return false;
    }
    // Session confirmed; populate user object via /api/user/me. Use raw fetch
    // (not `api()`) to avoid the 401-refresh chain — if /api/user/me 401s here
    // we just leave user=null (caller already gated on sessionState==='yes').
    try {
      const me = await api<SafeUser>('/api/user/me');
      user.value = me;
    } catch {
      // /api/user/me failed despite /api/projects returning 200. Don't flip
      // sessionState back to 'no' (session is valid, just couldn't fetch
      // profile). Leave user=null so AccountSwitcher stays hidden rather than
      // render a placeholder with a stale user object.
    }
    return true;
  }

  return { user, sessionState, login, register, logout, checkSession };
});