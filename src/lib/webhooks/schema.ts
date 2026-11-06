import { z } from "zod";
import { WEBHOOK_EVENTS } from "../db/webhooks";

const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
const webhookUrlSchema = z.string().url().refine(
  (url) => url.startsWith("http://") || url.startsWith("https://"),
  "url must use http or https"
);

export const createWebhookSchema = z.object({
  name: z.string().trim().min(1),
  url: webhookUrlSchema,
  events: z.array(webhookEventSchema).min(1),
  secret: z.string().min(1),
  active: z.boolean().optional(),
});

export const updateWebhookSchema = z.object({
  name: z.string().trim().min(1).optional(),
  url: webhookUrlSchema.optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
  secret: z.string().min(1).optional(),
  active: z.boolean().optional(),
}).strict();
