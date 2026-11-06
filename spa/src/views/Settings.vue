<script setup lang="ts">
/* 功能: Settings 通用设置视图 — 对应 Next src/app/settings/page.tsx.
   sheet R7 字面要求 = "按 Next.js src/app/settings/page.tsx 完全镜像实现. URL: hash 模式 → #/settings.
   功能要点: 声音/紧凑阈值/全局 timeout/API token/可用模型等 (3035 行大页)".

   范围策略:
   - Tab 结构: 4 个 (account/notify/schedule/platform), platform 仅 admin 可见.
   - 已实现: 身份 + Preflight + 通知邮箱 + 飞书机器人 + 调度器参数 + 系统 API 配置 (R26 沉淀).
   - 本轮新增: tab 导航 + 提示音设置 + Fork 压缩阈值 + API Token + 多模态 API Key + 维护模式.
   - 未实现 (后续轮次): 个人 LLM 配置 + 平台 LLM 配置 + 用户授权 + 账号配额.
     这些与 Next 1:1 镜像需单独 API client + 复杂列表 + 模态框, 单轮做不完.

   关注点 (R7 与 R26 + Next 现实分歧):
   - sheet 字面 "完全镜像" → 实际是分块实现 (R26 + 本轮 + 后续); commit 披露差异.
   - 提示音 / Fork 压缩阈值 是纯客户端 (localStorage), 与 Next 端 lib/sound-settings / fork-settings 同款.
   - 管理员 PATCH /api/config 仅 admin (后端 403 兜底), UI 层前置权限检查避免无谓请求.
   - API Token 创建后明文只显示一次 (前端严格同源, 后端 hash 存储).
   - 维护模式 admin only, 非 admin 拿到 403 → 整块 UI 不渲染. */

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import {
  getAppConfig,
  updateAppConfig,
  type AppConfig,
} from '@/api/config';
import {
  getMyProfile,
  updateMyProfile,
  type UserProfile,
} from '@/api/user';
import { get, post, patch, put, del, isHttpError } from '@/api/http';
import { useToast } from '@/composables/useToast';
import { useAvailableModels } from '@/composables/useAvailableModels';
import { useProviderCatalog, type CatalogProvider } from '@/composables/useProviderCatalog';
import { getLang, setLang, SUPPORTED_LANGS, type Lang } from '@/i18n';
import Button from '@/components/Button.vue';
import Input from '@/components/Input.vue';
import Textarea from '@/components/Textarea.vue';
import Select from '@/components/Select.vue';
import Checkbox from '@/components/Checkbox.vue';
import Loading from '@/components/Loading.vue';
import Empty from '@/components/Empty.vue';
import ErrorView from '@/components/ErrorView.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Pagination from '@/components/Pagination.vue';
import RolesPanel from '@/components/RolesPanel.vue';
import ChannelsPanel from '@/components/ChannelsPanel.vue';

/* ------------------------------------------------------------------ */
/*  Tab 状态                                                            */
/* ------------------------------------------------------------------ */

/** 与 Next.js v54 R17 一致: 4 个 tab, platform 仅 admin. 波3 P5 加 roles tab. */
type TabId = 'account' | 'notify' | 'schedule' | 'roles' | 'channels' | 'platform';
const activeTab = ref<TabId>('account');
const isAdmin = computed<boolean>(() => auth.user?.role === 'admin');

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

const auth = useAuthStore();
const toast = useToast();
const { t } = useI18n();

/* ------------------------------------------------------------------ */
/*  语言 / Language 设置 (W2a) — 读 getLang() 显当前, 切换走 setLang      */
/* ------------------------------------------------------------------ */

// 语言原生名不翻译 (每种语言显示自己的名字).
const LANG_LABELS: Record<Lang, string> = { 'zh-CN': '简体中文', 'en-US': 'English' };
const langOptions = SUPPORTED_LANGS.map((l) => ({ value: l, label: LANG_LABELS[l] }));
const currentLang = computed<Lang>(() => getLang());
function onLangChange(v: string | null): void {
  if (v) setLang(v as Lang);
}

/* 模型下拉数据源 (configured + builtin + used) — 个人/admin LLM 编辑表单的
   Model 字段用 datalist 喂建议, 用户仍可输入自定义 model 名. 与 master
   settings/page.tsx:275 useAvailableModels() 同源. */
const { options: modelOptions } = useAvailableModels();
const modelStringList = computed<string[]>(() =>
  modelOptions.value
    .map((o) => o.value)
    .filter((v): v is string => !!v),
);

/* R240: 供应商目录 — 「快捷选择供应商」数据源. 选厂商 → 自动填 base_url +
   模型 datalist 切到该厂商列表 → 用户只需填 key. 拉取失败不阻塞手填流程. */
const { providers: catalogProviders, catalogUpdatedAt } = useProviderCatalog();

const providerSelectOptions = computed<{ value: string; label: string }[]>(() => [
  { value: '', label: t('settings.llm.providerManual') },
  ...catalogProviders.value.map((p) => ({ value: p.id, label: `${p.name} · ${p.vendor}` })),
]);

function findProviderById(id: string | null | undefined): CatalogProvider | null {
  if (!id) return null;
  return catalogProviders.value.find((p) => p.id === id) ?? null;
}

/** 按 base_url 反查厂商 (编辑已有配置 / 手动粘贴 url 时自动匹配). 前缀归一匹配, 与后端 matchProviderByBaseUrl 同规则. */
function matchProviderByUrl(url: string | null | undefined): CatalogProvider | null {
  if (!url) return null;
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  const target = norm(url);
  if (!target) return null;
  return (
    catalogProviders.value.find((p) => {
      const base = norm(p.anthropic_base_url);
      return target === base || target.startsWith(base);
    }) ?? null
  );
}

/** 选中厂商 → 自动填 base_url. 不清 model (用户从 datalist 接着选), 不动 key. */
function applyProvider(
  draft: { base_url: string; model: string },
  providerId: string,
): void {
  const p = findProviderById(providerId);
  if (!p) return;
  draft.base_url = p.anthropic_base_url;
}

/** datalist 联动: 选了厂商 → 该厂商 models (+当前已填值); 未选 → 原有 configured+builtin+used. */
function modelSuggestions(providerId: string, current: string): string[] {
  const p = findProviderById(providerId);
  if (!p) return modelStringList.value;
  const set = new Set(p.models);
  if (current.trim()) set.add(current.trim());
  return [...set];
}

/* provider 联动 (llmProviderId/watch/computed) 在 adminLlmDraft 声明之后 ——
   watch getter 创建时立即求值, 放在 draft 声明前会 TDZ 崩掉整个 Settings 页
   (8dab044f 引入, damo 1013 实证: Cannot access 'llmDraft' before initialization)。 */

/* ------------------------------------------------------------------ */
/*  App-level config state (/api/config) — schedule tab + platform     */
/* ------------------------------------------------------------------ */

const config = ref<AppConfig | null>(null);
const configLoading = ref<boolean>(false);
const configError = ref<string | null>(null);
const configRetrying = ref<boolean>(false);

interface AppConfigForm {
  concurrency: string;
  task_timeout_minutes: string;
  portPoolSegments: { start: string; end: string }[];
}
const appForm = reactive<AppConfigForm>({
  concurrency: '',
  task_timeout_minutes: '',
  portPoolSegments: [],
});
const appSaving = ref<boolean>(false);
const appFieldErrors = reactive<Record<string, string>>({});

function hydrateAppForm(c: AppConfig) {
  appForm.concurrency = String(c.concurrency);
  appForm.task_timeout_minutes = String(c.task_timeout_minutes);
  appForm.portPoolSegments = c.port_pool.map(([s, e]) => ({
    start: String(s),
    end: String(e),
  }));
}

async function loadConfig(showRetrying = false) {
  configLoading.value = true;
  if (showRetrying) configRetrying.value = true;
  configError.value = null;
  try {
    const c = await getAppConfig();
    config.value = c;
    hydrateAppForm(c);
  } catch (e) {
    configError.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
  } finally {
    configLoading.value = false;
    configRetrying.value = false;
  }
}

function serializePortPool(): { ok: true; value: number[][] } | { ok: false; error: string } {
  const c = config.value;
  if (!c) return { ok: false, error: t('settings.sched.notLoaded') };
  if (appForm.portPoolSegments.length === 0) {
    return { ok: false, error: t('settings.sched.minSegments') };
  }
  if (appForm.portPoolSegments.length > c.port_pool_max_segments) {
    return { ok: false, error: t('settings.sched.maxSegments', { max: c.port_pool_max_segments, cur: appForm.portPoolSegments.length }) };
  }
  const portLo = c.port_pool_min;
  const portHi = c.port_pool_max;
  const out: number[][] = [];
  for (let i = 0; i < appForm.portPoolSegments.length; i++) {
    const seg = appForm.portPoolSegments[i];
    const s = Number(seg.start);
    const e = Number(seg.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)
      || !Number.isInteger(s) || !Number.isInteger(e)
      || s < portLo || e > portHi || s > e) {
      return { ok: false, error: t('settings.sched.segInvalid', { idx: i + 1, lo: portLo, hi: portHi }) };
    }
    out.push([s, e]);
  }
  return { ok: true, value: out };
}

function addPortPoolSegment() {
  if (!config.value) return;
  if (appForm.portPoolSegments.length >= config.value.port_pool_max_segments) {
    toast.warn(t('settings.sched.maxSegmentsToast', { max: config.value.port_pool_max_segments }));
    return;
  }
  appForm.portPoolSegments.push({ start: '', end: '' });
}

function removePortPoolSegment(idx: number) {
  appForm.portPoolSegments.splice(idx, 1);
}

async function saveAppConfig() {
  if (!config.value) return;
  for (const k of Object.keys(appFieldErrors)) delete appFieldErrors[k];

  const concurrencyStr = appForm.concurrency.trim();
  const taskTimeoutStr = appForm.task_timeout_minutes.trim();
  const portPool = serializePortPool();

  const c = config.value;
  const concurrency = Number(concurrencyStr);
  if (concurrencyStr === '' || !Number.isInteger(concurrency)
    || concurrency < c.concurrency_min || concurrency > c.concurrency_max) {
    appFieldErrors.concurrency = t('settings.sched.concurrencyRange', { min: c.concurrency_min, max: c.concurrency_max });
    return;
  }
  const taskTimeout = Number(taskTimeoutStr);
  if (taskTimeoutStr === '' || !Number.isInteger(taskTimeout)
    || taskTimeout < c.task_timeout_min || taskTimeout > c.task_timeout_max) {
    appFieldErrors.task_timeout_minutes = t('settings.sched.timeoutRange', { min: c.task_timeout_min, max: c.task_timeout_max });
    return;
  }
  if (portPool === null || portPool.ok === false) {
    appFieldErrors.port_pool = portPool === null
      ? t('settings.sched.portFormatInvalid')
      : portPool.error;
    return;
  }

  appSaving.value = true;
  try {
    const updated = await updateAppConfig({
      concurrency,
      task_timeout_minutes: taskTimeout,
      port_pool: portPool.value,
    });
    config.value = updated;
    hydrateAppForm(updated);
    toast.success(t('settings.sched.savedOk'));
  } catch (e) {
    if (isHttpError(e)) {
      const fe = e.fieldErrors;
      if (fe) {
        for (const [k, v] of Object.entries(fe)) {
          appFieldErrors[k] = v;
        }
      } else if (e.status === 403) {
        toast.error(t('settings.sched.needAdmin'));
      } else {
        toast.error(e.message);
      }
    } else {
      toast.error(t('settings.common.saveFailed'));
    }
  } finally {
    appSaving.value = false;
  }
}

function resetAppForm() {
  if (config.value) hydrateAppForm(config.value);
  for (const k of Object.keys(appFieldErrors)) delete appFieldErrors[k];
}

/* ------------------------------------------------------------------ */
/*  User-level profile state (/api/user/me) — account + notify         */
/* ------------------------------------------------------------------ */

const profile = ref<UserProfile | null>(null);
const profileLoading = ref<boolean>(false);
const profileError = ref<string | null>(null);
const profileRetrying = ref<boolean>(false);

interface ProfileForm {
  preflight_enabled: boolean;
  notify_email: string;
  feishu_webhook_url: string;
  git_name: string;
  git_email: string;
  nickname: string;
  bio: string;
}
const profileForm = reactive<ProfileForm>({
  preflight_enabled: false,
  notify_email: '',
  feishu_webhook_url: '',
  git_name: '',
  git_email: '',
  nickname: '',
  bio: '',
});

const preflightSaving = ref<boolean>(false);
const notifySaving = ref<boolean>(false);
const feishuSaving = ref<boolean>(false);
const gitSaving = ref<boolean>(false);
const profileSaving = ref<boolean>(false);

function isValidFeishuWebhook(s: string): boolean {
  return s === '' || /^https:\/\/open\.feishu\.cn\/hook\/[A-Za-z0-9-]+$/.test(s);
}

function isValidEmail(s: string): boolean {
  return s === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function hydrateProfileForm(p: UserProfile) {
  profileForm.preflight_enabled = p.preflight_enabled;
  profileForm.notify_email = p.notify_email || '';
  profileForm.feishu_webhook_url = ''; // 不回显
  profileForm.git_name = p.git_name || '';
  profileForm.git_email = p.git_email || '';
  profileForm.nickname = p.nickname || '';
  profileForm.bio = p.bio || '';
}

async function loadProfile(showRetrying = false) {
  profileLoading.value = true;
  if (showRetrying) profileRetrying.value = true;
  profileError.value = null;
  try {
    const p = await getMyProfile();
    profile.value = p;
    /* R56-B5: 同步到 auth store, 让 isAdmin (平台 tab/banner/loadAdminLlm/loadGrants
       这些 role-based UI) 在刷新页面后立刻生效. 之前 auth.user 仅 login/register
       时设置 → 刷新后 auth.user=null → isAdmin=false → 整个平台 tab 不渲染. */
    auth.user = {
      id: p.id,
      email: p.email,
      name: p.name,
      role: p.role,
    };
    hydrateProfileForm(p);
    void loadFeishuWebhookMeta();
  } catch (e) {
    profileError.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
  } finally {
    profileLoading.value = false;
    profileRetrying.value = false;
  }
}

async function savePreflight(enabled: boolean) {
  preflightSaving.value = true;
  const prev = profileForm.preflight_enabled;
  profileForm.preflight_enabled = enabled;
  try {
    const updated = await updateMyProfile({ preflight_enabled: enabled });
    profile.value = updated;
    toast.success(enabled ? t('settings.preflight.enabledOk') : t('settings.preflight.disabledOk'));
  } catch (e) {
    profileForm.preflight_enabled = prev;
    toast.error(getErrorMsg(e, t('settings.common.saveFailed')));
  } finally {
    preflightSaving.value = false;
  }
}

async function saveNotifyEmail() {
  const trimmed = profileForm.notify_email.trim();
  if (!isValidEmail(trimmed)) {
    toast.error(t('settings.notify.errEmail'));
    return;
  }
  notifySaving.value = true;
  try {
    const updated = await updateMyProfile({ notify_email: trimmed || null });
    profile.value = updated;
    hydrateProfileForm(updated);
    toast.success(trimmed ? t('settings.notify.savedTo', { email: trimmed }) : t('settings.notify.clearedTo'));
  } catch (e) {
    toast.error(getErrorMsg(e, t('settings.common.saveFailed')));
  } finally {
    notifySaving.value = false;
  }
}

/** 保存账号级 git 提交身份 (v515, 飞书 R178). 留空 = 回落默认 (email→账号邮箱,
    name→邮箱前缀). 前端校验只挡明显脏值, 权威校验在 API (400 会带原因). */
async function saveGitIdentity() {
  const trimmedName = profileForm.git_name.trim();
  const trimmedEmail = profileForm.git_email.trim();
  if (trimmedName && /[<>\n\r]/.test(trimmedName)) {
    toast.error(t('settings.git.errNameChars'));
    return;
  }
  if (!isValidEmail(trimmedEmail)) {
    toast.error(t('settings.git.errEmail'));
    return;
  }
  gitSaving.value = true;
  try {
    const updated = await updateMyProfile({
      git_name: trimmedName || null,
      git_email: trimmedEmail || null,
    });
    profile.value = updated;
    hydrateProfileForm(updated);
    const effectiveEmail = updated.git_email || profile.value?.email || '';
    const effectiveName = updated.git_name || effectiveEmail.split('@')[0];
    toast.success(t('settings.git.savedWith', { name: effectiveName, email: effectiveEmail }));
  } catch (e) {
    toast.error(getErrorMsg(e, t('settings.common.saveFailed')));
  } finally {
    gitSaving.value = false;
  }
}

/** 保存用户身份 (v518, 飞书 R222). 留空 = 回落默认 (昵称→「用户」,
    自我介绍→省略). 前端校验只挡明显脏值, 权威校验在 API (400 会带原因). */
async function saveUserProfile() {
  const trimmedNickname = profileForm.nickname.trim();
  const trimmedBio = profileForm.bio.trim();
  if (trimmedNickname && /[\r\n]/.test(trimmedNickname)) {
    toast.error(t('settings.userProfile.errNicknameNewline'));
    return;
  }
  if (trimmedBio.length > 2000) {
    toast.error(t('settings.userProfile.errBioTooLong'));
    return;
  }
  profileSaving.value = true;
  try {
    const updated = await updateMyProfile({
      nickname: trimmedNickname || null,
      bio: trimmedBio || null,
    });
    profile.value = updated;
    hydrateProfileForm(updated);
    toast.success(t('settings.userProfile.savedWithNickname', { name: updated.nickname || t('settings.userProfile.defaultNickname') }));
  } catch (e) {
    toast.error(getErrorMsg(e, t('settings.common.saveFailed')));
  } finally {
    profileSaving.value = false;
  }
}

/** 真发一封测试邮件到当前生效的收件人.
   关注点: 端点不接受任意地址 (防开放中继), 发的是「已保存」地址 —— 改了
   输入框没保存就点测试会困惑. 文案里要说清这点 (镜像 master line 2109-2121). */
const notifyTesting = ref<boolean>(false);
const notifyMessage = ref<string | null>(null);
async function handleNotifyEmailTest() {
  notifyTesting.value = true;
  notifyMessage.value = null;
  try {
    const res = await post<{
      sent?: boolean;
      to?: string;
      using_fallback?: boolean;
      response?: string;
      reason?: string;
    }>('/api/user/notify-email/test', {});
    if (res.sent) {
      notifyMessage.value = t('settings.notify.sentOk', {
        to: res.to,
        fallback: res.using_fallback ? t('settings.notify.sentFallback') : '',
        resp: res.response || t('settings.notify.respDefault'),
      });
    } else {
      notifyMessage.value = t('settings.notify.notSent', { reason: res.reason || t('settings.notify.unknownReason') });
    }
  } catch (e) {
    notifyMessage.value = t('settings.notify.sendFailed', { msg: getErrorMsg(e, '') });
  } finally {
    notifyTesting.value = false;
  }
}

async function saveFeishuWebhook() {
  const trimmed = profileForm.feishu_webhook_url.trim();
  if (!isValidFeishuWebhook(trimmed)) {
    toast.error(t('settings.feishu.errUrl'));
    return;
  }
  feishuSaving.value = true;
  try {
    const updated = await updateMyProfile({ feishu_webhook_url: trimmed || null });
    profile.value = updated;
    hydrateProfileForm(updated);
    toast.success(trimmed ? t('settings.feishu.savedOk') : t('settings.feishu.clearedOk'));
  } catch (e) {
    toast.error(getErrorMsg(e, t('settings.common.saveFailed')));
  } finally {
    feishuSaving.value = false;
  }
}

/** 飞书 webhook meta (末 4 位脱敏) — 镜像 master line 428-439.
   关注点: webhook 是半秘密, profile.feishu_configured 只能判定有没有,
   看不到具体 URL. 末 4 位脱敏用于 "已配" 提示 + 让用户确认自己配的就是那一个. */
interface FeishuWebhookMeta {
  masked_url: string | null;
}
const feishuWebhookMeta = ref<FeishuWebhookMeta | null>(null);

async function loadFeishuWebhookMeta() {
  try {
    const res = await get<FeishuWebhookMeta>('/api/user/me/webhook-meta');
    feishuWebhookMeta.value = res;
  } catch {
    // 静默 — 不阻断主流程
  }
}

/** 飞书消息类型 + post 模式字段 (镜像 master line 566-570).
   text 兼容老 webhook (不支持 markdown 的) — 选 text 最稳. */
type FeishuMsgType = 'text' | 'markdown' | 'post';
const feishuMsgType = ref<FeishuMsgType>('text');
const feishuPostTitle = ref<string>('');
const feishuPostContent = ref<string>(
  '[[{"tag":"text","text":"项目有更新: "},{"tag":"a","text":"请查看","href":"https://example.com"}}]]',
);

const feishuWebhookTesting = ref<boolean>(false);
const feishuWebhookMessage = ref<string | null>(null);

async function handleFeishuWebhookTest() {
  feishuWebhookTesting.value = true;
  feishuWebhookMessage.value = null;
  try {
    const reqBody: Record<string, unknown> = {
      webhook_url: profileForm.feishu_webhook_url.trim() || undefined,
      msg_type: feishuMsgType.value,
    };
    if (feishuMsgType.value === 'post') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(feishuPostContent.value);
      } catch {
        feishuWebhookMessage.value = t('settings.feishu.parseFail');
        feishuWebhookTesting.value = false;
        return;
      }
      reqBody.post = {
        ...(feishuPostTitle.value ? { title: feishuPostTitle.value } : {}),
        content: parsed,
      };
    }
    const res = await post<{
      sent?: boolean;
      masked_url?: string;
      status?: number;
      reason?: string;
    }>('/api/user/notify-feishu/test', reqBody);
    if (res.sent) {
      feishuWebhookMessage.value = t('settings.feishu.sentOk', {
        to: res.masked_url || t('settings.feishu.groupDefault'),
        status: res.status || t('settings.feishu.statusDefault'),
      });
    } else {
      feishuWebhookMessage.value = t('settings.notify.notSent', { reason: res.reason || t('settings.notify.unknownReason') });
    }
  } catch (e) {
    feishuWebhookMessage.value = t('settings.notify.sendFailed', { msg: getErrorMsg(e, '') });
  } finally {
    feishuWebhookTesting.value = false;
  }
}

