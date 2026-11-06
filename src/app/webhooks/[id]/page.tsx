// Webhook detail page -- server component
import { notFound } from "next/navigation";
import { getWebhookById } from "@/lib/db/webhooks";
import { getWebhookDeliveryEvents } from "@/lib/db/events";
import { getServerUserId } from "@/lib/server-auth";
import WebhookDetailClient from "./webhook-detail-client";

export default function WebhookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (async () => {
    const { id } = await params;
    const userId = await getServerUserId();
    const webhook = getWebhookById(id, userId);
    if (!webhook) notFound();
    const events = getWebhookDeliveryEvents(id, 100);
    return <WebhookDetailClient webhook={webhook} deliveryEvents={events} />;
  })();
}
