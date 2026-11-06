// 🆕 idea-canvas P2: 构思层 API 封装 — 与 master src/lib/db/ideas.ts 字段集对齐.
// 画布 (IdeasView) + 详情抽屉 + 收益面板全部走这几个函数.

import { get, post, patch, del } from './http';

/** 构思状态 6 态意图层 — 与 master IDEA_STATUSES 对齐. */
export const IDEA_STATUSES = [
  'germinating', 'exploring', 'decided', 'shelved', 'rejected', 'landed',
] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  germinating: '构思中',
  exploring: '探索中',
  decided: '已定案',
  shelved: '搁置',
  rejected: '已否定',
  landed: '已落地',
};

export const NODE_STATUS_LABELS: Record<string, string> = {
  planned: '计划中',
  dispatched: '待执行',
  running: '执行中',
  reviewing: '待审核',
  awaiting_decision: '等决策',
  blocked: '卡住',
  done: '完成',
  dropped: '放弃',
};

export interface Idea {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  status: IdeaStatus;
  project_id: string | null;
  pinned: number;
  hypothesis: string | null;
  success_criteria: string | null;
  deadline: string | null;
  conclusion: string | null;
  concluded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaWithCounts extends Idea {
  node_count: number;
  task_count: number;
  signal_count: number;
}

export interface IdeaLink {
  idea_id: string;
  linked_idea_id: string;
  relation: string;
  weight: number;
}

export interface IdeaNode {
  id: string;
  idea_id: string;
  title: string;
  detail: string | null;
  status: string;
  pos_x: number | null;
  pos_y: number | null;
  sort_key: number | null;
  depends_on: string[];
  task_count: number;
  created_at: string;
  updated_at: string;
}

export interface IdeaSignal {
  id: string;
  idea_id: string;
  source: string;
  kind: string;
  value: number | null;
  note: string | null;
  ref: string | null;
  occurred_at: string | null;
  created_at: string;
}

export interface IdeaROI {
  idea_id: string;
  cost_usd: number;
  task_count: number;
  signal_count: number;
  inquiry_count: number;
  signup_count: number;
  payment_total: number;
  window_left_days: number | null;
  overdue: boolean;
}

export interface IdeaTaskLite {
  id: string;
  title: string;
  status: string;
  cost_usd: number | null;
  idea_id: string | null;
  node_id: string | null;
  work_class: string | null;
  created_at: string;
  completed_at: string | null;
}

/** GET /api/ideas — 画布全量（球 + 边）. */
export async function listIdeas(): Promise<{ ideas: IdeaWithCounts[]; links: IdeaLink[] }> {
  return get('/api/ideas');
}

/** GET /api/ideas/[id] — 详情（nodes/signals/roi/tasks/links）. */
export async function getIdea(id: string): Promise<{
  idea: Idea;
  nodes: IdeaNode[];
  signals: IdeaSignal[];
  roi: IdeaROI | null;
  tasks: IdeaTaskLite[];
  links: IdeaLink[];
}> {
  return get(`/api/ideas/${id}`);
}

export async function createIdea(body: Partial<Idea>): Promise<Idea> {
  return post('/api/ideas', body);
}

export async function updateIdea(id: string, body: Record<string, unknown>): Promise<Idea> {
  return patch(`/api/ideas/${id}`, body);
}

export async function deleteIdea(id: string): Promise<void> {
  await del(`/api/ideas/${id}`);
}

export async function createIdeaNode(
  ideaId: string,
  body: { title: string; detail?: string | null; deps?: string[] },
): Promise<IdeaNode> {
  return post(`/api/ideas/${ideaId}/nodes`, body);
}

export async function updateIdeaNode(id: string, body: Record<string, unknown>): Promise<IdeaNode> {
  return patch(`/api/idea-nodes/${id}`, body);
}

export async function addIdeaSignal(
  ideaId: string,
  body: { kind: string; value?: number | null; note?: string | null; ref?: string | null },
): Promise<IdeaSignal> {
  return post(`/api/ideas/${ideaId}/signals`, body);
}

/** 球体颜色（状态 → 材质色, 暗色画布上高对比）. */
export function ideaStatusColor(status: IdeaStatus): [number, number, number] {
  switch (status) {
    case 'germinating': return [0.51, 0.55, 0.91]; // 靛蓝（默认）
    case 'exploring': return [0.22, 0.74, 0.97]; // 天蓝（在跑）
    case 'decided': return [0.2, 0.83, 0.6]; // 绿（定案）
    case 'shelved': return [0.55, 0.58, 0.65]; // 灰（搁置）
    case 'rejected': return [0.95, 0.42, 0.42]; // 红（否定）
    case 'landed': return [1.0, 0.78, 0.29]; // 金（落地）
  }
}