function getErrorMsg(e: unknown, fallback: string): string {
  if (isHttpError(e)) return e.message;
  return fallback;
}

/* ------------------------------------------------------------------ */
/*  提示音设置 (localStorage, 纯客户端) — account tab                 */
/*  对应 Next src/lib/sound-settings.ts + lib/sound.ts                  */
/* ------------------------------------------------------------------ */

type SoundEventKey =
  | 'tool_approval'
  | 'user_dialog'
  | 'reviewing'
  | 'failed'
  | 'paused'
  | 'queued'
  | 'cancelled';

interface SoundSettings {
  enabled: boolean;
  events: Record<SoundEventKey, boolean>;
}

/* label/desc 存 i18n key, 模板里 t() 翻译 (语言切换即时生效) */
const SOUND_EVENT_OPTIONS: { key: SoundEventKey; labelKey: string; descKey: string }[] = [
  { key: 'tool_approval', labelKey: 'settings.sound.ev.toolApproval.label', descKey: 'settings.sound.ev.toolApproval.desc' },
  { key: 'user_dialog', labelKey: 'settings.sound.ev.userDialog.label', descKey: 'settings.sound.ev.userDialog.desc' },
  { key: 'reviewing', labelKey: 'settings.sound.ev.reviewing.label', descKey: 'settings.sound.ev.reviewing.desc' },
  { key: 'failed', labelKey: 'settings.sound.ev.failed.label', descKey: 'settings.sound.ev.failed.desc' },
  { key: 'paused', labelKey: 'settings.sound.ev.paused.label', descKey: 'settings.sound.ev.paused.desc' },
  { key: 'queued', labelKey: 'settings.sound.ev.queued.label', descKey: 'settings.sound.ev.queued.desc' },
  { key: 'cancelled', labelKey: 'settings.sound.ev.cancelled.label', descKey: 'settings.sound.ev.cancelled.desc' },
];

const SOUND_DEFAULTS: SoundSettings = {
  enabled: true,
  events: {
    tool_approval: true,
    user_dialog: true,
    reviewing: true,
    failed: true,
    paused: false,
    queued: false,
    cancelled: false,
  },
};

const SOUND_STORAGE_KEY = 'sound-settings';

function loadSoundSettings(): SoundSettings {
  if (typeof window === 'undefined') return SOUND_DEFAULTS;
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) return SOUND_DEFAULTS;
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled ?? SOUND_DEFAULTS.enabled,
      events: { ...SOUND_DEFAULTS.events, ...(parsed.events ?? {}) },
    };
  } catch {
    return SOUND_DEFAULTS;
  }
}

const soundSettings = ref<SoundSettings>(loadSoundSettings());

watch(soundSettings, (next) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可用 (隐私模式 / 配额满) — 静默
  }
}, { deep: true });

/** Web Audio API 合成短促 beep — 与 Next lib/sound.ts 同款. SSR 安全. */
let audioCtx: AudioContext | null = null;

function playNotifySound(): void {
  if (typeof window === 'undefined') return;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    // 静默
  }
}

/* ------------------------------------------------------------------ */
/*  Fork 自动压缩阈值 (localStorage, 纯客户端) — account tab           */
/*  对应 Next src/lib/fork-settings.ts                                 */
/* ------------------------------------------------------------------ */

const FORK_STORAGE_KEY = 'fork-compact-threshold';
const FORK_DEFAULT = 30000;

function loadForkThreshold(): number {
  if (typeof window === 'undefined') return FORK_DEFAULT;
  try {
    const raw = localStorage.getItem(FORK_STORAGE_KEY);
    if (!raw) return FORK_DEFAULT;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : FORK_DEFAULT;
  } catch {
    return FORK_DEFAULT;
  }
}

const forkThreshold = ref<number>(loadForkThreshold());

watch(forkThreshold, (next) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FORK_STORAGE_KEY, String(next));
  } catch {
    // 静默
  }
});

/* ------------------------------------------------------------------ */
/*  API Token (account tab) — 对应 Next /api/api-tokens                */
/* ------------------------------------------------------------------ */

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

const apiTokens = ref<ApiToken[]>([]);
const apiTokensLoading = ref<boolean>(false);
const apiTokensError = ref<string | null>(null);

const newTokenName = ref<string>('');
const createdToken = ref<string | null>(null);

function copyCreatedToken() {
  if (!createdToken.value) return;
  navigator.clipboard?.writeText(createdToken.value).catch(() => {
    toast.error(t('settings.common.copyFailedManual'));
  });
}
const tokenSaving = ref<boolean>(false);
const tokenMessage = ref<string | null>(null);
const tokenSearch = ref<string>('');

const selectedTokenIds = ref<Set<string>>(new Set());

async function loadApiTokens() {
  apiTokensLoading.value = true;
  apiTokensError.value = null;
  try {
    /* Bug 14: server (Next route.ts) 返回 { tokens: ApiToken[] }, 不是裸数组.
       原 `await get<ApiToken[]>` 直接赋 wrapper 对象 → filteredTokens computed
       拿到的不是数组 → line 656 .every is not a function. 解包 .tokens 跟 master
       settings/page.tsx:1347 (`data.tokens || []`) 对齐. POST / DELETE 响应
       已经是裸 token/id/deleted shape, 不动. */
    const data = await get<{ tokens: ApiToken[] }>('/api/api-tokens');
    apiTokens.value = data.tokens;
  } catch (e) {
    apiTokensError.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
  } finally {
    apiTokensLoading.value = false;
  }
}

async function handleCreateApiToken() {
  const name = newTokenName.value.trim();
  if (!name) {
    tokenMessage.value = t('settings.token.nameRequired');
    return;
  }
  tokenSaving.value = true;
  tokenMessage.value = null;
  try {
    const res = await post<{ token: string; id: string }>('/api/api-tokens', { name });
    createdToken.value = res.token;
    newTokenName.value = '';
    await loadApiTokens();
    tokenMessage.value = t('settings.token.createdMsg');
  } catch (e) {
    tokenMessage.value = isHttpError(e) ? e.message : t('settings.token.createFailed');
  } finally {
    tokenSaving.value = false;
  }
}

async function handleDeleteApiToken(id: string, name: string) {
  if (!confirm(t('settings.token.deleteConfirm', { name }))) return;
  tokenSaving.value = true;
  tokenMessage.value = null;
  try {
    await del(`/api/api-tokens/${id}`);
    await loadApiTokens();
    selectedTokenIds.value.delete(id);
    tokenMessage.value = t('settings.common.deleted');
  } catch (e) {
    tokenMessage.value = isHttpError(e) ? e.message : t('settings.common.deleteFailed');
  } finally {
    tokenSaving.value = false;
  }
}

const filteredTokens = computed<ApiToken[]>(() => {
  const q = tokenSearch.value.trim().toLowerCase();
  if (!q) return apiTokens.value;
  return apiTokens.value.filter((t) => t.name.toLowerCase().includes(q));
});

const allFilteredSelected = computed<boolean>(() => {
  if (filteredTokens.value.length === 0) return false;
  return filteredTokens.value.every((t) => selectedTokenIds.value.has(t.id));
});

