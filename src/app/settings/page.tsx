"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import Select from "@/components/Select";
import { playNotifySound } from "@/lib/sound";
import { useAvailableModels } from "@/lib/hooks/use-available-models";
import {
  getSoundSettings,
  saveSoundSettings,
  type SoundSettings,
  type SoundEventKey,
} from "@/lib/sound-settings";
import {
  getCompactThreshold,
  saveCompactThreshold,
  DEFAULT_COMPACT_THRESHOLD,
} from "@/lib/fork-settings";

type Config = {
  concurrency: number;
  concurrency_min: number;
  concurrency_max: number;
  queue_size: number;
  running_count: number;
  api_key_configured: boolean;
  base_url: string;
  model: string | null;
  // v40 全局默认壁钟超时(分钟) + 服务端边界。落库, 重启仍在。
  task_timeout_minutes: number;
  task_timeout_min: number;
  task_timeout_max: number;
  // R18 P2: 端口池 (admin 配置). number[][] = [[start,end], ...]; 边界常量
  // 来自后端, 前端不写死, 让客户端看到的边界永远和服务端一致.
  port_pool: number[][];
  port_pool_min: number;
  port_pool_max: number;
  port_pool_max_segments: number;
};

// 维护模式状态（GET /api/admin/maintenance）。admin only，非 admin 拿到 403，
// 此时整块 UI 不渲染。
type MaintenanceInfo = {
  active: boolean;
  entered_at: string | null;
  reason: string | null;
  suspended_count: number;
  scheduler_paused: boolean;
  running_count: number;
  queue_size: number;
  // v53: 最近一条已完成的维护记录（active 时为 null，UI 不显示避免和「正在维护」混淆）
  last_maintenance: {
    id: number;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    reason: string | null;
    paused_count: number;
    dequeued_count: number;
    failed_count: number;
    result: "completed" | "aborted" | "failed" | null;
  } | null;
};

type LlmConfigSafe = {
  id: string;
  owner_type: "user" | "project" | "admin";
  owner_id: string;
  name: string;
  type: string;
  api_key_masked: string | null;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
};

type AvailableLlmConfig = {
  id: string;
  source: "self" | "admin_grant";
  name: string;
  type: string;
  has_api_key: boolean;
  base_url: string | null;
  model: string | null;
  is_default: boolean;
};

// 多模态 API Key (mmx-cli) 安全 shape — 不返明文
type MediaKeySafe = {
  user_id: string;
  api_key_masked: string | null;
  has_api_key: boolean;
  region: string | null;
  /** PUT 成功但 mmx 写入失败时附带的警告 (e.g. mmx 未装, 网络挂) */
  mmx_warning?: string;
};

type UserProfile = {
  id: string;
  email: string;
  role: string;
  created_at: string;
  admin_llm_granted: boolean;
  preflight_enabled: boolean;
  notify_email: string | null;
  /** 平台 SMTP env 是否配齐 —— 没配齐时填了通知邮箱也发不出去 */
  mailer_configured: boolean;
  /** v47: 飞书 webhook 是否已配 (不返明文 URL, 看具体值走 /webhook-meta) */
  feishu_configured: boolean;
  /** 系统兜底收件人, 用户没配 notify_email 时通知发到这里 */
  notify_fallback_to: string | null;
  // v55+ R88 quota: 自查看 (party_a_enabled=1 的用户才显示配额卡, Sheet L 验收 ⑤)
  party_a_enabled?: boolean;
  quota_total_spent_cap?: number | null;
  quota_granted_cap?: number | null;
  quota_expire_at?: string | null;
  /** v55+: 当前累计费用 (USD), 走 GET /api/admin/users 的聚合; 用户自己从
   *  /api/user/me 拿不到 (profile 不返 SUM 聚合避免 GET /user/me 变重) —— 用户端
   *  直接走 /api/admin/users 自我聚合 (admin 接口对所有用户返自己)。 */
  used_total_usd?: number;
};

// v55+: Admin 配额管理 UI 类型. 跟 listUsersWithQuota() 返的 JSON 形状一致.
type UserWithQuota = {
  id: string;
  email: string;
  role: string;
  party_a_enabled: boolean;
  quota_total_spent_cap: number | null;
  quota_granted_cap: number | null;
  quota_expire_at: string | null;
  used_total_usd: number;
};

// v55+: 配额变更历史 entry. 跟 getQuotaChangeLog() 返的形状一致.
type QuotaLogEntry = {
  id: number;
  operator_id: string;
  target_user_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  created_at: string;
};

type UserWithGrant = {
  id: string;
  email: string;
  role: string;
  granted: boolean;
  max_concurrency: number | null;
};

type ApiToken = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
};

// 功能: 把字符串写到剪贴板. 优先用 async clipboard API, 不可用 (非安全上下文或老浏览器)
//   时降级到临时 textarea + execCommand 兜底.
// 关注点: localhost (dev) + https (prod) 走 async 路径; file:// / http:// 内网 IP 才需要
//   fallback. 失败抛错由调用方决定如何提示 (避免误报「复制成功」).
async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to fallback
    }
  }
  if (typeof document === "undefined") {
    throw new Error("clipboard not available");
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("execCommand copy failed");
}

// 注: 本地 MODEL_OPTIONS 已在 2026-08-22 由 useAvailableModels() 替代; 详见
// src/lib/hooks/use-available-models.ts (configured + builtin + used 并集去重).
// datalist 直接喂 modelStringList (从 hook 取出), 用户仍可输入任意自定义 model 名.

// Client-side pagination for the admin user-grants list.
const GRANTS_PAGE_SIZE = 10;

// 提示音事件选项: key 对应 SoundEventKey, label/desc 用于设置页展示.
const SOUND_EVENT_OPTIONS: { key: SoundEventKey; label: string; desc: string }[] = [
  { key: "tool_approval", label: "工具需审批", desc: "agent 使用写入类工具时需你批准" },
  { key: "user_dialog", label: "需回答问题", desc: "agent 通过 AskUserQuestion 向你提问" },
  { key: "reviewing", label: "任务待审核", desc: "agent 完成工作，等待你审核" },
  { key: "failed", label: "任务失败", desc: "agent 出错或异常结束" },
  { key: "paused", label: "任务已暂停（自动）", desc: "超时等待人工输入时自动暂停（系统重启的暂停无法提示）" },
  { key: "queued", label: "排队中", desc: "并发已满，任务进入排队" },
  { key: "cancelled", label: "任务已取消（自动）", desc: "运行超时被强制取消" },
];

