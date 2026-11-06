// /api/intake/wecom/outbound - 出站: task->reviewing 时把蒸馏回复发回甲方微信.
//
// 功能: 接收平台 webhook (task.reviewing)，验 HMAC，查 intake_thread，
//   从 task 最后一条 assistant 消息提取 <<<REPLY>>> 段，查 48h 窗口，
//   通过企微 send_msg 发给甲方.
// 关注点: webhook 由平台 dispatcher 自调用 (localhost)，走 middleware public 白名单;
//   HMAC 用 INTAKE_WEBHOOK_SECRET 验（建 webhook 时用同一 secret）;
//   非 intake task（无 thread 映射）直接忽略; 窗口到顶跳过+记事件.

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getIntakeThreadByTask, incrementSentCount } from "@/lib/db/intake-threads";
import { insertEvent } from "@/lib/db/events";
import { sendKfMessage } from "@/lib/intake/wecom";

const WEBHOOK_SECRET = process.env.INTAKE_WEBHOOK_SECRET ?? "";
const WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
const MAX_MSGS_PER_WINDOW = 5;

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("x-signature") ?? "";

  // 验 webhook HMAC
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  if (!WEBHOOK_SECRET || signature !== expected) {
    return NextResponse.json({ error: "invalid signature" }, { status: 403 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const taskId: string = payload?.task?.id;
  if (!taskId) return NextResponse.json({ ok: true, skipped: "no task id" });

  // 非 intake task -> 忽略
  const thread = getIntakeThreadByTask(taskId);
  if (!thread) return NextResponse.json({ ok: true, skipped: "not intake task" });

  // 取最后一条 assistant 消息
  let replyText: string | null = null;
  try {
    const history = await getRuntime().getSessionHistory(taskId);
    const assistantMsgs = history.filter((m) => m.type === "assistant");
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (last) {
      const msg = last.message as { content?: unknown };
      const content = msg.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((b: any) => b?.text ?? "").join("")
          : "";
      const m = text.match(/<<<REPLY>>>\s*([\s\S]*?)\s*<<<END>>>/);
      if (m) replyText = m[1].trim();
    }
  } catch (err) {
    console.error("[intake/outbound] getSessionHistory failed:", err);
    return NextResponse.json({ ok: true, skipped: "history fetch failed" });
  }

  if (!replyText) {
    return NextResponse.json({ ok: true, skipped: "no <<<REPLY>>> in last assistant msg" });
  }

  // 查 48h 窗口
  const lastInbound = thread.last_inbound_at ? new Date(thread.last_inbound_at).getTime() : 0;
  const inWindow = Date.now() - lastInbound < WINDOW_MS;
  const underLimit = thread.msg_sent_in_window < MAX_MSGS_PER_WINDOW;

  if (!inWindow || !underLimit) {
    insertEvent({
      task_id: taskId,
      type: "intake_send_skipped",
      data: JSON.stringify({
        reason: !inWindow ? "48h window expired" : "5 msg limit reached",
        thread_id: thread.id,
      }),
    });
    return NextResponse.json({ ok: true, skipped: "window/limit", inWindow, underLimit });
  }

  // 发消息
  try {
    await sendKfMessage(thread.external_user_id, replyText);
    incrementSentCount(thread.id);
  } catch (err) {
    console.error("[intake/outbound] sendKfMessage failed:", err);
    return NextResponse.json({ ok: false, error: "send failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: true });
}