function toggleSelectToken(id: string) {
  const next = new Set(selectedTokenIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTokenIds.value = next;
}

function toggleSelectAllFiltered() {
  if (allFilteredSelected.value) {
    selectedTokenIds.value = new Set();
  } else {
    selectedTokenIds.value = new Set(filteredTokens.value.map((t) => t.id));
  }
}

async function handleBatchDeleteApiTokens() {
  const targetIds = Array.from(selectedTokenIds.value).filter((id) =>
    filteredTokens.value.some((t) => t.id === id),
  );
  if (targetIds.length === 0) return;
  const includesSwitch = targetIds.some(
    (id) => filteredTokens.value.find((t) => t.id === id)?.name === 'switch-account',
  );
  const message = includesSwitch
    ? t('settings.token.batchDeleteConfirmSwitch', { n: targetIds.length })
    : t('settings.token.batchDeleteConfirm', { n: targetIds.length });
  if (!confirm(message)) return;

  tokenSaving.value = true;
  tokenMessage.value = null;
  try {
    const res = await post<{ deleted: number; requested: number }>(
      '/api/api-tokens/delete-batch',
      { ids: targetIds },
    );
    selectedTokenIds.value = new Set();
    await loadApiTokens();
    tokenMessage.value = t('settings.token.batchDeleted', { deleted: res.deleted, requested: res.requested });
  } catch (e) {
    tokenMessage.value = isHttpError(e) ? e.message : t('settings.common.deleteFailed');
  } finally {
    tokenSaving.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  多模态 API Key (mmx-cli) — account tab                            */
/*  对应 Next /api/user/media-key                                      */
/* ------------------------------------------------------------------ */

interface MediaKeyInfo {
  has_api_key: boolean;
  api_key_masked?: string;
  region?: 'cn' | 'global';
}

const mediaKey = ref<MediaKeyInfo | null>(null);
const mediaKeyInput = ref<string>('');
const showMediaKeyInput = ref<boolean>(false);
const regionInput = ref<'cn' | 'global'>('cn');
const mediaSaving = ref<boolean>(false);
const mediaTesting = ref<boolean>(false);
const mediaMessage = ref<string | null>(null);

async function loadMediaKey() {
  try {
    mediaKey.value = await get<MediaKeyInfo>('/api/user/media-key');
    if (mediaKey.value?.region) regionInput.value = mediaKey.value.region;
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
  }
}

async function handleMediaKeySave() {
  mediaSaving.value = true;
  mediaMessage.value = null;
  try {
    const body: { api_key?: string; region: 'cn' | 'global'; clear_api_key?: boolean } = {
      region: regionInput.value,
    };
    if (mediaKeyInput.value) body.api_key = mediaKeyInput.value;
    /* 后端 route 只导 GET/PUT/DELETE, 没有 POST — 用 put 而非 post (R56-B5 修复) */
    await put('/api/user/media-key', body);
    mediaMessage.value = t('settings.common.saved');
    mediaKeyInput.value = '';
    showMediaKeyInput.value = false;
    await loadMediaKey();
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : t('settings.common.saveFailed');
  } finally {
    mediaSaving.value = false;
  }
}

async function handleClearMediaKey() {
  if (!confirm(t('settings.media.clearConfirm'))) return;
  mediaSaving.value = true;
  try {
    /* 后端 route 只导 GET/PUT/DELETE, 没有 POST — 用 put (R56-B5 修复) */
    await put('/api/user/media-key', { clear_api_key: true, region: regionInput.value });
    mediaMessage.value = t('settings.media.cleared');
    await loadMediaKey();
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : t('settings.media.clearFailed');
  } finally {
    mediaSaving.value = false;
  }
}

/** 「删除全部」 — 镜像 master line 2586-2594.
   关注点: 与「清除」不同, 删除会清掉整条 user_media_keys 记录 + 清 mmx 配置目录,
   后续 agent 进程拿不到 media key. 仅在用户明确想彻底下掉时用. */
async function handleDeleteMediaKey() {
  if (!confirm(t('settings.media.deleteConfirm'))) return;
  mediaSaving.value = true;
  mediaMessage.value = null;
  try {
    await del('/api/user/media-key');
    mediaMessage.value = t('settings.media.deleted');
    await loadMediaKey();
    mediaKeyInput.value = '';
    showMediaKeyInput.value = false;
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : t('settings.common.deleteFailed');
  } finally {
    mediaSaving.value = false;
  }
}

async function handleTestMediaKey() {
  mediaTesting.value = true;
  mediaMessage.value = null;
  try {
    const res = await post<{ ok: boolean; quota?: string; error?: string }>(
      '/api/user/media-key/test',
      {},
    );
    mediaMessage.value = res.ok ? t('settings.media.testOk', { msg: res.quota ?? t('settings.media.testDefault') }) : t('settings.media.testFail', { msg: res.error ?? t('settings.media.testFailDefault') });
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : t('settings.media.testFailed');
  } finally {
    mediaTesting.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  维护模式 (admin, platform tab) — 对应 Next /api/admin/maintenance  */
/* ------------------------------------------------------------------ */

interface MaintenanceInfo {
  active: boolean;
  entered_at: string | null;
  reason: string | null;
  suspended_count: number;
  scheduler_paused: boolean;
  running_count: number;
  queue_size: number;
  /** v53: 最近一条已完成的维护记录 (active=true 时为 null, UI 不显示避免和「正在维护」混淆) */
  last_maintenance: {
    id: number;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    reason: string | null;
    paused_count: number;
    dequeued_count: number;
    failed_count: number;
    result: 'completed' | 'aborted' | 'failed' | null;
  } | null;
}

/** ISO → 「YYYY-MM-DD HH:MM」本地时区 (镜像 master settings/page.tsx:212-217) */
function formatMaintenanceTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 秒数渲染: < 60s 「Ns」; < 3600s 「Mm Ss」; 否则「Hh Mm」. */
function formatMaintenanceDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const maintenance = ref<MaintenanceInfo | null>(null);
const maintenanceLoading = ref<boolean>(false);
const maintenanceError = ref<string | null>(null);

async function loadMaintenance() {
  if (!isAdmin.value) return;
  maintenanceLoading.value = true;
  maintenanceError.value = null;
  try {
    maintenance.value = await get<MaintenanceInfo>('/api/admin/maintenance');
  } catch (e) {
    if (isHttpError(e) && e.status === 403) {
      maintenance.value = null; // 非 admin, 不渲染
    } else {
      maintenanceError.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
    }
  } finally {
    maintenanceLoading.value = false;
  }
}

async function handleEnterMaintenance() {
  const reason = prompt(t('settings.maint.reasonPrompt'));
  if (reason === null) return;
  try {
    await post('/api/admin/maintenance/enter', { reason: reason || null });
    await loadMaintenance();
    toast.success(t('settings.maint.enteredOk'));
  } catch (e) {
    toast.error(getErrorMsg(e, t('settings.maint.enterFailed')));
  }
}

async function handleExitMaintenance() {
  if (!confirm(t('settings.maint.exitConfirm'))) return;
  try {
    await post('/api/admin/maintenance/exit');
    await loadMaintenance();
    toast.success(t('settings.maint.exitedOk'));
  } catch (e) {
    toast.error(getErrorMsg(e, t('settings.maint.exitFailed')));
  }
}

/* ------------------------------------------------------------------ */
/*  账号配额 (admin, platform tab) — 对应 Next /api/admin/users       */
/*  R50.1 B309 镜像 master src/app/settings/page.tsx:1794-1979.        */
/*  后端路由已就绪:                                                      */
/*    GET  /api/admin/users                          -> { users: UserWithQuota[] } */
/*    PATCH /api/admin/users/[id]                    -> 200 {ok} | 4xx {error}    */
/*    GET  /api/admin/users/[id]/quota-log?limit=50  -> { log: QuotaLogEntry[] }    */
/* ------------------------------------------------------------------ */

interface UserWithQuota {
  id: string;
  email: string;
  role: string;
  party_a_enabled: boolean;
  quota_total_spent_cap: number | null;
  quota_granted_cap: number | null;
  quota_expire_at: string | null;
  used_total_usd: number;
}

interface QuotaLogEntry {
  id: number;
  operator_id: string;
  target_user_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  created_at: string;
}

const quotaUsers = ref<UserWithQuota[]>([]);
const quotaSaving = ref<Record<string, boolean>>({});
const quotaMessage = ref<string | null>(null);
const quotaLogOpen = ref<string | null>(null);
const quotaLogByUser = ref<Record<string, QuotaLogEntry[] | undefined>>({});

/* 分页 (AO-DEV R208) — 服务端分页, 1-indexed quotaPage + quotaPageSize 与
   Pagination 组件同语义. 后端 ?page=&pageSize= 校验非法返 400, pageSize>200
   服务端 clamp. 用户太多全量渲染页面拉太长, 改分页. */
const QUOTA_PAGE_SIZE = 20;
const quotaPage = ref<number>(1);
const quotaPageSize = ref<number>(QUOTA_PAGE_SIZE);
const quotaTotal = ref<number>(0);

async function loadQuotaUsers() {
  if (!isAdmin.value) return;
  try {
    const data = await get<{ users: UserWithQuota[]; total: number }>(
      `/api/admin/users?page=${quotaPage.value}&pageSize=${quotaPageSize.value}`,
    );
    quotaUsers.value = data.users || [];
    quotaTotal.value = typeof data.total === 'number' ? data.total : 0;
  } catch (e) {
    if (!(isHttpError(e) && e.status === 403)) {
      quotaMessage.value = getErrorMsg(e, t('settings.quotaAdmin.loadFailed'));
    }
  }
}

/* Pagination emit 收口 — 与 Assets.vue 同款: :model-value 单向, 单一入口在
   handler 里写值 + reload, 不绑 v-model (防 emit 同值被短路). pageSize 变更
   回首页防越界空页. */
function onQuotaPageChange(page: number): void {
  quotaPage.value = page;
  void loadQuotaUsers();
}

function onQuotaPageSizeChange(size: number): void {
  quotaPageSize.value = size;
  quotaPage.value = 1;
  void loadQuotaUsers();
}

async function fetchQuotaLog(userId: string) {
  try {
    const data = await get<{ log: QuotaLogEntry[] }>(
      `/api/admin/users/${userId}/quota-log?limit=50`,
    );
    quotaLogByUser.value = {
      ...quotaLogByUser.value,
      [userId]: data.log || [],
    };
  } catch (e) {
    quotaMessage.value = t('settings.quotaAdmin.logFailed', { msg: getErrorMsg(e, '') });
  }
}

async function saveQuota(
  userId: string,
  body: {
    party_a_enabled?: boolean;
    quota_total_spent_cap?: number | null;
    quota_granted_cap?: number | null;
    quota_expire_at?: string | null;
  },
) {
  quotaSaving.value = { ...quotaSaving.value, [userId]: true };
  quotaMessage.value = null;
  try {
    await patch(`/api/admin/users/${userId}`, body);
    quotaMessage.value = t('settings.quotaAdmin.updatedOk', { id: userId.slice(0, 8) });
    await loadQuotaUsers();
  } catch (e) {
    quotaMessage.value = `❌ ${getErrorMsg(e, t('settings.common.saveFailed'))}`;
  } finally {
    quotaSaving.value = { ...quotaSaving.value, [userId]: false };
  }
}

function toggleQuotaLog(userId: string) {
  if (quotaLogOpen.value === userId) {
    quotaLogOpen.value = null;
    return;
  }
  quotaLogOpen.value = userId;
  if (quotaLogByUser.value[userId] === undefined) {
    void fetchQuotaLog(userId);
  }
}

function onCapBlur(user: UserWithQuota, raw: string) {
  const trimmed = raw.trim();
  const next: number | null = trimmed === '' ? null : Number(trimmed);
  if (trimmed !== '' && (!Number.isFinite(next) || (next as number) < 0)) return;
  if (next === user.quota_total_spent_cap) return;
  void saveQuota(user.id, { quota_total_spent_cap: next });
}

function onGrantedCapBlur(user: UserWithQuota, raw: string) {
  const trimmed = raw.trim();
  const next: number | null = trimmed === '' ? null : Number(trimmed);
  if (trimmed !== '' && (!Number.isFinite(next) || (next as number) < 0)) return;
  if (next === user.quota_granted_cap) return;
  void saveQuota(user.id, { quota_granted_cap: next });
}

function onExpireAtBlur(user: UserWithQuota, raw: string) {
  const trimmed = raw.trim();
  const next: string | null = trimmed === '' ? null : trimmed;
  if (next !== null && !Number.isFinite(Date.parse(next))) {
    quotaMessage.value = t('settings.quotaAdmin.invalidDate', { date: next });
    return;
  }
  if (next === user.quota_expire_at) return;
  void saveQuota(user.id, { quota_expire_at: next });
}

function quotaPct(u: UserWithQuota): number {
  const cap = u.quota_total_spent_cap;
  if (cap === null || cap === undefined || cap <= 0) return 0;
  const used = u.used_total_usd || 0;
  return Math.min(100, (used / cap) * 100);
}

function quotaPctClass(u: UserWithQuota): string {
  const cap = u.quota_total_spent_cap;
  const used = u.used_total_usd || 0;
  if (cap === null || cap === undefined || cap <= 0) return 'muted';
  if (used >= cap) return 'fail';
  if (quotaPct(u) >= 80) return 'warn';
  return 'info';
}

/* ------------------------------------------------------------------ */
/*  个人 LLM 配置 (account tab) — 对应 Next /api/user/llm-config       */
/*  R50.3 B301 镜像 master src/app/settings/page.tsx:2314-2500.        */
/*  后端路由已就绪 (5 端点):                                              */
/*    GET    /api/user/llm-config                       -> { configs: LlmConfigSafe[] } */
/*    POST   /api/user/llm-config                       -> LlmConfigSafe                  */
/*    PUT    /api/user/llm-config/[id]                  -> LlmConfigSafe                  */
/*    DELETE /api/user/llm-config/[id]                  -> { ok }                         */
/*    POST   /api/user/llm-config/[id]/duplicate        -> LlmConfigSafe                  */
/*    POST   /api/user/llm-config/[id]/default          -> LlmConfigSafe                  */
/*    GET    /api/user/llm-config/available             -> { configs: AvailableLlmConfig[] } */
/* ------------------------------------------------------------------ */

interface LlmConfigSafe {
  id: string;
  owner_type: 'user' | 'project' | 'admin';
  owner_id: string;
  name: string;
  type: string;
  api_key_masked: string | null;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
  fallback_ids: string[];
  supports_vision: boolean | null;
  /** R239: per-model 单价 USD/百万token (null=未配, 配了任一档任务成本走 priced 口径) */
  price_in: number | null;
  price_out: number | null;
  price_cache_read: number | null;
  /** R239: 相对全局基准模型的成本系数 (基准未设/没配价 → null) */
  coefficient: number | null;
}

interface AvailableLlmConfig {
  id: string;
  source: 'self' | 'admin_grant';
  name: string;
  type: string;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
  fallback_ids: string[];
  supports_vision: boolean | null;
}

const llmConfigs = ref<LlmConfigSafe[]>([]);
const availableLlmConfigs = ref<AvailableLlmConfig[]>([]);
/** R239: 成本系数基准配置 id (全局单值, 与平台 tab 的 costBaselineId 同源) */
const userCostBaselineId = ref<string | null>(null);
const editingLlmId = ref<string | 'new' | null>(null);
interface LlmDraft {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  clear_api_key: boolean;
  /** R175: 有序 fallback 链 (config id, 点选顺序即链顺序) */
  fallback_ids: string[];
  /** R175: 视觉能力三态 — null=未设置(按模型名推断) */
  supports_vision: boolean | null;
  /** R239: 单价 USD/百万token, 输入框用 string 承接 (空串=清除该档) */
  price_in: string;
  price_out: string;
  price_cache_read: string;
}
const llmDraft = reactive<LlmDraft>({
  name: '', base_url: '', model: '', api_key: '', clear_api_key: false,
  fallback_ids: [], supports_vision: null,
  price_in: '', price_out: '', price_cache_read: '',
});
/** R239: 输入框字符串 → 单价 number|null (空/非法/≤0 = null 清除) */
function parsePriceInput(s: string): number | null {
  const v = Number(s.trim());
  return s.trim() !== '' && Number.isFinite(v) && v > 0 ? v : null;
}
function fillPriceInput(v: number | null | undefined): string {
  return v != null ? String(v) : '';
}
const MAX_FALLBACK_ENTRIES = 5;
/** R175: 视觉能力三态下拉选项 (Select 组件 value 是 string); label 走 t() 随语言切换 */
const visionSelectOptions = computed(() => [
  { value: 'unset', label: t('settings.llm.visionUnset') },
  { value: 'yes', label: t('settings.llm.visionYes') },
  { value: 'no', label: t('settings.llm.visionNo') },
]);
const llmVisionSelect = computed<string | null>({
  get: () => (llmDraft.supports_vision === true ? 'yes' : llmDraft.supports_vision === false ? 'no' : 'unset'),
  set: (v) => {
    llmDraft.supports_vision = v === 'yes' ? true : v === 'no' ? false : null;
  },
});

/** R175: fallback 链可选项 = 除自己外的其它配置; 点选加入/移除, 顺序=点击顺序 */
function otherLlmConfigs(excludeId: string | 'new'): LlmConfigSafe[] {
  return llmConfigs.value.filter((c) => c.id !== excludeId);
}
function toggleLlmFallback(id: string): void {
  const i = llmDraft.fallback_ids.indexOf(id);
  if (i >= 0) llmDraft.fallback_ids.splice(i, 1);
  else if (llmDraft.fallback_ids.length < MAX_FALLBACK_ENTRIES) llmDraft.fallback_ids.push(id);
}
function llmCfgName(id: string): string {
  return llmConfigs.value.find((c) => c.id === id)?.name || id.slice(0, 8) + '…';
}
function visionBadge(v: boolean | null): string {
  if (v === true) return '👁';
  if (v === false) return '🚫👁';
  return '';
}
/** R239: 系数列文案 — 基准模型显「基准」，没配价/没设基准显「—」 */
function coefficientLabel(cfg: { id: string; coefficient: number | null }, baselineId: string | null): string {
  if (baselineId && cfg.id === baselineId) return t('settings.llm.baselineCoef');
  return cfg.coefficient != null ? `×${cfg.coefficient.toFixed(2)}` : '—';
}
const llmSaving = ref<boolean>(false);
const llmMessage = ref<string | null>(null);

async function loadLlmConfigs() {
  try {
    const [me, avail] = await Promise.all([
      get<{ configs: LlmConfigSafe[]; baseline_id: string | null }>('/api/user/llm-config'),
      get<{ configs: AvailableLlmConfig[] }>('/api/user/llm-config/available'),
    ]);
    llmConfigs.value = me.configs || [];
    userCostBaselineId.value = me.baseline_id ?? null;
    availableLlmConfigs.value = avail.configs || [];
  } catch (e) {
    // 用户没配过 / 后端 401 都静默 (老账号路径) —— 不阻断设置页其它卡片
    if (isHttpError(e) && (e.status === 401 || e.status === 404)) return;
    llmMessage.value = getErrorMsg(e, t('settings.llm.loadFailed'));
  }
}

function startEditLlm(cfg: LlmConfigSafe | 'new') {
  if (cfg === 'new') {
    editingLlmId.value = 'new';
    llmDraft.name = '';
    llmDraft.base_url = '';
    llmDraft.model = '';
    llmProviderId.value = '';
    llmDraft.api_key = '';
    llmDraft.clear_api_key = false;
    llmDraft.fallback_ids = [];
    llmDraft.supports_vision = null;
    llmDraft.price_in = '';
    llmDraft.price_out = '';
    llmDraft.price_cache_read = '';
  } else {
    editingLlmId.value = cfg.id;
    llmDraft.name = cfg.name;
    llmDraft.base_url = cfg.base_url || '';
    llmDraft.model = cfg.model || '';
    llmProviderId.value = matchProviderByUrl(cfg.base_url)?.id ?? '';
    llmDraft.api_key = '';
    llmDraft.clear_api_key = false;
    llmDraft.fallback_ids = [...(cfg.fallback_ids || [])];
    llmDraft.supports_vision = cfg.supports_vision ?? null;
    llmDraft.price_in = fillPriceInput(cfg.price_in);
    llmDraft.price_out = fillPriceInput(cfg.price_out);
    llmDraft.price_cache_read = fillPriceInput(cfg.price_cache_read);
  }
  llmMessage.value = null;
}

function cancelEditLlm() {
  editingLlmId.value = null;
  llmMessage.value = null;
}

async function handleLlmSave() {
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    const body: Record<string, unknown> = {
      name: llmDraft.name.trim(),
      base_url: llmDraft.base_url || null,
      model: llmDraft.model || null,
      fallback_ids: llmDraft.fallback_ids,
      supports_vision: llmDraft.supports_vision,
      price_in: parsePriceInput(llmDraft.price_in),
      price_out: parsePriceInput(llmDraft.price_out),
      price_cache_read: parsePriceInput(llmDraft.price_cache_read),
    };
    if (llmDraft.clear_api_key) {
      body.clear_api_key = true;
    } else if (llmDraft.api_key.trim()) {
      body.api_key = llmDraft.api_key.trim();
    }
    if (editingLlmId.value === 'new') {
      await post('/api/user/llm-config', body);
    } else if (editingLlmId.value) {
      await put(`/api/user/llm-config/${editingLlmId.value}`, body);
    } else {
      llmMessage.value = t('settings.llm.noneEditing');
      llmSaving.value = false;
      return;
    }
    llmMessage.value = t('settings.common.saved');
    cancelEditLlm();
    await loadLlmConfigs();
  } catch (e) {
    llmMessage.value = isHttpError(e) ? e.message : t('settings.common.saveFailed');
  } finally {
    llmSaving.value = false;
  }
}

async function handleDuplicateLlmConfig(id: string, name: string) {
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    const data = await post<{ name?: string }>(`/api/user/llm-config/${id}/duplicate`, {});
    llmMessage.value = t('settings.llm.dupOk', { name: data.name ?? t('settings.llm.copySuffix', { name }) });
    await loadLlmConfigs();
  } catch (e) {
    llmMessage.value = isHttpError(e) ? e.message : t('settings.llm.dupFailed');
  } finally {
    llmSaving.value = false;
  }
}

async function handleCopyLlmConfigText(cfg: LlmConfigSafe) {
  const lines = [
    t('settings.llm.lineName', { name: cfg.name }),
    t('settings.llm.lineBaseUrl', { value: cfg.base_url || t('settings.llm.valueDefault') }),
    t('settings.llm.lineModel', { value: cfg.model || t('settings.llm.valueDefault') }),
    t('settings.llm.lineKey', { value: cfg.has_api_key ? cfg.api_key_masked : t('settings.llm.valueNotSet') }),
    t('settings.llm.lineType', { type: cfg.type }),
    t('settings.llm.linePrice', { pin: cfg.price_in ?? '—', pout: cfg.price_out ?? '—', pcache: cfg.price_cache_read ?? '—' }),
    cfg.is_default ? t('settings.llm.statusDefault') : t('settings.llm.statusNormal'),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    llmMessage.value = t('settings.llm.copiedMsg', { name: cfg.name });
  } catch (err) {
    llmMessage.value = t('settings.llm.copyFailedMsg', { msg: (err as Error).message });
  }
}

async function handleSetLlmDefault(id: string) {
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    await post(`/api/user/llm-config/${id}/default`, {});
    llmMessage.value = t('settings.llm.setDefaultOk');
    await loadLlmConfigs();
  } catch (e) {
    llmMessage.value = isHttpError(e) ? e.message : t('settings.common.saveFailed');
  } finally {
    llmSaving.value = false;
  }
}

function handleDeleteLlmConfig(id: string, name: string) {
  if (!confirm(t('settings.llm.deleteConfirm', { name }))) return;
  void (async () => {
    llmSaving.value = true;
    llmMessage.value = null;
    try {
      await del(`/api/user/llm-config/${id}`);
      llmMessage.value = t('settings.common.deleted');
      await loadLlmConfigs();
    } catch (e) {
      llmMessage.value = isHttpError(e) ? e.message : t('settings.common.deleteFailed');
    } finally {
      llmSaving.value = false;
    }
  })();
}

onMounted(async () => {
  await Promise.all([
    loadConfig(),
    loadProfile(),
    loadApiTokens(),
    loadMediaKey(),
    loadMaintenance(),
    loadQuotaUsers(),
    loadLlmConfigs(),
  ]);
  /* R55.8 (B307) + R55.9 (B308): 平台 LLM admin + 用户授权只在 platform
     tab 渲染, 但 isAdmin 不等到用户切过去才校验, mount 时一起拉, 等用户
     点 platform tab 即可时拿到. 非 admin 用户走 403 静默吞 (loadAdminLlm / loadGrants
     内部 isHttpError 处理); 后端不会回 admin-only 字段. */
  if (isAdmin.value) {
    void loadAdminLlm();
    void loadGrants();
  }
});

/* ------------------------------------------------------------------ */
/*  派生: tab 是否可见                                                  */
/* ------------------------------------------------------------------ */

const showPlatformTab = computed<boolean>(() => isAdmin.value);

/* ------------------------------------------------------------------ */
/*  平台 LLM admin (R55.8 / B307) — admin only                         */
/*    镜像 master src/app/settings/page.tsx:1548-1697:                  */
/*      GET  /api/admin/llm-config        列表                          */
/*      POST /api/admin/llm-config        新建                          */
/*      PUT  /api/admin/llm-config/[id]   编辑                          */
/*      POST /api/admin/llm-config/[id]/default   设为默认                */
/*      POST /api/admin/llm-config/[id]/duplicate 拷贝                   */
/*      DELETE /api/admin/llm-config/[id]  删除                          */
/* ------------------------------------------------------------------ */

interface AdminLlmConfig {
  id: string;
  name: string;
  type: string;
  api_key_masked: string | null;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
  fallback_ids: string[];
  supports_vision: boolean | null;
  /** R239: per-model 单价 USD/百万token (null=未配) */
  price_in: number | null;
  price_out: number | null;
  price_cache_read: number | null;
  /** R239: 相对基准模型的成本系数 (本行就是基准 → null 但由前端标「基准 ×1」) */
  coefficient: number | null;
}

interface AdminLlmDraft {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  clear_api_key: boolean;
  fallback_ids: string[];
  supports_vision: boolean | null;
  /** R239: 单价 USD/百万token, 输入框 string 承接 (空串=清除) */
  price_in: string;
  price_out: string;
  price_cache_read: string;
}

const adminLlmConfigs = ref<AdminLlmConfig[]>([]);
const adminLlmLoading = ref<boolean>(false);
const adminLlmSaving = ref<boolean>(false);
const adminLlmMessage = ref<string | null>(null);
const editingAdminLlmId = ref<string | 'new' | null>(null);
const adminLlmDraft = reactive<AdminLlmDraft>({
  name: '', base_url: '', model: '', api_key: '', clear_api_key: false,
  fallback_ids: [], supports_vision: null,
  price_in: '', price_out: '', price_cache_read: '',
});

const llmProviderId = ref<string>('');
const adminLlmProviderId = ref<string>('');

const llmModelSuggestions = computed<string[]>(() =>
  modelSuggestions(llmProviderId.value, llmDraft.model),
);
const adminLlmModelSuggestions = computed<string[]>(() =>
  modelSuggestions(adminLlmProviderId.value, adminLlmDraft.model),
);

const llmSelectedProvider = computed(() => findProviderById(llmProviderId.value));
const adminLlmSelectedProvider = computed(() => findProviderById(adminLlmProviderId.value));

// base_url 手动改动 → 反查厂商 (粘贴中转 url 自动匹配; applyProvider 填入时命中同一家, 无循环)
watch(
  () => llmDraft.base_url,
  (url) => {
    llmProviderId.value = matchProviderByUrl(url)?.id ?? '';
  },
);
watch(
  () => adminLlmDraft.base_url,
  (url) => {
    adminLlmProviderId.value = matchProviderByUrl(url)?.id ?? '';
  },
);

/** R239: 成本系数基准配置 id (null=未设, 全部系数显「—」) */
const costBaselineId = ref<string | null>(null);

/** R239: 设/清成本基准配置 (config_id=null 清除) */
async function handleSetBaseline(id: string | null): Promise<void> {
  adminLlmSaving.value = true;
  try {
    await post('/api/admin/llm-config/baseline', { config_id: id });
    toast.success(id ? t('settings.adminLlm.setBaselineOk') : t('settings.adminLlm.clearBaselineOk'));
    await loadAdminLlm();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, t('settings.adminLlm.setBaselineFailed')));
  } finally {
    adminLlmSaving.value = false;
  }
}

