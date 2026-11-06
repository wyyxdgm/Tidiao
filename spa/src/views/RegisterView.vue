<script setup lang="ts">
// 功能: 注册视图. 与 Next.js master `src/app/register/page.tsx` 1:1 镜像:
//   - 邮箱/密码表单 (密码 ≥ 6 位客户端前置校验) + POST /api/auth/register
//   - 成功: addRecentAccount(email, switchToken) → window.location.href 硬导航
//     到 ?redirect= 或 / (硬导航保证 set-cookie 后 middleware 看到新 cookie,
//     与 Next.js 注释一致)
//   - 409 → 「该邮箱已注册」(覆盖后端英文 msg)
//   - 400 后端校验失败 → 后端 msg (中文覆盖)
//   - 429 → 后端 msg 或「尝试次数过多, 请 N 分钟后再试」(走 Retry-After)
//   - 其他兜底 → 「注册失败, 请重试」
//   - 底部「已有账号? 登录」链接
//
// 与 LoginView 的设计取舍对齐 (sister page):
//   - R46 起改用 R7 Button / R8 Input 封装组件 (与主应用统一); 字段级错误
//     走 Input 组件的 :error prop, 不再单独维护 .input-error + .field-error.
//   - 视觉差异 (auth 卡片灰底 + 居中) 保留在 .register-page / .register-card.
//
// 与 Next.js 的分歧 (commit message 披露):
//   1. Next 用 ?from= query 名; SPA 沿用 LoginView 的 ?redirect= (router
//      beforeEach 已经写入该名, 跨页面统一). 新用户注册成功默认跳 /, 无
//      "之前想去的页" 概念, 实际影响 = 0
//   2. Next 401 走统一文案 — register 不返回 401, 仅 409 (邮箱已注册) +
//      400 (校验失败) + 429 (rate limit) + 5xx, 不引入 "防枚举" 文案
//   3. SPA 字段级错误 UI (input 红边框 + 下方红字) 是 LoginView 引入的
//      客户端前置校验基础设施, register 顺手复用, 客户端先校验密码长度,
//      后端 400 后再叠加服务端错误
// i18n (W1 样板 2026-11-06): 用户可见字符串走 t('register.*'), 文案源
//   spa/src/i18n/locales/{zh-CN,en-US}/register.json; 迁移模式同 LoginView.
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { HttpError } from '@/api/http';
import { hardNavigate } from '@/lib/hard-navigate';
import { addRecentAccount } from '@/lib/recent-accounts';
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
  // 客户端前置校验 —— 邮箱非空 + 密码 ≥ 6 位 (与 Next 一致)。
  const localFieldErrors: { email?: string; password?: string } = {};
  if (!email.value) localFieldErrors.email = t('register.errEmailRequired');
  if (!password.value) {
    localFieldErrors.password = t('register.errPasswordRequired');
  } else if (password.value.length < 6) {
    // 与 Next.js setError("密码至少 6 位") 同款文案。
    localFieldErrors.password = t('register.errPasswordMin');
  }
  if (Object.keys(localFieldErrors).length > 0) {
    resetErrors();
    fieldErrors.value = localFieldErrors;
    errorMsg.value = t('register.errFormIncomplete');
    return;
  }

  resetErrors();
  submitting.value = true;
  try {
    const resp = await auth.register(email.value.trim(), password.value);
    // 持久化 switch token —— 与 LoginView 同款, AccountSwitcher 后续接入
    // 直接读取同一份 localStorage。缺失字段静默跳过。
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
    // 🔴 hash 路由必须落 #/ 形态 (与 LoginView 同款): 裸拼 `/` 只变 hash 不重载,
    //    还会命中 src/app 历史壳 (2026-10-12 实证同坑)。
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
      } else if (err.status === 409) {
        // 与 Next.js 一致: 覆盖后端英文 "Email already registered" 为本地文案。
        errorMsg.value = t('register.errEmailTaken');
      } else if (err.status === 429) {
        // 后端 message 展示原样 (语言随部署方配置); 后端未返回 message 时按
        // Retry-After header 拼本地化兜底文案。
        if (err.message && err.message !== `HTTP ${err.status}`) {
          errorMsg.value = err.message;
        } else if (err.retryAfter) {
          const mins = Math.ceil(err.retryAfter / 60);
          errorMsg.value = t('register.errRateLimitedMinutes', { mins });
        } else {
          errorMsg.value = t('register.errRateLimited');
        }
      } else {
        // 400 (邮箱格式 / 密码不足 6 位 后端二次校验) + 其他兜底。
        errorMsg.value = err.message || t('register.errGeneric');
      }
    } else {
      errorMsg.value = t('register.errGeneric');
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="register-page">
    <LangToggle floating />
    <form class="register-card card" @submit.prevent="onSubmit">
      <h1 class="register-title">{{ t('register.title') }}</h1>
      <p class="register-subtitle">{{ t('register.subtitle') }}</p>

      <div class="form-group">
        <label class="form-label" for="email">{{ t('register.email') }}</label>
        <Input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          placeholder="you@example.com"
          :disabled="submitting"
          :error="fieldErrors.email"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="password">{{ t('register.password') }}</label>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          :disabled="submitting"
          :error="fieldErrors.password"
        />
      </div>

      <div v-if="errorMsg" class="form-error">{{ errorMsg }}</div>

      <Button variant="primary" type="submit" block :loading="submitting">
        {{ submitting ? t('register.submitting') : t('register.submit') }}
      </Button>

      <p class="register-foot">
        {{ t('register.footHasAccount') }}
        <a class="register-link" href="#/login">{{ t('register.footLogin') }}</a>
      </p>
    </form>
  </div>
</template>

<style scoped>
.register-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, var(--t-grad-a) 0%, var(--t-grad-b) 100%);
}
.register-card {
  width: 360px;
  padding: 28px;
  box-shadow: var(--shadow-md);
}
.register-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}
.register-subtitle {
  margin: 0 0 20px;
  color: var(--color-text-muted);
  font-size: 13px;
}
.register-foot {
  margin: 14px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}
.register-link {
  color: var(--color-primary);
}
.register-link:hover {
  text-decoration: underline;
}
</style>
