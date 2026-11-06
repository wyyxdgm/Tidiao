// Webhooks management page -- server component wrapper
import WebhooksClient from "./webhooks-client";
import { listWebhooks } from "@/lib/db/webhooks";
import { WEBHOOK_EVENTS } from "@/lib/db/webhooks";
import { getServerUserId } from "@/lib/server-auth";

export default async function WebhooksPage() {
  const userId = await getServerUserId();
  const webhooks = listWebhooks(userId);
  const events = [...WEBHOOK_EVENTS];
  return <WebhooksClient initialWebhooks={webhooks} availableEvents={events} />;
}