// v53: 把 maintenance_log.started_at (ISO) 渲染成「YYYY-MM-DD HH:MM」本地时区格式.
//  // 故意避开 toLocaleString: 服务端写 ISO, 客户端用本地时区, 不同人看到的「时间」不同.
//  // 单函数隔离, 不引 dayjs 之类的依赖.
function formatMaintenanceTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// v53: 秒数渲染. < 60s 「Ns」; < 3600s 「Mm Ss」; 否则「Hh Mm」.
//  // 维护很少超过 1h, 超过的标天 - 「1d 2h」.
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

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [concurrency, setConcurrency] = useState(2);
  // 全局默认壁钟超时(分钟, v40). 与 concurrency 同一个「保存」按钮提交。
  const [timeoutInput, setTimeoutInput] = useState("30");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: "danger" | "default";
    onConfirm: () => void;
  } | null>(null);

  // 维护模式（v34，admin only）
  const [maintenance, setMaintenance] = useState<MaintenanceInfo | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(null);

  // R18 P2: 端口池 (admin only). poolDraft 是 [[start,end], ...] 输入框草稿,
  // 与 concurrency/timeout 共用「保存」按钮 + handleSave, 一并 PATCH /api/config.
  // 用 number[][] 而不是字符串, 让前端无需 parse.
  const [poolDraft, setPoolDraft] = useState<Array<[number, number]>>([[13000, 13099]]);

  // User profile (role + grant status)
  const [profile, setProfile] = useState<UserProfile | null>(null);

  // Preflight toggle state (v27)
  const [preflightSaving, setPreflightSaving] = useState(false);
  const [preflightMessage, setPreflightMessage] = useState<string | null>(null);

  // 通知邮箱 (v41)。notifyDraft 是输入框的本地草稿, 只在保存时才写回 profile ——
  // 边打字边 PATCH 会把每个中间态都存进库(还会触发格式校验报错闪烁)。
  const [notifyDraft, setNotifyDraft] = useState("");
  const [notifySaving, setNotifySaving] = useState(false);
  const [notifyTesting, setNotifyTesting] = useState(false);
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);

  // 模型下拉数据源 (configured + builtin + used). 给 llm_configs 编辑表单的 model
  // 字段用 datalist 喂建议, 用户仍可输入自定义 model 名 (settings 的 model 字段是
  // 「新建一份配置指向的模型」, 必须是任意字符串).
  const { options: modelOptions } = useAvailableModels();
  const modelStringList = useMemo(
    () => modelOptions.map((o) => o.value).filter(Boolean),
    [modelOptions]
  );

  // 飞书 webhook (v47)。同样的草稿模式: feishuWebhookDraft 在保存前只在本地,
  // feishuWebhookMeta 拿末 4 位脱敏 (webhook URL 是半秘密, GET /api/user/me 不回).
  const [feishuWebhookDraft, setFeishuWebhookDraft] = useState("");
  const [feishuWebhookMeta, setFeishuWebhookMeta] = useState<{
    masked_url: string | null;
  } | null>(null);
  const [feishuWebhookSaving, setFeishuWebhookSaving] = useState(false);
  const [feishuWebhookTesting, setFeishuWebhookTesting] = useState(false);
  const [feishuWebhookMessage, setFeishuWebhookMessage] = useState<string | null>(null);

  // 提示音设置 (localStorage, 纯客户端)
  const [soundSettings, setSoundSettings] = useState<SoundSettings | null>(null);

  // Fork 自动压缩阈值 (localStorage, 纯客户端)
  const [compactThreshold, setCompactThreshold] = useState<number>(DEFAULT_COMPACT_THRESHOLD);

  // User LLM config state (v50: 多配置 + list)
  const [llmConfigs, setLlmConfigs] = useState<LlmConfigSafe[]>([]);
  const [editingLlmId, setEditingLlmId] = useState<string | "new" | null>(null);
  const [llmDraft, setLlmDraft] = useState<{ name: string; base_url: string; model: string; api_key: string; clear_api_key: boolean }>({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);

  // 多模态 API Key (mmx-cli) state — v48 user_media_keys
  const [mediaKey, setMediaKey] = useState<MediaKeySafe | null>(null);
  const [mediaKeyInput, setMediaKeyInput] = useState("");
  const [showMediaKeyInput, setShowMediaKeyInput] = useState(false);
  const [regionInput, setRegionInput] = useState<"cn" | "global">("cn");
  const [mediaSaving, setMediaSaving] = useState(false);
  const [mediaTesting, setMediaTesting] = useState(false);
  const [mediaMessage, setMediaMessage] = useState<string | null>(null);

  // Admin LLM config state (v50: 多配置 + list)
  const [adminLlmConfigs, setAdminLlmConfigs] = useState<LlmConfigSafe[]>([]);
  const [editingAdminLlmId, setEditingAdminLlmId] = useState<string | "new" | null>(null);
  const [adminLlmDraft, setAdminLlmDraft] = useState<{ name: string; base_url: string; model: string; api_key: string; clear_api_key: boolean }>({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
  const [adminLlmSaving, setAdminLlmSaving] = useState(false);
  const [adminLlmMessage, setAdminLlmMessage] = useState<string | null>(null);

  // Available (聚合自配 + 平台) — 模板/任务选择器使用
  const [availableLlmConfigs, setAvailableLlmConfigs] = useState<AvailableLlmConfig[]>([]);

  // Admin grants state
  const [grants, setGrants] = useState<UserWithGrant[]>([]);
  const [grantsSaving, setGrantsSaving] = useState(false);
  const [grantsMessage, setGrantsMessage] = useState<string | null>(null);
  const [grantsPage, setGrantsPage] = useState(0);
  const [concurrencyStatus, setConcurrencyStatus] = useState<
    Record<string, "saving" | "saved" | "error">
  >({});

  // v55+ R88 配额 admin state (Sheet L 验收 ④)
  const [quotaUsers, setQuotaUsers] = useState<UserWithQuota[]>([]);
  const [quotaSaving, setQuotaSaving] = useState<Record<string, boolean>>({});
  const [quotaMessage, setQuotaMessage] = useState<string | null>(null);
  const [quotaLogByUser, setQuotaLogByUser] = useState<Record<string, QuotaLogEntry[]>>({});
  const [quotaLogOpen, setQuotaLogOpen] = useState<string | null>(null);

  // API tokens state
  const [apiTokens, setApiTokens] = useState<ApiToken[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  // 批量删除 + 搜索：仅影响 API Token 卡片内部，跟 admin grants 的 selectedGrants 互不干扰
  const [selectedTokenIds, setSelectedTokenIds] = useState<Set<string>>(new Set());
  const [tokenSearch, setTokenSearch] = useState("");

  // v54 拆 tab (R17): 把 14 个 section 切成 4 个 tab, 默认 "account"。
  //   - account    = 个人账号相关 (声音 / Fork / 个人 LLM / 多模态 / Token)
  //   - notify     = 通知出口 (邮箱 / 飞书机器人)
  //   - schedule   = 调度 (并发 / 超时 / Dispatch 行为) — 不依赖 admin
  //   - platform   = 平台管理 (系统 API / 平台 LLM / 用户授权 / 维护模式) — admin only
  // rationale: 2539 行单页面太长, 用户每次只能盯一类问题。
  //   非 admin 看不到 "platform" tab (header 里过滤掉)。
  const [activeTab, setActiveTab] = useState<
    "account" | "notify" | "schedule" | "platform"
  >("account");

  // 派生：搜索过滤后的 token 列表 + 全选状态
  const filteredTokens = useMemo(() => {
    const q = tokenSearch.trim().toLowerCase();
    if (!q) return apiTokens;
    return apiTokens.filter((t) => t.name.toLowerCase().includes(q));
  }, [apiTokens, tokenSearch]);
  const allFilteredSelected =
    filteredTokens.length > 0 &&
    filteredTokens.every((t) => selectedTokenIds.has(t.id));

  // token 成功消息 3 秒后自动消失，错误消息保持常驻（用户需要看到失败原因）。
  // timer ref 防止连续操作时多次 setTimeout 互相覆盖。
  const tokenMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function setTransientTokenMessage(msg: string) {
    setTokenMessage(msg);
    if (tokenMessageTimerRef.current) clearTimeout(tokenMessageTimerRef.current);
    tokenMessageTimerRef.current = setTimeout(() => {
      setTokenMessage(null);
      tokenMessageTimerRef.current = null;
    }, 3000);
  }
  useEffect(() => () => {
    if (tokenMessageTimerRef.current) clearTimeout(tokenMessageTimerRef.current);
  }, []);

  const isAdmin = profile?.role === "admin";

  // Derived: pagination slice for the admin grants list.
  const totalGrantPages = Math.max(1, Math.ceil(grants.length / GRANTS_PAGE_SIZE));
  const safeGrantsPage = Math.min(grantsPage, totalGrantPages - 1);
  const pagedGrants = grants.slice(
    safeGrantsPage * GRANTS_PAGE_SIZE,
    (safeGrantsPage + 1) * GRANTS_PAGE_SIZE
  );

  useEffect(() => {
    fetchConfig();
    fetchLlmConfigs();
    fetchMediaKey();
    fetchProfile();
    fetchApiTokens();
    setSoundSettings(getSoundSettings());
    setCompactThreshold(getCompactThreshold());
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchAdminLlmConfigs();
      fetchGrants();
      fetchMaintenance();
      fetchQuotaUsers();
    }
  }, [isAdmin]);

  async function fetchProfile() {
    try {
      const res = await fetch("/api/user/me");
      const data = await res.json();
      setProfile(data);
      // 首次加载把库里的值灌进输入框草稿。用户已经在编辑时不覆盖他的输入。
      setNotifyDraft((d) => (d ? d : data.notify_email || ""));
      // v47: 拉 webhook 脱敏信息 (拿末 4 位), 用于 "已配" 提示
      fetchFeishuWebhookMeta();
    } catch {
      // Silently fail
    }
  }

  // v47: 拉飞书 webhook 脱敏信息 (末 4 位). 用于显示 "已配" + 让用户确认
  //   自己配的就是那一个 hook, 不回完整明文 (webhook 是半秘密).
  async function fetchFeishuWebhookMeta() {
    try {
      const res = await fetch("/api/user/me/webhook-meta");
      if (!res.ok) return;
      const data = await res.json();
      setFeishuWebhookMeta({ masked_url: data.masked_url });
    } catch {
      // Silently fail —— 不阻断主流程
    }
  }

  async function handlePreflightToggle(enabled: boolean) {
    setPreflightSaving(true);
    setPreflightMessage(null);
    // Optimistic update — flip the toggle immediately for snappy UX, revert
    // on error.
    const prev = profile;
    setProfile((p) => (p ? { ...p, preflight_enabled: enabled } : p));
    try {
      const res = await fetch("/api/user/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preflight_enabled: enabled }),
      });
      if (!res.ok) {
        setProfile(prev);
        const err = await res.json().catch(() => ({}));
        setPreflightMessage(`保存失败：${err.error || res.statusText}`);
        return;
      }
      const updated = await res.json();
      setProfile((p) => (p ? { ...p, ...updated, admin_llm_granted: p.admin_llm_granted } : p));
      setPreflightMessage(enabled ? "已开启 preflight 自检" : "已关闭 preflight 自检");
    } catch (err) {
      setProfile(prev);
      setPreflightMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setPreflightSaving(false);
    }
  }

  // 功能: 保存通知邮箱。空串 = 清空(回落系统邮箱)。
  // 关注点: 后端也校验格式(isValidNotifyEmail), 这里不做前端预校验 —— 两份规则
  //   一定会漂移, 让后端当唯一判据, 前端只负责把 error 显示出来。
  async function handleNotifyEmailSave() {
    setNotifySaving(true);
    setNotifyMessage(null);
    try {
      const res = await fetch("/api/user/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify_email: notifyDraft.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotifyMessage(`保存失败：${data.error || res.statusText}`);
        return;
      }
      setProfile((p) => (p ? { ...p, ...data, admin_llm_granted: p.admin_llm_granted } : p));
      setNotifyDraft(data.notify_email || "");
      setNotifyMessage(
        data.notify_email ? `已保存，通知将发往 ${data.notify_email}` : "已清空，通知发往系统邮箱"
      );
    } catch (err) {
      setNotifyMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setNotifySaving(false);
    }
  }

  // 功能: 真发一封测试邮件到当前生效的收件人。
  // 关注点: 端点不接受任意地址(防开放中继), 所以发的一定是「未保存的草稿」以外的
  //   **已保存值** —— 文案里要说清这点, 否则用户改了输入框没保存就点测试会困惑。
  async function handleNotifyEmailTest() {
    setNotifyTesting(true);
    setNotifyMessage(null);
    try {
      const res = await fetch("/api/user/notify-email/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotifyMessage(`发送失败：${data.error || res.statusText}`);
        return;
      }
      if (data.sent) {
        setNotifyMessage(
          `已发送到 ${data.to}${data.using_fallback ? "（系统兜底邮箱）" : ""}，请查收。SMTP 响应：${data.response || "已接受"}`
        );
      } else {
        setNotifyMessage(`未发送：${data.reason || "未知原因"}`);
      }
    } catch (err) {
      setNotifyMessage(`发送失败：${(err as Error).message}`);
    } finally {
      setNotifyTesting(false);
    }
  }

  // v47: 保存飞书 webhook URL. 与 notify_email 同款: 草稿 vs 已保存值分离,
  //   后端是格式校验唯一判据. 保存成功后刷一次 meta (拿新的脱敏显示).
  async function handleFeishuWebhookSave() {
    setFeishuWebhookSaving(true);
    setFeishuWebhookMessage(null);
    try {
      const res = await fetch("/api/user/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feishu_webhook_url: feishuWebhookDraft.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeishuWebhookMessage(`保存失败：${data.error || res.statusText}`);
        return;
      }
      // 同步刷新 profile (feishu_configured) + meta (masked_url)
      setProfile((p) =>
        p ? { ...p, ...data, admin_llm_granted: p.admin_llm_granted } : p
      );
      setFeishuWebhookMessage(
        data.feishu_webhook_url ? "已保存飞书 webhook" : "已清空飞书 webhook"
      );
      // 保存后清空输入框 (脱敏值由 meta 显示, 不让输入框跟已保存值同步显示, 避免误以为能编辑明文)
      setFeishuWebhookDraft("");
      fetchFeishuWebhookMeta();
    } catch (err) {
      setFeishuWebhookMessage(`保存失败：${(err as Error).message}`);
    } finally {
      setFeishuWebhookSaving(false);
    }
  }

  // v47: 真发一条飞书测试消息. draft (输入框未保存) 优先于 saved (DB 已存),
  //   端点走 isValidFeishuWebhookUrl 校验 draft —— 与 PATCH /api/user/me 同口径.
  // msgType: text | markdown | post. 默认 text 兼容老 webhook (不支持 markdown 的).
  // post 模式需额外传 post_title + post_content (JSON 字符串).
  const [feishuMsgType, setFeishuMsgType] = useState<"text" | "markdown" | "post">("text");
  const [feishuPostTitle, setFeishuPostTitle] = useState("");
  const [feishuPostContent, setFeishuPostContent] = useState(
    '[[{"tag":"text","text":"项目有更新: "},{"tag":"a","text":"请查看","href":"https://example.com"}}]]'
  );

  async function handleFeishuWebhookTest() {
    setFeishuWebhookTesting(true);
    setFeishuWebhookMessage(null);
    try {
      const reqBody: Record<string, unknown> = {
        webhook_url: feishuWebhookDraft.trim() || undefined,
        msg_type: feishuMsgType,
      };
      if (feishuMsgType === "post") {
        // content 字段必须是合法 JSON 字符串; 失败就当 text 发, 给个 reason 提示
        try {
          const parsed = JSON.parse(feishuPostContent);
          reqBody.post = {
            ...(feishuPostTitle ? { title: feishuPostTitle } : {}),
            content: parsed,
          };
        } catch {
          setFeishuWebhookMessage(
            `post.content JSON 解析失败，请检查 textarea —— 用 [ [ {tag,text} ], ... ] 二维数组格式`
          );
          setFeishuWebhookTesting(false);
          return;
        }
      }
      const res = await fetch("/api/user/notify-feishu/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeishuWebhookMessage(`发送失败：${data.error || res.statusText}`);
        return;
      }
      if (data.sent) {
        setFeishuWebhookMessage(
          `已发送到 ${data.masked_url || "飞书群"}，请查收。HTTP 状态：${data.status || "已接受"}`
        );
      } else {
        setFeishuWebhookMessage(`未发送：${data.reason || "未知原因"}`);
      }
    } catch (err) {
      setFeishuWebhookMessage(`发送失败：${(err as Error).message}`);
    } finally {
      setFeishuWebhookTesting(false);
    }
  }

  async function fetchConfig() {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      setConfig(data);
      // 用服务端回的边界夹取, 不写死 —— 之前前端固定夹到 5, 而后端允许到 10,
      // 并发落库后这会让「API 设过 8 的实例, 管理员一进设置页保存就被降到 5」。
      setConcurrency(
        Math.min(data.concurrency_max ?? 10, Math.max(data.concurrency_min ?? 1, data.concurrency))
      );
      setTimeoutInput(String(data.task_timeout_minutes ?? 30));
      // R18 P2: 同步端口池草稿. 后端回 [[start,end], ...]; 直接 setState 即可,
      // 编辑态只在「保存」时写回, 切换 tab 不丢.
      if (Array.isArray(data.port_pool) && data.port_pool.length > 0) {
        setPoolDraft(
          data.port_pool.map(
            (seg: number[]) => [Number(seg[0]), Number(seg[1])] as [number, number],
          ),
        );
      }
    } catch (err) {
      setMessage("加载配置失败");
    }
  }

  async function fetchLlmConfigs() {
    try {
      const [user, avail] = await Promise.all([
        fetch("/api/user/llm-config").then((r) => r.json()),
        fetch("/api/user/llm-config/available").then((r) => r.json()),
      ]);
      setLlmConfigs(user.configs || []);
      setAvailableLlmConfigs(avail.configs || []);
    } catch (err) {
      // Silently fail — user config is optional
    }
  }

  async function fetchAdminLlmConfigs() {
    try {
      const res = await fetch("/api/admin/llm-config");
      const data = await res.json();
      setAdminLlmConfigs(data.configs || []);
    } catch {
      // Silently fail
    }
  }

  async function fetchMediaKey() {
    try {
      const res = await fetch("/api/user/media-key");
      const data: MediaKeySafe = await res.json();
      setMediaKey(data);
      setRegionInput((data.region as "cn" | "global") || "cn");
    } catch {
      // 静默失败 — media key 是可选配置
    }
  }

  async function fetchGrants() {
    try {
      const res = await fetch("/api/admin/llm-grants");
      const data = await res.json();
      setGrants(data.users || []);
    } catch {
      // Silently fail
    }
  }

  // v55+ R88 quota: 拉全部 user + 配额 4 字段 + 累计费用. admin only.
  async function fetchQuotaUsers() {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) return; // 非 admin / 未登录
      const data = await res.json();
      setQuotaUsers(data.users || []);
    } catch {
      // Silently fail
    }
  }

  // v55+ R88 quota: 单个 user 的变更历史. 按需 lazy fetch, 不在 fetchQuotaUsers 里批量拿
  //   (避免 N+1 —— 100 user × 50 条 = 5000 行 JSON, 不必要).
  async function fetchQuotaLog(userId: string) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/quota-log?limit=50`);
      if (!res.ok) {
        setQuotaMessage(`❌ 拉变更历史失败: ${res.statusText}`);
        return;
      }
      const data = await res.json();
      setQuotaLogByUser((prev) => ({ ...prev, [userId]: data.log || [] }));
    } catch (err) {
      setQuotaMessage(`❌ ${(err as Error).message}`);
    }
  }

  // v55+ R88 quota: PATCH 单个 user 的配额 4 字段. body 只传改了的字段, undefined
  //   = 不改; null = 清空. 后端按字段分别调 setter.
  async function saveQuota(
    userId: string,
    patch: {
      party_a_enabled?: boolean;
      quota_total_spent_cap?: number | null;
      quota_granted_cap?: number | null;
      quota_expire_at?: string | null;
      reason?: string | null;
    }
  ) {
    setQuotaSaving((prev) => ({ ...prev, [userId]: true }));
    setQuotaMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        setQuotaMessage(`❌ ${data.error || res.statusText}`);
        return;
      }
      setQuotaMessage(`✅ 已更新 ${userId.slice(0, 8)} 的配额`);
      await fetchQuotaUsers();
    } catch (err) {
      setQuotaMessage(`❌ ${(err as Error).message}`);
    } finally {
      setQuotaSaving((prev) => ({ ...prev, [userId]: false }));
    }
  }

  async function fetchMaintenance() {
    try {
      const res = await fetch("/api/admin/maintenance");
      if (!res.ok) return; // 非 admin / 未登录 —— 整块 UI 不渲染
      setMaintenance(await res.json());
    } catch {
      // Silently fail — 维护状态读不到不该挡住整个设置页
    }
  }

  // 功能: 进入/退出维护模式. enter 走 ConfirmDialog 二次确认(影响全平台所有租户).
  // 关注点: 关停会打断 running 任务当前那一轮, 但 session_id 保住 => 恢复可续
  //   完整 transcript. 结果摘要写进 maintenanceMessage, 失败如实显示后端 error.
  async function callMaintenance(action: "enter" | "exit") {
    setMaintenanceBusy(true);
    setMaintenanceMessage(null);
    try {
      const res = await fetch(`/api/admin/maintenance/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "enter" ? JSON.stringify({ reason: "手动关停（设置页）" }) : undefined,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMaintenanceMessage(`❌ ${data.error || res.statusText}`);
        return;
      }
      const c = data.counts || {};
      if (action === "enter") {
        setMaintenanceMessage(
          (data.already ? "ℹ️ 已处于维护模式（未重复关停）" : "🔧 已进入维护模式") +
            `：pause ${c.paused ?? 0} 个运行中、摘下 ${c.dequeued ?? 0} 个排队` +
            (c.failed ? `，${c.failed} 个失败（不可恢复）` : "")
        );
      } else {
        setMaintenanceMessage(
          "✅ 已退出维护模式" +
            `：恢复 ${c.resumed ?? 0} 个、重新入队 ${c.requeued ?? 0} 个` +
            (c.skipped ? `，跳过 ${c.skipped} 个（已被手动处理）` : "") +
            (c.failed ? `，${c.failed} 个失败` : "")
        );
      }
      await fetchMaintenance();
      await fetchConfig();
    } catch (err) {
      setMaintenanceMessage(`❌ ${(err as Error).message}`);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  function handleEnterMaintenance() {
    setPendingConfirm({
      title: "进入维护模式",
      message:
        "将暂停全平台所有租户的任务调度：运行中的任务会被挂起（当前这一轮会被打断，但上下文保留，恢复后可续），排队中的任务会被摘下队列。适合部署前使用。",
      confirmLabel: "关停",
      variant: "danger",
      onConfirm: () => {
        void callMaintenance("enter");
      },
    });
  }

  async function handleSave() {
    // 前端先校验一遍给即时反馈; 服务端仍会独立校验(前端校验只是体验, 不是边界)。
    const minutes = Number(timeoutInput);
    const lo = config?.task_timeout_min ?? 1;
    const hi = config?.task_timeout_max ?? 1440;
    if (!Number.isInteger(minutes) || minutes < lo || minutes > hi) {
      setMessage(`任务超时必须是 ${lo}-${hi} 的整数（分钟）`);
      return;
    }
    // R18 P2: 端口池本地校验 (服务端会二次校验, 错误信息更准).
    const portLo = config?.port_pool_min ?? 1024;
    const portHi = config?.port_pool_max ?? 65535;
    const maxSegs = config?.port_pool_max_segments ?? 8;
    if (poolDraft.length === 0) {
      setMessage("端口池至少 1 段");
      return;
    }
    if (poolDraft.length > maxSegs) {
      setMessage(`端口池最多 ${maxSegs} 段, 当前 ${poolDraft.length}`);
      return;
    }
    for (let i = 0; i < poolDraft.length; i++) {
      const [a, b] = poolDraft[i];
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < portLo || b > portHi || a > b) {
        setMessage(
          `端口池第 ${i + 1} 段非法: 需 ${portLo}-${portHi} 整数且 start<=end`,
        );
        return;
      }
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concurrency,
          task_timeout_minutes: minutes,
          // R18 P2: 把草稿的 [[a,b],...] 透传. 后端 setPortPool 会再校验.
          port_pool: poolDraft.map(([a, b]) => [a, b]),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setConfig(data);
        setTimeoutInput(String(data.task_timeout_minutes));
        setMessage("✅ 配置已保存");
      } else {
        setMessage(data.error || "保存失败");
      }
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleLlmSave() {
    setLlmSaving(true);
    setLlmMessage(null);
    try {
      const body: Record<string, unknown> = {
        name: llmDraft.name.trim(),
        base_url: llmDraft.base_url || null,
        model: llmDraft.model || null,
      };
      if (llmDraft.clear_api_key) {
        body.clear_api_key = true;
      } else if (llmDraft.api_key.trim()) {
        body.api_key = llmDraft.api_key.trim();
      }
      let res: Response;
      if (editingLlmId === "new") {
        res = await fetch("/api/user/llm-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (editingLlmId) {
        res = await fetch(`/api/user/llm-config/${editingLlmId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        setLlmMessage("无正在编辑的配置");
        setLlmSaving(false);
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setLlmMessage("✅ 已保存");
        setEditingLlmId(null);
        setLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
        await fetchLlmConfigs();
      } else {
        setLlmMessage(data.error || "保存失败");
      }
    } catch (err: any) {
      setLlmMessage(err.message);
    } finally {
      setLlmSaving(false);
    }
  }

  async function handleDuplicateLlmConfig(id: string, name: string) {
    setLlmSaving(true);
    setLlmMessage(null);
    try {
      const res = await fetch(`/api/user/llm-config/${id}/duplicate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setLlmMessage(`✅ 已拷贝为「${data.name}」`);
        await fetchLlmConfigs();
      } else {
        setLlmMessage(data.error || "拷贝失败");
      }
    } catch (err: any) {
      setLlmMessage(err.message);
    } finally {
      setLlmSaving(false);
    }
  }

  // 功能: 把当前行的配置拼成多行文本塞剪贴板 (用于人工搬运 / 备份到别的工具).
  // 关注点: api_key 只能复制脱敏值 (sk-xxx…****), 明文不让出页面 (加密落库, 解密只在
  //   服务端 resolve 路径). 拼成 markdown 风格表, 粘贴到任意文本编辑器都易读.
  async function handleCopyLlmConfigText(cfg: LlmConfigSafe) {
    const lines = [
      `名称: ${cfg.name}`,
      `Base URL: ${cfg.base_url || "(默认)"}`,
      `Model: ${cfg.model || "(默认)"}`,
      `API Key: ${cfg.has_api_key ? cfg.api_key_masked : "(未配)"}`,
      `类型: ${cfg.type}`,
      cfg.is_default ? `状态: 默认` : `状态: 普通`,
    ];
    try {
      await copyTextToClipboard(lines.join("\n"));
      setLlmMessage(`✅ 已复制「${cfg.name}」到剪贴板`);
    } catch (err: any) {
      setLlmMessage(`❌ 复制失败：${err.message}`);
    }
  }

  async function handleSetLlmDefault(id: string) {
    setLlmSaving(true);
    setLlmMessage(null);
    try {
      const res = await fetch(`/api/user/llm-config/${id}/default`, { method: "POST" });
      if (res.ok) {
        setLlmMessage("✅ 已设为默认");
        await fetchLlmConfigs();
      } else {
        const data = await res.json();
        setLlmMessage(data.error || "设置失败");
      }
    } catch (err: any) {
      setLlmMessage(err.message);
    } finally {
      setLlmSaving(false);
    }
  }

  function handleDeleteLlmConfig(id: string, name: string) {
    setPendingConfirm({
      title: `删除「${name}」`,
      message: "确定要删除这份 LLM 配置？默认配置需要先切换默认才能删除。",
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        setLlmSaving(true);
        setLlmMessage(null);
        try {
          const res = await fetch(`/api/user/llm-config/${id}`, { method: "DELETE" });
          if (res.ok) {
            setLlmMessage("✅ 已删除");
            await fetchLlmConfigs();
          } else {
            const data = await res.json();
            setLlmMessage(data.error || "删除失败");
          }
        } catch (err: any) {
          setLlmMessage(err.message);
        } finally {
          setLlmSaving(false);
        }
      },
    });
  }

  function startEditLlm(cfg: LlmConfigSafe | "new") {
    if (cfg === "new") {
      setEditingLlmId("new");
      setLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
    } else {
      setEditingLlmId(cfg.id);
      setLlmDraft({ name: cfg.name, base_url: cfg.base_url || "", model: cfg.model || "", api_key: "", clear_api_key: false });
    }
  }

  // ---- 多模态 API Key (mmx-cli) handlers ----

  async function handleMediaKeySave() {
    setMediaSaving(true);
    setMediaMessage(null);
    try {
      const body: Record<string, unknown> = {};
      // 只在用户填了新 key 时带 api_key; 否则只更新 region (类比 LLM-config).
      if (mediaKeyInput.trim()) {
        body.api_key = mediaKeyInput.trim();
      }
      if (regionInput !== (mediaKey?.region || "cn")) {
        body.region = regionInput;
      }
      if (Object.keys(body).length === 0) {
        setMediaMessage("无需更新");
        setMediaSaving(false);
        return;
      }
      const res = await fetch("/api/user/media-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: MediaKeySafe & { error?: string; mmx_warning?: string } = await res.json();
      if (res.ok) {
        setMediaKey(data);
        setShowMediaKeyInput(false);
        setMediaKeyInput("");
        if (data.mmx_warning) {
          // DB 存了, 但 mmx 写 config.json 失败 — 不算 fatal, 提示但不挡
          setMediaMessage(`⚠️ DB 已保存, 但 mmx 配置写入失败: ${data.mmx_warning}`);
        } else {
          setMediaMessage("✅ 多模态 API Key 已保存 (mmx 配置已就绪)");
        }
      } else {
        setMediaMessage(data.error || "保存失败");
      }
    } catch (err: any) {
      setMediaMessage(err.message);
    } finally {
      setMediaSaving(false);
    }
  }

  async function handleClearMediaKey() {
    setMediaSaving(true);
    setMediaMessage(null);
    try {
      const res = await fetch("/api/user/media-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_api_key: true }),
      });
      const data: MediaKeySafe & { error?: string } = await res.json();
      if (res.ok) {
        setMediaKey(data);
        setShowMediaKeyInput(false);
        setMediaKeyInput("");
        setMediaMessage("✅ API Key 已清除 (mmx 配置目录也已清理)");
      } else {
        setMediaMessage(data.error || "清除失败");
      }
    } catch (err: any) {
      setMediaMessage(err.message);
    } finally {
      setMediaSaving(false);
    }
  }

  function handleDeleteMediaKey() {
    setPendingConfirm({
      title: "删除多模态 API Key",
      message: "确定要删除多模态 API Key 配置？将无法在任务中使用 mmx-cli 生成图片/视频/音乐。",
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        setMediaSaving(true);
        setMediaMessage(null);
        try {
          const res = await fetch("/api/user/media-key", { method: "DELETE" });
          if (res.ok) {
            setMediaKey(null);
            setMediaKeyInput("");
            setRegionInput("cn");
            setShowMediaKeyInput(false);
            setMediaMessage("✅ 多模态 API Key 已删除");
          } else {
            const data = await res.json();
            setMediaMessage(data.error || "删除失败");
          }
        } catch (err: any) {
          setMediaMessage(err.message);
        } finally {
          setMediaSaving(false);
        }
      },
    });
  }

  async function handleTestMediaKey() {
    // 后端在临时目录跑 mmx auth login + quota, 不污染用户目录.
    // mmx 未装 / 网络挂都返清晰 reason, UI 提示.
    setMediaTesting(true);
    setMediaMessage(null);
    try {
      const res = await fetch("/api/user/media-key/test", { method: "POST" });
      const data: { ok: boolean; reason?: string; quota_stdout?: string } = await res.json();
      if (res.ok && data.ok) {
        setMediaMessage("✅ 测试通过 (mmx quota 正常)");
      } else {
        setMediaMessage(`❌ ${data.reason || "测试失败"}`);
      }
    } catch (err: any) {
      setMediaMessage(`❌ ${err.message}`);
    } finally {
      setMediaTesting(false);
    }
  }

  // Admin LLM config handlers
  async function handleAdminLlmSave() {
    setAdminLlmSaving(true);
    setAdminLlmMessage(null);
    try {
      const body: Record<string, unknown> = {
        name: adminLlmDraft.name.trim(),
        base_url: adminLlmDraft.base_url || null,
        model: adminLlmDraft.model || null,
      };
      if (adminLlmDraft.clear_api_key) {
        body.clear_api_key = true;
      } else if (adminLlmDraft.api_key.trim()) {
        body.api_key = adminLlmDraft.api_key.trim();
      }
      let res: Response;
      if (editingAdminLlmId === "new") {
        res = await fetch("/api/admin/llm-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (editingAdminLlmId) {
        res = await fetch(`/api/admin/llm-config/${editingAdminLlmId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        setAdminLlmMessage("无正在编辑的配置");
        setAdminLlmSaving(false);
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setAdminLlmMessage("✅ 已保存");
        setEditingAdminLlmId(null);
        setAdminLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
        await fetchAdminLlmConfigs();
        await fetchLlmConfigs(); // refresh available list since admin list may be included
      } else {
        setAdminLlmMessage(data.error || "保存失败");
      }
    } catch (err: any) {
      setAdminLlmMessage(err.message);
    } finally {
      setAdminLlmSaving(false);
    }
  }

  async function handleDuplicateAdminLlmConfig(id: string, name: string) {
    setAdminLlmSaving(true);
    setAdminLlmMessage(null);
    try {
      const res = await fetch(`/api/admin/llm-config/${id}/duplicate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setAdminLlmMessage(`✅ 已拷贝为「${data.name}」`);
        await fetchAdminLlmConfigs();
      } else {
        setAdminLlmMessage(data.error || "拷贝失败");
      }
    } catch (err: any) {
      setAdminLlmMessage(err.message);
    } finally {
      setAdminLlmSaving(false);
    }
  }

  async function handleCopyAdminLlmConfigText(cfg: LlmConfigSafe) {
    const lines = [
      `[平台配置] ${cfg.name}`,
      `Base URL: ${cfg.base_url || "(默认)"}`,
      `Model: ${cfg.model || "(默认)"}`,
      `API Key: ${cfg.has_api_key ? cfg.api_key_masked : "(未配)"}`,
      `类型: ${cfg.type}`,
      cfg.is_default ? `状态: 平台默认` : `状态: 普通`,
    ];
    try {
      await copyTextToClipboard(lines.join("\n"));
      setAdminLlmMessage(`✅ 已复制「${cfg.name}」到剪贴板`);
    } catch (err: any) {
      setAdminLlmMessage(`❌ 复制失败：${err.message}`);
    }
  }

  async function handleSetAdminLlmDefault(id: string) {
    setAdminLlmSaving(true);
    setAdminLlmMessage(null);
    try {
      const res = await fetch(`/api/admin/llm-config/${id}/default`, { method: "POST" });
      if (res.ok) {
        setAdminLlmMessage("✅ 已设为平台默认");
        await fetchAdminLlmConfigs();
      } else {
        const data = await res.json();
        setAdminLlmMessage(data.error || "设置失败");
      }
    } catch (err: any) {
      setAdminLlmMessage(err.message);
    } finally {
      setAdminLlmSaving(false);
    }
  }

  function handleDeleteAdminLlmConfig(id: string, name: string) {
    setPendingConfirm({
      title: `删除平台配置「${name}」`,
      message: "确定要删除？默认配置需要先切换默认才能删除。",
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        setAdminLlmSaving(true);
        setAdminLlmMessage(null);
        try {
          const res = await fetch(`/api/admin/llm-config/${id}`, { method: "DELETE" });
          if (res.ok) {
            setAdminLlmMessage("✅ 已删除");
            await fetchAdminLlmConfigs();
          } else {
            const data = await res.json();
            setAdminLlmMessage(data.error || "删除失败");
          }
        } catch (err: any) {
          setAdminLlmMessage(err.message);
        } finally {
          setAdminLlmSaving(false);
        }
      },
    });
  }

  function startEditAdminLlm(cfg: LlmConfigSafe | "new") {
    if (cfg === "new") {
      setEditingAdminLlmId("new");
      setAdminLlmDraft({ name: "", base_url: "", model: "", api_key: "", clear_api_key: false });
    } else {
      setEditingAdminLlmId(cfg.id);
      setAdminLlmDraft({ name: cfg.name, base_url: cfg.base_url || "", model: cfg.model || "", api_key: "", clear_api_key: false });
    }
  }

  // Grant toggle handler
  async function handleGrantToggle(userId: string, enabled: boolean) {
    setGrantsSaving(true);
    setGrantsMessage(null);
    try {
      const res = await fetch("/api/admin/llm-grants", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, enabled }),
      });
      const data = await res.json();
      if (res.ok) {
        setGrants(data.users || []);
        setGrantsMessage(enabled ? "✅ 已授权" : "✅ 已禁用");
      } else {
        setGrantsMessage(data.error || "操作失败");
      }
    } catch (err: any) {
      setGrantsMessage(err.message);
    } finally {
      setGrantsSaving(false);
    }
  }

  // Per-user concurrency cap save (v30). Fired onBlur from the number input.
  // Empty = null (unlimited). No-op if unchanged.
  async function saveConcurrency(userId: string, value: string) {
    const trimmed = value.trim();
    const n: number | null = trimmed === "" ? null : Number(trimmed);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 10)) {
      setConcurrencyStatus((prev) => ({ ...prev, [userId]: "error" }));
      return;
    }
    const current = grants.find((g) => g.id === userId)?.max_concurrency ?? null;
    if (n === current) return; // no change
    setConcurrencyStatus((prev) => ({ ...prev, [userId]: "saving" }));
    setGrantsMessage(null);
    try {
      const res = await fetch("/api/admin/llm-grants", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, max_concurrency: n }),
      });
      const data = await res.json();
      if (res.ok) {
        setGrants(data.users || []);
        setConcurrencyStatus((prev) => ({ ...prev, [userId]: "saved" }));
        setTimeout(() => {
          setConcurrencyStatus((prev) => {
            const next = { ...prev };
            delete next[userId];
            return next;
          });
        }, 1500);
      } else {
        setConcurrencyStatus((prev) => ({ ...prev, [userId]: "error" }));
        setGrantsMessage(data.error || "保存失败");
      }
    } catch (err: any) {
      setConcurrencyStatus((prev) => ({ ...prev, [userId]: "error" }));
      setGrantsMessage(err.message);
    }
  }

  // API token handlers
  async function fetchApiTokens() {
    try {
      const res = await fetch("/api/api-tokens");
      const data = await res.json();
      setApiTokens(data.tokens || []);
      // 列表刷新后清掉已选 id（防 ids 引用已删除的行）
      setSelectedTokenIds(new Set());
    } catch {
      // Silently fail
    }
  }

  async function handleCreateApiToken() {
    setTokenSaving(true);
    setTokenMessage(null);
    try {
      const res = await fetch("/api/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreatedToken(data.token);
        setNewTokenName("");
        fetchApiTokens();
        setTransientTokenMessage("✅ Token 已创建，请立即复制（仅显示一次）");
      } else {
        setTokenMessage(data.error || "创建失败");
      }
    } catch (err: any) {
      setTokenMessage(err.message);
    } finally {
      setTokenSaving(false);
    }
  }

  function handleDeleteApiToken(id: string, name: string) {
    setPendingConfirm({
      title: "删除 Token",
      message: `确定删除 token "${name}"？注意：token 仍有效直到服务端轮换 JWT_SECRET。`,
      confirmLabel: "删除",
      variant: "danger",
      onConfirm: async () => {
        setTokenSaving(true);
        setTokenMessage(null);
        try {
          const res = await fetch(`/api/api-tokens/${id}`, { method: "DELETE" });
          if (res.ok) {
            fetchApiTokens();
            setTransientTokenMessage("✅ 已删除");
          } else {
            const data = await res.json();
            setTokenMessage(data.error || "删除失败");
          }
        } catch (err: any) {
          setTokenMessage(err.message);
        } finally {
          setTokenSaving(false);
        }
      },
    });
  }

  // 批量选择 — 沿用 board-client.tsx 的 Set + toggle 模式
  function toggleSelectToken(id: string) {
    setSelectedTokenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAllFiltered() {
    if (allFilteredSelected) {
      setSelectedTokenIds(new Set());
    } else {
      setSelectedTokenIds(new Set(filteredTokens.map((t) => t.id)));
    }
  }

  // 批量删除：用 filtered 集合过滤 selected 避免误删搜索框没显示的旧 token
  function handleBatchDeleteApiTokens() {
    const targetIds = Array.from(selectedTokenIds).filter((id) =>
      filteredTokens.some((t) => t.id === id)
    );
    if (targetIds.length === 0) return;
    const includesSwitch = targetIds.some(
      (id) => filteredTokens.find((t) => t.id === id)?.name === "switch-account"
    );
    const message = includesSwitch
      ? `确定批量删除 ${targetIds.length} 个 token？其中包含 switch-account（删除后下次登录会自动重建）。Token 元数据行删除后 JWT 在轮换 JWT_SECRET 前仍有效。`
      : `确定批量删除 ${targetIds.length} 个 token？删除后 JWT 在轮换 JWT_SECRET 前仍有效。`;
    setPendingConfirm({
      title: `批量删除 ${targetIds.length} 个 Token`,
      message,
      confirmLabel: "批量删除",
      variant: "danger",
      onConfirm: async () => {
        setTokenSaving(true);
        setTokenMessage(null);
        try {
          const res = await fetch("/api/api-tokens/delete-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: targetIds }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            setSelectedTokenIds(new Set());
            fetchApiTokens();
            setTransientTokenMessage(
              `✅ 已删除 ${data.deleted} / ${data.requested}`
            );
          } else {
            setTokenMessage(data.error || "批量删除失败");
          }
        } catch (err: any) {
          setTokenMessage(err.message);
        } finally {
          setTokenSaving(false);
        }
      },
    });
  }

  return (
    // 🆕 飞书 R139 第四批: /settings 右滚修复——根 plain div 无 overflow, 加 h-full overflow-y-auto.
    <div className="h-full overflow-y-auto max-w-2xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">设置</h1>
        <a href="/" className="text-blue-600 text-sm hover:underline">← 返回</a>
      </div>

      {config ? (
        <>
          {/* v54 拆 tab (R17): tab header */}
          <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
            {(
              [
                { id: "account" as const, label: "账户" },
                { id: "notify" as const, label: "通知" },
                { id: "schedule" as const, label: "调度" },
                ...(isAdmin ? [{ id: "platform" as const, label: "平台管理" }] : []),
              ]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === t.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-600 hover:text-gray-900"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

        <div className="space-y-6">
          {/* API Configuration (env-level) — platform tab (hidden if other tab active) */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "platform" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-3">系统 API 配置（环境变量）</h2>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${config.api_key_configured ? "bg-green-500" : "bg-red-500"}`} />
                <span className="text-sm">
                  {config.api_key_configured
                    ? "ANTHROPIC_API_KEY 已配置"
                    : "ANTHROPIC_API_KEY 未配置 — agent 无法运行"}
                </span>
              </div>
              <div className="text-sm text-gray-600">
                Base URL: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{config.base_url}</code>
              </div>
              {config.model && (
                <div className="text-sm text-gray-600">
                  默认模型: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{config.model}</code>
                </div>
              )}
            </div>
            {!config.api_key_configured && (
              <p className="text-xs text-gray-500 mt-2">
                设置环境变量 ANTHROPIC_API_KEY 后重启服务
              </p>
            )}
            <div className="mt-3 p-2 bg-gray-50 rounded text-xs text-gray-500 font-mono">
              ANTHROPIC_API_KEY=*** ANTHROPIC_BASE_URL={config.base_url}
            </div>
            <p className="text-xs text-amber-600 mt-2">
              ⚠️ 环境变量中的 API Key 仅作系统级 fallback，普通用户必须配置自己的 API Key 或被管理员授权才能运行任务
            </p>
          </div>

          {/* Admin: Platform LLM Configuration (v50: 多配置 + list) */}
          {isAdmin && (
            <div className={`bg-white rounded-lg border border-blue-200 p-4 ${activeTab !== "platform" ? "hidden" : ""}`}>
              <h2 className="font-medium text-gray-900 mb-1">🔑 平台 LLM 配置 <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">管理员</span></h2>
              <p className="text-xs text-gray-500 mb-3">
                可配多份平台 LLM 配置（如「Claude 生产」/「火山方舟测试」），授权用户能看到完整列表并选用其一；选一份作为平台默认。
              </p>

              {/* 已有配置列表 */}
              {adminLlmConfigs.length > 0 && (
                <table className="w-full text-sm mb-4">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b">
                      <th className="py-2">名称</th>
                      <th className="py-2">Base URL</th>
                      <th className="py-2">Model</th>
                      <th className="py-2">Key</th>
                      <th className="py-2">默认</th>
                      <th className="py-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminLlmConfigs.map((cfg) => (
                      <tr key={cfg.id} className="border-b last:border-b-0">
                        <td className="py-2 font-medium">{cfg.name}</td>
                        <td className="py-2 text-xs text-gray-600 max-w-[150px] truncate" title={cfg.base_url || ""}>
                          {cfg.base_url || "—"}
                        </td>
                        <td className="py-2 text-xs max-w-[160px] truncate" title={cfg.model || ""}>{cfg.model || "—"}</td>
                        <td className="py-2 text-xs">
                          {cfg.has_api_key
                            ? <code className="bg-gray-100 px-1 py-0.5 rounded">{cfg.api_key_masked}</code>
                            : <span className="text-red-500">未配</span>}
                        </td>
                        <td className="py-2">
                          {cfg.is_default
                            ? <span className="inline-block bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded">默认</span>
                            : <button
                                onClick={() => handleSetAdminLlmDefault(cfg.id)}
                                disabled={adminLlmSaving}
                                className="text-xs text-blue-600 hover:underline"
                              >设为默认</button>}
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => startEditAdminLlm(cfg)}
                            className="text-xs text-blue-600 hover:underline mr-2"
                          >编辑</button>
                          <button
                            onClick={() => handleDuplicateAdminLlmConfig(cfg.id, cfg.name)}
                            disabled={adminLlmSaving}
                            className="text-xs text-blue-600 hover:underline mr-2"
                          >拷贝</button>
                          <button
                            onClick={() => handleCopyAdminLlmConfigText(cfg)}
                            disabled={adminLlmSaving}
                            title="把这一行配置复制成文本到剪贴板"
                            className="text-xs text-gray-600 hover:underline mr-2"
                          >📋 复制</button>
                          <button
                            onClick={() => handleDeleteAdminLlmConfig(cfg.id, cfg.name)}
                            disabled={cfg.is_default || adminLlmSaving}
                            className="text-xs text-red-600 hover:underline disabled:opacity-30"
                          >删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* 新增 / 编辑表单 */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium">
                    {editingAdminLlmId === "new" ? "新增平台配置" : editingAdminLlmId ? "编辑平台配置" : ""}
                  </h3>
                  {editingAdminLlmId === null && (
                    <button
                      onClick={() => startEditAdminLlm("new")}
                      className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700"
                    >+ 新增配置</button>
                  )}
                </div>
                {editingAdminLlmId !== null && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">名称 *</label>
                      <input
                        type="text"
                        value={adminLlmDraft.name}
                        onChange={(e) => setAdminLlmDraft({ ...adminLlmDraft, name: e.target.value })}
                        placeholder="如：Claude 生产 / 火山方舟测试"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Base URL</label>
                      <input
                        type="text"
                        value={adminLlmDraft.base_url}
                        onChange={(e) => setAdminLlmDraft({ ...adminLlmDraft, base_url: e.target.value })}
                        placeholder={config?.base_url || "https://api.anthropic.com"}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                      <input
                        type="text"
                        value={adminLlmDraft.model}
                        onChange={(e) => setAdminLlmDraft({ ...adminLlmDraft, model: e.target.value })}
                        list="admin-llm-model-options"
                        placeholder="选择或输入自定义模型名"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                      <datalist id="admin-llm-model-options">
                        {modelStringList.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">API Key</label>
                      <input
                        type="password"
                        value={adminLlmDraft.api_key}
                        onChange={(e) => setAdminLlmDraft({ ...adminLlmDraft, api_key: e.target.value, clear_api_key: false })}
                        placeholder={editingAdminLlmId !== "new" ? "留空保留现有 key" : "输入平台 API Key"}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                      {editingAdminLlmId !== "new" && (
                        <label className="text-xs text-gray-600 mt-1 inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={adminLlmDraft.clear_api_key}
                            onChange={(e) => setAdminLlmDraft({ ...adminLlmDraft, clear_api_key: e.target.checked })}
                          />
                          清除现有 key
                        </label>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleAdminLlmSave}
                        disabled={adminLlmSaving || !adminLlmDraft.name.trim()}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                      >
                        {adminLlmSaving ? "保存中..." : "保存"}
                      </button>
                      <button
                        onClick={() => { setEditingAdminLlmId(null); setAdminLlmMessage(null); }}
                        className="border px-4 py-2 rounded-lg text-sm hover:bg-gray-50"
                      >取消</button>
                      {adminLlmMessage && <span className="text-sm">{adminLlmMessage}</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Admin: User Grants (LLM authorization + per-user concurrency cap) */}
          {isAdmin && (
            <div className={`bg-white rounded-lg border border-blue-200 p-4 ${activeTab !== "platform" ? "hidden" : ""}`}>
              <h2 className="font-medium text-gray-900 mb-1">👥 用户授权 <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">管理员</span></h2>
              <p className="text-xs text-gray-500 mb-3">
                授权用户使用平台 LLM 配置，并可设置每账号并发上限（留空=不限，仍受全局总闸约束）。管理员默认可用，无需授权。
              </p>

              {grants.length === 0 ? (
                <div className="text-sm text-gray-400 py-2">暂无其他用户</div>
              ) : (
                <>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-2 pb-1 text-xs text-gray-400 border-b">
                      <span>用户</span>
                      <div className="flex items-center gap-3">
                        <span>并发上限</span>
                        <span className="w-9 text-right">授权</span>
                      </div>
                    </div>
                    {pagedGrants.map((u) => (
                      <div key={u.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm text-gray-800 truncate">{u.email}</span>
                          {u.role === "admin" && (
                            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded shrink-0">管理员</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={1}
                              max={10}
                              defaultValue={u.max_concurrency ?? ""}
                              placeholder="不限"
                              onBlur={(e) => saveConcurrency(u.id, e.target.value)}
                              className="w-16 border rounded px-2 py-1 text-sm text-center"
                              aria-label={`${u.email} 并发上限`}
                            />
                            {concurrencyStatus[u.id] === "saving" && <span className="text-xs text-gray-400">…</span>}
                            {concurrencyStatus[u.id] === "saved" && <span className="text-xs text-green-600">✓</span>}
                            {concurrencyStatus[u.id] === "error" && <span className="text-xs text-red-600">✗</span>}
                          </div>
                          {u.role === "admin" ? (
                            <span className="text-xs text-gray-400 w-9 text-right">默认</span>
                          ) : (
                            <label className="relative inline-flex items-center cursor-pointer w-9">
                              <input
                                type="checkbox"
                                checked={u.granted}
                                onChange={(e) => handleGrantToggle(u.id, e.target.checked)}
                                disabled={grantsSaving}
                                className="sr-only peer"
                              />
                              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                            </label>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {totalGrantPages > 1 && (
                    <div className="flex items-center justify-center gap-3 mt-3 text-sm">
                      <button
                        onClick={() => setGrantsPage((p) => Math.max(0, p - 1))}
                        disabled={safeGrantsPage === 0}
                        className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                      >
                        上一页
                      </button>
                      <span className="text-gray-600">
                        {safeGrantsPage + 1} / {totalGrantPages}
                      </span>
                      <button
                        onClick={() => setGrantsPage((p) => Math.min(totalGrantPages - 1, p + 1))}
                        disabled={safeGrantsPage >= totalGrantPages - 1}
                        className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                      >
                        下一页
                      </button>
                    </div>
                  )}
                </>
              )}

              {grantsMessage && (
                <div className="mt-2 text-sm">{grantsMessage}</div>
              )}
            </div>
          )}

          {/* v55+ R88 配额管理 - admin 卡片 (Sheet L 验收 ④)
              - 复用 👥 用户授权的列表风格: 每用户一行 + inline 编辑 + 进度条
              - 4 字段独立编辑 (party_a_enabled 开关 + cap 数字 + granted_cap 数字 + expire_at)
              - 「查看变更历史」按钮触发 fetchQuotaLog + 展开面板 */}
          {isAdmin && (
            <div className={`bg-white rounded-lg border border-blue-200 p-4 ${activeTab !== "platform" ? "hidden" : ""}`}>
              <h2 className="font-medium text-gray-900 mb-1">
                💰 账号配额 <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">管理员</span>
              </h2>
              <p className="text-xs text-gray-500 mb-3">
                标记为甲方的用户 (party_a_enabled=1) 才会按 R88 三件套拦截。granted_cap 仅展示不参与拦截。
              </p>

              {quotaMessage && (
                <div className="text-sm mb-2">{quotaMessage}</div>
              )}

              {quotaUsers.length === 0 ? (
                <div className="text-sm text-gray-400 py-2">暂无用户</div>
              ) : (
                <div className="space-y-2">
                  {quotaUsers.map((u) => {
                    const used = u.used_total_usd || 0;
                    const cap = u.quota_total_spent_cap;
                    const pct = cap && cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
                    const isPartyA = u.party_a_enabled;
                    const isOverCap = cap !== null && cap !== undefined && cap > 0 && used >= cap;
                    const isNearCap = cap !== null && cap !== undefined && cap > 0 && !isOverCap && pct >= 80;
                    return (
                      <div key={u.id} className="border rounded p-3 bg-gray-50">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm text-gray-800 truncate">{u.email}</span>
                            {u.role === "admin" && (
                              <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded shrink-0">管理员</span>
                            )}
                            {isPartyA && (
                              <span className="text-xs bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded shrink-0">甲方</span>
                            )}
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer shrink-0">
                            <input
                              type="checkbox"
                              checked={isPartyA}
                              onChange={(e) => saveQuota(u.id, { party_a_enabled: e.target.checked })}
                              disabled={!!quotaSaving[u.id]}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500 peer-disabled:opacity-50"></div>
                          </label>
                        </div>

                        {isPartyA && cap !== null && cap !== undefined && cap > 0 && (
                          <div className="mb-2">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="text-gray-600">
                                已用 ${used.toFixed(2)} / 上限 ${cap.toFixed(2)}
                              </span>
                              <span className={`font-medium ${isOverCap ? "text-red-600" : isNearCap ? "text-amber-600" : "text-gray-500"}`}>
                                {pct.toFixed(0)}%
                              </span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                              <div
                                className={`h-full ${isOverCap ? "bg-red-500" : isNearCap ? "bg-amber-500" : "bg-blue-500"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                          <label className="flex flex-col gap-1">
                            <span className="text-gray-500">费用上限 (USD)</span>
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              defaultValue={u.quota_total_spent_cap ?? ""}
                              placeholder="不限"
                              disabled={!!quotaSaving[u.id]}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const v = raw === "" ? null : Number(raw);
                                if (raw !== "" && (!Number.isFinite(v) || (v as number) < 0)) return;
                                if (v === u.quota_total_spent_cap) return;
                                saveQuota(u.id, { quota_total_spent_cap: v });
                              }}
                              className="border rounded px-2 py-1 text-sm"
                              aria-label={`${u.email} 费用上限`}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-gray-500">授予上限 (仅展示)</span>
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              defaultValue={u.quota_granted_cap ?? ""}
                              placeholder="不限"
                              disabled={!!quotaSaving[u.id]}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const v = raw === "" ? null : Number(raw);
                                if (raw !== "" && (!Number.isFinite(v) || (v as number) < 0)) return;
                                if (v === u.quota_granted_cap) return;
                                saveQuota(u.id, { quota_granted_cap: v });
                              }}
                              className="border rounded px-2 py-1 text-sm"
                              aria-label={`${u.email} 授予上限`}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-gray-500">到期日期 (ISO8601)</span>
                            <input
                              type="text"
                              defaultValue={u.quota_expire_at ?? ""}
                              placeholder="不限 (e.g. 2027-01-01T00:00:00Z)"
                              disabled={!!quotaSaving[u.id]}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const v: string | null = raw === "" ? null : raw;
                                if (v !== null && !Number.isFinite(Date.parse(v))) {
                                  setQuotaMessage(`❌ 日期格式不对: ${v}`);
                                  return;
                                }
                                if (v === u.quota_expire_at) return;
                                saveQuota(u.id, { quota_expire_at: v });
                              }}
                              className="border rounded px-2 py-1 text-sm"
                              aria-label={`${u.email} 到期日期`}
                            />
                          </label>
                        </div>

                        <div className="mt-2 flex items-center justify-between">
                          <button
                            onClick={() => {
                              if (quotaLogOpen === u.id) {
                                setQuotaLogOpen(null);
                              } else {
                                setQuotaLogOpen(u.id);
                                if (!quotaLogByUser[u.id]) fetchQuotaLog(u.id);
                              }
                            }}
                            className="text-xs text-blue-600 hover:underline"
                          >
                            {quotaLogOpen === u.id ? "收起" : "查看变更历史"}
                          </button>
                        </div>

                        {quotaLogOpen === u.id && (
                          <div className="mt-2 border-t pt-2">
                            {quotaLogByUser[u.id] === undefined ? (
                              <div className="text-xs text-gray-400">加载中…</div>
                            ) : quotaLogByUser[u.id].length === 0 ? (
                              <div className="text-xs text-gray-400">暂无变更记录</div>
                            ) : (
                              <ul className="text-xs space-y-1">
                                {quotaLogByUser[u.id].map((entry) => (
                                  <li key={entry.id} className="text-gray-700">
                                    <span className="text-gray-500">{entry.created_at}</span>
                                    {" · "}
                                    <span className="font-mono">{entry.field}</span>
                                    {entry.old_value !== null && entry.new_value !== null && (
                                      <>: {entry.old_value} → {entry.new_value}</>
                                    )}
                                    {entry.new_value !== null && entry.old_value === null && (
                                      <>: → {entry.new_value}</>
                                    )}
                                    {entry.reason && (
                                      <span className="text-gray-500"> ({entry.reason})</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* v55+ R88 用户端配额卡 (Sheet L 验收 ⑤): 仅 party_a_enabled=1 渲染,
                普通用户 party_a=0 直接 return null 不渲染此卡 → 老用户零行为变化. */}
          {profile?.party_a_enabled && (
            <div className={`bg-white rounded-lg border p-4 ${activeTab !== "schedule" ? "hidden" : ""}`}>
              <h2 className="font-medium text-gray-900 mb-1">📊 账号配额</h2>
              <p className="text-xs text-gray-500 mb-3">
                你的账号已被管理员标记为甲方，按 R88 三件套（费用上限 / 授予额度 / 到期日期）触发任务创建拦截。
              </p>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">费用上限</span>
                  <span className="font-mono">
                    {profile.quota_total_spent_cap !== null && profile.quota_total_spent_cap !== undefined
                      ? `$${Number(profile.quota_total_spent_cap).toFixed(2)}`
                      : "不限"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">授予上限 (仅展示)</span>
                  <span className="font-mono">
                    {profile.quota_granted_cap !== null && profile.quota_granted_cap !== undefined
                      ? `$${Number(profile.quota_granted_cap).toFixed(2)}`
                      : "不限"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-600">到期日期</span>
                  <span className="font-mono">
                    {profile.quota_expire_at ?? "不限"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                累计费用明细与触发拦截提示，在每次创建/启动任务时会显式提示。如需调整请联系管理员。
              </p>
            </div>
          )}

          {/* Dispatch 行为 (v27) — schedule tab */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "schedule" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-3">Dispatch 行为</h2>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-800">Preflight 自检</div>
                <p className="text-xs text-gray-500 mt-1">
                  开启后，每个新 task 启动时会在 prompt 头部注入 preflight 要求，agent
                  必须先报告 <code className="bg-gray-100 px-1 rounded">pwd</code> /
                  <code className="bg-gray-100 px-1 rounded">git remote</code> /
                  <code className="bg-gray-100 px-1 rounded">last commit</code>，
                  派发者通过 SSE 看到结果再决定是否继续。
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  关闭后跳过自检，节省 1 轮 token；适合信任自己派发准确性的资深用户。
                </p>
                {preflightMessage && (
                  <div className="mt-2 text-xs text-gray-600">{preflightMessage}</div>
                )}
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={profile?.preflight_enabled ?? true}
                  onChange={(e) => handlePreflightToggle(e.target.checked)}
                  disabled={preflightSaving || !profile}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 peer-disabled:opacity-50"></div>
              </label>
            </div>
          </div>

          {/* 通知邮箱 (v41) */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "notify" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-1">📧 通知邮箱</h2>
            <p className="text-xs text-gray-500 mb-3">
              任务超时会往这个地址发通知。留空则发到平台的系统邮箱
              {profile?.notify_fallback_to ? (
                <code className="bg-gray-100 px-1 rounded mx-1">
                  {profile.notify_fallback_to}
                </code>
              ) : (
                "（当前平台未设置系统邮箱）"
              )}
              。
            </p>

            {/* 当前配置值 —— 与输入框草稿分离, 让用户能一眼看清"已配 vs 待保存"。
                读 profile.notify_email (随 fetchProfile 更新, "保持最新" 自动满足). */}
            <div className="mb-3 text-xs">
              当前通知邮箱:{" "}
              {profile?.notify_email ? (
                <code className="bg-gray-100 px-1 rounded">{profile.notify_email}</code>
              ) : profile?.notify_fallback_to ? (
                <span className="text-gray-500">
                  未配（将发到系统邮箱{" "}
                  <code className="bg-gray-100 px-1 rounded">{profile.notify_fallback_to}</code>）
                </span>
              ) : (
                <span className="text-amber-700">未配，且平台未设置系统邮箱（通知将无法发送）</span>
              )}
            </div>

            {profile && !profile.mailer_configured && (
              <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                ⚠️ 平台尚未配置 SMTP（需在 .env.local 设置 SMTP_HOST / SMTP_USER /
                SMTP_PASS / NOTIFY_FROM），此处填了也发不出邮件。
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                type="email"
                value={notifyDraft}
                onChange={(e) => setNotifyDraft(e.target.value)}
                placeholder="you@example.com（留空 = 用系统邮箱）"
                className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                disabled={!profile || notifySaving}
              />
              <button
                onClick={handleNotifyEmailSave}
                disabled={!profile || notifySaving}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {notifySaving ? "保存中..." : "保存"}
              </button>
              <button
                onClick={handleNotifyEmailTest}
                disabled={!profile || notifyTesting}
                title="发送到当前已保存的收件地址（不是输入框里未保存的内容）"
                className="px-3 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
              >
                {notifyTesting ? "发送中..." : "发送测试邮件"}
              </button>
            </div>

            {notifyMessage && (
              <div className="mt-2 text-xs text-gray-600 break-all">{notifyMessage}</div>
            )}
            <p className="mt-2 text-xs text-gray-400">
              「发送测试邮件」发往<strong>已保存</strong>的地址 —— 改了输入框请先保存再测试。
            </p>
          </div>

          {/* 飞书机器人 (v47) — 镜像通知邮箱卡片结构 */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "notify" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-1">🤖 飞书机器人</h2>
            <p className="text-xs text-gray-500 mb-3">
              通用通知 (CLI/HTTP) 可往这里配置的飞书群发消息。
            </p>

            {/* 当前配置值 —— 与通知邮箱卡片对称, 末 4 位脱敏 (webhook 是半秘密).
                读 feishuWebhookMeta (随 fetchFeishuWebhookMeta 更新, 保存后也调一次,
                "保持最新" 自动满足). */}
            <div className="mb-3 text-xs">
              当前 webhook:{" "}
              {feishuWebhookMeta?.masked_url ? (
                <code className="bg-gray-100 px-1 rounded">
                  {feishuWebhookMeta.masked_url}
                </code>
              ) : (
                <span className="text-gray-500">未配（通知将不发到飞书）</span>
              )}
            </div>

            <div className="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={feishuWebhookDraft}
                onChange={(e) => setFeishuWebhookDraft(e.target.value)}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/<token>（留空 = 清除）"
                className="flex-1 border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
                disabled={!profile || feishuWebhookSaving}
              />
              <button
                onClick={handleFeishuWebhookSave}
                disabled={!profile || feishuWebhookSaving}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {feishuWebhookSaving ? "保存中..." : "保存"}
              </button>
              <button
                onClick={handleFeishuWebhookTest}
                disabled={!profile || feishuWebhookTesting || (!profile.feishu_configured && !feishuWebhookDraft.trim())}
                title="直接发往输入框里的 webhook（无需先保存）"
                className="px-3 py-2 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
              >
                {feishuWebhookTesting ? "发送中..." : "发送测试消息"}
              </button>
            </div>

            {/* 消息类型 + post 条件字段 (2026-08-17 兼容老 webhook 不支持 markdown) */}
            <div className="mb-2 flex items-center gap-2 text-xs">
              <label className="text-gray-600">消息类型：</label>
              <div className="w-56">
                <Select
                  value={feishuMsgType}
                  onChange={(v) => setFeishuMsgType(v as "text" | "markdown" | "post")}
                  disabled={!profile || feishuWebhookTesting}
                  options={[
                    { value: "text", label: "text（纯文本，最稳）" },
                    { value: "markdown", label: "markdown（**加粗** 等）" },
                    { value: "post", label: "post（富文本，含链接/@人）" },
                  ]}
                />
              </div>
              <span className="text-gray-400">
                老 webhook 不支持 markdown 会静默拒收（code:10208），用 text 或 post
              </span>
            </div>
            {feishuMsgType === "post" && (
              <div className="mb-2 space-y-1">
                <input
                  type="text"
                  value={feishuPostTitle}
                  onChange={(e) => setFeishuPostTitle(e.target.value)}
                  placeholder="post 标题（可选）"
                  className="w-full border rounded px-2 py-1 text-xs"
                  disabled={!profile || feishuWebhookTesting}
                />
                <textarea
                  value={feishuPostContent}
                  onChange={(e) => setFeishuPostContent(e.target.value)}
                  rows={3}
                  className="w-full border rounded px-2 py-1 text-xs font-mono"
                  placeholder='post 内容，二维数组 JSON: [[{tag,text},{tag:"a",text,href},...], ...]'
                  disabled={!profile || feishuWebhookTesting}
                />
              </div>
            )}

            {feishuWebhookMessage && (
              <div className="mt-2 text-xs text-gray-600 break-all">{feishuWebhookMessage}</div>
            )}
            <p className="mt-2 text-xs text-gray-400">
              「发送测试消息」直接发往输入框里的 webhook（无需先保存）—— 测通过后点「保存」才写入账户。
              取得 webhook 路径: 飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人。
            </p>
          </div>

          {/* 提示音设置 (localStorage, 纯客户端) — account tab */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "account" ? "hidden" : ""}`}>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex-1">
                <h2 className="font-medium text-gray-900 mb-1">提示音设置</h2>
                <p className="text-xs text-gray-500">
                  任务详情页收到事件时播放提示音。按事件类型独立开关，仅对当前浏览器生效。
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={soundSettings?.enabled ?? true}
                  onChange={(e) => {
                    const next = { ...soundSettings!, enabled: e.target.checked };
                    setSoundSettings(next);
                    saveSoundSettings(next);
                  }}
                  disabled={!soundSettings}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 peer-disabled:opacity-50"></div>
              </label>
            </div>

            {soundSettings && soundSettings.enabled && (
              <div className="space-y-2 mb-4">
                {SOUND_EVENT_OPTIONS.map((opt) => (
                  <div
                    key={opt.key}
                    className="flex items-start justify-between gap-4 py-1.5 border-t border-gray-100 first:border-t-0"
                  >
                    <div className="flex-1">
                      <div className="text-sm text-gray-800">{opt.label}</div>
                      <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0 pt-0.5">
                      <input
                        type="checkbox"
                        checked={soundSettings.events[opt.key] ?? false}
                        onChange={(e) => {
                          const next = {
                            ...soundSettings,
                            events: { ...soundSettings.events, [opt.key]: e.target.checked },
                          };
                          setSoundSettings(next);
                          saveSoundSettings(next);
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => playNotifySound()}
              disabled={!soundSettings?.enabled}
              className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              🔔 测试提示音
            </button>
          </div>

          {/* Fork 自动压缩阈值 (localStorage, 纯客户端) — account tab */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "account" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-1">Fork 自动压缩阈值</h2>
            <p className="text-xs text-gray-500 mb-3">
              Fork 弹窗打开时，若父任务上下文（tokens）超过此值，自动勾选「压缩后继续」，可手动取消。仅对当前浏览器生效。
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="1000"
                value={compactThreshold}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n) && n >= 0) {
                    setCompactThreshold(n);
                    saveCompactThreshold(n);
                  }
                }}
                className="w-36 border rounded-lg px-3 py-2 text-sm"
              />
              <span className="text-xs text-gray-500">
                tokens（{(compactThreshold / 1000).toFixed(0)}k）
              </span>
            </div>
          </div>

          {/* User LLM Configuration (v50: 多配置 + list) */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "account" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-3">个人 LLM 配置 <span className="text-red-500 text-sm">*至少 1 份</span></h2>
            <p className="text-xs text-gray-500 mb-3">
              可配置多份 LLM 配置（如生产 / 测试 / 火山方舟）。任务/模板从「可见的 LLM 配置」里选；列表里被授权的平台配置也会一起出现。
            </p>

            {profile?.admin_llm_granted && !isAdmin && (
              <div className="mb-3 p-2 bg-green-50 border border-green-200 rounded text-xs text-green-700">
                ✅ 你已被管理员授权使用平台 LLM 配置。授权收回后只能用自己的。
              </div>
            )}

            {/* 已有的配置列表 */}
            {llmConfigs.length > 0 && (
              <table className="w-full text-sm mb-4">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b">
                    <th className="py-2">名称</th>
                    <th className="py-2">Base URL</th>
                    <th className="py-2">Model</th>
                    <th className="py-2">Key</th>
                    <th className="py-2">默认</th>
                    <th className="py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {llmConfigs.map((cfg) => (
                    <tr key={cfg.id} className="border-b last:border-b-0">
                      <td className="py-2 font-medium">{cfg.name}</td>
                      <td className="py-2 text-xs text-gray-600 max-w-[150px] truncate" title={cfg.base_url || ""}>
                          {cfg.base_url || "—"}
                        </td>
                      <td className="py-2 text-xs max-w-[160px] truncate" title={cfg.model || ""}>{cfg.model || "—"}</td>
                      <td className="py-2 text-xs">
                        {cfg.has_api_key
                          ? <code className="bg-gray-100 px-1 py-0.5 rounded">{cfg.api_key_masked}</code>
                          : <span className="text-red-500">未配</span>}
                      </td>
                      <td className="py-2">
                        {cfg.is_default
                          ? <span className="inline-block bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded">默认</span>
                          : <button
                              onClick={() => handleSetLlmDefault(cfg.id)}
                              disabled={llmSaving}
                              className="text-xs text-blue-600 hover:underline"
                            >设为默认</button>}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => startEditLlm(cfg)}
                          className="text-xs text-blue-600 hover:underline mr-2"
                        >编辑</button>
                        <button
                          onClick={() => handleDuplicateLlmConfig(cfg.id, cfg.name)}
                          disabled={llmSaving}
                          className="text-xs text-blue-600 hover:underline mr-2"
                        >拷贝</button>
                        <button
                          onClick={() => handleCopyLlmConfigText(cfg)}
                          disabled={llmSaving}
                          title="把这一行配置复制成文本到剪贴板"
                          className="text-xs text-gray-600 hover:underline mr-2"
                        >📋 复制</button>
                        <button
                          onClick={() => handleDeleteLlmConfig(cfg.id, cfg.name)}
                          disabled={cfg.is_default || llmSaving}
                          className="text-xs text-red-600 hover:underline disabled:opacity-30"
                        >删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* 新增 / 编辑表单 */}
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium">
                  {editingLlmId === "new" ? "新增个人配置" : editingLlmId ? "编辑个人配置" : ""}
                </h3>
                {editingLlmId === null && (
                  <button
                    onClick={() => startEditLlm("new")}
                    className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700"
                  >+ 新增配置</button>
                )}
              </div>
              {editingLlmId !== null && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">名称 *</label>
                    <input
                      type="text"
                      value={llmDraft.name}
                      onChange={(e) => setLlmDraft({ ...llmDraft, name: e.target.value })}
                      placeholder="如：Claude 生产 / 火山方舟测试"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Base URL</label>
                    <input
                      type="text"
                      value={llmDraft.base_url}
                      onChange={(e) => setLlmDraft({ ...llmDraft, base_url: e.target.value })}
                      placeholder={config?.base_url || "https://api.anthropic.com"}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                    <input
                      type="text"
                      value={llmDraft.model}
                      onChange={(e) => setLlmDraft({ ...llmDraft, model: e.target.value })}
                      list="llm-model-options"
                      placeholder="选择或输入自定义模型名"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                    <datalist id="llm-model-options">
                      {modelStringList.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">API Key</label>
                    <input
                      type="password"
                      value={llmDraft.api_key}
                      onChange={(e) => setLlmDraft({ ...llmDraft, api_key: e.target.value, clear_api_key: false })}
                      placeholder={editingLlmId !== "new" ? "留空保留现有 key" : "输入 API Key"}
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                    {editingLlmId !== "new" && (
                      <label className="text-xs text-gray-600 mt-1 inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={llmDraft.clear_api_key}
                          onChange={(e) => setLlmDraft({ ...llmDraft, clear_api_key: e.target.checked })}
                        />
                        清除现有 key
                      </label>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleLlmSave}
                      disabled={llmSaving || !llmDraft.name.trim()}
                      className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                    >
                      {llmSaving ? "保存中..." : "保存"}
                    </button>
                    <button
                      onClick={() => { setEditingLlmId(null); setLlmMessage(null); }}
                      className="border px-4 py-2 rounded-lg text-sm hover:bg-gray-50"
                    >取消</button>
                    {llmMessage && <span className="text-sm">{llmMessage}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* 可见的 LLM 配置 (任务/模板选择器) */}
            {availableLlmConfigs.length > 0 && (
              <div className="mt-6 pt-4 border-t">
                <h3 className="text-sm font-medium text-gray-700 mb-2">可见的 LLM 配置（任务/模板可从这里选）</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {availableLlmConfigs.map((cfg) => (
                    <div key={cfg.id} className="border rounded p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-white text-[10px] ${cfg.source === "self" ? "bg-blue-500" : "bg-purple-500"}`}>
                          {cfg.source === "self" ? "我的" : "平台"}
                        </span>
                        <span className="font-medium">{cfg.name}</span>
                        {cfg.is_default && <span className="text-blue-600">默认</span>}
                      </div>
                      <div className="text-gray-500 mt-1">
                        {cfg.model || "—"} · {cfg.base_url || "默认"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 多模态 API Key (mmx-cli) — v48 user_media_keys */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "account" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-1">🎨 多模态 API Key (mmx-cli)</h2>
            <p className="text-xs text-gray-500 mb-3">
              用于在任务中调用 minimax 全模态平台 (mmx-cli) 生成图片/视频/音乐等。
              凭据加密存储于数据库；「保存」时 API 端自动 <code className="bg-gray-100 px-1 py-0.5 rounded">mmx auth login</code> 写到 per-user <code className="bg-gray-100 px-1 py-0.5 rounded">$ORCHESTRATOR_HOME/users/&lt;id&gt;/.mmx/config.json</code>，
  agent 进程下次启动即用。🔴 <strong className="text-red-500">mmx-cli 不读取 MINIMAX_API_KEY env，必须落到 config.json。</strong>
            </p>

            {/* 解密失败警告 (同 llm-configs.ts:222 模式) */}
            {mediaKey?.has_api_key && mediaKey.api_key_masked?.includes("解密失败") && (
              <div className="mb-3 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
                ⚠️ 已存的 key 解密失败（通常因为 ENCRYPTION_KEY 变更）。请重新输入。
              </div>
            )}

            {/* API Key */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
              {mediaKey?.has_api_key && !showMediaKeyInput ? (
                <div className="flex items-center gap-2">
                  <code className="bg-gray-100 px-2 py-1 rounded text-sm flex-1">
                    {mediaKey.api_key_masked}
                  </code>
                  <button
                    onClick={() => { setShowMediaKeyInput(true); setMediaKeyInput(""); }}
                    className="text-xs text-blue-600 hover:underline"
                  >更换</button>
                  <button
                    onClick={handleClearMediaKey}
                    disabled={mediaSaving}
                    className="text-xs text-red-600 hover:underline"
                  >清除</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={mediaKeyInput}
                    onChange={(e) => setMediaKeyInput(e.target.value)}
                    placeholder="输入 minimax API Key (mmx-cli)"
                    className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  />
                  {mediaKey?.has_api_key && (
                    <button
                      onClick={() => { setShowMediaKeyInput(false); setMediaKeyInput(""); }}
                      className="text-xs text-gray-500 hover:underline"
                    >取消</button>
                  )}
                </div>
              )}
            </div>

            {/* Region */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">区域</label>
              <Select
                value={regionInput}
                onChange={(v) => setRegionInput(v as "cn" | "global")}
                options={[
                  { value: "cn", label: "cn (国内端点 api.minimaxi.com)" },
                  { value: "global", label: "global (海外端点)" },
                ]}
              />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleMediaKeySave}
                disabled={mediaSaving}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {mediaSaving ? "保存中..." : "保存"}
              </button>
              {mediaKey?.has_api_key && (
                <>
                  <button
                    onClick={handleTestMediaKey}
                    disabled={mediaTesting}
                    className="border border-blue-300 text-blue-600 px-4 py-2 rounded-lg text-sm hover:bg-blue-50 disabled:opacity-50"
                  >
                    {mediaTesting ? "测试中..." : "测试 (mmx quota)"}
                  </button>
                  <button
                    onClick={handleDeleteMediaKey}
                    disabled={mediaSaving}
                    className="border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
                  >
                    删除全部
                  </button>
                </>
              )}
              {mediaMessage && (
                <span className="text-sm whitespace-pre-wrap">{mediaMessage}</span>
              )}
            </div>
          </div>

          {/* API Tokens */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "account" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-1">🔑 API Token</h2>
            <p className="text-xs text-gray-500 mb-3">
              不过期的个人访问令牌。CLI / 脚本用 <code className="bg-gray-100 px-1 py-0.5 rounded">Authorization: Bearer &lt;token&gt;</code> 调用所有接口，免去 7 天登录刷新。
            </p>

            {/* Created token - shown once */}
            {createdToken && (
              <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded">
                <div className="text-sm font-medium text-green-800 mb-1">Token 已创建（仅显示一次，请立即复制）</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-white border rounded px-2 py-1 text-xs break-all">{createdToken}</code>
                  <button
                    onClick={() => navigator.clipboard?.writeText(createdToken)}
                    className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                  >复制</button>
                  <button
                    onClick={() => setCreatedToken(null)}
                    className="text-xs text-gray-500 hover:underline whitespace-nowrap"
                  >关闭</button>
                </div>
              </div>
            )}

            {/* Create */}
            <div className="flex items-center gap-2 mb-4">
              <input
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="名称（如 CLI-local）"
                className="flex-1 border rounded-lg px-3 py-2 text-sm"
              />
              <button
                onClick={handleCreateApiToken}
                disabled={tokenSaving}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {tokenSaving ? "创建中..." : "创建 Token"}
              </button>
            </div>

            {/* List — max-h + 滚动容器，列表头：全选 / 搜索 / 批量删除 */}
            {apiTokens.length === 0 ? (
              <div className="text-sm text-gray-400 py-2">暂无 API Token</div>
            ) : (
              <>
                {/* Toolbar — 全选 checkbox + 搜索框 + 批量删除按钮 */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAllFiltered}
                      disabled={filteredTokens.length === 0}
                      className="cursor-pointer"
                    />
                    全选
                  </label>
                  <input
                    type="text"
                    value={tokenSearch}
                    onChange={(e) => setTokenSearch(e.target.value)}
                    placeholder="按名称搜索"
                    className="flex-1 min-w-[140px] border rounded px-2 py-1 text-xs"
                  />
                  <button
                    onClick={handleBatchDeleteApiTokens}
                    disabled={selectedTokenIds.size === 0 || tokenSaving}
                    className="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    批量删除{selectedTokenIds.size > 0 ? ` ${selectedTokenIds.size}` : ""}
                  </button>
                </div>

                <div className="max-h-[400px] overflow-y-auto border rounded">
                  {filteredTokens.length === 0 ? (
                    <div className="text-sm text-gray-400 py-3 text-center">
                      无匹配 token
                    </div>
                  ) : (
                    filteredTokens.map((t) => {
                      const checked = selectedTokenIds.has(t.id);
                      return (
                        <div
                          key={t.id}
                          className={`flex items-center justify-between py-1.5 px-2 border-b last:border-b-0 ${
                            checked ? "bg-blue-50" : "hover:bg-gray-50"
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSelectToken(t.id)}
                              disabled={tokenSaving}
                              className="cursor-pointer"
                            />
                            <code className="text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                              {t.prefix}…
                            </code>
                            <span className="text-sm text-gray-800 truncate">
                              {t.name}
                            </span>
                          </div>
                          <button
                            onClick={() => handleDeleteApiToken(t.id, t.name)}
                            disabled={tokenSaving}
                            className="text-xs text-red-600 hover:underline"
                          >
                            删除
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}

            {tokenMessage && (
              <div className="mt-2 text-sm">{tokenMessage}</div>
            )}

            <div className="mt-3 p-2 bg-gray-50 rounded text-xs text-gray-500 font-mono break-all">
              curl -H "Authorization: Bearer &lt;token&gt;" https://&lt;host&gt;/api/projects
            </div>
            <p className="text-xs text-amber-600 mt-2">
              ⚠️ Token 不过期。删除仅清理记录，token 在服务端轮换密钥后才彻底失效。
            </p>
          </div>

          {/* 维护模式（v34，admin only）*/}
          {isAdmin && maintenance && (
            <div
              className={`bg-white rounded-lg border p-4 ${
                maintenance.active ? "border-amber-400 bg-amber-50" : ""
              } ${activeTab !== "platform" ? "hidden" : ""}`}
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <h2 className="font-medium text-gray-900">维护模式</h2>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    maintenance.active
                      ? "bg-amber-200 text-amber-900"
                      : "bg-green-100 text-green-700"
                  }`}
                >
                  {maintenance.active ? "🔧 维护中" : "✅ 正常运行"}
                </span>
              </div>
              <p className="text-xs text-gray-500 mb-3">
                部署前关停：暂停调度、挂起运行中的任务（保留上下文，恢复后可续完整对话）、摘下排队任务。
                直接重启服务会连 agent 子进程一起杀掉，在跑的任务就丢上下文了。
              </p>

              {maintenance.active && (
                <div className="text-xs text-amber-800 bg-amber-100 rounded p-2 mb-3 space-y-0.5">
                  <div>进入时间：{maintenance.entered_at || "—"}</div>
                  {maintenance.reason && <div>原因：{maintenance.reason}</div>}
                  <div>挂起任务：{maintenance.suspended_count} 个（恢复时自动重启）</div>
                </div>
              )}

              <div className="text-xs text-gray-500 mb-3">
                调度器：{maintenance.scheduler_paused ? "已关闸" : "正常"} · 运行中{" "}
                {maintenance.running_count} · 排队 {maintenance.queue_size}
              </div>

              {/* v53: 上次维护记录. active=true 时不显示 (避免和「正在维护」混淆).
                  展示字段: 开始时间 / 持续 / 原因 / 结果徽标 / 失败任务数 */}
              {!maintenance.active && maintenance.last_maintenance && (
                <div className="text-xs text-gray-500 bg-gray-50 rounded p-2 mb-3 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-700">上次维护</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        maintenance.last_maintenance.result === "failed"
                          ? "bg-red-100 text-red-700"
                          : maintenance.last_maintenance.result === "aborted"
                          ? "bg-orange-100 text-orange-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {maintenance.last_maintenance.result === "failed"
                        ? "有失败"
                        : maintenance.last_maintenance.result === "aborted"
                        ? "异常中断"
                        : "已完成"}
                    </span>
                  </div>
                  <div>
                    {formatMaintenanceTime(maintenance.last_maintenance.started_at)}
                    {maintenance.last_maintenance.duration_seconds !== null && (
                      <>
                        {" → "}
                        {formatMaintenanceDuration(maintenance.last_maintenance.duration_seconds)}
                      </>
                    )}
                    {maintenance.last_maintenance.reason && (
                      <> · 原因：{maintenance.last_maintenance.reason}</>
                    )}
                  </div>
                  {(maintenance.last_maintenance.paused_count > 0 ||
                    maintenance.last_maintenance.dequeued_count > 0 ||
                    maintenance.last_maintenance.failed_count > 0) && (
                    <div>
                      影响：暂停 {maintenance.last_maintenance.paused_count} 个运行中
                      {maintenance.last_maintenance.dequeued_count > 0 &&
                        `，摘下 ${maintenance.last_maintenance.dequeued_count} 个排队`}
                      {maintenance.last_maintenance.failed_count > 0 &&
                        `，${maintenance.last_maintenance.failed_count} 个失败`}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                {maintenance.active ? (
                  <button
                    onClick={() => void callMaintenance("exit")}
                    disabled={maintenanceBusy}
                    className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
                  >
                    {maintenanceBusy ? "恢复中..." : "恢复运行"}
                  </button>
                ) : (
                  <button
                    onClick={handleEnterMaintenance}
                    disabled={maintenanceBusy}
                    className="bg-amber-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50"
                  >
                    {maintenanceBusy ? "关停中..." : "关停任务"}
                  </button>
                )}
                <button
                  onClick={() => void fetchMaintenance()}
                  disabled={maintenanceBusy}
                  className="border border-gray-300 text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  刷新
                </button>
                {maintenanceMessage && (
                  <span className="text-sm text-gray-700">{maintenanceMessage}</span>
                )}
              </div>

              <p className="text-xs text-gray-400 mt-2">
                CLI 等价操作：<code className="font-mono">scripts/maintenance.sh enter|exit|status</code>
                ；部署时用 <code className="font-mono">npm run deploy -- --drain</code> 自动包住。
              </p>
            </div>
          )}

          {/* Concurrency */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "schedule" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-2">并发控制</h2>
            <div className="flex items-center gap-4">
              <label className="text-sm text-gray-600">最大并发数</label>
              <input
                type="range"
                min={config.concurrency_min}
                max={config.concurrency_max}
                step={1}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-48 accent-blue-600"
                aria-label="最大并发数"
              />
              <output className="w-6 text-center text-sm font-mono font-medium">{concurrency}</output>
              <span className="text-xs text-gray-400">
                {config.concurrency_min}-{config.concurrency_max}
              </span>
            </div>
            <div className="text-xs text-gray-500 mt-2">
              当前运行: {config.running_count} · 排队: {config.queue_size}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              保存后<strong>落库</strong>：立即改调度器 + pm2 重启仍生效（v39 起）。新实例未设置过时缺省 2。
            </p>
          </div>

          {/* 任务超时（v40 全局默认，落库）— schedule tab */}
          <div className={`bg-white rounded-lg border p-4 ${activeTab !== "schedule" ? "hidden" : ""}`}>
            <h2 className="font-medium text-gray-900 mb-2">任务超时（全局默认）</h2>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-600" htmlFor="task-timeout">
                单个任务最长运行
              </label>
              <input
                id="task-timeout"
                type="number"
                min={config.task_timeout_min}
                max={config.task_timeout_max}
                value={timeoutInput}
                onChange={(e) => setTimeoutInput(e.target.value)}
                className="w-24 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono"
              />
              <span className="text-xs text-gray-400">
                分钟（{config.task_timeout_min}-{config.task_timeout_max}）
              </span>
            </div>
            <p className="text-xs text-gray-500 leading-5 mt-2">
              到点后任务走「暂停」同一条路径（打断当前一轮但<strong>保留上下文</strong>，之后可
              恢复续跑），不是取消。单个项目可在「项目 → 高级选项」里覆盖本值。
              <br />
              <span className="text-amber-700">
                🔴 调长的代价：<code className="bg-gray-50 px-1 rounded">paused</code> 是非终态，
                定时任务的防重派闸门按「非终态」算在飞 —— 一个超时挂着的任务会挡住该
                定时任务的后续触发，调长等于把这段窗口一起调长。
              </span>
              <br />
              改动落库，pm2 重启仍生效；对<strong>已在跑</strong>的任务不生效（下一次启动/恢复才吃到新值）。
              新实例未设置过时缺省 30 分钟。
            </p>
          </div>

          {/* Save concurrency + timeout */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存运行配置"}
            </button>
            {message && (
              <span className="text-sm">{message}</span>
            )}
          </div>

          {/* R18 P2: 端口池 (admin only). 与并发 + 超时同一个「保存运行配置」按钮.
              池段数 1-8, 每段 start<=end + 1024-65535 整数. 改了不级联校验已有项目
              (历史已分配的端口可能在新池外, 但仍在用, 不强迁). */}
          {profile?.role === "admin" && (
            <div className={`bg-white rounded-lg border p-4 ${activeTab !== "platform" ? "hidden" : ""}`}>
              <h2 className="font-medium text-gray-900 mb-2">端口池 (项目分配白名单)</h2>
              <p className="text-xs text-gray-500 leading-5 mb-3">
                项目新建 / 高级选项里填的端口必须落在池内. 池外分配会回 409.
                跨项目撞端口也会回 409. 改池不级联校验已有项目 (历史端口可能「出池」, 仍可继续用).
              </p>
              <div className="space-y-2">
                {poolDraft.map((seg, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-12">段 {i + 1}</span>
                    <input
                      type="number"
                      min={config.port_pool_min}
                      max={config.port_pool_max}
                      value={seg[0]}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setPoolDraft((prev) =>
                          prev.map((s, j) => (j === i ? [v, s[1]] : s)),
                        );
                      }}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                      aria-label={`端口池第 ${i + 1} 段起始`}
                    />
                    <span className="text-xs text-gray-400">~</span>
                    <input
                      type="number"
                      min={config.port_pool_min}
                      max={config.port_pool_max}
                      value={seg[1]}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setPoolDraft((prev) =>
                          prev.map((s, j) => (j === i ? [s[0], v] : s)),
                        );
                      }}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                      aria-label={`端口池第 ${i + 1} 段结束`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (poolDraft.length > 1) {
                          setPoolDraft((prev) => prev.filter((_, j) => j !== i));
                        }
                      }}
                      disabled={poolDraft.length <= 1}
                      className="text-xs text-red-600 hover:text-red-700 px-2 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="删除该段"
                    >
                      删除
                    </button>
                  </div>
                ))}
                {poolDraft.length < config.port_pool_max_segments && (
                  <button
                    type="button"
                    onClick={() => {
                      // 新段默认起点 = 末段终点 + 1, 终点 = 起点 + 99. 落库
                      // 前端会校验, 不会越界.
                      const last = poolDraft[poolDraft.length - 1];
                      const start = Math.min(config.port_pool_max, last[1] + 1);
                      const end = Math.min(config.port_pool_max, start + 99);
                      setPoolDraft((prev) => [...prev, [start, end]]);
                    }}
                    className="text-xs text-blue-600 hover:text-blue-700 px-2"
                  >
                    + 增加段
                  </button>
                )}
                <div className="text-xs text-gray-400 mt-2">
                  当前 {poolDraft.length}/{config.port_pool_max_segments} 段, 端口范围 {config.port_pool_min}-{config.port_pool_max}.
                  单项目最多 5 个端口.
                </div>
              </div>
            </div>
          )}
        </div>
        </>
      ) : (
        <div className="text-center py-10 text-gray-400">加载中...</div>
      )}

      <ConfirmDialog
        open={!!pendingConfirm}
        title={pendingConfirm?.title ?? ""}
        message={pendingConfirm?.message ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel}
        variant={pendingConfirm?.variant}
        onConfirm={() => {
          pendingConfirm?.onConfirm();
          setPendingConfirm(null);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}
