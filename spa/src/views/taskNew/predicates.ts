// 纯函数 helpers — TaskNew.vue 视图逻辑拆分.
//   全部为 deterministic 纯函数 (仅依赖入参), 抽出来便于 vitest 单测断言 + 跨
//   三处按钮 (quick / full / snapshot) 共用同一口径. 改文案/规则只动这一文件.
// 与 master src/app/tasks/new/page.tsx 1:1 移植 — 这是 sheet R23 字面要求
// 「完整镜像 Next.js /tasks/new」的一部分. SPA 不引 master 仓, 故逐字搬运,
// 后续 master 改口径时同步改这里.

/* ------------------------------------------------------------------ */
/*  Keyboard submit predicate                                          */
/* ------------------------------------------------------------------ */

/** SubmitKeyEvent — 来自 Vue form-level @keydown 事件. isInputOrTextarea 由
    handler 在 DOM 层 instanceof HTMLInputElement / HTMLTextAreaElement 判定,
    纯函数只看 boolean. 改「什么算 input」时同时改 handler. */
export interface SubmitKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  targetIsInputOrTextarea: boolean;
}

/** Ctrl/Cmd+Enter 在 textfield 内触发 form submit. 单独 Enter / 其他键 /
    submitting=true / canSubmit=false 都早退. */
export function shouldTriggerSubmitOnKey(
  e: SubmitKeyEvent,
  opts: { submitting: boolean; canSubmit: boolean },
): boolean {
  if (e.key !== 'Enter') return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (!e.targetIsInputOrTextarea) return false;
  if (opts.submitting || !opts.canSubmit) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/*  Click submit lock predicate                                        */
/* ------------------------------------------------------------------ */

/** inFlight=true (useRef 同步锁持有) 或 canSubmit=false (required 字段空 /
    按钮 disabled) → 阻止双提交. inFlight 由调用方传 submitLockRef.current. */
export function shouldBlockClickSubmit(opts: {
  inFlight: boolean;
  canSubmit: boolean;
}): boolean {
  if (opts.inFlight) return true;
  if (!opts.canSubmit) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Spinner visibility                                                 */
/* ------------------------------------------------------------------ */

/** damo 2026-09-18 反馈: 创建按钮 loading 反馈太弱. 抽出纯函数强约束 submitting
    → 显示 spinner. */
export function shouldShowSpinner(submitting: boolean): boolean {
  return submitting;
}

/* ------------------------------------------------------------------ */
/*  Submit button label                                                */
/* ------------------------------------------------------------------ */

/** 三处按钮 (quick / full / snapshot) 共享同一文案口径, 改文案只改这里. loading
    时显示进度文案 (避免宽窄抖动 — 固定文案). snapshot editing 双态决定「保存修改」
    vs「创建快照」, submitting=true 时盖过 editing.
    i18n: 文案走 taskNew 域 locale (i18n.global.t 不依赖组件上下文, 纯函数可用). */
import { i18n } from '@/i18n';

export function getSubmitButtonLabel(
  mode: 'quick' | 'full' | 'snapshot',
  submitting: boolean,
  snapshotEditing: boolean,
): string {
  if (submitting) {
    return mode === 'quick'
      ? i18n.global.t('taskNew.submitQuickLoading')
      : mode === 'full'
        ? i18n.global.t('taskNew.submitFullLoading')
        : i18n.global.t('taskNew.snap.saving');
  }
  if (mode === 'quick') return i18n.global.t('taskNew.submitQuick');
  if (mode === 'full') return i18n.global.t('taskNew.submitFull');
  return snapshotEditing
    ? i18n.global.t('taskNew.snap.saveChanges')
    : i18n.global.t('taskNew.snap.modalCreate');
}

/* ------------------------------------------------------------------ */
/*  Goal-driven loop prompt builder (R143)                             */
/* ------------------------------------------------------------------ */

/** 把结构化 goal_text 字段拼回 prompt 文本 (R143, damo 2026-09-15):
    - basePrompt 为空 + goalText 非空 → 直接产出 `<goal>...</goal>` (quick 模式合法).
    - goalText 为空 → 原样返回 basePrompt (向后兼容, 不污染普通 task prompt).
    - goalText 已含 `<goal>` 字面 (用户手填) → 仍走拼路径, 不去重也不抛错
      (tolerant: API 端 GOAL_MARKER_RE 首匹配即可).
    UI 层沿用字面 `<goal>`, 不读 regex, 是有意为之 (regex 改 UI 不必跟). */
export function buildGoalPrompt(
  basePrompt: string,
  goalText: string | undefined | null,
): string {
  const trimmed = (goalText ?? '').trim();
  if (!trimmed) return basePrompt;
  if (!basePrompt) return `<goal>${trimmed}</goal>`;
  return `${basePrompt}\n\n<goal>${trimmed}</goal>`;
}

/** R143 二轮: UI goal_rounds 字符串字段转 API 期望的数字/null.
    "" → null (不传, 走 settings 默认 20).
    非整数 → null (不传). API 层校验报 400. UI 不预校验范围, 错误集中服务端.
    整数 → 直接传 (含 0 = 不限轮次, R143 四轮哨兵). */
export function parseGoalRoundsInput(raw: string): number | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  return n;
}

/* ------------------------------------------------------------------ */
/*  Size formatter                                                     */
/* ------------------------------------------------------------------ */

/** 字节 → 人类可读 (KB/MB). 附件列表显示用. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  Tag list helpers                                                   */
/* ------------------------------------------------------------------ */

/** 把后端 allowed_tools / tags (JSON 字符串或 null) 解析为字符串数组. 解析失败
    返回空数组. 与 spa/src/api/templates.ts parseTags 同款 (那里是 tags, 这里
    是 allowed_tools / tags 通用). */
export function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string');
    return [];
  } catch {
    return [];
  }
}

/** 把字符串数组序列化为后端 JSON 字符串. 空数组返回 null (后端期望 null = 没值). */
export function serializeJsonStringArray(arr: string[]): string | null {
  if (!arr.length) return null;
  return JSON.stringify(arr);
}

/** tags 字符串 ("a, b, c") → 数组. trim + filter(Boolean) — 与 Next handleSubmit
    `form.tags.split(",").map((t) => t.trim())` 同口径. */
export function parseCsvTags(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** tags 数组 → CSV 字符串. 仅用于 snapshot 的编辑表单 (full 模式直接发数组). */
export function serializeCsvTags(arr: string[]): string {
  return arr.join(',');
}