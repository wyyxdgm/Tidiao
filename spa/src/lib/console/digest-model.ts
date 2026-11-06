// R195 AI 全局归纳 — 前端纯逻辑 (无副作用, vitest 直测).
// 后端 /api/projects/[id]/console-digest 返回 {headline, items[]} (每任务
// 分类/紧急度/建议/是否需拍板); 这里管分组渲染 + 每条目可用的快捷动作判定.
// 动作本体 (approve / message) 在 ConsoleCanvas.vue, 与等我处理卡共用端点.

import { i18n } from '@/i18n';
export type DigestCategory =
  | 'fix'
  | 'design'
  | 'delivery'
  | 'iterate'
  | 'decision'
  | 'other';

export interface DigestItem {
  id: string;
  category: DigestCategory;
  urgency: 'high' | 'mid' | 'low';
  suggestion: string;
  need_owner: boolean;
}

export interface ConsoleDigest {
  headline: string;
  items: DigestItem[];
}

export interface DigestGroup {
  key: DigestCategory;
  label: string;
  icon: string;
  items: DigestItem[];
}

/** 类别元数据 — 顺序即面板分组渲染顺序.
    i18n (W4.5b): label 为 locale key (misc.console.digest.*), groupDigestItems 出口走 t(). */
export const CATEGORY_META: Record<DigestCategory, { labelKey: string; icon: string }> = {
  fix: { labelKey: 'misc.console.digest.fix', icon: '🔧' },
  design: { labelKey: 'misc.console.digest.design', icon: '🧭' },
  delivery: { labelKey: 'misc.console.digest.delivery', icon: '📦' },
  iterate: { labelKey: 'misc.console.digest.iterate', icon: '✨' },
  decision: { labelKey: 'misc.console.digest.decision', icon: '⚖️' },
  other: { labelKey: 'misc.console.digest.other', icon: '•' },
};

/** 高紧急度排前的组内排序权重. */
const URGENCY_ORDER: Record<DigestItem['urgency'], number> = { high: 0, mid: 1, low: 2 };

// 功能: items 按固定 6 类分组 (组按 CATEGORY_META 顺序, 空组不出现;
// 组内 high→low + 原顺序稳定).
export function groupDigestItems(items: DigestItem[]): DigestGroup[] {
  const byCat = new Map<DigestCategory, DigestItem[]>();
  for (const it of items) {
    const list = byCat.get(it.category) ?? [];
    list.push(it);
    byCat.set(it.category, list);
  }
  const groups: DigestGroup[] = [];
  for (const key of Object.keys(CATEGORY_META) as DigestCategory[]) {
    const list = byCat.get(key);
    if (!list?.length) continue;
    groups.push({
      key,
      label: i18n.global.t(CATEGORY_META[key].labelKey),
      icon: CATEGORY_META[key].icon,
      items: [...list].sort(
        (a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency],
      ),
    });
  }
  return groups;
}

export type DigestAction = 'approve' | 'agree' | 'reply' | 'none';

/** 终态惰性状态 (R204, damo 2026-10-06): completed/cancelled 已了结, 不再继续
 *  处理任何问题 — 不许有任何唤醒动作 (一键同意会经 terminal auto-resume 把
 *  终态任务拉起重跑, 实证事故 384e9e1e). failed 不在内: 失败恰恰是「要修的」
 *  典型来源, 同意 = 按建议修. ⚠️ 镜像 src/lib/runtime/console-digest.ts 的
 *  DIGEST_INERT_STATUSES, 两处必须同步. */
export const DIGEST_INERT_STATUSES: readonly string[] = ['completed', 'cancelled'];

export interface ActionTarget {
  id: string;
  status: string;
  awaitingOwnerReview?: boolean | null;
}

// 功能: 判定某归纳条目的一键主动作.
// 规则: reviewing/await_user = approve (真验收, 同意即过);
//       completed/cancelled = none (R204 终态惰性, 不渲染任何动作按钮);
//       其余 need_owner = agree (一键同意 = 罐头消息让任务按建议继续);
//       再否则 = reply (打开行内输入框).
export function digestActionFor(item: DigestItem, t?: ActionTarget): DigestAction {
  if (t && DIGEST_INERT_STATUSES.includes(t.status)) return 'none';
  if (t && (t.status === 'reviewing' || t.status === 'await_user')) return 'approve';
  if (item.need_owner) return 'agree';
  return 'reply';
}

// i18n (W4.5b): 按钮文案走 locale (运行时求值, 语言切换跟新).
export const AGREE_LABEL = 'misc.console.digest.agree';
export const APPROVE_LABEL = 'misc.console.digest.approve';
export const REPLY_LABEL = 'misc.console.digest.reply';

export function actionLabel(a: DigestAction): string {
  if (a === 'approve') return i18n.global.t(APPROVE_LABEL);
  if (a === 'agree') return i18n.global.t(AGREE_LABEL);
  if (a === 'none') return ''; // R204: 终态惰性, 不出按钮
  return i18n.global.t(REPLY_LABEL);
}

// 功能: 一键同意的罐头消息 — 带上 AI 建议原文, agent 收到即按建议继续,
// owner 不用打字. suggestion 为空时退化为纯同意.
export function buildAgreeMessage(suggestion: string): string {
  const s = suggestion.trim();
  return s
    ? i18n.global.t('misc.console.digest.agreeWithSuggestion', { s })
    : i18n.global.t('misc.console.digest.agreePlain');
}

/** 紧急度 → 面板圆点样式类. */
export function urgencyClass(u: DigestItem['urgency']): string {
  return `urg-${u}`;
}
