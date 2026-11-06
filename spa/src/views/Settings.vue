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
  { value: '', label: '手动填写（自定义中转 / Anthropic 官方）' },
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
    configError.value = isHttpError(e) ? e.message : '加载失败';
  } finally {
    configLoading.value = false;
    configRetrying.value = false;
  }
}

function serializePortPool(): { ok: true; value: number[][] } | { ok: false; error: string } {
  const c = config.value;
  if (!c) return { ok: false, error: '尚未加载配置' };
  if (appForm.portPoolSegments.length === 0) {
    return { ok: false, error: '端口池至少 1 段' };
  }
  if (appForm.portPoolSegments.length > c.port_pool_max_segments) {
    return { ok: false, error: `端口池最多 ${c.port_pool_max_segments} 段, 当前 ${appForm.portPoolSegments.length}` };
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
      return { ok: false, error: `端口池第 ${i + 1} 段非法: 需 ${portLo}-${portHi} 整数且 start≤end` };
    }
    out.push([s, e]);
  }
  return { ok: true, value: out };
}

function addPortPoolSegment() {
  if (!config.value) return;
  if (appForm.portPoolSegments.length >= config.value.port_pool_max_segments) {
    toast.warn(`端口段最多 ${config.value.port_pool_max_segments} 段`);
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
    appFieldErrors.concurrency = `并发数需在 ${c.concurrency_min} - ${c.concurrency_max}`;
    return;
  }
  const taskTimeout = Number(taskTimeoutStr);
  if (taskTimeoutStr === '' || !Number.isInteger(taskTimeout)
    || taskTimeout < c.task_timeout_min || taskTimeout > c.task_timeout_max) {
    appFieldErrors.task_timeout_minutes = `超时需在 ${c.task_timeout_min} - ${c.task_timeout_max} 分钟`;
    return;
  }
  if (portPool === null || portPool.ok === false) {
    appFieldErrors.port_pool = portPool === null
      ? '端口段格式不合法 (每段 start ≤ end 且为整数)'
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
    toast.success('应用配置已保存');
  } catch (e) {
    if (isHttpError(e)) {
      const fe = e.fieldErrors;
      if (fe) {
        for (const [k, v] of Object.entries(fe)) {
          appFieldErrors[k] = v;
        }
      } else if (e.status === 403) {
        toast.error('需要管理员权限');
      } else {
        toast.error(e.message);
      }
    } else {
      toast.error('保存失败');
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
    profileError.value = isHttpError(e) ? e.message : '加载失败';
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
    toast.success(enabled ? '已开启 preflight 自检' : '已关闭 preflight 自检');
  } catch (e) {
    profileForm.preflight_enabled = prev;
    toast.error(getErrorMsg(e, '保存失败'));
  } finally {
    preflightSaving.value = false;
  }
}

async function saveNotifyEmail() {
  const trimmed = profileForm.notify_email.trim();
  if (!isValidEmail(trimmed)) {
    toast.error('邮箱格式不正确');
    return;
  }
  notifySaving.value = true;
  try {
    const updated = await updateMyProfile({ notify_email: trimmed || null });
    profile.value = updated;
    hydrateProfileForm(updated);
    toast.success(trimmed ? `已保存, 通知将发往 ${trimmed}` : '已清空, 通知发往系统邮箱');
  } catch (e) {
    toast.error(getErrorMsg(e, '保存失败'));
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
    toast.error('git 用户名不能含 < > 或换行');
    return;
  }
  if (!isValidEmail(trimmedEmail)) {
    toast.error('git 邮箱格式不正确');
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
    toast.success(`已保存, 此后 agent 提交将署名 ${effectiveName} <${effectiveEmail}>`);
  } catch (e) {
    toast.error(getErrorMsg(e, '保存失败'));
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
    toast.error('昵称不能含换行');
    return;
  }
  if (trimmedBio.length > 2000) {
    toast.error('自我介绍过长 (≤2000 字符)');
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
    toast.success(`已保存, agent 将称呼你「${updated.nickname || '用户'}」`);
  } catch (e) {
    toast.error(getErrorMsg(e, '保存失败'));
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
      notifyMessage.value = `已发送到 ${res.to}${res.using_fallback ? ' (系统兜底邮箱)' : ''}, 请查收。SMTP 响应: ${res.response || '已接受'}`;
    } else {
      notifyMessage.value = `未发送: ${res.reason || '未知原因'}`;
    }
  } catch (e) {
    notifyMessage.value = `发送失败: ${getErrorMsg(e, '')}`;
  } finally {
    notifyTesting.value = false;
  }
}

async function saveFeishuWebhook() {
  const trimmed = profileForm.feishu_webhook_url.trim();
  if (!isValidFeishuWebhook(trimmed)) {
    toast.error('Webhook URL 不合法 (需以 https://open.feishu.cn/hook/ 开头)');
    return;
  }
  feishuSaving.value = true;
  try {
    const updated = await updateMyProfile({ feishu_webhook_url: trimmed || null });
    profile.value = updated;
    hydrateProfileForm(updated);
    toast.success(trimmed ? '已保存飞书 webhook' : '已清空飞书 webhook');
  } catch (e) {
    toast.error(getErrorMsg(e, '保存失败'));
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
        feishuWebhookMessage.value = 'post.content JSON 解析失败, 请检查 textarea —— 用 [[{tag,text},{tag:"a",text,href},...],...] 二维数组格式';
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
      feishuWebhookMessage.value = `已发送到 ${res.masked_url || '飞书群'}, 请查收。HTTP 状态: ${res.status || '已接受'}`;
    } else {
      feishuWebhookMessage.value = `未发送: ${res.reason || '未知原因'}`;
    }
  } catch (e) {
    feishuWebhookMessage.value = `发送失败: ${getErrorMsg(e, '')}`;
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

const SOUND_EVENT_OPTIONS: { key: SoundEventKey; label: string; desc: string }[] = [
  { key: 'tool_approval', label: '工具审批', desc: 'agent 请求工具权限时' },
  { key: 'user_dialog', label: '用户对话', desc: 'agent 向你提问时' },
  { key: 'reviewing', label: '进入 review', desc: '任务进入评审态时' },
  { key: 'failed', label: '失败', desc: '任务失败时' },
  { key: 'paused', label: '挂起 (自动)', desc: 'agent 自动暂停任务时' },
  { key: 'queued', label: '排队', desc: '任务进入排队时' },
  { key: 'cancelled', label: '取消', desc: '任务被取消时' },
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
    toast.error('复制失败, 请手动选中');
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
    apiTokensError.value = isHttpError(e) ? e.message : '加载失败';
  } finally {
    apiTokensLoading.value = false;
  }
}

async function handleCreateApiToken() {
  const name = newTokenName.value.trim();
  if (!name) {
    tokenMessage.value = '请输入 Token 名称';
    return;
  }
  tokenSaving.value = true;
  tokenMessage.value = null;
  try {
    const res = await post<{ token: string; id: string }>('/api/api-tokens', { name });
    createdToken.value = res.token;
    newTokenName.value = '';
    await loadApiTokens();
    tokenMessage.value = '✅ Token 已创建 (明文仅显示一次)';
  } catch (e) {
    tokenMessage.value = isHttpError(e) ? e.message : '创建失败';
  } finally {
    tokenSaving.value = false;
  }
}

