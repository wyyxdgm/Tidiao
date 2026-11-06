<script setup lang="ts">
// 功能: 登录视图. 与 Next.js master `src/app/login/page.tsx` 1:1 镜像:
//   - 邮箱/密码表单 + POST /api/auth/login
//   - 成功: addRecentAccount(email, switchToken) → window.location.href 硬导航
//     到 ?redirect= 或 / (硬导航保证 set-cookie 后 middleware 看到新 cookie)
//   - 401 统一「邮箱或密码错误」(防枚举); 429 用后端 message 或「请 N 分钟后再试」
//   - 失败兜底「登录失败，请重试」
//   - 底部「没有账号? 注册」链接 (SPA 暂无 /register 路由, 走 hash 跳 catch-all → /,
//     commit message 披露; register.vue 属 R+ 范畴)
//
// 与原 LoginView (M1 scaffold) 的差异:
//   1. 新增 recent-accounts 持久化 (switchToken 进 localStorage, AccountSwitcher
//      后续接入直接消费)
//   2. 改用 window.location 硬导航 (router.push 在 set-cookie 后可能仍带旧
//      cookie, 被弹回 login —— 与 Next.js 注释一致)
//   3. 支持 ?redirect= query (router beforeEach 已经写入, 跟随回跳)
//   4. 401 文案统一为「邮箱或密码错误」(后端 msg 是英文 "Invalid email or password",
//      与 Next 端覆盖一致)
//   5. 底部注册链接 (Next 端 <Link href="/register">, SPA 用 <a href="#/register">)
// i18n (W1 样板 2026-11-06): 用户可见字符串走 t('login.*'), 文案源
//   spa/src/i18n/locales/{zh-CN,en-US}/login.json; 本文件是 i18n 迁移样板,
//   后续波次照抄此模式 (script: useI18n → t; template: {{ t('key') }}).
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { HttpError } from '@/api/http';
import { addRecentAccount } from '@/lib/recent-accounts';
import { hardNavigate } from '@/lib/hard-navigate';
import Input from '@/components/Input.vue';
import Button from '@/components/Button.vue';
import LangToggle from '@/components/LangToggle.vue';

const auth = useAuthStore();
const route = useRoute();
const { t } = useI18n();

const email = ref('');
const password = ref('');
const submitting = ref(false);
const errorMsg = ref<string | null>(null);
// 字段级错误: 后端校验失败 / 客户端前置校验失败时按字段名定位显示。
const fieldErrors = ref<{ email?: string; password?: string }>({});

function resetErrors() {
  errorMsg.value = null;
  fieldErrors.value = {};
}

