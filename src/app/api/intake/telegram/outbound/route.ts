// /api/intake/telegram/outbound - 出站: telegram intake task 完成轮次时把蒸馏回复发回 Telegram.
//
// 功能: 接收平台 webhook (task.reviewing)，验 HMAC，查 intake_thread，
//   从 task 最后一条 assistant 消息提取 <<<REPLY>>> 段，经 telegram adapter 发出.
// 关注点: 结构与 /api/intake/wecom/outbound 同模式 (各自验签+蒸馏+发);
//   Telegram 无 48h/5 条窗口 (adapter 未实现 outboundGate), 无窗口跳过逻辑;
//   出站走 api.telegram.org, 需部署 env NODE_USE_ENV_PROXY=1 + HTTPS_PROXY (见 telegram.ts).

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getIntakeThreadByTask } from "@/lib/db/intake-threads";
import { listChannelConfigs } from "@/lib/db/channel-configs";
import { getChannelAdapter } from "@/lib/intake/channels/registry";

const WEBHOOK_SECRET = process.env.INTAKE_WEBHOOK_SECRET ?? "";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("x-signature") ?? "";

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

  const thread = getIntakeThreadByTask(taskId);
  if (!thread || thread.channel !== "telegram") {
    return NextResponse.json({ ok: true, skipped: "not telegram intake task" });
  }

  // 提取最后一条 assistant 消息里的蒸馏段 (与 wecom outbound 同一标记约定)
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
    console.error("[intake/telegram/outbound] getSessionHistory failed:", err);
    return NextResponse.json({ ok: true, skipped: "history fetch failed" });
  }

  if (!replyText) {
    return NextResponse.json({ ok: true, skipped: "no <<<REPLY>>> in last assistant msg" });
  }

  const adapter = getChannelAdapter("telegram");
  if (!adapter) return NextResponse.json({ ok: true, skipped: "adapter missing" });

  // thread -> config: 同渠道 config 里按 bound_project_id 匹配 thread.project_id 最准,
  // 无匹配回落第一个 telegram config (单 bot 场景唯一).
  const config =
    listChannelConfigs().find(
      (c) => c.channel === "telegram" && c.bound_project_id === thread.project_id,
    ) ?? listChannelConfigs().find((c) => c.channel === "telegram");
  if (!config) return NextResponse.json({ ok: true, skipped: "no telegram config" });

  try {
    await adapter.sendMessage(config, { externalUserId: thread.external_user_id }, replyText);
  } catch (err) {
    console.error("[intake/telegram/outbound] sendMessage failed:", err);
    return NextResponse.json({ ok: false, error: "send failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: true });
}