async function handleDeleteApiToken(id: string, name: string) {
  if (!confirm(`确定删除 Token「${name}」？删除后 JWT 在轮换 JWT_SECRET 前仍有效。`)) return;
  tokenSaving.value = true;
  tokenMessage.value = null;
  try {
    await del(`/api/api-tokens/${id}`);
    await loadApiTokens();
    selectedTokenIds.value.delete(id);
    tokenMessage.value = '✅ 已删除';
  } catch (e) {
    tokenMessage.value = isHttpError(e) ? e.message : '删除失败';
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
    ? `确定批量删除 ${targetIds.length} 个 token？其中包含 switch-account（删除后下次登录会自动重建）。`
    : `确定批量删除 ${targetIds.length} 个 token？`;
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
    tokenMessage.value = `✅ 已删除 ${res.deleted} / ${res.requested}`;
  } catch (e) {
    tokenMessage.value = isHttpError(e) ? e.message : '批量删除失败';
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
    mediaMessage.value = isHttpError(e) ? e.message : '加载失败';
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
    mediaMessage.value = '✅ 已保存';
    mediaKeyInput.value = '';
    showMediaKeyInput.value = false;
    await loadMediaKey();
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : '保存失败';
  } finally {
    mediaSaving.value = false;
  }
}

async function handleClearMediaKey() {
  if (!confirm('确定清除多模态 API Key？')) return;
  mediaSaving.value = true;
  try {
    /* 后端 route 只导 GET/PUT/DELETE, 没有 POST — 用 put (R56-B5 修复) */
    await put('/api/user/media-key', { clear_api_key: true, region: regionInput.value });
    mediaMessage.value = '✅ 已清除';
    await loadMediaKey();
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : '清除失败';
  } finally {
    mediaSaving.value = false;
  }
}

/** 「删除全部」 — 镜像 master line 2586-2594.
   关注点: 与「清除」不同, 删除会清掉整条 user_media_keys 记录 + 清 mmx 配置目录,
   后续 agent 进程拿不到 media key. 仅在用户明确想彻底下掉时用. */
async function handleDeleteMediaKey() {
  if (!confirm('确定删除多模态 API Key 配置？删除后 agent 任务中将无法使用 mmx-cli 生成图片/视频/音乐。')) return;
  mediaSaving.value = true;
  mediaMessage.value = null;
  try {
    await del('/api/user/media-key');
    mediaMessage.value = '✅ 多模态 API Key 已删除';
    await loadMediaKey();
    mediaKeyInput.value = '';
    showMediaKeyInput.value = false;
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : '删除失败';
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
    mediaMessage.value = res.ok ? `✅ ${res.quota ?? '通过'}` : `❌ ${res.error ?? '失败'}`;
  } catch (e) {
    mediaMessage.value = isHttpError(e) ? e.message : '测试失败';
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
      maintenanceError.value = isHttpError(e) ? e.message : '加载失败';
    }
  } finally {
    maintenanceLoading.value = false;
  }
}

async function handleEnterMaintenance() {
  const reason = prompt('进入维护模式的原因（可选）:');
  if (reason === null) return;
  try {
    await post('/api/admin/maintenance/enter', { reason: reason || null });
    await loadMaintenance();
    toast.success('已进入维护模式');
  } catch (e) {
    toast.error(getErrorMsg(e, '进入维护模式失败'));
  }
}

async function handleExitMaintenance() {
  if (!confirm('确定退出维护模式？挂起的任务将自动恢复。')) return;
  try {
    await post('/api/admin/maintenance/exit');
    await loadMaintenance();
    toast.success('已退出维护模式');
  } catch (e) {
    toast.error(getErrorMsg(e, '退出维护模式失败'));
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
      quotaMessage.value = getErrorMsg(e, '加载账号配额失败');
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
    quotaMessage.value = `❌ 拉变更历史失败: ${getErrorMsg(e, '')}`;
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
    quotaMessage.value = `✅ 已更新 ${userId.slice(0, 8)} 的配额`;
    await loadQuotaUsers();
  } catch (e) {
    quotaMessage.value = `❌ ${getErrorMsg(e, '保存失败')}`;
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
    quotaMessage.value = `❌ 日期格式不对: ${next}`;
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
/** R175: 视觉能力三态下拉选项 (Select 组件 value 是 string) */
const visionSelectOptions = [
  { value: 'unset', label: '未设置（按模型名推断）' },
  { value: 'yes', label: '👁 支持视觉' },
  { value: 'no', label: '🚫 不支持视觉' },
];
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
  if (baselineId && cfg.id === baselineId) return '基准 ×1';
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
    llmMessage.value = getErrorMsg(e, '加载 LLM 配置失败');
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
      llmMessage.value = '无正在编辑的配置';
      llmSaving.value = false;
      return;
    }
    llmMessage.value = '✅ 已保存';
    cancelEditLlm();
    await loadLlmConfigs();
  } catch (e) {
    llmMessage.value = isHttpError(e) ? e.message : '保存失败';
  } finally {
    llmSaving.value = false;
  }
}

async function handleDuplicateLlmConfig(id: string, name: string) {
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    const data = await post<{ name?: string }>(`/api/user/llm-config/${id}/duplicate`, {});
    llmMessage.value = `✅ 已拷贝为「${data.name ?? name + ' - 拷贝'}」`;
    await loadLlmConfigs();
  } catch (e) {
    llmMessage.value = isHttpError(e) ? e.message : '拷贝失败';
  } finally {
    llmSaving.value = false;
  }
}

async function handleCopyLlmConfigText(cfg: LlmConfigSafe) {
  const lines = [
    `名称: ${cfg.name}`,
    `Base URL: ${cfg.base_url || '(默认)'}`,
    `Model: ${cfg.model || '(默认)'}`,
    `API Key: ${cfg.has_api_key ? cfg.api_key_masked : '(未配)'}`,
    `类型: ${cfg.type}`,
    `单价: ${cfg.price_in ?? '—'} / ${cfg.price_out ?? '—'} / ${cfg.price_cache_read ?? '—'} USD每百万token (入/出/缓存读)`,
    cfg.is_default ? '状态: 默认' : '状态: 普通',
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    llmMessage.value = `✅ 已复制「${cfg.name}」到剪贴板`;
  } catch (err) {
    llmMessage.value = `❌ 复制失败: ${(err as Error).message}`;
  }
}

async function handleSetLlmDefault(id: string) {
  llmSaving.value = true;
  llmMessage.value = null;
  try {
    await post(`/api/user/llm-config/${id}/default`, {});
    llmMessage.value = '✅ 已设为默认';
    await loadLlmConfigs();
  } catch (e) {
    llmMessage.value = isHttpError(e) ? e.message : '设置失败';
  } finally {
    llmSaving.value = false;
  }
}

function handleDeleteLlmConfig(id: string, name: string) {
  if (!confirm(`确定删除「${name}」？删除后回落到平台默认 LLM 配置。`)) return;
  void (async () => {
    llmSaving.value = true;
    llmMessage.value = null;
    try {
      await del(`/api/user/llm-config/${id}`);
      llmMessage.value = '✅ 已删除';
      await loadLlmConfigs();
    } catch (e) {
      llmMessage.value = isHttpError(e) ? e.message : '删除失败';
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
    toast.success(id ? '已设为成本基准' : '已清除成本基准');
    await loadAdminLlm();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, '设置成本基准失败'));
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
    adminLlmMessage.value = isHttpError(e) ? e.message : '加载失败';
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
    adminLlmMessage.value = '✅ 已保存';
    editingAdminLlmId.value = null;
    await loadAdminLlm();
  } catch (e: unknown) {
    adminLlmMessage.value = getErrorMsg(e, '保存失败');
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
    adminLlmMessage.value = getErrorMsg(e, '设为默认失败');
  } finally {
    adminLlmSaving.value = false;
  }
}

async function handleAdminLlmDuplicate(id: string, name: string): Promise<void> {
  adminLlmSaving.value = true;
  try {
    await post(`/api/admin/llm-config/${id}/duplicate`);
    toast.success(`已拷贝「${name}」`);
    await loadAdminLlm();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, '拷贝失败'));
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
    toast.success('已复制到剪贴板');
  } catch {
    toast.error('复制失败 (浏览器权限?)');
  }
}

