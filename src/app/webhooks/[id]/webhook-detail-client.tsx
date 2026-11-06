"use client";

import Link from "next/link";

type Webhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: number | boolean;
  created_at: string;
};

type DeliveryEvent = {
  id?: number;
  task_id: string;
  type: string;
  data: string;
  created_at?: string;
};

function statusFor(type: string) {
  if (type === "webhook_delivered") return { label: "已投递", color: "bg-emerald-100 text-emerald-700" };
  if (type === "webhook_delivery_failed") return { label: "失败", color: "bg-red-100 text-red-700" };
  return { label: type, color: "bg-gray-100 text-gray-700" };
}

export default function WebhookDetailClient({
  webhook,
  deliveryEvents,
}: {
  webhook: Webhook;
  deliveryEvents: DeliveryEvent[];
}) {
  return (
    // 🆕 飞书 R139 第三批: 右滚修复 — 同 schedules 套路.
    <div className="h-full flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="text-sm text-gray-500 mb-1">
          <Link href="/" className="hover:text-blue-600">项目</Link>
          <span className="mx-1">›</span>
          <Link href="/webhooks" className="hover:text-blue-600">Webhooks</Link>
          <span className="mx-1">›</span>
          <span>{webhook.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-gray-900">{webhook.name}</h1>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              webhook.active
                ? "bg-emerald-100 text-emerald-700"
                : "bg-gray-100 text-gray-500"
            }`}
          >
            {webhook.active ? "启用" : "禁用"}
          </span>
        </div>
        <code className="block mt-1 text-xs text-gray-500 font-mono break-all">
          {webhook.url}
        </code>
        <div className="mt-2 flex flex-wrap gap-1">
          {webhook.events.map((ev) => (
            <span
              key={ev}
              className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-mono"
            >
              {ev}
            </span>
          ))}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto max-w-5xl w-full mx-auto px-6 py-6">
        <h2 className="text-base font-semibold text-gray-700 mb-3">
          投递历史 (最近 {deliveryEvents.length} 条)
        </h2>
        {deliveryEvents.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-6 text-center text-gray-500 text-sm">
            暂无投递记录。该 webhook 还没被任何 task 事件触发过,或事件已超过 100 条上限。
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2 text-left">时间</th>
                  <th className="px-4 py-2 text-left">状态</th>
                  <th className="px-4 py-2 text-left">事件</th>
                  <th className="px-4 py-2 text-left">关联 task</th>
                  <th className="px-4 py-2 text-left">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {deliveryEvents.map((e) => {
                  const status = statusFor(e.type);
                  let parsed: any = {};
                  try { parsed = JSON.parse(e.data); } catch {}
                  return (
                    <tr key={e.id}>
                      <td className="px-4 py-2 text-xs text-gray-600 font-mono whitespace-nowrap">
                        {e.created_at || "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${status.color}`}>
                          {status.label}
                        </span>
                        {typeof parsed.status_code === "number" && (
                          <span className="ml-2 text-xs text-gray-500">
                            HTTP {parsed.status_code}
                          </span>
                        )}
                        {typeof parsed.duration_ms === "number" && (
                          <span className="ml-2 text-xs text-gray-400">
                            {parsed.duration_ms}ms
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs font-mono text-gray-700">
                        {parsed.event}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/tasks/${e.task_id}`}
                          className="text-blue-600 hover:underline font-mono text-xs"
                        >
                          {e.task_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600">
                        {parsed.error ? (
                          <code className="font-mono text-red-600">{parsed.error}</code>
                        ) : parsed.message ? (
                          <span>{parsed.message}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