/** R175: admin tab 的 fallback 链/视觉 (与 user tab 同款交互, 数据源换 adminLlmConfigs) */
function toggleAdminLlmFallback(id: string): void {
  const i = adminLlmDraft.fallback_ids.indexOf(id);
  if (i >= 0) adminLlmDraft.fallback_ids.splice(i, 1);
  else if (adminLlmDraft.fallback_ids.length < MAX_FALLBACK_ENTRIES) adminLlmDraft.fallback_ids.push(id);
}
function adminLlmCfgName(id: string): string {
  return adminLlmConfigs.value.find((c) => c.id === id)?.name || id.slice(0, 8) + '…';
}
const adminVisionSelect = computed<string | null>({
  get: () => (adminLlmDraft.supports_vision === true ? 'yes' : adminLlmDraft.supports_vision === false ? 'no' : 'unset'),
  set: (v) => {
    adminLlmDraft.supports_vision = v === 'yes' ? true : v === 'no' ? false : null;
  },
});

async function loadAdminLlm(): Promise<void> {
  adminLlmLoading.value = true;
  adminLlmMessage.value = null;
  try {
    const { configs, baseline_id } = await get<{ configs: AdminLlmConfig[]; baseline_id: string | null }>('/api/admin/llm-config');
    adminLlmConfigs.value = Array.isArray(configs) ? configs : [];
    costBaselineId.value = baseline_id ?? null;
  } catch (e: unknown) {
    adminLlmMessage.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
  } finally {
    adminLlmLoading.value = false;
  }
}

function startEditAdminLlm(cfg: AdminLlmConfig | 'new'): void {
  if (cfg === 'new') {
    editingAdminLlmId.value = 'new';
    adminLlmDraft.name = '';
    adminLlmDraft.base_url = '';
    adminLlmDraft.model = '';
    adminLlmProviderId.value = '';
    adminLlmDraft.api_key = '';
    adminLlmDraft.clear_api_key = false;
    adminLlmDraft.fallback_ids = [];
    adminLlmDraft.supports_vision = null;
    adminLlmDraft.price_in = '';
    adminLlmDraft.price_out = '';
    adminLlmDraft.price_cache_read = '';
  } else {
    editingAdminLlmId.value = cfg.id;
    adminLlmDraft.name = cfg.name;
    adminLlmDraft.base_url = cfg.base_url || '';
    adminLlmDraft.model = cfg.model || '';
    adminLlmProviderId.value = matchProviderByUrl(cfg.base_url)?.id ?? '';
    adminLlmDraft.api_key = '';
    adminLlmDraft.clear_api_key = false;
    adminLlmDraft.fallback_ids = [...(cfg.fallback_ids || [])];
    adminLlmDraft.supports_vision = cfg.supports_vision ?? null;
    adminLlmDraft.price_in = fillPriceInput(cfg.price_in);
    adminLlmDraft.price_out = fillPriceInput(cfg.price_out);
    adminLlmDraft.price_cache_read = fillPriceInput(cfg.price_cache_read);
  }
  adminLlmMessage.value = null;
}

function cancelEditAdminLlm(): void {
  editingAdminLlmId.value = null;
  adminLlmMessage.value = null;
}

async function saveAdminLlm(): Promise<void> {
  adminLlmSaving.value = true;
  adminLlmMessage.value = null;
  try {
    const body: Record<string, unknown> = {
      name: adminLlmDraft.name.trim(),
      base_url: adminLlmDraft.base_url || null,
      model: adminLlmDraft.model || null,
      fallback_ids: adminLlmDraft.fallback_ids,
      supports_vision: adminLlmDraft.supports_vision,
      price_in: parsePriceInput(adminLlmDraft.price_in),
      price_out: parsePriceInput(adminLlmDraft.price_out),
      price_cache_read: parsePriceInput(adminLlmDraft.price_cache_read),
    };
    if (adminLlmDraft.clear_api_key) body.clear_api_key = true;
    else if (adminLlmDraft.api_key.trim()) body.api_key = adminLlmDraft.api_key.trim();
    if (editingAdminLlmId.value === 'new') {
      await post('/api/admin/llm-config', body);
    } else if (editingAdminLlmId.value) {
      await put(`/api/admin/llm-config/${editingAdminLlmId.value}`, body);
    } else {
      return;
    }
    adminLlmMessage.value = t('settings.common.saved');
    editingAdminLlmId.value = null;
    await loadAdminLlm();
  } catch (e: unknown) {
    adminLlmMessage.value = getErrorMsg(e, t('settings.common.saveFailed'));
  } finally {
    adminLlmSaving.value = false;
  }
}

async function handleAdminLlmDefault(id: string): Promise<void> {
  adminLlmSaving.value = true;
  try {
    await post(`/api/admin/llm-config/${id}/default`);
    await loadAdminLlm();
  } catch (e: unknown) {
    adminLlmMessage.value = getErrorMsg(e, t('settings.adminLlm.setDefaultFailed'));
  } finally {
    adminLlmSaving.value = false;
  }
}

async function handleAdminLlmDuplicate(id: string, name: string): Promise<void> {
  adminLlmSaving.value = true;
  try {
    await post(`/api/admin/llm-config/${id}/duplicate`);
    toast.success(t('settings.adminLlm.dupOk', { name }));
    await loadAdminLlm();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, t('settings.llm.dupFailed')));
  } finally {
    adminLlmSaving.value = false;
  }
}

async function handleAdminLlmCopyText(cfg: AdminLlmConfig): Promise<void> {
  const text = JSON.stringify({
    name: cfg.name,
    base_url: cfg.base_url || null,
    model: cfg.model || null,
    api_key_masked: cfg.api_key_masked,
    price_in: cfg.price_in,
    price_out: cfg.price_out,
    price_cache_read: cfg.price_cache_read,
    coefficient: cfg.coefficient,
  }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t('settings.common.copiedOk'));
  } catch {
    toast.error(t('settings.common.copyFailedManual'));
  }
}

async function handleAdminLlmDelete(id: string, name: string): Promise<void> {
  if (!confirm(t('settings.adminLlm.deleteConfirm', { name }))) return;
  adminLlmSaving.value = true;
  try {
    await del(`/api/admin/llm-config/${id}`);
    toast.success(t('settings.adminLlm.deletedOk', { name }));
    await loadAdminLlm();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, t('settings.common.deleteFailed')));
  } finally {
    adminLlmSaving.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  用户授权 grants (R55.9 / B308) — admin only                       */
/*    镜像 master src/app/settings/page.tsx:1701-1790 + llm-grants     */
/*    GET  /api/admin/llm-grants  -> { users: UserGrant[] }            */
/*    PUT  /api/admin/llm-grants  body { user_id, enabled?, max_concurrency? } */
/* ------------------------------------------------------------------ */

interface UserGrant {
  id: string;
  email: string;
  role: 'admin' | 'user';
  granted: boolean;
  max_concurrency: number | null;
}

const grants = ref<UserGrant[]>([]);
const grantsLoading = ref<boolean>(false);
const grantsMessage = ref<string | null>(null);
const grantsSaving = ref<boolean>(false);
const concurrencyStatus = reactive<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({});

/** 客户端分页 (GRANTS_PAGE_SIZE 一行 10) — 避免用户表大时一屏塞爆. */
const GRANTS_PAGE_SIZE = 10;
const grantsPage = ref<number>(0);
const totalGrantPages = computed<number>(() =>
  Math.max(1, Math.ceil(grants.value.length / GRANTS_PAGE_SIZE)),
);
const safeGrantsPage = computed<number>(() =>
  Math.min(grantsPage.value, totalGrantPages.value - 1),
);
const pagedGrants = computed<UserGrant[]>(() =>
  grants.value.slice(
    safeGrantsPage.value * GRANTS_PAGE_SIZE,
    (safeGrantsPage.value + 1) * GRANTS_PAGE_SIZE,
  ),
);

async function loadGrants(): Promise<void> {
  grantsLoading.value = true;
  grantsMessage.value = null;
  try {
    const { users } = await get<{ users: UserGrant[] }>('/api/admin/llm-grants');
    grants.value = Array.isArray(users) ? users : [];
  } catch (e: unknown) {
    grantsMessage.value = isHttpError(e) ? e.message : t('settings.common.loadFailed');
  } finally {
    grantsLoading.value = false;
  }
}

async function handleGrantToggle(userId: string, enabled: boolean): Promise<void> {
  grantsSaving.value = true;
  try {
    await put('/api/admin/llm-grants', { user_id: userId, enabled });
    await loadGrants();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, t('settings.grants.toggleFailed')));
  } finally {
    grantsSaving.value = false;
  }
}

async function saveConcurrency(userId: string, raw: string): Promise<void> {
  const trimmed = raw.trim();
  let val: number | null;
  if (trimmed === '') val = null;
  else {
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      concurrencyStatus[userId] = 'error';
      toast.error(t('settings.grants.concurrencyInvalid'));
      return;
    }
    val = n;
  }
  concurrencyStatus[userId] = 'saving';
  try {
    await put('/api/admin/llm-grants', { user_id: userId, max_concurrency: val });
    concurrencyStatus[userId] = 'saved';
    await loadGrants();
    window.setTimeout(() => {
      if (concurrencyStatus[userId] === 'saved') concurrencyStatus[userId] = 'idle';
    }, 1500);
  } catch (e: unknown) {
    concurrencyStatus[userId] = 'error';
    toast.error(getErrorMsg(e, t('settings.common.saveFailed')));
  }
}
</script>

