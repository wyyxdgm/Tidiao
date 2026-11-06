// 🆕 R179 (飞书 AO-DEV R179, damo 2026-10-03): 聊天输入框历史回溯 — ↑/↓ 翻已发送
//   输入 (terminal-style) + 未发送草稿持久化 (切 task / 刷新不丢) + /clearhistory
//   清除. 纯逻辑与 localStorage 访问收在本文件, TaskMessageInput.vue 只做接线.
//
// 设计点:
// - 历史 per-task 隔离 (key 带 taskId), localStorage 持久 → 切换/刷新后仍在.
// - 浏览态用 InputHistoryBrowser 状态机: 首次 ↑ 捕获当前文本为 draft, ↓ 翻回
//   最旧后回到 draft (bash 同款). 浏览中手工编辑的文本再按 ↑ 会被丢弃 (bash
//   同样不保存未执行的编辑), 保持语义简单.
// - 历史上限 100 条, 连续重复不记 (重发同一条不刷屏).
// - localStorage 不可用 (隐私模式/配额满) → 静默降级, 功能退化为会话内存.
//
// 关注点:
// - 此文件是 SPA 输入历史唯一实现点; 根仓 vitest 通过
//   src/lib/chat/input-history.test.ts 跨树 import 直接测本文件 (SPA 自身无
//   test runner, 不复制实现避免 drift).
// - 改 pushHistoryEntry / InputHistoryBrowser 语义必须同步改那份测试.

/** 历史条数上限. 超出从最旧端裁剪. */
export const INPUT_HISTORY_CAP = 100;

const HISTORY_KEY_PREFIX = 'ao-msg-input-history-';
const DRAFT_KEY_PREFIX = 'ao-msg-input-draft-';

// 功能: 追加一条历史 (拷贝原数组返回新数组), 尾随空白去掉; 连续重复跳过;
//   超上限从头部裁剪. 空白串不记.
export function pushHistoryEntry(
  entries: string[],
  raw: string,
  cap: number = INPUT_HISTORY_CAP,
): string[] {
  const t = (raw ?? '').replace(/\s+$/, '');
  if (!t.trim()) return entries;
  if (entries.length > 0 && entries[entries.length - 1] === t) return entries;
  const next = entries.concat([t]);
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

// 功能: ↑/↓ 浏览历史的状态机. up(current) 返回上一条 (首次进入浏览态时把
//   current 存为 draft); down(current) 返回下一条, 翻过最新一条后退回 draft
//   并退出浏览态. 非浏览态 down 原样返回 current.
// 关注点: 构造时持有 history 数组引用 — 组件重写历史后必须重建 browser,
//   否则浏览的是旧数组 (TaskMessageInput 每次 record/clear 后 new 一个).
export class InputHistoryBrowser {
  private idx: number | null = null;
  private draft = '';

  constructor(private readonly history: string[]) {}

  /** 是否处于浏览态 (↑ 进入过, ↓ 退回 draft 后 false). */
  get active(): boolean {
    return this.idx !== null;
  }

  up(current: string): string {
    if (this.history.length === 0) return current;
    if (this.idx === null) {
      this.draft = current;
      this.idx = this.history.length - 1;
    } else {
      this.idx = Math.max(0, this.idx - 1);
    }
    return this.history[this.idx];
  }

  down(current: string): string {
    if (this.idx === null) return current;
    if (this.idx >= this.history.length - 1) {
      this.idx = null;
      return this.draft;
    }
    this.idx += 1;
    return this.history[this.idx];
  }

  /** 发送/清除后调用: 退出浏览态并丢弃 draft. */
  reset(): void {
    this.idx = null;
    this.draft = '';
  }
}

/* ------------------------------------------------------------------ */
/*  localStorage 持久化 (失败静默)                                      */
/* ------------------------------------------------------------------ */

// 功能: 读 per-task 历史. 解析失败 / key 不存在 / localStorage 不可用 → [].
export function loadInputHistory(taskId: string): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY_PREFIX + taskId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

// 功能: 写 per-task 历史 (JSON 数组). localStorage 不可用 → 静默丢弃.
export function saveInputHistory(taskId: string, entries: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY_PREFIX + taskId, JSON.stringify(entries));
  } catch {
    /* 静默 — 历史是增强功能, 存不下不阻断输入 */
  }
}

// 功能: 读 per-task 未发送草稿. 没有草稿 / 失败 → ''.
export function loadDraft(taskId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY_PREFIX + taskId) ?? '';
  } catch {
    return '';
  }
}

// 功能: 写 per-task 未发送草稿. 草稿为空串也写 (等价清除).
export function saveDraft(taskId: string, text: string): void {
  try {
    localStorage.setItem(DRAFT_KEY_PREFIX + taskId, text);
  } catch {
    /* 静默 */
  }
}

// 功能: 一次性清除某 task 的历史 + 草稿 (/clearhistory 用).
export function clearInputHistoryStorage(taskId: string): void {
  try {
    localStorage.removeItem(HISTORY_KEY_PREFIX + taskId);
    localStorage.removeItem(DRAFT_KEY_PREFIX + taskId);
  } catch {
    /* 静默 */
  }
}

/* ------------------------------------------------------------------ */
/*  全局共享输入历史 (R233 Round7) — 跨入口共用一份「发送过的 prompt」     */
/* ------------------------------------------------------------------ */

const GLOBAL_HISTORY_KEY = 'ao-prompt-history-global';

// 功能: 读全局历史 (task 聊天 / 快速创建弹窗等所有 prompt 入口共用).
//   解析失败 / localStorage 不可用 → [].
export function loadGlobalInputHistory(): string[] {
  try {
    const raw = localStorage.getItem(GLOBAL_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

// 功能: 追加一条全局历史并落盘 (连续重复跳过 / 上限同 per-task). 返回新数组 —
//   调用方用它重建 InputHistoryBrowser (browser 持有数组引用).
export function pushGlobalInputHistory(
  raw: string,
  cap: number = INPUT_HISTORY_CAP,
): string[] {
  const next = pushHistoryEntry(loadGlobalInputHistory(), raw, cap);
  try {
    localStorage.setItem(GLOBAL_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 静默 — 历史是增强功能, 存不下不阻断发送 */
  }
  return next;
}
