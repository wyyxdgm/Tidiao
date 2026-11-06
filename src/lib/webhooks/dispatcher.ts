// Signed webhook delivery for task lifecycle events

import { createHmac } from "node:crypto";
import { insertEvent } from "../db/events";
import { listActiveWebhooks, type WebhookEventType } from "../db/webhooks";
import type { Task, TaskStatus } from "../runtime/types";

const WEBHOOK_TIMEOUT_MS = 5000;

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  task: Task;
  from?: TaskStatus;
  to?: TaskStatus;
  score?: number; // for task.evaluated
  note?: string; // for task.evaluated
}

async function deliverWebhook(
  webhook: ReturnType<typeof listActiveWebhooks>[number],
  taskId: string,
  event: WebhookEventType,
  body: string
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    // Success: persist an event row so the UI can show delivery history.
    try {
      insertEvent({
        task_id: taskId,
        type: "webhook_delivered",
        data: JSON.stringify({
          webhook_id: webhook.id,
          webhook_name: webhook.name,
          event,
          url: webhook.url,
          status_code: response.status,
          duration_ms: Date.now() - startedAt,
        }),
      });
    } catch (logError) {
      console.error("[Webhook] Failed to log delivery success:", logError);
    }
  } catch (err) {
    try {
      insertEvent({
        task_id: taskId,
        type: "webhook_delivery_failed",
        data: JSON.stringify({
          webhook_id: webhook.id,
          webhook_name: webhook.name,
          event,
          url: webhook.url,
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    } catch (logError) {
      console.error("[Webhook] Failed to log delivery error:", logError);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function dispatchWebhook(
  event: WebhookEventType,
  task: Task,
  status?: { from: TaskStatus; to: TaskStatus },
  note?: string, // R107 父子任务通知兜底 (parent-notify.ts) 用. 可选, 现有调用方不传.
): void {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    task,
    ...status,
    note,
  };
  const body = JSON.stringify(payload);

  // Scope delivery to the task owner's webhooks so a task only fires its
  // owner's webhooks (no cross-user event delivery). Legacy tasks with no
  // owner_id (NULL, reclaimed in T4) fall back to all active webhooks.
  void Promise.all(
    listActiveWebhooks(event, task.owner_id ?? undefined).map((webhook) =>
      deliverWebhook(webhook, task.id, event, body)
    )
  ).catch((err) => {
    console.error("[Webhook] Unexpected dispatch error:", err);
  });
}

// Dispatch when a dependency root task changes — broadcasts to dependents
// so external systems can react (re-plan, re-run, notify stakeholders).
// Uses the same signature + X-Signature + 5s timeout as the lifecycle path.
export interface DependencyChangePayload {
  event: "task.dependency_changed";
  timestamp: string;
  root_task: Task;          // the task whose deps/state changed
  dependents: Task[];       // tasks that depend (directly) on root_task
  message?: string;         // optional human note from the caller
}

export function dispatchDependencyChangeWebhook(
  rootTask: Task,
  dependents: Task[],
  message?: string
): void {
  const payload: DependencyChangePayload = {
    event: "task.dependency_changed",
    timestamp: new Date().toISOString(),
    root_task: rootTask,
    dependents,
    message,
  };
  const event = "task.dependency_changed";
  const body = JSON.stringify(payload);

  void Promise.all(
    listActiveWebhooks(event, rootTask.owner_id ?? undefined).map((webhook) =>
      deliverWebhook(webhook, rootTask.id, event, body)
    )
  ).catch((err) => {
    console.error("[Webhook] Unexpected dependency dispatch error:", err);
  });
}

// Dispatch a task.evaluation event — triggered by /api/tasks/[id]/evaluate.
// Carries score + optional note so external systems can aggregate agent quality.
export function dispatchEvaluatedWebhook(task: Task, score: number, note?: string): void {
  const event = "task.evaluated" as WebhookEventType;
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    task,
    score,
    note,
  };
  const body = JSON.stringify(payload);
  void Promise.all(
    listActiveWebhooks(event, task.owner_id ?? undefined).map((webhook) =>
      deliverWebhook(webhook, task.id, event, body)
    )
  ).catch((err) => {
    console.error("[Webhook] Unexpected evaluated dispatch error:", err);
  });
}