<template>
  <div class="settings-page">
    <h1 class="page-title">{{ t('settings.title') }}</h1>
    <p class="muted small page-subtitle">
      {{ t('settings.subtitle') }}
    </p>

    <!-- Tab 导航 -->
    <div class="tabs">
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'account' }"
        @click="activeTab = 'account'"
      >{{ t('settings.tabs.account') }}</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'notify' }"
        @click="activeTab = 'notify'"
      >{{ t('settings.tabs.notify') }}</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'schedule' }"
        @click="activeTab = 'schedule'"
      >{{ t('settings.tabs.schedule') }}</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'roles' }"
        @click="activeTab = 'roles'"
      >{{ t('settings.tabs.roles') }}</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'channels' }"
        @click="activeTab = 'channels'"
      >{{ t('settings.tabs.channels') }}</button>
      <button
        v-if="showPlatformTab"
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'platform' }"
        @click="activeTab = 'platform'"
      >{{ t('settings.tabs.platform') }}</button>
    </div>

    <!-- R56-B5: admin 跳转 banner (admin only, 不在 platform tab 时显示).
         真凶: admin LLM 配置藏在 platform tab 里, 默认 activeTab=account 容易
         被忽略; "+ 新增配置" 按钮又在 admin-llm-form-head 右上角, 视觉权重低.
         加这个 banner 让 admin 立刻知道"平台管理"在哪, 一键跳转. -->
    <div
      v-if="isAdmin && activeTab !== 'platform'"
      class="admin-shortcut-banner"
      role="button"
      tabindex="0"
      @click="activeTab = 'platform'"
      @keyup.enter="activeTab = 'platform'"
    >
      <span class="banner-icon">🚀</span>
      <span class="banner-text">
        {{ t('settings.banner.pre') }}
        <strong>「{{ t('settings.tabs.platform') }}」</strong> {{ t('settings.banner.post') }}
      </span>
      <span class="banner-cta">→</span>
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 账户 (account)                                              -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'account'" class="tab-panel">
      <!-- 语言 / Language (W2a) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.lang.title') }}</h2>
        </div>

        <div class="form-block">
          <div class="form-row">
            <label class="form-label">{{ t('settings.lang.label') }}</label>
            <Select
              :model-value="currentLang"
              :options="langOptions"
              @update:model-value="onLangChange"
            />
            <span class="form-aside">{{ t('settings.lang.desc') }}</span>
          </div>
        </div>
      </section>

      <!-- 身份 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.identity.title') }}</h2>
        </div>

        <Loading v-if="profileLoading && !profile" :label="t('settings.identity.loading')" />
        <ErrorView
          v-else-if="profileError"
          variant="error"
          :title="t('settings.identity.loadFailed')"
          :description="profileError"
          :retrying="profileRetrying"
          @retry="loadProfile(true)"
        />
        <Empty v-else-if="!profile" variant="doc" :title="t('settings.identity.empty')" />

        <div v-else class="kv-block">
          <div class="kv-row">
            <span class="kv-key">{{ t('settings.identity.email') }}</span>
            <span class="kv-val mono">{{ profile.email }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">{{ t('settings.identity.role') }}</span>
            <span class="kv-val">
              <span
                class="role-chip"
                :class="profile.role === 'admin' ? 'admin' : 'user'"
              >{{ profile.role }}</span>
              <span v-if="profile.admin_llm_granted" class="badge badge-info small">
                {{ t('settings.identity.grantedBadge') }}
              </span>
            </span>
          </div>
        </div>
      </section>

      <!-- 用户身份: 昵称 + 自我介绍 (v518, 飞书 R222) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.userProfile.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.userProfile.badge') }}</span>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-nickname" class="form-label">
              {{ t('settings.userProfile.nickname') }}
              <span class="form-hint">{{ t('settings.userProfile.nicknameHint') }}</span>
            </label>
            <Input
              id="user-nickname"
              v-model="profileForm.nickname"
              :disabled="profileSaving"
              :placeholder="t('settings.userProfile.nicknamePlaceholder')"
              class-name="form-input-md"
            />
          </div>
          <div class="form-row">
            <label for="user-bio" class="form-label">
              {{ t('settings.userProfile.bio') }}
              <span class="form-hint">{{ t('settings.userProfile.bioHint') }}</span>
            </label>
            <Textarea
              id="user-bio"
              v-model="profileForm.bio"
              :disabled="profileSaving"
              :rows="3"
              :maxlength="2000"
              show-count
              :placeholder="t('settings.userProfile.bioPlaceholder')"
            />
          </div>

          <p class="muted small form-aside">
            {{ t('settings.userProfile.aside') }}
          </p>
          <div class="form-actions">
            <Button variant="primary" :loading="profileSaving" @click="saveUserProfile">
              {{ t('settings.userProfile.save') }}
            </Button>
          </div>
        </div>
      </section>

      <!-- Preflight -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.preflight.title') }}</h2>
        </div>

        <div v-if="profile" class="form-block">
          <Checkbox
            :model-value="profileForm.preflight_enabled"
            :disabled="preflightSaving"
            :label="t('settings.preflight.label')"
            @update:model-value="savePreflight"
          />
          <p class="muted small form-aside">
            {{ t('settings.preflight.aside') }}
          </p>
        </div>
      </section>

      <!-- Git 提交身份 (v515, 飞书 R178) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.git.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.git.badge') }}</span>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-git-name" class="form-label">
              {{ t('settings.git.nameLabel') }}
              <span class="form-hint">{{ t('settings.git.nameHint') }}</span>
            </label>
            <Input
              id="user-git-name"
              v-model="profileForm.git_name"
              :disabled="gitSaving"
              :placeholder="t('settings.git.namePlaceholder')"
              class-name="form-input-md"
            />
          </div>
          <div class="form-row">
            <label for="user-git-email" class="form-label">
              {{ t('settings.git.emailLabel') }}
              <span class="form-hint">{{ t('settings.git.emailHint') }}</span>
            </label>
            <Input
              id="user-git-email"
              v-model="profileForm.git_email"
              type="email"
              :disabled="gitSaving"
              placeholder="user@example.com"
              class-name="form-input-md"
            />
            <span class="form-aside">
              <span
                class="status-dot"
                :class="profile.git_email || profile.git_name ? 'ok' : 'warn'"
              />
              {{
                profile.git_email || profile.git_name
                  ? t('settings.git.customized', {
                    name: profile.git_name || (profile.git_email || profile.email).split('@')[0],
                    email: profile.git_email || profile.email,
                  })
                  : t('settings.git.defaultLabel', { name: profile.email.split('@')[0], email: profile.email })
              }}
            </span>
          </div>

          <p class="muted small form-aside">
            {{ t('settings.git.aside') }}
          </p>
          <div class="form-actions">
            <Button variant="primary" :loading="gitSaving" @click="saveGitIdentity">
              {{ t('settings.git.save') }}
            </Button>
          </div>
        </div>
      </section>

      <!-- 提示音设置 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.sound.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.sound.badge') }}</span>
        </div>

        <div class="form-block">
          <div class="kv-row">
            <span class="kv-key">{{ t('settings.sound.master') }}</span>
            <span class="kv-val">
              <Checkbox
                :model-value="soundSettings.enabled"
                :label="t('settings.sound.enable')"
                @update:model-value="(v: boolean) => { soundSettings.enabled = v; }"
              />
            </span>
          </div>

          <div v-if="soundSettings.enabled" class="event-list">
            <div
              v-for="opt in SOUND_EVENT_OPTIONS"
              :key="opt.key"
              class="event-row"
            >
              <div class="event-meta">
                <div class="event-label">{{ t(opt.labelKey) }}</div>
                <div class="event-desc muted small">{{ t(opt.descKey) }}</div>
              </div>
              <Checkbox
                :model-value="soundSettings.events[opt.key]"
                @update:model-value="(v: boolean) => { soundSettings.events[opt.key] = v; }"
              />
            </div>
          </div>

          <div class="form-actions">
            <Button
              variant="ghost"

              :disabled="!soundSettings.enabled"
              @click="playNotifySound"
            >{{ t('settings.sound.test') }}</Button>
          </div>
        </div>
      </section>

      <!-- Fork 自动压缩阈值 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.fork.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.fork.badge') }}</span>
        </div>

        <div class="form-block">
          <div class="form-row">
            <label class="form-label">
              {{ t('settings.fork.threshold') }}
            </label>
            <Input
              :model-value="String(forkThreshold)"
              type="number"
              :min="0"
              :step="1000"
              class-name="form-input-sm"
              placeholder="30000"
              @update:model-value="(v: string) => { const n = parseInt(v, 10); forkThreshold = Number.isFinite(n) && n >= 0 ? n : FORK_DEFAULT; }"
            />
            <span class="form-aside">
              {{ t('settings.fork.aside') }}
              {{ t('settings.fork.current', { cur: (forkThreshold / 1000).toFixed(0), def: FORK_DEFAULT / 1000 }) }}
            </span>
          </div>
        </div>
      </section>

      <!-- 多模态 API Key (mmx-cli) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.media.title') }}</h2>
        </div>

        <div class="form-block">
          <p class="muted small">
            {{ t('settings.media.desc') }}
          </p>

          <div
            v-if="mediaKey?.has_api_key && mediaKey.api_key_masked?.includes('解密失败')"
            class="warn-box small"
          >
            {{ t('settings.media.decryptFail') }}
          </div>

          <div class="form-row">
            <label class="form-label">{{ t('settings.media.keyLabel') }}</label>
            <div v-if="mediaKey?.has_api_key && !showMediaKeyInput" class="kv-row">
              <code class="mono small flex-1">{{ mediaKey.api_key_masked }}</code>
              <Button
                variant="ghost"

                @click="showMediaKeyInput = true"
              >{{ t('settings.media.change') }}</Button>
              <Button
                variant="danger"

                :disabled="mediaSaving"
                @click="handleClearMediaKey"
              >{{ t('settings.media.clear') }}</Button>
            </div>
            <div v-else class="kv-row">
              <Input
                v-model="mediaKeyInput"
                type="password"
                class-name="form-input-md"
                :placeholder="t('settings.media.keyPlaceholder')"
              />
              <Button
                v-if="mediaKey?.has_api_key"
                variant="ghost"

                @click="showMediaKeyInput = false; mediaKeyInput = ''"
              >{{ t('settings.common.cancel') }}</Button>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">{{ t('settings.media.region') }}</label>
            <Select
              v-model="regionInput"
              :options="[
                { value: 'cn', label: t('settings.media.regionCn') },
                { value: 'global', label: t('settings.media.regionGlobal') },
              ]"
            />
          </div>

          <div class="form-actions">
            <Button variant="primary" :loading="mediaSaving" @click="handleMediaKeySave">
              {{ t('settings.common.save') }}
            </Button>
            <Button
              v-if="mediaKey?.has_api_key"
              variant="secondary"
              :loading="mediaTesting"
              :disabled="mediaSaving"
              @click="handleTestMediaKey"
            >{{ t('settings.media.test') }}</Button>
            <Button
              v-if="mediaKey?.has_api_key"
              variant="danger"
              :disabled="mediaSaving"
              @click="handleDeleteMediaKey"
            >{{ t('settings.media.deleteAll') }}</Button>
          </div>
          <div v-if="mediaMessage" class="message-box small">{{ mediaMessage }}</div>
        </div>
      </section>

      <!-- API Token -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.token.title') }}</h2>
        </div>

        <div class="form-block">
          <p class="muted small">
            {{ t('settings.token.desc1') }} <code class="mono small">Authorization: Bearer &lt;token&gt;</code> {{ t('settings.token.desc2') }}
          </p>

          <!-- 已创建 token (明文仅显示一次) -->
          <div v-if="createdToken" class="success-box">
            <div class="small font-medium mb-1">{{ t('settings.token.createdTitle') }}</div>
            <div class="flex-row gap-2">
              <code class="mono small flex-1 break-all">{{ createdToken }}</code>
              <Button
                variant="ghost"

                @click="copyCreatedToken"
              >{{ t('settings.common.copy') }}</Button>
              <Button
                variant="ghost"

                @click="createdToken = null"
              >{{ t('settings.common.close') }}</Button>
            </div>
          </div>

          <!-- 创建 -->
          <div class="form-row">
            <label class="form-label">{{ t('settings.token.newLabel') }}</label>
            <div class="flex-row gap-2">
              <Input
                v-model="newTokenName"
                type="text"
                class-name="form-input-md"
                :placeholder="t('settings.token.namePlaceholder')"
                :disabled="tokenSaving"
              />
              <Button
                variant="primary"
                :loading="tokenSaving"
                @click="handleCreateApiToken"
              >{{ t('settings.token.create') }}</Button>
            </div>
          </div>

          <!-- 列表 -->
          <Loading v-if="apiTokensLoading && apiTokens.length === 0" :label="t('settings.token.loading')" />
          <Empty v-else-if="!apiTokensLoading && apiTokens.length === 0" variant="doc" :title="t('settings.token.empty')" />
          <div v-else class="token-list-wrap">
            <div class="token-toolbar flex-row gap-2">
              <label class="flex-row gap-1 small cursor-pointer">
                <Checkbox
                  :model-value="allFilteredSelected"
                  :disabled="filteredTokens.length === 0"
                  @update:model-value="toggleSelectAllFiltered"
                />
                <span>{{ t('settings.token.selectAll') }}</span>
              </label>
              <Input
                v-model="tokenSearch"
                type="text"
                class-name="form-input-sm"
                :placeholder="t('settings.token.searchPlaceholder')"
              />
              <Button
                variant="danger"
                :disabled="selectedTokenIds.size === 0 || tokenSaving"
                @click="handleBatchDeleteApiTokens"
              >
                {{ t('settings.token.batchDelete') }} {{ selectedTokenIds.size > 0 ? t('settings.token.batchCount', { n: selectedTokenIds.size }) : '' }}
              </Button>
            </div>

            <div class="token-list">
              <div
                v-if="filteredTokens.length === 0"
                class="muted small text-center py-3"
              >{{ t('settings.token.noMatch') }}</div>
              <div
                v-for="tok in filteredTokens"
                :key="tok.id"
                class="token-row"
                :class="{ selected: selectedTokenIds.has(tok.id) }"
              >
                <div class="flex-row gap-2 min-w-0 flex-1">
                  <Checkbox
                    :model-value="selectedTokenIds.has(tok.id)"
                    :disabled="tokenSaving"
                    @update:model-value="toggleSelectToken(tok.id)"
                  />
                  <code class="mono small">{{ tok.prefix }}…</code>
                  <span class="truncate">{{ tok.name }}</span>
                </div>
                <Button
                  variant="danger"
                  :disabled="tokenSaving"
                  @click="handleDeleteApiToken(tok.id, tok.name)"
                >{{ t('settings.common.delete') }}</Button>
              </div>
            </div>
          </div>

          <div v-if="tokenMessage" class="message-box small">{{ tokenMessage }}</div>

          <p class="muted small mono">
            curl -H "Authorization: Bearer &lt;token&gt;" https://&lt;host&gt;/api/projects
          </p>
          <p class="warn-text small">
            {{ t('settings.token.warn') }}
          </p>
        </div>
      </section>

      <!-- 个人 LLM 配置 (R50.3 B301)
           镜像 master src/app/settings/page.tsx:2314-2500: 列表 + 编辑表单 +
           5 操作按钮 (设默认/编辑/拷贝/复制/删除) + 可见的 LLM 配置聚合块. -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.llm.title') }}</h2>
          <span class="badge badge-warn small">{{ t('settings.llm.minBadge') }}</span>
        </div>

        <p class="muted small">
          {{ t('settings.llm.desc') }}
        </p>

        <div
          v-if="profile?.admin_llm_granted && !isAdmin"
          class="success-box small"
        >
          {{ t('settings.llm.granted') }}
        </div>

        <!-- 列表 -->
        <div v-if="llmConfigs.length > 0" class="llm-table-wrap">
          <table class="llm-table">
            <thead>
              <tr>
                <th>{{ t('settings.llm.thName') }}</th>
                <th>Base URL</th>
                <th>Model</th>
                <th>Key</th>
                <th :title="t('settings.llm.thCoefTitle')">{{ t('settings.llm.thCoef') }}</th>
                <th>{{ t('settings.llm.thDefault') }}</th>
                <th class="text-right">{{ t('settings.llm.thActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="cfg in llmConfigs" :key="cfg.id">
                <td class="font-medium">
                  {{ cfg.name }}
                  <span
                    v-if="cfg.fallback_ids?.length"
                    class="badge small"
                    :title="t('settings.llm.fallbackChainTitle', { chain: cfg.fallback_ids.map(llmCfgName).join(' → ') })"
                  >⛓{{ cfg.fallback_ids.length }}</span>
                  <span
                    v-if="visionBadge(cfg.supports_vision)"
                    class="badge small"
                    :title="cfg.supports_vision ? t('settings.llm.visionYesTitle') : t('settings.llm.visionNoTitle')"
                  >{{ visionBadge(cfg.supports_vision) }}</span>
                </td>
                <td class="mono small truncate-cell" :title="cfg.base_url || ''">
                  {{ cfg.base_url || '—' }}
                </td>
                <td class="mono small truncate-cell" :title="cfg.model || ''">
                  {{ cfg.model || '—' }}
                </td>
                <td>
                  <code v-if="cfg.has_api_key" class="mono small key-chip">{{ cfg.api_key_masked }}</code>
                  <span v-else class="text-warn small">{{ t('settings.llm.noKey') }}</span>
                </td>
                <td class="mono small" :title="t('settings.llm.priceTitle', { pin: cfg.price_in ?? '—', pout: cfg.price_out ?? '—' })">
                  {{ coefficientLabel(cfg, userCostBaselineId) }}
                </td>
                <td>
                  <span v-if="cfg.is_default" class="badge badge-info small">{{ t('settings.llm.defaultBadge') }}</span>
                  <button
                    v-else
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    @click="handleSetLlmDefault(cfg.id)"
                  >{{ t('settings.llm.setDefault') }}</button>
                </td>
                <td class="text-right nowrap">
                  <button
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    @click="startEditLlm(cfg)"
                  >{{ t('settings.common.edit') }}</button>
                  <button
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    @click="handleDuplicateLlmConfig(cfg.id, cfg.name)"
                  >{{ t('settings.common.duplicate') }}</button>
                  <button
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    :title="t('settings.llm.copyTextTitle')"
                    @click="handleCopyLlmConfigText(cfg)"
                  >📋 {{ t('settings.common.copy') }}</button>
                  <button
                    type="button"
                    class="link-btn danger small"
                    :disabled="llmSaving"
                    @click="handleDeleteLlmConfig(cfg.id, cfg.name)"
                  >{{ t('settings.common.delete') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 新增 / 编辑表单 -->
        <div class="llm-form-section">
          <div class="llm-form-head">
            <h3 v-if="editingLlmId !== null" class="small font-medium">
              {{ editingLlmId === 'new' ? t('settings.llm.newTitle') : t('settings.llm.editTitle') }}
            </h3>
            <Button
              v-if="editingLlmId === null"
              variant="primary"

              :disabled="llmSaving"
              @click="startEditLlm('new')"
            >{{ t('settings.llm.add') }}</Button>
          </div>
          <div v-if="editingLlmId !== null" class="llm-form">
            <label class="form-label">
              {{ t('settings.llm.providerLabel') }}
              <Select
                v-model="llmProviderId"
                :options="providerSelectOptions"
                :disabled="llmSaving"
                @update:model-value="(v: string | null) => applyProvider(llmDraft, v ?? '')"
              />
              <span v-if="catalogUpdatedAt" class="small text-muted">
                {{ t('settings.llm.catalogHint', { count: catalogProviders.length, date: catalogUpdatedAt }) }}
              </span>
            </label>
            <label class="form-label">
              {{ t('settings.llm.nameLabel') }}
              <Input
                v-model="llmDraft.name"
                type="text"
                :placeholder="t('settings.llm.namePlaceholder')"
                :disabled="llmSaving"
              />
            </label>
            <label class="form-label">
              Base URL
              <Input
                v-model="llmDraft.base_url"
                type="text"
                :placeholder="config?.base_url || 'https://api.anthropic.com'"
                :disabled="llmSaving"
              />
            </label>
            <label class="form-label">
              Model
              <Input
                v-model="llmDraft.model"
                type="text"
                :placeholder="llmSelectedProvider ? t('settings.llm.modelProviderPlaceholder', { name: llmSelectedProvider.name }) : t('settings.llm.modelPlaceholder')"
                list="llm-model-options"
                :disabled="llmSaving"
              />
              <datalist id="llm-model-options">
                <option v-for="m in llmModelSuggestions" :key="m" :value="m" />
              </datalist>
            </label>
            <label class="form-label">
              API Key
              <Input
                v-model="llmDraft.api_key"
                type="password"
                :placeholder="editingLlmId !== 'new' ? t('settings.llm.keyKeepPlaceholder') : t('settings.llm.keyPlaceholder')"
                :disabled="llmSaving"
                @update:model-value="(v: string) => { if (v) llmDraft.clear_api_key = false; }"
              />
              <span v-if="editingLlmId !== 'new'" class="inline-clear-row">
                <Checkbox
                  id="clear-api-key"
                  :model-value="llmDraft.clear_api_key"
                  :disabled="llmSaving"
                  @update:model-value="(v: boolean) => llmDraft.clear_api_key = v"
                />
                <label for="clear-api-key" class="small">{{ t('settings.llm.clearKey') }}</label>
              </span>
              <span v-if="llmSelectedProvider" class="small text-muted">
                <a :href="llmSelectedProvider.api_key_url" target="_blank" rel="noopener">{{ t('settings.llm.getKeyLink', { name: llmSelectedProvider.name }) }}</a>
              </span>
            </label>
            <label class="form-label">
              {{ t('settings.llm.visionLabel') }}
              <Select
                v-model="llmVisionSelect"
                :options="visionSelectOptions"
                :disabled="llmSaving"
                :placeholder="t('settings.llm.visionUnset')"
              />
              <span class="small text-muted">{{ t('settings.llm.visionHint') }}</span>
            </label>
            <div class="form-label">
              <span>{{ t('settings.llm.priceLabel') }}</span>
              <div class="llm-price-row">
                <label class="small">{{ t('settings.llm.priceIn') }}
                  <Input v-model="llmDraft.price_in" type="number" step="any" min="0" :placeholder="t('settings.llm.pricePhIn')" :disabled="llmSaving" />
                </label>
                <label class="small">{{ t('settings.llm.priceOut') }}
                  <Input v-model="llmDraft.price_out" type="number" step="any" min="0" :placeholder="t('settings.llm.pricePhOut')" :disabled="llmSaving" />
                </label>
                <label class="small">{{ t('settings.llm.priceCacheRead') }}
                  <Input v-model="llmDraft.price_cache_read" type="number" step="any" min="0" :placeholder="t('settings.llm.pricePhCache')" :disabled="llmSaving" />
                </label>
              </div>
              <span class="small text-muted">{{ t('settings.llm.priceHint') }}</span>
            </div>
            <div v-if="otherLlmConfigs(editingLlmId === 'new' ? '' : editingLlmId || '').length" class="form-label">
              <span>{{ t('settings.llm.fallbackLabel') }}</span>
              <div class="llm-fallback-chips">
                <button
                  v-for="c in otherLlmConfigs(editingLlmId === 'new' ? '' : editingLlmId || '')"
                  :key="c.id"
                  type="button"
                  class="llm-chip"
                  :class="{ active: llmDraft.fallback_ids.includes(c.id) }"
                  :disabled="llmSaving"
                  @click="toggleLlmFallback(c.id)"
                >{{ llmDraft.fallback_ids.includes(c.id) ? `${llmDraft.fallback_ids.indexOf(c.id) + 1}. ` : '' }}{{ c.name }}</button>
              </div>
              <span v-if="llmDraft.fallback_ids.length" class="small text-muted">
                {{ t('settings.llm.fallbackOrder', { list: llmDraft.fallback_ids.map((id, i) => `${i + 1}.${llmCfgName(id)}`).join(' → ') }) }}
              </span>
            </div>
            <div class="form-actions">
              <Button
                variant="primary"
                :loading="llmSaving"
                :disabled="!llmDraft.name.trim()"
                @click="handleLlmSave"
              >{{ t('settings.common.save') }}</Button>
              <Button
                variant="ghost"
                :disabled="llmSaving"
                @click="cancelEditLlm"
              >{{ t('settings.common.cancel') }}</Button>
              <span v-if="llmMessage" class="small">{{ llmMessage }}</span>
            </div>
          </div>
        </div>

        <!-- 可见的 LLM 配置聚合 (任务/模板选择器数据源) -->
        <div v-if="availableLlmConfigs.length > 0" class="llm-available">
          <h3 class="small font-medium">{{ t('settings.llm.availableTitle') }}</h3>
          <div class="llm-available-grid">
            <div
              v-for="cfg in availableLlmConfigs"
              :key="cfg.id"
              class="llm-available-row"
            >
              <div class="flex-row gap-2">
                <span
                  class="badge small"
                  :class="cfg.source === 'self' ? 'badge-info' : 'badge-warn'"
                >{{ cfg.source === 'self' ? t('settings.llm.mine') : t('settings.llm.platformBadge') }}</span>
                <span class="font-medium small">{{ cfg.name }}</span>
                <span v-if="cfg.is_default" class="text-info small">{{ t('settings.llm.defaultBadge') }}</span>
              </div>
              <div class="muted small mono">
                {{ cfg.model || '—' }} · {{ cfg.base_url || t('settings.llm.baseUrlDefault') }}
              </div>
            </div>
          </div>
        </div>
        <div v-else-if="llmMessage && !llmSaving" class="message-box small">{{ llmMessage }}</div>
      </section>
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 通知 (notify)                                              -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'notify'" class="tab-panel">
      <!-- 通知邮箱 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.notify.title') }}</h2>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-notify-email" class="form-label">
              {{ t('settings.notify.emailLabel') }}
              <span class="form-hint">{{ t('settings.notify.emailHint') }}</span>
            </label>
            <Input
              id="user-notify-email"
              v-model="profileForm.notify_email"
              type="email"
              :disabled="notifySaving || notifyTesting"
              placeholder="user@example.com"
              class-name="form-input-md"
            />
            <span class="form-aside">
              <span
                class="status-dot"
                :class="profile.notify_email ? 'ok' : 'warn'"
              />
              {{ profile.notify_email ? t('settings.notify.current', { email: profile.notify_email }) : t('settings.notify.notSet') }}
            </span>
          </div>

          <div v-if="profile.mailer_configured === false" class="warn-box small">
            {{ t('settings.notify.smtpWarn') }}
          </div>

          <div class="form-actions">
            <Button variant="primary" :loading="notifySaving" @click="saveNotifyEmail">
              {{ t('settings.notify.save') }}
            </Button>
            <Button
              variant="secondary"
              :loading="notifyTesting"
              :disabled="notifySaving"
              :title="t('settings.notify.testTitle')"
              @click="handleNotifyEmailTest"
            >
              {{ notifyTesting ? t('settings.notify.sending') : t('settings.notify.test') }}
            </Button>
          </div>
          <div v-if="notifyMessage" class="message-box small">{{ notifyMessage }}</div>
          <p v-if="profile.notify_fallback_to" class="muted small">
            {{ t('settings.notify.testAsidePre') }}<strong>{{ t('settings.notify.testAsideStrong') }}</strong>{{ t('settings.notify.testAsidePost') }}
          </p>
        </div>
      </section>

      <!-- 飞书机器人 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.feishu.title') }}</h2>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-feishu-url" class="form-label">
              Webhook URL
              <span class="form-hint">{{ t('settings.feishu.urlHint') }}</span>
            </label>
            <Input
              id="user-feishu-url"
              v-model="profileForm.feishu_webhook_url"
              type="url"
              :disabled="feishuSaving || feishuWebhookTesting"
              placeholder="https://open.feishu.cn/hook/..."
            />
            <span class="form-aside">
              <span
                class="status-dot"
                :class="profile.feishu_configured ? 'ok' : 'warn'"
              />
              {{
                feishuWebhookMeta?.masked_url
                  ? t('settings.feishu.current', { url: feishuWebhookMeta.masked_url })
                  : profile.feishu_configured
                    ? t('settings.feishu.configured')
                    : t('settings.feishu.notConfigured')
              }}
            </span>
          </div>

          <div class="form-row">
            <label class="form-label">{{ t('settings.feishu.msgType') }}</label>
            <div class="flex-row gap-2">
              <Select
                v-model="feishuMsgType"
                :options="[
                  { value: 'text', label: t('settings.feishu.optText') },
                  { value: 'markdown', label: t('settings.feishu.optMarkdown') },
                  { value: 'post', label: t('settings.feishu.optPost') },
                ]"
                :disabled="feishuWebhookTesting"
              />
              <span class="form-aside">
                {{ t('settings.feishu.msgTypeAside') }}
              </span>
            </div>
          </div>

          <div v-if="feishuMsgType === 'post'" class="form-row">
            <label class="form-label">{{ t('settings.feishu.postMode') }}</label>
            <Input
              v-model="feishuPostTitle"
              type="text"
              :placeholder="t('settings.feishu.postTitlePh')"
              :disabled="feishuWebhookTesting"
              class-name="form-input-md"
            />
            <Textarea
              v-model="feishuPostContent"
              :rows="3"
              :placeholder="t('settings.feishu.postContentPh')"
              :disabled="feishuWebhookTesting"
              class-name="form-textarea"
            />
          </div>

          <div class="form-actions">
            <Button variant="primary" :loading="feishuSaving" @click="saveFeishuWebhook">
              {{ t('settings.feishu.save') }}
            </Button>
            <Button
              variant="secondary"
              :loading="feishuWebhookTesting"
              :disabled="feishuSaving || (!profile.feishu_configured && !profileForm.feishu_webhook_url.trim())"
              :title="t('settings.feishu.testTitle')"
              @click="handleFeishuWebhookTest"
            >
              {{ feishuWebhookTesting ? t('settings.feishu.sending') : t('settings.feishu.test') }}
            </Button>
          </div>
          <div v-if="feishuWebhookMessage" class="message-box small">{{ feishuWebhookMessage }}</div>
          <p class="muted small">
            {{ t('settings.feishu.aside') }}
          </p>
        </div>
      </section>
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 调度 (schedule) — 所有人可读, admin 可写                  -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'schedule'" class="tab-panel">
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.sched.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.sched.badge') }}</span>
        </div>

        <Loading v-if="configLoading && !config" :label="t('settings.sched.loading')" />
        <ErrorView
          v-else-if="configError"
          variant="error"
          :title="t('settings.sched.loadFailed')"
          :description="configError"
          :retrying="configRetrying"
          @retry="loadConfig(true)"
        />
        <Empty v-else-if="!config" variant="doc" :title="t('settings.sched.empty')" />

        <div v-else class="section-body">
          <div class="form-row">
            <label class="form-label">
              {{ t('settings.sched.concurrency') }}
              <span class="form-hint">
                {{ t('settings.sched.rangeHint', { min: config.concurrency_min, max: config.concurrency_max }) }}
              </span>
            </label>
            <Input
              v-model="appForm.concurrency"
              type="number"
              :disabled="!isAdmin || appSaving"
              :error="appFieldErrors.concurrency"
              class-name="form-input-sm"
              placeholder=""
            />
            <span class="form-aside">
              {{ t('settings.sched.queueAside', { running: config.running_count, cap: config.concurrency, depth: config.queue_size }) }}
            </span>
          </div>

          <div class="form-row">
            <label class="form-label">
              {{ t('settings.sched.timeout') }}
              <span class="form-hint">
                {{ t('settings.sched.rangeHint', { min: config.task_timeout_min, max: config.task_timeout_max }) }}
              </span>
            </label>
            <Input
              v-model="appForm.task_timeout_minutes"
              type="number"
              :disabled="!isAdmin || appSaving"
              :error="appFieldErrors.task_timeout_minutes"
              class-name="form-input-sm"
              placeholder=""
            />
            <span class="form-aside">
              {{ t('settings.sched.timeoutAside') }}
            </span>
          </div>

          <div class="form-row">
            <label class="form-label">
              {{ t('settings.sched.portPool') }}
              <span class="form-hint">
                {{ t('settings.sched.portPoolHint', { segs: config.port_pool_max_segments, min: config.port_pool_min, max: config.port_pool_max }) }}
              </span>
            </label>
            <div v-if="!isAdmin" class="mono small">
              <span
                v-for="(seg, i) in config.port_pool"
                :key="i"
                class="seg-readonly"
              >[{{ seg[0] }}, {{ seg[1] }}]</span>
            </div>
            <div v-else class="seg-list">
              <div
                v-for="(seg, i) in appForm.portPoolSegments"
                :key="i"
                class="seg-row"
              >
                <Input
                  v-model="seg.start"
                  type="number"
                  :disabled="appSaving"
                  placeholder="start"
                  class-name="form-input-xs"
                />
                <span class="seg-dash">—</span>
                <Input
                  v-model="seg.end"
                  type="number"
                  :disabled="appSaving"
                  placeholder="end"
                  class-name="form-input-xs"
                />
                <Button
                  variant="ghost"

                  :disabled="appSaving"
                  @click="removePortPoolSegment(i)"
                >{{ t('settings.common.delete') }}</Button>
              </div>
              <Button
                variant="secondary"

                :disabled="appSaving"
                @click="addPortPoolSegment"
              >{{ t('settings.sched.addSegment') }}</Button>
            </div>
            <p v-if="appFieldErrors.port_pool" class="form-error small">
              {{ appFieldErrors.port_pool }}
            </p>
            <p v-else-if="isAdmin" class="muted small form-aside">
              {{ t('settings.sched.portPoolAside') }}
            </p>
          </div>

          <div v-if="isAdmin" class="form-actions">
            <Button variant="primary" :loading="appSaving" @click="saveAppConfig">
              {{ t('settings.sched.save') }}
            </Button>
            <Button variant="ghost" :disabled="appSaving" @click="resetAppForm">
              {{ t('settings.common.reset') }}
            </Button>
          </div>
        </div>
      </section>

      <!-- v55+ R88 个人配额卡 (Sheet L 验收 ⑤) — party_a_enabled=1 才渲染,
           普通用户 party_a=0 直接不存在 (老用户零行为变化).
           admin 视角下, 自己在 /api/admin/users 里被标记为甲方, 这里才看到.
           累计费用明细不在此卡展示 (用户端 profile 不返 used_total_usd). -->
      <section
        v-if="profile?.party_a_enabled"
        class="card section-card"
      >
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.myQuota.title') }}</h2>
          <span class="badge badge-warn">{{ t('settings.myQuota.badge') }}</span>
        </div>

        <p class="muted small">
          {{ t('settings.myQuota.desc') }}
        </p>

        <div class="kv-block">
          <div class="kv-row">
            <span class="kv-key">{{ t('settings.myQuota.spentCap') }}</span>
            <span class="kv-val mono">
              {{
                profile.quota_total_spent_cap !== null && profile.quota_total_spent_cap !== undefined
                  ? `$${Number(profile.quota_total_spent_cap).toFixed(2)}`
                  : t('settings.common.unlimited')
              }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">{{ t('settings.myQuota.grantedCap') }}</span>
            <span class="kv-val mono">
              {{
                profile.quota_granted_cap !== null && profile.quota_granted_cap !== undefined
                  ? `$${Number(profile.quota_granted_cap).toFixed(2)}`
                  : t('settings.common.unlimited')
              }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">{{ t('settings.myQuota.expireAt') }}</span>
            <span class="kv-val mono">{{ profile.quota_expire_at ?? t('settings.common.unlimited') }}</span>
          </div>
        </div>

        <p class="muted small kv-hint">
          {{ t('settings.myQuota.hint') }}
        </p>
      </section>
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 角色 (roles) — 波3 P5: RolesPanel 独立组件                  -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'roles'" class="tab-panel">
      <RolesPanel />
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 渠道 (channels) — docs/plans/channel-role-ui.md D2         -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'channels'" class="tab-panel">
      <ChannelsPanel />
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 平台管理 (platform) — admin only                          -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'platform' && showPlatformTab" class="tab-panel">
      <!-- 系统 API 配置 (env) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.sysApi.title') }}</h2>
        </div>

        <div v-if="config" class="kv-block">
          <div class="kv-row">
            <span class="kv-key">ANTHROPIC_API_KEY</span>
            <span class="kv-val">
              <span
                class="status-dot"
                :class="config.api_key_configured ? 'ok' : 'fail'"
              />
              {{ config.api_key_configured ? t('settings.sysApi.configured') : t('settings.sysApi.notConfigured') }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">ANTHROPIC_BASE_URL</span>
            <span class="kv-val mono">{{ config.base_url }}</span>
          </div>
          <div v-if="config.model" class="kv-row">
            <span class="kv-key">{{ t('settings.sysApi.defaultModel') }}</span>
            <span class="kv-val mono">{{ config.model }}</span>
          </div>
          <p class="muted small kv-hint">
            {{ t('settings.sysApi.hint') }}
          </p>
        </div>
      </section>

      <!-- 维护模式 -->
      <section
        class="card section-card"
        :class="{ 'maint-active': maintenance?.active }"
      >
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.maint.title') }}</h2>
          <span
            class="badge"
            :class="maintenance?.active ? 'badge-warn' : 'badge-ok'"
          >
            {{ maintenance?.active ? t('settings.maint.activeBadge') : t('settings.maint.okBadge') }}
          </span>
        </div>

        <Loading v-if="maintenanceLoading && !maintenance" :label="t('settings.maint.loading')" />
        <ErrorView
          v-else-if="maintenanceError"
          variant="error"
          :title="t('settings.maint.loadFailed')"
          :description="maintenanceError"
          @retry="loadMaintenance"
        />

        <div v-else-if="maintenance" class="form-block">
          <p class="muted small">
            {{ t('settings.maint.desc') }}
          </p>

          <div v-if="maintenance.active" class="warn-box small">
            <div>{{ t('settings.maint.enteredAt') }} {{ maintenance.entered_at || '—' }}</div>
            <div v-if="maintenance.reason">{{ t('settings.maint.reason') }} {{ maintenance.reason }}</div>
            <div>{{ t('settings.maint.suspended', { n: maintenance.suspended_count }) }}</div>
          </div>

          <!-- v53 上次维护: active=true 时不显示避免歧义 -->
          <div
            v-else-if="maintenance.last_maintenance"
            class="muted small maint-last"
          >
            <div class="flex-row gap-2">
              <span class="font-medium">{{ t('settings.maint.last') }}</span>
              <span
                class="maint-result-chip"
                :class="{
                  'maint-result-failed': maintenance.last_maintenance.result === 'failed',
                  'maint-result-aborted': maintenance.last_maintenance.result === 'aborted',
                  'maint-result-ok': maintenance.last_maintenance.result === 'completed',
                }"
              >
                {{
                  maintenance.last_maintenance.result === 'failed' ? t('settings.maint.resultFailed')
                  : maintenance.last_maintenance.result === 'aborted' ? t('settings.maint.resultAborted')
                  : t('settings.maint.resultDone')
                }}
              </span>
            </div>
            <div>
              {{ formatMaintenanceTime(maintenance.last_maintenance.started_at) }}
              <template v-if="maintenance.last_maintenance.duration_seconds !== null">
                → {{ formatMaintenanceDuration(maintenance.last_maintenance.duration_seconds) }}
              </template>
              <template v-if="maintenance.last_maintenance.reason">
                · {{ t('settings.maint.reason') }} {{ maintenance.last_maintenance.reason }}
              </template>
            </div>
            <div v-if="maintenance.last_maintenance.paused_count > 0 || maintenance.last_maintenance.dequeued_count > 0 || maintenance.last_maintenance.failed_count > 0">
              {{ t('settings.maint.impactPaused', { n: maintenance.last_maintenance.paused_count }) }}
              <template v-if="maintenance.last_maintenance.dequeued_count > 0">
                {{ t('settings.maint.impactDequeued', { n: maintenance.last_maintenance.dequeued_count }) }}
              </template>
              <template v-if="maintenance.last_maintenance.failed_count > 0">
                {{ t('settings.maint.impactFailed', { n: maintenance.last_maintenance.failed_count }) }}
              </template>
            </div>
          </div>

          <div class="muted small">
            {{ t('settings.maint.statusLine', {
              state: maintenance.scheduler_paused ? t('settings.maint.pausedState') : t('settings.maint.normalState'),
              running: maintenance.running_count,
              queue: maintenance.queue_size,
            }) }}
          </div>

          <div class="form-actions">
            <Button
              v-if="!maintenance.active"
              variant="primary"
              @click="handleEnterMaintenance"
            >{{ t('settings.maint.enter') }}</Button>
            <Button
              v-else
              variant="primary"
              @click="handleExitMaintenance"
            >{{ t('settings.maint.exit') }}</Button>
          </div>
        </div>
      </section>

      <!-- 账号配额 (R50.1 B309) — admin 卡片
           镜像 master src/app/settings/page.tsx:1794-1979: 每用户一行 + party_a 开关 +
           3 字段 onBlur 自动保存 + 「查看变更历史」按钮. -->
      <section class="card section-card quota-section">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.quotaAdmin.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.common.adminBadge') }}</span>
        </div>

        <p class="muted small">
          {{ t('settings.quotaAdmin.desc') }}
        </p>

        <div v-if="quotaMessage" class="message-box small">{{ quotaMessage }}</div>

        <div v-if="quotaUsers.length === 0" class="muted small text-center py-3">
          {{ t('settings.quotaAdmin.noUsers') }}
        </div>
        <div v-else class="quota-list">
          <div
            v-for="u in quotaUsers"
            :key="u.id"
            class="quota-row"
          >
            <div class="quota-row-head">
              <div class="quota-user-meta">
                <span class="mono small">{{ u.email }}</span>
                <span
                  v-if="u.role === 'admin'"
                  class="badge badge-info small"
                >{{ t('settings.common.adminBadge') }}</span>
                <span
                  v-if="u.party_a_enabled"
                  class="badge badge-warn small"
                >{{ t('settings.quotaAdmin.partyBadge') }}</span>
              </div>
              <label class="party-toggle" :title="u.party_a_enabled ? t('settings.quotaAdmin.unmarkParty') : t('settings.quotaAdmin.markParty')">
                <Checkbox
                  :model-value="u.party_a_enabled"
                  :disabled="!!quotaSaving[u.id]"
                  @update:model-value="(v: boolean) => saveQuota(u.id, { party_a_enabled: v })"
                />
                <span class="party-toggle-track" />
              </label>
            </div>

            <!-- 用量进度条: party_a=1 且有上限才显示 -->
            <div
              v-if="u.party_a_enabled && u.quota_total_spent_cap !== null && u.quota_total_spent_cap > 0"
              class="quota-progress"
            >
              <div class="quota-progress-meta">
                <span class="muted small">
                  {{ t('settings.quotaAdmin.usedOf', { used: (u.used_total_usd || 0).toFixed(2), cap: u.quota_total_spent_cap.toFixed(2) }) }}
                </span>
                <span
                  class="small font-medium"
                  :class="quotaPctClass(u)"
                >{{ quotaPct(u).toFixed(0) }}%</span>
              </div>
              <div class="quota-progress-bar">
                <div
                  class="quota-progress-fill"
                  :class="quotaPctClass(u)"
                  :style="{ width: quotaPct(u) + '%' }"
                />
              </div>
            </div>

            <!-- 3 字段 onBlur 保存 -->
            <div class="quota-fields">
              <label class="form-label">
                {{ t('settings.quotaAdmin.spentCapLabel') }}
                <Input
                  :model-value="u.quota_total_spent_cap === null ? '' : String(u.quota_total_spent_cap)"
                  type="number"
                  :min="0"
                  :step="0.01"
                  :placeholder="t('settings.common.unlimited')"
                  :disabled="!!quotaSaving[u.id]"
                  class-name="form-input-sm"
                  @update:model-value="(v: string) => onCapBlur(u, v)"
                />
              </label>
              <label class="form-label">
                {{ t('settings.quotaAdmin.grantedCapLabel') }}
                <Input
                  :model-value="u.quota_granted_cap === null ? '' : String(u.quota_granted_cap)"
                  type="number"
                  :min="0"
                  :step="0.01"
                  :placeholder="t('settings.common.unlimited')"
                  :disabled="!!quotaSaving[u.id]"
                  class-name="form-input-sm"
                  @update:model-value="(v: string) => onGrantedCapBlur(u, v)"
                />
              </label>
              <label class="form-label">
                {{ t('settings.quotaAdmin.expireLabel') }}
                <Input
                  :model-value="u.quota_expire_at ?? ''"
                  type="text"
                  :placeholder="t('settings.quotaAdmin.expirePh')"
                  :disabled="!!quotaSaving[u.id]"
                  class-name="form-input-sm"
                  @update:model-value="(v: string) => onExpireAtBlur(u, v)"
                />
              </label>
            </div>

            <div class="quota-row-foot">
              <button
                type="button"
                class="link-btn small"
                @click="toggleQuotaLog(u.id)"
              >
                {{ quotaLogOpen === u.id ? t('settings.quotaAdmin.collapse') : t('settings.quotaAdmin.viewLog') }}
              </button>
            </div>

            <div v-if="quotaLogOpen === u.id" class="quota-log">
              <div
                v-if="quotaLogByUser[u.id] === undefined"
                class="muted small"
              >{{ t('settings.common.loading') }}</div>
              <div
                v-else-if="!quotaLogByUser[u.id] || quotaLogByUser[u.id]!.length === 0"
                class="muted small"
              >{{ t('settings.quotaAdmin.noLog') }}</div>
              <ul v-else class="quota-log-list">
                <li
                  v-for="entry in quotaLogByUser[u.id]"
                  :key="entry.id"
                  class="small"
                >
                  <span class="muted mono">{{ entry.created_at }}</span>
                  · <span class="mono">{{ entry.field }}</span>
                  <template v-if="entry.old_value !== null && entry.new_value !== null">
                    : {{ entry.old_value }} → {{ entry.new_value }}
                  </template>
                  <template v-else-if="entry.new_value !== null && entry.old_value === null">
                    : → {{ entry.new_value }}
                  </template>
                  <span v-if="entry.reason" class="muted"> ({{ entry.reason }})</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- 分页 (AO-DEV R208) — 服务端分页, 与 Assets / Runners 同款 Pagination.
             :model-value 单向 + emit 收口到 onQuotaPageChange (不绑 v-model 防
             同值 emit 被短路). total>0 才渲染. -->
        <Pagination
          v-if="quotaTotal > 0"
          :model-value="quotaPage"
          :total="quotaTotal"
          :page-size="quotaPageSize"
          @update:model-value="onQuotaPageChange"
          @update:page-size="onQuotaPageSizeChange"
        />
      </section>

      <!-- 平台 LLM admin (R55.8 / B307) — admin only
           镜像 master src/app/settings/page.tsx:1548-1697: 表格 + CRUD + 设为默认 / 拷贝 / 删除.
           这些 LLM 配置 → /api/user/llm-config/available 时 source='admin_grant' 露出,
           被授权用户在 task/template 选择 (与 account tab 文末的「可用 LLM」联动). -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.adminLlm.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.common.adminBadge') }}</span>
        </div>

        <p class="muted small">
          {{ t('settings.adminLlm.desc') }}
        </p>

        <div v-if="adminLlmMessage" class="message-box small">{{ adminLlmMessage }}</div>

        <Loading v-if="adminLlmLoading && adminLlmConfigs.length === 0" :label="t('settings.adminLlm.loading')" />
        <Empty v-else-if="adminLlmConfigs.length === 0" variant="doc" :title="t('settings.adminLlm.empty')" />

        <p class="muted small">
          {{ t('settings.adminLlm.desc') }}
          <span>{{ t('settings.adminLlm.baselineHint') }}</span>
        </p>

        <div v-if="adminLlmMessage" class="message-box small">{{ adminLlmMessage }}</div>

        <Loading v-if="adminLlmLoading && adminLlmConfigs.length === 0" :label="t('settings.adminLlm.loading')" />
        <Empty v-else-if="adminLlmConfigs.length === 0" variant="doc" :title="t('settings.adminLlm.empty')" />

        <div v-else class="admin-llm-table">
          <div class="admin-llm-head">
            <span>{{ t('settings.llm.thName') }}</span>
            <span>Base URL</span>
            <span>Model</span>
            <span>API Key</span>
            <span :title="t('settings.adminLlm.coefTitle')">{{ t('settings.llm.thCoef') }}</span>
            <span>{{ t('settings.llm.thDefault') }}</span>
            <span class="ta-right">{{ t('settings.llm.thActions') }}</span>
          </div>
          <div
            v-for="cfg in adminLlmConfigs"
            :key="cfg.id"
            class="admin-llm-row"
          >
            <span class="mono">
              {{ cfg.name }}
              <span
                v-if="cfg.fallback_ids?.length"
                class="badge small"
                :title="t('settings.llm.fallbackChainTitle', { chain: cfg.fallback_ids.map(adminLlmCfgName).join(' → ') })"
              >⛓{{ cfg.fallback_ids.length }}</span>
              <span
                v-if="visionBadge(cfg.supports_vision)"
                class="badge small"
                :title="cfg.supports_vision ? t('settings.llm.visionYesTitle') : t('settings.llm.visionNoTitle')"
              >{{ visionBadge(cfg.supports_vision) }}</span>
            </span>
            <span
              class="mono truncate max-w-[150px]"
              :title="cfg.base_url || ''"
            >{{ cfg.base_url || '—' }}</span>
            <span
              class="mono truncate max-w-[160px]"
              :title="cfg.model || ''"
            >{{ cfg.model || '—' }}</span>
            <span>
              <code v-if="cfg.has_api_key" class="mono small bg-gray">{{ cfg.api_key_masked }}</code>
              <span v-else class="text-warn small">{{ t('settings.llm.noKey') }}</span>
            </span>
            <span class="mono small" :title="t('settings.llm.priceTitle', { pin: cfg.price_in ?? '—', pout: cfg.price_out ?? '—' })">
              {{ coefficientLabel(cfg, costBaselineId) }}
            </span>
            <span>
              <span v-if="cfg.is_default" class="badge badge-info small">{{ t('settings.llm.defaultBadge') }}</span>
              <button
                v-else
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmDefault(cfg.id)"
              >{{ t('settings.llm.setDefault') }}</button>
              <button
                v-if="costBaselineId !== cfg.id"
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                :title="t('settings.adminLlm.setBaselineTitle')"
                @click="handleSetBaseline(cfg.id)"
              >{{ t('settings.adminLlm.setBaseline') }}</button>
              <button
                v-else
                type="button"
                class="link-btn small link-btn-danger"
                :disabled="adminLlmSaving"
                :title="t('settings.adminLlm.clearBaselineTitle')"
                @click="handleSetBaseline(null)"
              >{{ t('settings.adminLlm.clearBaseline') }}</button>
            </span>
            <span class="ta-right admin-llm-actions">
              <button
                type="button"
                class="link-btn small"
                @click="startEditAdminLlm(cfg)"
              >{{ t('settings.common.edit') }}</button>
              <button
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmDuplicate(cfg.id, cfg.name)"
              >{{ t('settings.common.duplicate') }}</button>
              <button
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmCopyText(cfg)"
              >📋 {{ t('settings.common.copy') }}</button>
              <button
                type="button"
                class="link-btn small link-btn-danger"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmDelete(cfg.id, cfg.name)"
              >{{ t('settings.common.delete') }}</button>
            </span>
          </div>
        </div>

        <!-- 新增 / 编辑表单 -->
        <div class="admin-llm-form">
          <div class="admin-llm-form-head">
            <h3 class="small-section">
              {{ editingAdminLlmId === 'new' ? t('settings.adminLlm.newTitle') : editingAdminLlmId ? t('settings.adminLlm.editTitle') : '' }}
            </h3>
            <Button
              v-if="editingAdminLlmId === null"
              variant="primary"

              @click="startEditAdminLlm('new')"
            >{{ t('settings.llm.add') }}</Button>
          </div>

          <div v-if="editingAdminLlmId !== null" class="form-block">
            <label class="form-label">{{ t('settings.llm.providerLabel') }}
              <Select
                v-model="adminLlmProviderId"
                :options="providerSelectOptions"
                @update:model-value="(v: string | null) => applyProvider(adminLlmDraft, v ?? '')"
              />
              <span v-if="catalogUpdatedAt" class="small text-muted">
                {{ t('settings.llm.catalogHint', { count: catalogProviders.length, date: catalogUpdatedAt }) }}
              </span>
            </label>
            <label class="form-label">{{ t('settings.llm.nameLabel') }}</label>
            <Input v-model="adminLlmDraft.name" :placeholder="t('settings.llm.namePlaceholder')" />

            <label class="form-label">Base URL</label>
            <Input v-model="adminLlmDraft.base_url" placeholder="https://api.anthropic.com" />

            <label class="form-label">Model</label>
            <Input
              v-model="adminLlmDraft.model"
              :placeholder="adminLlmSelectedProvider ? t('settings.llm.modelProviderPlaceholder', { name: adminLlmSelectedProvider.name }) : t('settings.llm.modelPlaceholder')"
              list="admin-llm-model-options"
            />
            <datalist id="admin-llm-model-options">
              <option v-for="m in adminLlmModelSuggestions" :key="m" :value="m" />
            </datalist>

            <label class="form-label">API Key</label>
            <Input
              v-model="adminLlmDraft.api_key"
              type="password"
              :placeholder="editingAdminLlmId !== 'new' ? t('settings.llm.keyKeepPlaceholder') : t('settings.llm.keyPlaceholder')"
            />
            <label v-if="editingAdminLlmId !== 'new'" class="form-label small">
              <Checkbox v-model="adminLlmDraft.clear_api_key" />
              {{ t('settings.llm.clearKey') }}
            </label>
            <p v-if="adminLlmSelectedProvider" class="form-label small text-muted">
              <a :href="adminLlmSelectedProvider.api_key_url" target="_blank" rel="noopener">{{ t('settings.llm.getKeyLink', { name: adminLlmSelectedProvider.name }) }}</a>
            </p>

            <label class="form-label">{{ t('settings.llm.visionLabel') }}</label>
            <Select
              v-model="adminVisionSelect"
              :options="visionSelectOptions"
              :disabled="adminLlmSaving"
              :placeholder="t('settings.llm.visionUnset')"
            />

            <label class="form-label">{{ t('settings.adminLlm.priceLabel') }}</label>
            <div class="llm-price-row">
              <label class="small">{{ t('settings.llm.priceIn') }}
                <Input v-model="adminLlmDraft.price_in" type="number" step="any" min="0" :placeholder="t('settings.llm.pricePhIn')" :disabled="adminLlmSaving" />
              </label>
              <label class="small">{{ t('settings.llm.priceOut') }}
                <Input v-model="adminLlmDraft.price_out" type="number" step="any" min="0" :placeholder="t('settings.llm.pricePhOut')" :disabled="adminLlmSaving" />
              </label>
              <label class="small">{{ t('settings.llm.priceCacheRead') }}
                <Input v-model="adminLlmDraft.price_cache_read" type="number" step="any" min="0" :placeholder="t('settings.llm.pricePhCache')" :disabled="adminLlmSaving" />
              </label>
            </div>
            <span class="small text-muted">{{ t('settings.adminLlm.priceHint') }}</span>

            <div
              v-if="adminLlmConfigs.filter((c) => c.id !== (editingAdminLlmId === 'new' ? '' : editingAdminLlmId)).length"
              class="form-label"
            >
              <span>{{ t('settings.llm.fallbackLabel') }}</span>
              <div class="llm-fallback-chips">
                <button
                  v-for="c in adminLlmConfigs.filter((cc) => cc.id !== (editingAdminLlmId === 'new' ? '' : editingAdminLlmId))"
                  :key="c.id"
                  type="button"
                  class="llm-chip"
                  :class="{ active: adminLlmDraft.fallback_ids.includes(c.id) }"
                  :disabled="adminLlmSaving"
                  @click="toggleAdminLlmFallback(c.id)"
                >{{ adminLlmDraft.fallback_ids.includes(c.id) ? `${adminLlmDraft.fallback_ids.indexOf(c.id) + 1}. ` : '' }}{{ c.name }}</button>
              </div>
              <span v-if="adminLlmDraft.fallback_ids.length" class="small text-muted">
                {{ t('settings.llm.fallbackOrder', { list: adminLlmDraft.fallback_ids.map((id, i) => `${i + 1}.${adminLlmCfgName(id)}`).join(' → ') }) }}
              </span>
            </div>

            <div class="form-actions">
              <Button
                variant="primary"

                :loading="adminLlmSaving"
                :disabled="adminLlmSaving || !adminLlmDraft.name.trim()"
                @click="saveAdminLlm"
              >{{ t('settings.common.save') }}</Button>
              <Button variant="ghost" :disabled="adminLlmSaving" @click="cancelEditAdminLlm">
                {{ t('settings.common.cancel') }}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <!-- 用户授权 grants (R55.9 / B308) — admin only
           镜像 master src/app/settings/page.tsx:1701-1790: 每用户一行 +
           max_concurrency onBlur 保存 + granted 授权 toggle + 翻页. -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">{{ t('settings.grants.title') }}</h2>
          <span class="badge badge-info">{{ t('settings.common.adminBadge') }}</span>
        </div>

        <p class="muted small">
          {{ t('settings.grants.desc') }}
        </p>

        <div v-if="grantsMessage" class="message-box small">{{ grantsMessage }}</div>

        <Loading v-if="grantsLoading && grants.length === 0" :label="t('settings.grants.loading')" />
        <Empty v-else-if="grants.length === 0" variant="doc" :title="t('settings.grants.empty')" />

        <div v-else class="grants-table">
          <div class="grants-head">
            <span>{{ t('settings.grants.thUser') }}</span>
            <span>{{ t('settings.grants.thConcurrency') }}</span>
            <span class="ta-right">{{ t('settings.grants.thGrant') }}</span>
          </div>
          <div
            v-for="u in pagedGrants"
            :key="u.id"
            class="grants-row"
          >
            <span class="grants-user">
              <span class="mono">{{ u.email }}</span>
              <span v-if="u.role === 'admin'" class="badge badge-info small">{{ t('settings.common.adminBadge') }}</span>
            </span>
            <span class="grants-input">
              <Input
                type="number"
                :model-value="u.max_concurrency === null ? '' : String(u.max_concurrency ?? '')"
                :placeholder="t('settings.common.unlimited')"
                class-name="form-input-sm mono center"
                @blur="(e: FocusEvent) => saveConcurrency(u.id, (e.target as HTMLInputElement).value)"
              />
              <span v-if="concurrencyStatus[u.id] === 'saving'" class="muted small">…</span>
              <span v-else-if="concurrencyStatus[u.id] === 'saved'" class="text-ok small">✓</span>
              <span v-else-if="concurrencyStatus[u.id] === 'error'" class="text-warn small">✗</span>
            </span>
            <span class="ta-right">
              <span v-if="u.role === 'admin'" class="muted small">{{ t('settings.grants.defaultBadge') }}</span>
              <label v-else class="grant-toggle">
                <Checkbox
                  :model-value="u.granted"
                  :disabled="grantsSaving"
                  @update:model-value="(v: boolean) => handleGrantToggle(u.id, v)"
                />
                <span class="grant-toggle-track" />
              </label>
            </span>
          </div>

          <div v-if="totalGrantPages > 1" class="grants-pager">
            <Button
              variant="ghost"

              :disabled="safeGrantsPage === 0"
              @click="grantsPage = safeGrantsPage - 1"
            >{{ t('settings.common.prevPage') }}</Button>
            <span class="muted small">{{ safeGrantsPage + 1 }} / {{ totalGrantPages }}</span>
            <Button
              variant="ghost"

              :disabled="safeGrantsPage >= totalGrantPages - 1"
              @click="grantsPage = safeGrantsPage + 1"
            >{{ t('settings.common.nextPage') }}</Button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
}

.page-subtitle {
  margin-top: -8px;
  margin-bottom: 16px;
}

/* R59+: banner 统一 30px 档, 跟 Button.vue 默认 + tab-btn 同档 (用户反馈
   「新建项目 26, 其他按钮 30」不齐). 之前 30px (4px 10px / 12px) 比 30px
   avatar/icon 按钮矮 4px, 现在 height:30px 跟全系统齐. */
.admin-shortcut-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  height: 30px;
  margin-bottom: 16px;
  background: linear-gradient(90deg, var(--tw-blue-50) 0%, var(--tw-sky-50) 100%);
  border: 1px solid var(--tw-blue-300);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;
  user-select: none;
  box-sizing: border-box;
}
.admin-shortcut-banner:hover {
  background: linear-gradient(90deg, var(--tw-blue-100) 0%, var(--tw-sky-100) 100%);
  border-color: var(--tw-blue-500);
}
.admin-shortcut-banner:active { transform: translateY(1px); }
.admin-shortcut-banner:focus-visible {
  outline: 2px solid var(--tw-blue-600);
  outline-offset: 2px;
}
.banner-icon { font-size: 14px; }
.banner-text { flex: 1; font-size: 12px; color: var(--tw-blue-800); }
.banner-text strong { color: var(--tw-blue-900); }
.banner-cta {
  font-size: 18px;
  color: var(--tw-blue-600);
  font-weight: 700;
}

/* --- Tabs --- */
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--tw-gray-200);
  margin-bottom: 16px;
}
/* R59+: tab-btn 统一 30px 档 — 跟 Button.vue 默认 + 顶部 30×30 头像/图标按钮
   (AccountSwitcher .avatar-btn / TaskHeader .icon-btn) 同档 (用户反馈
   「新建项目 26, 其他按钮 30」不齐). 之前 8px 16px / 14px ~36-40px 高
   (R59+ 也调到 30px 4×10/12px), 现在 30px 跟全系统齐. */
.tab-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  height: 30px;
  box-sizing: border-box;
  color: var(--tw-gray-500);
  transition: all 0.15s;
}
.tab-btn:hover { color: var(--tw-gray-900); }
.tab-btn.active {
  color: var(--tw-blue-600);
  border-bottom-color: var(--tw-blue-600);
}

.tab-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-card {
  margin-bottom: 0;
  padding: 16px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.section-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.kv-block {
  border-bottom: 1px solid var(--tw-gray-200);
  padding-bottom: 12px;
}
.kv-block:last-child { border-bottom: none; padding-bottom: 0; }

.kv-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 14px;
  /* R59+: 改 flex-start — 之前 center 在 .kv-val 多行内容 (e.g. 角色行 role-chip +
     badge 「已授权平台 LLM」 窄屏换行) 时, kv-key 被垂直居中「漂浮」在两行中间,
     跟 .kv-val 第一行 (role-chip) 不齐, 视觉错位. 改 flex-start 让 kv-key 永远
     跟 .kv-val 第一行顶部对齐. 文本单行行高 ≈ 21px, padding 4px 0, 单行行视觉
     上 flex-start vs center 几乎看不出差 (visible glyph 位置相同, 都是 top+3.5px
     leading), 不破坏现有文本行观感. */
  align-items: flex-start;
}

.kv-key {
  width: 180px;
  color: var(--tw-gray-500);
  flex-shrink: 0;
  padding-top: 2px;  /* 跟 14px 文本对齐 baseline 微调 */
}

.kv-val {
  flex: 1;
  color: var(--tw-gray-900);
  display: flex;
  /* R59+: wrap 让窄屏 role-chip + badge 装不下时 badge 自动换行到下一行 (从左边
     开始, 满足用户「已授权平台LLM 那一行可以左一点, 现在出去了」 — 之前 nowrap
     + flex-shrink:0 让 badge 强行撑宽 kv-val, 容器右边出去. wrap 让 badge 乖乖
     换行, 不溢出. 宽屏够宽, role-chip + badge 一行装下, wrap 不触发, 视觉不变). */
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.kv-hint {
  margin: 6px 0 0 192px;
  font-size: 12px;
  color: var(--tw-gray-400);
}

.form-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--tw-gray-700);
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.form-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--tw-gray-400);
}

