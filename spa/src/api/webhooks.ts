// 🆕 R25: webhooks API 封装 — 与 master src/lib/db/webhooks.ts 的 Webhook 字段集对齐.
//   字段范围是 UI 渲染 + 表单编辑所需; 后端不返 secret (只有 has_secret 标志), UI 上要
//   据此展示「已配置 / 未配置」徽章, 不暴露明文.
//
//   WEBHOOK_EVENTS 列表同步 master src/lib/db/webhooks.ts (12 项含 R107 父子任务通知兜底 +
//   R131 已退役的 task.rejected 但保留契约). 前端写死, 与后端 createWebhookSchema 的
//   z.enum(WEBHOOK_EVENTS) 校验对齐 — 改了这里要同步 master, 否则提交会被 400 打回.

import { get, post, patch, del } from './http';

/** 单条 webhook — 与 master listWebhooks / getWebhookById 返回结构对齐.
    secret 永远不返回 (后端 schema 主动屏蔽), 只返 has_secret 标志. */
export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
  has_secret: boolean;
}

/** 后端允许订阅的事件类型 — 与 master WEBHOOK_EVENTS 完全对齐 (damo 2026 R107/R131 引入).
    写入表单时只允许从本列表中选; 后端 z.enum 校验会兜底. */
export const WEBHOOK_EVENTS: readonly string[] = [
  'task.created',
  'task.started',
  'task.reviewing',
  'task.completed',
  'task.failed',
  'task.rejected', // R131 退役但保留契约, 旧 task 重启不会触发, 仅历史数据接口兼容.
  'task.cancelled',
  'task.await_user', // R131: 外部系统可订阅以触发提醒/工作流.
  'task.dependency_changed',
  'task.evaluated',
  'task.parent_child_notify', // R107 父子任务通知兜底, 默认无 webhook 订阅此事件.
];

/** 新建 webhook 的 body — 与 master createWebhookSchema 对齐 (除 ownerId 走 session). */
export interface CreateWebhookBody {
  name: string;
  url: string;
  events: string[];
  secret: string;
  active?: boolean;
}

/** 编辑 webhook 的 body — 与 master updateWebhookSchema 对齐; 所有字段可选.
    secret 留空字符串 = 不更新 (后端会 delete body.secret). 这里前端不做特殊处理,
    想要改 secret 就传新值, 不传就保持不变. */
export interface UpdateWebhookBody {
  name?: string;
  url?: string;
  events?: string[];
  secret?: string;
  active?: boolean;
}

/** GET /api/webhooks — 拉当前用户全部 webhook. 后端按 owner_id 过滤. */
export function listWebhooks(): Promise<Webhook[]> {
  return get<Webhook[]>('/api/webhooks');
}

/** GET /api/webhooks/[id] — 拉单条 webhook. 后端按 owner_id 过滤, 非 owner 返 404.
    与 master route GET handler 对齐 (next.js `getWebhookById(id, userId)`).
    R11 detail 视图用. */
export function getWebhook(id: string): Promise<Webhook> {
  return get<Webhook>(`/api/webhooks/${id}`);
}

/** POST /api/webhooks — 新建. 返回新建后的完整 webhook. */
export function createWebhook(body: CreateWebhookBody): Promise<Webhook> {
  return post<Webhook>('/api/webhooks', body);
}

/** PATCH /api/webhooks/[id] — 编辑. 返回更新后的 webhook. */
export function updateWebhook(id: string, body: UpdateWebhookBody): Promise<Webhook> {
  return patch<Webhook>(`/api/webhooks/${id}`, body);
}

/** DELETE /api/webhooks/[id] — 硬删 (master 无软删除通道, 与 schedules 同款). */
export function deleteWebhook(id: string): Promise<void> {
  return del<void>(`/api/webhooks/${id}`);
}

// 🆕 R38: webhook deliveries — G3 缺口收口, 后端 `src/app/api/webhooks/[id]/deliveries/route.ts`
//   (commit a432dad2) GET → 扫 events 表 type IN ('webhook_delivered','webhook_delivery_failed')
//   WHERE data LIKE %webhook_id% ORDER BY id DESC. SPA 详情页用这个取代 R11 暂未对接的占位
//   notice + 跳转 Next.js, 与 master Next.js webhook-detail-client.tsx 1:1 镜像数据.
//
/** 单条 webhook 投递 — 后端 deliveries DTO, 数据源 = events 表 (WebhookDeliveryEvent).
    payload 字段是后端解析后的 data JSON 对象 (含 event/status_code/error/url/duration_ms),
    SPA 表格直接用字段渲染, 失败 payload 解析为空对象兜底 (后端 try/catch 不抛 5xx). */
export interface WebhookDelivery {
  id: number | null;
  event: string | null;
  payload: Record<string, unknown>;
  status: 'delivered' | 'failed' | string;
  response_status: number | null;
  attempted_at: string | null;
}

/** GET /api/webhooks/[id]/deliveries — 拉该 webhook 的最近投递历史.
    后端默认 limit=50 (1..200, 超出回落 50). admin / owner 校验对齐后端.
    与 master route GET handler 同源. R38 WebhookDetail.vue 用此替代 R11 占位跳转. */
export function getWebhookDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
  return get<{ deliveries: WebhookDelivery[] }>(`/api/webhooks/${webhookId}/deliveries`)
    .then((body) => body.deliveries);
}