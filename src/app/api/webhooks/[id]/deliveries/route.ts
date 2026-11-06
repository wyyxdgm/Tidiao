// GET /api/webhooks/[id]/deliveries - 列出 webhook 的最近投递历史
//
// 数据源: events 表 type IN ('webhook_delivered', 'webhook_delivery_failed'),
//   经 getWebhookDeliveryEvents(webhookId, limit) 按 data LIKE %webhook_id% 扫出来.
//   v2.0-spa WebhookDetail.vue 用这个补「投递历史」段 (R142 G3).
//
// 关注点:
//   - 权限: admin (x-user-role === 'admin') OR owner. 非 owner 看到 webhook 即
//     当 404 — 跟 [id]/route.ts owner-scoped 行为对齐, 不暴露 webhook 存在性.
//   - 失败/成功 status 都返 (webhook_delivered / webhook_delivery_failed).
//     response_status 是 webhook 投递时目标返回的 HTTP code, 失败时为 null.
//   - 默认 limit=50, 与 getWebhookDeliveryEvents 默认值同.
//   - 顺序: events.id DESC (最近在前), 与 SPA 表格顺序一致.

import { NextRequest, NextResponse } from "next/server";
import { getWebhookById } from "@/lib/db/webhooks";
import { getWebhookDeliveryEvents } from "@/lib/db/events";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const userId = _request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = _request.headers.get("x-user-role") === "admin";
  const { id } = await params;

  // owner 校验; admin 可读任意 webhook. 跨 owner 一律 404 (no existence leak).
  const webhook = getWebhookById(id, isAdmin ? undefined : userId);
  if (!webhook) {
    return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
  }

  // 可选 ?limit= 限, 默认 50, 上限 200 防止一次拉太多.
  const limitParam = _request.nextUrl.searchParams.get("limit");
  const limit = (() => {
    if (limitParam === null) return 50;
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > 200) return 50;
    return n;
  })();

  const events = getWebhookDeliveryEvents(id, limit);
  const deliveries = events.map((e) => {
    let parsed: {
      event?: string;
      status_code?: number;
      error?: string;
      url?: string;
    } = {};
    try {
      parsed = JSON.parse(e.data);
    } catch {
      // events.data 是 dispatcher.ts 落库时 JSON.stringify 的, 这里解析失败
      // 兜底当空对象 — 不会 5xx, 前端按字段缺失渲染 '—'.
    }
    const status =
      e.type === "webhook_delivered"
        ? "delivered"
        : e.type === "webhook_delivery_failed"
          ? "failed"
          : e.type;
    return {
      id: e.id ?? null,
      event: parsed.event ?? null,
      payload: parsed,
      status,
      response_status: typeof parsed.status_code === "number" ? parsed.status_code : null,
      attempted_at: e.created_at ?? null,
    };
  });

  return NextResponse.json({ deliveries });
}