async function onSubmit() {
  // 客户端前置校验 —— 用 HttpError 走统一错误链路, 让 isFormError / getFieldError
  // 路径在没接后端 Zod 错误时也能跑通, 表单 UI 立即可见字段级反馈。
  const localFieldErrors: { email?: string; password?: string } = {};
  if (!email.value) localFieldErrors.email = t('login.errEmailRequired');
  if (!password.value) localFieldErrors.password = t('login.errPasswordRequired');
  if (Object.keys(localFieldErrors).length > 0) {
    resetErrors();
    fieldErrors.value = localFieldErrors;
    errorMsg.value = t('login.errFormIncomplete');
    return;
  }

  resetErrors();
  submitting.value = true;
  try {
    const resp = await auth.login(email.value.trim(), password.value);
    // 持久化 switch token —— AccountSwitcher 后续接入直接读取同一 localStorage。
    // 缺失字段时静默跳过 (与 Next.js addRecentAccount 内部防御一致)。
    if (resp?.switchToken && resp?.user?.email) {
      addRecentAccount(resp.user.email, resp.switchToken);
    }
    // 硬导航 (非 router.push): set-cookie 后 client-side navigation 可能仍带旧
    // cookie 状态被 middleware 弹回 login。hardNavigate 整页重载, 确保带新 cookie
    // 且清掉旧会话残留的 store / keep-alive。回跳目标 = ?redirect= (router
    // beforeEach 写入) 或 /。
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    // 只接受同源相对路径, 防 open-redirect (//evil.com/x → 被中间人改写或钓鱼)。
    const safe = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/';
    // 🔴 hash 路由必须落 #/ 形态: redirect 是 SPA 内部路径, 裸拼会命中 src/app
    //    历史壳 (能用但不是对外 SPA; 2026-10-12 实证: wiki 深链登录后落到旧壳页)。
    hardNavigate(`/#${safe}`);
  } catch (e) {
    // 关注点: 不用 `HttpError.isFormError` 作为类型守卫, 避免 TS 把
    // 已 const 化的 `err` 在 false 分支缩到 never (因为 `err is HttpError`
    // 在 false 分支意味着 NOT HttpError, 与 const 类型矛盾)。改为内联
    // 判断 fieldErrors, 既保留类型又便于阅读。
    if (e instanceof HttpError) {
      const err: HttpError = e;
      const fe = err.fieldErrors;
      const hasFieldErrors = !!fe && Object.keys(fe).length > 0;
      if (hasFieldErrors) {
        fieldErrors.value = {
          email: fe!.email,
          password: fe!.password,
        };
        // 顶层仅当后端 message 不与任一字段错重复时才展示, 避免信息冗余。
        if (!Object.values(fe!).some((v) => v === err.message)) {
          errorMsg.value = err.message;
        }
      } else if (err.status === 401) {
        // 与 Next.js 一致: 不区分用户存在与否, 统一文案防枚举。
        errorMsg.value = t('login.errBadCredentials');
      } else if (err.status === 429) {
        // 后端 message 展示原样 (语言随部署方配置); 后端未返回 message 时按
        // Retry-After header 拼本地化兜底文案。
        if (err.message && err.message !== `HTTP ${err.status}`) {
          errorMsg.value = err.message;
        } else if (err.retryAfter) {
          const mins = Math.ceil(err.retryAfter / 60);
          errorMsg.value = t('login.errRateLimitedMinutes', { mins });
        } else {
          errorMsg.value = t('login.errRateLimited');
        }
      } else {
        errorMsg.value = err.message || t('login.errGeneric');
      }
    } else {
      errorMsg.value = t('login.errGeneric');
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <LangToggle floating />
    <form class="login-card card" @submit.prevent="onSubmit">
      <h1 class="login-title">{{ t('login.title') }}</h1>
      <p class="login-subtitle">{{ t('login.subtitle') }}</p>

      <div class="form-group">
        <label class="form-label" for="email">{{ t('login.email') }}</label>
        <Input
          id="email"
          v-model="email"
          type="email"
          autocomplete="username"
          placeholder="you@example.com"
          :disabled="submitting"
          :error="fieldErrors.email"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="password">{{ t('login.password') }}</label>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="submitting"
          :error="fieldErrors.password"
        />
      </div>

      <div v-if="errorMsg" class="form-error">{{ errorMsg }}</div>

      <Button variant="primary" type="submit" block :loading="submitting">
        {{ submitting ? t('login.submitting') : t('login.submit') }}
      </Button>

      <p class="login-foot">
        {{ t('login.footNoAccount') }}
        <a class="login-link" href="#/register">{{ t('login.footRegister') }}</a>
      </p>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, var(--t-grad-a) 0%, var(--t-grad-b) 100%);
}
.login-card {
  width: 360px;
  padding: 28px;
  box-shadow: var(--shadow-md);
}
.login-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}
.login-subtitle {
  margin: 0 0 20px;
  color: var(--color-text-muted);
  font-size: 13px;
}
.login-foot {
  margin: 14px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}
.login-link {
  color: var(--color-primary);
}
.login-link:hover {
  text-decoration: underline;
}
</style>