.form-aside {
  font-size: 12px;
  color: var(--tw-gray-500);
  margin-top: 2px;
}

.form-error {
  color: var(--tw-red-600);
  font-size: 12px;
  margin-top: 2px;
}

.form-actions {
  display: flex;
  gap: 8px;
}

.form-textarea {
  padding: 6px 10px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 4px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--color-bg-elevated);
  resize: vertical;
  min-height: 60px;
}
.form-textarea:focus {
  outline: none;
  border-color: var(--tw-blue-600);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

/* --- R56-B5 维护模式上次记录 --- */
.maint-last {
  background: var(--tw-gray-50);
  border: 1px solid var(--tw-gray-200);
  border-radius: 4px;
  padding: 8px 12px;
  margin: 8px 0;
}
.maint-result-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 9999px;
  font-weight: 600;
}
.maint-result-failed { background: var(--tw-red-100); color: var(--tw-red-800); }
.maint-result-aborted { background: var(--tw-orange-200); color: var(--tw-orange-800); }
.maint-result-ok { background: var(--tw-emerald-100); color: var(--tw-emerald-700); }

.flex-row { display: flex; align-items: center; }
.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.flex-1 { flex: 1; }
.min-w-0 { min-width: 0; }
.break-all { word-break: break-all; }
.cursor-pointer { cursor: pointer; }
.text-center { text-align: center; }
.font-medium { font-weight: 500; }
.py-3 { padding-top: 12px; padding-bottom: 12px; }
.mb-1 { margin-bottom: 4px; }
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-locked {
  font-style: italic;
  color: var(--tw-gray-400);
}

