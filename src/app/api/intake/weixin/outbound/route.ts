// /api/intake/weixin/outbound - 出站: weixin intake task 完成轮次时把蒸馏回复发回微信.
//
// 功能: 接收平台 webhook (task.reviewing)，验 HMAC，查 intake_thread，
//   从 task 最后一条 assistant 消息提取 <<<REPLY>>> 段，经 iLink sendmessage 发出.
// 关注点: 结构与 /api/intake/telegram/outbound 同模式 (各自验签+蒸馏+发);
//   触发 = damo 在平台 UI 配 webhook 行 (URL 指向本端点, event=task.reviewing);
//   出站走 ilinkai.weixin.qq.com 国内直连可达 (与 telegram 出站需代理不同);
//   无 48h/5 条窗口 (个人微信 bot 无配额), 不做窗口跳过.

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getIntakeThreadByTask } from "@/lib/db/intake-threads";
import { listChannelConfigs } from "@/lib/db/channel-configs";
import { parseWeixinSecret, sendText } from "@/lib/intake/weixin";

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
  if (!thread || thread.channel !== "weixin") {
    return NextResponse.json({ ok: true, skipped: "not weixin intake task" });
  }

  // 提取最后一条 assistant 消息里的蒸馏段 (与 wecom/telegram outbound 同一标记约定)
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
    console.error("[intake/weixin/outbound] getSessionHistory failed:", err);
    return NextResponse.json({ ok: true, skipped: "history fetch failed" });
  }

  if (!replyText) {
    return NextResponse.json({ ok: true, skipped: "no <<<REPLY>>> in last assistant msg" });
  }

  // thread -> config: 按 bound_project_id 匹配最准, 无匹配回落第一个 weixin config
  // (单 bot 场景唯一; telegram outbound 同策略)
  const configs = listChannelConfigs().filter((c) => c.channel === "weixin");
  const config =
    configs.find((c) => c.bound_project_id === thread.project_id) ?? configs[0];
  if (!config) return NextResponse.json({ ok: true, skipped: "no weixin config" });

  const cred = parseWeixinSecret(config.secret);
  if (!cred) {
    return NextResponse.json({ ok: true, skipped: "weixin secret invalid" });
  }

  try {
    await sendText(cred.bot_token, cred.ilink_bot_id, thread.external_user_id, replyText);
  } catch (err) {
    console.error("[intake/weixin/outbound] sendmessage failed:", err);
    return NextResponse.json({ ok: false, error: "send failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: true });
}