async function handleAdminLlmDelete(id: string, name: string): Promise<void> {
  if (!confirm(`确认删除平台 LLM 配置「${name}」?`)) return;
  adminLlmSaving.value = true;
  try {
    await del(`/api/admin/llm-config/${id}`);
    toast.success(`已删除「${name}」`);
    await loadAdminLlm();
  } catch (e: unknown) {
    toast.error(getErrorMsg(e, '删除失败'));
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
    grantsMessage.value = isHttpError(e) ? e.message : '加载失败';
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
    toast.error(getErrorMsg(e, '授权切换失败'));
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
      toast.error('并发上限需为 1-10 整数, 留空不限');
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
    toast.error(getErrorMsg(e, '保存失败'));
  }
}
</script>

<template>
  <div class="settings-page">
    <h1 class="page-title">设置</h1>
    <p class="muted small page-subtitle">
      通用设置 — 账户 / 通知 / 调度 / 平台管理 (admin)
    </p>

    <!-- Tab 导航 -->
    <div class="tabs">
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'account' }"
        @click="activeTab = 'account'"
      >账户</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'notify' }"
        @click="activeTab = 'notify'"
      >通知</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'schedule' }"
        @click="activeTab = 'schedule'"
      >调度</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'roles' }"
        @click="activeTab = 'roles'"
      >角色</button>
      <button
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'channels' }"
        @click="activeTab = 'channels'"
      >渠道</button>
      <button
        v-if="showPlatformTab"
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === 'platform' }"
        @click="activeTab = 'platform'"
      >平台管理</button>
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
        你是管理员，平台 LLM 配置 / 用户授权 / 账号配额 在
        <strong>「平台管理」</strong> tab 里
      </span>
      <span class="banner-cta">→</span>
    </div>

    <!-- ============================================================== -->
    <!--  Tab: 账户 (account)                                              -->
    <!-- ============================================================== -->
    <div v-show="activeTab === 'account'" class="tab-panel">
      <!-- 身份 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">👤 身份</h2>
        </div>

        <Loading v-if="profileLoading && !profile" label="加载账号信息…" />
        <ErrorView
          v-else-if="profileError"
          variant="error"
          title="加载账号信息失败"
          :description="profileError"
          :retrying="profileRetrying"
          @retry="loadProfile(true)"
        />
        <Empty v-else-if="!profile" variant="doc" title="暂无账号信息" />

        <div v-else class="kv-block">
          <div class="kv-row">
            <span class="kv-key">邮箱</span>
            <span class="kv-val mono">{{ profile.email }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">角色</span>
            <span class="kv-val">
              <span
                class="role-chip"
                :class="profile.role === 'admin' ? 'admin' : 'user'"
              >{{ profile.role }}</span>
              <span v-if="profile.admin_llm_granted" class="badge badge-info small">
                已授权平台 LLM
              </span>
            </span>
          </div>
        </div>
      </section>

      <!-- 用户身份: 昵称 + 自我介绍 (v518, 飞书 R222) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🪪 用户身份（agent 视角）</h2>
          <span class="badge badge-info">账号级 · 注入此后所有任务的 agent 上下文</span>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-nickname" class="form-label">
              昵称
              <span class="form-hint">(留空 = agent 称呼「用户」)</span>
            </label>
            <Input
              id="user-nickname"
              v-model="profileForm.nickname"
              :disabled="profileSaving"
              placeholder="用户"
              class-name="form-input-md"
            />
          </div>
          <div class="form-row">
            <label for="user-bio" class="form-label">
              自我介绍
              <span class="form-hint">(留空 = 省略; 你是谁、喜好、忌讳等)</span>
            </label>
            <Textarea
              id="user-bio"
              v-model="profileForm.bio"
              :disabled="profileSaving"
              :rows="3"
              :maxlength="2000"
              show-count
              placeholder="例: 叫我老王; 偏好 terse 风格汇报; 讨论技术时直接给结论…"
            />
          </div>

          <p class="muted small form-aside">
            agent 每个任务会话开头会收到这段身份 (每会话一次, 不逐轮重复)。参考 OpenClaw
            USER.md 的「About Your Human」设计。不配置时 agent 默认称呼「用户」。
          </p>
          <div class="form-actions">
            <Button variant="primary" :loading="profileSaving" @click="saveUserProfile">
              保存用户身份
            </Button>
          </div>
        </div>
      </section>

      <!-- Preflight -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">⚡ 任务启动前自检 (Preflight)</h2>
        </div>

        <div v-if="profile" class="form-block">
          <Checkbox
            :model-value="profileForm.preflight_enabled"
            :disabled="preflightSaving"
            label="开启 preflight 自检 (推荐)"
            @update:model-value="savePreflight"
          />
          <p class="muted small form-aside">
            开启后, 任务启动前会先做环境检查 (git/Node/依赖), 减少失败率。
          </p>
        </div>
      </section>

      <!-- Git 提交身份 (v515, 飞书 R178) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🌿 Git 提交身份</h2>
          <span class="badge badge-info">账号级 · 影响此后所有任务的 git commit</span>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-git-name" class="form-label">
              用户名 (user.name)
              <span class="form-hint">(留空 = 邮箱前缀)</span>
            </label>
            <Input
              id="user-git-name"
              v-model="profileForm.git_name"
              :disabled="gitSaving"
              placeholder="(账号邮箱前缀)"
              class-name="form-input-md"
            />
          </div>
          <div class="form-row">
            <label for="user-git-email" class="form-label">
              邮箱 (user.email)
              <span class="form-hint">(留空 = 账号邮箱)</span>
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
                  ? `已自定义: ${(profile.git_name || (profile.git_email || profile.email).split('@')[0])} <${profile.git_email || profile.email}>`
                  : `默认: ${profile.email.split('@')[0]} <${profile.email}>`
              }}
            </span>
          </div>

          <p class="muted small form-aside">
            agent 子进程 git commit 的作者/提交者署名 (git log 可见)。通过环境变量注入,
            不改各仓库的 .git/config。留空回落默认 = 账号邮箱 + 邮箱前缀。
          </p>
          <div class="form-actions">
            <Button variant="primary" :loading="gitSaving" @click="saveGitIdentity">
              保存 Git 身份
            </Button>
          </div>
        </div>
      </section>

      <!-- 提示音设置 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🔔 提示音设置</h2>
          <span class="badge badge-info">仅当前浏览器生效 (localStorage)</span>
        </div>

        <div class="form-block">
          <div class="kv-row">
            <span class="kv-key">总开关</span>
            <span class="kv-val">
              <Checkbox
                :model-value="soundSettings.enabled"
                label="开启提示音"
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
                <div class="event-label">{{ opt.label }}</div>
                <div class="event-desc muted small">{{ opt.desc }}</div>
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
            >🔔 测试提示音</Button>
          </div>
        </div>
      </section>

      <!-- Fork 自动压缩阈值 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🔀 Fork 自动压缩阈值</h2>
          <span class="badge badge-info">仅当前浏览器生效</span>
        </div>

        <div class="form-block">
          <div class="form-row">
            <label class="form-label">
              阈值 (tokens)
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
              Fork 弹窗打开时, 若父任务上下文超过此值, 自动勾选「压缩后继续」。
              当前: {{ (forkThreshold / 1000).toFixed(0) }}k tokens (默认 {{ FORK_DEFAULT / 1000 }}k)
            </span>
          </div>
        </div>
      </section>

      <!-- 多模态 API Key (mmx-cli) -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🎨 多模态 API Key (mmx-cli)</h2>
        </div>

        <div class="form-block">
          <p class="muted small">
            用于在任务中调用 minimax 全模态平台 (mmx-cli) 生成图片/视频/音乐等。
            凭据加密存储于数据库, agent 进程下次启动即用。
          </p>

          <div
            v-if="mediaKey?.has_api_key && mediaKey.api_key_masked?.includes('解密失败')"
            class="warn-box small"
          >
            ⚠️ 已存的 key 解密失败 (通常因为 ENCRYPTION_KEY 变更)。请重新输入。
          </div>

          <div class="form-row">
            <label class="form-label">API Key</label>
            <div v-if="mediaKey?.has_api_key && !showMediaKeyInput" class="kv-row">
              <code class="mono small flex-1">{{ mediaKey.api_key_masked }}</code>
              <Button
                variant="ghost"
               
                @click="showMediaKeyInput = true"
              >更换</Button>
              <Button
                variant="danger"
               
                :disabled="mediaSaving"
                @click="handleClearMediaKey"
              >清除</Button>
            </div>
            <div v-else class="kv-row">
              <Input
                v-model="mediaKeyInput"
                type="password"
                class-name="form-input-md"
                placeholder="输入 minimax API Key"
              />
              <Button
                v-if="mediaKey?.has_api_key"
                variant="ghost"
               
                @click="showMediaKeyInput = false; mediaKeyInput = ''"
              >取消</Button>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">区域</label>
            <Select
              v-model="regionInput"
              :options="[
                { value: 'cn', label: 'cn (国内端点)' },
                { value: 'global', label: 'global (海外端点)' },
              ]"
            />
          </div>

          <div class="form-actions">
            <Button variant="primary" :loading="mediaSaving" @click="handleMediaKeySave">
              保存
            </Button>
            <Button
              v-if="mediaKey?.has_api_key"
              variant="secondary"
              :loading="mediaTesting"
              :disabled="mediaSaving"
              @click="handleTestMediaKey"
            >测试 (mmx quota)</Button>
            <Button
              v-if="mediaKey?.has_api_key"
              variant="danger"
              :disabled="mediaSaving"
              @click="handleDeleteMediaKey"
            >删除全部</Button>
          </div>
          <div v-if="mediaMessage" class="message-box small">{{ mediaMessage }}</div>
        </div>
      </section>

      <!-- API Token -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🔑 API Token</h2>
        </div>

        <div class="form-block">
          <p class="muted small">
            不过期的个人访问令牌。CLI / 脚本用 <code class="mono small">Authorization: Bearer &lt;token&gt;</code> 调用所有接口。
          </p>

          <!-- 已创建 token (明文仅显示一次) -->
          <div v-if="createdToken" class="success-box">
            <div class="small font-medium mb-1">Token 已创建 (仅显示一次, 请立即复制)</div>
            <div class="flex-row gap-2">
              <code class="mono small flex-1 break-all">{{ createdToken }}</code>
              <Button
                variant="ghost"
               
                @click="copyCreatedToken"
              >复制</Button>
              <Button
                variant="ghost"
               
                @click="createdToken = null"
              >关闭</Button>
            </div>
          </div>

          <!-- 创建 -->
          <div class="form-row">
            <label class="form-label">新建 Token</label>
            <div class="flex-row gap-2">
              <Input
                v-model="newTokenName"
                type="text"
                class-name="form-input-md"
                placeholder="名称 (如 CLI-local)"
                :disabled="tokenSaving"
              />
              <Button
                variant="primary"
                :loading="tokenSaving"
                @click="handleCreateApiToken"
              >创建 Token</Button>
            </div>
          </div>

          <!-- 列表 -->
          <Loading v-if="apiTokensLoading && apiTokens.length === 0" label="加载 Token…" />
          <Empty v-else-if="!apiTokensLoading && apiTokens.length === 0" variant="doc" title="暂无 API Token" />
          <div v-else class="token-list-wrap">
            <div class="token-toolbar flex-row gap-2">
              <label class="flex-row gap-1 small cursor-pointer">
                <Checkbox
                  :model-value="allFilteredSelected"
                  :disabled="filteredTokens.length === 0"
                  @update:model-value="toggleSelectAllFiltered"
                />
                <span>全选</span>
              </label>
              <Input
                v-model="tokenSearch"
                type="text"
                class-name="form-input-sm"
                placeholder="按名称搜索"
              />
              <Button
                variant="danger"
                :disabled="selectedTokenIds.size === 0 || tokenSaving"
                @click="handleBatchDeleteApiTokens"
              >
                批量删除 {{ selectedTokenIds.size > 0 ? `(${selectedTokenIds.size})` : '' }}
              </Button>
            </div>

            <div class="token-list">
              <div
                v-if="filteredTokens.length === 0"
                class="muted small text-center py-3"
              >无匹配 token</div>
              <div
                v-for="t in filteredTokens"
                :key="t.id"
                class="token-row"
                :class="{ selected: selectedTokenIds.has(t.id) }"
              >
                <div class="flex-row gap-2 min-w-0 flex-1">
                  <Checkbox
                    :model-value="selectedTokenIds.has(t.id)"
                    :disabled="tokenSaving"
                    @update:model-value="toggleSelectToken(t.id)"
                  />
                  <code class="mono small">{{ t.prefix }}…</code>
                  <span class="truncate">{{ t.name }}</span>
                </div>
                <Button
                  variant="danger"
                  :disabled="tokenSaving"
                  @click="handleDeleteApiToken(t.id, t.name)"
                >删除</Button>
              </div>
            </div>
          </div>

          <div v-if="tokenMessage" class="message-box small">{{ tokenMessage }}</div>

          <p class="muted small mono">
            curl -H "Authorization: Bearer &lt;token&gt;" https://&lt;host&gt;/api/projects
          </p>
          <p class="warn-text small">
            ⚠️ Token 不过期。删除仅清理记录, token 在服务端轮换密钥后才彻底失效。
          </p>
        </div>
      </section>

      <!-- 个人 LLM 配置 (R50.3 B301)
           镜像 master src/app/settings/page.tsx:2314-2500: 列表 + 编辑表单 +
           5 操作按钮 (设默认/编辑/拷贝/复制/删除) + 可见的 LLM 配置聚合块. -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🤖 个人 LLM 配置</h2>
          <span class="badge badge-warn small">至少 1 份</span>
        </div>

        <p class="muted small">
          可配置多份 LLM 配置（如生产 / 测试 / 火山方舟）。任务/模板从「可见的 LLM 配置」里选；列表里被授权的平台配置也会一起出现。
        </p>

        <div
          v-if="profile?.admin_llm_granted && !isAdmin"
          class="success-box small"
        >
          ✅ 你已被管理员授权使用平台 LLM 配置。授权收回后只能用自己的。
        </div>

        <!-- 列表 -->
        <div v-if="llmConfigs.length > 0" class="llm-table-wrap">
          <table class="llm-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>Base URL</th>
                <th>Model</th>
                <th>Key</th>
                <th title="相对平台设定的基准模型的成本系数（管理员在平台 LLM 配置里设基准；本配置配了单价才算得出）">系数</th>
                <th>默认</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="cfg in llmConfigs" :key="cfg.id">
                <td class="font-medium">
                  {{ cfg.name }}
                  <span
                    v-if="cfg.fallback_ids?.length"
                    class="badge small"
                    :title="`fallback 链: ${cfg.fallback_ids.map(llmCfgName).join(' → ')}`"
                  >⛓{{ cfg.fallback_ids.length }}</span>
                  <span
                    v-if="visionBadge(cfg.supports_vision)"
                    class="badge small"
                    :title="cfg.supports_vision ? '支持视觉（可读图）' : '不支持视觉（读图会白读）'"
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
                  <span v-else class="text-warn small">未配</span>
                </td>
                <td class="mono small" :title="`单价(入/出): ${cfg.price_in ?? '—'} / ${cfg.price_out ?? '—'} USD每百万token`">
                  {{ coefficientLabel(cfg, userCostBaselineId) }}
                </td>
                <td>
                  <span v-if="cfg.is_default" class="badge badge-info small">默认</span>
                  <button
                    v-else
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    @click="handleSetLlmDefault(cfg.id)"
                  >设为默认</button>
                </td>
                <td class="text-right nowrap">
                  <button
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    @click="startEditLlm(cfg)"
                  >编辑</button>
                  <button
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    @click="handleDuplicateLlmConfig(cfg.id, cfg.name)"
                  >拷贝</button>
                  <button
                    type="button"
                    class="link-btn small"
                    :disabled="llmSaving"
                    title="把这一行配置复制成文本到剪贴板"
                    @click="handleCopyLlmConfigText(cfg)"
                  >📋 复制</button>
                  <button
                    type="button"
                    class="link-btn danger small"
                    :disabled="llmSaving"
                    @click="handleDeleteLlmConfig(cfg.id, cfg.name)"
                  >删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 新增 / 编辑表单 -->
        <div class="llm-form-section">
          <div class="llm-form-head">
            <h3 v-if="editingLlmId !== null" class="small font-medium">
              {{ editingLlmId === 'new' ? '新增个人配置' : '编辑个人配置' }}
            </h3>
            <Button
              v-if="editingLlmId === null"
              variant="primary"
             
              :disabled="llmSaving"
              @click="startEditLlm('new')"
            >+ 新增配置</Button>
          </div>
          <div v-if="editingLlmId !== null" class="llm-form">
            <label class="form-label">
              快捷选择供应商
              <Select
                v-model="llmProviderId"
                :options="providerSelectOptions"
                :disabled="llmSaving"
                @update:model-value="(v: string | null) => applyProvider(llmDraft, v ?? '')"
              />
              <span v-if="catalogUpdatedAt" class="small text-muted">
                内置 {{ catalogProviders.length }} 家国内厂商目录（模型列表日更于 {{ catalogUpdatedAt }}）。选中后自动填 Base URL，只需再填 Key。
              </span>
            </label>
            <label class="form-label">
              名称 *
              <Input
                v-model="llmDraft.name"
                type="text"
                placeholder="如：Claude 生产 / 火山方舟测试"
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
                :placeholder="llmSelectedProvider ? `选择 ${llmSelectedProvider.name} 的模型` : '选择或输入自定义模型名'"
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
                :placeholder="editingLlmId !== 'new' ? '留空保留现有 key' : '输入 API Key'"
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
                <label for="clear-api-key" class="small">清除现有 key</label>
              </span>
              <span v-if="llmSelectedProvider" class="small text-muted">
                <a :href="llmSelectedProvider.api_key_url" target="_blank" rel="noopener">获取 {{ llmSelectedProvider.name }} API Key ↗</a>
              </span>
            </label>
            <label class="form-label">
              支持视觉（能否读图）
              <Select
                v-model="llmVisionSelect"
                :options="visionSelectOptions"
                :disabled="llmSaving"
                placeholder="未设置（按模型名推断）"
              />
              <span class="small text-muted">带图任务会自动换到链上能看图的模型（仅当本配置明确标为「不支持」时）</span>
            </label>
            <div class="form-label">
              <span>单价（USD / 百万 token，R239 成本精确计费）</span>
              <div class="llm-price-row">
                <label class="small">输入价
                  <Input v-model="llmDraft.price_in" type="number" step="any" min="0" placeholder="如 3" :disabled="llmSaving" />
                </label>
                <label class="small">输出价
                  <Input v-model="llmDraft.price_out" type="number" step="any" min="0" placeholder="如 15" :disabled="llmSaving" />
                </label>
                <label class="small">缓存读价
                  <Input v-model="llmDraft.price_cache_read" type="number" step="any" min="0" placeholder="如 0.3" :disabled="llmSaving" />
                </label>
              </div>
              <span class="small text-muted">留空 = 未配。配了任一档，任务成本改按本配置单价精确折算（cost_source=priced），不再用全平台折中价；平台代理不回传缓存写价，该档不参与计算。</span>
            </div>
            <div v-if="otherLlmConfigs(editingLlmId === 'new' ? '' : editingLlmId || '').length" class="form-label">
              <span>fallback 链（主模型失败按序换，点选即加入）</span>
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
                顺序：{{ llmDraft.fallback_ids.map((id, i) => `${i + 1}.${llmCfgName(id)}`).join(' → ') }}
              </span>
            </div>
            <div class="form-actions">
              <Button
                variant="primary"
                :loading="llmSaving"
                :disabled="!llmDraft.name.trim()"
                @click="handleLlmSave"
              >保存</Button>
              <Button
                variant="ghost"
                :disabled="llmSaving"
                @click="cancelEditLlm"
              >取消</Button>
              <span v-if="llmMessage" class="small">{{ llmMessage }}</span>
            </div>
          </div>
        </div>

        <!-- 可见的 LLM 配置聚合 (任务/模板选择器数据源) -->
        <div v-if="availableLlmConfigs.length > 0" class="llm-available">
          <h3 class="small font-medium">可见的 LLM 配置（任务/模板可从这里选）</h3>
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
                >{{ cfg.source === 'self' ? '我的' : '平台' }}</span>
                <span class="font-medium small">{{ cfg.name }}</span>
                <span v-if="cfg.is_default" class="text-info small">默认</span>
              </div>
              <div class="muted small mono">
                {{ cfg.model || '—' }} · {{ cfg.base_url || '默认' }}
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
          <h2 class="section-title">📧 通知邮箱</h2>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-notify-email" class="form-label">
              邮箱
              <span class="form-hint">(留空 = 用系统邮箱)</span>
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
              {{ profile.notify_email ? `当前: ${profile.notify_email}` : '未配置, 通知将发往系统邮箱' }}
            </span>
          </div>

          <div v-if="profile.mailer_configured === false" class="warn-box small">
            ⚠️ 平台尚未配置 SMTP (需设置 SMTP_HOST / SMTP_USER / SMTP_PASS / NOTIFY_FROM),
            即使填了通知邮箱也发不出去。
          </div>

          <div class="form-actions">
            <Button variant="primary" :loading="notifySaving" @click="saveNotifyEmail">
              保存邮箱
            </Button>
            <Button
              variant="secondary"
              :loading="notifyTesting"
              :disabled="notifySaving"
              title="发送到当前已保存的收件地址 (不是输入框里未保存的内容)"
              @click="handleNotifyEmailTest"
            >
              {{ notifyTesting ? '发送中...' : '发送测试邮件' }}
            </Button>
          </div>
          <div v-if="notifyMessage" class="message-box small">{{ notifyMessage }}</div>
          <p v-if="profile.notify_fallback_to" class="muted small">
            「发送测试邮件」发往<strong>已保存</strong>的地址 —— 改了输入框请先保存再测试。
          </p>
        </div>
      </section>

      <!-- 飞书机器人 -->
      <section class="card section-card">
        <div class="section-head">
          <h2 class="section-title">🤖 飞书机器人</h2>
        </div>

        <div v-if="profile" class="form-block">
          <div class="form-row">
            <label for="user-feishu-url" class="form-label">
              Webhook URL
              <span class="form-hint">(留空 = 不发飞书)</span>
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
                  ? `当前: ${feishuWebhookMeta.masked_url}`
                  : profile.feishu_configured
                    ? '已配置 (修改后将替换)'
                    : '未配置'
              }}
            </span>
          </div>

          <div class="form-row">
            <label class="form-label">消息类型</label>
            <div class="flex-row gap-2">
              <Select
                v-model="feishuMsgType"
                :options="[
                  { value: 'text', label: 'text (纯文本, 最稳)' },
                  { value: 'markdown', label: 'markdown (**加粗** 等)' },
                  { value: 'post', label: 'post (富文本, 含链接/@人)' },
                ]"
                :disabled="feishuWebhookTesting"
              />
              <span class="form-aside">
                老 webhook 不支持 markdown 会静默拒收 (code:10208), 用 text 或 post
              </span>
            </div>
          </div>

          <div v-if="feishuMsgType === 'post'" class="form-row">
            <label class="form-label">post 模式</label>
            <Input
              v-model="feishuPostTitle"
              type="text"
              placeholder="post 标题 (可选)"
              :disabled="feishuWebhookTesting"
              class-name="form-input-md"
            />
            <Textarea
              v-model="feishuPostContent"
              :rows="3"
              placeholder="post 内容, 二维数组 JSON: [[{tag,text},{tag:'a',text,href},...], ...]"
              :disabled="feishuWebhookTesting"
              class-name="form-textarea"
            />
          </div>

          <div class="form-actions">
            <Button variant="primary" :loading="feishuSaving" @click="saveFeishuWebhook">
              保存 Webhook
            </Button>
            <Button
              variant="secondary"
              :loading="feishuWebhookTesting"
              :disabled="feishuSaving || (!profile.feishu_configured && !profileForm.feishu_webhook_url.trim())"
              title="直接发往输入框里的 webhook (无需先保存)"
              @click="handleFeishuWebhookTest"
            >
              {{ feishuWebhookTesting ? '发送中...' : '发送测试消息' }}
            </Button>
          </div>
          <div v-if="feishuWebhookMessage" class="message-box small">{{ feishuWebhookMessage }}</div>
          <p class="muted small">
            「发送测试消息」直接发往输入框里的 webhook (无需先保存) —— 测通过后点「保存」才写入账户。
            取得 webhook 路径: 飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人。
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
          <h2 class="section-title">⚙️ 调度器参数</h2>
          <span class="badge badge-info">所有用户可读, 管理员可写</span>
        </div>

        <Loading v-if="configLoading && !config" label="加载调度器配置…" />
        <ErrorView
          v-else-if="configError"
          variant="error"
          title="加载调度器配置失败"
          :description="configError"
          :retrying="configRetrying"
          @retry="loadConfig(true)"
        />
        <Empty v-else-if="!config" variant="doc" title="暂无配置" />

        <div v-else class="section-body">
          <div class="form-row">
            <label class="form-label">
              并发上限
              <span class="form-hint">
                (范围 {{ config.concurrency_min }} - {{ config.concurrency_max }})
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
              当前队列: {{ config.running_count }} / {{ config.concurrency }} (running / cap),
              队列深度 {{ config.queue_size }}
            </span>
          </div>

          <div class="form-row">
            <label class="form-label">
              任务壁钟超时 (分钟)
              <span class="form-hint">
                (范围 {{ config.task_timeout_min }} - {{ config.task_timeout_max }})
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
              已在跑的任务按启动那一刻解析的值超时, 改全局值不会重挂定时器。
            </span>
          </div>

          <div class="form-row">
            <label class="form-label">
              端口池
              <span class="form-hint">
                (段数 ≤ {{ config.port_pool_max_segments }},
                每段 {{ config.port_pool_min }} - {{ config.port_pool_max }})
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
                >删除</Button>
              </div>
              <Button
                variant="secondary"
               
                :disabled="appSaving"
                @click="addPortPoolSegment"
              >+ 段</Button>
            </div>
            <p v-if="appFieldErrors.port_pool" class="form-error small">
              {{ appFieldErrors.port_pool }}
            </p>
            <p v-else-if="isAdmin" class="muted small form-aside">
              改端口池不会迁移已在用的项目端口。
            </p>
          </div>

          <div v-if="isAdmin" class="form-actions">
            <Button variant="primary" :loading="appSaving" @click="saveAppConfig">
              保存调度参数
            </Button>
            <Button variant="ghost" :disabled="appSaving" @click="resetAppForm">
              重置
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
          <h2 class="section-title">📊 账号配额</h2>
          <span class="badge badge-warn">甲方</span>
        </div>

        <p class="muted small">
          你的账号已被管理员标记为甲方, 按 R88 三件套（费用上限 / 授予额度 / 到期日期）
          触发任务创建拦截。
        </p>

        <div class="kv-block">
          <div class="kv-row">
            <span class="kv-key">费用上限</span>
            <span class="kv-val mono">
              {{
                profile.quota_total_spent_cap !== null && profile.quota_total_spent_cap !== undefined
                  ? `$${Number(profile.quota_total_spent_cap).toFixed(2)}`
                  : '不限'
              }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">授予上限 (仅展示)</span>
            <span class="kv-val mono">
              {{
                profile.quota_granted_cap !== null && profile.quota_granted_cap !== undefined
                  ? `$${Number(profile.quota_granted_cap).toFixed(2)}`
                  : '不限'
              }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">到期日期</span>
            <span class="kv-val mono">{{ profile.quota_expire_at ?? '不限' }}</span>
          </div>
        </div>

        <p class="muted small kv-hint">
          累计费用明细与触发拦截提示, 在每次创建/启动任务时会显式提示。如需调整请联系管理员。
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
          <h2 class="section-title">🌐 系统 API 配置 (环境变量)</h2>
        </div>

        <div v-if="config" class="kv-block">
          <div class="kv-row">
            <span class="kv-key">ANTHROPIC_API_KEY</span>
            <span class="kv-val">
              <span
                class="status-dot"
                :class="config.api_key_configured ? 'ok' : 'fail'"
              />
              {{ config.api_key_configured ? '已配置' : '未配置 — agent 无法运行' }}
            </span>
          </div>
          <div class="kv-row">
            <span class="kv-key">ANTHROPIC_BASE_URL</span>
            <span class="kv-val mono">{{ config.base_url }}</span>
          </div>
          <div v-if="config.model" class="kv-row">
            <span class="kv-key">默认模型</span>
            <span class="kv-val mono">{{ config.model }}</span>
          </div>
          <p class="muted small kv-hint">
            ⚠️ 环境变量中的 API Key 仅作系统级 fallback, 普通用户必须配置自己的 API Key 或被管理员授权才能运行任务。
          </p>
        </div>
      </section>

      <!-- 维护模式 -->
      <section
        class="card section-card"
        :class="{ 'maint-active': maintenance?.active }"
      >
        <div class="section-head">
          <h2 class="section-title">🔧 维护模式</h2>
          <span
            class="badge"
            :class="maintenance?.active ? 'badge-warn' : 'badge-ok'"
          >
            {{ maintenance?.active ? '🔧 维护中' : '✅ 正常运行' }}
          </span>
        </div>

        <Loading v-if="maintenanceLoading && !maintenance" label="加载维护模式…" />
        <ErrorView
          v-else-if="maintenanceError"
          variant="error"
          title="加载维护模式失败"
          :description="maintenanceError"
          @retry="loadMaintenance"
        />

        <div v-else-if="maintenance" class="form-block">
          <p class="muted small">
            部署前关停: 暂停调度、挂起运行中的任务 (保留上下文, 恢复后可续完整对话)、摘下排队任务。
            直接重启服务会连 agent 子进程一起杀掉, 在跑的任务就丢上下文了。
          </p>

          <div v-if="maintenance.active" class="warn-box small">
            <div>进入时间: {{ maintenance.entered_at || '—' }}</div>
            <div v-if="maintenance.reason">原因: {{ maintenance.reason }}</div>
            <div>挂起任务: {{ maintenance.suspended_count }} 个 (恢复时自动重启)</div>
          </div>

          <!-- v53 上次维护: active=true 时不显示避免歧义 -->
          <div
            v-else-if="maintenance.last_maintenance"
            class="muted small maint-last"
          >
            <div class="flex-row gap-2">
              <span class="font-medium">上次维护</span>
              <span
                class="maint-result-chip"
                :class="{
                  'maint-result-failed': maintenance.last_maintenance.result === 'failed',
                  'maint-result-aborted': maintenance.last_maintenance.result === 'aborted',
                  'maint-result-ok': maintenance.last_maintenance.result === 'completed',
                }"
              >
                {{
                  maintenance.last_maintenance.result === 'failed' ? '有失败'
                  : maintenance.last_maintenance.result === 'aborted' ? '异常中断'
                  : '已完成'
                }}
              </span>
            </div>
            <div>
              {{ formatMaintenanceTime(maintenance.last_maintenance.started_at) }}
              <template v-if="maintenance.last_maintenance.duration_seconds !== null">
                → {{ formatMaintenanceDuration(maintenance.last_maintenance.duration_seconds) }}
              </template>
              <template v-if="maintenance.last_maintenance.reason">
                · 原因: {{ maintenance.last_maintenance.reason }}
              </template>
            </div>
            <div v-if="maintenance.last_maintenance.paused_count > 0 || maintenance.last_maintenance.dequeued_count > 0 || maintenance.last_maintenance.failed_count > 0">
              影响: 暂停 {{ maintenance.last_maintenance.paused_count }} 个运行中
              <template v-if="maintenance.last_maintenance.dequeued_count > 0">
                , 摘下 {{ maintenance.last_maintenance.dequeued_count }} 个排队
              </template>
              <template v-if="maintenance.last_maintenance.failed_count > 0">
                , {{ maintenance.last_maintenance.failed_count }} 个失败
              </template>
            </div>
          </div>

          <div class="muted small">
            调度器: {{ maintenance.scheduler_paused ? '已关闸' : '正常' }} ·
            运行中 {{ maintenance.running_count }} · 排队 {{ maintenance.queue_size }}
          </div>

          <div class="form-actions">
            <Button
              v-if="!maintenance.active"
              variant="primary"
              @click="handleEnterMaintenance"
            >进入维护模式</Button>
            <Button
              v-else
              variant="primary"
              @click="handleExitMaintenance"
            >退出维护模式</Button>
          </div>
        </div>
      </section>

      <!-- 账号配额 (R50.1 B309) — admin 卡片
           镜像 master src/app/settings/page.tsx:1794-1979: 每用户一行 + party_a 开关 +
           3 字段 onBlur 自动保存 + 「查看变更历史」按钮. -->
      <section class="card section-card quota-section">
        <div class="section-head">
          <h2 class="section-title">💰 账号配额</h2>
          <span class="badge badge-info">管理员</span>
        </div>

        <p class="muted small">
          标记为甲方的用户 (party_a_enabled=1) 才会按 R88 三件套拦截。granted_cap 仅展示不参与拦截。
        </p>

        <div v-if="quotaMessage" class="message-box small">{{ quotaMessage }}</div>

        <div v-if="quotaUsers.length === 0" class="muted small text-center py-3">
          暂无用户
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
                >管理员</span>
                <span
                  v-if="u.party_a_enabled"
                  class="badge badge-warn small"
                >甲方</span>
              </div>
              <label class="party-toggle" :title="u.party_a_enabled ? '取消甲方标记' : '标记为甲方'">
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
                  已用 ${{ (u.used_total_usd || 0).toFixed(2) }}
                  / 上限 ${{ u.quota_total_spent_cap.toFixed(2) }}
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
                费用上限 (USD)
                <Input
                  :model-value="u.quota_total_spent_cap === null ? '' : String(u.quota_total_spent_cap)"
                  type="number"
                  :min="0"
                  :step="0.01"
                  placeholder="不限"
                  :disabled="!!quotaSaving[u.id]"
                  class-name="form-input-sm"
                  @update:model-value="(v: string) => onCapBlur(u, v)"
                />
              </label>
              <label class="form-label">
                授予上限 (仅展示)
                <Input
                  :model-value="u.quota_granted_cap === null ? '' : String(u.quota_granted_cap)"
                  type="number"
                  :min="0"
                  :step="0.01"
                  placeholder="不限"
                  :disabled="!!quotaSaving[u.id]"
                  class-name="form-input-sm"
                  @update:model-value="(v: string) => onGrantedCapBlur(u, v)"
                />
              </label>
              <label class="form-label">
                到期日期 (ISO8601)
                <Input
                  :model-value="u.quota_expire_at ?? ''"
                  type="text"
                  placeholder="不限 (e.g. 2027-01-01T00:00:00Z)"
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
                {{ quotaLogOpen === u.id ? '收起' : '查看变更历史' }}
              </button>
            </div>

            <div v-if="quotaLogOpen === u.id" class="quota-log">
              <div
                v-if="quotaLogByUser[u.id] === undefined"
                class="muted small"
              >加载中…</div>
              <div
                v-else-if="!quotaLogByUser[u.id] || quotaLogByUser[u.id]!.length === 0"
                class="muted small"
              >暂无变更记录</div>
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
          <h2 class="section-title">🤖 平台 LLM 配置</h2>
          <span class="badge badge-info">管理员</span>
        </div>

        <p class="muted small">
          任务 / 模板从「可见的 LLM 配置」里选。被授权用户也看得到这里的 admin 配置。
        </p>

        <div v-if="adminLlmMessage" class="message-box small">{{ adminLlmMessage }}</div>

        <Loading v-if="adminLlmLoading && adminLlmConfigs.length === 0" label="加载平台 LLM…" />
        <Empty v-else-if="adminLlmConfigs.length === 0" variant="doc" title="还没有平台 LLM" />

        <p class="muted small">
          任务 / 模板从「可见的 LLM 配置」里选。被授权用户也看得到这里的 admin 配置。
          <span>「基准」= 成本系数的分母模型：点某行「设基准」，其它配置的系数 = 本行基准价(入+出) ÷ 该行基准价。全平台一个基准。</span>
        </p>

        <div v-if="adminLlmMessage" class="message-box small">{{ adminLlmMessage }}</div>

        <Loading v-if="adminLlmLoading && adminLlmConfigs.length === 0" label="加载平台 LLM…" />
        <Empty v-else-if="adminLlmConfigs.length === 0" variant="doc" title="还没有平台 LLM" />

        <div v-else class="admin-llm-table">
          <div class="admin-llm-head">
            <span>名称</span>
            <span>Base URL</span>
            <span>Model</span>
            <span>API Key</span>
            <span title="相对基准模型的成本系数 = 本配置(入价+出价) ÷ 基准(入价+出价)；基准未设或没配价显 —">系数</span>
            <span>默认</span>
            <span class="ta-right">操作</span>
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
                :title="`fallback 链: ${cfg.fallback_ids.map(adminLlmCfgName).join(' → ')}`"
              >⛓{{ cfg.fallback_ids.length }}</span>
              <span
                v-if="visionBadge(cfg.supports_vision)"
                class="badge small"
                :title="cfg.supports_vision ? '支持视觉（可读图）' : '不支持视觉（读图会白读）'"
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
              <span v-else class="text-warn small">未配</span>
            </span>
            <span class="mono small" :title="`单价(入/出): ${cfg.price_in ?? '—'} / ${cfg.price_out ?? '—'} USD每百万token`">
              {{ coefficientLabel(cfg, costBaselineId) }}
            </span>
            <span>
              <span v-if="cfg.is_default" class="badge badge-info small">默认</span>
              <button
                v-else
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmDefault(cfg.id)"
              >设为默认</button>
              <button
                v-if="costBaselineId !== cfg.id"
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                title="把本配置设为成本系数基准（其它配置的系数相对它算）"
                @click="handleSetBaseline(cfg.id)"
              >设基准</button>
              <button
                v-else
                type="button"
                class="link-btn small link-btn-danger"
                :disabled="adminLlmSaving"
                title="清除成本基准（所有系数变 —）"
                @click="handleSetBaseline(null)"
              >清基准</button>
            </span>
            <span class="ta-right admin-llm-actions">
              <button
                type="button"
                class="link-btn small"
                @click="startEditAdminLlm(cfg)"
              >编辑</button>
              <button
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmDuplicate(cfg.id, cfg.name)"
              >拷贝</button>
              <button
                type="button"
                class="link-btn small"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmCopyText(cfg)"
              >📋 复制</button>
              <button
                type="button"
                class="link-btn small link-btn-danger"
                :disabled="adminLlmSaving"
                @click="handleAdminLlmDelete(cfg.id, cfg.name)"
              >删除</button>
            </span>
          </div>
        </div>

        <!-- 新增 / 编辑表单 -->
        <div class="admin-llm-form">
          <div class="admin-llm-form-head">
            <h3 class="small-section">
              {{ editingAdminLlmId === 'new' ? '新增平台 LLM' : editingAdminLlmId ? '编辑平台 LLM' : '' }}
            </h3>
            <Button
              v-if="editingAdminLlmId === null"
              variant="primary"
             
              @click="startEditAdminLlm('new')"
            >+ 新增配置</Button>
          </div>

          <div v-if="editingAdminLlmId !== null" class="form-block">
            <label class="form-label">快捷选择供应商
              <Select
                v-model="adminLlmProviderId"
                :options="providerSelectOptions"
                @update:model-value="(v: string | null) => applyProvider(adminLlmDraft, v ?? '')"
              />
              <span v-if="catalogUpdatedAt" class="small text-muted">
                内置 {{ catalogProviders.length }} 家国内厂商目录（模型列表日更于 {{ catalogUpdatedAt }}）。选中后自动填 Base URL，只需再填 Key。
              </span>
            </label>
            <label class="form-label">名称 *</label>
            <Input v-model="adminLlmDraft.name" placeholder="如: Claude 生产 / 火山方舟测试" />

            <label class="form-label">Base URL</label>
            <Input v-model="adminLlmDraft.base_url" placeholder="https://api.anthropic.com" />

            <label class="form-label">Model</label>
            <Input
              v-model="adminLlmDraft.model"
              :placeholder="adminLlmSelectedProvider ? `选择 ${adminLlmSelectedProvider.name} 的模型` : '选择或输入自定义模型名'"
              list="admin-llm-model-options"
            />
            <datalist id="admin-llm-model-options">
              <option v-for="m in adminLlmModelSuggestions" :key="m" :value="m" />
            </datalist>

            <label class="form-label">API Key</label>
            <Input
              v-model="adminLlmDraft.api_key"
              type="password"
              :placeholder="editingAdminLlmId !== 'new' ? '留空保留现有 key' : '输入 API Key'"
            />
            <label v-if="editingAdminLlmId !== 'new'" class="form-label small">
              <Checkbox v-model="adminLlmDraft.clear_api_key" />
              清除现有 key
            </label>
            <p v-if="adminLlmSelectedProvider" class="form-label small text-muted">
              <a :href="adminLlmSelectedProvider.api_key_url" target="_blank" rel="noopener">获取 {{ adminLlmSelectedProvider.name }} API Key ↗</a>
            </p>

            <label class="form-label">支持视觉（能否读图）</label>
            <Select
              v-model="adminVisionSelect"
              :options="visionSelectOptions"
              :disabled="adminLlmSaving"
              placeholder="未设置（按模型名推断）"
            />

            <label class="form-label">单价（USD / 百万 token）</label>
            <div class="llm-price-row">
              <label class="small">输入价
                <Input v-model="adminLlmDraft.price_in" type="number" step="any" min="0" placeholder="如 3" :disabled="adminLlmSaving" />
              </label>
              <label class="small">输出价
                <Input v-model="adminLlmDraft.price_out" type="number" step="any" min="0" placeholder="如 15" :disabled="adminLlmSaving" />
              </label>
              <label class="small">缓存读价
                <Input v-model="adminLlmDraft.price_cache_read" type="number" step="any" min="0" placeholder="如 0.3" :disabled="adminLlmSaving" />
              </label>
            </div>
            <span class="small text-muted">配了任一档，用本配置的任务成本按单价精确折算（不再走全平台折中价）；系数 = (输入价+输出价) ÷ 基准模型同和，基准用上方「设基准」选。</span>

            <div
              v-if="adminLlmConfigs.filter((c) => c.id !== (editingAdminLlmId === 'new' ? '' : editingAdminLlmId)).length"
              class="form-label"
            >
              <span>fallback 链（主模型失败按序换，点选即加入）</span>
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
                顺序：{{ adminLlmDraft.fallback_ids.map((id, i) => `${i + 1}.${adminLlmCfgName(id)}`).join(' → ') }}
              </span>
            </div>

            <div class="form-actions">
              <Button
                variant="primary"
               
                :loading="adminLlmSaving"
                :disabled="adminLlmSaving || !adminLlmDraft.name.trim()"
                @click="saveAdminLlm"
              >保存</Button>
              <Button variant="ghost" :disabled="adminLlmSaving" @click="cancelEditAdminLlm">
                取消
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
          <h2 class="section-title">👥 用户授权</h2>
          <span class="badge badge-info">管理员</span>
        </div>

        <p class="muted small">
          授权用户使用平台 LLM 配置, 并可设每账号并发上限 (留空 = 不限, 仍受全局总闸约束).
          管理员默认可用, 无需授权.
        </p>

        <div v-if="grantsMessage" class="message-box small">{{ grantsMessage }}</div>

        <Loading v-if="grantsLoading && grants.length === 0" label="加载用户授权…" />
        <Empty v-else-if="grants.length === 0" variant="doc" title="暂无其他用户" />

        <div v-else class="grants-table">
          <div class="grants-head">
            <span>用户</span>
            <span>并发上限</span>
            <span class="ta-right">授权</span>
          </div>
          <div
            v-for="u in pagedGrants"
            :key="u.id"
            class="grants-row"
          >
            <span class="grants-user">
              <span class="mono">{{ u.email }}</span>
              <span v-if="u.role === 'admin'" class="badge badge-info small">管理员</span>
            </span>
            <span class="grants-input">
              <Input
                type="number"
                :model-value="u.max_concurrency === null ? '' : String(u.max_concurrency ?? '')"
                placeholder="不限"
                class-name="form-input-sm mono center"
                @blur="(e: FocusEvent) => saveConcurrency(u.id, (e.target as HTMLInputElement).value)"
              />
              <span v-if="concurrencyStatus[u.id] === 'saving'" class="muted small">…</span>
              <span v-else-if="concurrencyStatus[u.id] === 'saved'" class="text-ok small">✓</span>
              <span v-else-if="concurrencyStatus[u.id] === 'error'" class="text-warn small">✗</span>
            </span>
            <span class="ta-right">
              <span v-if="u.role === 'admin'" class="muted small">默认</span>
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
            >上一页</Button>
            <span class="muted small">{{ safeGrantsPage + 1 }} / {{ totalGrantPages }}</span>
            <Button
              variant="ghost"
             
              :disabled="safeGrantsPage >= totalGrantPages - 1"
              @click="grantsPage = safeGrantsPage + 1"
            >下一页</Button>
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