.muted { color: var(--tw-gray-500); }
.small { font-size: 12px; }

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.ok { background: var(--tw-emerald-500-solid); }
.status-dot.warn { background: var(--tw-amber-500-solid); }
.status-dot.fail { background: var(--tw-red-500-solid); }

.role-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.role-chip.admin {
  background: var(--tw-blue-100);
  color: var(--tw-blue-800);
}
.role-chip.user {
  background: var(--tw-gray-100);
  color: var(--tw-gray-600);
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  /* R59+: H5 flex 排不下时 .badge 被 flex-shrink:1 (默认) 压窄, 中文 text 按字宽
     断行变多行 (用户反馈「已授权平台LLM 换行导致变高」: .kv-val 里 .role-chip +
     .badge-info 「已授权平台LLM」 共占一行, badge 被挤窄 → 中文按字宽断行 →
     .kv-row 高度被撑高). nowrap + flex-shrink:0 保不被压 + 保不换行. */
  flex-shrink: 0;
  white-space: nowrap;
}
.badge-info { background: var(--tw-blue-100); color: var(--tw-blue-800); }
.badge-ok { background: var(--tw-emerald-100); color: var(--tw-emerald-700); }
.badge-warn { background: var(--tw-orange-200); color: var(--tw-orange-800); }

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

