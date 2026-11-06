// /api/intake/feishu - 飞书/Lark 事件回调入站 (D2, docs/plans/intake-channel-unify.md
//   + docs/plans/channel-qr-bind.md D2: bind 命令门控 + lark 渠道类型).
//
// 功能: 接收飞书开放平台事件订阅回调 —— url_verification challenge 应答 +
//   im.message.receive_v1 文本消息:
//   1. "bind <码>" -> 校验 channel_configs.bind_code (feishu/lark 行), 建 intake thread
//   2. 已有 thread -> 续聊 (sendUserMessage 触发 auto-resume)
//   3. 未绑 -> 跳过 (不自动建 task, 防陌生人消息白烧 agent 额度)
// 关注点: 验签 = encrypt_key AES 解密 + verification_token 比对, 凭据只在
//   channel_configs (channel=feishu/lark) 行加密体内 (app_id/app_secret 不进平台 ——
//   发消息走部署机 lark-cli, 收发分治); 处理出错也回 200 (防飞书重试风暴,
//   与 wecom/telegram 同策略), 同 event_id 幂等去重; 路由在 middleware public
//   白名单, 靠验签自证合法.
//   🔴 本线路只收不发: 绑定成功回执 / 未绑引导文案无法由 route 直发 ——
//   回执经绑定首 task 的 agent 首轮回复 (REPLY → lark-cli) 送达; 未绑引导无法送达,
//   引导语在渠道管理页 hint + QR 弹窗呈现 (bind-qr API).

import { NextRequest, NextResponse } from "next/server";
import { getRuntime } from "@/lib/runtime/agent-runtime";
import { getProjectById } from "@/lib/db/projects";
import { getChannelConfigByBindCode } from "@/lib/db/channel-configs";
import {
  createIntakeThread,
  getIntakeThreadByExternal,
  markInbound,
  type IntakeChannel,
} from "@/lib/db/intake-threads";
import { resolveEvent, parseMessageEvent, consumeEventId } from "@/lib/intake/feishu";
import { buildIntakePrompt } from "@/lib/intake/prompt";
import { EXPLORE_TOOLS } from "@/lib/constants";

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: true, skipped: "invalid json" });
  }

  try {
    // 验签 + 定位渠道行: 加密包逐启用 feishu/lark 行试解密, 明文包逐行比对 token
    const resolved = resolveEvent(payload);
    if (!resolved) {
      return NextResponse.json({ error: "decrypt/verify failed" }, { status: 403 });
    }
    const evt = resolved.event;

    // url_verification: challenge 原样应答 (飞书后台配回调 URL 时的握手)
    if (evt.type === "url_verification" && typeof evt.challenge === "string") {
      return NextResponse.json({ challenge: evt.challenge });
    }

    const msg = parseMessageEvent(evt);
    if (!msg) {
      return NextResponse.json({ ok: true, skipped: "not a handled event" });
    }

    // at-least-once 重投去重 (副作用 = 建 task / 续聊, 重复投递不能重复触发)
    const header = evt.header as Record<string, unknown> | undefined;
    if (typeof header?.event_id === "string" && consumeEventId(header.event_id)) {
      return NextResponse.json({ ok: true, dedup: true });
    }

    // 绑定码: "bind ABCD1234" (大小写不敏感, 允许多空格; 与 telegram route 同 regex).
    // 绑定先行于线程查找 —— 同 chat 发 bind = 换绑 (旧 thread 保留, 语义同 telegram).
    const bindMatch = msg.text.match(/^bind\s+([A-Za-z0-9]{6,16})\s*$/i);
    if (bindMatch) {
      const target = getChannelConfigByBindCode(bindMatch[1]);
      if (!target || (target.channel !== "feishu" && target.channel !== "lark")) {
        // 码无效 / 码属于其他渠道类型: 只收不发, 无法回执, 记日志跳过
        console.error(
          `[intake/feishu] bind code invalid or not a feishu/lark channel (chat=${msg.chatId})`,
        );
        return NextResponse.json({ ok: true, skipped: "invalid bind code" });
      }
      return NextResponse.json(await handleBind(target, msg.chatId));
    }

    // 已绑定 -> 续聊; 未绑定 -> 跳过 (只收不发, 引导文案走渠道管理页呈现)
    const existing = getIntakeThreadByExternal(
      resolved.channel.channel as IntakeChannel,
      msg.chatId,
    );
    if (existing) {
      // 续聊: 刷新 last_inbound_at + 发消息触发 auto-resume
      markInbound(existing.id);
      getRuntime().sendUserMessage(existing.task_id, msg.text);
      return NextResponse.json({ ok: true, resumed: existing.task_id });
    }

    console.error(
      `[intake/feishu] chat ${msg.chatId} not bound (channel=${resolved.channel.channelId}), ignored`,
    );
    return NextResponse.json({ ok: true, skipped: "not bound" });
  } catch (err) {
    console.error("[intake/feishu] callback error:", err);
    return NextResponse.json({ ok: true });
  }
}

// 功能: 校验绑定码 -> 建 thread + 首个 task (telegram handleBind 同模式).
// 关注点: 绑定成功回执无法由 route 直发 (收发分治) —— 首条 prompt 注入回执要求,
//   由 agent 首轮 REPLY 经部署机 lark-cli 送达甲方.
async function handleBind(
  target: NonNullable<ReturnType<typeof getChannelConfigByBindCode>>,
  chatId: string,
): Promise<{ ok: boolean; created?: string }> {
  const project = getProjectById(target.bound_project_id);
  if (!project?.owner_id) {
    console.error(
      `[intake/feishu] bind target project ${target.bound_project_id} not found (channel=${target.id})`,
    );
    return { ok: true };
  }

  const channelType = target.channel as IntakeChannel; // "feishu" | "lark"
  const task = getRuntime().createTask({
    title: `甲方需求线程（${chatId.slice(-6)}）`,
    prompt: buildIntakePrompt(
      project.name,
      "（用户刚完成渠道绑定，此条无实际需求内容。请先回复一句绑定成功确认，告知直接发需求即可。）",
      "feishu",
    ),
    project_id: project.id,
    effort: "medium",
    maxTurns: 60,
    auto_approve: true,
    // 外部渠道任意文本输入, 只给只读探索集 (同 wecom/telegram, 见 constants.ts EXPLORE_TOOLS)
    allowedTools: EXPLORE_TOOLS,
    tags: ["intake", channelType],
    // 渠道默认角色 (v526 D3): channel 行配了 role 则首 task 挂上 (telegram route
    // :101-102 同款条件展开); role 随 task 定型, 后续消息进已有 thread 走 resume 不再变.
    // 未配 (role_id NULL) 时不传, createTask 走原逻辑 (行为不变).
    ...(target.role_id ? { role_id: target.role_id } : {}),
    // 绑定版本 (v529): 渠道行钉了 bound_version_id 则首 task 落该 version;
    // NULL 时不传, createTask 走项目 current_version (行为不变).
    ...(target.bound_version_id ? { version_id: target.bound_version_id } : {}),
  });
  getRuntime().startTask(task.id, undefined, "intake_feishu");

  createIntakeThread({
    channel: channelType,
    external_user_id: chatId,
    task_id: task.id,
    project_id: project.id,
    owner_id: project.owner_id,
  });
  return { ok: true, created: task.id };
}
