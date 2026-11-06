/* 功能: 解析 task.awaiting_markers + task.awaiting_owner_review 回到角标渲染列表.
   关注点: 与 master task-header.tsx / board-client.tsx 同款语义. 6 种 type:
   review (需拍板) / choice (等选) / info (提示) / waiting_reply (等回复) /
   suggestion (有建议) / stuck (卡住). 解析失败静默回退到 awaiting_owner_review.
   i18n (W4.5b): label 走 locale (复用 tasks.kanban.marker.* 键, 非 setup 环境
   用 i18n.global); 未知 type 兜底显示原始 type 值. */
import { i18n } from '@/i18n';

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

const TYPE_META: Record<string, { cssClass: string; key?: string; icon: string }> = {
  review: { cssClass: 'marker-review', key: 'tasks.kanban.marker.review', icon: '🛎' },
  choice: { cssClass: 'marker-choice', key: 'tasks.kanban.marker.choice', icon: '🔀' },
  info: { cssClass: 'marker-info', key: 'tasks.kanban.marker.info', icon: 'ℹ️' },
  waiting_reply: { cssClass: 'marker-waiting', key: 'tasks.kanban.marker.waitingReply', icon: '📩' },
  suggestion: { cssClass: 'marker-suggestion', key: 'tasks.kanban.marker.suggestion', icon: '💡' },
  stuck: { cssClass: 'marker-stuck', key: 'tasks.kanban.marker.stuck', icon: '🆘' },
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
            key: undefined,
            icon: '⏳',
          };
          const descSnippet = m.desc
            ? ` · ${m.desc.slice(0, 30)}${m.desc.length > 30 ? '…' : ''}`
            : '';
          const labelText = meta.key
            ? i18n.global.t(meta.key)
            : (t || i18n.global.t('tasks.kanban.marker.default'));
          return {
            label: `${labelText}${descSnippet}`,
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
        label: i18n.global.t('tasks.kanban.marker.review'),
        title:
          'Agent 标了需拍板 — approve 会被拒, 需先调 POST /api/tasks/{id}/unset-awaiting-review',
        icon: '🛎',
        cssClass: 'marker-review',
      },
    ];
  }
  return [];
}