.seg-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.seg-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.seg-dash {
  color: var(--tw-gray-400);
}
.seg-readonly {
  display: inline-block;
  padding: 2px 6px;
  background: var(--tw-gray-100);
  border-radius: 4px;
  margin-right: 6px;
}

.form-input-sm { max-width: 200px; }
.form-input-md { max-width: 320px; }
.form-input-xs { max-width: 100px; }

/* 提示音事件列表 */
.event-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--tw-gray-100);
  border-radius: 4px;
}
.event-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 8px 12px;
  border-top: 1px solid var(--tw-gray-100);
}
.event-row:first-child { border-top: none; }
.event-meta { flex: 1; }
.event-label { font-size: 13px; color: var(--tw-gray-900); }
.event-desc { margin-top: 2px; }

/* 维护模式激活时的强调 */
.maint-active { border-color: var(--tw-amber-400) !important; background: var(--tw-amber-50); }

/* 提示框 */
.warn-box {
  background: var(--tw-amber-50);
  border: 1px solid var(--tw-amber-400);
  color: var(--tw-amber-800);
  padding: 8px 12px;
  border-radius: 4px;
}
.warn-text { color: var(--tw-amber-700); }
.success-box {
  background: var(--tw-green-50);
  border: 1px solid var(--tw-green-300);
  color: var(--tw-green-800);
  padding: 8px 12px;
  border-radius: 4px;
}
.message-box {
  color: var(--tw-gray-700);
  margin-top: 4px;
}

/* 账号配额 R50.1 B309 */
.quota-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}
.quota-row {
  border: 1px solid var(--tw-gray-200);
  border-radius: 6px;
  padding: 12px;
  background: var(--tw-gray-50);
}
.quota-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.quota-user-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.quota-user-meta .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.party-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
  width: 36px;
  height: 20px;
}
/* R59+: 隐藏 Checkbox 组件自带的 .cb-box (16×16 复选框框) — 我们用 .party-toggle-track
   胶囊当唯一可见 toggle. Checkbox 内部 .cb-native (绝对定位 + 1px + clip 隐藏)
   保留给 a11y / 键盘 / 屏幕阅读. cb-wrap 变成空 inline-flex 容器, 0×0 不占空间,
   旁边只剩下 track 36×20. */
.party-toggle .cb-box { display: none; }
.party-toggle-track {
  position: absolute;
  inset: 0;
  background: var(--tw-gray-200);
  border-radius: 999px;
  transition: background 0.15s;
}
.party-toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--color-bg-elevated);
  border-radius: 50%;
  transition: transform 0.15s;
}
/* R59+: 用 :has() 代替原来的 input:checked + .party-toggle-track.
   Checkbox 组件渲染 <label.cb-wrap><input.cb-native /><span.cb-box /></label>,
   input 不是 .party-toggle-track 的直接兄弟 (cb-box / cb-wrap 在中间), 原 CSS
   选择器永远不匹配 → 轨道永远不变色 (checked 时不变橙) + cb-box 16×16 复选框
   跟 party-toggle-track 36×20 胶囊同时显示 (用户原话「变成了两?」).
   :has() 看整个 .party-toggle 子孙树里有 checked / disabled input, 不依赖
   DOM 顺序, 把 Checkbox 组件当黑盒用. 浏览器支持: Chromium 105+ / Safari 15.4+
   / Firefox 121+, 跟现有 scope 兼容 (2024+ 浏览器都已支持). */
.party-toggle:has(input:checked) .party-toggle-track { background: var(--tw-amber-500-solid); }
.party-toggle:has(input:checked) .party-toggle-track::after { transform: translateX(16px); }
.party-toggle:has(input:disabled) .party-toggle-track { opacity: 0.5; }

.quota-progress {
  margin-bottom: 8px;
}
.quota-progress-meta {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}
.quota-progress-bar {
  width: 100%;
  height: 8px;
  background: var(--tw-gray-200);
  border-radius: 999px;
  overflow: hidden;
}
.quota-progress-fill {
  height: 100%;
  transition: width 0.2s;
}
.quota-progress-fill.info { background: var(--tw-blue-500-solid); }
.quota-progress-fill.warn { background: var(--tw-amber-500-solid); }
.quota-progress-fill.fail { background: var(--tw-red-500-solid); }
.quota-progress-fill.muted { background: var(--tw-gray-300); }

.quota-fields {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
@media (min-width: 768px) {
  .quota-fields { grid-template-columns: repeat(3, 1fr); }
}
.quota-fields .form-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--tw-gray-500);
}
.quota-row-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.link-btn {
  background: transparent;
  border: none;
  color: var(--tw-blue-600);
  cursor: pointer;
  padding: 0;
}
.link-btn:hover { text-decoration: underline; }
.link-btn.small { font-size: 12px; }
.link-btn-danger { color: var(--tw-red-700); }
.link-btn-danger:hover { color: var(--tw-red-800); }

/* R55.8 (B307) — 平台 LLM admin 表格 */
.admin-llm-table {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
}
.admin-llm-head,
.admin-llm-row {
  display: grid;
  /* R239: 加第 5 列「系数」(名称/URL/Model/Key/系数/默认/操作) */
  grid-template-columns: 1.2fr 1.4fr 1.4fr 1.1fr 0.5fr 0.9fr 1.6fr;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
}
.admin-llm-head {
  color: var(--tw-gray-500);
  font-size: 12px;
  border-bottom: 1px solid var(--tw-gray-200);
}
.admin-llm-row {
  border-bottom: 1px solid var(--tw-gray-100);
}
.admin-llm-row:last-child { border-bottom: none; }
.admin-llm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.admin-llm-form { margin-top: 8px; }
.admin-llm-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.small-section { margin: 0; font-size: 13px; font-weight: 500; color: var(--tw-gray-700); }
.admin-llm-form .form-label { margin-top: 6px; }
.text-warn { color: var(--tw-red-600); }
.text-ok { color: var(--tw-emerald-600); }
.bg-gray {
  background: var(--tw-gray-100);
  padding: 1px 6px;
  border-radius: 3px;
}
.ta-right { text-align: right; }
.max-w-\[150px\] { max-width: 150px; }
.max-w-\[160px\] { max-width: 160px; }
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}
.center { text-align: center; }

/* R55.9 (B308) — 用户授权 grants 表格 */
.grants-table {
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
  /* R59+: 窄屏 (H5) 长 email 默认按 min-content 撑大 .grants-user 列 (grid
     auto 最小值 = min-content) → input 列被挤窄换行覆盖「并发上限」, email
     列也截不全 (用户原话「输入框还是原来的长度, 就盖到 并发上限这一列上了」
     + 「用户列也看不完整」). minmax(0, 1fr) 关掉自动撑, 容器 overflow-x: auto
     兜底横向滚. */
  overflow-x: auto;
}
.grants-head,
.grants-row {
  display: grid;
  grid-template-columns: minmax(140px, 1.5fr) minmax(80px, 1fr) minmax(80px, 1fr);
  gap: 12px;
  align-items: center;
  padding: 4px 8px;
  font-size: 13px;
}
.grants-head {
  color: var(--tw-gray-500);
  font-size: 12px;
  border-bottom: 1px solid var(--tw-gray-200);
}
.grants-row {
  border-bottom: 1px solid var(--tw-gray-100);
}
.grants-row:last-of-type { border-bottom: none; }
.grants-user {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
.grants-user .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grants-input {
  display: flex;
  align-items: center;
  gap: 6px;
}
.grant-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  width: 36px;
  height: 20px;
}
/* R59+: 跟 .party-toggle 同根问题 — 隐藏 Checkbox 自带的 .cb-box (grant-toggle
   这边因为 track 是 position:absolute 盖住 cb-box, 视觉上不像 party-toggle 那样
   看到「两个 toggle」, 但 :checked + .grant-toggle-track 选择器还是不匹配 →
   点了之后轨道永远不变蓝 (checked state 视觉反馈丢了). 修法: 同样隐藏 cb-box
   + 用 :has() 检 checked / disabled. */
.grant-toggle .cb-box { display: none; }
.grant-toggle-track {
  position: absolute;
  inset: 0;
  background: var(--tw-gray-300);
  border-radius: 999px;
  transition: background 0.15s;
}
.grant-toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  /* theme-ok: 开关把手, 两主题都需浅色才在 track 上可见 */
  background: white;
  border-radius: 50%;
  transition: transform 0.15s;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.grant-toggle:has(input:checked) .grant-toggle-track {
  background: var(--tw-blue-600-solid);
}
.grant-toggle:has(input:checked) .grant-toggle-track::after {
  transform: translateX(16px);
}
.grant-toggle:has(input:disabled) .grant-toggle-track {
  opacity: 0.5;
  cursor: not-allowed;
}
.grants-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 8px;
}
.quota-log {
  margin-top: 8px;
  border-top: 1px solid var(--tw-gray-200);
  padding-top: 8px;
}
.quota-log-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  padding: 0;
  margin: 0;
}

/* 个人 LLM 配置 R50.3 B301 */
/* R175 fallback 链点选 chips — 点击加入/移除, active 显示序号 */
.llm-fallback-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
/* R239: 单价三联输入 (输入价/输出价/缓存读价) */
.llm-price-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 6px;
}
.llm-chip {
  padding: 3px 10px;
  border: 1px solid var(--tw-gray-300);
  border-radius: 999px;
  background: var(--tw-gray-50);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.llm-chip:hover {
  border-color: var(--tw-blue-600);
}
.llm-chip.active {
  background: var(--tw-blue-600-solid);
  border-color: var(--tw-blue-600);
  color: #fff;
}
.llm-table-wrap {
  margin-top: 8px;
  border: 1px solid var(--tw-gray-200);
  border-radius: 6px;
  overflow-x: auto;
}
.llm-table {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
}
.llm-table th,
.llm-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--tw-gray-100);
}
.llm-table th {
  font-size: 11px;
  font-weight: 600;
  color: var(--tw-gray-500);
  background: var(--tw-gray-50);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.llm-table tr:last-child td { border-bottom: none; }
.llm-table .text-right { text-align: right; }
.truncate-cell {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: middle;
}
.nowrap { white-space: nowrap; }
.key-chip {
  background: var(--tw-gray-100);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
}
.link-btn.danger { color: var(--tw-red-600); }
.link-btn.danger:hover { color: var(--tw-red-800); text-decoration: underline; }
.text-warn { color: var(--tw-red-600); }
.text-info { color: var(--tw-blue-600); }

.llm-form-section {
  border-top: 1px solid var(--tw-gray-200);
  margin-top: 12px;
  padding-top: 12px;
}
.llm-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.llm-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.inline-clear-row {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  color: var(--tw-gray-500);
}

.llm-available {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--tw-gray-200);
}
.llm-available-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-top: 8px;
}
@media (min-width: 768px) {
  .llm-available-grid { grid-template-columns: repeat(2, 1fr); }
}
.llm-available-row {
  border: 1px solid var(--tw-gray-200);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--tw-gray-50);
}

/* API Token 列表 */
.token-list-wrap {
  border: 1px solid var(--tw-gray-200);
  border-radius: 4px;
}
.token-toolbar {
  padding: 8px 12px;
  border-bottom: 1px solid var(--tw-gray-200);
  background: var(--tw-gray-50);
  flex-wrap: wrap;
}
.token-list {
  max-height: 400px;
  overflow-y: auto;
}
.token-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid var(--tw-gray-100);
}
.token-row:last-child { border-bottom: none; }
.token-row.selected { background: var(--tw-blue-50); }
.token-row:hover { background: var(--tw-gray-50); }
</style>