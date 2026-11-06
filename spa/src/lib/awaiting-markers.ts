/* 功能: 解析 task.awaiting_markers + task.awaiting_owner_review 回到角标渲染列表.
   关注点: 与 master task-header.tsx / board-client.tsx 同款语义. 6 种 type:
   review (需拍板) / choice (等选) / info (提示) / waiting_reply (等回复) /
   suggestion (有建议) / stuck (卡住). 解析失败静默回退到 awaiting_owner_review. */
export interface AwaitingMarkerMeta {
  label: string;
  title: string;
  icon: string;
  cssClass: string;
}

interface MarkerInput {
  type?: string;
  desc?: string | null;
}

const TYPE_META: Record<string, { cssClass: string; cn: string; icon: string }> = {
  review: { cssClass: 'marker-review', cn: '需拍板', icon: '🛎' },
  choice: { cssClass: 'marker-choice', cn: '等选', icon: '🔀' },
  info: { cssClass: 'marker-info', cn: '提示', icon: 'ℹ️' },
  waiting_reply: { cssClass: 'marker-waiting', cn: '等回复', icon: '📩' },
  suggestion: { cssClass: 'marker-suggestion', cn: '有建议', icon: '💡' },
  stuck: { cssClass: 'marker-stuck', cn: '卡住', icon: '🆘' },
};

export function parseAwaitingMarkers(
  awaitingMarkersJson: string | null,
  awaitingOwnerReview: number,
): AwaitingMarkerMeta[] {
  if (awaitingMarkersJson) {
    try {
      const parsed = JSON.parse(awaitingMarkersJson) as MarkerInput[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((m) => {
          const t = (m.type || 'review').toLowerCase();
          const meta = TYPE_META[t] || {
            cssClass: 'marker-default',
            cn: t || '等拍板',
            icon: '⏳',
          };
          const descSnippet = m.desc
            ? ` · ${m.desc.slice(0, 30)}${m.desc.length > 30 ? '…' : ''}`
            : '';
          return {
            label: `${meta.cn}${descSnippet}`,
            title: m.desc ? `${t}: ${m.desc}` : `awaiting marker (type=${t})`,
            icon: meta.icon,
            cssClass: meta.cssClass,
          };
        });
      }
    } catch {
      // 静默走回退
    }
  }
  if (awaitingOwnerReview === 1) {
    return [
      {
        label: '需拍板',
        title:
          'Agent 标了需拍板 — approve 会被拒, 需先调 POST /api/tasks/{id}/unset-awaiting-review',
        icon: '🛎',
        cssClass: 'marker-review',
      },
    ];
  }
  return [];
}