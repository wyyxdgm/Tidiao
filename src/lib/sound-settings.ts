// 功能: 提示音偏好设置 (localStorage 读写) + 按事件判断是否该响铃.
// 关注点: 纯客户端 (声音是浏览器行为, 服务端不参与); SSR 时 typeof window guard;
//   合并默认值防止旧版本字段缺失; paused/cancelled 需区分自动 vs 人为 (source).

export type SoundEventKey =
  | "tool_approval"
  | "user_dialog"
  | "reviewing"
  | "failed"
  | "paused"
  | "queued"
  | "cancelled";

export interface SoundSettings {
  enabled: boolean; // 总开关, 关闭时全部静音
  events: Record<SoundEventKey, boolean>;
}

const STORAGE_KEY = "sound-settings";

// 默认: 需要人操作 / 完成类事件默认开, 自动状态变更类默认关 (用户按需开)
const DEFAULTS: SoundSettings = {
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

export function getSoundSettings(): SoundSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    // 合并默认值: 旧数据缺少新字段时补默认
    return {
      enabled: parsed.enabled ?? DEFAULTS.enabled,
      events: { ...DEFAULTS.events, ...(parsed.events || {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveSoundSettings(s: SoundSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 隐身模式 / 配额满: 静默失败, 不影响功能
  }
}

// 功能: 判断一个 SSE 事件是否应触发提示音.
// 关注点: status_change 的 paused/cancelled 只有 source !== "manual" 才响
//   (人为手动暂停/取消时用户正在看页面, 无需提醒).
export function shouldPlaySound(event: any): boolean {
  const s = getSoundSettings();
  if (!s.enabled) return false;

  let key: SoundEventKey | null = null;
  if (event.type === "tool_approval_request") {
    key = "tool_approval";
  } else if (event.type === "user_dialog_request") {
    key = "user_dialog";
  } else if (event.type === "status_change") {
    key = event.to as SoundEventKey;
    // 人为暂停/取消不响 (用户自己点的, 正在看页面)
    if (
      (key === "paused" || key === "cancelled") &&
      event.source === "manual"
    ) {
      return false;
    }
  }

  if (!key) return false;
  return s.events[key] ?? false;
}
