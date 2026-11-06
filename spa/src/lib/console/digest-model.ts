// R195 AI 全局归纳 — 前端纯逻辑 (无副作用, vitest 直测).
// 后端 /api/projects/[id]/console-digest 返回 {headline, items[]} (每任务
// 分类/紧急度/建议/是否需拍板); 这里管分组渲染 + 每条目可用的快捷动作判定.
// 动作本体 (approve / message) 在 ConsoleCanvas.vue, 与等我处理卡共用端点.

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

/** 类别元数据 — 顺序即面板分组渲染顺序. */
export const CATEGORY_META: Record<DigestCategory, { label: string; icon: string }> = {
  fix: { label: '要修的', icon: '🔧' },
  design: { label: '设计规划', icon: '🧭' },
  delivery: { label: '已交付', icon: '📦' },
  iterate: { label: '功能迭代', icon: '✨' },
  decision: { label: '等你拍板', icon: '⚖️' },
  other: { label: '其他', icon: '•' },
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
      label: CATEGORY_META[key].label,
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

export const AGREE_LABEL = '✓ 同意';
export const APPROVE_LABEL = '✓ 验收';
export const REPLY_LABEL = '✎ 回复';

export function actionLabel(a: DigestAction): string {
  if (a === 'approve') return APPROVE_LABEL;
  if (a === 'agree') return AGREE_LABEL;
  if (a === 'none') return ''; // R204: 终态惰性, 不出按钮
  return REPLY_LABEL;
}

// 功能: 一键同意的罐头消息 — 带上 AI 建议原文, agent 收到即按建议继续,
// owner 不用打字. suggestion 为空时退化为纯同意.
export function buildAgreeMessage(suggestion: string): string {
  const s = suggestion.trim();
  return s ? `同意，按建议推进：${s}` : '同意，按你的建议继续推进。';
}

/** 紧急度 → 面板圆点样式类. */
export function urgencyClass(u: DigestItem['urgency']): string {
  return `urg-${u}`;
}
